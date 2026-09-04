/**
 * Adjudication reproduction (xc-journeys / journey-notifications-permissions):
 * `syncNow` re-checks only the owner after its slow context read, not the
 * preferences. A foreground sync (useNotificationBootstrap fires one on every
 * AppState 'active') that is still reading the consistency snapshot when the
 * user flips reminders OFF re-applies the full plan AFTER the disable path
 * cancelled it, so the OS keeps reminders the user just turned off until the
 * next foreground pass.
 */
import type { NotificationPlanContext } from '../../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

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

class FakeScheduler implements SchedulerPort {
  live = new Set<string>();
  ops: string[] = [];
  async permissionState(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.live = new Set(plan.map(p => p.id));
    this.ops.push(`applyPlan(${plan.length})`);
  }
  async cancelAllPlanned(): Promise<void> {
    this.live.clear();
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

describe('adjudication: notification syncNow vs. disable race', () => {
  beforeEach(() => {
    mockKvTable.clear();
    setActiveDataOwner(owner);
  });
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('reminders switched OFF during an in-flight foreground sync stay scheduled', async () => {
    const scheduler = new FakeScheduler();
    const fast = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(fast);
    await useNotificationStore.getState().requestPermissionAndEnable(fast);
    expect(scheduler.live.size).toBeGreaterThan(0);
    const scheduledWhileOn = scheduler.live.size;

    const release: { context: (() => void) | null } = { context: null };
    const slow = {
      scheduler,
      loadContext: () =>
        new Promise<NotificationPlanContext>(resolve => {
          release.context = () => resolve(planContext);
        }),
    };
    // Foreground pass starts (slow snapshot read) ...
    const foregroundSync = useNotificationStore.getState().syncNow(slow);
    // ... the user flips the master switch OFF while it is still reading.
    await useNotificationStore.getState().setPrefs({ enabled: false }, fast);
    expect(scheduler.live.size).toBe(0);
    release.context?.();
    await foregroundSync;

    const state = useNotificationStore.getState();

    console.log(
      `[adjudicate] prefs.enabled=${state.prefs.enabled} scheduleFailed=${state.scheduleFailed} liveAfter=${scheduler.live.size} ops=${JSON.stringify(scheduler.ops)}`,
    );
    expect(state.prefs.enabled).toBe(false);
    expect(scheduledWhileOn).toBeGreaterThan(0);
    // Expected product behaviour: reminders are OFF, nothing stays queued.
    expect([...scheduler.live]).toEqual([]);
  });
});
