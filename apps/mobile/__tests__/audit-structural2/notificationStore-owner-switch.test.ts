/**
 * AUDIT PROBE (structural #2, mobile-settings-account).
 *
 * I17 says prefs are owner-scoped and never leak across owners. The only
 * leak-proof path tested so far is a sequential switch through a signed-out
 * hydrate. A DIRECT owner switch (guest → connected account, or the
 * `installApiSession` path) changes `getActiveDataOwner()` first and hydrates
 * the new owner asynchronously. Between those two points `setPrefs` merges
 * the PREVIOUS owner's in-memory prefs and persists them under the NEW
 * owner's key; `hydrated` is never reset, so the priming card and the
 * Settings row render the previous owner's state for the new owner.
 */
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
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockReadGate: Promise<void> | null = null;
let mockReadFailures = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockReadFailures > 0) {
          mockReadFailures -= 1;
          throw new Error('sqlite read failed');
        }
        if (mockReadGate) await mockReadGate;
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
} from '../../src/notifications/notificationStore';

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
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
  });
}

const ownerB = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  mockKvTable.clear();
  mockReadGate = null;
  mockReadFailures = 0;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});
afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('AUDIT: direct owner switch (guest → connected account)', () => {
  it('setPrefs before the new owner hydrates must not persist the previous owner’s prefs under the new key', async () => {
    const scheduler = new FakeScheduler();
    // Guest opted in with a custom time.
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore.getState().setPrefs(
      {
        enabled: true,
        promptDismissed: true,
        practiceReminderMinutes: 6 * 60,
      },
      deps(scheduler),
    );
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    // Connect account: the owner flips synchronously; hydrate for B has not
    // run yet (it is an effect on the next render).
    setActiveDataOwner(ownerB);
    // Any write in that window — e.g. the priming card's "Not now" — merges
    // the guest's in-memory prefs.
    await useNotificationStore
      .getState()
      .setPrefs({ promptDismissed: true }, deps(scheduler));

    const storedForB = mockKvTable.get(notificationPrefsKeyForOwner(ownerB));
    console.log(
      JSON.stringify({
        probe: 'notificationStore-owner-switch/setPrefs-leak',
        storedForB,
        hydratedFlagAfterSwitch: useNotificationStore.getState().hydrated,
        ownerKey: useNotificationStore.getState().ownerKey,
      }),
    );
    expect(storedForB).toBeDefined();
    const parsed = JSON.parse(storedForB!) as typeof DEFAULT_NOTIFICATION_PREFS;
    // Owner B never opted in; B's durable copy must not say enabled / 6:00.
    expect(parsed.enabled).toBe(false);
    expect(parsed.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
  });

  it('hydrate in flight for the new owner: a concurrent setPrefs must not be lost nor leak', async () => {
    const scheduler = new FakeScheduler();
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));

    // B has an existing durable copy: reminders off, prompt dismissed.
    mockKvTable.set(
      notificationPrefsKeyForOwner(ownerB),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: false,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(ownerB);
    let releaseRead!: () => void;
    mockReadGate = new Promise<void>(resolve => (releaseRead = resolve));
    const hydrating = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    // While B's KV read is pending the user flips the weekly recap.
    mockReadGate = null;
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    releaseRead();
    await hydrating;

    const inMemory = useNotificationStore.getState().prefs;
    const storedForB = JSON.parse(
      mockKvTable.get(notificationPrefsKeyForOwner(ownerB))!,
    ) as typeof DEFAULT_NOTIFICATION_PREFS;
    console.log(
      JSON.stringify({
        probe: 'notificationStore-owner-switch/hydrate-race',
        inMemory,
        storedForB,
      }),
    );
    // The guest's enabled:true must not have been written under B…
    expect(storedForB.enabled).toBe(false);
    // …and the user's own tap (weeklyRecap off) must survive B's hydrate.
    expect(inMemory.weeklyRecap).toBe(false);
    expect(storedForB.weeklyRecap).toBe(false);
  });

  it('hydrated must not report true for the new owner before its hydrate commits', async () => {
    const scheduler = new FakeScheduler();
    setActiveDataOwner(GUEST_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().hydrated).toBe(true);
    setActiveDataOwner(ownerB);
    // Nothing has hydrated B yet; consumers that key "hidden until hydrated"
    // off this flag would now render the guest's prefs for B.
    const state = useNotificationStore.getState();
    console.log(
      JSON.stringify({
        probe: 'notificationStore-owner-switch/hydrated-flag',
        hydrated: state.hydrated,
        ownerKey: state.ownerKey,
        activeOwner: ownerB,
      }),
    );
    expect(state.hydrated && state.ownerKey === ownerB).toBe(false);
    expect(state.hydrated).toBe(false);
  });
});

describe('AUDIT: KV read failure during hydrate (verified-good candidates)', () => {
  it('still commits hydrated:true with defaults and keeps the pending onboarding stash for the next hydrate', async () => {
    const scheduler = new FakeScheduler();
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    setActiveDataOwner(ownerB);
    mockReadFailures = 1;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    // Stash untouched → next hydrate adopts it.
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe(
      JSON.stringify({ version: 1, enabled: true }),
    );
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });

  it('same-owner re-sign-in with enabled:true persisted re-arms without a new prompt (durable opt-in, by design)', async () => {
    const scheduler = new FakeScheduler();
    mockKvTable.set(
      notificationPrefsKeyForOwner(ownerB),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(ownerB);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    const plansBefore = scheduler.appliedPlans.length;
    setActiveDataOwner(ownerB);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.appliedPlans.length).toBeGreaterThan(plansBefore);
  });
});
