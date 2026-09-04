/**
 * stress-cmp-notification-priming — replayable evidence sink.
 *
 * Every iteration appends one NDJSON line AND one row of the JSON seed table
 * under `artifacts/stress-notification-priming/<STRESS_RUN_ID>/` (repo-root
 * relative), carrying the seed, the inputs derived from it, the observed
 * measurements and the verdict — so a failing row can be replayed with
 *   cd apps/mobile && STRESS_SEED=<seed> npx jest --ci <suite>
 *
 * Node built-ins are require()d through local shims because the mobile
 * tsconfig excludes node typings (same convention as
 * `testing/xcBehavioral/evidence.ts`).
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
};

const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export interface StressRow {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  /** Set when `verdict` is 'fail': which invariant broke. */
  brokenInvariant?: string;
}

function repoRoot(): string {
  // apps/mobile/testing/stress/notificationPriming → repo root
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(
    repoRoot(),
    'artifacts',
    'stress-notification-priming',
    RUN_ID,
  );
}

export function ndjsonFile(suite: string): string {
  return path.join(evidenceDir(), `${suite}.events.ndjson`);
}

export function seedTableFile(suite: string): string {
  return path.join(evidenceDir(), `${suite}.seeds.json`);
}

const rowsBySuite = new Map<string, StressRow[]>();

/** Records one executed iteration. */
export function record(row: StressRow): StressRow {
  const rows = rowsBySuite.get(row.suite) ?? [];
  rows.push(row);
  rowsBySuite.set(row.suite, rows);
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.appendFileSync(ndjsonFile(row.suite), `${JSON.stringify(row)}\n`);
  return row;
}

export function rowsFor(suite: string): readonly StressRow[] {
  return rowsBySuite.get(suite) ?? [];
}

/** Writes the seed → outcome table for a suite (call from afterAll). */
export function writeSeedTable(
  suite: string,
  meta: Record<string, unknown>,
): string {
  const rows = rowsFor(suite);
  const file = seedTableFile(suite);
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        suite,
        runId: RUN_ID,
        ...meta,
        executed: rows.length,
        failed: rows.filter(r => r.verdict === 'fail').length,
        replay:
          'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress',
        rows,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/** Campaign size: small by default so the harness can live in the suite. */
export function iterations(fallback: number): number {
  const raw = process.env['STRESS_ITER'];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Replay mode: a single pinned seed instead of the generated sequence. */
export function pinnedSeed(): number | null {
  const raw = process.env['STRESS_SEED'];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}
