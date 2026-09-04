import type { NotificationPlanContext } from '../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../src/notifications/service';
import type { PlannedNotification } from '../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Store behavior around the SchedulerPort seam: hydration, permission
 * gating, sign-out cancellation, and durable prefs. The fake scheduler
 * records every applied plan; the fake context injects practice facts.
 */

const mockKvTable = new Map<string, string>();
/** Number of upcoming kv SELECTs that throw (a locked/unavailable db). */
let mockKvReadFailures = 0;
/** When set, every kv SELECT waits on it before answering. */
let mockKvReadGate: Promise<void> | null = null;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvReadGate) await mockKvReadGate;
        if (mockKvReadFailures > 0) {
          mockKvReadFailures -= 1;
          throw new Error('database is locked');
        }
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

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../src/notifications/notificationStore';

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  requestResult: PermissionState = 'granted';

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
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

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    hydrateFailed: false,
    pendingWrite: null,
  });
}

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';

function storedPrefs(forOwner: string) {
  return JSON.parse(
    mockKvTable.get(notificationPrefsKeyForOwner(forOwner))!,
  ) as Record<string, unknown>;
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvReadFailures = 0;
  mockKvReadGate = null;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('notification store', () => {
  it('cancels everything for a signed-out process', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.cancelAllCalls).toBeGreaterThan(0);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });

  it('hydrates defaults, then schedules only after permission + opt-in', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    // Default state is OFF: hydration must not schedule anything.
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.appliedPlans).toEqual([]);

    const granted = await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(granted).toBe(true);
    const state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(true);
    expect(state.prefs.promptDismissed).toBe(true);
    expect(state.permission).toBe('granted');
    const lastPlan = scheduler.appliedPlans.at(-1)!;
    expect(lastPlan.map(item => item.id)).toContain('ps.reminder.practice');
    expect(lastPlan.map(item => item.id)).toContain('ps.reminder.streak');
  });

  it('does not enable when the system prompt is denied', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.requestResult = 'denied';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const granted = await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(granted).toBe(false);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('persists prefs to the owner-scoped kv and re-syncs on change', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 8 * 60 }, deps(scheduler));
    const stored = mockKvTable.get(notificationPrefsKeyForOwner(owner));
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).practiceReminderMinutes).toBe(8 * 60);
    const lastPlan = scheduler.appliedPlans.at(-1)!;
    const practice = lastPlan.find(item => item.id === 'ps.reminder.practice')!;
    expect(new Date(practice.timestampMs).getHours()).toBe(8);
  });

  it('survives corrupt stored prefs by falling back to defaults', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(notificationPrefsKeyForOwner(owner), '{broken json');
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it('cancels instead of scheduling when permission was revoked', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
    );
    const scheduler = new FakeScheduler();
    scheduler.permission = 'denied';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(scheduler.appliedPlans).toEqual([]);
    expect(scheduler.cancelAllCalls).toBeGreaterThan(0);
  });

  it('turning the master off cancels the schedule', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(scheduler.appliedPlans.length).toBeGreaterThan(0);
    const cancelsBefore = scheduler.cancelAllCalls;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    expect(scheduler.cancelAllCalls).toBeGreaterThan(cancelsBefore);
  });

  it('holds a granted pre-auth onboarding choice until a writable owner hydrates', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore
      .getState()
      .completeOnboardingStep('enable', deps(scheduler));

    expect(scheduler.requestCalls).toBe(1);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(
      JSON.parse(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: true });

    setActiveDataOwner(owner);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs).toMatchObject({
      enabled: true,
      promptDismissed: true,
    });
    expect(scheduler.appliedPlans.length).toBeGreaterThan(0);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });

  it('keeps reminders off when the onboarding permission request is denied', async () => {
    const scheduler = new FakeScheduler();
    scheduler.requestResult = 'denied';
    await useNotificationStore
      .getState()
      .completeOnboardingStep('enable', deps(scheduler));

    expect(scheduler.requestCalls).toBe(1);
    expect(
      JSON.parse(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: false });
  });

  it('records Not now during pre-auth onboarding without requesting permission', async () => {
    const scheduler = new FakeScheduler();
    await useNotificationStore
      .getState()
      .completeOnboardingStep('not_now', deps(scheduler));

    expect(scheduler.requestCalls).toBe(0);
    expect(
      JSON.parse(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: false });
  });

  it('keeps existing owner preferences over a pre-auth choice', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: false,
        promptDismissed: true,
      }),
    );
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    setActiveDataOwner(owner);

    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });

  it('does not apply one owner’s plan after the active owner changes', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';

    await useNotificationStore.getState().hydrate({
      scheduler,
      loadContext: async () => {
        setActiveDataOwner(otherOwner);
        return planContext;
      },
    });

    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('dismissPrompt is durable and one-way', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore.getState().dismissPrompt(deps(scheduler));
    expect(useNotificationStore.getState().prefs.promptDismissed).toBe(true);
    const stored = mockKvTable.get(notificationPrefsKeyForOwner(owner));
    expect(JSON.parse(stored!).promptDismissed).toBe(true);
  });

  it('re-reads prefs after an await so a concurrent opt-out wins over the captured plan', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const appliedBefore = scheduler.appliedPlans.length;
    const cancelsBefore = scheduler.cancelAllCalls;

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const sync = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: async () => {
        await gate;
        return planContext;
      },
    });
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    release();
    await sync;

    expect(scheduler.appliedPlans.length).toBe(appliedBefore);
    expect(scheduler.cancelAllCalls).toBeGreaterThan(cancelsBefore);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });

  it('resets to the new owner’s defaults the moment its hydrate starts', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminderMinutes: 19 * 60,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    setActiveDataOwner(otherOwner);
    const hydrating = useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: false,
      ownerKey: otherOwner,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    });
    // A write for the new owner during its hydrate merges onto ITS row.
    await useNotificationStore
      .getState()
      .setPrefs({ promptDismissed: true }, deps(scheduler));
    await hydrating;

    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: true,
      ownerKey: otherOwner,
      prefs: {
        enabled: false,
        practiceReminderMinutes:
          DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
        promptDismissed: true,
      },
    });
    expect(storedPrefs(otherOwner)).toMatchObject({
      enabled: false,
      practiceReminderMinutes:
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      promptDismissed: true,
    });
    expect(storedPrefs(owner)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: 19 * 60,
    });
  });

  it('a failed prefs read leaves the store un-hydrated, keeps reminders, and retries on the next sync', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminderMinutes: 19 * 60,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    mockKvReadFailures = 1;

    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: false,
      hydrateFailed: true,
      ownerKey: owner,
    });
    expect(scheduler.cancelAllCalls).toBe(0);
    expect(scheduler.appliedPlans).toEqual([]);

    // Tapping "Not now" on a card that should not be showing must not write
    // defaults over the saved opt-in.
    await useNotificationStore.getState().dismissPrompt(deps(scheduler));
    expect(storedPrefs(owner)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: 19 * 60,
      promptDismissed: true,
    });

    // The next foreground sync retries the read and schedules the saved prefs.
    const state = useNotificationStore.getState();
    if (!state.hydrated) await state.syncNow(deps(scheduler));
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: true,
      hydrateFailed: false,
      prefs: { enabled: true, practiceReminderMinutes: 19 * 60 },
    });
    const lastPlan = scheduler.appliedPlans.at(-1)!;
    const practice = lastPlan.find(item => item.id === 'ps.reminder.practice')!;
    expect(new Date(practice.timestampMs).getHours()).toBe(19);
  });

  it('a write made before the row could be read is merged onto the row once it is', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminderMinutes: 19 * 60,
        promptDismissed: false,
      }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    mockKvReadFailures = 1;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().hydrated).toBe(false);

    // The read fails once more, so the choice stays pending in memory…
    mockKvReadFailures = 1;
    await useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler));
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: false,
      persistFailed: true,
      prefs: { streakDefense: false },
    });
    expect(storedPrefs(owner)).toMatchObject({ streakDefense: true });

    // …and lands on top of the durable row on the next successful read.
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(useNotificationStore.getState()).toMatchObject({
      hydrated: true,
      persistFailed: false,
      prefs: {
        enabled: true,
        practiceReminderMinutes: 19 * 60,
        streakDefense: false,
      },
    });
    expect(storedPrefs(owner)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: 19 * 60,
      streakDefense: false,
    });
  });

  it('a write that lands while the owner’s row is re-read is not undone by the stale row', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);

    let release!: () => void;
    mockKvReadGate = new Promise<void>(resolve => (release = resolve));
    const rehydrate = useNotificationStore.getState().hydrate(deps(scheduler));
    mockKvReadGate = null;
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    expect(storedPrefs(owner)).toMatchObject({ enabled: true });
    release();
    await rehydrate;

    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(storedPrefs(owner)).toMatchObject({ enabled: true });
  });
});
