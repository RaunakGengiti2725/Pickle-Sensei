/**
 * mod-telemetry concurrency stress harness (lens: `concurrency`).
 *
 * Drives the in-memory telemetry recorders
 * (`src/analysis/stabilityTelemetry.ts`, `src/analysis/usabilityTelemetry.ts`)
 * with bursts of async "actors" whose relative order is decided by a SEEDED
 * scheduler, so every interleaving is replayable from its seed:
 *
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/<suite>
 *
 * Scale is `STRESS_ITER` (interleavings per fuzzed scenario, default 40 so
 * the suites stay cheap in CI); the campaign runs it at several hundred.
 * `STRESS_STRICT=1` additionally asserts the invariants the module is
 * EXPECTED to hold but does not today (bounded buffers, field whitelist,
 * encapsulated log) — those tests measure and record evidence in the
 * default mode and only fail in strict mode, so a known finding never turns
 * the default suite red while its repro stays one command away.
 *
 * Every scenario execution appends one NDJSON line to
 * `artifacts/stress/mod-telemetry-concurrency/<STRESS_RUN_ID>/events.ndjson`
 * (repo-root relative, git-ignored) carrying suite, scenario, seed, the
 * seed-derived plan, the observed outcome, verdict, duration and heap.
 */
// Node built-ins for the evidence sink. The mobile tsconfig deliberately
// excludes node typings, so the shims stay local (same convention as
// testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
  hrtime: { bigint(): bigint };
};

const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Seeded randomness ──────────────────────────────────────────────────────

/** mulberry32 — small, deterministic, good enough to drive interleavings. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Random = () => number;

export function randomInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export function shuffle<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/** Deterministic pseudo-UUID derived from the seed stream (never a real
 * identifier — the recorders are only ever fed pseudonymous keys). */
export function pseudoUuid(random: Random): string {
  const hex = () =>
    Math.floor(random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  const a = `${hex()}${hex()}-${hex()}-4${hex().slice(1)}`;
  return `${a}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

// ─── Scale / replay knobs ───────────────────────────────────────────────────

export const STRICT = process.env['STRESS_STRICT'] === '1';

/** Seeds for a fuzzed scenario: one pinned seed in replay mode, otherwise
 * `STRESS_ITER` deterministic seeds derived from the scenario name so every
 * run at the same scale covers the same interleavings. */
export function scenarioSeeds(scenario: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  const scale = Number(process.env['STRESS_ITER'] ?? '40');
  let hash = 2166136261;
  for (const ch of scenario) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < scale; i += 1) {
    seeds.push((hash + i * 7919) >>> 0);
  }
  return seeds;
}

// ─── Seeded cooperative scheduler ───────────────────────────────────────────

export interface Scheduler {
  /** Suspend the calling actor until the dispatcher picks it again. Which
   * waiting actor resumes next is decided by the seed, never by event-loop
   * timing, so a seed replays the exact same interleaving every run. */
  yield(): Promise<void>;
  /** Dispatch decisions taken so far (part of the replay evidence). */
  readonly steps: number;
}

export type Actor = (sched: Scheduler) => Promise<void>;

/**
 * Runs every actor concurrently (Promise.all) under a seeded cooperative
 * dispatcher: each actor runs synchronously until its next `yield()`, then
 * the dispatcher picks — by seed — which parked actor continues. Fails if
 * the burst does not settle inside `wallBudgetMs` (a hung interleaving is a
 * deadlock finding, never a silent pass).
 */
export async function runBurst(
  random: Random,
  actors: readonly Actor[],
  wallBudgetMs: number,
): Promise<{ elapsedMs: number; steps: number }> {
  const started = process.hrtime.bigint();
  const waiting: (() => void)[] = [];
  let running = actors.length;
  let steps = 0;
  const sched: Scheduler = {
    get steps() {
      return steps;
    },
    yield: () =>
      new Promise<void>(resolve => {
        waiting.push(resolve);
      }),
  };
  const all = Promise.all(
    actors.map(async actor => {
      try {
        await actor(sched);
      } finally {
        running -= 1;
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `burst of ${actors.length} actors did not settle within ${wallBudgetMs}ms (running=${running}, parked=${waiting.length}, steps=${steps})`,
          ),
        ),
      wallBudgetMs,
    );
  });
  const dispatch = async (): Promise<void> => {
    let idle = 0;
    while (running > 0) {
      if (waiting.length === 0) {
        // Every live actor is mid-flight between yields (or awaiting a
        // sibling); give the microtask queue room, then a macrotask.
        idle += 1;
        if (idle < 8) await Promise.resolve();
        else
          await new Promise<void>(resolve => {
            setImmediate(() => resolve());
          });
        continue;
      }
      idle = 0;
      steps += 1;
      const index = Math.floor(random() * waiting.length);
      const resume = waiting.splice(index, 1)[0]!;
      resume();
      await Promise.resolve();
      await Promise.resolve();
    }
    await all;
  };
  try {
    await Promise.race([dispatch(), deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const elapsedNs = process.hrtime.bigint() - started;
  return { elapsedMs: Number(elapsedNs / 1_000_000n), steps };
}

// ─── Skewed clocks ──────────────────────────────────────────────────────────

export interface SkewedClock {
  /** Next reading. Mostly advances; sometimes steps backward (NTP
   * correction / user clock change) or jumps forward (suspend/resume). */
  now(): number;
  /** Every reading handed out, in call order — the oracle for `at`/`tMs`. */
  readonly readings: number[];
}

export function skewedClock(random: Random, startMs: number): SkewedClock {
  let t = startMs;
  const readings: number[] = [];
  return {
    readings,
    now() {
      const roll = random();
      if (roll < 0.1) t -= randomInt(random, 1, 5_000);
      else if (roll < 0.15) t += randomInt(random, 60_000, 3_600_000);
      else t += randomInt(random, 0, 400);
      readings.push(t);
      return t;
    },
  };
}

// ─── Evidence sink ──────────────────────────────────────────────────────────

export interface ScenarioEvidence {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  strict: boolean;
  durationMs: number;
  heapUsedMb: number;
  rssMb: number;
  atIso: string;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(
    repoRoot(),
    'artifacts',
    'stress',
    'mod-telemetry-concurrency',
    RUN_ID,
  );
}

export function evidenceFile(): string {
  return path.join(evidenceDir(), 'events.ndjson');
}

function appendEvidence(record: ScenarioEvidence): void {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.appendFileSync(evidenceFile(), `${JSON.stringify(record)}\n`);
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * Runs one scenario body, records evidence whether it passes or throws, and
 * re-throws so Jest still reports the failure. `inputs` is the exact
 * seed-derived plan so the line alone is enough to replay by hand.
 */
export async function recordScenario(
  suite: string,
  scenario: string,
  seed: number,
  inputs: Record<string, unknown>,
  body: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let observed: Record<string, unknown> = {};
  let verdict: ScenarioEvidence['verdict'] = 'pass';
  try {
    observed = await body();
    return observed;
  } catch (error) {
    verdict = 'fail';
    observed = {
      ...observed,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    const mem = process.memoryUsage();
    appendEvidence({
      suite,
      scenario,
      seed,
      inputs,
      observed,
      verdict,
      strict: STRICT,
      durationMs: Date.now() - started,
      heapUsedMb: mb(mem.heapUsed),
      rssMb: mb(mem.rss),
      atIso: new Date().toISOString(),
    });
  }
}

/** Deep structural equality without pulling in a matcher — used inside
 * actors where a thrown expect would be swallowed by the burst. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
