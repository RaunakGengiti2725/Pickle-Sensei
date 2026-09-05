import { seedSchedule } from './prng';

/**
 * Campaign plumbing shared by the mod-app-root stress suites: iteration
 * budget from the environment, JSON result tables on disk, and the
 * BROKEN/HELD accounting the coordinator reads.
 *
 * Environment:
 * - `STRESS_ITER`   iterations per suite campaign (default small enough for
 *                   the normal `npx jest --ci --silent` run; the coordinator
 *                   runs `STRESS_ITER=1000`+ for the ≥3000-input campaign).
 * - `STRESS_SEED`   replay exactly one seed (the campaign then has one row).
 * - `STRESS_CAMPAIGN_SEED` the root seed the per-iteration seeds derive
 *                   from (default 0x5eed_0001). A small run is a strict
 *                   prefix of a larger run with the same campaign seed.
 * - `STRESS_ARTIFACT_DIR` where the JSON tables go (default
 *                   `<repo>/artifacts/stress-mod-app-root/`, gitignored).
 *
 * apps/mobile's tsconfig types only `jest` (no @types/node), so the Node
 * surface used here is declared explicitly, as the xc harness does.
 */

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;

interface NodeFs {
  mkdirSync(dir: string, options?: { recursive?: boolean }): void;
  writeFileSync(file: string, data: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

const fs = require('node:fs') as NodeFs;
const path = require('node:path') as NodePath;

export const DEFAULT_CAMPAIGN_SEED = 0x5eed0001;

export interface CampaignPlan {
  suite: string;
  campaignSeed: number;
  iterations: number;
  seeds: number[];
  replayOnly: boolean;
}

export function planCampaign(
  suite: string,
  defaultIterations: number,
): CampaignPlan {
  const env = process.env;
  const campaignSeed =
    parseSeed(env['STRESS_CAMPAIGN_SEED']) ?? DEFAULT_CAMPAIGN_SEED;
  const replay = parseSeed(env['STRESS_SEED']);
  if (replay !== null) {
    return {
      suite,
      campaignSeed,
      iterations: 1,
      seeds: [replay],
      replayOnly: true,
    };
  }
  const requested = Number.parseInt(env['STRESS_ITER'] ?? '', 10);
  const iterations =
    Number.isFinite(requested) && requested > 0 ? requested : defaultIterations;
  return {
    suite,
    campaignSeed,
    iterations,
    seeds: seedSchedule(campaignSeed, iterations),
    replayOnly: false,
  };
}

function parseSeed(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed >>> 0;
}

/** One executed iteration. `inputs` + `seed` are the replay key. */
export interface StressRow {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  durationMs: number;
}

export function finishRow(row: Omit<StressRow, 'ok' | 'failed'>): StressRow {
  const failed = Object.entries(row.invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return { ...row, ok: failed.length === 0, failed };
}

export function artifactDir(): string {
  const configured = process.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-mod-app-root');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export interface CampaignSummary {
  suite: string;
  campaignSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  failedSeeds: Array<{ seed: number; scenario: string; failed: string[] }>;
  byInvariant: Record<string, { checked: number; failed: number }>;
  byFamily: Record<string, { executed: number; failed: number }>;
  byOutcome: Record<string, number>;
  wallMs: number;
}

export function summarize(
  plan: CampaignPlan,
  rows: StressRow[],
  wallMs: number,
  familyOf: (row: StressRow) => string,
  outcomeOf: (row: StressRow) => string,
): CampaignSummary {
  const byInvariant: CampaignSummary['byInvariant'] = {};
  const byFamily: CampaignSummary['byFamily'] = {};
  const byOutcome: CampaignSummary['byOutcome'] = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
    const family = familyOf(row);
    const familySlot = (byFamily[family] ??= { executed: 0, failed: 0 });
    familySlot.executed += 1;
    if (!row.ok) familySlot.failed += 1;
    const outcome = outcomeOf(row);
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }
  return {
    suite: plan.suite,
    campaignSeed: plan.campaignSeed,
    iterations: plan.iterations,
    executed: rows.length,
    held: rows.filter(row => row.ok).length,
    broken: rows.filter(row => !row.ok).length,
    failedSeeds: rows
      .filter(row => !row.ok)
      .map(row => ({
        seed: row.seed,
        scenario: row.scenario,
        failed: row.failed,
      })),
    byInvariant,
    byFamily,
    byOutcome,
    wallMs,
  };
}

/**
 * Capture the outcome of a call that may throw ANY value, including values
 * hostile to String()/instanceof; never lets the hostile value escape into
 * the result table.
 */
export function capture<T>(
  fn: () => T,
): { threw: false; value: T } | { threw: true; error: string } {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, error: describeThrown(error) };
  }
}

export function describeThrown(error: unknown): string {
  try {
    if (error instanceof Error) {
      const frame =
        typeof error.stack === 'string'
          ? (error.stack
              .split('\n')
              .map(line => line.trim())
              .find(line => line.startsWith('at ')) ?? '')
          : '';
      return `${error.name}: ${error.message.slice(0, 200)}${frame ? ` @ ${frame.slice(0, 160)}` : ''}`;
    }
    if (typeof error === 'symbol') return `symbol(${error.description ?? ''})`;
    if (typeof error === 'bigint') return `bigint(${error.toString()})`;
    if (typeof error === 'string') return `string(${error.slice(0, 200)})`;
    if (error === null || typeof error !== 'object')
      return `${typeof error}(${String(error)})`;
    return `object(${Object.prototype.toString.call(error)})`;
  } catch (inner) {
    return `<indescribable thrown value: ${inner instanceof Error ? inner.message : typeof inner}>`;
  }
}
