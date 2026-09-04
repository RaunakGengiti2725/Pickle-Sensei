/**
 * Failure-injection scenario recorder (xc-failure-injection-mobile).
 *
 * Every injected-failure scenario in `__tests__/wf/xc-failure-injection/`
 * runs through `runScenario`, which times the scenario, samples the heap,
 * and appends one JSON line per scenario to
 * `<repo>/artifacts/failure-injection/records/<suite>.jsonl` (override with
 * PICKLE_FI_ARTIFACT_DIR). `build-matrix.mjs` folds those lines into the
 * matrix. The seed and inputs recorded here are sufficient to replay the
 * scenario deterministically with the `replay` command.
 *
 * Verdicts:
 *   safe     – the failure surfaced (typed error / explicit state) and the
 *              store/flow settled; every invariant held.
 *   degraded – the flow settled without a crash but at least one invariant
 *              (no silent failure / no infinite spinner) did NOT hold or
 *              held only partially; a concrete finding is attached.
 *   defect   – an invariant failed outright (hang, leaked resource, wrong
 *              state).
 * `assertInvariants` decides pass/fail per invariant; jest assertions inside
 * the scenario body decide whether the SUITE passes. The suite passes when
 * the OBSERVED behaviour matches the pinned observation — it pins current
 * behaviour so the matrix is reproducible, it never hides a defect.
 */
// The mobile tsconfig has no Node types (same pattern as
// __tests__/importedRealFootageAnalysis.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number };
};
const { appendFileSync, mkdirSync } = require('fs') as {
  appendFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
};
const { resolve } = require('path') as {
  resolve: (...parts: string[]) => string;
};

export type FailureClass =
  'keychain' | 'sqlite' | 'camera' | 'vision' | 'tts' | 'fetch' | 'clock';

export type InvariantVerdict = 'pass' | 'fail' | 'n/a';

export interface Invariants {
  /** A store/flow reached a terminal state within the bounded fake/real time. */
  noInfiniteSpinner: InvariantVerdict;
  /** The failure is visible to the user or caller (typed error, explicit
   * state, thrown error caught by a surfacing boundary) — not swallowed. */
  noSilentFailure: InvariantVerdict;
  /** No exception escaped a Zustand store action or a hook boundary. */
  noStoreCrash: InvariantVerdict;
}

export type Verdict = 'safe' | 'degraded' | 'defect';

export interface ScenarioMeta {
  /** Stable id, e.g. `KC-01`. Used with `jest -t` for replay. */
  id: string;
  failureClass: FailureClass;
  suite: string;
  title: string;
  /** Deterministic seed for every random choice inside the scenario. */
  seed: number;
  /** Exact inputs derived from the seed (error kinds, indices, deltas…). */
  inputs: Record<string, unknown>;
  /** file:line anchors of the boundary under test. */
  files: string[];
}

export interface ScenarioOutcome {
  invariants: Invariants;
  verdict: Verdict;
  observed: string;
  expected: string;
}

export interface ScenarioRecord extends ScenarioMeta, ScenarioOutcome {
  label: 'VERIFIED';
  durationMs: number;
  heapUsedBytesBefore: number;
  heapUsedBytesAfter: number;
  heapDeltaBytes: number;
  replay: string;
  recordedAtIso: string;
  node: string;
}

const DEFAULT_ARTIFACT_DIR = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'artifacts',
  'failure-injection',
);

export function artifactDir(): string {
  return process.env['PICKLE_FI_ARTIFACT_DIR'] ?? DEFAULT_ARTIFACT_DIR;
}

function recordsDir(): string {
  const dir = resolve(artifactDir(), 'records');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function replayCommand(suite: string, id: string): string {
  return `cd apps/mobile && npx jest --ci __tests__/wf/xc-failure-injection/${suite}.test -t "${id}"`;
}

/** mulberry32 — small, deterministic, good enough to pick failure shapes. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export function intBetween(
  rng: () => number,
  min: number,
  max: number,
): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function verdictFor(invariants: Invariants): Verdict {
  const values = Object.values(invariants);
  if (values.includes('fail')) {
    return invariants.noInfiniteSpinner === 'fail' ||
      invariants.noStoreCrash === 'fail'
      ? 'defect'
      : 'degraded';
  }
  return 'safe';
}

export async function runScenario(
  meta: ScenarioMeta,
  body: () => Promise<ScenarioOutcome> | ScenarioOutcome,
): Promise<ScenarioRecord> {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  const outcome = await body();
  const durationMs = Date.now() - startedAt;
  const heapAfter = process.memoryUsage().heapUsed;
  const record: ScenarioRecord = {
    ...meta,
    ...outcome,
    label: 'VERIFIED',
    durationMs,
    heapUsedBytesBefore: heapBefore,
    heapUsedBytesAfter: heapAfter,
    heapDeltaBytes: heapAfter - heapBefore,
    replay: replayCommand(meta.suite, meta.id),
    recordedAtIso: new Date().toISOString(),
    node: process.version,
  };
  appendFileSync(
    resolve(recordsDir(), `${meta.suite}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
  return record;
}

/** Runs `promise` against a fake-timer clock: calls `advance(stepMs)` (the
 * caller passes `ms => jest.advanceTimersByTimeAsync(ms)`) up to `maxMs` of
 * fake time, flushing microtasks between steps. Resolves with
 * `{ settled: true, value }` if the promise settled, `{ settled: false }` if
 * the whole budget elapsed without it settling (⇒ infinite spinner). */
export async function settleWithinFakeTime<T>(
  promise: Promise<T>,
  maxMs: number,
  advance: (ms: number) => Promise<void>,
  stepMs = 1_000,
): Promise<
  | { settled: true; value: T; elapsedMs: number }
  | { settled: false; elapsedMs: number }
> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown = null;
  let failed = false;
  void promise.then(
    resolved => {
      settled = true;
      value = resolved;
    },
    error => {
      settled = true;
      failed = true;
      failure = error;
    },
  );
  let elapsedMs = 0;
  // Let synchronous continuations run first.
  await Promise.resolve();
  while (!settled && elapsedMs < maxMs) {
    await advance(stepMs);
    elapsedMs += stepMs;
  }
  if (!settled) return { settled: false, elapsedMs };
  if (failed) throw failure;
  return { settled: true, value: value as T, elapsedMs };
}
