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
 * A failed preference write or a failed OS reconcile must never be
 * invisible: the store records each as a flag the settings screen renders,
 * and clears it again on the next success.
 */

const mockKvTable = new Map<string, string>();
let mockKvWriteFails = false;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteFails) throw new Error('disk full');
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import { useNotificationStore } from '../../src/notifications/notificationStore';

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  appliedPlans: PlannedNotification[][] = [];
  applyFails = false;
  cancelFails = false;

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    if (this.applyFails) throw new Error('notifee unavailable');
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    if (this.cancelFails) throw new Error('notifee unavailable');
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

function deps(scheduler: FakeScheduler) {
  return { scheduler, loadContext: async () => planContext };
}

const owner = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  mockKvTable.clear();
  mockKvWriteFails = false;
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

describe('notification store failure flags', () => {
  it('starts with no failure recorded', () => {
    const state = useNotificationStore.getState();
    expect(state.persistFailed).toBe(false);
    expect(state.scheduleFailed).toBe(false);
  });

  it('records a failed preference write and clears it on the next successful save', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));

    mockKvWriteFails = true;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    let state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(true);
    expect(state.persistFailed).toBe(true);
    expect(state.scheduleFailed).toBe(false);
    expect(
      mockKvTable.get(notificationPrefsKeyForOwner(owner)),
    ).toBeUndefined();

    mockKvWriteFails = false;
    await useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 8 * 60 }, deps(scheduler));
    state = useNotificationStore.getState();
    expect(state.persistFailed).toBe(false);
    expect(
      JSON.parse(mockKvTable.get(notificationPrefsKeyForOwner(owner))!),
    ).toMatchObject({ enabled: true, practiceReminderMinutes: 8 * 60 });
  });

  it('records a failed schedule apply and clears it once a sync succeeds', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));

    scheduler.applyFails = true;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    let state = useNotificationStore.getState();
    expect(state.persistFailed).toBe(false);
    expect(state.scheduleFailed).toBe(true);
    expect(scheduler.appliedPlans).toEqual([]);

    scheduler.applyFails = false;
    await useNotificationStore.getState().syncNow(deps(scheduler));
    state = useNotificationStore.getState();
    expect(state.scheduleFailed).toBe(false);
    expect(scheduler.appliedPlans.length).toBe(1);
  });

  it('records a failed cancel when reminders are turned off', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);

    scheduler.cancelFails = true;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);
  });

  it('keeps both flags independent when the save and the schedule fail together', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    mockKvWriteFails = true;
    scheduler.applyFails = true;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state.persistFailed).toBe(true);
    expect(state.scheduleFailed).toBe(true);
  });

  it('a signed-out hydrate resets both flags', async () => {
    useNotificationStore.setState({
      persistFailed: true,
      scheduleFailed: true,
    });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state.persistFailed).toBe(false);
    expect(state.scheduleFailed).toBe(false);
  });
});
