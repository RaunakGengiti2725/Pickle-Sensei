/**
 * Failure-injection stress harness for `mod-account-deletion-consent`
 * (deletion.ts / consentApi.ts / onboarding.ts / deviceContext.ts and their
 * store + screen consumers).
 *
 * Every iteration is derived from a seed (mulberry32) and appends one NDJSON
 * line to `artifacts/stress/<STRESS_RUN_ID>/<suite>.ndjson` (repo-root
 * relative) carrying the scenario, seed, the injected fault, the exact
 * inputs, the observed outcome and the verdict, so any line can be replayed
 * with `STRESS_SEED=<seed> npx jest __tests__/stress/<suite>`.
 *
 * Scale: `STRESS_ITER` seeds per scenario (default 12 — cheap enough to live
 * in the suite); `STRESS_SEED` pins one seed (replay mode). Fault kinds are
 * swept deterministically (iteration i → catalog[i % catalog.length]) so a
 * default run still exercises every fault kind at least once per scenario;
 * the seed drives the fault's parameters (status, delay, payload shape…).
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export type Rng = () => number;

/** mulberry32 — deterministic, replayable from its 32-bit seed. */
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

export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() on empty list');
  return items[Math.floor(rng() * items.length)]!;
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';
export const DEFAULT_ITER = 12;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ITER;
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const SEED_STRIDE = 7919;

/** Seeds for one scenario: the pinned STRESS_SEED, or STRESS_ITER seeds
 * derived from the scenario name (same scale ⇒ same seeds every run). */
export function scenarioSeeds(scenario: string): number[] {
  return scenarioCases(scenario).map(([seed]) => seed);
}

/**
 * `[seed, iteration]` pairs for one scenario. The iteration index drives the
 * deterministic fault-kind sweep, so a replay must run the pinned seed under
 * the SAME iteration it originally had: seed_i = base + i·STRIDE, hence
 * i = (seed − base) / STRIDE. A pinned seed that was never one of the
 * scenario's seeds (foreign scenario, hand-picked) replays as iteration 0.
 */
export function scenarioCases(
  scenario: string,
): ReadonlyArray<readonly [seed: number, iteration: number]> {
  const base = fnv1a(scenario);
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') {
    const seed = Number(pinned) >>> 0;
    const offset = (seed - base + 0x1_0000_0000) % 0x1_0000_0000;
    const iteration =
      offset % SEED_STRIDE === 0 && offset / SEED_STRIDE < 100_000
        ? offset / SEED_STRIDE
        : 0;
    return [[seed, iteration]];
  }
  const cases: Array<readonly [number, number]> = [];
  for (let i = 0; i < stressIterations(); i += 1) {
    cases.push([(base + i * SEED_STRIDE) >>> 0, i]);
  }
  return cases;
}

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', RUN_ID);
}

export function evidenceFile(suite: string): string {
  return path.join(evidenceDir(), `${suite}.ndjson`);
}

/**
 * HELD        — the invariant held under the injected fault.
 * BROKEN      — the invariant was violated. Either the iteration threw
 *               (Jest failure) or the body returned it explicitly with a
 *               `finding` id for a reproduced, documented product defect
 *               (the suite stays green; the evidence row carries the id).
 * KNOWN_LIMIT — the fault violates the fetch contract RN relies on
 *               (whatwg-fetch over XHR: honours AbortSignal, resolves only
 *               after the full body) so the observed outcome is recorded but
 *               not asserted as a product defect.
 */
export type Classification = 'HELD' | 'BROKEN' | 'KNOWN_LIMIT';

export interface StressEvidence {
  suite: string;
  scenario: string;
  seed: number;
  iteration: number;
  fault: string;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  classification: Classification;
  finding?: string;
  durationMs: number;
  atIso: string;
}

export function appendEvidence(record: StressEvidence): void {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.appendFileSync(evidenceFile(record.suite), `${JSON.stringify(record)}\n`);
}

export interface ScenarioResult {
  observed: Record<string, unknown>;
  classification?: Classification;
  /** Required when classification is BROKEN without throwing. */
  finding?: string;
}

/**
 * Runs one seeded iteration, records evidence whether it passes or throws,
 * and re-throws so Jest reports the failure. The body returns what it
 * observed plus an optional classification (defaults to HELD on pass).
 */
export async function recordIteration(
  meta: {
    suite: string;
    scenario: string;
    seed: number;
    iteration: number;
    fault: string;
    inputs: Record<string, unknown>;
  },
  body: () => Promise<ScenarioResult>,
): Promise<void> {
  const started = Date.now();
  let observed: Record<string, unknown> = {};
  let verdict: StressEvidence['verdict'] = 'pass';
  let classification: Classification = 'HELD';
  let finding: string | undefined;
  try {
    const result = await body();
    observed = result.observed;
    classification = result.classification ?? 'HELD';
    finding = result.finding;
    if (classification === 'BROKEN') {
      if (!finding) {
        throw new Error('BROKEN classification requires a finding id');
      }
      verdict = 'fail';
    }
  } catch (error) {
    verdict = 'fail';
    classification = 'BROKEN';
    observed = {
      ...observed,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    appendEvidence({
      ...meta,
      observed,
      verdict,
      classification,
      ...(finding ? { finding } : {}),
      durationMs: Date.now() - started,
      atIso: new Date().toISOString(),
    });
  }
}

/** Settlement probe: what a promise did, without awaiting it. */
export interface Settlement<T> {
  settled: boolean;
  resolved: boolean;
  value: T | undefined;
  error: unknown;
  /** Fake-clock ms from probe creation to settlement (Date is faked). */
  settledAfterMs: number | null;
}

export function probe<T>(promise: Promise<T>): Settlement<T> {
  const started = Date.now();
  const state: Settlement<T> = {
    settled: false,
    resolved: false,
    value: undefined,
    error: undefined,
    settledAfterMs: null,
  };
  promise.then(
    value => {
      state.settled = true;
      state.resolved = true;
      state.value = value;
      state.settledAfterMs = Date.now() - started;
    },
    error => {
      state.settled = true;
      state.resolved = false;
      state.error = error;
      state.settledAfterMs = Date.now() - started;
    },
  );
  return state;
}

export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra: Record<string, unknown> = {};
    if ('code' in error) extra['code'] = (error as { code: unknown }).code;
    if ('retryable' in error) {
      extra['retryable'] = (error as { retryable: unknown }).retryable;
    }
    return { name: error.name, message: error.message, ...extra };
  }
  return { nonError: String(error) };
}
