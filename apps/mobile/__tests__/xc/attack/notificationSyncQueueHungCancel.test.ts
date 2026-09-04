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
 * Head-of-line blocking, native-call variant: a disabled-state reconcile
 * whose OS cancel never settles pins every later reconcile. Turning
 * reminders ON afterwards persists prefs.enabled=true but nothing is ever
 * scheduled and requestPermissionAndEnable() — which the settings screen
 * awaits behind its "requesting" spinner — never resolves.
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
  live: PlannedNotification[] = [];
  ops: string[] = [];
  hangNextCancel = false;

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
    if (this.hangNextCancel) {
      this.hangNextCancel = false;
      this.ops.push('cancelAllPlanned:hung');
      await new Promise<void>(() => {});
    }
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

const owner = '99999999-9999-4999-8999-999999999999';

const SETTLE_MS = 250;

function settleOrTimeout(p: Promise<unknown>): Promise<'settled' | 'timeout'> {
  return Promise.race([
    p.then(() => 'settled' as const),
    new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), SETTLE_MS),
    ),
  ]);
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

describe('notification sync queue — hung OS cancel', () => {
  it('C2: turning reminders on still schedules while an earlier disabled-state sync hangs in the OS cancel', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fastDeps);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().permission).toBe('granted');

    // Foreground sync for the disabled state whose native cancel never settles.
    scheduler.hangNextCancel = true;
    void useNotificationStore.getState().syncNow(fastDeps);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned:hung');

    // The player taps "Turn on reminders".
    const enable = useNotificationStore
      .getState()
      .requestPermissionAndEnable(fastDeps);

    const outcome = await settleOrTimeout(enable);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(outcome).toBe('settled');
    expect(scheduler.live.length).toBeGreaterThan(0);
    expect(scheduler.ops.at(-1)).toMatch(/^applyPlan\(\d+\)$/);
  });
});
