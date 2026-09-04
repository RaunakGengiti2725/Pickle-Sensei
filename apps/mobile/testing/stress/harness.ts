/**
 * Per-iteration wiring shared by the stress suites: scheduler + stress db +
 * permit server + owner reset, plus the HELD / BROKEN / DEADLOCK bookkeeping
 * that feeds the seed → outcome table.
 */
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  recordStressRow,
  STRESS_TX_MODES,
  stressSeeds,
  Violations,
} from './evidence';
import { createPermitServer, type PermitServer } from './permitServer';
import {
  createScheduler,
  StressDeadlock,
  type StressScheduler,
} from './scheduler';
import { createStressDb, type StressDb, type TxMode } from './stressDb';

export const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TOKEN_A = 'bearer-a';
export const API_A = { baseUrl: 'https://api.stress', token: TOKEN_A };

export interface IterationContext {
  seed: number;
  txMode: TxMode;
  scheduler: StressScheduler;
  db: StressDb;
  server: PermitServer;
  violations: Violations;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
}

export interface IterationOptions {
  freeRatings?: (s: StressScheduler) => number;
  premium?: (s: StressScheduler) => boolean;
  maxSteps?: number;
  maxWallMs?: number;
}

/**
 * Declares one `it` per (txMode, seed) for `scenario`. `body` drives the unit
 * and fills `ctx.violations`; the test fails when any violation remains, and
 * the row is recorded either way so the JSON table carries every outcome.
 */
export function stressScenario(
  suite: string,
  scenario: string,
  options: IterationOptions,
  body: (ctx: IterationContext) => Promise<void>,
): void {
  for (const txMode of STRESS_TX_MODES) {
    for (const seed of stressSeeds(scenario)) {
      it(`${scenario} [${txMode}] seed ${seed}`, async () => {
        const scheduler = createScheduler(seed, {
          maxSteps: options.maxSteps,
          maxWallMs: options.maxWallMs,
        });
        const db = createStressDb(scheduler, txMode);
        const server = createPermitServer(scheduler, {
          freeRatings: options.freeRatings ? options.freeRatings(scheduler) : 3,
          premium: options.premium ? options.premium(scheduler) : false,
        });
        setActiveDataOwner(OWNER_A);
        server.install();
        const ctx: IterationContext = {
          seed,
          txMode,
          scheduler,
          db,
          server,
          violations: new Violations(),
          inputs: {},
          observed: {},
        };
        let status: 'HELD' | 'BROKEN' | 'DEADLOCK' = 'HELD';
        let deadlock: StressDeadlock | null = null;
        const startedAt = Date.now();
        try {
          await body(ctx);
        } catch (error) {
          if (error instanceof StressDeadlock) {
            deadlock = error;
            status = 'DEADLOCK';
            ctx.violations.list.push(`deadlock: ${error.message}`);
          } else {
            throw error;
          }
        } finally {
          server.uninstall();
          setActiveDataOwner(OWNER_A);
        }
        if (status !== 'DEADLOCK' && ctx.violations.list.length > 0) {
          status = 'BROKEN';
        }
        ctx.observed['openTransactions'] = db.openTransactions();
        ctx.observed['beginCollisions'] = db.beginCollisions;
        ctx.observed['rollbacksAfterBeginCollision'] =
          db.rollbacksAfterBeginCollision;
        ctx.observed['strayTxEnds'] = db.strayTxEnds;
        recordStressRow({
          suite,
          scenario,
          txMode,
          seed,
          status,
          steps: Number(ctx.observed['steps'] ?? 0),
          wallMs: Date.now() - startedAt,
          inputs: ctx.inputs,
          observed: ctx.observed,
          violations: ctx.violations.list,
          ...(status !== 'HELD'
            ? {
                trace: deadlock
                  ? [...deadlock.trace]
                  : (ctx.observed['trace'] as string[] | undefined),
              }
            : {}),
        });
        expect(ctx.violations.list).toEqual([]);
      });
    }
  }
}

/** Yield `n` scheduler slots — a stand-in for work between two seams. */
export async function busy(
  scheduler: StressScheduler,
  label: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i += 1) await scheduler.yieldAt(`${label}#${i}`);
}
