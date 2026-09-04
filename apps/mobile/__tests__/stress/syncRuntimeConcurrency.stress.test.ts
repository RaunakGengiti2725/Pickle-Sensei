/**
 * stress / mod-sync-runtime — concurrency lens.
 *
 * Seeded interleaving campaigns over the REAL sync runtime
 * (`configureSyncRuntime` / `triggerOutboxSync` / `clearSyncRuntime` →
 * `drainOutbox` → `createTransport` → `fetch`) with held server responses,
 * Promise.all bursts of triggers and app-state flaps, sign-in / sign-out /
 * bearer rotation during in-flight requests, request timeouts, wall-clock
 * skew and DB faults. Families:
 *
 *   stormBurst            one runtime, duplicate calls + call-during-call
 *   cancelDuringCall      clearSyncRuntime / signOut while a request is out
 *   twoActors             USER_A and USER_B swapping on the same device
 *   sameOwnerReconfigure  sign out + back in as the same user mid-request
 *   rotationSkewTimeout   bearer rotation, 401s, clock skew, 20s timeouts
 *   dbFaults              receipt/delete/commit/select failures mid-drain
 *   chaos                 every action, both users
 *
 * Per iteration the harness collects violations of request-time invariants
 * (owner/bearer isolation, no overlapping drain per runtime, exhausted rows
 * never sent, bounded timers) and end-state invariants (no lost row, receipt
 * only after server accept, attempt budget never over-spent, liveness after
 * quiescence, no orphan transaction, no timer/listener leak, bounded wall
 * time), and `deriveUploadQueueStatus` is cross-checked against the durable
 * rows. All checks are gathered into one list so a failing seed reports
 * every broken invariant at once.
 *
 * Known defect (pinned by syncRuntimeConcurrentDrains.stress.test.ts):
 * `clearSyncRuntime` cannot stop a drain whose request is already out, so a
 * re-`configureSyncRuntime` (same or other user) starts a SECOND drain on
 * the one SQLite connection. When both responses land, the loser's
 * `BEGIN IMMEDIATE` fails ("cannot start a transaction within a
 * transaction"). Families that can re-configure record
 * `knownDefects.nestedBegin` instead of failing unless STRESS_STRICT=1;
 * single-runtime families always require zero.
 *
 * Scale: STRESS_ITER seeds per family (default 24). Replay one seed:
 *   STRESS_SEED=<seed> npx jest __tests__/stress/syncRuntimeConcurrency
 * Evidence: artifacts/stress/<STRESS_RUN_ID>/events.ndjson (one line per
 * iteration: seed, plan, observed stats, verdict, wall time).
 */
import { getDb } from '../../src/data/db';
import { createTransport } from '../../src/data/api';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import { deriveUploadQueueStatus } from '../../src/data/offlineCapabilities';
import {
  DEFAULT_WEIGHTS,
  OWNER_A,
  USER_A,
  USERS,
  buildPlan,
  createStressWorld,
  flush,
  inspectEnd,
  recordStress,
  requestSummary,
  runStep,
  settle,
  signIn,
  statementTrace,
  stressSeeds,
  teardownWorld,
  wallNowMs,
  type PlanOptions,
  type StepOp,
  type StressWorld,
} from '../../testing/stress/syncRuntimeStressHarness';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, createTransport: jest.fn() };
});

const actualApi =
  jest.requireActual<typeof import('../../src/data/api')>('../../src/data/api');

const SUITE = 'syncRuntimeConcurrency';
/** Real wall-clock budget per iteration (fake timers, in-memory DB). */
const WALL_BUDGET_MS = 4_000;
/** Fail on the pinned known defect too (campaign mode for findings). */
const STRICT = process.env['STRESS_STRICT'] === '1';

interface Family {
  name: string;
  plan: PlanOptions;
  /** Actions that never appear; used to decide which checks are exact. */
  singleRuntime: boolean;
}

const only = (ops: Partial<Record<StepOp, number>>) => {
  const zeroed = Object.fromEntries(
    (Object.keys(DEFAULT_WEIGHTS) as StepOp[]).map(op => [op, 0]),
  ) as Record<StepOp, number>;
  return { ...zeroed, ...ops };
};

const FAMILIES: Family[] = [
  {
    name: 'stormBurst',
    singleRuntime: true,
    plan: {
      steps: [12, 60],
      users: [USER_A],
      weights: only({
        enqueue: 12,
        enqueueSession: 3,
        rotate: 2,
        trigger: 10,
        appState: 10,
        burst: 16,
        release: 14,
        releaseAll: 4,
        advance: 8,
        flush: 4,
      }),
    },
  },
  {
    name: 'cancelDuringCall',
    singleRuntime: false,
    plan: {
      steps: [12, 60],
      users: [USER_A],
      weights: only({
        enqueue: 12,
        enqueueSession: 2,
        signIn: 6,
        signOut: 4,
        clearRuntime: 6,
        trigger: 8,
        appState: 6,
        burst: 8,
        release: 14,
        releaseAll: 4,
        advance: 6,
        flush: 4,
      }),
    },
  },
  {
    name: 'twoActors',
    singleRuntime: false,
    plan: {
      steps: [12, 60],
      users: USERS,
      weights: only({
        enqueue: 14,
        enqueueSession: 3,
        signIn: 8,
        signOut: 3,
        rotate: 4,
        trigger: 8,
        appState: 6,
        burst: 8,
        release: 14,
        releaseAll: 4,
        advance: 6,
        flush: 4,
      }),
    },
  },
  {
    name: 'sameOwnerReconfigure',
    singleRuntime: false,
    plan: {
      steps: [12, 60],
      users: [USER_A],
      weights: only({
        enqueue: 14,
        enqueueSession: 2,
        signIn: 10,
        signOut: 4,
        clearRuntime: 4,
        trigger: 6,
        appState: 6,
        burst: 8,
        release: 14,
        releaseAll: 6,
        advance: 6,
        flush: 4,
      }),
    },
  },
  {
    name: 'rotationSkewTimeout',
    singleRuntime: true,
    plan: {
      steps: [12, 60],
      users: [USER_A],
      weights: only({
        enqueue: 12,
        enqueueSession: 2,
        rotate: 12,
        trigger: 8,
        appState: 6,
        burst: 8,
        release: 14,
        releaseAll: 4,
        advance: 14,
        skew: 8,
        flush: 4,
      }),
    },
  },
  {
    name: 'dbFaults',
    singleRuntime: true,
    plan: {
      steps: [12, 60],
      users: [USER_A],
      weights: only({
        enqueue: 14,
        enqueueSession: 3,
        trigger: 8,
        appState: 6,
        burst: 8,
        release: 14,
        releaseAll: 4,
        advance: 6,
        dbFault: 10,
        flush: 4,
      }),
    },
  },
  {
    name: 'chaos',
    singleRuntime: false,
    plan: { steps: [16, 80], users: USERS },
  },
];

describe('stress: sync runtime concurrency', () => {
  const originalFetch = globalThis.fetch;
  let world: StressWorld;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'hrtime'] });
    world = createStressWorld({
      getDb: getDb as jest.Mock,
      createTransport: createTransport as jest.Mock,
      actualCreateTransport: actualApi.createTransport,
    });
  });

  afterEach(() => {
    teardownWorld(world, originalFetch);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  for (const family of FAMILIES) {
    describe(family.name, () => {
      for (const seed of stressSeeds(family.name)) {
        it(`seed ${seed}`, async () => {
          const { plan } = buildPlan(seed, family.plan);
          await recordStress(
            SUITE,
            family.name,
            seed,
            { steps: plan.length, plan },
            async observed => {
              const started = wallNowMs();
              // Every family starts signed in as USER_A with a live runtime.
              signIn(world, USER_A);
              await flush(4);
              for (const step of plan) {
                await runStep(world, step);
              }
              const midTimers = jest.getTimerCount();
              const settlement = await settle(world);
              const end = inspectEnd(world);
              const wallMs = wallNowMs() - started;
              const clean =
                world.stats.faultsInjected === 0 && world.stats.txErrors === 0;

              const failures: string[] = [];
              const check = (ok: boolean, label: string) => {
                if (!ok) failures.push(label);
              };
              for (const v of world.violations) {
                failures.push(`${v.invariant} ${JSON.stringify(v.detail)}`);
              }
              // ── durable-state invariants ──
              check(end.lostIds.length === 0, `lost rows ${end.lostIds}`);
              check(
                end.receiptWithoutAccept.length === 0,
                `receipt without server accept ${end.receiptWithoutAccept}`,
              );
              check(
                end.receiptOwnerMismatch.length === 0,
                `receipt under wrong owner ${end.receiptOwnerMismatch}`,
              );
              check(
                end.receiptAndRowBoth.length === 0,
                `receipt but row still queued ${end.receiptAndRowBoth}`,
              );
              check(
                end.attemptsOverBudget.length === 0,
                `attempts above OUTBOX_MAX_ATTEMPTS ${end.attemptsOverBudget}`,
              );
              check(
                end.attemptsOverServerPermanent.length === 0,
                `attempt budget spent on a non-permanent outcome ${end.attemptsOverServerPermanent}`,
              );
              if (clean) {
                check(
                  end.attemptsUnderServerPermanent.length === 0,
                  `permanent outcome not recorded on row ${end.attemptsUnderServerPermanent}`,
                );
              }
              // ── liveness after quiescence ──
              check(
                end.unexpectedRemaining.length === 0,
                `USER_A rows still queued after settle ${end.unexpectedRemaining} (rounds ${settlement.rounds})`,
              );
              check(
                world.pending.length === 0,
                `requests still pending after settle ${world.pending.length}`,
              );
              // ── transaction / timer / listener hygiene ──
              check(
                end.openTransactions === 0,
                `orphaned BEGIN ${end.openTransactions}`,
              );
              const nestedBegin = world.stats.nestedBeginAttempts;
              if (family.singleRuntime || STRICT) {
                check(
                  nestedBegin === 0,
                  `nested BEGIN IMMEDIATE on the single SQLite connection ×${nestedBegin}`,
                );
              }
              // The nested BEGIN is the loser's only symptom: its rows are
              // marked failed without spending attempts, the winner's
              // transaction completes, so the durable checks above still
              // hold. Anything else in txErrors is unexpected.
              check(
                world.stats.txErrors === nestedBegin,
                `transaction errors beyond nested BEGIN ×${world.stats.txErrors - nestedBegin}`,
              );
              check(end.timers === 1, `timers after settle ${end.timers}`);
              check(
                end.listenersLive === 1,
                `AppState listeners live ${end.listenersLive}`,
              );
              // ── single-runtime families: strict concurrency bounds ──
              if (family.singleRuntime) {
                check(
                  world.stats.maxInFlight <= 1,
                  `overlapping requests from one runtime ${world.stats.maxInFlight}`,
                );
                check(
                  world.stats.duplicateSends === 0,
                  `shot id sent while already in flight ×${world.stats.duplicateSends}`,
                );
                check(
                  end.duplicateReceiptWrites === 0,
                  `duplicate receipt writes ${end.duplicateReceiptWrites}`,
                );
              }
              // ── 401 handling: only a rejection of the CURRENT bearer counts ──
              const current401 = world.requests.filter(
                r => r.outcome === 'http_401' && r.bearerCurrentAtResponse,
              ).length;
              check(
                world.unauthorizedEvents.length === current401,
                `unauthorized listener fired ${world.unauthorizedEvents.length}× for ${current401} current-bearer 401s`,
              );
              check(
                world.unauthorizedEvents.every(e => e.reported === e.current),
                'unauthorized listener fired for a stale bearer',
              );
              // ── offlineCapabilities: status derives from durable rows ──
              const rowsA = world.fake.outbox
                .filter(r => r.owner_key === OWNER_A)
                .map(r => ({
                  kind: r.kind,
                  attempts: r.attempts,
                  lastError: r.last_error,
                }));
              const status = deriveUploadQueueStatus(rowsA);
              const exhaustedA = rowsA.filter(
                r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
              ).length;
              if (rowsA.length === 0) {
                check(
                  status.state === 'idle',
                  `status ${status.state} for 0 rows`,
                );
              } else if (exhaustedA > 0) {
                check(
                  status.state === 'needs_attention' &&
                    status.exhausted === exhaustedA &&
                    status.pending === rowsA.length - exhaustedA,
                  `status ${JSON.stringify(status)} for ${rowsA.length} rows / ${exhaustedA} exhausted`,
                );
              } else {
                check(
                  status.state === 'queued' && status.pending === rowsA.length,
                  `status ${JSON.stringify(status)} for ${rowsA.length} queued rows`,
                );
              }
              // ── bounded wall time (deadlock guard) ──
              check(
                wallMs < WALL_BUDGET_MS,
                `iteration took ${Math.round(wallMs)}ms`,
              );

              Object.assign(observed, {
                requests: world.requests.length,
                drainStarts: world.drainStarts,
                runtimes: world.runtimeSeq,
                enqueued: world.enqueued.size,
                acceptedIds: world.acceptedIds.size,
                receipts: end.receipts,
                duplicateReceiptWrites: end.duplicateReceiptWrites,
                outboxRows: end.outboxRows,
                outboxByOwner: end.outboxByOwner,
                exhaustedRows: end.exhaustedRows,
                orphanRows: end.orphanRows,
                midTimers,
                settleRounds: settlement.rounds,
                requestsDuringSettle: settlement.requestsDuringSettle,
                settleTrace: settlement.trace,
                unauthorizedEvents: world.unauthorizedEvents.length,
                stats: world.stats,
                knownDefects: {
                  nestedBegin,
                  concurrentDrainsOnOneConnection: world.stats.maxInFlight > 1,
                  duplicateSends: world.stats.duplicateSends,
                },
                violations: world.violations.length,
                failures,
                wallMs: Math.round(wallMs),
              });
              if (failures.length > 0) {
                // Full trace for the finding; stays out of passing lines.
                Object.assign(observed, {
                  requestLog: requestSummary(world),
                  statementTail: statementTrace(world, 120),
                });
              }
              expect(failures).toEqual([]);
            },
          );
        });
      }
    });
  }
});
