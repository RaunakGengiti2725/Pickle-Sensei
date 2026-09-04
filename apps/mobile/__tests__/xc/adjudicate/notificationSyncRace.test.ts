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
 * XC-P2-NOTIFICATION-STALE-PLAN-RACE — a reconcile that started under one
 * set of preferences must never apply its result once the preferences have
 * moved on. The fake scheduler models what is LIVE on the OS: applyPlan
 * replaces the queue, cancelAllPlanned empties it, and both take effect
 * when the native call resolves (so ordering between overlapping syncs is
 * observable). The fake context is a gate the test opens by hand.
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

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

class LiveScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  live: PlannedNotification[] = [];
  ops: string[] = [];
  /** When set, the next cancelAllPlanned() waits on it before taking effect. */
  cancelGate: Gate | null = null;

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.live = [...plan];
    this.ops.push(`applyPlan(${plan.length})`);
  }
  async cancelAllPlanned(): Promise<void> {
    const pending = this.cancelGate;
    this.cancelGate = null;
    if (pending) await pending.promise;
    this.live = [];
    this.ops.push('cancelAllPlanned');
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

const owner = '55555555-5555-4555-8555-555555555555';

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

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
  setActiveDataOwner(owner);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('notification sync race (stale plan)', () => {
  it('disabling reminders while a sync is loading context leaves nothing live', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fastDeps);
    await useNotificationStore.getState().requestPermissionAndEnable(fastDeps);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.live.length).toBeGreaterThan(0);
    const planSize = scheduler.live.length;

    // A foreground sync starts and blocks while reading practice facts.
    const contextGate = gate();
    const staleSync = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: async () => {
        await contextGate.promise;
        return planContext;
      },
    });

    // The player turns reminders off while that sync is still in flight.
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();

    // The stale sync now resolves its (pre-disable) facts.
    contextGate.open();
    await Promise.all([staleSync, disable]);
    await flush();

    const state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(false);
    expect(state.scheduleFailed).toBe(false);
    expect(scheduler.live).toEqual([]);
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
    // The stale plan was never applied after the disable landed.
    const disableIndex = scheduler.ops.lastIndexOf('cancelAllPlanned');
    expect(
      scheduler.ops
        .slice(disableIndex + 1)
        .filter(op => op.startsWith('applyPlan')),
    ).toEqual([]);
    expect(planSize).toBeGreaterThan(0);
  });

  it('enabling reminders while a disabled sync is cancelling ends with the plan live', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fastDeps);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(scheduler.live).toEqual([]);

    // A foreground sync for the disabled state starts and blocks inside the
    // OS cancel call.
    const cancelGate = gate();
    scheduler.cancelGate = cancelGate;
    const staleSync = useNotificationStore.getState().syncNow(fastDeps);
    await flush();

    // The player turns reminders on while that cancel is still in flight.
    const enable = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, fastDeps);
    await flush();

    cancelGate.open();
    await Promise.all([staleSync, enable]);
    await flush();

    const state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(true);
    expect(state.scheduleFailed).toBe(false);
    expect(scheduler.live.length).toBeGreaterThan(0);
    expect(scheduler.live.map(item => item.id)).toContain(
      'ps.reminder.practice',
    );
    expect(scheduler.ops.at(-1)).toMatch(/^applyPlan\(\d+\)$/);
  });

  it('a burst of overlapping syncs converges on the latest preferences', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fastDeps);
    await useNotificationStore.getState().requestPermissionAndEnable(fastDeps);

    const gates = [gate(), gate(), gate()];
    const syncs = gates.map(g =>
      useNotificationStore.getState().syncNow({
        scheduler,
        loadContext: async () => {
          await g.promise;
          return planContext;
        },
      }),
    );
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();
    // Release the stale syncs out of order.
    gates[2]!.open();
    await flush();
    gates[0]!.open();
    await flush();
    gates[1]!.open();
    await Promise.all([...syncs, disable]);
    await flush();

    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
    expect(scheduler.live).toEqual([]);
  });
});
