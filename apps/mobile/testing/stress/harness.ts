/**
 * mod-capture concurrency stress harness — seeded, replayable interleavings
 * for `src/camera/{capture,captureEnvelope,deviceBench}.ts`.
 *
 * Every campaign iteration derives ALL of its randomness (burst shape, native
 * outcomes, settle order, actor schedule, clock skew) from one 32-bit seed,
 * so any failing row in the JSON table replays byte-for-byte with
 * `STRESS_SEED=<seed> npx jest --ci __tests__/stress/<suite>`.
 *
 * Scale knobs (all optional):
 *  - `STRESS_ITER`   iterations per scenario (default 20 — fast enough to
 *                    live in the regular suite; campaigns use hundreds)
 *  - `STRESS_SEED`   replay exactly one seed per scenario
 *  - `STRESS_RUN_ID` artifact folder under `artifacts/stress/` (repo root)
 *
 * Each scenario writes `artifacts/stress/<run>/<suite>.<scenario>.json`, a
 * seed → outcome table (`verdict`, `detail`, `durationMs`) plus a summary.
 */
// Node built-ins for the evidence sink. The mobile tsconfig deliberately
// excludes node typings, so the shims stay local (same convention as
// testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  hrtime: { bigint(): bigint };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export type Rng = () => number;

/** mulberry32 — small, deterministic, good enough to drive interleavings. */
export function seededRandom(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: Rng, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[Math.floor(random() * items.length)] as T;
}

export function shuffle<T>(random: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

/** FNV-1a of the scenario name → stable seed base per scenario. */
export function scenarioSeedBase(scenario: string): number {
  let hash = 2166136261;
  for (const ch of scenario) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function stressIterations(): number {
  const raw = Number(process.env['STRESS_ITER'] ?? '20');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

export function scenarioSeeds(scenario: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned) >>> 0];
  const base = scenarioSeedBase(scenario);
  const seeds: number[] = [];
  for (let i = 0; i < stressIterations(); i += 1) {
    seeds.push((base + i * 7919) >>> 0);
  }
  return seeds;
}

// ─── Deterministic scheduler ─────────────────────────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: value => {
      d.settled = true;
      resolve(value);
    },
    reject: error => {
      d.settled = true;
      reject(error);
    },
    settled: false,
  };
  return d;
}

/** Drains the microtask queue far enough for chained awaits to observe a
 * settlement (promise resolution runs in a bounded number of ticks). */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

export interface PendingOp {
  id: number;
  label: string;
  settle: () => void;
}

/**
 * Holds every in-flight simulated native call and settles them in a
 * seed-chosen order, one at a time, flushing microtasks between settlements
 * so the module code under test observes each ordering as a distinct
 * interleaving. `step()` returns false once nothing is pending.
 */
export class SeededScheduler {
  private readonly pending: PendingOp[] = [];
  private nextId = 0;
  readonly settledOrder: string[] = [];

  constructor(private readonly random: Rng) {}

  hold<T>(label: string, outcome: () => T | Promise<T>): Promise<T> {
    const d = deferred<T>();
    this.pending.push({
      id: this.nextId++,
      label,
      settle: () => {
        try {
          d.resolve(outcome() as T);
        } catch (error) {
          d.reject(error);
        }
      },
    });
    return d.promise;
  }

  holdRejection<T>(label: string, error: unknown): Promise<T> {
    const d = deferred<T>();
    this.pending.push({
      id: this.nextId++,
      label,
      settle: () => d.reject(error),
    });
    return d.promise;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  async step(): Promise<boolean> {
    if (this.pending.length === 0) return false;
    const index = Math.floor(this.random() * this.pending.length);
    const [op] = this.pending.splice(index, 1);
    if (!op) return false;
    this.settledOrder.push(op.label);
    op.settle();
    await flushMicrotasks();
    return true;
  }

  async drain(): Promise<void> {
    while (await this.step()) {
      // settle until nothing is pending
    }
  }
}

// ─── Campaign runner + JSON evidence ─────────────────────────────────────────

export type Verdict = 'pass' | 'fail' | 'deadlock';

export interface IterationRow {
  seed: number;
  verdict: Verdict;
  /** Seed-derived plan + observed counters; enough to replay by hand. */
  detail: Record<string, unknown>;
  /** First invariant violation (empty on pass). */
  error: string;
  durationMs: number;
}

export interface CampaignTable {
  suite: string;
  scenario: string;
  runId: string;
  iterations: number;
  passed: number;
  failed: number;
  deadlocked: number;
  failingSeeds: number[];
  maxDurationMs: number;
  totalDurationMs: number;
  replay: string;
  rows: IterationRow[];
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function artifactDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', RUN_ID);
}

export function artifactFile(suite: string, scenario: string): string {
  return path.join(artifactDir(), `${suite}.${scenario}.json`);
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

/**
 * Per-iteration wall-time bound. A body that has not settled by then is a
 * DEADLOCK verdict (the lens' "bounded wall time" invariant), never a hang
 * of the whole suite.
 */
export const ITERATION_WALL_MS = 4000;

export interface IterationResult {
  detail: Record<string, unknown>;
  /** Invariant violations found during the iteration (empty = pass). */
  violations: string[];
}

/**
 * Runs `body` once per seed, records the seed → outcome table to the
 * artifact file, and returns it. Never throws for a failing iteration — the
 * caller asserts on the table so every failing seed is reported together.
 */
export async function runCampaign(
  suite: string,
  scenario: string,
  body: (seed: number, random: Rng) => Promise<IterationResult>,
): Promise<CampaignTable> {
  const seeds = scenarioSeeds(scenario);
  const rows: IterationRow[] = [];
  const campaignStart = nowMs();
  for (const seed of seeds) {
    const started = nowMs();
    let verdict: Verdict = 'pass';
    let detail: Record<string, unknown> = {};
    let error = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<'deadlock'>(resolve => {
      timer = setTimeout(() => resolve('deadlock'), ITERATION_WALL_MS);
    });
    try {
      const outcome = await Promise.race([
        body(seed, seededRandom(seed)).then(result => ({
          kind: 'done' as const,
          result,
        })),
        wall.then(() => ({ kind: 'deadlock' as const })),
      ]);
      if (outcome.kind === 'deadlock') {
        verdict = 'deadlock';
        error = `iteration exceeded ${ITERATION_WALL_MS}ms wall bound`;
      } else {
        detail = outcome.result.detail;
        if (outcome.result.violations.length > 0) {
          verdict = 'fail';
          error = outcome.result.violations.join(' | ');
        }
      }
    } catch (thrown) {
      verdict = 'fail';
      error = `threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    rows.push({
      seed,
      verdict,
      detail,
      error,
      durationMs: Math.round((nowMs() - started) * 1000) / 1000,
    });
  }
  const table: CampaignTable = {
    suite,
    scenario,
    runId: RUN_ID,
    iterations: rows.length,
    passed: rows.filter(r => r.verdict === 'pass').length,
    failed: rows.filter(r => r.verdict === 'fail').length,
    deadlocked: rows.filter(r => r.verdict === 'deadlock').length,
    failingSeeds: rows.filter(r => r.verdict !== 'pass').map(r => r.seed),
    maxDurationMs: rows.reduce((m, r) => Math.max(m, r.durationMs), 0),
    totalDurationMs: Math.round((nowMs() - campaignStart) * 1000) / 1000,
    replay: `STRESS_SEED=<seed> npx jest --ci __tests__/stress/${suite}.stress.test.ts`,
    rows,
  };
  fs.mkdirSync(artifactDir(), { recursive: true });
  fs.writeFileSync(
    artifactFile(suite, scenario),
    `${JSON.stringify(table, null, 2)}\n`,
  );
  return table;
}

/** Human-readable failure summary for the jest assertion message. */
export function describeFailures(table: CampaignTable): string {
  const failing = table.rows.filter(r => r.verdict !== 'pass');
  if (failing.length === 0) return '';
  return failing
    .slice(0, 10)
    .map(r => `seed ${r.seed} [${r.verdict}]: ${r.error}`)
    .join('\n');
}

/** Structural deep-equality on JSON-able values (order-sensitive). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v,
  );
}
