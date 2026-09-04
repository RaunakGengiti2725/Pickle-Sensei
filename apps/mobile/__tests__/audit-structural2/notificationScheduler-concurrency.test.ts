/**
 * AUDIT PROBE (structural #2, mobile-settings-account).
 *
 * The scheduler fakes used by the existing suites resolve applyPlan /
 * cancelAllPlanned atomically. The real adapter (service.ts) performs
 * several awaited native calls per operation (getTriggerNotificationIds,
 * cancelTriggerNotification × n, createTriggerNotification × n). This probe
 * runs the REAL adapter against the repo's stateful notifee mock with one
 * macrotask of latency per native call and interleaves the two production
 * writers that can overlap in the app:
 *   - the foreground re-sync (`useNotificationBootstrap` → syncNow) that is
 *     already mid-applyPlan, and
 *   - the user switching "All reminders" OFF in Settings (setPrefs → syncNow
 *     → cancelAllPlanned).
 * Invariant under test (I15/I19): once the user has turned reminders off,
 * nothing remains scheduled after every in-flight sync has settled.
 *
 * Run: cd apps/mobile && npx jest __tests__/audit-structural2/notificationScheduler-concurrency.test.ts
 */
import notifee from 'react-native-notify-kit';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import { getScheduler } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
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

import { useNotificationStore } from '../../src/notifications/notificationStore';

const mocked = notifee as unknown as {
  requestPermission: jest.Mock;
  getNotificationSettings: jest.Mock;
  createTriggerNotification: jest.Mock;
  getTriggerNotificationIds: jest.Mock;
  cancelTriggerNotification: jest.Mock;
};

/** Live trigger table with one macrotask of latency per native call. */
const scheduled = new Map<string, unknown>();
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 3,
  practicedToday: false,
  hasAnyHistory: true,
};

beforeEach(() => {
  scheduled.clear();
  mockKvTable.clear();
  mocked.getNotificationSettings.mockImplementation(async () => {
    await tick();
    return { authorizationStatus: 1 };
  });
  mocked.requestPermission.mockImplementation(async () => {
    await tick();
    return { authorizationStatus: 1 };
  });
  mocked.getTriggerNotificationIds.mockImplementation(async () => {
    await tick();
    return [...scheduled.keys()];
  });
  mocked.cancelTriggerNotification.mockImplementation(async (id: string) => {
    await tick();
    scheduled.delete(id);
  });
  mocked.createTriggerNotification.mockImplementation(
    async (notification: { id: string }, trigger: unknown) => {
      await tick();
      scheduled.set(notification.id, trigger);
      return notification.id;
    },
  );
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(GUEST_DATA_OWNER);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mocked.getNotificationSettings.mockReset();
  mocked.requestPermission.mockReset();
  mocked.getTriggerNotificationIds.mockReset();
  mocked.cancelTriggerNotification.mockReset();
  mocked.createTriggerNotification.mockReset();
});

describe('AUDIT: real adapter — foreground re-sync overlapping a Settings "All reminders" OFF', () => {
  it('leaves nothing scheduled once both operations have settled', async () => {
    const scheduler = getScheduler();
    const deps = { scheduler, loadContext: async () => planContext };
    const store = useNotificationStore.getState();

    await store.hydrate(deps);
    await store.setPrefs({ enabled: true, promptDismissed: true }, deps);
    expect(useNotificationStore.getState().permission).toBe('granted');
    const armed = [...scheduled.keys()];
    expect(armed.length).toBeGreaterThan(1);
    expect(armed.every(id => id.startsWith(NOTIFICATION_ID_PREFIX))).toBe(true);

    // Foreground: bootstrap re-syncs (still enabled) …
    const foregroundSync = useNotificationStore.getState().syncNow(deps);
    // … and a few native calls later the user flips the master switch off.
    await tick();
    await tick();
    const userOff = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps);

    await Promise.all([foregroundSync, userOff]);
    // Let any stragglers from either side land.
    for (let i = 0; i < 20; i += 1) await tick();

    const remaining = [...scheduled.keys()];
    console.log(
      JSON.stringify({
        probe: 'notificationScheduler-concurrency/off-during-resync',
        prefsEnabled: useNotificationStore.getState().prefs.enabled,
        scheduleFailed: useNotificationStore.getState().scheduleFailed,
        remaining,
      }),
    );
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(remaining).toEqual([]);
  });

  it('rapid ON → OFF on "All reminders" (I26 double tap) ends with nothing scheduled', async () => {
    const scheduler = getScheduler();
    const deps = { scheduler, loadContext: async () => planContext };
    await useNotificationStore.getState().hydrate(deps);
    expect(scheduled.size).toBe(0);

    const on = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps);
    // Persist (KV write) + getTriggerNotificationIds resolve before the user's
    // second tap lands.
    await tick();
    await tick();
    const off = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps);
    await Promise.all([on, off]);
    for (let i = 0; i < 20; i += 1) await tick();

    const remaining = [...scheduled.keys()];
    console.log(
      JSON.stringify({
        probe: 'notificationScheduler-concurrency/on-off-double-tap',
        prefsEnabled: useNotificationStore.getState().prefs.enabled,
        remaining,
      }),
    );
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(remaining).toEqual([]);
  });

  it('two overlapping enabled syncs never leave a duplicate or a stale id behind', async () => {
    const scheduler = getScheduler();
    const deps = { scheduler, loadContext: async () => planContext };
    const store = useNotificationStore.getState();
    await store.hydrate(deps);
    await store.setPrefs({ enabled: true, promptDismissed: true }, deps);
    const expected = [...scheduled.keys()].sort();

    const a = useNotificationStore.getState().syncNow(deps);
    await tick();
    const b = useNotificationStore.getState().syncNow(deps);
    await Promise.all([a, b]);
    for (let i = 0; i < 20; i += 1) await tick();

    const remaining = [...scheduled.keys()].sort();
    console.log(
      JSON.stringify({
        probe: 'notificationScheduler-concurrency/double-sync',
        expected,
        remaining,
      }),
    );
    expect(remaining).toEqual(expected);
  });
});
