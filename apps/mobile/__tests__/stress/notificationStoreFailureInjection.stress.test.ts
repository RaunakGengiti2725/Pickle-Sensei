/**
 * FAILURE-INJECTION campaign — notificationStore against every dependency
 * it has: SQLite kv (reads + writes), the OS scheduler (permission read,
 * permission prompt, apply, cancel), the training-facts context loader
 * (both the injected `deps.loadContext` and the default consistency
 * snapshot path), the clock, and the account owner.
 *
 * Each seed generates a replayable scenario (owner, wall clock, what is on
 * disk, OS permission, 2–7 user/system actions) and a per-call fault draw
 * (throw / reject / timeout / slow / never / malformed / partial). After
 * every action the store must be in an HONEST, RECOVERABLE state:
 *
 *   settled-or-never        an action only fails to settle within 60 s of
 *                           fake time when a dependency literally never
 *                           resolves (no hidden deadlock)
 *   state-shape             prefs/permission stay inside their types
 *   no-fake-permission      `granted` is only ever what the OS reported
 *   persist-flag-truthful   persistFailed mirrors whether the last prefs
 *                           write actually landed
 *   schedule-flag-truthful  scheduleFailed mirrors the last reconcile
 *   persisted-integrity     nothing the store writes is un-parseable, mis-
 *                           owned or written while signed out
 *   plan-sanity             every plan handed to the OS: `ps.` ids, unique,
 *                           valid screens, finite timestamps ≥ 90 s lead,
 *                           equal to buildNotificationPlan(prefs, facts)
 *   foreign-intact          reminders owned by other libraries untouched
 *   queue-matches-state     with scheduleFailed clear, the OS queue is
 *                           exactly what the preferences call for
 *   memory-disk-coherent    with persistFailed clear, in-memory prefs equal
 *                           the parsed on-disk prefs
 *   recovered               once faults lift, one foreground pass + one
 *                           settings change fully heals every flag/queue
 *
 * Scale:   STRESS_ITER=<n>   iterations (default 48)
 * Replay:  STRESS_ONLY=<seed>[,<seed>...]
 * Output:  STRESS_OUT=<dir>  JSON table (default apps/mobile/artifacts/stress/notifications)
 */
import type { NotificationPlanContext } from '../../src/notifications/plan';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type { PermissionState } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
  type PlannedNotification,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { SeededRng } from '../../test-support/stress/notifications/seededRng';
import {
  FaultJournal,
  runFault,
  settleWithin,
  type FaultMode,
} from '../../test-support/stress/notifications/faults';
import { FaultKv } from '../../test-support/stress/notifications/faultKv';
import { FaultScheduler } from '../../test-support/stress/notifications/faultScheduler';
import {
  CHAINED_DEPENDENCY_BUDGET_MS,
  NO_SPINNER_BUDGET_MS,
  campaignSeeds,
  describeCampaignFailure,
  knownFindingIds,
  makeFaultContextLoader,
  planDefects,
  randomContext,
  replayCommand,
  summarizeRows,
  unexplainedViolations,
  writeResultTable,
  type IterationRow,
  type Violation,
} from '../../test-support/stress/notifications/campaign';

let mockKv: FaultKv;
let mockScheduler: FaultScheduler;
let mockConsistency: () => Promise<unknown>;

jest.mock('../../src/data/db', () => ({ getDb: () => mockKv }));
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: () => mockConsistency(),
}));

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';

const SUITE = 'notificationStoreFailureInjection';
const UUID_OWNER = '77777777-7777-4777-8777-777777777777';
const OTHER_UUID_OWNER = '88888888-8888-4888-8888-888888888888';

type Patch = Partial<Omit<NotificationPrefs, 'version'>>;

type Action =
  | { kind: 'hydrate' }
  | { kind: 'setPrefs'; patch: Patch }
  | { kind: 'requestEnable' }
  | { kind: 'onboarding'; choice: 'enable' | 'not_now' }
  | { kind: 'dismiss' }
  | { kind: 'syncNow' }
  | { kind: 'refresh' }
  | { kind: 'foreground' }
  | { kind: 'switchOwner'; owner: string }
  | { kind: 'osPermission'; permission: PermissionState }
  | { kind: 'burst'; patches: Patch[] };

interface Scenario {
  owner: string;
  clockIso: string;
  storedRaw: string | null;
  pendingRaw: string | null;
  osPermission: PermissionState;
  promptOutcome: PermissionState;
  actions: string[];
}

const STORED_MALFORMED = [
  'not json',
  '{"enabled":true,',
  'null',
  '[]',
  '"enabled"',
  '{"version":9,"enabled":"true","practiceReminderMinutes":"18:00"}',
  '{"enabled":true,"practiceReminderMinutes":1440}',
  '{"enabled":true,"practiceReminderMinutes":-30,"streakDefense":1}',
  '{"enabled":true,"practiceReminderMinutes":17.5}',
  '{"enabled":true,"practiceReminderMinutes":1e309}',
  '{"__proto__":{"enabled":true},"enabled":true}',
  '{"enabled":true}'.repeat(2),
  '',
  '{}',
];

const PENDING_MALFORMED = [
  '{"version":1}',
  '{"version":2,"enabled":true}',
  '{"enabled":"true","version":1}',
  '[1]',
  'x',
];

function randomPrefs(rng: SeededRng): NotificationPrefs {
  return {
    version: 1,
    enabled: rng.chance(0.7),
    practiceReminder: rng.chance(0.7),
    practiceReminderMinutes: rng.int(0, 47) * 30,
    streakDefense: rng.chance(0.6),
    weeklyRecap: rng.chance(0.6),
    comeback: rng.chance(0.6),
    promptDismissed: rng.chance(0.5),
  };
}

function randomPatch(rng: SeededRng): Patch {
  const patch: Patch = {};
  const keys: Array<keyof Patch> = [
    'enabled',
    'practiceReminder',
    'practiceReminderMinutes',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ];
  for (const key of rng.shuffle(keys).slice(0, rng.int(1, 3))) {
    if (key === 'practiceReminderMinutes') {
      patch[key] = rng.int(0, 47) * 30;
    } else {
      patch[key] = rng.chance(0.5);
    }
  }
  return patch;
}

function randomClockMs(rng: SeededRng): number {
  const day = new Date(2025, 0, 1, 12, 0, 0, 0);
  day.setDate(day.getDate() + rng.int(0, 1095));
  const minutes = rng.weighted<number>([
    [rng.int(0, 1439), 5],
    [19 * 60 + 28 + rng.int(0, 4), 2], // around the 19:30 streak slot
    [18 * 60 + rng.int(0, 2), 1], // weekly recap 18:00
    [23 * 60 + 59, 1],
    [0, 1],
  ]);
  day.setHours(Math.floor(minutes / 60), minutes % 60, rng.int(0, 59), 0);
  return day.getTime();
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'setPrefs':
      return `setPrefs(${JSON.stringify(action.patch)})`;
    case 'onboarding':
      return `onboarding(${action.choice})`;
    case 'switchOwner':
      return `switchOwner(${action.owner})`;
    case 'osPermission':
      return `osPermission(${action.permission})`;
    case 'burst':
      return `burst(${action.patches.map(p => JSON.stringify(p)).join(' | ')})`;
    default:
      return action.kind;
  }
}

function randomAction(rng: SeededRng, owner: string): Action {
  return rng.weighted<Action>([
    [{ kind: 'hydrate' }, 2],
    [{ kind: 'setPrefs', patch: randomPatch(rng) }, 5],
    [{ kind: 'requestEnable' }, 3],
    [{ kind: 'onboarding', choice: rng.chance(0.6) ? 'enable' : 'not_now' }, 1],
    [{ kind: 'dismiss' }, 1],
    [{ kind: 'syncNow' }, 2],
    [{ kind: 'refresh' }, 1],
    [{ kind: 'foreground' }, 3],
    [
      {
        kind: 'switchOwner',
        owner: rng.pick(
          [
            GUEST_DATA_OWNER,
            UUID_OWNER,
            OTHER_UUID_OWNER,
            SIGNED_OUT_DATA_OWNER,
          ].filter(candidate => candidate !== owner),
        ),
      },
      1,
    ],
    [
      {
        kind: 'osPermission',
        permission: rng.pick<PermissionState>([
          'granted',
          'denied',
          'undetermined',
        ]),
      },
      1,
    ],
    [
      {
        kind: 'burst',
        patches: Array.from({ length: rng.int(2, 3) }, () => randomPatch(rng)),
      },
      1,
    ],
  ]);
}

const KV_MODES: readonly FaultMode[] = [
  'throw',
  'reject',
  'timeout',
  'slow',
  'never',
  'malformed',
  'partial',
];
const CONTEXT_MODES: readonly FaultMode[] = KV_MODES;
const PERMISSION_READ_MODES: readonly FaultMode[] = [
  'reject',
  'timeout',
  'slow',
  'never',
];
const PERMISSION_REQUEST_MODES: readonly FaultMode[] = [
  'reject',
  'timeout',
  'slow',
  'never',
  'partial',
];
const SCHEDULE_MODES: readonly FaultMode[] = PERMISSION_REQUEST_MODES;

function drawMode(rng: SeededRng, modes: readonly FaultMode[]): FaultMode {
  if (rng.chance(0.55)) return 'ok';
  const mode = rng.pick(modes);
  // `never` hangs the rest of the action; keep it rarer than the others so
  // most iterations still exercise the recovery path.
  if (mode === 'never' && rng.chance(0.5))
    return rng.pick(modes.filter(m => m !== 'never'));
  return mode;
}

interface ContextEvent {
  atMs: number;
  mode: FaultMode;
  /** `injected` = deps.loadContext (failures propagate to the sync);
   *  `default` = defaultLoadContext → consistency snapshot (degrades). */
  source: 'injected' | 'default';
  /** Facts the planner ended up with (null when the loader failed). */
  context: NotificationPlanContext | null;
}

function samePlan(
  actual: readonly PlannedNotification[],
  expected: readonly PlannedNotification[],
): boolean {
  const key = (item: PlannedNotification) =>
    `${item.id}|${item.timestampMs}|${item.repeat}|${item.screen}`;
  const a = actual.map(key).sort();
  const b = expected.map(key).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function validPermission(value: unknown): boolean {
  return (
    value === 'granted' ||
    value === 'denied' ||
    value === 'undetermined' ||
    value === 'unknown'
  );
}

function prefsShapeDefects(prefs: NotificationPrefs): string[] {
  const defects: string[] = [];
  if (prefs.version !== 1) defects.push(`version=${String(prefs.version)}`);
  for (const key of [
    'enabled',
    'practiceReminder',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ] as const) {
    if (typeof prefs[key] !== 'boolean')
      defects.push(`${key}=${String(prefs[key])}`);
  }
  const m = prefs.practiceReminderMinutes;
  if (!Number.isInteger(m) || m < 0 || m >= 1440)
    defects.push(`minutes=${String(m)}`);
  return defects;
}

const rows: IterationRow<Scenario>[] = [];

afterAll(() => {
  if (rows.length === 0) return;
  const summary = summarizeRows(SUITE, rows);
  writeResultTable(`${SUITE}.json`, summary);
});

async function runIteration(seed: number): Promise<IterationRow<Scenario>> {
  const rng = new SeededRng(seed);
  const journal = new FaultJournal();
  mockKv = new FaultKv(journal, rng);
  mockScheduler = new FaultScheduler(journal, rng);

  // ---- scenario -----------------------------------------------------------
  const owner = rng.weighted<string>([
    [GUEST_DATA_OWNER, 3],
    [UUID_OWNER, 5],
    [SIGNED_OUT_DATA_OWNER, 1],
  ]);
  const clockMs = randomClockMs(rng);
  const storedRaw = rng.weighted<string | null>([
    [null, 4],
    [JSON.stringify(randomPrefs(rng)), 4],
    [rng.pick(STORED_MALFORMED), 3],
  ]);
  const pendingRaw = rng.weighted<string | null>([
    [null, 7],
    [JSON.stringify({ version: 1, enabled: rng.chance(0.6) }), 2],
    [rng.pick(PENDING_MALFORMED), 1],
  ]);
  const osPermission = rng.pick<PermissionState>([
    'undetermined',
    'granted',
    'denied',
  ]);
  const promptOutcome: PermissionState = rng.chance(0.7) ? 'granted' : 'denied';
  const actions: Action[] = [];
  if (rng.chance(0.8)) actions.push({ kind: 'hydrate' });
  let currentOwner = owner;
  for (let i = rng.int(2, 6); i > 0; i--) {
    const action = randomAction(rng, currentOwner);
    if (action.kind === 'switchOwner') currentOwner = action.owner;
    actions.push(action);
  }
  const scenario: Scenario = {
    owner,
    clockIso: new Date(clockMs).toISOString(),
    storedRaw,
    pendingRaw,
    osPermission,
    promptOutcome,
    actions: actions.map(describeAction),
  };

  // ---- world --------------------------------------------------------------
  jest.useFakeTimers();
  jest.setSystemTime(clockMs);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(owner);
  if (storedRaw !== null && owner !== SIGNED_OUT_DATA_OWNER) {
    mockKv.table.set(notificationPrefsKeyForOwner(owner), storedRaw);
  }
  if (pendingRaw !== null) {
    mockKv.table.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, pendingRaw);
  }
  mockScheduler.osPermission = osPermission;
  mockScheduler.promptOutcome = promptOutcome;

  let faultsArmed = true;
  mockKv.modeFor = () => (faultsArmed ? drawMode(rng, KV_MODES) : 'ok');
  mockScheduler.modeFor = op => {
    if (!faultsArmed) return 'ok';
    if (op === 'permissionState') return drawMode(rng, PERMISSION_READ_MODES);
    if (op === 'requestPermission')
      return drawMode(rng, PERMISSION_REQUEST_MODES);
    if (op === 'openSystemSettings') return 'ok';
    return drawMode(rng, SCHEDULE_MODES);
  };
  const contextEvents: ContextEvent[] = [];
  let nextContextMode: FaultMode = 'ok';
  const injectedLoader = makeFaultContextLoader(
    journal,
    rng,
    () => nextContextMode,
  );
  const loadContext = () => {
    nextContextMode = faultsArmed ? drawMode(rng, CONTEXT_MODES) : 'ok';
    const event: ContextEvent = {
      atMs: Date.now(),
      mode: nextContextMode,
      source: 'injected',
      context: null,
    };
    contextEvents.push(event);
    // `throw` escapes synchronously here, exactly like a loader that blows
    // up before returning its promise.
    const promise = injectedLoader.load();
    return promise.then(context => {
      event.context = context;
      return context;
    });
  };
  // Default (hook) path: defaultLoadContext() → computeConsistencySnapshot().
  mockConsistency = () => {
    const nowMs = Date.now();
    const mode = faultsArmed ? drawMode(rng, CONTEXT_MODES) : 'ok';
    const event: ContextEvent = {
      atMs: nowMs,
      mode,
      source: 'default',
      context: null,
    };
    contextEvents.push(event);
    const facts = randomContext(rng, nowMs);
    const degraded: NotificationPlanContext = {
      nowMs,
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    };
    const snapshotFor = (context: NotificationPlanContext) => ({
      currentStreak: context.streakDays,
      trainedToday: context.practicedToday,
      totalActivities: context.hasAnyHistory ? 1 : 0,
      shieldsAvailable: context.shieldsAvailable ?? 0,
      nextStreakMilestone: context.milestoneEve
        ? { ...context.milestoneEve, daysAway: 1 }
        : null,
    });
    let promise: Promise<unknown>;
    try {
      promise = runFault(
        journal,
        'consistency',
        'snapshot',
        mode,
        () => {
          event.context = facts;
          return snapshotFor(facts);
        },
        {
          slowMs: rng.int(500, 5_000),
          malformed: () => {
            event.context = {
              nowMs,
              streakDays: Number.NaN,
              practicedToday: false,
              hasAnyHistory: true,
              shieldsAvailable: 0,
              milestoneEve: null,
            };
            return {
              currentStreak: Number.NaN,
              trainedToday: false,
              totalActivities: 1,
              shieldsAvailable: 0,
              nextStreakMilestone: null,
            };
          },
          partial: () => {
            // Snapshot with only the streak — every other fact undefined.
            event.context = {
              nowMs,
              streakDays: facts.streakDays,
              practicedToday: undefined as unknown as boolean,
              hasAnyHistory: false,
              shieldsAvailable: 0,
              milestoneEve: null,
            };
            return { currentStreak: facts.streakDays, totalActivities: 0 };
          },
        },
      );
    } catch (error) {
      event.context = degraded;
      throw error;
    }
    return promise.catch((error: unknown) => {
      event.context = degraded;
      throw error;
    });
  };

  const deps = { scheduler: mockScheduler, loadContext };
  const store = useNotificationStore;
  const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

  const violations: Violation[] = [];
  const hangs: IterationRow<Scenario>['hangs'] = [];

  const perform = (action: Action): Promise<unknown> => {
    switch (action.kind) {
      case 'hydrate':
        return store
          .getState()
          .hydrate({ ...deps, expectedOwnerKey: getActiveDataOwner() });
      case 'setPrefs':
        return store.getState().setPrefs(action.patch, deps);
      case 'requestEnable':
        return store.getState().requestPermissionAndEnable(deps);
      case 'onboarding':
        return store.getState().completeOnboardingStep(action.choice, deps);
      case 'dismiss':
        return store.getState().dismissPrompt(deps);
      case 'syncNow':
        return store.getState().syncNow(deps);
      case 'refresh':
        return store.getState().refreshPermission(deps);
      case 'foreground':
        // Exactly what useNotificationBootstrap does on AppState 'active'.
        return store
          .getState()
          .refreshPermission()
          .then(() => store.getState().syncNow());
      case 'switchOwner':
        setActiveDataOwner(action.owner);
        return store
          .getState()
          .hydrate({ ...deps, expectedOwnerKey: action.owner });
      case 'osPermission':
        mockScheduler.osPermission = action.permission;
        return Promise.resolve();
      case 'burst':
        return Promise.all(
          action.patches.map(patch => store.getState().setPrefs(patch, deps)),
        );
    }
  };

  const check = (
    step: number,
    performed: Action,
    marks: { calls: number; writes: number; journal: number; context: number },
    settled: boolean,
    phase: 'campaign' | 'recovery' | 'recovered',
  ) => {
    const action = `${phase === 'campaign' ? '' : 'recovery:'}${describeAction(performed)}`;
    // Concurrent saves have no defined "last" write/reconcile; only the
    // end state (queue, disk) is judged for a burst.
    const isBurst = performed.kind === 'burst';
    const fail = (invariant: string, detail: string) =>
      violations.push({ invariant, step, action, detail });
    const state = store.getState();
    const activeOwner = getActiveDataOwner();
    const prefsKey = notificationPrefsKeyForOwner(activeOwner);

    // state-shape
    if (!validPermission(state.permission)) {
      fail('state-shape', `permission=${String(state.permission)}`);
    }
    const shape = prefsShapeDefects(state.prefs);
    if (shape.length) fail('state-shape', shape.join(', '));

    // no-fake-permission
    if (state.permission === 'granted') {
      const lastReport = [...mockScheduler.calls]
        .reverse()
        .find(
          call =>
            (call.op === 'permissionState' ||
              call.op === 'requestPermission') &&
            call.outcome === 'ok',
        );
      if (!lastReport || lastReport.result !== 'granted') {
        fail(
          'no-fake-permission',
          `store says granted, last OS report ${lastReport ? String(lastReport.result) : 'none'}`,
        );
      }
    }

    // foreign-intact
    if (!mockScheduler.foreignIdsIntact()) {
      fail('foreign-intact', 'a non-ps. trigger id was cancelled');
    }

    // persisted-integrity — every acknowledged healthy write this step
    for (const write of mockKv.writes.slice(marks.writes)) {
      if (!write.acknowledged || write.mode !== 'ok') continue;
      if (write.key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY) {
        if (write.requested !== '') {
          const parsed = JSON.parse(write.requested) as {
            version?: unknown;
            enabled?: unknown;
          };
          if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean') {
            fail('persisted-integrity', `pending choice ${write.requested}`);
          }
        }
        continue;
      }
      if (write.activeOwner === SIGNED_OUT_DATA_OWNER) {
        fail(
          'persisted-integrity',
          `prefs written while signed out: ${write.key}`,
        );
      }
      if (write.key !== notificationPrefsKeyForOwner(write.activeOwner)) {
        fail(
          'persisted-integrity',
          `prefs for ${write.key} written while ${write.activeOwner} was active`,
        );
      }
      const roundTrip = JSON.stringify(parseNotificationPrefs(write.requested));
      if (roundTrip !== write.requested) {
        fail(
          'persisted-integrity',
          `write does not round-trip: ${write.requested}`,
        );
      }
    }

    // plan-sanity — every applyPlan this step
    const contextsThisStep = contextEvents.slice(marks.context);
    for (const call of mockScheduler.calls.slice(marks.calls)) {
      if (call.op !== 'applyPlan' || !call.plan) continue;
      const facts = [...contextsThisStep]
        .reverse()
        .find(event => event.context && event.atMs <= call.atMs);
      const leadBase = facts?.context?.nowMs ?? call.atMs;
      const defects = planDefects(call.plan, leadBase);
      if (defects.length) fail('plan-sanity', defects.join('; '));
      if (!isBurst && facts?.context && settled) {
        const expected = buildNotificationPlan(state.prefs, facts.context);
        if (!samePlan(call.plan, expected)) {
          fail(
            'plan-sanity',
            `applied [${call.planIds?.join(',')}] but prefs+facts call for [${expected
              .map(item => item.id)
              .join(',')}]`,
          );
        }
      }
    }

    if (!settled) return;

    // persist-flag-truthful — the last prefs write this step
    const prefsWrites = mockKv.writes
      .slice(marks.writes)
      .filter(write => write.key !== PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
    const lastPrefsWrite = prefsWrites[prefsWrites.length - 1];
    if (!isBurst && lastPrefsWrite && lastPrefsWrite.mode !== 'never') {
      if (lastPrefsWrite.acknowledged && state.persistFailed) {
        fail('persist-flag-truthful', 'write landed but persistFailed=true');
      }
      if (!lastPrefsWrite.acknowledged && !state.persistFailed) {
        fail(
          'persist-flag-truthful',
          `write ${lastPrefsWrite.mode} did not land but persistFailed=false (prefs=${JSON.stringify(
            state.prefs,
          )}, disk=${JSON.stringify(mockKv.table.get(lastPrefsWrite.key) ?? null)})`,
        );
      }
    }

    // schedule-flag-truthful — the last reconcile attempt this step
    type Attempt = { atMs: number; outcome: 'ok' | 'failed' | 'pending' };
    const attempts: Attempt[] = [];
    for (const call of mockScheduler.scheduleCallsSince(marks.calls)) {
      attempts.push({ atMs: call.atMs, outcome: call.outcome });
    }
    for (const event of contextsThisStep) {
      // Only the injected deps.loadContext propagates a failure into the
      // sync; the default path degrades to fact-free facts and still
      // reaches applyPlan, whose own outcome is what counts.
      if (
        event.source === 'injected' &&
        (event.mode === 'reject' ||
          event.mode === 'throw' ||
          event.mode === 'timeout')
      ) {
        attempts.push({ atMs: event.atMs, outcome: 'failed' });
      }
    }
    attempts.sort((a, b) => a.atMs - b.atMs);
    const lastAttempt = attempts[attempts.length - 1];
    if (!isBurst && lastAttempt && lastAttempt.outcome !== 'pending') {
      if (lastAttempt.outcome === 'failed' && !state.scheduleFailed) {
        fail(
          'schedule-flag-truthful',
          `last reconcile failed but scheduleFailed=false (owner=${activeOwner})`,
        );
      }
      if (lastAttempt.outcome === 'ok' && state.scheduleFailed) {
        fail(
          'schedule-flag-truthful',
          'last reconcile succeeded but scheduleFailed=true',
        );
      }
    }

    // queue-matches-state
    if (
      !state.scheduleFailed &&
      state.hydrated &&
      lastAttempt &&
      lastAttempt.outcome === 'ok' &&
      activeOwner !== SIGNED_OUT_DATA_OWNER &&
      state.ownerKey === activeOwner
    ) {
      const shouldSchedule =
        state.prefs.enabled && state.permission === 'granted';
      const own = mockScheduler.ownPlan();
      if (!shouldSchedule && own.length > 0) {
        fail(
          'queue-matches-state',
          `prefs off / permission ${state.permission} but OS still holds [${own
            .map(item => item.id)
            .join(',')}]`,
        );
      }
      if (shouldSchedule) {
        const facts = [...contextEvents].reverse().find(event => event.context);
        if (facts?.context) {
          const expected = buildNotificationPlan(state.prefs, facts.context);
          if (!samePlan(own, expected)) {
            fail(
              'queue-matches-state',
              `OS holds [${own.map(i => i.id).join(',')}] but prefs call for [${expected
                .map(i => i.id)
                .join(',')}]`,
            );
          }
        }
      }
    }
    if (
      activeOwner === SIGNED_OUT_DATA_OWNER &&
      state.hydrated &&
      !state.scheduleFailed
    ) {
      const own = mockScheduler.ownIds();
      if (own.length > 0 && lastAttempt?.outcome === 'ok') {
        fail(
          'queue-matches-state',
          `signed out but OS still holds [${own.join(',')}]`,
        );
      }
    }

    // memory-disk-coherent
    if (
      state.hydrated &&
      !state.persistFailed &&
      activeOwner !== SIGNED_OUT_DATA_OWNER &&
      state.ownerKey === activeOwner
    ) {
      const disk = mockKv.table.get(prefsKey);
      const last = mockKv.lastWrite(prefsKey);
      const diskTrusted =
        disk !== undefined &&
        (!last || (last.acknowledged && last.mode === 'ok'));
      // A read that handed back garbage (malformed/partial) is the
      // dependency lying; the store cannot know and is not judged for it.
      const lastRead = [...mockKv.reads]
        .reverse()
        .find(read => read.key === prefsKey);
      const readLied =
        lastRead?.mode === 'malformed' || lastRead?.mode === 'partial';
      if (diskTrusted && !readLied) {
        const onDisk = parseNotificationPrefs(disk);
        if (JSON.stringify(onDisk) !== JSON.stringify(state.prefs)) {
          fail(
            'memory-disk-coherent',
            `memory ${JSON.stringify(state.prefs)} vs disk ${JSON.stringify(onDisk)} (persistFailed=false)`,
          );
        }
      }
    }

    if (phase === 'recovered') {
      if (state.persistFailed)
        fail('recovered', 'persistFailed still set after healthy retry');
      if (state.scheduleFailed)
        fail('recovered', 'scheduleFailed still set after healthy retry');
    }
  };

  const marksNow = () => ({
    calls: mockScheduler.calls.length,
    writes: mockKv.writes.length,
    journal: journal.entries.length,
    context: contextEvents.length,
  });

  // ---- campaign -----------------------------------------------------------
  for (let step = 0; step < actions.length; step++) {
    const action = actions[step]!;
    const marks = marksNow();
    let promise: Promise<unknown>;
    try {
      promise = perform(action);
    } catch (error) {
      violations.push({
        invariant: 'settled-or-never',
        step,
        action: describeAction(action),
        detail: `synchronous throw escaped the store: ${String(error)}`,
      });
      continue;
    }
    let result = await settleWithin(promise, NO_SPINNER_BUDGET_MS, advance);
    if (
      !result.settled &&
      !journal.entries.slice(marks.journal).some(e => e.mode === 'never')
    ) {
      // Dependency-bound, not spinner-bound: chained 30 s dependency
      // timeouts may legitimately outlast 60 s. Grant the chain budget.
      result = await settleWithin(
        promise,
        CHAINED_DEPENDENCY_BUDGET_MS - NO_SPINNER_BUDGET_MS,
        advance,
      );
    }
    if (result.settled && !result.ok) {
      violations.push({
        invariant: 'settled-or-never',
        step,
        action: describeAction(action),
        detail: `store action rejected: ${String(result.error)}`,
      });
    }
    if (!result.settled) {
      const pending = journal.entries
        .slice(marks.journal)
        .filter(entry => entry.mode === 'never');
      if (pending.length === 0) {
        violations.push({
          invariant: 'settled-or-never',
          step,
          action: describeAction(action),
          detail: `did not settle within ${CHAINED_DEPENDENCY_BUDGET_MS / 1000} s and no dependency was \`never\``,
        });
      } else {
        hangs.push({
          step,
          action: describeAction(action),
          pendingFault: pending.map(p => `${p.dependency}.${p.op}`).join(','),
        });
      }
    }
    check(step, action, marks, result.settled, 'campaign');
  }

  // ---- recovery: faults lift, the user returns and touches one setting ----
  faultsArmed = false;
  const recoveryActions: Action[] = [
    { kind: 'foreground' },
    { kind: 'setPrefs', patch: {} },
  ];
  for (let i = 0; i < recoveryActions.length; i++) {
    const action = recoveryActions[i]!;
    const step = actions.length + i;
    const marks = marksNow();
    const result = await settleWithin(
      perform(action),
      NO_SPINNER_BUDGET_MS,
      advance,
    );
    if (!result.settled) {
      violations.push({
        invariant: 'recovered',
        step,
        action: describeAction(action),
        detail: 'healthy recovery action did not settle within 60 s',
      });
    }
    check(
      step,
      action,
      marks,
      result.settled,
      i === recoveryActions.length - 1 ? 'recovered' : 'recovery',
    );
  }

  jest.useRealTimers();

  const outcome = violations.length ? 'BROKEN' : hangs.length ? 'HUNG' : 'HELD';
  return {
    seed,
    outcome,
    knownFindings: knownFindingIds(violations),
    scenario,
    faultsInjected: journal.injected().length,
    faultsByMode: journal.byMode(),
    faultTrace: journal.trace(),
    violations,
    hangs,
    replay: replayCommand(SUITE, seed),
  };
}

describe('notificationStore failure injection (seeded)', () => {
  it.each(campaignSeeds())(
    'seed %i holds every recoverability invariant',
    async seed => {
      const row = await runIteration(seed);
      rows.push(row);
      if (unexplainedViolations(row.violations).length) {
        throw new Error(describeCampaignFailure(row));
      }
    },
  );
});
