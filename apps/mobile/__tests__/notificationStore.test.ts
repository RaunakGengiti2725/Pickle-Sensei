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

jest.mock('../src/data/db', () => ({
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function enabledScheduler() {
  setActiveDataOwner(owner);
  const scheduler = new FakeScheduler();
  scheduler.permission = 'granted';
  mockKvTable.set(
    notificationPrefsKeyForOwner(owner),
    JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
  );
  await useNotificationStore.getState().hydrate(deps(scheduler));
  scheduler.appliedPlans = [];
  scheduler.cancelAllCalls = 0;
  return scheduler;
}

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  mockKvTable.clear();
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  jest.restoreAllMocks();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('notification store', () => {
  it('lets the newest context win when reminder syncs finish out of order', async () => {
    const scheduler = await enabledScheduler();
    const context = deferred<NotificationPlanContext>();
    const first = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => context.promise,
    });
    await useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: async () => ({ ...planContext, practicedToday: true }),
    });
    context.resolve(planContext);
    await first;
    expect(scheduler.appliedPlans).toHaveLength(1);
    const streak = scheduler.appliedPlans[0]!.find(
      item => item.id === 'ps.reminder.streak',
    );
    expect(new Date(streak!.timestampMs).getDate()).toBe(26);
  });

  it('does not re-arm opted-out reminders when an old context finishes loading', async () => {
    const scheduler = await enabledScheduler();
    const context = deferred<NotificationPlanContext>();
    const first = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => context.promise,
    });
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    context.resolve(planContext);
    await first;
    expect(scheduler.appliedPlans).toEqual([]);
    expect(scheduler.cancelAllCalls).toBe(1);
  });

  it('ignores work explicitly requested for an owner who is no longer active', async () => {
    const scheduler = await enabledScheduler();
    setActiveDataOwner(otherOwner);
    await useNotificationStore
      .getState()
      .syncNow({ ...deps(scheduler), expectedOwnerKey: owner });
    expect(scheduler.appliedPlans).toEqual([]);
    expect(scheduler.cancelAllCalls).toBe(0);
  });

  it('rejects an old sign-in generation even when the same account is current again', async () => {
    const scheduler = await enabledScheduler();
    const context = deferred<NotificationPlanContext>();
    const first = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => context.promise,
    });
    setActiveDataOwner(otherOwner);
    setActiveDataOwner(owner);
    context.resolve(planContext);
    await first;
    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('honors caller teardown before applying a deferred context', async () => {
    const scheduler = await enabledScheduler();
    const context = deferred<NotificationPlanContext>();
    let active = true;
    const first = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => context.promise,
      isCurrent: () => active,
    });
    active = false;
    context.resolve(planContext);
    await first;
    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('serializes native cancellation after an already-started apply so sign-out wins', async () => {
    const scheduler = await enabledScheduler();
    const started = deferred<void>();
    const finish = deferred<void>();
    let scheduled: readonly PlannedNotification[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    jest.spyOn(scheduler, 'applyPlan').mockImplementation(async plan => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      started.resolve();
      await finish.promise;
      scheduled = plan;
      activeCalls -= 1;
    });
    jest.spyOn(scheduler, 'cancelAllPlanned').mockImplementation(async () => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      scheduled = [];
      activeCalls -= 1;
    });
    const first = useNotificationStore.getState().syncNow(deps(scheduler));
    await started.promise;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const signOut = useNotificationStore.getState().hydrate(deps(scheduler));
    finish.resolve();
    await Promise.all([first, signOut]);
    expect(maxActiveCalls).toBe(1);
    expect(scheduled).toEqual([]);
    expect(useNotificationStore.getState().ownerKey).toBe(
      SIGNED_OUT_DATA_OWNER,
    );
  });

  it('does not make sign-out wait for a pending history read before cancelling', async () => {
    const scheduler = await enabledScheduler();
    const context = deferred<NotificationPlanContext>();
    const first = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: () => context.promise,
    });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.cancelAllCalls).toBe(1);
    context.resolve(planContext);
    await first;
    expect(scheduler.appliedPlans).toEqual([]);
  });

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
});
