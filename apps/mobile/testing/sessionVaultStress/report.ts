/**
 * Seed → outcome table for the sessionVault stress campaigns.
 *
 * Every executed iteration is one row; the whole table is written as JSON to
 * `artifacts/stress/session-vault/<STRESS_RUN_ID>/<campaign>.json` (repo-root
 * relative, `artifacts/` is git-ignored) so a failing seed can be replayed
 * with `STRESS_SEED=<seed> npx jest <suite>`.
 *
 * Knobs (all environment variables, read once per process):
 *  - STRESS_ITER   iterations per campaign (default 600 — fast enough for CI)
 *  - STRESS_SEED   replay exactly one seed
 *  - STRESS_RUN_ID directory name under artifacts/stress/session-vault
 */
// The mobile tsconfig excludes node typings on purpose; the shims stay local
// (same convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export interface SeedRow {
  seed: number;
  scenario: string;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  violated: string[];
  verdict: 'HELD' | 'BROKEN';
  /** Known failure signature the violations match (see scenario.ts), else null. */
  defectClass: string | null;
  durationMs: number;
}

export interface CampaignTable {
  campaign: string;
  unit: 'apps/mobile/src/account/sessionVault.ts';
  runId: string;
  iterations: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  brokenByDefectClass: Record<string, number>;
  /** BROKEN rows whose signature is not a known defect class. */
  unclassifiedSeeds: number[];
  violationsByInvariant: Record<string, number>;
  wallMs: number;
  rows: SeedRow[];
}

const DEFAULT_ITERATIONS = 600;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ITERATIONS;
}

/** The seeds a campaign runs: one pinned seed, or `base + i` for each iteration. */
export function campaignSeeds(base: number): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') {
    const seed = Number(pinned);
    if (!Number.isFinite(seed)) throw new Error(`STRESS_SEED not a number`);
    return [seed >>> 0];
  }
  const n = stressIterations();
  const seeds: number[] = [];
  for (let i = 0; i < n; i += 1) seeds.push((base + i) >>> 0);
  return seeds;
}

export function runId(): string {
  return process.env['STRESS_RUN_ID'] ?? 'local';
}

function repoRoot(): string {
  // apps/mobile/testing/sessionVaultStress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function reportDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', 'session-vault', runId());
}

export function summarize(
  campaign: string,
  rows: SeedRow[],
  wallMs: number,
): CampaignTable {
  const violationsByInvariant: Record<string, number> = {};
  for (const row of rows) {
    for (const invariant of row.violated) {
      violationsByInvariant[invariant] =
        (violationsByInvariant[invariant] ?? 0) + 1;
    }
  }
  const brokenRows = rows.filter(row => row.verdict === 'BROKEN');
  const brokenByDefectClass: Record<string, number> = {};
  for (const row of brokenRows) {
    const key = row.defectClass ?? 'unclassified';
    brokenByDefectClass[key] = (brokenByDefectClass[key] ?? 0) + 1;
  }
  return {
    campaign,
    unit: 'apps/mobile/src/account/sessionVault.ts',
    runId: runId(),
    iterations: rows.length,
    held: rows.length - brokenRows.length,
    broken: brokenRows.length,
    brokenSeeds: brokenRows.map(row => row.seed),
    brokenByDefectClass,
    unclassifiedSeeds: brokenRows
      .filter(row => row.defectClass === null)
      .map(row => row.seed),
    violationsByInvariant,
    wallMs,
    rows,
  };
}

export function writeTable(table: CampaignTable): string {
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${table.campaign}.json`);
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  return file;
}
