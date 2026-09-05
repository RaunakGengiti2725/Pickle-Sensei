/**
 * Adjudication reproduction (mobile-settings-account, base 4d812e1a).
 *
 * notificationStore candidates:
 *  N1  syncNow() captures prefs BEFORE `await loadContext()` and only re-checks
 *      the owner afterwards, so a foreground re-sync in flight applies a plan
 *      built from prefs the user has since changed (including "all off").
 *  N2  Owner switch: `hydrated`/`ownerKey`/`prefs` are not reset when the
 *      active owner changes; a setPrefs for the new owner before its hydrate
 *      commits persists the PREVIOUS owner's prefs under the new owner's key.
 *  N3  A failing kv SELECT during hydrate marks the store hydrated with
 *      DEFAULTS; the next write (e.g. dismissPrompt) overwrites the durable row.
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect reproduced.
 */
import type { NotificationPlanContext } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockSelectFailuresLeft = 0;
let mockSelectGate: Promise<void> | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockSelectGate) await mockSelectGate;
        if (mockSelectFailuresLeft > 0) {
          mockSelectFailuresLeft -= 1;
          throw new Error('SQLITE_IOERR: disk I/O error');
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

import { useNotificationStore } from '../../src/notifications/notificationStore';

type SchedulerOp =
  { kind: 'apply'; plan: PlannedNotification[] } | { kind: 'cancelAll' };

class RecordingScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: SchedulerOp[] = [];
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'apply', plan: [...plan] });
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push({ kind: 'cancelAll' });
  }
  async openSystemSettings(): Promise<void> {}
}

const context: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 0,
  practicedToday: false,
  hasAnyHistory: true,
};

const ownerA = '33333333-3333-4333-8333-333333333333';
const ownerB = '44444444-4444-4444-8444-444444444444';

function seedPrefs(owner: string, patch: Partial<NotificationPrefs>) {
  const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, ...patch };
  mockKvTable.set(notificationPrefsKeyForOwner(owner), JSON.stringify(prefs));
  return prefs;
}

function durablePrefs(owner: string): NotificationPrefs | null {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined ? null : (JSON.parse(raw) as NotificationPrefs);
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  mockKvTable.clear();
  mockSelectFailuresLeft = 0;
  mockSelectGate = null;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('N1 — syncNow applies a plan built from stale prefs', () => {
  it('foreground syncNow in flight + user turns ALL reminders off → nothing may remain scheduled', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, { enabled: true, promptDismissed: true });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    scheduler.ops = [];

    // Foreground re-sync whose context load is slow (SQLite read).
    let releaseContext!: () => void;
    const gate = new Promise<void>(r => (releaseContext = r));
    const foregroundSync = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: async () => {
        await gate;
        return context;
      },
    });
    await flush();

    // Meanwhile the user flips "All reminders" OFF in Settings.
    await useNotificationStore
      .getState()
      .setPrefs(
        { enabled: false },
        { scheduler, loadContext: async () => context },
      );
    expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });

    releaseContext();
    await foregroundSync;

    // EXPECTED: the last scheduler operation still reflects "off".
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });
  });

  it('foreground syncNow in flight + user moves the reminder time → the applied plan uses the NEW time', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 19 * 60,
    });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    scheduler.ops = [];

    let releaseContext!: () => void;
    const gate = new Promise<void>(r => (releaseContext = r));
    const foregroundSync = useNotificationStore.getState().syncNow({
      scheduler,
      loadContext: async () => {
        await gate;
        return context;
      },
    });
    await flush();

    await useNotificationStore
      .getState()
      .setPrefs(
        { practiceReminderMinutes: 20 * 60 },
        { scheduler, loadContext: async () => context },
      );
    releaseContext();
    await foregroundSync;

    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('apply');
    const practice = (last as { plan: PlannedNotification[] }).plan.find(
      n => n.id === 'ps.reminder.practice',
    );
    expect(practice).toBeDefined();
    expect(new Date(practice!.timestampMs).getHours()).toBe(20);
  });
});

describe('N2 — owner switch without a store reset', () => {
  it('setPrefs for the new owner before its hydrate commits must not persist the previous owner’s prefs', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 19 * 60,
    });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    // Account switch → owner B (no durable prefs yet). B's hydrate starts but
    // its kv read is slow.
    setActiveDataOwner(ownerB);
    let releaseSelect!: () => void;
    mockSelectGate = new Promise<void>(r => (releaseSelect = r));
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    await flush();

    // (Observed but asserted separately below: the store still reports
    // hydrated=true with ownerKey=A and A's prefs while B's hydrate is in flight.)
    const midSwitch = useNotificationStore.getState();
    const staleHydratedForA =
      midSwitch.hydrated && midSwitch.ownerKey === ownerA;

    // A write for B lands while B's hydrate is in flight.
    await useNotificationStore
      .getState()
      .setPrefs(
        { weeklyRecap: false },
        { scheduler, loadContext: async () => context },
      );
    releaseSelect();
    mockSelectGate = null;
    await hydrateB;

    // EXPECTED: B's durable row does not inherit A's opt-in / reminder time.
    const rowB = durablePrefs(ownerB);
    expect(rowB).not.toBeNull();
    expect(rowB!.enabled).toBe(false);
    expect(rowB!.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    expect(staleHydratedForA).toBe(false);
  });

  it('after the active owner changes, hydrated must not stay true for the previous owner', async () => {
    setActiveDataOwner(ownerA);
    seedPrefs(ownerA, { enabled: true, promptDismissed: true });
    const scheduler = new RecordingScheduler();
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });

    setActiveDataOwner(ownerB);
    let releaseSelect!: () => void;
    mockSelectGate = new Promise<void>(r => (releaseSelect = r));
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });
    await flush();
    const midSwitch = useNotificationStore.getState();
    releaseSelect();
    await hydrateB;
    expect({
      hydrated: midSwitch.hydrated,
      ownerKey: midSwitch.ownerKey,
      enabled: midSwitch.prefs.enabled,
    }).not.toEqual({ hydrated: true, ownerKey: ownerA, enabled: true });
  });
});

describe('N3 — failed kv read during hydrate', () => {
  it('a failing SELECT must not mark the store hydrated with defaults, and the next write must not destroy the durable row', async () => {
    setActiveDataOwner(ownerA);
    const saved = seedPrefs(ownerA, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 19 * 60,
    });
    const scheduler = new RecordingScheduler();
    mockSelectFailuresLeft = 1;
    await useNotificationStore
      .getState()
      .hydrate({ scheduler, loadContext: async () => context });

    const state = useNotificationStore.getState();
    // Observed (asserted at the end): hydrated=true with DEFAULT prefs, which
    // re-shows the priming card and disarms every reminder for an opted-in
    // player.
    const hydratedWithDefaults = state.hydrated && !state.prefs.enabled;

    // Home priming card would now be visible; the player taps "Not now".
    await useNotificationStore
      .getState()
      .dismissPrompt({ scheduler, loadContext: async () => context });

    expect(durablePrefs(ownerA)).toEqual(
      expect.objectContaining({
        enabled: saved.enabled,
        practiceReminderMinutes: saved.practiceReminderMinutes,
      }),
    );
    expect(hydratedWithDefaults).toBe(false);
  });
});
