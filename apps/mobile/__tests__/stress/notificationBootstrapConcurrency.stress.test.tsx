import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';
import { Interleaver } from '../../testing/stress/interleaver';
import {
  FakeKvDb,
  HeldNotifee,
  randomPatch,
} from '../../testing/stress/notificationsFixtures';
import {
  pick,
  randomInt,
  recordStress,
  seededRandom,
  stressSeeds,
} from '../../testing/stress/stressEvidence';

/**
 * CONCURRENCY stress for the App.tsx bootstrap hook with NOTHING in the
 * notification module faked: real store, real `NotifeeScheduler`, real
 * `computeConsistencySnapshot` context loader. Only the two I/O edges are
 * held: SQLite (`getDb`, FIFO — op-sqlite runs one worker) and the native
 * notification module (random completion order). Drives, in seeded order and
 * overlapping: owner changes (sign-in / rotate / guest / sign-out) through
 * the hook prop, foreground `AppState` events (including bursts), and
 * settings-screen `setPrefs` writes.
 *
 *   B1 bounded steps / wall time, no rejections (no deadlock).
 *   B2 after settling, the store's owner is the active owner and hydrated.
 *   B3 durable prefs for the final owner equal memory (no lost update).
 *   B4 the OS tray equals the plan for the settled state: ids of
 *      buildNotificationPlan(prefs) when owner ∈ {uuid, guest} ∧ enabled ∧
 *      permission granted; otherwise empty. Signed-out ⇒ empty.
 *   B5 previous owner's row is never written by anything issued after the
 *      rotation.
 *
 * Replay: STRESS_SEED=<seed> npx jest notificationBootstrapConcurrency
 * (STRESS_TRACE=1 also prints the interleaving trace.)
 */

const mockNotifee = new HeldNotifee();
jest.mock('react-native-notify-kit', () => mockNotifee.module());

let mockDb: FakeKvDb | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockDb) throw new Error('db not attached');
    return mockDb;
  },
}));

jest.setTimeout(20 * 60 * 1000);

const SUITE = 'notificationBootstrapConcurrency';
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const MAX_ITERATION_WALL_MS = 8000;

function Host({ ownerKey }: { ownerKey: string | null }) {
  useNotificationBootstrap(ownerKey);
  return null;
}

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

async function iteration(seed: number) {
  const random = seededRandom(seed);
  const il = new Interleaver(random);
  il.lane('sqlite', 'fifo');
  il.lane('native', 'random');
  il.setActionBias(0.15 + random() * 0.6);
  const db = new FakeKvDb(il);
  mockDb = db;
  mockNotifee.reset();
  mockNotifee.attach(il);
  mockNotifee.authorizationStatus = 1;
  resetStore();

  // Owner A has reminders on from a previous session; B is fresh.
  db.table.set(
    notificationPrefsKeyForOwner(OWNER_A),
    JSON.stringify({
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      practiceReminder: true,
    }),
  );

  let appStateHandler: ((state: string) => void) | null = null;
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });

  const rejections: string[] = [];
  const guard = (label: string, run: () => unknown) => {
    Promise.resolve()
      .then(run)
      .catch((error: unknown) => {
        rejections.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  setActiveDataOwner(OWNER_A);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Host ownerKey={OWNER_A} />);
  });

  const owners = [OWNER_A, OWNER_B, GUEST_DATA_OWNER, SIGNED_OUT_DATA_OWNER];
  let currentOwner = OWNER_A;
  const timeline: string[] = [];
  let lastRotationStep = -1;
  let previousOwner: string | null = null;
  const actionCount = randomInt(random, 2, 7);
  for (let i = 0; i < actionCount; i += 1) {
    const kind = pick(random, [
      'rotate',
      'foreground',
      'foreground',
      'foregroundBurst',
      'setPrefs',
      'setPrefs',
      'revoke',
    ] as const);
    if (kind === 'rotate') {
      const next = pick(
        random,
        owners.filter(o => o !== currentOwner),
      );
      il.enqueue(`rotate→${next}`, async () => {
        timeline.push(`rotate:${next}`);
        previousOwner = currentOwner;
        currentOwner = next;
        lastRotationStep = il.trace.length;
        // authStore flips the owner synchronously before App re-renders.
        setActiveDataOwner(next);
        await act(async () => {
          renderer.update(<Host ownerKey={next} />);
        });
      });
    } else if (kind === 'foreground') {
      il.enqueue('foreground', () => {
        timeline.push('foreground');
        appStateHandler?.('active');
      });
    } else if (kind === 'foregroundBurst') {
      const n = randomInt(random, 2, 4);
      il.enqueue(`foreground x${n}`, () => {
        timeline.push(`foreground x${n}`);
        for (let j = 0; j < n; j += 1) appStateHandler?.('active');
      });
    } else if (kind === 'setPrefs') {
      const patch = randomPatch(random);
      il.enqueue(`setPrefs ${JSON.stringify(patch)}`, () => {
        timeline.push(`setPrefs:${JSON.stringify(patch)}`);
        guard('setPrefs', () =>
          useNotificationStore.getState().setPrefs(patch),
        );
      });
    } else {
      il.enqueue('revoke/regrant', () => {
        mockNotifee.authorizationStatus =
          mockNotifee.authorizationStatus === 1 ? 0 : 1;
        timeline.push(`authorizationStatus=${mockNotifee.authorizationStatus}`);
        appStateHandler?.('active');
      });
    }
  }

  const started = Date.now();
  const { steps, trace } = await il.drain(6000);
  if (process.env.STRESS_TRACE) console.log(JSON.stringify(trace));
  const wallMs = Date.now() - started;

  const state = useNotificationStore.getState();
  const active = getActiveDataOwner();
  const ownerOk =
    active === SIGNED_OUT_DATA_OWNER
      ? state.ownerKey === SIGNED_OUT_DATA_OWNER
      : state.hydrated && state.ownerKey === active;
  const durable = parseNotificationPrefs(
    db.table.get(notificationPrefsKeyForOwner(active)) ?? null,
  );
  const durableOk =
    active === SIGNED_OUT_DATA_OWNER ||
    state.persistFailed ||
    JSON.stringify(durable) === JSON.stringify(state.prefs);
  const permissionGranted = mockNotifee.authorizationStatus === 1;
  const schedulingAllowed =
    active !== SIGNED_OUT_DATA_OWNER &&
    state.ownerKey === active &&
    state.prefs.enabled &&
    state.permission === 'granted' &&
    permissionGranted;
  const expectedIds = schedulingAllowed
    ? buildNotificationPlan(state.prefs, {
        nowMs: Date.now(),
        streakDays: 0,
        practicedToday: false,
        hasAnyHistory: false,
        shieldsAvailable: 0,
        milestoneEve: null,
      })
        .map(item => item.id)
        .sort()
    : [];
  const tray = mockNotifee.ownedIds();
  const trayOk = JSON.stringify(tray) === JSON.stringify(expectedIds);
  const lateWrites =
    previousOwner === null || previousOwner === SIGNED_OUT_DATA_OWNER
      ? []
      : db.writes.filter(
          w =>
            w.issuedStep > lastRotationStep &&
            w.key === notificationPrefsKeyForOwner(previousOwner!) &&
            previousOwner !== active,
        );

  await act(async () => {
    renderer.unmount();
  });
  spy.mockRestore();
  mockDb = null;

  const checks: Record<string, boolean> = {
    'B1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
    'B1.noRejections': rejections.length === 0,
    'B2.ownerHydrated': ownerOk,
    'B3.durableMatchesMemory': durableOk,
    'B4.trayReconciled': trayOk,
    'B4.scheduleSucceeded': !state.scheduleFailed,
    'B5.noLateWriteToPreviousOwner': lateWrites.length === 0,
  };
  const violations = Object.entries(checks)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    ok: violations.length === 0,
    violations,
    steps,
    wallMs,
    timeline,
    finalOwner: active,
    state: {
      hydrated: state.hydrated,
      ownerKey: state.ownerKey,
      permission: state.permission,
      enabled: state.prefs.enabled,
      persistFailed: state.persistFailed,
      scheduleFailed: state.scheduleFailed,
    },
    tray,
    expectedIds,
    lateWrites: lateWrites.length,
    rejections,
    ...(violations.length > 0 ? { trace } : {}),
  };
}

describe('useNotificationBootstrap end-to-end under owner/foreground races', () => {
  it('holds B1–B5 for every seed', async () => {
    const failures: string[] = [];
    let executed = 0;
    for (const seed of stressSeeds(`${SUITE}.ownerForegroundRace`)) {
      const outcome = await recordStress(
        SUITE,
        'ownerForegroundRace',
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
