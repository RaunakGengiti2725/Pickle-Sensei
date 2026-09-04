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
 * Does the candidate's own repro (notificationSyncRace.test.ts case 1) still
 * exercise the window it names? It calls setPrefs({enabled:false})
 * synchronously after syncNow(); on the fixed store the reconcile reads
 * prefs one microtask later, so it takes the cancel branch and the gated
 * loadContext is never invoked — the "stale sync resolves its facts" step
 * is a no-op and the generation guard after loadContext is not covered.
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
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.live = [...plan];
  }
  async cancelAllPlanned(): Promise<void> {
    this.live = [];
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

it('D1: the candidate repro sequence actually reaches the gated loadContext', async () => {
  const scheduler = new LiveScheduler();
  const fastDeps = { scheduler, loadContext: async () => planContext };
  await useNotificationStore.getState().hydrate(fastDeps);
  await useNotificationStore.getState().requestPermissionAndEnable(fastDeps);

  let contextReads = 0;
  let open: () => void = () => {};
  const gatePromise = new Promise<void>(resolve => {
    open = resolve;
  });
  // Verbatim ordering from notificationSyncRace.test.ts case 1: no tick
  // between syncNow() and setPrefs().
  const staleSync = useNotificationStore.getState().syncNow({
    scheduler,
    loadContext: async () => {
      contextReads += 1;
      await gatePromise;
      return planContext;
    },
  });
  const disable = useNotificationStore
    .getState()
    .setPrefs({ enabled: false }, fastDeps);
  await new Promise<void>(resolve => setImmediate(resolve));
  open();
  await Promise.all([staleSync, disable]);

  expect(scheduler.live).toEqual([]);
  expect(contextReads).toBe(1);
});
