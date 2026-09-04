/**
 * Structural audit probe (mobile-settings-account, pass 1).
 *
 * Owner scoping of notification prefs across an account switch. The store
 * guards hydrate/syncNow against a changed owner, but `setPrefs` merges
 * whatever prefs are in memory (`{ ...get().prefs, ...patch }`) under the
 * CURRENT active owner, and `hydrated` is never reset when the owner
 * changes. The window is "active owner changed, new owner's hydrate not yet
 * complete" — i.e. one SQLite read after sign-in.
 */
import { useNotificationStore } from '../../src/notifications/notificationStore';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKv = new Map<string, string>();
let mockKvReadGate: Promise<void> | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvReadGate) await mockKvReadGate;
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM kv')) {
        mockKv.delete(String(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState() {
    return this.permission;
  }
  async requestPermission() {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]) {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned() {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings() {}
}

const ownerA = canonicalDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const ownerB = canonicalDataOwner('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

const context: NotificationPlanContext = {
  nowMs: Date.UTC(2026, 5, 10, 17, 0, 0),
  streakDays: 0,
  practicedToday: false,
  hasAnyHistory: false,
};

function deps(scheduler: FakeScheduler) {
  return { scheduler, loadContext: async () => context };
}

beforeEach(() => {
  mockKv.clear();
  mockKvReadGate = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
});

describe('audit: notification prefs across an account switch', () => {
  it('setPrefs for a freshly switched-to owner does not inherit the previous owner in-memory prefs', async () => {
    const scheduler = new FakeScheduler();
    // Owner A: reminders on, prompt dismissed, custom time.
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore.getState().setPrefs(
      {
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 6 * 60,
        promptDismissed: true,
      },
      deps(scheduler),
    );
    expect(mockKv.has(notificationPrefsKeyForOwner(ownerA))).toBe(true);

    // Account switch: B becomes the active owner; B's hydrate is still
    // pending (the read is gated), which is exactly the app's state during
    // the bootstrap hook's first hydrate after sign-in.
    let release!: () => void;
    mockKvReadGate = new Promise<void>(resolve => {
      release = resolve;
    });
    setActiveDataOwner(ownerB);
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    // A user action for B lands before the hydrate completes.
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));

    const storedForB = mockKv.get(notificationPrefsKeyForOwner(ownerB));
    expect(storedForB).toBeDefined();
    const parsed = JSON.parse(storedForB!) as Record<string, unknown>;
    // B never opted in: the durable copy must not say enabled / dismissed /
    // 06:00 — those are A's choices.
    expect(parsed).toMatchObject({
      enabled: false,
      promptDismissed: false,
      practiceReminderMinutes:
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      weeklyRecap: false,
    });

    release();
    await hydrateB;
  });

  it('after the active owner changes, the store does not report hydrated with the previous owner prefs', async () => {
    const scheduler = new FakeScheduler();
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, practiceReminder: true }, deps(scheduler));

    let release!: () => void;
    mockKvReadGate = new Promise<void>(resolve => {
      release = resolve;
    });
    setActiveDataOwner(ownerB);
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    const state = useNotificationStore.getState();
    // Either not yet hydrated, or hydrated for B with B's prefs — never
    // "hydrated" while still holding A's prefs under A's ownerKey.
    const consistent =
      state.hydrated === false ||
      (state.ownerKey === ownerB && state.prefs.enabled === false);
    expect({
      hydrated: state.hydrated,
      ownerKey: state.ownerKey,
      enabled: state.prefs.enabled,
      consistent,
    }).toEqual(expect.objectContaining({ consistent: true }));

    release();
    await hydrateB;
  });

  it('control: sequential switch with a completed hydrate keeps owners separate (I17 holds)', async () => {
    const scheduler = new FakeScheduler();
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, practiceReminder: true }, deps(scheduler));

    setActiveDataOwner(ownerB);
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    const parsed = JSON.parse(
      mockKv.get(notificationPrefsKeyForOwner(ownerB))!,
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({ enabled: false, weeklyRecap: false });
    expect(
      (
        JSON.parse(mockKv.get(notificationPrefsKeyForOwner(ownerA))!) as Record<
          string,
          unknown
        >
      ).enabled,
    ).toBe(true);
  });

  it('control: hydrate survives a throwing KV read (defaults, hydrated:true)', async () => {
    const scheduler = new FakeScheduler();
    setActiveDataOwner(ownerA);
    mockKvReadGate = Promise.reject(new Error('sqlite locked'));
    mockKvReadGate.catch(() => {});
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(ownerA);
    expect(state.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });
});
