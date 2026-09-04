import { buildNotificationPlan } from '../../src/notifications/plan';
import { getScheduler } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  type PlannedNotification,
} from '../../src/notifications/types';
import { Interleaver } from '../../testing/stress/interleaver';
import {
  HeldNotifee,
  randomContext,
  randomPatch,
} from '../../testing/stress/notificationsFixtures';
import {
  randomInt,
  recordStress,
  seededRandom,
  stressSeeds,
} from '../../testing/stress/stressEvidence';

/**
 * CONCURRENCY stress for the native adapter (`NotifeeScheduler`): overlapping
 * `applyPlan` / `cancelAllPlanned` calls against a held native module whose
 * round trips complete in seeded order. Each apply is several native steps
 * (getIds, cancel×n, create×m) so two in-flight applies interleave at the
 * OS boundary exactly as they would on device.
 *
 *   S1 foreign ids (not `ps.`) are never touched.
 *   S2 no call rejects; bounded steps / wall time.
 *   S3 last-issued wins: the settled tray equals the plan of the LAST call
 *      issued (or nothing after a trailing cancel).
 *   S4 no mixed tray: the settled tray is exactly one issued plan or empty,
 *      never a union of two plans (a reminder from a stale plan surviving
 *      next to the new one).
 *
 * Replay: STRESS_SEED=<seed> npx jest notificationServiceConcurrency
 */

const mockNotifee = new HeldNotifee();
jest.mock('react-native-notify-kit', () => mockNotifee.module());

jest.setTimeout(20 * 60 * 1000);

const SUITE = 'notificationServiceConcurrency';
const FOREIGN_ID = 'com.other.app.reminder';
const MAX_ITERATION_WALL_MS = 5000;

function idsOf(plan: readonly PlannedNotification[]): string[] {
  return plan.map(item => item.id).sort();
}

async function iteration(seed: number) {
  const random = seededRandom(seed);
  const il = new Interleaver(random);
  il.setActionBias(0.2 + random() * 0.6);
  mockNotifee.reset();
  mockNotifee.attach(il);
  mockNotifee.pending.set(FOREIGN_ID, { trigger: null });
  const scheduler = getScheduler();
  const context = randomContext(random);

  // Pre-existing owned reminders from a previous session.
  const seedPlan = buildNotificationPlan(
    { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
    context,
  );
  for (const item of seedPlan) {
    if (random() < 0.5) mockNotifee.pending.set(item.id, { trigger: null });
  }

  type Op = { kind: 'apply'; plan: PlannedNotification[] } | { kind: 'cancel' };
  const ops: Op[] = [];
  const rejections: string[] = [];
  const opCount = randomInt(random, 2, 5);
  const burstMode = random() < 0.5;
  const runs: Array<() => Promise<unknown>> = [];
  for (let i = 0; i < opCount; i += 1) {
    const op: Op =
      random() < 0.7
        ? {
            kind: 'apply',
            plan: buildNotificationPlan(
              {
                ...DEFAULT_NOTIFICATION_PREFS,
                ...randomPatch(random),
                enabled: true,
                version: 1,
              },
              context,
            ),
          }
        : { kind: 'cancel' };
    ops.push(op);
    const run = () =>
      (op.kind === 'apply'
        ? scheduler.applyPlan(op.plan)
        : scheduler.cancelAllPlanned()
      ).catch((error: unknown) => {
        rejections.push(error instanceof Error ? error.message : String(error));
      });
    if (burstMode) runs.push(run);
    else il.enqueue(`${op.kind}#${i}`, run);
  }
  if (burstMode) {
    il.enqueue(`burst x${runs.length}`, () => Promise.all(runs.map(r => r())));
  }

  const started = Date.now();
  const { steps, trace } = await il.drain(4000);
  const wallMs = Date.now() - started;

  const tray = mockNotifee.ownedIds();
  const last = ops[ops.length - 1]!;
  const expectedLast = last.kind === 'apply' ? idsOf(last.plan) : [];
  const lastIssuedWins = JSON.stringify(tray) === JSON.stringify(expectedLast);
  const issuedSets = ops.map(op => (op.kind === 'apply' ? idsOf(op.plan) : []));
  const trayIsOneIssuedPlan =
    tray.length === 0 ||
    issuedSets.some(set => JSON.stringify(set) === JSON.stringify(tray));
  const foreignSurvived = mockNotifee.pending.has(FOREIGN_ID);
  const onlyOwnedTouched = [...mockNotifee.pending.keys()].every(
    id => id === FOREIGN_ID || id.startsWith(NOTIFICATION_ID_PREFIX),
  );
  const checks: Record<string, boolean> = {
    'S1.foreignUntouched': foreignSurvived && onlyOwnedTouched,
    'S2.noRejections': rejections.length === 0,
    'S2.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
    'S3.lastIssuedWins': lastIssuedWins,
    'S4.noMixedTray': trayIsOneIssuedPlan,
  };
  const violations = Object.entries(checks)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    ok: violations.length === 0,
    violations,
    steps,
    wallMs,
    burstMode,
    ops: ops.map(op => (op.kind === 'apply' ? idsOf(op.plan) : 'cancel')),
    tray,
    expectedLast,
    createCalls: mockNotifee.createCalls,
    cancelCalls: mockNotifee.cancelCalls,
    rejections,
    ...(violations.length > 0 ? { trace } : {}),
  };
}

describe('NotifeeScheduler under overlapping apply/cancel', () => {
  it('holds S1–S4 for every seed', async () => {
    const failures: string[] = [];
    let executed = 0;
    for (const seed of stressSeeds(`${SUITE}.applyCancelRace`)) {
      const outcome = await recordStress(
        SUITE,
        'applyCancelRace',
        seed,
        { seed },
        () => iteration(seed),
      );
      executed += 1;
      if (!outcome.ok) failures.push(`seed=${seed} ${JSON.stringify(outcome)}`);
    }
    expect(executed).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
