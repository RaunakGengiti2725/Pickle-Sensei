import type { NotificationPlanContext } from '../../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * XC-NOTIF-1 — reminders switched OFF while a syncNow is still awaiting its
 * plan context must not be re-applied by that stale sync.
 *
 * Journey: the foreground pass (useNotificationBootstrap → syncNow) is
 * reading the consistency snapshot when the user flips the master switch
 * off. setPrefs({enabled:false}) cancels everything, then the in-flight
 * sync's context resolves. Whatever the OS holds afterwards must be empty.
 *
 * The fake scheduler mirrors what the OS would hold (`live`) and records
 * every op in order so the final state and the op sequence can both be
 * asserted.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
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

import { useNotificationStore } from '../../../src/notifications/notificationStore';

class LiveScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  live = new Map<string, PlannedNotification>();
  ops: string[] = [];

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push(`applyPlan(${plan.length})`);
    this.live.clear();
    for (const item of plan) this.live.set(item.id, item);
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push('cancelAllPlanned');
    this.live.clear();
  }
  async openSystemSettings(): Promise<void> {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

const owner = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  mockKvTable.clear();
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

describe('XC-NOTIF-1 syncNow vs. reminders switched off mid-flight', () => {
  it('leaves nothing scheduled when the master switch turns off while a sync awaits its context', async () => {
    setActiveDataOwner(owner);
    const scheduler = new LiveScheduler();
    const store = useNotificationStore.getState();

    // Reminders on with permission granted: the OS holds a real plan.
    await store.hydrate({ scheduler, loadContext: async () => planContext });
    await store.requestPermissionAndEnable({
      scheduler,
      loadContext: async () => planContext,
    });
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.live.size).toBeGreaterThan(0);

    // Foreground sync starts and blocks on its context read.
    const gate = deferred<NotificationPlanContext>();
    const inFlight = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => gate.promise,
    });

    // User turns reminders off; that sync cancels the schedule.
    await useNotificationStore.getState().setPrefs(
      { enabled: false },
      { scheduler, loadContext: async () => planContext },
    );
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.live.size).toBe(0);

    // The stale sync's context arrives afterwards.
    gate.resolve(planContext);
    await inFlight;

    const state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(false);
    expect(state.scheduleFailed).toBe(false);
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
    expect([...scheduler.live.keys()]).toEqual([]);
  });

  it('cancels instead of applying when permission is revoked while a sync awaits its context', async () => {
    setActiveDataOwner(owner);
    const scheduler = new LiveScheduler();
    const store = useNotificationStore.getState();
    await store.hydrate({ scheduler, loadContext: async () => planContext });
    await store.requestPermissionAndEnable({
      scheduler,
      loadContext: async () => planContext,
    });
    expect(scheduler.live.size).toBeGreaterThan(0);

    const gate = deferred<NotificationPlanContext>();
    const inFlight = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => gate.promise,
    });

    // The OS-level permission flips to denied (Settings app) and the
    // foreground pass records it before the stale context lands.
    scheduler.permission = 'denied';
    await useNotificationStore.getState().refreshPermission({ scheduler });
    expect(useNotificationStore.getState().permission).toBe('denied');

    gate.resolve(planContext);
    await inFlight;

    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
    expect([...scheduler.live.keys()]).toEqual([]);
  });
});
