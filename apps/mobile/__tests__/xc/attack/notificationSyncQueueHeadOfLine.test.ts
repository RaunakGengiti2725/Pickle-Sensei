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
 * Head-of-line blocking. The fix serializes every reconcile through one
 * module-level promise chain with no timeout. A single pass that never
 * settles — a context read or a native scheduler call that hangs — therefore
 * pins every later pass behind it: the player turns reminders off, the
 * store's prefs say off, and the OS keeps every reminder scheduled forever.
 *
 * Each case lives in its own file because a hung pass poisons the queue for
 * the rest of the Jest module registry.
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

const owner = '88888888-8888-4888-8888-888888888888';

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

describe('notification sync queue — head-of-line blocking', () => {
  it('C1: disabling reminders still cancels the OS schedule while a foreground sync hangs reading context', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fastDeps);
    await useNotificationStore.getState().requestPermissionAndEnable(fastDeps);
    expect(scheduler.live.length).toBeGreaterThan(0);

    // Foreground bootstrap sync whose practice-facts read never settles.
    void useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => new Promise<NotificationPlanContext>(() => {}),
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    // The player turns reminders off.
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);

    const outcome = await settleOrTimeout(disable);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(outcome).toBe('settled');
    expect(scheduler.live).toEqual([]);
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
  });
});
