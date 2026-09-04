import type { NotificationPlanContext } from '../../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * ADVERSARIAL PASS 3 / tester #4 — notification store owner races.
 *
 * Scenario 3: owner A enables reminders, signs out, owner B signs in and
 *             toggles a switch BEFORE B's hydrate resolves. B's durable row
 *             must be default-based, never A's preferences.
 * Scenario 4: same owner signs out and back in with enabled:true persisted and
 *             permission granted → reminders re-arm, no permission re-prompt,
 *             no second priming card.
 * Scenario 5: owner B's hydrate KV read resolves AFTER a setPrefs sneaked in →
 *             final in-memory prefs must equal the durable row and exactly one
 *             plan must be applied.
 *
 * The KV fake mirrors SQLite queue semantics: a SELECT snapshots the value at
 * submission time and its promise resolves when the test releases it, so a
 * write issued after the read was submitted is invisible to that read.
 */

const mockKvTable = new Map<string, string>();
const mockPendingReads: Array<() => void> = [];
let mockGateReads = false;

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        const rows = value === undefined ? [] : [{ value }];
        if (!mockGateReads) return Promise.resolve({ rows });
        return new Promise<{ rows: Array<{ value: string }> }>(resolve => {
          mockPendingReads.push(() => resolve({ rows }));
        });
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
    close() {},
  }),
}));

import { useNotificationStore } from '../../../src/notifications/notificationStore';

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  requestResult: PermissionState = 'granted';
  /** When set, cancelAllPlanned parks until the test releases it. */
  gateCancel = false;
  pendingCancels: Array<() => void> = [];

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
  cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
    if (!this.gateCancel) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.pendingCancels.push(resolve);
    });
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

const OWNER_A = canonicalDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const OWNER_B = canonicalDataOwner('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

function deps(scheduler: FakeScheduler) {
  return { scheduler, loadContext: async () => planContext };
}

function durableRow(owner: string): NotificationPrefs | null {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(owner));
  return raw === undefined ? null : parseNotificationPrefs(raw);
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

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Mirrors App.tsx: the Gate re-hydrates for SIGNED_OUT on sign-out and for
 * the canonical owner on sign-in (useNotificationBootstrap). */
async function signOut(scheduler: FakeScheduler) {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  await useNotificationStore.getState().hydrate({
    ...deps(scheduler),
    expectedOwnerKey: SIGNED_OUT_DATA_OWNER,
  });
}

/** The priming card's visibility predicate (NotificationPrimingCard.tsx). */
function primingCardVisible(): boolean {
  const { hydrated, prefs, permission } = useNotificationStore.getState();
  return (
    hydrated &&
    !prefs.enabled &&
    !prefs.promptDismissed &&
    permission !== 'denied'
  );
}

beforeEach(() => {
  mockKvTable.clear();
  mockPendingReads.length = 0;
  mockGateReads = false;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('scenario 3 — cross-account isolation before B hydrates', () => {
  it("B's toggle before hydrate persists a default-based row, never A's prefs", async () => {
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';

    // Owner A: enable reminders at 06:00.
    setActiveDataOwner(OWNER_A);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore.getState().setPrefs(
      {
        enabled: true,
        practiceReminderMinutes: 6 * 60,
        promptDismissed: true,
      },
      deps(scheduler),
    );
    const rowA = durableRow(OWNER_A);
    expect(rowA).toMatchObject({ enabled: true, practiceReminderMinutes: 360 });

    await signOut(scheduler);
    expect(useNotificationStore.getState().prefs).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );

    // Owner B signs in; hydrate is in flight (KV read gated) when B flips a switch.
    setActiveDataOwner(OWNER_B);
    mockGateReads = true;
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_B });
    await flushMicrotasks();
    expect(mockPendingReads.length).toBeGreaterThan(0);

    await useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler));

    const rowBDuringHydrate = durableRow(OWNER_B);
    expect(rowBDuringHydrate).not.toBeNull();
    // Default-based: A's 06:00 / enabled:true must not have leaked into B's row.
    expect(rowBDuringHydrate).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      streakDefense: false,
    });

    mockGateReads = false;
    while (mockPendingReads.length) mockPendingReads.shift()!();
    await hydrateB;

    // A's row is untouched by B's session.
    expect(durableRow(OWNER_A)).toEqual(rowA);
    // Nothing of A's ever reaches B's memory either.
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    expect(useNotificationStore.getState().ownerKey).toBe(OWNER_B);
  });

  it('B signs in while the sign-out cancelAllPlanned is still pending → A prefs still in memory leak into B row', async () => {
    // Attack: the SIGNED_OUT hydrate awaits `scheduler.cancelAllPlanned()`
    // (a native call) BEFORE resetting prefs to defaults. If B becomes the
    // active owner before that resolves, the signed-out hydrate bails out on
    // its owner check and A's prefs are still in memory during B's hydrate.
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    setActiveDataOwner(OWNER_A);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore.getState().setPrefs(
      {
        enabled: true,
        practiceReminderMinutes: 6 * 60,
        promptDismissed: true,
      },
      deps(scheduler),
    );

    scheduler.gateCancel = true;
    const signedOutHydrate = signOut(scheduler);
    await flushMicrotasks();
    expect(scheduler.pendingCancels).toHaveLength(1);
    // A's prefs are still in memory: the reset happens after the await.
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    setActiveDataOwner(OWNER_B);
    scheduler.gateCancel = false;
    scheduler.pendingCancels.shift()!();
    await signedOutHydrate;
    // The signed-out hydrate bailed out without resetting memory.
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    mockGateReads = true;
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_B });
    await flushMicrotasks();
    await useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler));

    const leaked = durableRow(OWNER_B);
    mockGateReads = false;
    while (mockPendingReads.length) mockPendingReads.shift()!();
    await hydrateB;

    // B's first durable row must not carry A's 06:00 enabled reminder.
    expect(leaked).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      streakDefense: false,
    });
  });
});

describe('scenario 4 — same owner signs out and back in', () => {
  it('re-arms reminders without re-prompting and without a second priming card', async () => {
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';

    setActiveDataOwner(OWNER_A);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    // The player accepted the priming card earlier: enabled + prompt dismissed.
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    const plansBefore = scheduler.appliedPlans.length;
    expect(plansBefore).toBeGreaterThan(0);
    expect(primingCardVisible()).toBe(false);

    await signOut(scheduler);
    const cancelsAfterSignOut = scheduler.cancelAllCalls;
    expect(cancelsAfterSignOut).toBeGreaterThan(0);

    setActiveDataOwner(OWNER_A);
    await useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_A });

    const state = useNotificationStore.getState();
    expect(state.ownerKey).toBe(OWNER_A);
    expect(state.prefs.enabled).toBe(true);
    expect(state.prefs.promptDismissed).toBe(true);
    expect(state.permission).toBe('granted');
    // Re-armed: a new plan was applied after the sign-out cancellation.
    expect(scheduler.appliedPlans.length).toBe(plansBefore + 1);
    expect(scheduler.appliedPlans.at(-1)!.length).toBeGreaterThan(0);
    // No system permission prompt was ever raised by hydrate.
    expect(scheduler.requestCalls).toBe(0);
    // And the priming card stays hidden.
    expect(primingCardVisible()).toBe(false);
  });

  it('extra: hydrated flag is not reset for the new owner, so the priming predicate can flip true mid-hydrate', async () => {
    // Attack on the visible-state window: after the signed-out hydrate, the
    // store says hydrated:true with DEFAULT prefs. While the returning owner's
    // KV read is in flight the predicate the priming card renders from is
    // evaluated against those defaults, not the owner's durable row.
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';
    setActiveDataOwner(OWNER_A);
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, deps(scheduler));
    await signOut(scheduler);

    setActiveDataOwner(OWNER_A);
    mockGateReads = true;
    const hydrateA = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_A });
    await flushMicrotasks();
    const visibleMidHydrate = primingCardVisible();
    mockGateReads = false;
    while (mockPendingReads.length) mockPendingReads.shift()!();
    await hydrateA;
    expect(primingCardVisible()).toBe(false);
    // A returning player who already accepted must never see the card again,
    // not even for the duration of one SQLite read.
    expect(visibleMidHydrate).toBe(false);
  });
});

describe('scenario 5 — durable row must win over a racing write', () => {
  it('final in-memory prefs equal the durable row and exactly one plan is applied', async () => {
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';

    // Owner B already has reminders on at 06:00 from a previous session.
    const durableB: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 6 * 60,
    };
    mockKvTable.set(
      notificationPrefsKeyForOwner(OWNER_B),
      JSON.stringify(durableB),
    );

    // Process launched signed-out (defaults in memory), then B signs in.
    await signOut(scheduler);
    setActiveDataOwner(OWNER_B);
    scheduler.appliedPlans.length = 0;
    scheduler.cancelAllCalls = 0;

    mockGateReads = true;
    const hydrateB = useNotificationStore
      .getState()
      .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_B });
    await flushMicrotasks();
    expect(mockPendingReads.length).toBe(1);

    // The sneaked-in write: the player flips Streak defense off from the
    // Notifications screen while the hydrate read is still queued.
    await useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler));

    mockGateReads = false;
    while (mockPendingReads.length) mockPendingReads.shift()!();
    await hydrateB;
    await flushMicrotasks();

    const inMemory = useNotificationStore.getState().prefs;
    const durable = durableRow(OWNER_B);
    expect(durable).not.toBeNull();

    // Exactly one plan is applied for the settled state.
    expect(scheduler.appliedPlans).toHaveLength(1);
    // What the screen shows must be what survives a restart.
    expect(inMemory).toEqual(durable);
    // And the player's two intents must both survive: reminders stay ON
    // (durable before) and streak defense is OFF (the write).
    expect(durable).toMatchObject({ enabled: true, streakDefense: false });
    expect(inMemory).toMatchObject({ enabled: true, streakDefense: false });
  });

  it('seeded fuzz: 64 random interleavings never let memory and durable row disagree', async () => {
    // Deterministic LCG so a failure is replayable from the seed.
    const SEED = 0x5eed_0004;
    let s = SEED;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    const mismatches: Array<{
      iteration: number;
      inMemory: unknown;
      durable: unknown;
    }> = [];

    for (let iteration = 0; iteration < 64; iteration += 1) {
      mockKvTable.clear();
      mockPendingReads.length = 0;
      resetStore();
      const scheduler = new FakeScheduler();
      scheduler.permission = 'granted';
      const durableB: NotificationPrefs = {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: rnd() < 0.7,
        promptDismissed: true,
        practiceReminderMinutes: Math.floor(rnd() * 1440),
        streakDefense: rnd() < 0.5,
        weeklyRecap: rnd() < 0.5,
      };
      mockKvTable.set(
        notificationPrefsKeyForOwner(OWNER_B),
        JSON.stringify(durableB),
      );
      await signOut(scheduler);
      setActiveDataOwner(OWNER_B);

      mockGateReads = true;
      const hydrateB = useNotificationStore
        .getState()
        .hydrate({ ...deps(scheduler), expectedOwnerKey: OWNER_B });
      await flushMicrotasks();
      const writes = 1 + Math.floor(rnd() * 3);
      for (let w = 0; w < writes; w += 1) {
        const patch: Partial<NotificationPrefs> =
          rnd() < 0.5
            ? { streakDefense: rnd() < 0.5 }
            : { practiceReminderMinutes: Math.floor(rnd() * 1440) };
        await useNotificationStore.getState().setPrefs(patch, deps(scheduler));
        if (rnd() < 0.5 && mockPendingReads.length) mockPendingReads.shift()!();
        await flushMicrotasks();
      }
      mockGateReads = false;
      while (mockPendingReads.length) mockPendingReads.shift()!();
      await hydrateB;
      await flushMicrotasks();

      const inMemory = useNotificationStore.getState().prefs;
      const durable = durableRow(OWNER_B);
      if (JSON.stringify(inMemory) !== JSON.stringify(durable)) {
        mismatches.push({ iteration, inMemory, durable });
      }
    }
    // Recorded for the evidence log; seed 0x5eed0004 replays the sequence.
    console.log(
      `[attack][seed=${SEED.toString(16)}] memory/durable mismatches: ${mismatches.length}/64`,
      JSON.stringify(mismatches.slice(0, 2)),
    );
    expect(mismatches.length).toBe(0);
  });
});
