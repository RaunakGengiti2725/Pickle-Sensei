/**
 * Adversarial attack on the MSA-P1-2 / MSA-P2-1 / MSA-P2-2 candidate fix
 * (candidate 5229ea58, base 4d812e1a) — variants of the original repros
 * that the candidate's owner/pass/readFailed guards do not cover.
 *
 *  X1  Owner switch whose NEW owner's durable read fails: hydrate(B) now
 *      returns early on `readFailed` BEFORE any scheduler call, so the
 *      previous owner's reminders stay armed in the OS queue for the new
 *      account (base 4d812e1a cancelled them via the defaults→syncNow path).
 *  X2  "All off" toggled while a foreground re-sync is INSIDE applyPlan:
 *      the newest-pass guard is checked only around the `await applyPlan`
 *      boundary, but the real NotifeeScheduler.applyPlan is a multi-await
 *      cancel+create sequence, so creates from the superseded pass land AFTER
 *      the newer pass's cancelAll and reminders survive the toggle.
 *  X3  Same as X2 for a sign-out mid-applyPlan: the signed-out store reports
 *      hydrated=true (defaults) while the OS queue still holds ps.* items.
 *  X4  A same-owner re-hydrate whose read fails flips readFailed=true while
 *      the store still holds hydrated=true with the owner's valid prefs — the
 *      settings screen then blocks a working, correctly-loaded owner.
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect reproduced.
 */
import notifee from 'react-native-notify-kit';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockSelectFailuresLeft = 0;
let mockSelectGate: Promise<void> | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockSelectGate) await mockSelectGate;
        if (mockSelectFailuresLeft > 0) {
          mockSelectFailuresLeft -= 1;
          throw new Error('SQLITE_IOERR: disk I/O error');
        }
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import { useNotificationStore } from '../../src/notifications/notificationStore';

type SchedulerOp =
  { kind: 'apply'; plan: PlannedNotification[] } | { kind: 'cancelAll' };

class RecordingScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: SchedulerOp[] = [];
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'apply', plan: [...plan] });
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push({ kind: 'cancelAll' });
  }
  async openSystemSettings(): Promise<void> {}
}

const mockedNotifee = notifee as unknown as {
  createTriggerNotification: jest.Mock;
  getTriggerNotificationIds: jest.Mock<Promise<string[]>>;
  cancelTriggerNotification: jest.Mock;
};

/**
 * Every native bridge call costs at least one event-loop turn (the auto-mock
 * resolves in a microtask). Wrapping the three queue calls this way keeps the
 * relative order "SQLite kv write settles before the next bridge reply", which
 * is the ordering a real device produces when a tap lands mid-applyPlan.
 */
function slowBridge() {
  const wrap = (fn: jest.Mock) => {
    const impl = fn.getMockImplementation() as (
      ...args: unknown[]
    ) => Promise<unknown>;
    fn.mockImplementation(async (...args: unknown[]) => {
      await new Promise<void>(r => setTimeout(r, 0));
      return impl(...args);
    });
    return () => fn.mockImplementation(impl);
  };
  const restores = [
    wrap(mockedNotifee.createTriggerNotification),
    wrap(mockedNotifee.getTriggerNotificationIds),
    wrap(mockedNotifee.cancelTriggerNotification),
  ];
  return () => restores.forEach(restore => restore());
}

const context: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 0,
  practicedToday: false,
  hasAnyHistory: true,
};

const ownerA = '33333333-3333-4333-8333-333333333333';
const ownerB = '44444444-4444-4444-8444-444444444444';

function seedPrefs(owner: string, patch: Partial<NotificationPrefs>) {
  const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, ...patch };
  mockKvTable.set(notificationPrefsKeyForOwner(owner), JSON.stringify(prefs));
  return prefs;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

async function osQueue(): Promise<string[]> {
  return (await mockedNotifee.getTriggerNotificationIds()).filter(id =>
    id.startsWith('ps.'),
  );
}

async function clearOsQueue() {
  for (const id of await mockedNotifee.getTriggerNotificationIds()) {
    await notifee.cancelTriggerNotification(id);
  }
}

/** Spin until the superseded pass has created ≥ 1 trigger of its own. */
async function untilCreatesSince(baseline: number) {
  for (let i = 0; i < 200; i += 1) {
    if (mockedNotifee.createTriggerNotification.mock.calls.length > baseline) {
      return;
    }
    await (i % 2 ? flush() : Promise.resolve());
  }
  throw new Error('applyPlan never started creating triggers');
}

beforeEach(async () => {
  mockKvTable.clear();
  mockSelectFailuresLeft = 0;
  mockSelectGate = null;
  await clearOsQueue();
  mockedNotifee.createTriggerNotification.mockClear();
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    readFailed: false,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('X1 — owner switch + failed read for the new owner leaves the previous owner armed', () => {
  it.each([
    ['canonical A → canonical B', ownerA, ownerB],
    ['guest → canonical sign-in', GUEST_DATA_OWNER, ownerB],
  ])(
    "%s: hydrate(new owner) with a failing SELECT must still cancel the old owner's reminders",
    async (_label, previous, next) => {
      setActiveDataOwner(previous);
      seedPrefs(previous, {
        enabled: true,
        promptDismissed: true,
        practiceReminderMinutes: 19 * 60,
      });
      const scheduler = new RecordingScheduler();
      await useNotificationStore
        .getState()
        .hydrate({ scheduler, loadContext: async () => context });
      expect(scheduler.ops.at(-1)?.kind).toBe('apply');
      scheduler.ops = [];

      // Account switch; the new owner's durable row cannot be read right now.
      setActiveDataOwner(next);
      mockSelectFailuresLeft = 1;
      await useNotificationStore
        .getState()
        .hydrate({ scheduler, loadContext: async () => context });

      const state = useNotificationStore.getState();
      expect(state.hydrated).toBe(false);
      // The previous owner's plan is not this owner's plan: the OS queue must
      // have been cleared (base 4d812e1a did cancelAll here).
      expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });
    },
  );

  it('foreground retry that fails again still never cancels — the leak persists across foregrounds', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, { enabled: true, promptDismissed: true });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    scheduler.ops = [];

    setActiveDataOwner(ownerB);
    mockSelectFailuresLeft = 3;
    for (let i = 0; i < 3; i += 1) {
      // useNotificationBootstrap re-hydrates on every foreground while
      // readFailed; each attempt fails the same way.
      await useNotificationStore
        .getState()
        .hydrate({ scheduler, loadContext: async () => context });
    }
    expect(useNotificationStore.getState().readFailed).toBe(true);
    expect(scheduler.ops.some(op => op.kind === 'cancelAll')).toBe(true);
  });
});

describe('X2 — "all off" during a foreground re-sync that is inside applyPlan', () => {
  it('reminders must not survive setPrefs({enabled:false}) issued while the previous pass is creating triggers', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, { enabled: true, promptDismissed: true });
    await useNotificationStore
      .getState()
      .hydrate({ loadContext: async () => context });
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect((await osQueue()).length).toBeGreaterThan(0);
    const restoreBridge = slowBridge();

    // Foreground re-sync: slow context load, then the real NotifeeScheduler
    // applyPlan (cancel existing ids → create each planned trigger).
    let releaseContext!: () => void;
    const gate = new Promise<void>(r => (releaseContext = r));
    const foregroundSync = useNotificationStore.getState().syncNow({
      loadContext: async () => {
        await gate;
        return context;
      },
    });
    const createsBefore =
      mockedNotifee.createTriggerNotification.mock.calls.length;
    releaseContext();
    await untilCreatesSince(createsBefore);

    // User flips the master switch off while that applyPlan is mid-flight.
    const turnOff = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, { loadContext: async () => context });
    await Promise.all([foregroundSync, turnOff]);
    await flush();
    restoreBridge();

    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(await osQueue()).toEqual([]);
  });
});

describe('X3 — sign-out while a re-sync is inside applyPlan', () => {
  it('signed-out store reports hydrated with defaults while the OS queue must be empty', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, { enabled: true, promptDismissed: true });
    await useNotificationStore
      .getState()
      .hydrate({ loadContext: async () => context });
    expect((await osQueue()).length).toBeGreaterThan(0);
    const restoreBridge = slowBridge();

    let releaseContext!: () => void;
    const gate = new Promise<void>(r => (releaseContext = r));
    const foregroundSync = useNotificationStore.getState().syncNow({
      loadContext: async () => {
        await gate;
        return context;
      },
    });
    const createsBefore =
      mockedNotifee.createTriggerNotification.mock.calls.length;
    releaseContext();
    await untilCreatesSince(createsBefore);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const signOutHydrate = useNotificationStore.getState().hydrate();
    await Promise.all([foregroundSync, signOutHydrate]);
    await flush();
    restoreBridge();

    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(await osQueue()).toEqual([]);
  });
});

describe('X4 — same-owner re-hydrate whose read fails', () => {
  it('must not flag readFailed over an already-hydrated owner with valid prefs', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 19 * 60,
    });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: ownerA,
      readFailed: false,
    });

    // Foreground / error-boundary remount / "Try again" re-hydrate for the
    // SAME owner hits a transient I/O error.
    mockSelectFailuresLeft = 1;
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });

    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.prefs.practiceReminderMinutes).toBe(19 * 60);
    // Either the in-memory truth stands (readFailed=false) or the store is
    // unhydrated — never "hydrated with valid prefs" AND "read failed".
    expect(state.readFailed && state.hydrated).toBe(false);
  });
});
