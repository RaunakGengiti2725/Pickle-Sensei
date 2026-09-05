/**
 * MSA-P1-2 pin (mobile-settings-account): one test per acceptance criterion.
 *
 *  AC1  After setActiveDataOwner(B) and before B's hydrate commits, the store
 *       reports hydrated=false (or ownerKey=B with default prefs) — never
 *       hydrated=true with ownerKey=A.
 *  AC2  A setPrefs landing during B's in-flight hydrate never writes A's
 *       enabled / practiceReminderMinutes into notificationPrefsKeyForOwner(B).
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect present.
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
let mockSelectGate: Promise<void> | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockSelectGate) await mockSelectGate;
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

class RecordingScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: Array<{ kind: 'apply' | 'cancelAll' }> = [];
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(_plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'apply' });
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

async function hydrateAThenStartSlowHydrateB(scheduler: RecordingScheduler) {
  setActiveDataOwner(ownerA);
  seedPrefs(ownerA, {
    enabled: true,
    promptDismissed: true,
    practiceReminderMinutes: 19 * 60,
  });
  await useNotificationStore
    .getState()
    .hydrate({ scheduler, loadContext: async () => context });
  expect(useNotificationStore.getState()).toEqual(
    expect.objectContaining({ hydrated: true, ownerKey: ownerA }),
  );

  setActiveDataOwner(ownerB);
  let releaseSelect!: () => void;
  mockSelectGate = new Promise<void>(r => (releaseSelect = r));
  const hydrateB = useNotificationStore
    .getState()
    .hydrate({ scheduler, loadContext: async () => context });
  await flush();
  return {
    hydrateB,
    release: () => {
      releaseSelect();
      mockSelectGate = null;
    },
  };
}

beforeEach(() => {
  mockKvTable.clear();
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

describe('MSA-P1-2 acceptance', () => {
  it('AC1: mid-switch the store never reports hydrated=true with ownerKey=A', async () => {
    const scheduler = new RecordingScheduler();
    const { hydrateB, release } =
      await hydrateAThenStartSlowHydrateB(scheduler);

    const mid = useNotificationStore.getState();
    const acceptable =
      mid.hydrated === false ||
      (mid.ownerKey === ownerB &&
        mid.prefs.enabled === DEFAULT_NOTIFICATION_PREFS.enabled &&
        mid.prefs.practiceReminderMinutes ===
          DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes);

    release();
    await hydrateB;

    expect({
      hydrated: mid.hydrated,
      ownerKey: mid.ownerKey,
      enabled: mid.prefs.enabled,
    }).not.toEqual({ hydrated: true, ownerKey: ownerA, enabled: true });
    expect(acceptable).toBe(true);
  });

  it("AC2: a setPrefs during B's in-flight hydrate never writes A's enabled / reminder time under B's key", async () => {
    const scheduler = new RecordingScheduler();
    const { hydrateB, release } =
      await hydrateAThenStartSlowHydrateB(scheduler);

    await useNotificationStore
      .getState()
      .setPrefs(
        { weeklyRecap: false },
        { scheduler, loadContext: async () => context },
      );
    release();
    await hydrateB;

    const rowB = durablePrefs(ownerB);
    if (rowB !== null) {
      expect(rowB.enabled).toBe(DEFAULT_NOTIFICATION_PREFS.enabled);
      expect(rowB.practiceReminderMinutes).toBe(
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      );
    }
    // A's durable row is untouched by B's write.
    expect(durablePrefs(ownerA)).toEqual(
      expect.objectContaining({
        enabled: true,
        practiceReminderMinutes: 19 * 60,
      }),
    );
  });
});
