/**
 * xc-matrix-behavioral — replayable evidence for the behavioral scenario
 * matrix (rapid tapping, double submit, navigation during processing,
 * background/resume, cancel, retry, kill/relaunch, stale cached state,
 * simultaneous operations across AnalyzeScreen / appStore / accessStore /
 * sync).
 *
 * Every scenario execution appends one NDJSON line to
 * `artifacts/xc-behavioral/<XC_RUN_ID>/events.ndjson` (repo-root relative)
 * carrying the suite, scenario, seed, the exact inputs derived from that
 * seed, the observed outcome and heap numbers — so any failing seed can be
 * replayed with `XC_SEED=<seed> npx jest <suite>`.
 *
 * Scale is controlled by `XC_SCALE` (number of seeds per fuzzed scenario;
 * default 25) and pinned by `XC_SEED` (a single seed, replay mode).
 */
// Node built-ins for the evidence sink. The mobile tsconfig deliberately
// excludes node typings, so the shims stay local (same convention as
// __tests__/importedRealFootageAnalysis.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export interface ScenarioEvidence {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  durationMs: number;
  heapUsedMb: number;
  rssMb: number;
  atIso: string;
}

const RUN_ID = process.env['XC_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/xcBehavioral → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(repoRoot(), 'artifacts', 'xc-behavioral', RUN_ID);
}

export function evidenceFile(): string {
  return path.join(evidenceDir(), 'events.ndjson');
}

export function appendEvidence(record: ScenarioEvidence): void {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.appendFileSync(evidenceFile(), `${JSON.stringify(record)}\n`);
}

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

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

export function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/** Seeds for a fuzzed scenario: one pinned seed in replay mode, otherwise
 * `XC_SCALE` deterministic seeds derived from the scenario name so every
 * run of the same scale covers the same inputs. */
export function scenarioSeeds(scenario: string): number[] {
  const pinned = process.env['XC_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  const scale = Number(process.env['XC_SCALE'] ?? '25');
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

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * Runs one scenario body, records evidence whether it passes or throws, and
 * re-throws so Jest still reports the failure. `inputs` should be the exact
 * seed-derived plan so the line is enough to replay by hand.
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
      durationMs: Date.now() - started,
      heapUsedMb: mb(mem.heapUsed),
      rssMb: mb(mem.rss),
      atIso: new Date().toISOString(),
    });
  }
}
