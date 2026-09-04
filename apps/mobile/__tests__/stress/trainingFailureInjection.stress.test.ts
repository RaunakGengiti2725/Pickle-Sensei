/**
 * STRESS — unit `mod-training` (training/api + training/store), lens
 * `failure-injection`.
 *
 * The REAL `createTrainingApi` and the REAL zustand training store run over an
 * injected fetch. One route per iteration misbehaves (throw / reject / abort
 * after a delay / slow / never settles / 401 / 429 / 4xx / 5xx / HTML body /
 * non-JSON / single-field contract violation / wrong shape / empty 204 / echo
 * of a different resource) while every other route answers healthily, and a
 * seeded twist may be layered on: a double tap, an account reconfiguration or
 * sign-out while the request is in flight, a rejecting consistency mirror, or
 * a clock whose ISO formatter throws.
 *
 * Invariants asserted per iteration (fake timers advanced 60 s):
 *   - the operation settles with a truthful boolean (no fake success, no
 *     fake failure); every read/mutation status leaves `loading`/busy;
 *   - a failure lands in the matching `*Error` slot with the documented code
 *     and a `retryable` flag the screen turns into "Try again" (or, for an
 *     expired bearer, exactly one `onUnauthorized` and a non-retryable state);
 *   - no partially-parsed payload reaches the store, prior data survives a
 *     failed mutation, and a healed retry (or re-sign-in) fully recovers;
 *   - the consistency ledger is written once per SERVER-confirmed completion
 *     and never on failure; no unhandled rejection, no console noise;
 *   - stale responses never write into a reconfigured store.
 *
 * Known defects are pinned by `it.failing` reproductions below (they pass
 * while the defect reproduces and FAIL once it is fixed); the campaign still
 * records those seeds as BROKEN in the JSON table.
 *
 * Replay:   STRESS_SEEDS=<seed> npx jest --ci __tests__/stress/trainingFailureInjection
 * Campaign: STRESS_ITER=2000 STRESS_OUT=/tmp/table.json npx jest --ci …
 */
import {
  buildResultTable,
  createInjectedServer,
  expectedErrorCode,
  FAULT_KINDS,
  installConsoleSentinel,
  isRetryableFault,
  iterationCount,
  pickFault,
  rngFor,
  seedsFor,
  writeResultTable,
  type Fault,
  type FaultKind,
  type InjectedServer,
  type IterationRecord,
  type Rng,
  type RouteKind,
} from '../../test-support/stress/failureInjectionHarness';
import {
  createTrainingServerModel,
  DRILLS,
  IDS,
} from '../../test-support/stress/trainingServerModel';

const mockRecordDrillCompletion = jest.fn(
  async (_record: unknown): Promise<void> => undefined,
);
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
  type TrainingStoreState,
} from '../../src/training/store';
import type {
  TrainingErrorState,
  TrainingPlanItem,
} from '../../src/training/types';

jest.useFakeTimers();

const BASE_SEED = 0x7a11_0001;
const BASE_URL = 'https://training.test.invalid';
const TOKEN = 'stress-bearer';
const SETTLE_MS = 60_000;

// ─── Scenario space ──────────────────────────────────────────────────────────

type Operation =
  | 'loadSavedDrills'
  | 'loadCurrentPlan'
  | 'createPlan'
  | 'reassessCurrentPlan'
  | 'saveDrill'
  | 'unsaveDrill'
  | 'completePlanItem'
  | 'listCatalogDrills';

type Twist =
  | 'plain'
  | 'double-tap'
  | 'reconfigure-midflight'
  | 'signout-midflight'
  | 'consistency-reject'
  | 'clock-throw';

const OPERATIONS: readonly Operation[] = [
  'loadSavedDrills',
  'loadCurrentPlan',
  'createPlan',
  'reassessCurrentPlan',
  'saveDrill',
  'unsaveDrill',
  'completePlanItem',
  'listCatalogDrills',
];

const MUTATIONS: ReadonlySet<Operation> = new Set([
  'createPlan',
  'reassessCurrentPlan',
  'saveDrill',
  'unsaveDrill',
  'completePlanItem',
]);

/** Routes each operation touches; the first is its primary request. */
function routesFor(op: Operation): RouteKind[] {
  switch (op) {
    case 'loadSavedDrills':
      return ['saved-list', 'detail'];
    case 'loadCurrentPlan':
      return ['plan-current', 'detail'];
    case 'createPlan':
      return ['plan-create', 'detail'];
    case 'reassessCurrentPlan':
      return ['plan-reassess'];
    case 'saveDrill':
      return ['save', 'saved-list', 'detail'];
    case 'unsaveDrill':
      return ['unsave', 'saved-list', 'detail'];
    case 'completePlanItem':
      return ['complete'];
    case 'listCatalogDrills':
      return ['catalog'];
  }
}

/** DELETE ignores its response body: body faults are not faults there. */
function faultsFor(route: RouteKind): readonly FaultKind[] {
  if (route === 'unsave') {
    return FAULT_KINDS.filter(
      kind =>
        kind !== 'malformed-payload' &&
        kind !== 'wrong-shape' &&
        kind !== 'wrong-echo' &&
        kind !== 'empty-204',
    );
  }
  return FAULT_KINDS;
}

const DELAYED: ReadonlySet<FaultKind> = new Set([
  'slow',
  'never-resolves',
  'reject-timeout',
]);

interface Scenario {
  seed: number;
  op: Operation;
  target: RouteKind;
  fault: Fault;
  /** Fault applies to the first N matching requests (∞ = every one). */
  maxHits: number;
  twist: Twist;
  savedSlugs: string[];
  hasPlan: boolean;
}

function twistFor(
  rng: Rng,
  op: Operation,
  target: RouteKind,
  fault: Fault,
): Twist {
  const options: Twist[] = ['plain', 'plain', 'plain'];
  if (MUTATIONS.has(op) && target === routesFor(op)[0]) {
    options.push('double-tap');
  }
  if (DELAYED.has(fault.kind) && op !== 'listCatalogDrills') {
    options.push('reconfigure-midflight', 'signout-midflight');
  }
  if (op === 'completePlanItem') {
    options.push('consistency-reject', 'clock-throw');
  }
  return rng.pick(options);
}

function scenarioFor(seed: number): Scenario {
  const rng = rngFor(seed);
  const op = rng.pick(OPERATIONS);
  const routes = routesFor(op);
  // Primary route twice as likely as the secondary ones.
  const target = rng.pick([routes[0]!, ...routes]);
  const fault = pickFault(rng, faultsFor(target));
  const savedSlugs = DRILLS.filter(() => rng.bool(0.6)).map(
    drill => drill.slug,
  );
  // Keep the scenario meaningful: an unsave needs a saved drill (two, if the
  // refresh's detail fetch is the target), a save needs an unsaved one, and a
  // detail fault needs at least one detail request to exist.
  if (
    op === 'unsaveDrill' &&
    savedSlugs.length < (target === 'detail' ? 2 : 1)
  ) {
    savedSlugs.splice(0, savedSlugs.length, DRILLS[0].slug, DRILLS[1].slug);
  }
  if (op === 'saveDrill' && savedSlugs.length === DRILLS.length) {
    savedSlugs.pop();
  }
  if (
    op === 'loadSavedDrills' &&
    target === 'detail' &&
    savedSlugs.length === 0
  ) {
    savedSlugs.push(DRILLS[1].slug);
  }
  const hasPlan =
    op === 'reassessCurrentPlan' ||
    op === 'completePlanItem' ||
    (op === 'loadCurrentPlan' && target === 'detail') ||
    rng.bool(0.5);
  return {
    seed,
    op,
    target,
    fault,
    maxHits: target === 'detail' && rng.bool() ? 1 : Number.POSITIVE_INFINITY,
    twist: twistFor(rng, op, target, fault),
    savedSlugs,
    hasPlan,
  };
}

function describeScenario(s: Scenario): string {
  const hits = Number.isFinite(s.maxHits) ? `x${s.maxHits}` : 'x∞';
  const fault = `${s.fault.kind}${s.fault.detail ? `(${s.fault.detail})` : ''}${
    s.fault.delayMs ? `@${s.fault.delayMs / 1000}s` : ''
  }`;
  return `${s.op} ← ${fault} on ${s.target}${hits} · twist=${s.twist} · saved=[${s.savedSlugs.join(
    ',',
  )}] plan=${s.hasPlan}`;
}

// ─── Known defects (each pinned by an it.failing below) ──────────────────────

const KNOWN_DEFECTS = {
  'no-request-timeout': /never settled and the client has no timeout/,
  'unguarded-consistency-mirror':
    /ledger write voided without a rejection handler/,
} as const;

type KnownDefect = keyof typeof KNOWN_DEFECTS;

function knownDefectFor(failures: string[]): KnownDefect | null {
  if (failures.length === 0) return null;
  for (const [id, pattern] of Object.entries(KNOWN_DEFECTS) as Array<
    [KnownDefect, RegExp]
  >) {
    if (failures.every(failure => pattern.test(failure))) return id;
  }
  return null;
}

// ─── Per-iteration runner ────────────────────────────────────────────────────

interface Outcome {
  interactions: number;
  failures: string[];
}

type StoreData = Pick<
  TrainingStoreState,
  | 'savedStatus'
  | 'planStatus'
  | 'mutation'
  | 'savedDrills'
  | 'drillDetails'
  | 'currentPlan'
  | 'savedError'
  | 'planError'
  | 'mutationError'
>;

function snapshot(): StoreData {
  const s = useTrainingStore.getState();
  return {
    savedStatus: s.savedStatus,
    planStatus: s.planStatus,
    mutation: s.mutation,
    savedDrills: s.savedDrills,
    drillDetails: s.drillDetails,
    currentPlan: s.currentPlan,
    savedError: s.savedError,
    planError: s.planError,
    mutationError: s.mutationError,
  };
}

const DEFAULT_STATE: StoreData = {
  savedStatus: 'idle',
  planStatus: 'idle',
  mutation: 'idle',
  savedDrills: [],
  drillDetails: {},
  currentPlan: null,
  savedError: null,
  planError: null,
  mutationError: null,
};

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(SETTLE_MS);
}

/** Resolves to the settled value, or `'pending'` if it has not settled. */
async function probe<T>(promise: Promise<T>): Promise<T | 'pending'> {
  let settled: { value: T } | null = null;
  void promise.then(value => {
    settled = { value };
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled ? (settled as { value: T }).value : 'pending';
}

/**
 * A ledger write whose `.then`/`.catch` calls are recorded. jest-circus turns
 * any real unhandled rejection into a failure of the running test (it owns the
 * parent process' `unhandledRejection` listener), so the campaign observes the
 * missing guard structurally instead of crashing the run: the store `void`s
 * the promise, so a rejecting mirror would surface as an unhandled rejection.
 */
function recordedLedgerWrite(): {
  handled: () => boolean;
  thenable: Promise<void>;
} {
  let rejectionHandled = false;
  const thenable = {
    then(_onFulfilled?: unknown, onRejected?: unknown) {
      if (typeof onRejected === 'function') rejectionHandled = true;
      return Promise.resolve();
    },
    catch(onRejected?: unknown) {
      if (typeof onRejected === 'function') rejectionHandled = true;
      return Promise.resolve();
    },
    finally() {
      return Promise.resolve();
    },
  };
  return {
    handled: () => rejectionHandled,
    thenable: thenable as unknown as Promise<void>,
  };
}

function targetItem(): TrainingPlanItem {
  const plan = useTrainingStore.getState().currentPlan;
  const item = plan?.items.find(candidate => candidate.id === IDS.item2);
  if (!item) throw new Error('precondition: plan item missing');
  return item;
}

interface Context {
  s: Scenario;
  server: InjectedServer;
  unauthorized: number;
  out: Outcome;
}

function check(ctx: Context, condition: boolean, failure: string): void {
  ctx.out.interactions += 1;
  if (!condition) ctx.out.failures.push(failure);
}

function errorMatches(
  ctx: Context,
  slot: string,
  error: TrainingErrorState | null,
): void {
  const fault = ctx.s.fault;
  check(ctx, error !== null, `${slot}: no error recorded for ${fault.kind}`);
  if (!error) return;
  const code = expectedErrorCode(fault);
  check(ctx, error.code === code, `${slot}: code ${error.code} ≠ ${code}`);
  check(
    ctx,
    error.retryable === isRetryableFault(fault),
    `${slot}: retryable=${error.retryable} for ${fault.kind}`,
  );
  check(ctx, error.message.trim().length > 0, `${slot}: empty message`);
  if (fault.kind === 'http-401') {
    check(ctx, error.status === 401, `${slot}: status ${error.status} ≠ 401`);
  }
}

function runOperation(op: Operation, slug: string): Promise<boolean> {
  const store = useTrainingStore.getState();
  switch (op) {
    case 'loadSavedDrills':
      return store.loadSavedDrills();
    case 'loadCurrentPlan':
      return store.loadCurrentPlan();
    case 'createPlan':
      return store.createPlan(IDS.sourceShot);
    case 'reassessCurrentPlan':
      return store.reassessCurrentPlan(IDS.reassessShot);
    case 'saveDrill':
      return store.setDrillSaved(slug, true);
    case 'unsaveDrill':
      return store.setDrillSaved(slug, false);
    case 'completePlanItem':
      return store.completePlanItem(targetItem());
    case 'listCatalogDrills':
      throw new Error('catalog is exercised at the api level');
  }
}

async function runCatalog(
  ctx: Context,
  api: ReturnType<typeof createTrainingApi>,
) {
  const { s, server } = ctx;
  server.setFault(s.target, s.fault);
  const call = api.listCatalogDrills({ q: 'dink' }).then(
    items => ({ ok: true as const, items }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await settle();
  const result = await probe(call);
  if (s.fault.kind === 'never-resolves') {
    check(
      ctx,
      result !== 'pending',
      'listCatalogDrills still pending after 60s: fetch on catalog never settled and the client has no timeout',
    );
    return;
  }
  check(ctx, result !== 'pending', 'catalog call did not settle in 60s');
  if (result === 'pending') return;
  if (s.fault.kind === 'slow') {
    check(
      ctx,
      result.ok && result.items.length === DRILLS.length,
      'slow catalog did not deliver',
    );
    return;
  }
  check(ctx, !result.ok, `catalog resolved despite ${s.fault.kind}`);
  if (!result.ok) {
    const error = result.error;
    const state =
      error instanceof Error && 'toState' in error
        ? (error as { toState(): TrainingErrorState }).toState()
        : null;
    check(ctx, state !== null, 'catalog rejected with a non-TrainingError');
    if (state) errorMatches(ctx, 'catalog', state);
  }
  if (s.fault.kind === 'http-401') {
    check(
      ctx,
      ctx.unauthorized === 1,
      `onUnauthorized called ${ctx.unauthorized}× (expected 1)`,
    );
  }
  server.setFault(null, null);
  const retried = await api.listCatalogDrills({ q: 'dink' });
  check(ctx, retried.length === DRILLS.length, 'healed catalog retry failed');
}

async function runIteration(s: Scenario): Promise<Outcome> {
  const rng = rngFor(s.seed ^ 0x5eed);
  const model = createTrainingServerModel({
    savedSlugs: new Set(s.savedSlugs),
    hasPlan: s.hasPlan,
  });
  const server = createInjectedServer(model, rng, {
    target: null,
    fault: null,
  });
  const ctx: Context = {
    s,
    server,
    unauthorized: 0,
    out: { interactions: 0, failures: [] },
  };
  const api = createTrainingApi({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchFn: server.fetchFn,
    onUnauthorized: () => {
      ctx.unauthorized += 1;
    },
  });
  mockRecordDrillCompletion.mockReset();
  mockRecordDrillCompletion.mockImplementation(async () => undefined);

  if (s.op === 'listCatalogDrills') {
    await runCatalog(ctx, api);
    return ctx.out;
  }

  configureTrainingStore(api);
  const store = useTrainingStore.getState();

  // Preconditions over a healthy server (fault not yet armed).
  if (s.hasPlan) {
    check(ctx, await store.loadCurrentPlan(), 'precondition: plan load failed');
  }
  if (
    s.savedSlugs.length > 0 ||
    s.op === 'saveDrill' ||
    s.op === 'unsaveDrill'
  ) {
    check(
      ctx,
      await store.loadSavedDrills(),
      'precondition: saved load failed',
    );
  }
  const before = snapshot();
  const slug =
    s.op === 'unsaveDrill'
      ? s.savedSlugs[0]!
      : (DRILLS.find(drill => !s.savedSlugs.includes(drill.slug))?.slug ??
        DRILLS[2].slug);
  const requestsBefore = server.log.length;
  const primary = routesFor(s.op)[0]!;

  server.setFault(s.target, s.fault, s.maxHits);

  let clockSpy: jest.SpyInstance | null = null;
  let ledgerWrite: ReturnType<typeof recordedLedgerWrite> | null = null;
  if (s.twist === 'consistency-reject') {
    ledgerWrite = recordedLedgerWrite();
    mockRecordDrillCompletion.mockImplementation(() => ledgerWrite!.thenable);
  }
  if (s.twist === 'clock-throw') {
    clockSpy = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(() => {
        throw new RangeError('Invalid time value (injected)');
      });
  }

  const first = runOperation(s.op, slug);
  const second = s.twist === 'double-tap' ? runOperation(s.op, slug) : null;

  if (s.twist === 'reconfigure-midflight' || s.twist === 'signout-midflight') {
    await jest.advanceTimersByTimeAsync(500);
    if (s.twist === 'signout-midflight') {
      clearTrainingStoreConfiguration();
    } else {
      const fresh = createInjectedServer(
        createTrainingServerModel({ savedSlugs: new Set(), hasPlan: false }),
        rngFor(s.seed ^ 0xfe5),
        { target: null, fault: null },
      );
      configureTrainingStore(
        createTrainingApi({
          baseUrl: BASE_URL,
          token: 'rotated',
          fetchFn: fresh.fetchFn,
        }),
      );
    }
  }

  await settle();
  clockSpy?.mockRestore();
  const result = await probe(first);
  const after = snapshot();
  const requestsOn = (route: RouteKind) =>
    server.log.slice(requestsBefore).filter(entry => entry.route === route)
      .length;
  const ledgerWrites = () => mockRecordDrillCompletion.mock.calls.length;

  // ── Stale-configuration twists: the store must be untouched ──
  if (s.twist === 'reconfigure-midflight' || s.twist === 'signout-midflight') {
    if (s.target === primary) {
      // The primary request settled after the account changed: it must not
      // be reported as this account's success.
      check(
        ctx,
        result !== true,
        `stale ${s.op} reported success after reconfiguration`,
      );
    }
    check(
      ctx,
      eq(after, DEFAULT_STATE),
      `stale ${s.op} wrote into the reconfigured store: ${JSON.stringify(after).slice(0, 240)}`,
    );
    if (s.fault.kind !== 'never-resolves') {
      check(ctx, result !== 'pending', 'stale delayed response never settled');
    }
    check(ctx, ledgerWrites() === 0, 'stale completion reached the ledger');
    return ctx.out;
  }

  // ── Clock fault: nothing leaves the device, state recovers ──
  if (s.twist === 'clock-throw') {
    check(
      ctx,
      result === false,
      'completion claimed success with a broken clock',
    );
    check(
      ctx,
      after.mutation === 'idle',
      `mutation stuck at ${after.mutation}`,
    );
    check(
      ctx,
      after.mutationError !== null && after.mutationError.retryable,
      'no retryable error for clock fault',
    );
    check(
      ctx,
      requestsOn('complete') === 0,
      'evidence sent with an unformattable timestamp',
    );
    check(
      ctx,
      ledgerWrites() === 0,
      'ledger written without server completion',
    );
    check(
      ctx,
      eq(after.currentPlan, before.currentPlan),
      'plan mutated by failed completion',
    );
    server.setFault(null, null);
    const recovered = await useTrainingStore
      .getState()
      .completePlanItem(targetItem());
    check(ctx, recovered, 'completion did not recover once the clock worked');
    check(ctx, ledgerWrites() === 1, 'ledger not written once after recovery');
    return ctx.out;
  }

  // ── Double tap: the second call is refused and issues no request ──
  if (second) {
    const secondResult = await probe(second);
    check(ctx, secondResult === false, 'second tap did not return false');
    check(
      ctx,
      requestsOn(primary) <= 1,
      `double tap issued ${requestsOn(primary)} ${primary} requests`,
    );
  }

  // ── Never-resolves: must not hang without a visible error ──
  if (s.fault.kind === 'never-resolves') {
    const pending = result === 'pending';
    const spinner =
      s.target === 'saved-list' ||
      (s.op === 'loadSavedDrills' && s.target === 'detail')
        ? after.savedStatus === 'loading'
        : s.op === 'loadCurrentPlan'
          ? after.planStatus === 'loading'
          : after.mutation !== 'idle';
    check(
      ctx,
      !pending && !spinner,
      `${s.op} still ${pending ? 'pending' : 'settled'} after 60s with ${
        spinner ? 'a live spinner/busy lock' : 'no spinner'
      } and no error: fetch on ${s.target} never settled and the client has no timeout`,
    );
    return ctx.out;
  }

  check(
    ctx,
    result !== 'pending',
    `${s.op} did not settle within 60s (${s.fault.kind})`,
  );
  if (result === 'pending') return ctx.out;
  check(ctx, after.mutation === 'idle', `mutation stuck at ${after.mutation}`);
  check(
    ctx,
    after.savedStatus !== 'loading' && after.planStatus !== 'loading',
    'a read is still loading',
  );

  const faultOnRefresh =
    (s.op === 'saveDrill' || s.op === 'unsaveDrill') &&
    s.target === 'saved-list';
  const faultOnDetails = s.target === 'detail';
  const isMutation = MUTATIONS.has(s.op);

  if (s.fault.kind === 'slow' || faultOnDetails || faultOnRefresh) {
    // The operation itself must succeed: slow is not an error; detail and
    // refresh faults degrade a secondary read without failing the op.
    check(
      ctx,
      result === true,
      `${s.op} returned false though only ${s.target} was ${s.fault.kind}`,
    );
    check(
      ctx,
      after.mutationError === null,
      `mutationError set for a ${s.target} fault: ${after.mutationError?.code}`,
    );

    if (faultOnDetails && s.fault.kind !== 'slow') {
      const faultedSlugs = new Set(
        server.log
          .slice(requestsBefore)
          .filter(entry => entry.faulted)
          .map(entry => decodeURIComponent(entry.url.split('/').pop() ?? '')),
      );
      check(ctx, faultedSlugs.size > 0, 'detail fault never served');
      for (const drillSlug of faultedSlugs) {
        const known = before.drillDetails[drillSlug] !== undefined;
        check(
          ctx,
          known || after.drillDetails[drillSlug] === undefined,
          `detail for ${drillSlug} present despite ${s.fault.kind}`,
        );
      }
      if (s.op === 'loadSavedDrills') {
        check(
          ctx,
          after.savedStatus === 'ready',
          `savedStatus ${after.savedStatus} after partial details`,
        );
        check(
          ctx,
          after.savedDrills.length === s.savedSlugs.length,
          'saved list truncated by a detail fault',
        );
      }
      if (s.op === 'loadCurrentPlan' || s.op === 'createPlan') {
        check(
          ctx,
          after.planStatus === 'ready' && after.currentPlan !== null,
          'plan dropped by a detail fault',
        );
      }
      if (s.op === 'saveDrill' || s.op === 'unsaveDrill') {
        check(
          ctx,
          after.savedStatus === 'ready' &&
            after.savedDrills.some(drill => drill.slug === slug) ===
              (s.op === 'saveDrill'),
          'saved list wrong after a detail fault during refresh',
        );
      }
      if (s.fault.kind === 'http-401') {
        check(
          ctx,
          ctx.unauthorized >= 1,
          '401 on detail swallowed without onUnauthorized',
        );
      }
    }
    if (faultOnRefresh && s.fault.kind !== 'slow') {
      // Save/unsave succeeded server-side; the refresh failed visibly.
      check(
        ctx,
        model.state.savedSlugs.has(slug) === (s.op === 'saveDrill'),
        'server state does not reflect the confirmed mutation',
      );
      check(
        ctx,
        after.savedStatus === 'error',
        `refresh failure hidden: savedStatus=${after.savedStatus}`,
      );
      errorMatches(ctx, 'savedError', after.savedError);
      const detail = after.drillDetails[slug];
      check(
        ctx,
        !detail || detail.saved === (s.op === 'saveDrill'),
        'detail.saved does not reflect the confirmed mutation',
      );
    }
    if (s.fault.kind === 'slow') {
      const okStatus =
        s.op === 'loadSavedDrills'
          ? after.savedStatus === 'ready' &&
            after.savedDrills.length === s.savedSlugs.length
          : s.op === 'loadCurrentPlan'
            ? after.planStatus === 'ready' &&
              (after.currentPlan !== null) === s.hasPlan
            : s.op === 'createPlan' || s.op === 'reassessCurrentPlan'
              ? after.planStatus === 'ready' && after.currentPlan !== null
              : true;
      check(
        ctx,
        okStatus,
        `slow ${s.op} left status saved=${after.savedStatus} plan=${after.planStatus}`,
      );
      if (s.op === 'saveDrill' || s.op === 'unsaveDrill') {
        check(
          ctx,
          after.savedDrills.some(drill => drill.slug === slug) ===
            (s.op === 'saveDrill'),
          'saved list does not reflect the slow mutation',
        );
      }
    }
    if (s.op === 'completePlanItem') {
      const item = after.currentPlan?.items.find(
        candidate => candidate.id === IDS.item2,
      );
      check(ctx, item?.completion != null, 'completion missing after success');
      const recorded = mockRecordDrillCompletion.mock.calls[0]?.[0] as
        { id?: string } | undefined;
      check(
        ctx,
        ledgerWrites() === 1 && recorded?.id === item?.completion?.id,
        `ledger recorded ${ledgerWrites()}× (expected exactly once with the server id)`,
      );
      if (ledgerWrite && ledgerWrites() === 1) {
        check(
          ctx,
          ledgerWrite.handled(),
          'ledger write voided without a rejection handler (store.ts recordDrillCompletion mirror)',
        );
      }
    }
    return ctx.out;
  }

  // ── Hard failure on the primary route ──
  check(
    ctx,
    result === false,
    `${s.op} claimed success despite ${s.fault.kind} on ${s.target}`,
  );
  if (s.fault.kind === 'http-401') {
    check(
      ctx,
      ctx.unauthorized === 1,
      `onUnauthorized called ${ctx.unauthorized}× (expected 1)`,
    );
  }
  if (isMutation) {
    errorMatches(ctx, 'mutationError', after.mutationError);
    check(
      ctx,
      eq(after.savedDrills, before.savedDrills),
      'savedDrills changed by a failed mutation',
    );
    check(
      ctx,
      eq(after.currentPlan, before.currentPlan),
      'currentPlan changed by a failed mutation',
    );
    check(
      ctx,
      eq(after.drillDetails, before.drillDetails),
      'drillDetails changed by a failed mutation',
    );
    check(
      ctx,
      after.planStatus === before.planStatus,
      'planStatus changed by a failed mutation',
    );
    check(
      ctx,
      after.savedStatus === before.savedStatus,
      'savedStatus changed by a failed mutation',
    );
    check(ctx, ledgerWrites() === 0, 'ledger written for a failed completion');
    if (s.op === 'saveDrill' || s.op === 'unsaveDrill') {
      check(
        ctx,
        model.state.savedSlugs.has(slug) === (s.op === 'unsaveDrill'),
        'server state changed by a failed mutation request',
      );
    }
  } else if (s.op === 'loadSavedDrills') {
    check(
      ctx,
      after.savedStatus === 'error',
      `savedStatus ${after.savedStatus}`,
    );
    errorMatches(ctx, 'savedError', after.savedError);
    check(
      ctx,
      after.savedDrills.length === 0,
      'partially parsed saved drills stored',
    );
  } else {
    check(ctx, after.planStatus === 'error', `planStatus ${after.planStatus}`);
    errorMatches(ctx, 'planError', after.planError);
    check(ctx, after.currentPlan === null, 'partially parsed plan stored');
  }

  // ── Recovery: heal the server and use the visible retry ──
  server.setFault(null, null);
  if (s.fault.kind === 'http-401') {
    // The screen's recovery for an expired bearer is a fresh sign-in.
    configureTrainingStore(
      createTrainingApi({
        baseUrl: BASE_URL,
        token: 'renewed',
        fetchFn: server.fetchFn,
      }),
    );
    if (s.hasPlan) await useTrainingStore.getState().loadCurrentPlan();
    if (s.savedSlugs.length > 0) {
      await useTrainingStore.getState().loadSavedDrills();
    }
  }
  const retried = runOperation(s.op, slug);
  await settle();
  const recovered = await probe(retried);
  check(
    ctx,
    recovered === true,
    `healed retry of ${s.op} returned ${String(recovered)}`,
  );
  const healed = snapshot();
  check(ctx, healed.mutation === 'idle', 'mutation busy after healed retry');
  check(
    ctx,
    healed.mutationError === null,
    `mutationError persists after healed retry: ${healed.mutationError?.code}`,
  );
  if (
    s.op === 'loadSavedDrills' ||
    s.op === 'saveDrill' ||
    s.op === 'unsaveDrill'
  ) {
    check(
      ctx,
      healed.savedStatus === 'ready' && healed.savedError === null,
      'saved read not ready after healed retry',
    );
  }
  if (s.op === 'loadCurrentPlan') {
    check(
      ctx,
      healed.planStatus === 'ready' &&
        (healed.currentPlan !== null) === s.hasPlan,
      'plan not ready after healed retry',
    );
  }
  if (s.op === 'createPlan' || s.op === 'reassessCurrentPlan') {
    check(
      ctx,
      healed.planStatus === 'ready' && healed.currentPlan !== null,
      'plan not ready after healed retry',
    );
  }
  if (s.op === 'completePlanItem') {
    check(
      ctx,
      ledgerWrites() === 1,
      'ledger not written exactly once after recovery',
    );
    if (ledgerWrite && ledgerWrites() === 1) {
      check(
        ctx,
        ledgerWrite.handled(),
        'ledger write voided without a rejection handler (store.ts recordDrillCompletion mirror)',
      );
    }
  }
  if (s.op === 'saveDrill') {
    check(
      ctx,
      healed.savedDrills.some(drill => drill.slug === slug),
      'saved drill missing after healed save',
    );
  }
  if (s.op === 'unsaveDrill') {
    check(
      ctx,
      !healed.savedDrills.some(drill => drill.slug === slug),
      'unsaved drill still listed after healed unsave',
    );
  }
  return ctx.out;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

describe('stress: mod-training under injected dependency faults', () => {
  // Unhandled rejections need no sentinel: jest-circus owns the parent
  // process' `unhandledRejection` listener and fails the running test.
  const consoleNoise = installConsoleSentinel();

  afterAll(() => {
    consoleNoise.restore();
    clearTrainingStoreConfiguration();
  });

  it('runs the seeded campaign and holds every recoverability invariant (known defects pinned separately)', async () => {
    const seeds = seedsFor(BASE_SEED, iterationCount(240));
    const results: Array<IterationRecord & { known: KnownDefect | null }> = [];
    for (const seed of seeds) {
      clearTrainingStoreConfiguration();
      const scenario = scenarioFor(seed);
      let outcome: Outcome;
      try {
        outcome = await runIteration(scenario);
      } catch (error) {
        outcome = {
          interactions: 1,
          failures: [
            `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          ],
        };
      }
      await jest.advanceTimersByTimeAsync(0);
      for (const noise of consoleNoise.drain()) {
        outcome.failures.push(`console noise: ${noise}`);
      }
      results.push({
        seed,
        scenario: `${scenario.op}/${scenario.target}/${scenario.twist}`,
        outcome: outcome.failures.length === 0 ? 'HELD' : 'BROKEN',
        interactions: outcome.interactions,
        script: describeScenario(scenario),
        failures: outcome.failures,
        known: knownDefectFor(outcome.failures),
      });
    }

    const table = buildResultTable({
      unit: 'mod-training',
      lens: 'failure-injection',
      baseSeed: BASE_SEED,
      results,
      faultOf: record => scenarioFor(record.seed).fault.kind,
    });
    const artifact = writeResultTable('mod-training-failure-injection', table);

    const unexpected = results.filter(
      record => record.outcome === 'BROKEN' && record.known === null,
    );
    if (unexpected.length > 0) {
      throw new Error(
        `${unexpected.length}/${results.length} iterations BROKEN outside the pinned defects (table: ${artifact})\n${unexpected
          .slice(0, 12)
          .map(
            record =>
              `  seed=${record.seed} ${record.script}\n    ${record.failures.join('\n    ')}`,
          )
          .join('\n')}`,
      );
    }
    expect(results).toHaveLength(seeds.length);
    expect(table.interactions).toBeGreaterThanOrEqual(results.length * 2);
  });

  // `it.failing` inverts the verdict: these PASS while the defect reproduces
  // and FAIL the day it is fixed, so nothing is hidden or silently forgotten.
  it.failing(
    'KNOWN BROKEN no-request-timeout: a never-settling fetch surfaces an error with a retry within 60s',
    async () => {
      clearTrainingStoreConfiguration();
      const model = createTrainingServerModel({
        savedSlugs: new Set([DRILLS[0].slug]),
        hasPlan: false,
      });
      const server = createInjectedServer(model, rngFor(1), {
        target: 'saved-list',
        fault: { kind: 'never-resolves', detail: '', delayMs: 0 },
      });
      configureTrainingStore(
        createTrainingApi({
          baseUrl: BASE_URL,
          token: TOKEN,
          fetchFn: server.fetchFn,
        }),
      );
      const load = useTrainingStore.getState().loadSavedDrills();
      await settle();
      expect(await probe(load)).not.toBe('pending');
      expect(useTrainingStore.getState().savedStatus).not.toBe('loading');
    },
  );

  it.failing(
    'KNOWN BROKEN unguarded-consistency-mirror: the ledger write after a confirmed completion carries a rejection handler',
    async () => {
      clearTrainingStoreConfiguration();
      const model = createTrainingServerModel({
        savedSlugs: new Set(),
        hasPlan: true,
      });
      const server = createInjectedServer(model, rngFor(2), {
        target: null,
        fault: null,
      });
      configureTrainingStore(
        createTrainingApi({
          baseUrl: BASE_URL,
          token: TOKEN,
          fetchFn: server.fetchFn,
        }),
      );
      const ledgerWrite = recordedLedgerWrite();
      mockRecordDrillCompletion.mockReset();
      mockRecordDrillCompletion.mockImplementation(() => ledgerWrite.thenable);
      expect(await useTrainingStore.getState().loadCurrentPlan()).toBe(true);
      expect(
        await useTrainingStore.getState().completePlanItem(targetItem()),
      ).toBe(true);
      expect(mockRecordDrillCompletion).toHaveBeenCalledTimes(1);
      expect(ledgerWrite.handled()).toBe(true);
    },
  );
});
