/**
 * MSA-P1-2 adversarial suite (mobile-settings-account) against the candidate
 * fix in notificationStore.ts (owner invalidation + pending-write re-base +
 * same-owner hydrate join). Every test asserts the EXPECTED behaviour; a
 * failure = a defect in the fix or its neighbourhood.
 *
 * Attack surface: orderings (write before/after/without hydrate, A→B→A,
 * A→B→C), two concurrent hydrates, concurrent writes, cancellation mid-flight
 * (sign-out / revoked session), foreground sync mid-switch, malformed / empty /
 * out-of-range durable rows, pre-auth onboarding carry-over, failed SELECT,
 * durability of an awaited write, dead in-flight hydrate, mixed-case ids.
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

type KvOp = { kind: 'select' | 'insert'; key: string; value?: string };

const mockKvTable = new Map<string, string>();
const mockKvOps: KvOp[] = [];
/** Per-statement gate: return a promise to delay THIS statement, or null. */
let mockGate: ((op: KvOp) => Promise<void> | null) | null = null;
/** Per-statement fault: throw for THIS statement when it returns true. */
let mockFault: ((op: KvOp) => boolean) | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        // SQLite executes the statement when it is issued; a gate only delays
        // the bridge returning the (already read) result to JS.
        const op: KvOp = { kind: 'select', key: String(params[0]) };
        mockKvOps.push(op);
        const value = mockKvTable.get(op.key);
        const gate = mockGate?.(op);
        if (gate) await gate;
        if (mockFault?.(op)) throw new Error('SQLITE_IOERR');
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const op: KvOp = {
          kind: 'insert',
          key: String(params[0]),
          value: String(params[1]),
        };
        mockKvOps.push(op);
        const gate = mockGate?.(op);
        if (gate) await gate;
        if (mockFault?.(op)) throw new Error('SQLITE_IOERR');
        mockKvTable.set(op.key, op.value!);
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

class RecordingScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: Array<
    | { kind: 'apply'; plan: readonly PlannedNotification[] }
    | { kind: 'cancelAll' }
  > = [];
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'apply', plan });
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
const ownerC = '55555555-5555-4555-8555-555555555555';

const keyA = notificationPrefsKeyForOwner(ownerA);
const keyB = notificationPrefsKeyForOwner(ownerB);
const keyC = notificationPrefsKeyForOwner(ownerC);

function seedPrefs(owner: string, patch: Partial<NotificationPrefs>) {
  const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, ...patch };
  mockKvTable.set(notificationPrefsKeyForOwner(owner), JSON.stringify(prefs));
  return prefs;
}

function durablePrefs(owner: string): NotificationPrefs | null {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined ? null : (JSON.parse(raw) as NotificationPrefs);
}

function insertsFor(key: string): KvOp[] {
  return mockKvOps.filter(op => op.kind === 'insert' && op.key === key);
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(r => (release = r));
  return { promise, release };
}

/** Gate exactly the SELECT of `key`; every other statement runs at once. */
function gateSelectOf(key: string) {
  const gate = deferred();
  let armed = true;
  mockGate = op =>
    armed && op.kind === 'select' && op.key === key ? gate.promise : null;
  return {
    release: () => {
      armed = false;
      gate.release();
    },
  };
}

const A_PREFS = {
  enabled: true,
  promptDismissed: true,
  practiceReminderMinutes: 19 * 60,
};

function deps(scheduler: RecordingScheduler) {
  return { scheduler, loadContext: async () => context };
}

async function hydrateA(scheduler: RecordingScheduler) {
  setActiveDataOwner(ownerA);
  seedPrefs(ownerA, A_PREFS);
  await useNotificationStore.getState().hydrate(deps(scheduler));
  expect(useNotificationStore.getState()).toEqual(
    expect.objectContaining({ hydrated: true, ownerKey: ownerA }),
  );
}

async function switchToBWithSlowSelect(scheduler: RecordingScheduler) {
  setActiveDataOwner(ownerB);
  const gate = gateSelectOf(keyB);
  const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
  await flush();
  return { hydrateB, release: gate.release };
}

function expectARowUntouched() {
  expect(durablePrefs(ownerA)).toEqual(expect.objectContaining(A_PREFS));
  expect(insertsFor(keyA)).toHaveLength(0);
}

beforeEach(async () => {
  // Drain any hydrate left in flight by a previous test so the module-level
  // join state cannot leak across cases.
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockGate = null;
  mockFault = null;
  await useNotificationStore.getState().hydrate({
    scheduler: new RecordingScheduler(),
    loadContext: async () => context,
  });
  mockKvTable.clear();
  mockKvOps.length = 0;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    pendingWrite: null,
  });
});

afterEach(() => {
  mockGate = null;
  mockFault = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('MSA-P1-2 attack — ordering variants of the original repro', () => {
  it("write for B lands BEFORE any hydrate(B) is requested (bootstrap effect late): B's row is defaults+patch, A's untouched", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    setActiveDataOwner(ownerB);
    // No hydrate(B) yet — the auth store flips the owner before React
    // re-renders App and the bootstrap effect fires.
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await useNotificationStore.getState().hydrate(deps(scheduler));

    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({
        enabled: false,
        practiceReminderMinutes: 1050,
        weeklyRecap: false,
      }),
    );
    expectARowUntouched();
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        pendingWrite: null,
      }),
    );
  });

  it("A→B→A ping-pong with B's SELECT slow: A's state wins and B's late hydrate cannot flip the store back to B", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    expect(useNotificationStore.getState().hydrated).toBe(false);

    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerA,
        prefs: expect.objectContaining(A_PREFS),
      }),
    );

    release();
    await hydrateB;
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerA,
        prefs: expect.objectContaining(A_PREFS),
      }),
    );
    expect(durablePrefs(ownerB)).toBeNull();
    expectARowUntouched();
  });

  it("A→B→C: B's queued write must not be persisted under C's key nor merged into C's in-memory prefs", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerC, { enabled: true, practiceReminderMinutes: 8 * 60 });
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, streakDefense: false }, deps(scheduler));

    setActiveDataOwner(ownerC);
    const hydrateC = useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await Promise.all([hydrateB, hydrateC]);

    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerC,
        prefs: expect.objectContaining({
          enabled: true,
          practiceReminderMinutes: 8 * 60,
          streakDefense: true,
        }),
      }),
    );
    expect(durablePrefs(ownerC)).toEqual(
      expect.objectContaining({ streakDefense: true }),
    );
    expect(insertsFor(keyC)).toHaveLength(0);
    expectARowUntouched();
  });

  it("A's in-flight normal write (INSERT slow) straddling the switch to B never lands in B's key or B's memory", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerB, { enabled: false, promptDismissed: true });
    const insertGate = deferred();
    mockGate = op =>
      op.kind === 'insert' && op.key === keyA ? insertGate.promise : null;
    const writeA = useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 21 * 60 }, deps(scheduler));
    await flush();

    setActiveDataOwner(ownerB);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    insertGate.release();
    await writeA;

    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        prefs: expect.objectContaining({
          enabled: false,
          practiceReminderMinutes: 1050,
        }),
      }),
    );
    expect(insertsFor(keyB)).toHaveLength(0);
    expect(durablePrefs(ownerA)).toEqual(
      expect.objectContaining({ practiceReminderMinutes: 21 * 60 }),
    );
    // B is disabled: the final scheduler op must be a cancel, never A's plan.
    expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });
  });
});

describe('MSA-P1-2 attack — concurrency', () => {
  it("A→B→A→B: B's stale first hydrate (result still on the bridge) must not commit over B's newer opt-in or cancel B's reminders", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB: staleB, release } =
      await switchToBWithSlowSelect(scheduler);

    setActiveDataOwner(ownerA);
    await useNotificationStore.getState().hydrate(deps(scheduler));

    setActiveDataOwner(ownerB);
    // Second hydrate(B) from the bootstrap effect, then B opts in; both
    // complete against the live row while the first SELECT is still gated.
    mockGate = null;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(scheduler.ops.at(-1)?.kind).toBe('apply');
    scheduler.ops.length = 0;

    release();
    await staleB;

    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        prefs: expect.objectContaining({ enabled: true }),
      }),
    );
    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(scheduler.ops.map(op => op.kind)).not.toContain('cancelAll');
  });

  it('two concurrent hydrate(B) + one write: exactly one durable B row carrying the patch, no duplicate schedule', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    setActiveDataOwner(ownerB);
    const gate = gateSelectOf(keyB);
    const h1 = useNotificationStore.getState().hydrate(deps(scheduler));
    const h2 = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, comeback: false }, deps(scheduler));
    gate.release();
    await Promise.all([h1, h2, write]);

    expect(insertsFor(keyB)).toHaveLength(1);
    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({
        enabled: true,
        comeback: false,
        practiceReminderMinutes: 1050,
      }),
    );
    expect(
      mockKvOps.filter(op => op.kind === 'select' && op.key === keyB),
    ).toHaveLength(1);
    expectARowUntouched();
  });

  it('two writes queued during the same in-flight hydrate both survive the re-base', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerB, { weeklyRecap: false });
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    const w1 = useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    const w2 = useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 20 * 60 }, deps(scheduler));
    release();
    await Promise.all([hydrateB, w1, w2]);

    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({
        enabled: true,
        practiceReminderMinutes: 20 * 60,
        weeklyRecap: false,
      }),
    );
    expect(useNotificationStore.getState().prefs).toEqual(
      expect.objectContaining({
        enabled: true,
        practiceReminderMinutes: 20 * 60,
        weeklyRecap: false,
      }),
    );
    expectARowUntouched();
  });

  it('a write arriving while hydrate(B) is persisting the first queued patch is not lost', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    const w1 = useNotificationStore
      .getState()
      .setPrefs({ enabled: true }, deps(scheduler));
    const insertGate = deferred();
    let inserts = 0;
    mockGate = op => {
      if (op.kind === 'insert' && op.key === keyB && inserts++ === 0) {
        return insertGate.promise;
      }
      return null;
    };
    release();
    await flush();
    const w2 = useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler));
    insertGate.release();
    await Promise.all([hydrateB, w1, w2]);

    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({ enabled: true, streakDefense: false }),
    );
    expect(useNotificationStore.getState().pendingWrite).toBeNull();
  });
});

describe('MSA-P1-2 attack — cancellation mid-flight', () => {
  it("sign-out while B's write is queued behind a slow hydrate: the awaited write is either durable under B or reported unsaved — never silently dropped", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    const write = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await Promise.all([hydrateB, write]);

    expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });
    expectARowUntouched();
    const rowB = durablePrefs(ownerB);
    const unsavedReported = useNotificationStore.getState().persistFailed;
    // Contract: "a write is rejected or re-based" — rejected must be visible.
    expect(rowB !== null || unsavedReported).toBe(true);
  });

  it("revoked session (B → signed-out) then B signs back in: B's earlier opt-in is not reported as saved and then missing", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    const shownAsEnabled = useNotificationStore.getState().prefs.enabled;

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await hydrateB;

    setActiveDataOwner(ownerB);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    const afterReturn = useNotificationStore.getState();
    // Either the toggle was never shown as on, or it is still on when B is back.
    expect(shownAsEnabled && !afterReturn.prefs.enabled).toBe(false);
  });

  it("await setPrefs() for B resolving implies B's row is durable (kill-safe write contract)", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));

    const durableAtResolve = durablePrefs(ownerB);
    release();
    await hydrateB;
    expect(durableAtResolve).toEqual(
      expect.objectContaining({ enabled: true, promptDismissed: true }),
    );
  });

  it('a dead in-flight hydrate(B) (SELECT never resolves) is not joined after sign-out and sign-in as B again', async () => {
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(ownerB);
    seedPrefs(ownerB, { enabled: true, promptDismissed: true });
    const gate = gateSelectOf(keyB);
    const dead = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    setActiveDataOwner(ownerB);
    mockGate = null;
    const timeout = new Promise<'timeout'>(r =>
      setTimeout(() => r('timeout'), 50),
    );
    const outcome = await Promise.race([
      useNotificationStore
        .getState()
        .hydrate(deps(scheduler))
        .then(() => 'hydrated' as const),
      timeout,
    ]);
    expect(outcome).toBe('hydrated');
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        prefs: expect.objectContaining({ enabled: true }),
      }),
    );
    gate.release();
    await dead;
    expect(useNotificationStore.getState().ownerKey).toBe(ownerB);
  });
});

describe('MSA-P1-2 attack — foreground / background', () => {
  it("foreground syncNow while B's hydrate is in flight cancels instead of applying A's plan; B's own plan follows the commit", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerB, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 7 * 60,
    });
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    scheduler.ops.length = 0;

    await useNotificationStore.getState().refreshPermission(deps(scheduler));
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(scheduler.ops).toEqual([{ kind: 'cancelAll' }]);

    release();
    await hydrateB;
    const last = scheduler.ops.at(-1);
    expect(last?.kind).toBe('apply');
    if (last?.kind === 'apply') {
      const practice = last.plan.find(n => n.id === 'ps.reminder.practice');
      expect(practice).toBeDefined();
      expect(new Date(practice!.timestampMs).getHours()).toBe(7);
    }
  });
});

describe('MSA-P1-2 attack — malformed / NULL / boundary durable rows', () => {
  it.each([
    ['non-JSON', '{not json'],
    ['empty string', ''],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    [
      'wrong types',
      '{"version":1,"enabled":"yes","practiceReminderMinutes":"19:00"}',
    ],
    [
      'out-of-range minutes 1440',
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        practiceReminderMinutes: 1440,
      }),
    ],
    [
      'negative minutes',
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        practiceReminderMinutes: -1,
      }),
    ],
    [
      'fractional minutes',
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        practiceReminderMinutes: 1050.5,
      }),
    ],
    ['unicode garbage', '\u{1F3D3}\u0000\uFFFD'],
    [
      'old-app shape, unknown fields only',
      '{"version":0,"reminderHour":19,"push":"on"}',
    ],
  ])(
    "B's pre-existing bad row (%s) + write during hydrate: B ends on defaults+patch, A untouched, no A value leaks",
    async (_label, raw) => {
      const scheduler = new RecordingScheduler();
      await hydrateA(scheduler);
      mockKvTable.set(keyB, raw);
      const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
      await useNotificationStore
        .getState()
        .setPrefs({ weeklyRecap: false }, deps(scheduler));
      release();
      await hydrateB;

      expect(durablePrefs(ownerB)).toEqual({
        ...DEFAULT_NOTIFICATION_PREFS,
        weeklyRecap: false,
      });
      expect(useNotificationStore.getState().prefs).toEqual({
        ...DEFAULT_NOTIFICATION_PREFS,
        weeklyRecap: false,
      });
      expectARowUntouched();
    },
  );

  it('boundary minutes 0 and 1439 in a queued patch are preserved verbatim', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 0 }, deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 1439 }, deps(scheduler));
    release();
    await hydrateB;
    expect(durablePrefs(ownerB)?.practiceReminderMinutes).toBe(1439);
    expectARowUntouched();
  });
});

describe('MSA-P1-2 attack — pre-auth onboarding carry-over', () => {
  it("signed-out 'enable' choice + B (no row) + write queued during hydrate: B gets enabled+promptDismissed+patch, pending key cleared, A untouched", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    release();
    await hydrateB;

    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({
        enabled: true,
        promptDismissed: true,
        weeklyRecap: false,
        practiceReminderMinutes: 1050,
      }),
    );
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) ?? '').toBe(
      '',
    );
    expectARowUntouched();
  });

  it('signed-out choice never overrides an existing B row, and a queued patch still lands on it', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerB, { enabled: false, promptDismissed: true });
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    const { hydrateB, release } = await switchToBWithSlowSelect(scheduler);
    await useNotificationStore
      .getState()
      .setPrefs({ comeback: false }, deps(scheduler));
    release();
    await hydrateB;
    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({
        enabled: false,
        promptDismissed: true,
        comeback: false,
      }),
    );
    expectARowUntouched();
  });
});

describe('MSA-P1-2 attack — failed SELECT with a queued write', () => {
  it("B's SELECT throws while a write is queued: the store flags persistFailed and does NOT overwrite B's unreadable row", async () => {
    const scheduler = new RecordingScheduler();
    await hydrateA(scheduler);
    seedPrefs(ownerB, { enabled: true, practiceReminderMinutes: 6 * 60 });
    setActiveDataOwner(ownerB);
    const gate = gateSelectOf(keyB);
    mockFault = op => op.kind === 'select' && op.key === keyB;
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    gate.release();
    await hydrateB;

    expect(insertsFor(keyB)).toHaveLength(0);
    expect(durablePrefs(ownerB)).toEqual(
      expect.objectContaining({ enabled: true, practiceReminderMinutes: 360 }),
    );
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        ownerKey: ownerB,
        persistFailed: true,
        pendingWrite: null,
      }),
    );
    expectARowUntouched();
  });
});

describe('MSA-P1-2 attack — identity normalisation', () => {
  it('a mixed-case canonical id resolves to the same durable row as its lowercase form', async () => {
    const scheduler = new RecordingScheduler();
    const ownerHex = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    setActiveDataOwner(ownerHex.toUpperCase());
    seedPrefs(ownerHex, { enabled: true, promptDismissed: true });
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: ownerHex });
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerHex,
        prefs: expect.objectContaining({ enabled: true }),
      }),
    );
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    expect(
      mockKvTable.has(notificationPrefsKeyForOwner(ownerHex.toUpperCase())),
    ).toBe(false);
    expect(durablePrefs(ownerHex)?.weeklyRecap).toBe(false);
  });
});
