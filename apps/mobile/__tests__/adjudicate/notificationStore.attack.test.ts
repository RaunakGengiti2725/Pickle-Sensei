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
 * Adversarial variants of MSA-P1-2 / MSA-P2-2 against the epoch-committed
 * notification store (34f29ec4):
 *   1. a preference tap that lands AFTER a hydrate has taken its held patches
 *      but BEFORE that hydrate commits (i.e. during the hydrate's own durable
 *      write) is neither applied by that hydrate nor by anything after it —
 *      the committed state, the durable row and the OS plan all disagree with
 *      the player's last tap, and the orphaned patch silently re-applies on
 *      some later hydrate;
 *   2. an account switch whose new owner's durable read fails leaves the
 *      PREVIOUS account's plan armed on the OS — nothing ever cancels it while
 *      the read keeps failing.
 *
 * The kv mock can gate a SELECT or an INSERT (to keep a hydrate in flight at
 * a chosen await) and fail all SELECTs; the scheduler fake records every
 * OS-facing op in order.
 */

const mockKvTable = new Map<string, string>();
let mockKvReadFails = false;
let mockKvReadGate: { key: string; promise: Promise<void> } | null = null;
let mockKvWriteGate: { key: string; promise: Promise<void> } | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        if (mockKvReadGate && mockKvReadGate.key === key) {
          await mockKvReadGate.promise;
        }
        if (mockKvReadFails) throw new Error('SQLITE_IOERR');
        const value = mockKvTable.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        if (mockKvWriteGate && mockKvWriteGate.key === key) {
          await mockKvWriteGate.promise;
        }
        mockKvTable.set(key, String(params[1]));
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

type SchedulerOp =
  { kind: 'applyPlan'; plan: PlannedNotification[] } | { kind: 'cancelAll' };

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
    this.ops.push({ kind: 'applyPlan', plan: [...plan] });
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push({ kind: 'cancelAll' });
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

function deps(scheduler: RecordingScheduler) {
  return { scheduler, loadContext: async () => planContext };
}

function gate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { open, promise };
}

/** Lets every already-queued microtask (and the mocked db round trips) run. */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const ownerA = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ownerB = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SAVED_MINUTES = 19 * 60;

function seedOptedIn(owner: string) {
  mockKvTable.set(
    notificationPrefsKeyForOwner(owner),
    JSON.stringify({
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: SAVED_MINUTES,
    }),
  );
}

function storedPrefs(owner: string): Record<string, unknown> | undefined {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvReadFails = false;
  mockKvReadGate = null;
  mockKvWriteGate = null;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    readFailed: false,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('ATTACK MSA-P1-2 — a tap that lands while the hydrate is persisting its held patches', () => {
  /**
   * Owner B signs in; its hydrate is kept at the SELECT. Tap 1 (enable) is
   * held. The SELECT resolves, the hydrate takes tap 1 and starts its own
   * INSERT, which is kept open. Tap 2 (disable) lands during that INSERT.
   */
  async function twoTapsAcrossTheCommit(scheduler: RecordingScheduler) {
    setActiveDataOwner(ownerB);
    const readGate = gate();
    mockKvReadGate = {
      key: notificationPrefsKeyForOwner(ownerB),
      promise: readGate.promise,
    };
    const writeGate = gate();
    mockKvWriteGate = {
      key: notificationPrefsKeyForOwner(ownerB),
      promise: writeGate.promise,
    };
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    const tap1 = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    readGate.open();
    await settle();
    // The hydrate is now inside persistPrefs (INSERT gated), not yet committed.
    expect(useNotificationStore.getState().hydrated).toBe(false);

    const tap2 = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    // The in-memory view reflects the newest tap right away, as documented.
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);

    writeGate.open();
    await Promise.all([hydrateB, tap1, tap2]);
  }

  it('the committed prefs, the durable row and the OS plan must all reflect the LAST tap (enabled=false)', async () => {
    const scheduler = new RecordingScheduler();
    await twoTapsAcrossTheCommit(scheduler);

    const state = useNotificationStore.getState();
    expect(state).toMatchObject({ hydrated: true, ownerKey: ownerB });
    expect(state.prefs.enabled).toBe(false);
    expect(storedPrefs(ownerB)).toMatchObject({ enabled: false });
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');
  });

  it('the orphaned tap must not silently re-apply on a later, unrelated hydrate (e.g. next launch)', async () => {
    const scheduler = new RecordingScheduler();
    await twoTapsAcrossTheCommit(scheduler);

    const rowBefore = storedPrefs(ownerB);
    const prefsBefore = useNotificationStore.getState().prefs;
    // Nothing happened in between — a plain re-hydrate must be idempotent.
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });
    expect(useNotificationStore.getState().prefs).toEqual(prefsBefore);
    expect(storedPrefs(ownerB)).toEqual(rowBefore);
  });

  it('single tap variant: pre-auth onboarding choice being adopted + one tap during its INSERT', async () => {
    // The player chose "enable" in the pre-auth notification step, then signs in.
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(ownerB);
    const writeGate = gate();
    mockKvWriteGate = {
      key: notificationPrefsKeyForOwner(ownerB),
      promise: writeGate.promise,
    };
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });
    await settle();
    expect(useNotificationStore.getState().hydrated).toBe(false);

    // Settings tap while the hydrate is writing the adopted choice.
    const tap = useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 8 * 60 }, deps(scheduler));
    writeGate.open();
    await Promise.all([hydrateB, tap]);

    const state = useNotificationStore.getState();
    expect(state).toMatchObject({ hydrated: true, ownerKey: ownerB });
    expect(state.prefs).toMatchObject({
      enabled: true,
      practiceReminderMinutes: 8 * 60,
    });
    expect(storedPrefs(ownerB)).toMatchObject({
      enabled: true,
      practiceReminderMinutes: 8 * 60,
    });
    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('applyPlan');
    if (last?.kind === 'applyPlan') {
      const practice = last.plan.find(i => i.id === 'ps.reminder.practice');
      expect(practice && new Date(practice.timestampMs).getHours()).toBe(8);
    }
  });
});

describe('ATTACK MSA-P2-2 × MSA-P1-2 — account switch whose new owner’s read fails', () => {
  it('the previous account’s reminders must not stay armed for the new account', async () => {
    const scheduler = new RecordingScheduler();
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(scheduler.ops.at(-1)?.kind).toBe('applyPlan');

    // B signs in on the same device; B's row cannot be read.
    mockKvReadFails = true;
    setActiveDataOwner(ownerB);
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });
    const state = useNotificationStore.getState();
    expect(state).toMatchObject({
      hydrated: false,
      ownerKey: ownerB,
      readFailed: true,
    });

    // A's plan (A's 19:00 practice reminder, A's streak facts) must not
    // outlive A's account context — "reminders never outlive the account
    // context that asked for them".
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');
  });

  it('…nor after a foreground re-sync while the read keeps failing', async () => {
    const scheduler = new RecordingScheduler();
    seedOptedIn(ownerA);
    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));

    mockKvReadFails = true;
    setActiveDataOwner(ownerB);
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerB });

    // App returns to the foreground (useNotificationBootstrap path).
    await useNotificationStore.getState().refreshPermission(deps(scheduler));
    await useNotificationStore.getState().syncNow(deps(scheduler));

    expect(useNotificationStore.getState().hydrated).toBe(false);
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');
  });
});
