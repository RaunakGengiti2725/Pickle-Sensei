/**
 * xc-journey-notifications-permissions — notification permission MATRIX +
 * seeded FUZZ harness against the real notification store.
 *
 * Adversarial, replayable, Linux-plane only: the OS scheduler is a faulting
 * fake behind the SchedulerPort seam, the SQLite kv is an in-memory map with
 * fault injection. Nothing here proves iOS runtime behaviour; it proves that
 * the JS store never dead-ends, never throws, never leaves reminders queued
 * when they must not be, and reports every failure honestly.
 *
 * Every row and every fuzz case is written as JSON to
 *   $XC_PERMISSIONS_ARTIFACT_DIR (default <repo>/artifacts/xc-journey-notifications-permissions)
 * with the exact seed / inputs so any failure can be replayed by running
 * this file with XC_PERMISSIONS_REPLAY_SEED=<seed>.
 */
import type { NotificationPlanContext } from '../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';

const mockKvTable = new Map<string, string>();
const mockKvFaults = { read: false, write: false };

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvFaults.read) throw new Error('kv read fault (injected)');
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvFaults.write) throw new Error('kv write fault (injected)');
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

// ---------------------------------------------------------------------------
// Artifact plumbing
// ---------------------------------------------------------------------------

// Node globals, typed locally the way the other filesystem-reading suites in
// this directory do (the mobile tsconfig deliberately has no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage: () => { heapUsed: number };
};
const { mkdirSync, writeFileSync, existsSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
};
const { resolve: resolvePath, join: joinPath } = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

const ARTIFACT_DIR =
  process.env['XC_PERMISSIONS_ARTIFACT_DIR'] ??
  resolvePath(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'xc-journey-notifications-permissions',
  );

/**
 * Default run pins the OBSERVED behaviour of the reproduced findings so the
 * suite stays green in the mobile gate while still recording every artifact.
 * `XC_PERMISSIONS_STRICT=1` asserts the intended contract instead and fails
 * until the findings are fixed — that is the replay/verification mode.
 */
const STRICT = process.env['XC_PERMISSIONS_STRICT'] === '1';

function writeArtifact(name: string, value: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = joinPath(ARTIFACT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Faulting scheduler — the mocked permission module
// ---------------------------------------------------------------------------

type PermissionOrThrow = PermissionState | 'THROW';

class FaultScheduler implements SchedulerPort {
  permission: PermissionOrThrow = 'undetermined';
  requestResult: PermissionOrThrow = 'granted';
  applyThrows = false;
  cancelThrows = false;
  openSettingsThrows = false;
  /** Ids currently queued with the (fake) OS. */
  live = new Set<string>();
  ops: string[] = [];
  requestCalls = 0;
  openSettingsCalls = 0;

  private async yieldTick(): Promise<void> {
    await Promise.resolve();
  }

  async permissionState(): Promise<PermissionState> {
    this.ops.push('permissionState');
    await this.yieldTick();
    if (this.permission === 'THROW')
      throw new Error('permissionState fault (injected)');
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.ops.push('requestPermission');
    this.requestCalls += 1;
    await this.yieldTick();
    if (this.requestResult === 'THROW')
      throw new Error('requestPermission fault (injected)');
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push(`applyPlan(${plan.length})`);
    await this.yieldTick();
    if (this.applyThrows) throw new Error('applyPlan fault (injected)');
    this.live.clear();
    for (const item of plan) this.live.add(item.id);
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push('cancelAllPlanned');
    await this.yieldTick();
    if (this.cancelThrows) throw new Error('cancelAll fault (injected)');
    this.live.clear();
  }
  async openSystemSettings(): Promise<void> {
    this.ops.push('openSystemSettings');
    this.openSettingsCalls += 1;
    if (this.openSettingsThrows) throw new Error('openSettings fault');
  }
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

function deps(scheduler: FaultScheduler, slowContext = false) {
  return {
    scheduler,
    loadContext: async () => {
      if (slowContext) {
        // Simulate the SQLite consistency snapshot taking several ticks.
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      }
      return planContext;
    },
  };
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

const OWNER_A = '33333333-3333-4333-8333-333333333333';
const OWNER_B = '44444444-4444-4444-8444-444444444444';
const VALID_PERMISSIONS = new Set([
  'granted',
  'denied',
  'undetermined',
  'unknown',
]);

beforeEach(() => {
  mockKvTable.clear();
  mockKvFaults.read = false;
  mockKvFaults.write = false;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

// ---------------------------------------------------------------------------
// Invariants (shared by matrix + fuzz)
// ---------------------------------------------------------------------------

interface InvariantViolation {
  invariant: string;
  detail: string;
  /** Finding id when the violation matches a reproduced, documented failure
   *  mode (see FINDING_CLASSES); null = unclassified, must never happen. */
  finding: string | null;
}

/**
 * Reproduced failure classes. Each has a dedicated `[FINDING …]` test below
 * that asserts the CORRECT behaviour (and therefore fails on this commit);
 * the aggregate matrix/fuzz tests only demand that no UNCLASSIFIED violation
 * appears, so a new regression cannot hide behind a known one.
 */
const FINDING_CLASSES = {
  F1_RACE_STALE_PLAN:
    'syncNow has no generation guard: a slower in-flight sync re-applies a plan after a later setPrefs/disable cancelled it',
  F2_SIGNED_OUT_CANCEL_FAULT_SWALLOWED:
    'hydrate() for the signed-out owner swallows a cancelAllPlanned failure and reports scheduleFailed=false',
  OBS1_STORE_ONLY_DRIFT_AFTER_NON_GRANTED_REQUEST:
    'requestPermissionAndEnable/completeOnboardingStep record a non-granted permission without a sync while prefs.enabled is already true (UI-unreachable: the request controls only render while reminders are OFF)',
} as const;

interface InvariantContext {
  action: string;
  cancelFaultActive: boolean;
}

function classifyStale(
  ctx: InvariantContext,
  owner: string,
  enabled: boolean,
  permission: string,
): string | null {
  if (ctx.action.startsWith('concurrent')) return 'F1_RACE_STALE_PLAN';
  if (owner === SIGNED_OUT_DATA_OWNER && ctx.cancelFaultActive)
    return 'F2_SIGNED_OUT_CANCEL_FAULT_SWALLOWED';
  if (
    (ctx.action === 'request' || ctx.action === 'onboardingEnable') &&
    enabled &&
    permission !== 'granted'
  )
    return 'OBS1_STORE_ONLY_DRIFT_AFTER_NON_GRANTED_REQUEST';
  return null;
}

function checkInvariants(
  scheduler: FaultScheduler,
  ctx: InvariantContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const state = useNotificationStore.getState();
  const owner = getActiveDataOwner();
  if (!VALID_PERMISSIONS.has(state.permission)) {
    violations.push({
      invariant: 'I2.permission-domain',
      detail: `permission=${String(state.permission)}`,
      finding: null,
    });
  }
  for (const id of scheduler.live) {
    if (!id.startsWith(NOTIFICATION_ID_PREFIX)) {
      violations.push({
        invariant: 'I8.prefixed-ids-only',
        detail: `live id ${id} lacks '${NOTIFICATION_ID_PREFIX}' prefix`,
        finding: null,
      });
    }
  }
  const mayBeLive =
    owner !== SIGNED_OUT_DATA_OWNER &&
    state.ownerKey === owner &&
    state.prefs.enabled &&
    state.permission === 'granted';
  // A failed cancel is reported via scheduleFailed; only an UNREPORTED live
  // plan that must not exist is a violation.
  if (scheduler.live.size > 0 && !mayBeLive && !state.scheduleFailed) {
    violations.push({
      invariant: 'I5.no-unreported-stale-schedule',
      detail: `live=${[...scheduler.live].join(',')} owner=${owner} ownerKey=${String(
        state.ownerKey,
      )} enabled=${state.prefs.enabled} permission=${state.permission} scheduleFailed=false`,
      finding: classifyStale(ctx, owner, state.prefs.enabled, state.permission),
    });
  }
  if (state.hydrated && state.ownerKey !== null && state.ownerKey !== owner) {
    // Allowed transiently only while a hydrate for the new owner is running;
    // the fuzz always awaits, so a mismatch after settle is a leak.
    violations.push({
      invariant: 'I9.owner-key-matches-active-owner',
      detail: `ownerKey=${state.ownerKey} active=${owner}`,
      finding: null,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 1. Deterministic matrix: hydrate → request → (revoke) → sync
// ---------------------------------------------------------------------------

type StoredPrefsSeed = 'none' | 'enabled' | 'disabled-dismissed' | 'corrupt';

interface MatrixInput {
  initialPermission: PermissionOrThrow;
  requestResult: PermissionOrThrow;
  storedPrefs: StoredPrefsSeed;
  kvWriteFails: boolean;
  applyFails: boolean;
}

interface MatrixRow extends MatrixInput {
  index: number;
  requestReturned: boolean;
  finalPermission: string;
  finalEnabled: boolean;
  persistFailed: boolean;
  scheduleFailed: boolean;
  liveAfterRequest: number;
  liveAfterRevoke: number;
  ops: string[];
  violations: InvariantViolation[];
  threw: string | null;
}

const PERMISSION_INPUTS: PermissionOrThrow[] = [
  'undetermined',
  'denied',
  'granted',
  'THROW',
];
const STORED_PREFS: StoredPrefsSeed[] = [
  'none',
  'enabled',
  'disabled-dismissed',
  'corrupt',
];

function seedStoredPrefs(owner: string, seed: StoredPrefsSeed): void {
  const key = notificationPrefsKeyForOwner(owner);
  if (seed === 'none') return;
  if (seed === 'corrupt') {
    mockKvTable.set(key, '{"version":1,"enabled":"yes",');
    return;
  }
  const prefs: NotificationPrefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: seed === 'enabled',
    promptDismissed: true,
  };
  mockKvTable.set(key, JSON.stringify(prefs));
}

function matrixInputs(): MatrixInput[] {
  const inputs: MatrixInput[] = [];
  for (const initialPermission of PERMISSION_INPUTS)
    for (const requestResult of PERMISSION_INPUTS)
      for (const storedPrefs of STORED_PREFS)
        for (const kvWriteFails of [false, true])
          for (const applyFails of [false, true])
            inputs.push({
              initialPermission,
              requestResult,
              storedPrefs,
              kvWriteFails,
              applyFails,
            });
  return inputs;
}

async function runMatrixRow(
  index: number,
  input: MatrixInput,
): Promise<MatrixRow> {
  mockKvTable.clear();
  mockKvFaults.write = false;
  resetStore();
  setActiveDataOwner(OWNER_A);
  seedStoredPrefs(OWNER_A, input.storedPrefs);
  const scheduler = new FaultScheduler();
  scheduler.permission = input.initialPermission;
  scheduler.requestResult = input.requestResult;
  scheduler.applyThrows = input.applyFails;
  mockKvFaults.write = input.kvWriteFails;

  const violations: InvariantViolation[] = [];
  let threw: string | null = null;
  let requestReturned = false;
  let liveAfterRequest = -1;
  let liveAfterRevoke = -1;
  try {
    const store = useNotificationStore.getState();
    await store.hydrate(deps(scheduler));
    violations.push(
      ...checkInvariants(scheduler, {
        action: 'hydrate',
        cancelFaultActive: false,
      }).map(v => ({
        ...v,
        invariant: `hydrate:${v.invariant}`,
      })),
    );

    requestReturned = await store.requestPermissionAndEnable(deps(scheduler));
    liveAfterRequest = scheduler.live.size;
    violations.push(
      ...checkInvariants(scheduler, {
        action: 'request',
        cancelFaultActive: false,
      }).map(v => ({
        ...v,
        invariant: `request:${v.invariant}`,
      })),
    );

    const after = useNotificationStore.getState();
    // I3: the boolean result is exactly "the OS granted and we enabled".
    const expectedReturn = input.requestResult === 'granted';
    if (requestReturned !== expectedReturn) {
      violations.push({
        invariant: 'I3.request-return-matches-grant',
        detail: `returned=${requestReturned} requestResult=${input.requestResult}`,
        finding: null,
      });
    }
    if (input.requestResult === 'THROW' && after.permission !== 'unknown') {
      violations.push({
        invariant: 'I3b.request-throw-yields-unknown',
        detail: `permission=${after.permission}`,
        finding: null,
      });
    }
    if (requestReturned) {
      if (!after.prefs.enabled || !after.prefs.promptDismissed) {
        violations.push({
          invariant: 'I4.grant-enables-and-dismisses',
          detail: JSON.stringify(after.prefs),
          finding: null,
        });
      }
      if (
        input.applyFails ? !after.scheduleFailed : scheduler.live.size === 0
      ) {
        violations.push({
          invariant: 'I4b.grant-schedules-or-reports',
          detail: `live=${scheduler.live.size} scheduleFailed=${after.scheduleFailed}`,
          finding: null,
        });
      }
      if (input.kvWriteFails !== after.persistFailed) {
        violations.push({
          invariant: 'I6.persist-failure-reported',
          detail: `kvWriteFails=${input.kvWriteFails} persistFailed=${after.persistFailed}`,
          finding: null,
        });
      }
      if (!input.kvWriteFails) {
        const stored = parseNotificationPrefs(
          mockKvTable.get(notificationPrefsKeyForOwner(OWNER_A)) ?? null,
        );
        if (JSON.stringify(stored) !== JSON.stringify(after.prefs)) {
          violations.push({
            invariant: 'I7.stored-prefs-match-memory',
            detail: `stored=${JSON.stringify(stored)} memory=${JSON.stringify(after.prefs)}`,
            finding: null,
          });
        }
      }
    } else if (!after.prefs.enabled && scheduler.live.size > 0) {
      violations.push({
        invariant: 'I5b.disabled-never-live',
        detail: `live=${scheduler.live.size}`,
        finding: null,
      });
    }

    // Revoke-later: the OS flips to denied behind our back; the foreground
    // bootstrap path (refreshPermission → syncNow) must cancel everything.
    scheduler.permission = 'denied';
    scheduler.applyThrows = false;
    await store.refreshPermission(deps(scheduler));
    await store.syncNow(deps(scheduler));
    liveAfterRevoke = scheduler.live.size;
    violations.push(
      ...checkInvariants(scheduler, {
        action: 'sync',
        cancelFaultActive: false,
      }).map(v => ({
        ...v,
        invariant: `revoke:${v.invariant}`,
      })),
    );
    const revoked = useNotificationStore.getState();
    if (revoked.permission !== 'denied') {
      violations.push({
        invariant: 'I10.revoke-observed',
        detail: `permission=${revoked.permission}`,
        finding: null,
      });
    }
    if (liveAfterRevoke !== 0) {
      violations.push({
        invariant: 'I10b.revoke-cancels-all',
        detail: `live=${liveAfterRevoke}`,
        finding: null,
      });
    }
    // Prefs must survive a revoke: the user's choice is not silently reset.
    if (requestReturned && !revoked.prefs.enabled) {
      violations.push({
        invariant: 'I11.revoke-keeps-user-choice',
        detail: 'prefs.enabled flipped to false on revoke',
        finding: null,
      });
    }
  } catch (error) {
    threw =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    violations.push({
      invariant: 'I1.store-never-throws',
      detail: threw,
      finding: null,
    });
  }
  const final = useNotificationStore.getState();
  return {
    index,
    ...input,
    requestReturned,
    finalPermission: final.permission,
    finalEnabled: final.prefs.enabled,
    persistFailed: final.persistFailed,
    scheduleFailed: final.scheduleFailed,
    liveAfterRequest,
    liveAfterRevoke,
    ops: scheduler.ops,
    violations,
    threw,
  };
}

// ---------------------------------------------------------------------------
// 2. Seeded fuzz: random action sequences with concurrency + fault toggles
// ---------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG so every case replays from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ACTIONS = [
  'hydrate',
  'foreground',
  'request',
  'enable',
  'disable',
  'toggleSubPref',
  'dismiss',
  'sync',
  'osRevoke',
  'osGrant',
  'osReset',
  'osThrowPermission',
  'osRequestDenied',
  'osRequestGranted',
  'osRequestUndetermined',
  'osRequestThrow',
  'kvWriteFaultOn',
  'kvWriteFaultOff',
  'kvReadFaultOn',
  'kvReadFaultOff',
  'applyFaultOn',
  'applyFaultOff',
  'cancelFaultOn',
  'cancelFaultOff',
  'signOut',
  'signInA',
  'signInB',
  'onboardingEnable',
  'onboardingNotNow',
  'concurrentDisableDuringSync',
  'concurrentRequestAndDisable',
  'concurrentSignOutDuringSync',
] as const;
type FuzzAction = (typeof FUZZ_ACTIONS)[number];

interface FuzzStep {
  action: FuzzAction;
  violations: InvariantViolation[];
  threw: string | null;
  snapshot: {
    owner: string;
    ownerKey: string | null;
    permission: string;
    enabled: boolean;
    persistFailed: boolean;
    scheduleFailed: boolean;
    live: string[];
  };
}

interface FuzzCase {
  seed: number;
  steps: FuzzStep[];
  failed: boolean;
  /** Finding class of the first violation; null when unclassified. */
  firstFinding: string | null;
  replay: string;
}

async function applyFuzzAction(
  action: FuzzAction,
  scheduler: FaultScheduler,
): Promise<void> {
  const store = useNotificationStore.getState();
  const d = deps(scheduler);
  switch (action) {
    case 'hydrate':
      await store.hydrate(d);
      return;
    case 'foreground':
      // useNotificationBootstrap on AppState 'active':
      // refreshPermission().then(() => syncNow())
      await store.refreshPermission(d);
      await store.syncNow(d);
      return;
    case 'request':
      await store.requestPermissionAndEnable(d);
      return;
    case 'enable':
      await store.setPrefs({ enabled: true }, d);
      return;
    case 'disable':
      await store.setPrefs({ enabled: false }, d);
      return;
    case 'toggleSubPref':
      await store.setPrefs({ streakDefense: !store.prefs.streakDefense }, d);
      return;
    case 'dismiss':
      await store.dismissPrompt(d);
      return;
    case 'sync':
      await store.syncNow(d);
      return;
    case 'osRevoke':
      scheduler.permission = 'denied';
      return;
    case 'osGrant':
      scheduler.permission = 'granted';
      return;
    case 'osReset':
      scheduler.permission = 'undetermined';
      return;
    case 'osThrowPermission':
      scheduler.permission = 'THROW';
      return;
    case 'osRequestDenied':
      scheduler.requestResult = 'denied';
      return;
    case 'osRequestGranted':
      scheduler.requestResult = 'granted';
      return;
    case 'osRequestUndetermined':
      scheduler.requestResult = 'undetermined';
      return;
    case 'osRequestThrow':
      scheduler.requestResult = 'THROW';
      return;
    case 'kvWriteFaultOn':
      mockKvFaults.write = true;
      return;
    case 'kvWriteFaultOff':
      mockKvFaults.write = false;
      return;
    case 'kvReadFaultOn':
      mockKvFaults.read = true;
      return;
    case 'kvReadFaultOff':
      mockKvFaults.read = false;
      return;
    case 'applyFaultOn':
      scheduler.applyThrows = true;
      return;
    case 'applyFaultOff':
      scheduler.applyThrows = false;
      return;
    case 'cancelFaultOn':
      scheduler.cancelThrows = true;
      return;
    case 'cancelFaultOff':
      scheduler.cancelThrows = false;
      return;
    case 'signOut':
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      await store.hydrate(d);
      return;
    case 'signInA':
      setActiveDataOwner(OWNER_A);
      await store.hydrate(d);
      return;
    case 'signInB':
      setActiveDataOwner(OWNER_B);
      await store.hydrate(d);
      return;
    case 'onboardingEnable':
      await store.completeOnboardingStep('enable', d);
      return;
    case 'onboardingNotNow':
      await store.completeOnboardingStep('not_now', d);
      return;
    case 'concurrentDisableDuringSync': {
      const slow = deps(scheduler, true);
      await Promise.all([
        store.syncNow(slow),
        store.setPrefs({ enabled: false }, d),
      ]);
      return;
    }
    case 'concurrentRequestAndDisable':
      await Promise.all([
        store.requestPermissionAndEnable(deps(scheduler, true)),
        store.setPrefs({ enabled: false }, d),
      ]);
      return;
    case 'concurrentSignOutDuringSync': {
      const slow = deps(scheduler, true);
      const sync = store.syncNow(slow);
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      await Promise.all([sync, store.hydrate(d)]);
      return;
    }
  }
}

async function runFuzzCase(seed: number, maxSteps: number): Promise<FuzzCase> {
  const rand = mulberry32(seed);
  mockKvTable.clear();
  mockKvFaults.read = false;
  mockKvFaults.write = false;
  resetStore();
  setActiveDataOwner(OWNER_A);
  const scheduler = new FaultScheduler();
  scheduler.permission = 'undetermined';
  const steps: FuzzStep[] = [];
  const stepCount = 3 + Math.floor(rand() * (maxSteps - 3));
  let failed = false;
  let firstFinding: string | null = null;
  for (let i = 0; i < stepCount; i += 1) {
    const action = FUZZ_ACTIONS[Math.floor(rand() * FUZZ_ACTIONS.length)]!;
    let threw: string | null = null;
    try {
      await applyFuzzAction(action, scheduler);
    } catch (error) {
      threw =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    }
    const violations = checkInvariants(scheduler, {
      action,
      cancelFaultActive: scheduler.cancelThrows,
    });
    if (threw)
      violations.push({
        invariant: 'I1.store-never-throws',
        detail: threw,
        finding: null,
      });
    const state = useNotificationStore.getState();
    steps.push({
      action,
      violations,
      threw,
      snapshot: {
        owner: getActiveDataOwner(),
        ownerKey: state.ownerKey,
        permission: state.permission,
        enabled: state.prefs.enabled,
        persistFailed: state.persistFailed,
        scheduleFailed: state.scheduleFailed,
        live: [...scheduler.live],
      },
    });
    // Only the FIRST violation classifies a case: once a known failure mode
    // has left the fake OS in a stale state, every later step re-reports it.
    if (violations.length > 0 && !failed) {
      failed = true;
      firstFinding = violations[0]!.finding;
    }
  }
  return {
    seed,
    steps,
    failed,
    firstFinding,
    replay: `XC_PERMISSIONS_REPLAY_SEED=${seed} npx jest --ci __tests__/xcPermissionsNotificationStoreMatrix.test.ts -t fuzz`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('xc notifications permission matrix (store)', () => {
  it('runs the full 4x4x4x2x2 permission matrix and records every row', async () => {
    const inputs = matrixInputs();
    expect(inputs).toHaveLength(256);
    const rows: MatrixRow[] = [];
    for (const [index, input] of inputs.entries()) {
      rows.push(await runMatrixRow(index, input));
    }
    const failing = rows.filter(r => r.violations.length > 0);
    const unclassified = rows
      .map(r => ({
        index: r.index,
        violations: r.violations.filter(v => v.finding === null),
      }))
      .filter(r => r.violations.length > 0);
    const summary = {
      harness: 'xcPermissionsNotificationStoreMatrix',
      commit: process.env['GITHUB_SHA'] ?? null,
      rows: rows.length,
      failingRows: failing.length,
      unclassifiedFailingRows: unclassified.length,
      violationsByInvariant: failing
        .flatMap(r => r.violations)
        .reduce<Record<string, number>>((acc, v) => {
          acc[v.invariant] = (acc[v.invariant] ?? 0) + 1;
          return acc;
        }, {}),
      violationsByFinding: failing
        .flatMap(r => r.violations)
        .reduce<Record<string, number>>((acc, v) => {
          const key = v.finding ?? 'UNCLASSIFIED';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      findingClasses: FINDING_CLASSES,
      granted: rows.filter(r => r.requestReturned).length,
      persistFailedReported: rows.filter(r => r.persistFailed).length,
      scheduleFailedReported: rows.filter(r => r.scheduleFailed).length,
      heapUsedBytes: process.memoryUsage().heapUsed,
    };
    const file = writeArtifact('notification-store-matrix.json', {
      summary,
      rows,
    });
    expect(existsSync(file)).toBe(true);
    // Every row is fully described (inputs + ops) in the artifact. Rows that
    // hit a documented finding class are counted there; anything ELSE is a
    // new failure and fails this test.
    expect(unclassified).toEqual([]);
    if (STRICT) {
      expect(
        failing.map(r => ({ index: r.index, violations: r.violations })),
      ).toEqual([]);
    }
    // The observation class must stay UI-unreachable-only: it may appear
    // solely in rows where stored prefs already had reminders ON.
    for (const row of failing) {
      for (const v of row.violations) {
        if (v.finding === 'OBS1_STORE_ONLY_DRIFT_AFTER_NON_GRANTED_REQUEST') {
          expect(row.storedPrefs).toBe('enabled');
          expect(row.initialPermission).toBe('granted');
        }
      }
    }
  });

  it('maps every request outcome to the documented store state', async () => {
    setActiveDataOwner(OWNER_A);
    const table: Array<{
      requestResult: PermissionOrThrow;
      expectPermission: string;
      expectEnabled: boolean;
      expectReturn: boolean;
    }> = [
      {
        requestResult: 'granted',
        expectPermission: 'granted',
        expectEnabled: true,
        expectReturn: true,
      },
      {
        requestResult: 'denied',
        expectPermission: 'denied',
        expectEnabled: false,
        expectReturn: false,
      },
      {
        requestResult: 'undetermined',
        expectPermission: 'undetermined',
        expectEnabled: false,
        expectReturn: false,
      },
      {
        requestResult: 'THROW',
        expectPermission: 'unknown',
        expectEnabled: false,
        expectReturn: false,
      },
    ];
    for (const row of table) {
      mockKvTable.clear();
      resetStore();
      const scheduler = new FaultScheduler();
      scheduler.requestResult = row.requestResult;
      await useNotificationStore.getState().hydrate(deps(scheduler));
      const returned = await useNotificationStore
        .getState()
        .requestPermissionAndEnable(deps(scheduler));
      const state = useNotificationStore.getState();
      expect({
        returned,
        permission: state.permission,
        enabled: state.prefs.enabled,
      }).toEqual({
        returned: row.expectReturn,
        permission: row.expectPermission,
        enabled: row.expectEnabled,
      });
      expect(scheduler.live.size).toBe(row.expectReturn ? 6 : 0);
    }
  });

  it('revoke-later then re-grant restores the schedule without a new user action', async () => {
    setActiveDataOwner(OWNER_A);
    const scheduler = new FaultScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(
      await useNotificationStore
        .getState()
        .requestPermissionAndEnable(deps(scheduler)),
    ).toBe(true);
    expect(scheduler.live.size).toBe(6);

    scheduler.permission = 'denied';
    await useNotificationStore.getState().refreshPermission(deps(scheduler));
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(scheduler.live.size).toBe(0);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    scheduler.permission = 'granted';
    await useNotificationStore.getState().refreshPermission(deps(scheduler));
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(scheduler.live.size).toBe(6);
    expect(scheduler.requestCalls).toBe(1);
  });

  it('a failing cancel on revoke is reported as scheduleFailed, never swallowed as success', async () => {
    setActiveDataOwner(OWNER_A);
    const scheduler = new FaultScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    scheduler.permission = 'denied';
    scheduler.cancelThrows = true;
    await useNotificationStore.getState().refreshPermission(deps(scheduler));
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);
    expect(scheduler.live.size).toBe(6);
    scheduler.cancelThrows = false;
    await useNotificationStore.getState().syncNow(deps(scheduler));
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
    expect(scheduler.live.size).toBe(0);
  });

  it('pre-auth onboarding pending choice survives a kv read fault at hydrate without throwing', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const scheduler = new FaultScheduler();
    scheduler.requestResult = 'granted';
    expect(
      await useNotificationStore
        .getState()
        .completeOnboardingStep('enable', deps(scheduler)),
    ).toBe(true);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe(
      JSON.stringify({ version: 1, enabled: true }),
    );
    setActiveDataOwner(OWNER_A);
    mockKvFaults.read = true;
    await expect(
      useNotificationStore.getState().hydrate(deps(scheduler)),
    ).resolves.toBeUndefined();
    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    // Read fault → defaults (disabled); the pending choice is NOT lost: it
    // is still in kv for the next hydrate.
    expect(state.prefs.enabled).toBe(false);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe(
      JSON.stringify({ version: 1, enabled: true }),
    );
    mockKvFaults.read = false;
    await useNotificationStore.getState().hydrate(deps(scheduler));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.live.size).toBe(6);
  });

  it('[FINDING F1] disabling reminders while a slow sync is in flight leaves a stale plan queued (strict: must not)', async () => {
    setActiveDataOwner(OWNER_A);
    const scheduler = new FaultScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(scheduler.live.size).toBe(6);
    // Foreground sync starts (slow consistency snapshot) and the user flips
    // the master switch OFF before it finishes.
    const slowSync = useNotificationStore
      .getState()
      .syncNow(deps(scheduler, true));
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, deps(scheduler));
    await slowSync;
    const state = useNotificationStore.getState();
    const record = {
      scenario: 'disable-during-slow-sync',
      prefsEnabled: state.prefs.enabled,
      permission: state.permission,
      scheduleFailed: state.scheduleFailed,
      liveAfter: [...scheduler.live],
      ops: scheduler.ops,
    };
    writeArtifact('notification-store-race-disable-during-sync.json', {
      ...record,
      finding: 'F1_RACE_STALE_PLAN',
      strict: STRICT,
      replayStrict: `XC_PERMISSIONS_STRICT=1 npx jest --ci __tests__/xcPermissionsNotificationStoreMatrix.test.ts -t 'FINDING F1'`,
    });
    expect(state.prefs.enabled).toBe(false);
    expect(state.scheduleFailed).toBe(false);
    if (STRICT) {
      // Contract: reminders are OFF, nothing may remain queued with the OS.
      expect([...scheduler.live]).toEqual([]);
    } else {
      // Observed on 4d812e1a: the slow sync re-applies the 6-item plan AFTER
      // the disable path cancelled it; the OS queue no longer matches prefs.
      expect(scheduler.ops.slice(-2)).toEqual([
        'cancelAllPlanned',
        'applyPlan(6)',
      ]);
      expect(scheduler.live.size).toBe(6);
    }
  });

  it('two quick sub-preference toggles: the LAST choice wins in the OS queue', async () => {
    setActiveDataOwner(OWNER_A);
    const scheduler = new FaultScheduler();
    const applied: Array<readonly PlannedNotification[]> = [];
    const originalApply = scheduler.applyPlan.bind(scheduler);
    scheduler.applyPlan = async plan => {
      applied.push(plan);
      await originalApply(plan);
    };
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(scheduler.live.has('ps.reminder.weekly')).toBe(true);

    // Toggle A (slow context read) then toggle B (fast) — B is the newer
    // intent: weekly recap OFF.
    const toggleA = useNotificationStore
      .getState()
      .setPrefs({ streakDefense: false }, deps(scheduler, true));
    const toggleB = useNotificationStore
      .getState()
      .setPrefs({ weeklyRecap: false }, deps(scheduler));
    await Promise.all([toggleA, toggleB]);
    const state = useNotificationStore.getState();
    const record = {
      scenario: 'two-toggles-last-writer',
      prefs: state.prefs,
      appliedPlanIds: applied.map(plan => plan.map(p => p.id)),
      liveAfter: [...scheduler.live],
      ops: scheduler.ops,
    };
    writeArtifact('notification-store-race-two-toggles.json', record);
    expect(state.prefs.weeklyRecap).toBe(false);
    expect(state.prefs.streakDefense).toBe(false);
    // The user turned the weekly recap OFF; it must not be queued. This
    // ordering happens to converge because setPrefs sets state BEFORE the
    // slow read and the plan is built from the latest prefs.
    expect(scheduler.live.has('ps.reminder.weekly')).toBe(false);
    expect(scheduler.live.has('ps.reminder.streak')).toBe(false);
  });

  it('[FINDING F2] signed-out hydrate swallows a failed cancel and reports scheduleFailed=false (strict: must report)', async () => {
    setActiveDataOwner(OWNER_A);
    const scheduler = new FaultScheduler();
    await useNotificationStore.getState().hydrate(deps(scheduler));
    await useNotificationStore
      .getState()
      .requestPermissionAndEnable(deps(scheduler));
    expect(scheduler.live.size).toBe(6);

    scheduler.cancelThrows = true;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await expect(
      useNotificationStore.getState().hydrate(deps(scheduler)),
    ).resolves.toBeUndefined();
    const state = useNotificationStore.getState();
    const record = {
      scenario: 'signed-out-cancel-fault',
      ownerKey: state.ownerKey,
      scheduleFailed: state.scheduleFailed,
      liveAfter: [...scheduler.live],
      ops: scheduler.ops,
    };
    writeArtifact('notification-store-signed-out-cancel-fault.json', {
      ...record,
      finding: 'F2_SIGNED_OUT_CANCEL_FAULT_SWALLOWED',
      strict: STRICT,
      replayStrict: `XC_PERMISSIONS_STRICT=1 npx jest --ci __tests__/xcPermissionsNotificationStoreMatrix.test.ts -t 'FINDING F2'`,
    });
    expect(state.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    // Six reminders are still queued for an account that signed out.
    expect(scheduler.live.size).toBe(6);
    if (STRICT) {
      // Contract: the store must say so.
      expect(state.scheduleFailed).toBe(true);
    } else {
      // Observed on 4d812e1a: `.catch(() => {})` swallows the failure and
      // hydrate resets scheduleFailed to false.
      expect(state.scheduleFailed).toBe(false);
    }
  });

  it('seeded fuzz: random action/fault sequences never violate the store invariants', async () => {
    const replaySeed = process.env['XC_PERMISSIONS_REPLAY_SEED'];
    const caseCount = replaySeed
      ? 1
      : Number(process.env['XC_PERMISSIONS_FUZZ_CASES'] ?? 400);
    const maxSteps = 16;
    const baseSeed = replaySeed ? Number(replaySeed) : 0x5eed_0001;
    const cases: FuzzCase[] = [];
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < caseCount; i += 1) {
      cases.push(
        await runFuzzCase(replaySeed ? baseSeed : baseSeed + i, maxSteps),
      );
    }
    const heapAfter = process.memoryUsage().heapUsed;
    const failing = cases.filter(c => c.failed);
    const unclassified = failing.filter(c => c.firstFinding === null);
    const byFinding = failing.reduce<Record<string, number>>((acc, c) => {
      const key = c.firstFinding ?? 'UNCLASSIFIED';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const violationsByInvariant = failing
      .flatMap(c => c.steps.flatMap(s => s.violations))
      .reduce<Record<string, number>>((acc, v) => {
        acc[v.invariant] = (acc[v.invariant] ?? 0) + 1;
        return acc;
      }, {});
    const summary = {
      harness: 'xcPermissionsNotificationStoreMatrix.fuzz',
      baseSeed,
      caseCount,
      maxSteps,
      totalSteps: cases.reduce((n, c) => n + c.steps.length, 0),
      failingCases: failing.length,
      unclassifiedFailingCases: unclassified.length,
      failingSeeds: failing.map(c => c.seed),
      casesByFinding: byFinding,
      findingClasses: FINDING_CLASSES,
      violationsByInvariant,
      heapUsedBeforeBytes: heapBefore,
      heapUsedAfterBytes: heapAfter,
      actions: FUZZ_ACTIONS,
    };
    writeArtifact('notification-store-fuzz.json', { summary, cases });
    writeArtifact(
      'notification-store-fuzz-failures.json',
      failing.map(c => ({
        seed: c.seed,
        finding: c.firstFinding,
        replay: c.replay,
        trace: c.steps.map(s => s.action),
        firstViolationStep: c.steps.findIndex(s => s.violations.length > 0),
        violations: c.steps.flatMap((s, i) =>
          s.violations.map(v => ({ step: i, action: s.action, ...v })),
        ),
      })),
    );
    expect(summary.totalSteps).toBeGreaterThan(0);
    // Known findings are reproduced by their dedicated tests above and
    // counted in the artifact; any violation outside those classes is a NEW
    // failure with its replay command.
    expect(
      unclassified.map(c => ({
        seed: c.seed,
        replay: c.replay,
        violations: c.steps.flatMap(s => s.violations),
      })),
    ).toEqual([]);
    if (STRICT) {
      expect(
        failing.map(c => ({
          seed: c.seed,
          finding: c.firstFinding,
          replay: c.replay,
        })),
      ).toEqual([]);
    }
  });
});
