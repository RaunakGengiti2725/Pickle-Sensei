import type { NotificationPlanContext } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * MSA-P1-2 / MSA-P2-1 / MSA-P2-2 — the notification store under the three
 * interleavings that leaked state across accounts or across in-flight
 * operations:
 *   1. an account switch while the previous account's state is still in
 *      memory (a write must never persist A's prefs under B's key);
 *   2. a foreground re-sync whose context load is still in flight when the
 *      player changes a preference (the last scheduler op must reflect the
 *      newest prefs);
 *   3. a durable read that fails (defaults must not be presented as truth,
 *      and the next write must not destroy the durable row).
 *
 * The kv mock can gate a SELECT (to keep a hydrate in flight) and fail all
 * SELECTs; the scheduler fake records every OS-facing op in order.
 */

const mockKvTable = new Map<string, string>();
let mockKvReadFails = false;
let mockKvReadGate: { key: string; promise: Promise<void> } | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        if (mockKvReadGate && mockKvReadGate.key === key) {
          await mockKvReadGate.promise;
        }
        if (mockKvReadFails) throw new Error('SQLITE_IOERR');
        const value = mockKvTable.get(key);
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
  { kind: 'applyPlan'; plan: PlannedNotification[] } | { kind: 'cancelAll' };

class RecordingScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: SchedulerOp[] = [];
  cancelFails = false;

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'applyPlan', plan: [...plan] });
  }
  async cancelAllPlanned(): Promise<void> {
    if (this.cancelFails) throw new Error('notifee unavailable');
    this.ops.push({ kind: 'cancelAll' });
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

function deps(scheduler: RecordingScheduler) {
  return { scheduler, loadContext: async () => planContext };
}

function gate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { open, promise };
}

function slowContext(): {
  loadContext: () => Promise<NotificationPlanContext>;
  release: () => void;
} {
  const g = gate();
  return {
    loadContext: () => g.promise.then(() => planContext),
    release: g.open,
  };
}

function practiceHour(op: SchedulerOp | undefined): number | null {
  if (!op || op.kind !== 'applyPlan') return null;
  const practice = op.plan.find(item => item.id === 'ps.reminder.practice');
  return practice ? new Date(practice.timestampMs).getHours() : null;
}

const ownerA = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ownerB = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SAVED_MINUTES = 19 * 60;

function seedOptedIn(owner: string) {
  mockKvTable.set(
    notificationPrefsKeyForOwner(owner),
    JSON.stringify({
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: SAVED_MINUTES,
    }),
  );
}

function storedPrefs(owner: string): Record<string, unknown> | undefined {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvReadFails = false;
  mockKvReadGate = null;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('MSA-P1-2 — account switch while the previous account is in memory', () => {
  async function hydrateAOptedIn(scheduler: RecordingScheduler) {
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state).toMatchObject({ hydrated: true, ownerKey: ownerA });
    expect(state.prefs.enabled).toBe(true);
    expect(state.prefs.practiceReminderMinutes).toBe(SAVED_MINUTES);
  }

  it('after the active owner changes, hydrated must not stay true for the previous owner', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAOptedIn(scheduler);

    const readGate = gate();
    mockKvReadGate = {
      key: notificationPrefsKeyForOwner(ownerB),
      promise: readGate.promise,
    };
    setActiveDataOwner(ownerB);
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    const midSwitch = useNotificationStore.getState();
    expect(midSwitch.hydrated && midSwitch.ownerKey === ownerA).toBe(false);
    if (midSwitch.hydrated) {
      expect(midSwitch.ownerKey).toBe(ownerB);
      expect(midSwitch.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    } else {
      expect(midSwitch.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    }

    readGate.open();
    await hydrateB;
    const after = useNotificationStore.getState();
    expect(after).toMatchObject({ hydrated: true, ownerKey: ownerB });
    expect(after.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('setPrefs for the new owner before its hydrate commits must not persist the previous owner’s prefs', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAOptedIn(scheduler);

    const readGate = gate();
    mockKvReadGate = {
      key: notificationPrefsKeyForOwner(ownerB),
      promise: readGate.promise,
    };
    setActiveDataOwner(ownerB);
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    // A settings tap (or the priming card's "Not now") lands mid-switch.
    const write = useNotificationStore
      .getState()
      .setPrefs({ promptDismissed: true }, deps(scheduler));

    const duringSwitch = storedPrefs(ownerB);
    if (duringSwitch) {
      expect(duringSwitch['enabled']).toBe(false);
      expect(duringSwitch['practiceReminderMinutes']).toBe(
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      );
    }

    readGate.open();
    await Promise.all([hydrateB, write]);

    const durableB = storedPrefs(ownerB);
    expect(durableB).toBeDefined();
    expect(durableB!['enabled']).toBe(false);
    expect(durableB!['practiceReminderMinutes']).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    // The player's tap is honored against B's own durable row, not lost.
    expect(durableB!['promptDismissed']).toBe(true);
    // A's row is untouched.
    expect(storedPrefs(ownerA)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: SAVED_MINUTES,
    });
    const state = useNotificationStore.getState();
    expect(state).toMatchObject({ hydrated: true, ownerKey: ownerB });
    expect(state.prefs).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      promptDismissed: true,
    });
    // Nothing of A's plan may be re-armed for B (B is opted out).
    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('cancelAll');
  });
});

describe('MSA-P2-1 — a preference change while a foreground syncNow is in flight', () => {
  async function hydrateEnabled(scheduler: RecordingScheduler) {
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.ops.at(-1)?.kind).toBe('applyPlan');
    scheduler.ops = [];
  }

  it('foreground syncNow in flight + user turns ALL reminders off → nothing may remain scheduled', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateEnabled(scheduler);

    const slow = slowContext();
    const inFlight = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: slow.loadContext });
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');

    slow.release();
    await inFlight;
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });

  it('foreground syncNow in flight + user moves the reminder time → the applied plan uses the NEW time', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateEnabled(scheduler);

    const slow = slowContext();
    const inFlight = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: slow.loadContext });
    await useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 8 * 60 }, deps(scheduler));
    expect(practiceHour(scheduler.ops.at(-1))).toBe(8);

    slow.release();
    await inFlight;
    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('applyPlan');
    expect(practiceHour(last)).toBe(8);
  });

  it('a superseded syncNow does not clear scheduleFailed set by the newer pass', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateEnabled(scheduler);

    const slow = slowContext();
    const inFlight = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: slow.loadContext });
    scheduler.cancelFails = true;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);

    slow.release();
    await inFlight;
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);
    expect(scheduler.ops.some(op => op.kind === 'applyPlan')).toBe(false);
  });
});

describe('MSA-P2-2 — a failing durable read during hydrate', () => {
  it('a failing SELECT must not mark the store hydrated with defaults, and the next write must not destroy the durable row', async () => {
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    const scheduler = new RecordingScheduler();

    mockKvReadFails = true;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const failed = useNotificationStore.getState();
    expect(failed.hydrated).toBe(false);
    expect(failed.readFailed).toBe(true);
    // Unknown prefs are not acted on: nothing armed, nothing disarmed.
    expect(scheduler.ops).toEqual([]);

    // Priming card "Not now" while the read is still failing.
    await useNotificationStore.getState().dismissPrompt(deps(scheduler));
    expect(storedPrefs(ownerA)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: SAVED_MINUTES,
    });
    expect(useNotificationStore.getState().hydrated).toBe(false);
    expect(scheduler.ops.some(op => op.kind === 'applyPlan')).toBe(false);

    // Disk recovers: the saved prefs come back and the plan is re-armed.
    mockKvReadFails = false;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const recovered = useNotificationStore.getState();
    expect(recovered).toMatchObject({
      hydrated: true,
      ownerKey: ownerA,
      readFailed: false,
    });
    expect(recovered.prefs).toMatchObject({
      enabled: true,
      practiceReminderMinutes: SAVED_MINUTES,
      promptDismissed: true,
    });
    expect(storedPrefs(ownerA)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: SAVED_MINUTES,
    });
    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('applyPlan');
    expect(practiceHour(last)).toBe(19);
  });

  it('a foreground syncNow after a failed read retries the read instead of cancelling an opted-in player’s reminders', async () => {
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    const scheduler = new RecordingScheduler();

    mockKvReadFails = true;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().hydrated).toBe(false);

    mockKvReadFails = false;
    await useNotificationStore.getState().syncNow(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state).toMatchObject({ hydrated: true, readFailed: false });
    expect(state.prefs.enabled).toBe(true);
    expect(scheduler.ops.some(op => op.kind === 'cancelAll')).toBe(false);
    expect(practiceHour(scheduler.ops.at(-1))).toBe(19);
  });
});
