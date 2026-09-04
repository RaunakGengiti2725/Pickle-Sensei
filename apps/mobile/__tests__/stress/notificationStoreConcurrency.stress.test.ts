import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type { PermissionState } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
  type PlannedNotification,
} from '../../src/notifications/types';
import { Interleaver } from '../../testing/stress/interleaver';
import {
  FakeKvDb,
  SQLITE_LANE,
  TrayScheduler,
  foldPatches,
  heldLoadContext,
  randomContext,
  randomPatch,
  type PrefsPatch,
} from '../../testing/stress/notificationsFixtures';
import {
  pick,
  randomInt,
  recordStress,
  seededRandom,
  stressSeeds,
} from '../../testing/stress/stressEvidence';

/**
 * CONCURRENCY stress for the notification store (STRESS lens).
 *
 * Every SQLite statement and native scheduler call is a held op; a seeded
 * Interleaver fires user actions (Promise.all bursts, duplicate calls,
 * call-during-call, disable-during-sync, owner rotation / sign-out during a
 * request, permission revoke, clock skew, injected faults) and completes the
 * held ops in seeded order until the store is quiescent. Invariants:
 *
 *   I1 no deadlock / livelock: bounded steps, every action promise settles,
 *      bounded wall time.
 *   I2 no lost update (memory): prefs == fold of the patches in call order.
 *   I3 no lost update (durable): when `persistFailed` is false the kv row
 *      equals the in-memory prefs; when it differs the flag must be raised.
 *   I4 tray reconciled: once quiescent, the OS tray holds exactly the plan
 *      for the current prefs when {owner ok, enabled, granted}, else nothing
 *      (no stale reminders after disable / revoke / logout, no duplicates).
 *   I5 no double spend: system permission prompts issued == enable requests.
 *   I6 no cross-owner write: after rotation nothing lands in the previous
 *      owner's kv row.
 *   I7 actions never reject (scheduling/persistence are best-effort).
 *
 * Replay one iteration: STRESS_SEED=<seed> npx jest notificationStoreConcurrency
 * Campaign scale:      STRESS_ITER=100 npx jest notificationStoreConcurrency
 */

const mockDbRef: { current: LocalDb | null } = { current: null };

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockDbRef.current) throw new Error('fake db not installed');
    return mockDbRef.current;
  },
}));

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';

jest.setTimeout(20 * 60 * 1000);

/** Pristine store method; each world wraps it to record the order in which
 * patches were actually applied (I2 folds that order, not enqueue order —
 * `requestPermissionAndEnable` applies its patch only after the prompt). */
const ORIGINAL_SET_PREFS = useNotificationStore.getState().setPrefs;

const SUITE = 'notificationStoreConcurrency';
const OWNER_A = '33333333-3333-4333-8333-333333333333';
const OWNER_B = '44444444-4444-4444-8444-444444444444';
const MAX_ITERATION_WALL_MS = 5000;
const MAX_STEPS = 4000;

interface World {
  seed: number;
  random: () => number;
  il: Interleaver;
  db: FakeKvDb;
  scheduler: TrayScheduler;
  context: ReturnType<typeof randomContext>;
  contextReads: number;
  rejections: string[];
  /** Patches in the order setPrefs applied them (see ORIGINAL_SET_PREFS). */
  patches: PrefsPatch[];
}

function makeWorld(seed: number): World {
  const random = seededRandom(seed);
  const il = new Interleaver(random);
  il.lane(SQLITE_LANE, 'fifo');
  il.setActionBias(0.25 + random() * 0.5);
  const db = new FakeKvDb(il);
  mockDbRef.current = db;
  const scheduler = new TrayScheduler(il);
  const world: World = {
    seed,
    random,
    il,
    db,
    scheduler,
    context: randomContext(random),
    contextReads: randomInt(random, 1, 4),
    rejections: [],
    patches: [],
  };
  useNotificationStore.setState({
    setPrefs: (patch, d) => {
      world.patches.push(patch);
      return ORIGINAL_SET_PREFS(patch, d);
    },
  });
  return world;
}

function deps(world: World) {
  return {
    scheduler: world.scheduler,
    loadContext: heldLoadContext(
      world.db,
      () => world.context,
      world.contextReads,
    ),
  };
}

function resetStore(): void {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    setPrefs: ORIGINAL_SET_PREFS,
  });
}

const PRIMED_PREFS: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
  promptDismissed: true,
};

/** I2: in-memory prefs == fold of every applied patch over the primed base. */
function memoryCheck(world: World): boolean {
  const expected = foldPatches(PRIMED_PREFS, world.patches);
  return (
    JSON.stringify(useNotificationStore.getState().prefs) ===
    JSON.stringify(expected)
  );
}

/** Enqueue an action whose rejection (never expected) is recorded. */
function act(world: World, label: string, run: () => Promise<unknown>): void {
  world.il.enqueue(label, () =>
    run().catch((error: unknown) => {
      world.rejections.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
  );
}

function burst(
  world: World,
  label: string,
  runs: Array<() => Promise<unknown>>,
): void {
  act(world, `burst(${label})x${runs.length}`, () =>
    Promise.all(runs.map(run => run())),
  );
}

async function settle(
  world: World,
): Promise<{ steps: number; wallMs: number }> {
  const started = Date.now();
  const { steps } = await world.il.drain(MAX_STEPS);
  return { steps, wallMs: Date.now() - started };
}

function schedulingAllowed(): boolean {
  const state = useNotificationStore.getState();
  const active = getActiveDataOwner();
  return (
    active !== SIGNED_OUT_DATA_OWNER &&
    state.ownerKey === active &&
    state.prefs.enabled &&
    state.permission === 'granted'
  );
}

function sortedPlan(
  items: readonly PlannedNotification[],
): PlannedNotification[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function trayCheck(world: World): {
  ok: boolean;
  expectedIds: string[];
  trayIds: string[];
  detail: string;
} {
  const state = useNotificationStore.getState();
  const expected = schedulingAllowed()
    ? sortedPlan(buildNotificationPlan(state.prefs, world.context))
    : [];
  const tray = sortedPlan([...world.scheduler.tray.values()]);
  const same = JSON.stringify(expected) === JSON.stringify(tray);
  return {
    ok: same,
    expectedIds: expected.map(item => item.id),
    trayIds: tray.map(item => item.id),
    detail: same
      ? 'tray == plan(current prefs)'
      : `tray ${JSON.stringify(tray.map(t => [t.id, t.timestampMs]))} != expected ${JSON.stringify(expected.map(t => [t.id, t.timestampMs]))}`,
  };
}

function kvCheck(
  world: World,
  owner: string,
): {
  ok: boolean;
  persistFailed: boolean;
  kvMatchesMemory: boolean;
} {
  const state = useNotificationStore.getState();
  const raw = world.db.table.get(notificationPrefsKeyForOwner(owner));
  // No row means "defaults" (that is what the next hydrate will load).
  const durable = parseNotificationPrefs(raw ?? null);
  const kvMatchesMemory =
    JSON.stringify(durable) === JSON.stringify(state.prefs);
  // I3: persistFailed=false ⇒ durable == memory. (A raised flag with a
  // matching row is allowed — a later write may have succeeded silently.)
  return {
    ok: state.persistFailed || kvMatchesMemory,
    persistFailed: state.persistFailed,
    kvMatchesMemory,
  };
}

/** Bring the store to: owner active, hydrated, permission granted, enabled. */
async function primeEnabled(world: World, owner: string): Promise<void> {
  setActiveDataOwner(owner);
  world.scheduler.permission = 'granted';
  world.db.table.set(
    notificationPrefsKeyForOwner(owner),
    JSON.stringify(PRIMED_PREFS),
  );
  act(world, 'prime.hydrate', () =>
    useNotificationStore
      .getState()
      .hydrate({ ...deps(world), expectedOwnerKey: owner }),
  );
  await settle(world);
  const state = useNotificationStore.getState();
  if (!state.hydrated || state.ownerKey !== owner || !state.prefs.enabled) {
    throw new Error(`prime failed: ${JSON.stringify(state)}`);
  }
}

interface Outcome {
  ok: boolean;
  violations: string[];
  [key: string]: unknown;
}

function verdict(checks: Record<string, boolean>): {
  ok: boolean;
  violations: string[];
} {
  const violations = Object.entries(checks)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return { ok: violations.length === 0, violations };
}

type Scenario = (world: World) => Promise<Outcome>;

const scenarios: Record<string, Scenario> = {
  /** Duplicate / overlapping setPrefs + syncNow bursts on one owner. */
  async setPrefsBurst(world) {
    await primeEnabled(world, OWNER_A);
    const actionCount = randomInt(world.random, 2, 7);
    for (let i = 0; i < actionCount; i += 1) {
      const kind = pick(world.random, [
        'set',
        'set',
        'burst',
        'sync',
        'dup',
      ] as const);
      if (kind === 'set') {
        const patch = randomPatch(world.random);
        act(world, `setPrefs#${i}`, () =>
          useNotificationStore.getState().setPrefs(patch, deps(world)),
        );
      } else if (kind === 'burst') {
        const size = randomInt(world.random, 2, 4);
        const runs: Array<() => Promise<unknown>> = [];
        for (let j = 0; j < size; j += 1) {
          const patch = randomPatch(world.random);
          runs.push(() =>
            useNotificationStore.getState().setPrefs(patch, deps(world)),
          );
        }
        burst(world, `setPrefs#${i}`, runs);
      } else if (kind === 'dup') {
        // The same patch twice in one tick — idempotency.
        const patch = randomPatch(world.random);
        burst(world, `dupSetPrefs#${i}`, [
          () => useNotificationStore.getState().setPrefs(patch, deps(world)),
          () => useNotificationStore.getState().setPrefs(patch, deps(world)),
        ]);
      } else {
        act(world, `syncNow#${i}`, () =>
          useNotificationStore.getState().syncNow(deps(world)),
        );
      }
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const memoryOk = memoryCheck(world);
    const kv = kvCheck(world, OWNER_A);
    const tray = trayCheck(world);
    return {
      ...verdict({
        'I2.memoryFold': memoryOk,
        'I3.durableMatchesMemory': kv.ok,
        'I3.persistSucceeded': !state.persistFailed,
        'I4.trayReconciled': tray.ok,
        'I4.scheduleSucceeded': !state.scheduleFailed,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      patches: world.patches.length,
      memoryOk,
      kv,
      tray,
      persistFailed: state.persistFailed,
      scheduleFailed: state.scheduleFailed,
      rejections: world.rejections,
    };
  },

  /** Enable/disable flips racing the multi-read context load: the classic
   * disable-during-sync window. */
  async enableDisableFlip(world) {
    await primeEnabled(world, OWNER_A);
    const flips = randomInt(world.random, 2, 6);
    let enableRequests = 0;
    for (let i = 0; i < flips; i += 1) {
      const kind = pick(world.random, [
        'toggle',
        'toggle',
        'request',
        'onboardEnable',
        'sync',
      ] as const);
      if (kind === 'toggle') {
        const patch: PrefsPatch = { enabled: world.random() < 0.5 };
        act(world, `toggle#${i}=${patch.enabled}`, () =>
          useNotificationStore.getState().setPrefs(patch, deps(world)),
        );
      } else if (kind === 'request') {
        enableRequests += 1;
        act(world, `requestPermissionAndEnable#${i}`, () =>
          useNotificationStore
            .getState()
            .requestPermissionAndEnable(deps(world)),
        );
      } else if (kind === 'onboardEnable') {
        enableRequests += 1;
        act(world, `completeOnboardingStep(enable)#${i}`, () =>
          useNotificationStore
            .getState()
            .completeOnboardingStep('enable', deps(world)),
        );
      } else {
        act(world, `syncNow#${i}`, () =>
          useNotificationStore.getState().syncNow(deps(world)),
        );
      }
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const memoryOk = memoryCheck(world);
    const kv = kvCheck(world, OWNER_A);
    const tray = trayCheck(world);
    const promptSpendOk = world.scheduler.requestCalls === enableRequests;
    return {
      ...verdict({
        'I2.memoryFold': memoryOk,
        'I3.durableMatchesMemory': kv.ok,
        'I4.trayReconciled': tray.ok,
        'I4.scheduleSucceeded': !state.scheduleFailed,
        'I5.promptSpend': promptSpendOk,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      memoryOk,
      kv,
      tray,
      promptSpendOk,
      requestCalls: world.scheduler.requestCalls,
      enableRequests,
      finalEnabled: state.prefs.enabled,
      rejections: world.rejections,
    };
  },

  /** Owner A is mid-request when the account rotates to B, guest, or
   * signed-out; B (or nobody) then acts. */
  async ownerRotation(world) {
    await primeEnabled(world, OWNER_A);
    const target = pick(world.random, [
      OWNER_B,
      OWNER_B,
      GUEST_DATA_OWNER,
      SIGNED_OUT_DATA_OWNER,
    ]);
    const before = randomInt(world.random, 1, 3);
    for (let i = 0; i < before; i += 1) {
      const patch = randomPatch(world.random);
      act(world, `A.setPrefs#${i}`, () =>
        useNotificationStore.getState().setPrefs(patch, deps(world)),
      );
    }
    let rotatedAtStep = -1;
    world.il.enqueue('rotate', () => {
      rotatedAtStep = world.il.trace.length;
      setActiveDataOwner(target);
    });
    act(world, 'hydrate(target)', () =>
      useNotificationStore
        .getState()
        .hydrate({ ...deps(world), expectedOwnerKey: target }),
    );
    const afterPatches: PrefsPatch[] = [];
    if (target !== SIGNED_OUT_DATA_OWNER && world.random() < 0.6) {
      const after = randomInt(world.random, 1, 2);
      for (let i = 0; i < after; i += 1) {
        const patch = randomPatch(world.random);
        afterPatches.push(patch);
        act(world, `B.setPrefs#${i}`, () =>
          useNotificationStore.getState().setPrefs(patch, deps(world)),
        );
      }
    }
    if (world.random() < 0.5) {
      act(world, 'foreground', () =>
        useNotificationStore
          .getState()
          .refreshPermission(deps(world))
          .then(() => useNotificationStore.getState().syncNow(deps(world))),
      );
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const tray = trayCheck(world);
    const ownerOk = state.ownerKey === target && state.hydrated;
    const kv =
      target === SIGNED_OUT_DATA_OWNER
        ? { ok: true, persistFailed: false, kvMatchesMemory: true }
        : kvCheck(world, target);
    // I6: nothing ISSUED after the rotation may target A's row (a write A
    // issued before rotating that lands late is A's own, and fine).
    const lateWritesToA = world.db.writes.filter(
      write =>
        write.issuedStep > rotatedAtStep &&
        write.key === notificationPrefsKeyForOwner(OWNER_A),
    );
    // Cross-owner leak: B's durable prefs should derive from B's defaults and
    // B's own patches, never from A's in-memory prefs.
    let crossOwnerLeak = false;
    if (target !== SIGNED_OUT_DATA_OWNER) {
      const raw = world.db.table.get(notificationPrefsKeyForOwner(target));
      if (raw !== undefined) {
        const durable = parseNotificationPrefs(raw);
        const expectedB = foldPatches(
          { ...DEFAULT_NOTIFICATION_PREFS },
          afterPatches,
        );
        crossOwnerLeak = JSON.stringify(durable) !== JSON.stringify(expectedB);
      }
    }
    return {
      ...verdict({
        'I4.ownerHydrated': ownerOk,
        'I4.trayReconciled': tray.ok,
        'I3.durableMatchesMemory': kv.ok,
        'I6.noLateWriteToPreviousOwner': lateWritesToA.length === 0,
        'I6.noCrossOwnerPrefsLeak': !crossOwnerLeak,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      target,
      ownerOk,
      tray,
      kv,
      lateWritesToA: lateWritesToA.length,
      crossOwnerLeak,
      afterPatches: afterPatches.length,
      rejections: world.rejections,
    };
  },

  /** Duplicate hydrate() calls (bootstrap re-renders + foreground passes)
   * with a pre-auth onboarding choice waiting in kv. */
  async hydrateStorm(world) {
    setActiveDataOwner(OWNER_A);
    world.scheduler.permission = pick(world.random, [
      'granted',
      'granted',
      'denied',
      'undetermined',
    ] as PermissionState[]);
    const hasPrefs = world.random() < 0.5;
    const storedPrefs: NotificationPrefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: world.random() < 0.6,
      promptDismissed: true,
    };
    if (hasPrefs) {
      world.db.table.set(
        notificationPrefsKeyForOwner(OWNER_A),
        JSON.stringify(storedPrefs),
      );
    }
    const pending =
      world.random() < 0.6
        ? { version: 1, enabled: world.random() < 0.6 }
        : null;
    if (pending) {
      world.db.table.set(
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
        JSON.stringify(pending),
      );
    }
    const hydrates = randomInt(world.random, 2, 4);
    const runs: Array<() => Promise<unknown>> = [];
    for (let i = 0; i < hydrates; i += 1) {
      runs.push(() =>
        useNotificationStore
          .getState()
          .hydrate({ ...deps(world), expectedOwnerKey: OWNER_A }),
      );
    }
    if (world.random() < 0.5) {
      burst(world, 'hydrate', runs);
    } else {
      runs.forEach((run, i) => act(world, `hydrate#${i}`, run));
    }
    const foregrounds = randomInt(world.random, 0, 2);
    for (let i = 0; i < foregrounds; i += 1) {
      act(world, `foreground#${i}`, () =>
        useNotificationStore
          .getState()
          .refreshPermission(deps(world))
          .then(() => useNotificationStore.getState().syncNow(deps(world))),
      );
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const expectedPrefs: NotificationPrefs = hasPrefs
      ? storedPrefs
      : pending
        ? {
            ...DEFAULT_NOTIFICATION_PREFS,
            enabled: pending.enabled,
            promptDismissed: true,
          }
        : { ...DEFAULT_NOTIFICATION_PREFS };
    const prefsOk =
      JSON.stringify(state.prefs) === JSON.stringify(expectedPrefs);
    const pendingConsumed =
      !pending ||
      (world.db.table.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) ?? '') === '';
    const durableRaw = world.db.table.get(
      notificationPrefsKeyForOwner(OWNER_A),
    );
    // A pre-auth choice must land durably (once); stored prefs stay as-is.
    const durableOk =
      hasPrefs || !pending
        ? true
        : durableRaw !== undefined &&
          JSON.stringify(parseNotificationPrefs(durableRaw)) ===
            JSON.stringify(expectedPrefs);
    const tray = trayCheck(world);
    const permissionOk = state.permission === world.scheduler.permission;
    return {
      ...verdict({
        'I4.ownerHydrated': state.hydrated && state.ownerKey === OWNER_A,
        'I2.prefsFromKvOrPending': prefsOk,
        'I5.pendingChoiceConsumedOnce': pendingConsumed,
        'I3.pendingChoicePersisted': durableOk,
        'I4.permissionFresh': permissionOk,
        'I4.trayReconciled': tray.ok,
        'I4.scheduleSucceeded': !state.scheduleFailed,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      hydrates,
      hasPrefs,
      pending,
      prefsOk,
      pendingConsumed,
      durableOk,
      permissionOk,
      tray,
      rejections: world.rejections,
    };
  },

  /** Permission revoked (and maybe re-granted) in Settings while syncs and
   * pref writes are in flight; the foreground path re-reads permission. */
  async permissionRevoke(world) {
    await primeEnabled(world, OWNER_A);
    const actions = randomInt(world.random, 2, 6);
    for (let i = 0; i < actions; i += 1) {
      const kind = pick(world.random, [
        'sync',
        'revoke',
        'revoke',
        'regrant',
        'set',
      ] as const);
      if (kind === 'sync') {
        act(world, `syncNow#${i}`, () =>
          useNotificationStore.getState().syncNow(deps(world)),
        );
      } else if (kind === 'set') {
        const patch = randomPatch(world.random);
        act(world, `setPrefs#${i}`, () =>
          useNotificationStore.getState().setPrefs(patch, deps(world)),
        );
      } else {
        const next: PermissionState = kind === 'revoke' ? 'denied' : 'granted';
        act(world, `${kind}#${i}`, () => {
          world.scheduler.permission = next;
          return useNotificationStore
            .getState()
            .refreshPermission(deps(world))
            .then(() => useNotificationStore.getState().syncNow(deps(world)));
        });
      }
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const memoryOk = memoryCheck(world);
    const permissionOk = state.permission === world.scheduler.permission;
    const tray = trayCheck(world);
    const kv = kvCheck(world, OWNER_A);
    return {
      ...verdict({
        'I2.memoryFold': memoryOk,
        'I4.permissionFresh': permissionOk,
        'I4.trayReconciled': tray.ok,
        'I3.durableMatchesMemory': kv.ok,
        'I4.scheduleSucceeded': !state.scheduleFailed,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      memoryOk,
      permissionOk,
      finalPermission: world.scheduler.permission,
      tray,
      kv,
      rejections: world.rejections,
    };
  },

  /** Clock skew: nowMs jumps forward/backward between overlapping syncs;
   * the settled tray must reflect the latest facts, never a stale clock. */
  async clockSkew(world) {
    await primeEnabled(world, OWNER_A);
    const actions = randomInt(world.random, 2, 6);
    for (let i = 0; i < actions; i += 1) {
      const skewMs = pick(world.random, [
        -2 * 60 * 60 * 1000,
        -30 * 1000,
        90 * 1000,
        3 * 60 * 60 * 1000,
        26 * 60 * 60 * 1000,
        8 * 24 * 60 * 60 * 1000,
      ]);
      act(world, `skew(${skewMs})+sync#${i}`, () => {
        world.context = {
          ...world.context,
          nowMs: world.context.nowMs + skewMs,
        };
        return useNotificationStore.getState().syncNow(deps(world));
      });
      if (world.random() < 0.4) {
        act(world, `foreground#${i}`, () =>
          useNotificationStore
            .getState()
            .refreshPermission(deps(world))
            .then(() => useNotificationStore.getState().syncNow(deps(world))),
        );
      }
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const tray = trayCheck(world);
    const leadOk = [...world.scheduler.tray.values()].every(
      item => item.timestampMs >= world.context.nowMs + 90_000,
    );
    return {
      ...verdict({
        'I4.trayReconciled': tray.ok,
        'I4.minLeadTime': leadOk,
        'I4.scheduleSucceeded': !state.scheduleFailed,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      tray,
      leadOk,
      finalNowMs: world.context.nowMs,
      rejections: world.rejections,
    };
  },

  /** Injected SQLite write failures and native apply/cancel failures under
   * concurrent writes: flags must be honest, nothing may reject or hang. */
  async faultInjection(world) {
    await primeEnabled(world, OWNER_A);
    const pWrite = world.random() * 0.5;
    const pApply = world.random() * 0.5;
    const pCancel = world.random() * 0.3;
    world.db.failWrite = () => world.random() < pWrite;
    world.scheduler.failApply = () => world.random() < pApply;
    world.scheduler.failCancel = () => world.random() < pCancel;
    const actions = randomInt(world.random, 2, 6);
    for (let i = 0; i < actions; i += 1) {
      if (world.random() < 0.7) {
        const patch = randomPatch(world.random);
        act(world, `setPrefs#${i}`, () =>
          useNotificationStore.getState().setPrefs(patch, deps(world)),
        );
      } else {
        act(world, `syncNow#${i}`, () =>
          useNotificationStore.getState().syncNow(deps(world)),
        );
      }
    }
    const { steps, wallMs } = await settle(world);
    const state = useNotificationStore.getState();
    const memoryOk = memoryCheck(world);
    const kv = kvCheck(world, OWNER_A);
    const tray = trayCheck(world);
    // With faults, the tray may legitimately be stale — but only if the
    // store admits it (scheduleFailed).
    const trayOk = tray.ok || state.scheduleFailed;
    return {
      ...verdict({
        'I2.memoryFold': memoryOk,
        'I3.durableMatchesMemoryOrFlagged': kv.ok,
        'I4.trayReconciledOrFlagged': trayOk,
        'I7.noRejections': world.rejections.length === 0,
        'I1.boundedWall': wallMs < MAX_ITERATION_WALL_MS,
      }),
      steps,
      wallMs,
      pWrite,
      pApply,
      pCancel,
      memoryOk,
      kv,
      tray,
      trayOkOrFlagged: trayOk,
      scheduleFailed: state.scheduleFailed,
      rejections: world.rejections,
    };
  },
};

beforeEach(() => {
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDbRef.current = null;
});

describe.each(Object.keys(scenarios))('%s', name => {
  it('holds I1–I7 for every seed', async () => {
    const failures: string[] = [];
    let executed = 0;
    for (const seed of stressSeeds(`${SUITE}.${name}`)) {
      resetStore();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      const world = makeWorld(seed);
      const outcome = await recordStress(SUITE, name, seed, { seed }, () =>
        scenarios[name]!(world).then(result =>
          result.ok ? result : { ...result, trace: world.il.trace },
        ),
      );
      executed += 1;
      if (!outcome.ok) {
        failures.push(`seed=${seed} ${JSON.stringify(outcome)}`);
      }
    }
    expect(executed).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
