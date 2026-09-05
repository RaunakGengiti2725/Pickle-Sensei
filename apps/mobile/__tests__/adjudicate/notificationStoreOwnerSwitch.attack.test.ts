/**
 * MSA-P1-2 adversarial suite (attack on the owner-switch fix).
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect present.
 * The kv mock exposes a per-call SELECT gate, INSERT failure injection and an
 * op log so orderings the pin/repro suites do not reach can be forced:
 * rapid A→B→A switches, writes racing an aborted hydrate, sign-out mid-read,
 * guest→account, pre-existing malformed rows, persist failures mid-drain.
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
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockSelectGate: Promise<void> | null = null;
let mockInsertGate: Promise<void> | null = null;
/** Gates the Nth (1-based) SELECT of `key` issued after arming; one-shot. */
let mockSelectTrap: {
  key: string;
  nth: number;
  seen: number;
  gate: Promise<void>;
} | null = null;
const mockFailInsertKeys = new Set<string>();
const mockOps: Array<{ op: 'select' | 'insert'; key: string; value?: string }> =
  [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockSelectGate) await mockSelectGate;
        const key = String(params[0]);
        const trap = mockSelectTrap;
        if (trap && trap.key === key) {
          trap.seen += 1;
          if (trap.seen === trap.nth) await trap.gate;
        }
        mockOps.push({ op: 'select', key });
        const value = mockKvTable.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockInsertGate) await mockInsertGate;
        const key = String(params[0]);
        const value = String(params[1]);
        mockOps.push({ op: 'insert', key, value });
        if (mockFailInsertKeys.has(key)) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        mockKvTable.set(key, value);
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
    { kind: 'apply'; plan: PlannedNotification[] } | { kind: 'cancelAll' }
  > = [];
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
const ownerC = '55555555-5555-4555-8555-555555555555';

function deps(scheduler: RecordingScheduler) {
  return { scheduler, loadContext: async () => context };
}

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

function gateSelects() {
  let release!: () => void;
  mockSelectGate = new Promise<void>(r => (release = r));
  return () => {
    release();
    mockSelectGate = null;
  };
}

function trapSelect(key: string, nth: number) {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  mockSelectTrap = { key, nth, seen: 0, gate };
  return () => {
    release();
    mockSelectTrap = null;
  };
}

function gateInserts() {
  let release!: () => void;
  mockInsertGate = new Promise<void>(r => (release = r));
  return () => {
    release();
    mockInsertGate = null;
  };
}

async function hydrateAsOptedInA(scheduler: RecordingScheduler) {
  setActiveDataOwner(ownerA);
  seedPrefs(ownerA, {
    enabled: true,
    promptDismissed: true,
    practiceReminderMinutes: 19 * 60,
  });
  await useNotificationStore.getState().hydrate(deps(scheduler));
  expect(useNotificationStore.getState()).toEqual(
    expect.objectContaining({ hydrated: true, ownerKey: ownerA }),
  );
}

const A_ROW = expect.objectContaining({
  enabled: true,
  practiceReminderMinutes: 19 * 60,
});

beforeEach(() => {
  mockKvTable.clear();
  mockOps.length = 0;
  mockFailInsertKeys.clear();
  mockSelectGate = null;
  mockInsertGate = null;
  mockSelectTrap = null;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    pendingWrite: null,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(async () => {
  // Never leave a gated read behind for the next test to join.
  mockSelectGate = null;
  mockInsertGate = null;
  mockSelectTrap = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  // Settle the module-level in-flight slot so no test inherits a hydrate.
  await useNotificationStore.getState().hydrate(deps(new RecordingScheduler()));
  await flush();
});

describe('MSA-P1-2 attack — ordering variants of the original repro', () => {
  it('AT1: write for B arrives BEFORE any hydrate(B) is called (toggle beats the bootstrap effect)', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const write = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await flush();
    const mid = useNotificationStore.getState();
    // Bootstrap effect fires afterwards.
    const hydrateB = useNotificationStore.getState().hydrate({
      ...deps(scheduler),
      expectedOwnerKey: ownerB,
    });
    release();
    await Promise.all([write, hydrateB]);

    expect({
      hydrated: mid.hydrated,
      ownerKey: mid.ownerKey,
      enabled: mid.prefs.enabled,
    }).not.toEqual({ hydrated: true, ownerKey: ownerA, enabled: true });
    expect(durablePrefs(ownerB)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      weeklyRecap: false,
    });
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, weeklyRecap: false },
      }),
    );
  });

  it('AT2: B has a pre-existing row; a mid-flight write is re-based onto it, not onto A or defaults', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);
    seedPrefs(ownerB, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 6 * 60,
      comeback: false,
    });

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    release();
    await hydrateB;

    const expected = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 6 * 60,
      comeback: false,
      weeklyRecap: false,
    };
    expect(durablePrefs(ownerB)).toEqual(expected);
    expect(useNotificationStore.getState().prefs).toEqual(expected);
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
  });

  it('AT3: two conflicting writes during the read — newest intent wins in memory AND on disk', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const w1 = useNotificationStore
      .getState()
      .setPrefs({ practiceReminderMinutes: 8 * 60 }, deps(scheduler));
    const w2 = useNotificationStore
      .getState()
      .setPrefs(
        { practiceReminderMinutes: 9 * 60, streakDefense: false },
        deps(scheduler),
      );
    release();
    await Promise.all([hydrateB, w1, w2]);

    const expected = {
      ...DEFAULT_NOTIFICATION_PREFS,
      practiceReminderMinutes: 9 * 60,
      streakDefense: false,
    };
    expect(durablePrefs(ownerB)).toEqual(expected);
    expect(useNotificationStore.getState().prefs).toEqual(expected);
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
  });

  it('AT4: guest → account switch with a mid-flight write never copies guest prefs into the account row', async () => {
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(GUEST_DATA_OWNER);
    seedPrefs(GUEST_DATA_OWNER, {
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 5 * 60,
    });
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ comeback: false }, deps(scheduler));
    release();
    await hydrateB;

    expect(durablePrefs(ownerB)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      comeback: false,
    });
    expect(durablePrefs(GUEST_DATA_OWNER)).toEqual(
      expect.objectContaining({
        enabled: true,
        practiceReminderMinutes: 5 * 60,
      }),
    );
  });

  it('AT5: A → signed-out mid-read: everything cancelled, A row untouched, no write lands under signed-out', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    // Sign out before B's read resolves.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const hydrateOut = useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await Promise.all([hydrateB, write, hydrateOut]);

    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: SIGNED_OUT_DATA_OWNER,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        pendingWrite: null,
      }),
    );
    expect(scheduler.ops.at(-1)).toEqual({ kind: 'cancelAll' });
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
    expect(
      mockKvTable.get(notificationPrefsKeyForOwner(SIGNED_OUT_DATA_OWNER)),
    ).toBeUndefined();
    const rowB = durablePrefs(ownerB);
    if (rowB) expect(rowB.enabled).toBe(false);
  });

  it('AT6: persist failure while draining a queued write flags persistFailed and leaves A untouched', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    mockFailInsertKeys.add(notificationPrefsKeyForOwner(ownerB));
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    release();
    await hydrateB;

    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerB,
        persistFailed: true,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, weeklyRecap: false },
      }),
    );
    expect(durablePrefs(ownerB)).toBeNull();
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
  });

  it('AT7: malformed pre-existing B row + mid-flight write → defaults + patch, never A', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);
    mockKvTable.set(notificationPrefsKeyForOwner(ownerB), '{"enabled":"yes",');

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    release();
    await hydrateB;

    expect(durablePrefs(ownerB)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      weeklyRecap: false,
    });
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
  });

  it('AT8: pending onboarding choice (signed-out "enable") + mid-flight write for the new account compose', async () => {
    const scheduler = new RecordingScheduler();
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    release();
    await hydrateB;

    const expected = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      weeklyRecap: false,
    };
    expect(durablePrefs(ownerB)).toEqual(expected);
    expect(useNotificationStore.getState().prefs).toEqual(expected);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });

  it('AT17: pre-existing B rows that are empty-string / JSON null / a JSON array + a mid-flight write → defaults + patch, never A', async () => {
    for (const badRow of ['', 'null', '[1,2]', '"\u{1F3BE}"']) {
      mockKvTable.clear();
      mockOps.length = 0;
      useNotificationStore.setState({
        hydrated: false,
        ownerKey: null,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        pendingWrite: null,
      });
      const scheduler = new RecordingScheduler();
      await hydrateAsOptedInA(scheduler);
      mockKvTable.set(notificationPrefsKeyForOwner(ownerB), badRow);

      setActiveDataOwner(ownerB);
      const release = gateSelects();
      const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
      await flush();
      const write = useNotificationStore
        .getState()
        .setPrefs({ streakDefense: false }, deps(scheduler));
      release();
      await Promise.all([hydrateB, write]);

      expect(durablePrefs(ownerB)).toEqual({
        ...DEFAULT_NOTIFICATION_PREFS,
        streakDefense: false,
      });
      expect(useNotificationStore.getState().prefs).toEqual(
        durablePrefs(ownerB),
      );
      expect(durablePrefs(ownerA)).toEqual(A_ROW);
    }
  });

  it('AT9: requestPermissionAndEnable during B’s in-flight hydrate enables B only (A row untouched, plan applied for B)', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const enabled = useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    release();
    await Promise.all([hydrateB, enabled]);

    expect(await enabled).toBe(true);
    expect(durablePrefs(ownerB)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
    });
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({ hydrated: true, ownerKey: ownerB }),
    );
    expect(scheduler.ops.at(-1)?.kind).toBe('apply');
  });
});

describe('MSA-P1-2 attack — the fix’s own machinery (pendingWrite / hydrateInFlight)', () => {
  it('AT10: rapid B→C→B switch with a queued write for B: memory must equal the durable row afterwards', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    const release = gateSelects();
    setActiveDataOwner(ownerB);
    const hydrateB1 = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    setActiveDataOwner(ownerC);
    const hydrateC = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    setActiveDataOwner(ownerB);
    const hydrateB2 = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await flush();
    release();
    await Promise.all([hydrateB1, hydrateC, hydrateB2, write]);
    await flush();

    const rowB = durablePrefs(ownerB);
    const state = useNotificationStore.getState();
    expect(state).toEqual(
      expect.objectContaining({ hydrated: true, ownerKey: ownerB }),
    );
    expect(rowB).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, weeklyRecap: false });
    // The user's choice must be what the UI shows AND what the next write
    // spreads from — otherwise the next toggle silently reverts it on disk.
    expect(state.prefs).toEqual(rowB);
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
    expect(durablePrefs(ownerC)).toBeNull();
  });

  it('AT16: B→C→B where the SECOND B hydrate commits last: memory must not revert to defaults while the row holds the write', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    const release = gateSelects();
    setActiveDataOwner(ownerB);
    const hydrateB1 = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    setActiveDataOwner(ownerC);
    const hydrateC = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    setActiveDataOwner(ownerB);
    // hydrateInFlight now points at C, so this does NOT join B1: two hydrates
    // for B run concurrently.
    const hydrateB2 = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await flush();
    // B2's second read (pending-onboarding key) is the slow one.
    const releaseTrap = trapSelect(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, 3);
    release();
    await Promise.all([hydrateB1, hydrateC, write]);
    await flush();
    // B1 has committed the write to the row and to memory by now.
    expect(durablePrefs(ownerB)?.weeklyRecap).toBe(false);
    expect(useNotificationStore.getState().prefs.weeklyRecap).toBe(false);
    releaseTrap();
    await hydrateB2;
    await flush();

    const state = useNotificationStore.getState();
    expect(state).toEqual(
      expect.objectContaining({ hydrated: true, ownerKey: ownerB }),
    );
    // Memory must still carry the user's choice…
    expect(state.prefs.weeklyRecap).toBe(false);
    // …because the next ordinary toggle spreads memory onto the row.
    await useNotificationStore
      .getState()
      .setPrefs({ comeback: false }, deps(scheduler));
    expect(durablePrefs(ownerB)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      weeklyRecap: false,
      comeback: false,
    });
    expect(durablePrefs(ownerA)).toEqual(A_ROW);
  });

  it('AT11: a write queued for A is not silently dropped when the owner switches before A’s read resolves', async () => {
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(ownerA);
    const release = gateSelects();
    const hydrateA = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    await flush();
    setActiveDataOwner(ownerB);
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await Promise.all([hydrateA, hydrateB, write]);
    await flush();

    // Either the write reached A's row, or the store still carries the
    // intent for A / flags the failure. Silent loss is the defect.
    const rowA = durablePrefs(ownerA);
    const state = useNotificationStore.getState();
    const preserved =
      rowA?.enabled === true ||
      state.pendingWrite?.owner === ownerA ||
      state.persistFailed;
    expect(preserved).toBe(true);
    // And B never inherits it.
    const rowB = durablePrefs(ownerB);
    if (rowB) expect(rowB.enabled).toBe(false);
    expect(state.prefs.enabled).toBe(false);
  });

  it('AT18: sign-out while B’s write is still queued must not silently drop it, and nothing lands under signed-out', async () => {
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    await flush();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const hydrateOut = useNotificationStore.getState().hydrate(deps(scheduler));
    release();
    await Promise.all([hydrateB, hydrateOut, write]);
    await flush();

    expect(durablePrefs(SIGNED_OUT_DATA_OWNER)).toBeNull();
    const state = useNotificationStore.getState();
    expect(state).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: SIGNED_OUT_DATA_OWNER,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      }),
    );
    expect(scheduler.ops.at(-1)?.kind).toBe('cancelAll');
    const preserved =
      durablePrefs(ownerB)?.enabled === true ||
      state.pendingWrite?.owner === ownerB ||
      state.persistFailed;
    expect(preserved).toBe(true);
  });

  it('AT12: a pre-hydrate write with NO hydrate in flight keeps the user’s choice visible while the row is read', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const release = gateSelects();
    // No bootstrap hydrate yet: the toggle itself triggers the read.
    const write = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await flush();
    const mid = useNotificationStore.getState();
    release();
    await write;

    expect(mid.prefs.weeklyRecap).toBe(false);
    expect(mid.hydrated === false || mid.ownerKey === ownerB).toBe(true);
    expect(useNotificationStore.getState().prefs.weeklyRecap).toBe(false);
    expect(durablePrefs(ownerB)?.weeklyRecap).toBe(false);
  });

  it('AT13: same-owner re-hydrate (foreground) racing a normal-path write must not revert the write in memory', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    const release = gateSelects();
    const rehydrate = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    await useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    expect(durablePrefs(ownerA)?.weeklyRecap).toBe(false);
    release();
    await rehydrate;

    expect(useNotificationStore.getState().prefs.weeklyRecap).toBe(false);
    // A later toggle must not resurrect the stale value on disk.
    await useNotificationStore
      .getState()
      .setPrefs({ comeback: false }, deps(scheduler));
    expect(durablePrefs(ownerA)).toEqual(
      expect.objectContaining({ weeklyRecap: false, comeback: false }),
    );
  });

  it('AT14: hydrate(B) resolved by the caller means the store IS hydrated for B (join must not resolve early)', async () => {
    const scheduler = new RecordingScheduler();
    setActiveDataOwner(ownerB);
    const release = gateSelects();
    const first = useNotificationStore.getState().hydrate(deps(scheduler));
    const second = useNotificationStore.getState().hydrate(deps(scheduler));
    let secondDone = false;
    void second.then(() => (secondDone = true));
    await flush();
    expect(secondDone).toBe(false);
    release();
    await second;
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({ hydrated: true, ownerKey: ownerB }),
    );
    await first;
    // One read of B's row, not two.
    expect(
      mockOps.filter(
        o =>
          o.op === 'select' && o.key === notificationPrefsKeyForOwner(ownerB),
      ),
    ).toHaveLength(1);
  });

  it('AT15: B→A→B while B’s queued write is mid-persist: nothing of B lands under A, A’s row survives', async () => {
    const scheduler = new RecordingScheduler();
    await hydrateAsOptedInA(scheduler);

    setActiveDataOwner(ownerB);
    const releaseSelect = gateSelects();
    const hydrateB = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    const write = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    await flush();
    const releaseInsert = gateInserts();
    releaseSelect();
    await flush();
    // B's persist is now parked on the INSERT gate; the user goes back to A.
    setActiveDataOwner(ownerA);
    const hydrateA = useNotificationStore.getState().hydrate(deps(scheduler));
    await flush();
    releaseInsert();
    await Promise.all([hydrateB, write, hydrateA]);
    await flush();

    expect(durablePrefs(ownerA)).toEqual(A_ROW);
    expect(useNotificationStore.getState()).toEqual(
      expect.objectContaining({
        hydrated: true,
        ownerKey: ownerA,
        prefs: expect.objectContaining({ practiceReminderMinutes: 19 * 60 }),
      }),
    );
    const rowB = durablePrefs(ownerB);
    if (rowB) {
      expect(rowB.practiceReminderMinutes).toBe(
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      );
    }
    // Every INSERT under A's key carries A's 19:00 reminder — never B's.
    for (const op of mockOps) {
      if (
        op.op === 'insert' &&
        op.key === notificationPrefsKeyForOwner(ownerA)
      ) {
        expect(JSON.parse(op.value!)).toEqual(A_ROW);
      }
    }
  });
});
