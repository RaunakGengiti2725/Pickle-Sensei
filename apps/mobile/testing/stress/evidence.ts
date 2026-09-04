/**
 * Stress-campaign controls and the seed → outcome JSON table.
 *
 *   STRESS_ITER=<n>      iterations per scenario (default 6 — suite-speed)
 *   STRESS_SEED=<seed>   replay exactly one seed in every scenario
 *   STRESS_TX_MODE=sqlite|serialized|both   transaction model (default both)
 *   STRESS_RUN_ID=<id>   artifacts/stress/<id>/<suite>.json (default: no file)
 *
 * Every iteration is replayable: its seed fully determines the scheduler's
 * interleaving, the fault plan, and the server behaviour.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { TxMode } from './stressDb';

export const STRESS_ITER = (() => {
  const raw = process.env['STRESS_ITER'];
  const n = raw ? Number(raw) : 6;
  return Number.isSafeInteger(n) && n > 0 ? n : 6;
})();

export const STRESS_SEED = (() => {
  const raw = process.env['STRESS_SEED'];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
})();

export const STRESS_TX_MODES: readonly TxMode[] = (() => {
  const raw = process.env['STRESS_TX_MODE'] ?? 'both';
  if (raw === 'sqlite' || raw === 'serialized') return [raw];
  return ['sqlite', 'serialized'];
})();

/** Deterministic per-scenario seed list: base(scenario) + i * 7919. */
export function stressSeeds(scenario: string): number[] {
  if (STRESS_SEED !== null) return [STRESS_SEED];
  let h = 2166136261;
  for (const ch of scenario) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const base = (h % 100_000) + 1;
  return Array.from({ length: STRESS_ITER }, (_, i) => base + i * 7919);
}

export interface StressOutcomeRow {
  suite: string;
  scenario: string;
  txMode: TxMode;
  seed: number;
  status: 'HELD' | 'BROKEN' | 'DEADLOCK';
  steps: number;
  wallMs: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  violations: string[];
  trace?: string[];
}

const rows: StressOutcomeRow[] = [];
const RUN_ID = process.env['STRESS_RUN_ID'] ?? null;

export function recordStressRow(row: StressOutcomeRow): void {
  rows.push(row);
}

export function flushStressTable(suite: string): void {
  if (!RUN_ID) return;
  const dir = join(__dirname, '..', '..', 'artifacts', 'stress', RUN_ID);
  mkdirSync(dir, { recursive: true });
  const mine = rows.filter(r => r.suite === suite);
  const summary = {
    suite,
    runId: RUN_ID,
    iterationsPerScenario: STRESS_ITER,
    txModes: STRESS_TX_MODES,
    executed: mine.length,
    held: mine.filter(r => r.status === 'HELD').length,
    broken: mine.filter(r => r.status === 'BROKEN').length,
    deadlock: mine.filter(r => r.status === 'DEADLOCK').length,
    byScenario: Object.fromEntries(
      [...new Set(mine.map(r => r.scenario))].map(s => {
        const sub = mine.filter(r => r.scenario === s);
        return [
          s,
          {
            executed: sub.length,
            held: sub.filter(r => r.status === 'HELD').length,
            broken: sub.filter(r => r.status === 'BROKEN').length,
            deadlock: sub.filter(r => r.status === 'DEADLOCK').length,
            failingSeeds: sub
              .filter(r => r.status !== 'HELD')
              .map(r => `${r.txMode}:${r.seed}`),
          },
        ];
      }),
    ),
    rows: mine,
  };
  writeFileSync(join(dir, `${suite}.json`), JSON.stringify(summary, null, 2));
}

/**
 * Collect invariant violations instead of throwing on the first one, so the
 * JSON table lists everything a seed broke. `expect` still fails the test.
 */
export class Violations {
  readonly list: string[] = [];
  check(condition: boolean, message: string): void {
    if (!condition) this.list.push(message);
  }
  equal<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
      this.list.push(
        `${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
      );
    }
  }
}
