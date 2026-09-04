/**
 * Evidence sink for the stress suites: one NDJSON line per executed seed
 * plus a JSON table (seed → outcome) at the end of the run, under
 * `artifacts/stress/<STRESS_RUN_ID>/` (repo-root relative, gitignored).
 * Any failing seed replays with `STRESS_SEED=<seed> npx jest <suite>`.
 */
// The mobile tsconfig excludes node typings; shims stay local (same
// convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export interface StressResult {
  suite: string;
  seed: number;
  mode: string;
  faults: Record<string, unknown>;
  /** Ops in the plan and ops that actually executed (equal unless the
   * seed failed part-way). */
  ops: number;
  executedOps: number;
  /** User intents (taps / typed edits) the plan issues. */
  intents: number;
  applied: number;
  blocked: number;
  absent: number;
  counters: Record<string, number>;
  finalStage: string;
  observations: string[];
  consoleWarnings: number;
  verdict: 'pass' | 'fail';
  failure: string | null;
  durationMs: number;
  replay: string;
  /** The full op list the seed expands to (kept in the NDJSON stream and,
   * for failing seeds, in the table so a failure reads without replaying). */
  plan: unknown[];
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', RUN_ID);
}

function fileStem(suite: string): string {
  return suite.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export function appendResult(result: StressResult): void {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.appendFileSync(
    path.join(evidenceDir(), `${fileStem(result.suite)}.ndjson`),
    `${JSON.stringify(result)}\n`,
  );
}

export function writeTable(suite: string, results: StressResult[]): void {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  const executedOps = results.reduce((n, r) => n + r.executedOps, 0);
  const intents = results.reduce((n, r) => n + r.intents, 0);
  const table = {
    suite,
    runId: RUN_ID,
    atIso: new Date().toISOString(),
    seeds: results.length,
    passed: results.filter(r => r.verdict === 'pass').length,
    failed: results.filter(r => r.verdict === 'fail').map(r => r.seed),
    executedOps,
    intents,
    observations: results
      .filter(r => r.observations.length > 0)
      .map(r => ({ seed: r.seed, observations: r.observations })),
    results: results.map(r => ({
      seed: r.seed,
      mode: r.mode,
      faults: r.faults,
      ops: r.executedOps,
      intents: r.intents,
      applied: r.applied,
      blocked: r.blocked,
      absent: r.absent,
      counters: r.counters,
      finalStage: r.finalStage,
      verdict: r.verdict,
      failure: r.failure,
      durationMs: r.durationMs,
      replay: r.replay,
      ...(r.verdict === 'fail' ? { plan: r.plan } : {}),
    })),
  };
  fs.writeFileSync(
    path.join(evidenceDir(), `${fileStem(suite)}.table.json`),
    `${JSON.stringify(table, null, 2)}\n`,
  );
}
