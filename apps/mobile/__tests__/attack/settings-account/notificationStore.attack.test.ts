import type { NotificationPlanContext } from '../../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * Adversarial pass (mobile-settings-account, pass 3): notificationStore
 * against a corrupted / hostile KV table and owner switches mid-hydrate.
 */

const mockKvTable = new Map<string, string>();
const kvReads: string[] = [];
const kvWrites: Array<[string, string]> = [];

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        kvReads.push(String(params[0]));
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        kvWrites.push([String(params[0]), String(params[1])]);
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
} from '../../../src/notifications/notificationStore';

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  requestResult: PermissionState = 'granted';
  onPermissionState: (() => void) | null = null;

  async permissionState(): Promise<PermissionState> {
    this.onPermissionState?.();
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
  });
}

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  mockKvTable.clear();
  kvReads.length = 0;
  kvWrites.length = 0;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('S3: corrupt pending onboarding stash', () => {
  it('{version:2,enabled:true} is ignored — prefs stay default OFF, nothing scheduled', async () => {
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 2, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const state = useNotificationStore.getState();
    expect(state.prefs.enabled).toBe(false);
    expect(state.prefs.promptDismissed).toBe(false);
    expect(scheduler.appliedPlans.flat()).toEqual([]);
    expect(mockKvTable.has(notificationPrefsKeyForOwner(owner))).toBe(false);
  });

  it('CHARACTERIZATION: the v2 stash is NOT cleared and is re-read on every hydrate (expected: cleared once)', async () => {
    // parsePendingOnboardingChoice() returns null for anything but v1, and
    // the clearing write lives inside `if (pending)`, so a stash the app
    // cannot understand survives forever. Pinned as the current behaviour;
    // flip the expectations when the store is fixed.
    const corrupt = JSON.stringify({ version: 2, enabled: true });
    mockKvTable.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, corrupt);
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    for (let i = 0; i < 3; i += 1) {
      resetStore();
      await useNotificationStore.getState().hydrate(deps(scheduler));
    }
    const pendingReads = kvReads.filter(
      key => key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
    ).length;
    const pendingWrites = kvWrites.filter(
      ([key]) => key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
    );
    // FINDING (P3): observed 3 reads / 0 clearing writes; expected the
    // first hydrate to write '' so later hydrates see an empty stash.
    expect(pendingReads).toBe(3);
    expect(pendingWrites).toEqual([]);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe(
      corrupt,
    );
  });

  it.each([
    ['version as string', JSON.stringify({ version: '1', enabled: true })],
    ['enabled as string', JSON.stringify({ version: 1, enabled: 'true' })],
    ['enabled as 1', JSON.stringify({ version: 1, enabled: 1 })],
    ['array payload', JSON.stringify([{ version: 1, enabled: true }])],
    ['bare true', 'true'],
    ['not JSON', '{version:1,enabled:true'],
    ['huge junk', 'x'.repeat(1_000_000)],
    ['unicode junk', '{"version":1,"enabled":"\u202Etrue"}'],
    [
      'prototype pollution',
      '{"__proto__":{"version":1,"enabled":true},"version":2}',
    ],
  ])('%s never enables reminders', async (_label, raw) => {
    mockKvTable.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, raw);
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.appliedPlans.flat()).toEqual([]);
  });

  it('a valid v1 stash is adopted exactly once and then cleared', async () => {
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
    // Second owner hydrating afterwards must not inherit the choice.
    resetStore();
    setActiveDataOwner(otherOwner);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });

  it('a v1 stash never overrides prefs an owner already saved (and is still cleared)', async () => {
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
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });
});

describe('corrupt persisted prefs', () => {
  it.each([
    ['not JSON', '{enabled:true'],
    ['array', '[true]'],
    ['null', 'null'],
    ['string true', '"true"'],
    ['enabled as string', JSON.stringify({ enabled: 'yes' })],
    ['minutes out of range', JSON.stringify({ practiceReminderMinutes: 1440 })],
    ['minutes negative', JSON.stringify({ practiceReminderMinutes: -1 })],
    ['minutes NaN-ish', JSON.stringify({ practiceReminderMinutes: 'NaN' })],
    ['huge blob', JSON.stringify({ enabled: 'x'.repeat(500_000) })],
  ])('%s hydrates to defaults (OFF) without throwing', async (_label, raw) => {
    mockKvTable.set(notificationPrefsKeyForOwner(owner), raw);
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const { prefs, hydrated } = useNotificationStore.getState();
    expect(hydrated).toBe(true);
    expect(prefs.enabled).toBe(false);
    expect(prefs.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    expect(scheduler.appliedPlans.flat()).toEqual([]);
  });

  it('enabled prefs + fractional minutes → minutes reset to default, plan still applied', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ enabled: true, practiceReminderMinutes: 17.5 }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const { prefs } = useNotificationStore.getState();
    expect(prefs.enabled).toBe(true);
    expect(prefs.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    expect(scheduler.appliedPlans.length).toBeGreaterThan(0);
  });
});

describe('owner switches and permission denial mid-hydrate', () => {
  it('owner switch between prefs read and permission read → nothing is scheduled for the old owner', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.onPermissionState = () => setActiveDataOwner(otherOwner);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.appliedPlans).toEqual([]);
    // The store must not still claim to be hydrated for the old owner with
    // a scheduled plan; ownerKey may be the old owner but no plan landed.
    expect(scheduler.cancelAllCalls).toBe(0);
  });

  it('sign-out during hydrate → no plan for the signed-out process', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.onPermissionState = () =>
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('permission revoked (denied) with enabled prefs → everything cancelled, prefs untouched', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'denied';
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(scheduler.cancelAllCalls).toBeGreaterThan(0);
  });

  it('permissionState() throwing → permission unknown, no plan, no crash', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
    );
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    scheduler.permissionState = async () => {
      throw new Error('native bridge down');
    };
    await expect(
      useNotificationStore.getState().hydrate(deps(scheduler)),
    ).resolves.toBeUndefined();
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(scheduler.appliedPlans).toEqual([]);
  });

  it('rapid setPrefs storm: last write wins in KV and every write is v1', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const store = useNotificationStore.getState();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.setPrefs({ enabled: i % 2 === 0, practiceReminderMinutes: i }),
      ),
    );
    const persisted = JSON.parse(
      mockKvTable.get(notificationPrefsKeyForOwner(owner))!,
    ) as { version: number; enabled: boolean; practiceReminderMinutes: number };
    expect(persisted.version).toBe(1);
    expect(persisted.practiceReminderMinutes).toBe(24);
    expect(persisted.enabled).toBe(true);
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      24,
    );
    for (const [, value] of kvWrites) {
      expect((JSON.parse(value) as { version: number }).version).toBe(1);
    }
  });

  it('completeOnboardingStep while signed out writes ONLY the v1 stash, never owner prefs', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const scheduler = new FakeScheduler();
    await useNotificationStore
      .getState()
      .completeOnboardingStep('enable', deps(scheduler));
    expect(kvWrites).toEqual([
      [
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
        JSON.stringify({ version: 1, enabled: true }),
      ],
    ]);
    expect(scheduler.appliedPlans).toEqual([]);
  });
});
