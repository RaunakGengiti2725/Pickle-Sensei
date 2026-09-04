/**
 * Campaign controls + artifact output shared by `__tests__/stress/`.
 *
 *   STRESS_ITER=<n>      random iterations per campaign (default small so the
 *                        suites stay cheap inside `npx jest --ci --silent`)
 *   STRESS_ONLY=<seed>   replay exactly one random seed per campaign
 *   STRESS_OUT=<dir>     JSON result tables (default apps/mobile/artifacts/stress)
 *
 * Deterministic matrices (locale × font scale × width × …) always run in
 * full; only the seeded random campaigns scale with STRESS_ITER.
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
};

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

export const STRESS_ITER: number = (() => {
  const raw = process.env.STRESS_ITER;
  if (raw === undefined) return 12;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`STRESS_ITER must be a non-negative integer, got ${raw}`);
  }
  return parsed;
})();

export const STRESS_ONLY: number | null = (() => {
  const raw = process.env.STRESS_ONLY;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `STRESS_ONLY must be a non-negative integer seed, got ${raw}`,
    );
  }
  return parsed;
})();

export const STRESS_OUT_DIR: string =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

/** Seeds for a random campaign: `STRESS_ONLY` replays one, else `base + i`. */
export function campaignSeeds(
  base: number,
  count: number = STRESS_ITER,
): number[] {
  if (STRESS_ONLY !== null) return [STRESS_ONLY];
  return Array.from({ length: count }, (_, i) => (base + i) >>> 0);
}

export interface CampaignRow {
  campaign: string;
  seed: number;
  cell: string;
  outcome: 'HELD' | 'BROKEN';
  detail: Record<string, unknown>;
  violations: string[];
}

export interface CampaignTable {
  campaign: string;
  generatedAt: string;
  iterations: number;
  held: number;
  broken: number;
  heapUsedMb: number;
  rows: CampaignRow[];
}

export function writeCampaignTable(
  campaign: string,
  rows: readonly CampaignRow[],
): { path: string; table: CampaignTable } {
  const table: CampaignTable = {
    campaign,
    generatedAt: new Date().toISOString(),
    iterations: rows.length,
    held: rows.filter(row => row.outcome === 'HELD').length,
    broken: rows.filter(row => row.outcome === 'BROKEN').length,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    rows: [...rows],
  };
  mkdirSync(STRESS_OUT_DIR, { recursive: true });
  const path = join(STRESS_OUT_DIR, `${campaign}.json`);
  writeFileSync(path, JSON.stringify(table, null, 2));
  return { path, table };
}

/** Writes an arbitrary JSON artifact (rendered trees, minimized payloads). */
export function writeStressArtifact(name: string, data: unknown): string {
  mkdirSync(STRESS_OUT_DIR, { recursive: true });
  const path = join(STRESS_OUT_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

/** Truncates a payload for the result table while keeping it replayable. */
export function summarizePayload(text: string, max = 80): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints.slice(0, max).join('')}…(${codePoints.length} code points)`;
}
