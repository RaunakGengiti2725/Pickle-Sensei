/**
 * stress / mod-sync-runtime — FAILURE INJECTION catalog for
 * `src/data/syncRuntime.ts` (+ `deriveUploadQueueStatus` as the queue's only
 * user-visible surface). Real runtime, real `drainOutbox`, real
 * `createTransport`; the doubles sit at the unit's dependency boundary:
 * global `fetch`, `getDb`, the ApiSession store, `AppState`, `Math.random`
 * and `getRuntimePublicConfig` (see testing/stress/syncRuntimeFaultInjection.ts
 * for the fault vocabulary and the invariant list).
 *
 * Every `it` is one catalog entry `Fnn` / `Dnn` / `Ann` / `Snn` / `Cnn`:
 *   F = fetch / api,  D = SQLite,  A = AppState,  S = session / owner store,
 *   C = clock (retry jitter / timers).
 * Each entry runs the same protocol:
 *   arrange rows + fault → configureSyncRuntime → let 60 s of fake time pass
 *   (the "no infinite spinner" window) → read the durable state → lift the
 *   fault → prove the retry control + the timer both drain → prove recovery
 *   → check the persisted-state invariants → record the evidence row.
 *
 * KNOWN BROKEN entries pin the CURRENT behaviour of a dependency promise that
 * never settles inside a drain (FI-1): the runtime generation stays
 * "running" forever, arms no timer and ignores every foreground / trigger
 * until `configureSyncRuntime` runs again. They live in their own describe so
 * the suite is green today and fails loudly the day a drain watchdog lands.
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/stress/syncRuntimeFailureInjection.stress.test.ts
 *   STRESS_RUN_ID=<id> …   → artifacts/stress/mod-sync-runtime/<id>/
 */
import { AppState } from 'react-native';
import { getDb } from '../../src/data/db';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { API_REQUEST_TIMEOUT_MS } from '../../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
} from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  nextSyncRetryDelayMs,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  deriveUploadQueueStatus,
  type UploadQueueStatus,
} from '../../src/data/offlineCapabilities';
import {
  USER_A,
  USER_B,
  advance,
  createAppStateHarness,
  createFakeServer,
  createFaultingDb,
  drainCount,
  drainsCompleted,
  flushFaultRecords,
  flushMicrotasks,
  fnv1a,
  maxRequestsInAnyMinute,
  outboxRowsFor,
  persistedStateViolations,
  recordFault,
  seededRandom,
  sessionFor,
  sessionPayload,
  shotPayload,
  trialPayload,
  unhandledRejectionSentinel,
  uniqueReceipts,
  type AppStateHarness,
  type EnqueuedRow,
  type FakeServer,
  type FaultingDb,
  type FetchOutcome,
} from '../../testing/stress/syncRuntimeFaultInjection';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: jest.fn(actual.getRuntimePublicConfig),
  };
});

const SUITE = 'syncRuntimeFailureInjection';
const SPINNER_WINDOW_MS = 60_000;
/** Enough fake time for the request timeout plus the maximum backoff. */
const LIVENESS_WINDOW_MS = API_REQUEST_TIMEOUT_MS + SYNC_RETRY_MAX_MS * 1.25;

const ownerA = canonicalDataOwner(USER_A);
const ownerB = canonicalDataOwner(USER_B);

const sentinel = unhandledRejectionSentinel();
const realFetch = globalThis.fetch;
const realRandom = Math.random;
/** Retry jitter for the current scenario, seeded from its name so the
 * evidence (request cadence, retry instants) replays bit-for-bit. */
let scenarioRandom: () => number = realRandom;

let db: FaultingDb;
let server: FakeServer;
let appState: AppStateHarness;
let enqueued: EnqueuedRow[];
let getDbFault: Error | null;

function push(
  kind:
    'shot.sync' | 'session.create' | 'session.finalize' | 'evaluation.trial',
  payload: unknown,
  entityId: string,
  wellFormed = true,
  owner = ownerA,
): EnqueuedRow {
  db.inner.push(kind, payload, owner);
  const row = db.inner.outbox[db.inner.outbox.length - 1]!;
  const record = { id: row.id, owner, kind, entityId, wellFormed };
  enqueued.push(record);
  return record;
}

function pushShot(id: string, sessionId: string | null = null, owner = ownerA) {
  return push('shot.sync', shotPayload(id, sessionId), id, true, owner);
}

function queueStatus(owner = ownerA): UploadQueueStatus {
  return deriveUploadQueueStatus(
    outboxRowsFor(db, owner).map(row => ({
      kind: row.kind,
      attempts: row.attempts,
      lastError: row.last_error,
    })),
  );
}

function rowsSnapshot(owner = ownerA) {
  return outboxRowsFor(db, owner).map(row => ({
    id: row.id,
    kind: row.kind,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}

/** Retry timers owned by the runtime = all fake timers minus the harness's
 * own pending `slow` timers. */
function runtimeTimers(): number {
  return jest.getTimerCount() - db.pendingSlow - server.pendingSlow;
}

/** The faulted drain has settled once nothing of it is pending (no request
 * in flight, no hanging/slow statement) and its `finally` armed the retry
 * timer. (`api.ts` owns a 20 s abort timer while a request is in flight, so
 * "a timer exists" alone is not enough.) */
function drainSettled(): boolean {
  return (
    server.inFlight === 0 &&
    server.pendingSlow === 0 &&
    db.hanging === 0 &&
    db.pendingSlow === 0 &&
    runtimeTimers() >= 1
  );
}

function healEverything() {
  server.script = [];
  server.defaultOutcome = { kind: 'ok' };
  db.clearFaults();
  getDbFault = null;
  appState.mode = 'normal';
  Math.random = scenarioRandom;
}

interface ScenarioSpec {
  id: string;
  family: string;
  inputs: Record<string, unknown>;
  /** Distinct faults this scenario injects (counted into the evidence). */
  faults: number;
  /** Push rows + install faults. Defaults to two shots. */
  arrange?: () => void | Promise<void>;
  /** Replaces the default `configureSyncRuntime(sessionFor(USER_A))`. */
  configure?: () => void;
  /** Runs after configure + first microtask flush, before the 60 s window. */
  act?: () => Promise<void>;
  /** Assertions on the state right after the 60 s window. */
  afterFault: (o: Record<string, unknown>) => void;
  /** Rows that may legitimately still sit in the outbox after recovery. */
  mayRemain?: (row: {
    kind: string;
    attempts: number;
    lastError: string | null;
  }) => boolean;
  /** Set when the scenario ends signed out (no recovery is expected). */
  noRecovery?: boolean;
  /** Overlapping generations are legal only when the scenario reconfigures
   * the runtime while a drain is in flight. */
  maxInFlight?: number;
  /** Requests driven by explicit foreground/trigger events (excluded from
   * the timer-cadence storm bound). */
  explicitTriggers?: number;
}

async function scenario(spec: ScenarioSpec): Promise<void> {
  await recordFault(SUITE, spec.family, spec.id, null, spec.inputs, async o => {
    if (spec.arrange) await spec.arrange();
    else {
      pushShot('shot-1');
      pushShot('shot-2');
    }
    let configureError: string | null = null;
    try {
      if (spec.configure) spec.configure();
      else configureSyncRuntime(sessionFor(USER_A));
    } catch (error) {
      configureError = error instanceof Error ? error.message : String(error);
    }
    o['configureError'] = configureError;
    await flushMicrotasks(20);
    if (spec.act) await spec.act();

    // ── the 60 s "no infinite spinner" window ──────────────────────────
    // A retry timer is armed only from the drain's `finally`, so its
    // appearance is the moment the faulted drain settled (completed or
    // threw). Poll second by second and snapshot the durable state THEN,
    // before the retry it armed gets a chance to run.
    let settleMs: number | null = drainSettled() ? 0 : null;
    for (
      let t = 1_000;
      settleMs === null && t <= SPINNER_WINDOW_MS;
      t += 1_000
    ) {
      await advance(1_000, 1_000);
      if (drainSettled()) settleMs = t;
    }
    o['settleMs'] = settleMs;
    o['requestsAfterFault'] = server.requests.length;
    o['requestOutcomes'] = server.requests.map(
      r => `${r.outcome}:${r.status ?? '-'}`,
    );
    o['drainsStarted'] = drainCount(db);
    o['drainsCompleted'] = drainsCompleted(db);
    o['rowsAfterFault'] = rowsSnapshot();
    o['receiptsAfterFault'] = uniqueReceipts(db).map(x => x.entityId);
    o['queueStatusAfterFault'] = queueStatus();
    o['timersAfterFault'] = runtimeTimers();
    o['hangingRequests'] = server.hanging;
    o['abortedRequests'] = server.aborted;
    o['drainSettledWithin60s'] = settleMs !== null;

    // ── NO_STALL: the timer alone must produce another drain ───────────
    const drainsBeforeLiveness = drainCount(db);
    await advance(LIVENESS_WINDOW_MS);
    o['timerDrove'] = drainCount(db) > drainsBeforeLiveness;

    spec.afterFault(o);

    // ── lift the fault; RETRY_CONTROL then RECOVERY ────────────────────
    healEverything();
    await advance(API_REQUEST_TIMEOUT_MS + 5_000);
    const drainsBeforeTrigger = drainCount(db);
    triggerOutboxSync();
    await flushMicrotasks(30);
    o['triggerDrove'] = drainCount(db) > drainsBeforeTrigger;
    const drainsBeforeForeground = drainCount(db);
    appState.fire('active');
    await flushMicrotasks(30);
    o['foregroundDrove'] = drainCount(db) > drainsBeforeForeground;
    await advance(LIVENESS_WINDOW_MS);
    await advance(LIVENESS_WINDOW_MS);
    o['rowsAfterRecovery'] = rowsSnapshot();
    o['receipts'] = uniqueReceipts(db).map(r => r.entityId);
    o['maxInFlight'] = server.maxInFlight;
    o['maxRequestsInAnyMinute'] = maxRequestsInAnyMinute(server);
    o['timersAtEnd'] = runtimeTimers();
    o['violations'] = persistedStateViolations(db, server, enqueued);
    o['unhandledRejections'] = sentinel.take();

    if (!spec.noRecovery) {
      expect(o['triggerDrove']).toBe(true);
      const remaining = rowsSnapshot().filter(
        row => !(spec.mayRemain?.(row) ?? false),
      );
      expect(remaining).toEqual([]);
      for (const row of enqueued) {
        if (row.kind !== 'shot.sync' || row.owner !== ownerA) continue;
        if (db.inner.outbox.some(r => r.id === row.id)) continue;
        expect(o['receipts']).toContain(row.entityId);
      }
      expect(runtimeTimers()).toBe(1);
    }
    expect(server.maxInFlight).toBeLessThanOrEqual(spec.maxInFlight ?? 1);
    expect(maxRequestsInAnyMinute(server)).toBeLessThanOrEqual(
      4 + (spec.explicitTriggers ?? 2),
    );
    expect(o['violations']).toEqual([]);
    expect(o['unhandledRejections']).toEqual([]);
    return spec.faults;
  });
}

function rows(o: Record<string, unknown>) {
  return o['rowsAfterFault'] as Array<{
    kind: string;
    attempts: number;
    lastError: string | null;
  }>;
}

/** Transient verdict: rows kept, attempts untouched, the error recorded. */
function expectTransient(
  o: Record<string, unknown>,
  count = 2,
  needle?: string,
) {
  const r = rows(o);
  expect(r).toHaveLength(count);
  for (const row of r) {
    expect(row.attempts).toBe(0);
    expect(row.lastError).not.toBeNull();
    if (needle) expect(row.lastError).toContain(needle);
  }
  expect(o['queueStatusAfterFault']).toEqual({
    state: 'queued',
    pending: count,
  });
  expect(o['drainSettledWithin60s']).toBe(true);
  expect(o['timersAfterFault']).toBe(1);
  expect(o['timerDrove']).toBe(true);
}

/** Permanent verdict: one attempt consumed per drain, error recorded. */
function expectPermanent(
  o: Record<string, unknown>,
  count = 2,
  needle?: string,
) {
  const r = rows(o);
  expect(r).toHaveLength(count);
  for (const row of r) {
    expect(row.attempts).toBe(1);
    expect(row.lastError).not.toBeNull();
    if (needle) expect(row.lastError).toContain(needle);
  }
  expect(o['queueStatusAfterFault']).toEqual({
    state: 'queued',
    pending: count,
  });
  expect(o['drainSettledWithin60s']).toBe(true);
  expect(o['timersAfterFault']).toBe(1);
  expect(o['timerDrove']).toBe(true);
}

function expectDelivered(o: Record<string, unknown>) {
  expect(rows(o)).toEqual([]);
  expect(o['queueStatusAfterFault']).toEqual({ state: 'idle' });
  expect(o['timersAfterFault']).toBe(1);
  expect(o['timerDrove']).toBe(true);
}

describe('stress/mod-sync-runtime failure-injection', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    db = createFaultingDb();
    server = createFakeServer();
    appState = createAppStateHarness();
    enqueued = [];
    getDbFault = null;
    scenarioRandom = seededRandom(
      fnv1a(expect.getState().currentTestName ?? SUITE),
    );
    Math.random = scenarioRandom;
    (getDb as jest.Mock).mockImplementation(() => {
      if (getDbFault) throw getDbFault;
      return db.db;
    });
    (getRuntimePublicConfig as jest.Mock).mockImplementation(() => ({
      appVersion: '0.0.0-stress',
    }));
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(
        appState.addEventListener as unknown as typeof AppState.addEventListener,
      );
    globalThis.fetch = server.fetch;
    establishApiSession(sessionFor(USER_A));
    setActiveDataOwner(ownerA);
    setApiUnauthorizedListener(null);
  });

  afterEach(() => {
    appState.mode = 'normal';
    try {
      clearSyncRuntime();
    } catch {
      // A removeThrows scenario leaves a poisoned subscription; the next
      // scenario installs a fresh AppState double anyway.
    }
    clearApiSession();
    setApiUnauthorizedListener(null);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    Math.random = realRandom;
    globalThis.fetch = realFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    sentinel.dispose();
    flushFaultRecords(SUITE);
  });

  // ─── F: fetch / api ──────────────────────────────────────────────────────

  describe('F fetch / api', () => {
    it('F01 fetch throws synchronously → transient, retried by timer', () =>
      scenario({
        id: 'F01',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'throwSync' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'throwSync' }];
        },
        afterFault: o => expectTransient(o, 2, 'fetch threw synchronously'),
      }));

    it('F02 fetch rejects TypeError("Network request failed") → transient', () =>
      scenario({
        id: 'F02',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject TypeError' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            { kind: 'reject', error: new TypeError('Network request failed') },
          ];
        },
        afterFault: o => expectTransient(o, 2, 'Network request failed'),
      }));

    it('F03 fetch rejects with a string → transient, reason recorded', () =>
      scenario({
        id: 'F03',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject string' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'reject', error: 'socket closed' }];
        },
        afterFault: o => expectTransient(o, 2, 'socket closed'),
      }));

    it('F04 fetch rejects with null → transient, "null" recorded (not silent)', () =>
      scenario({
        id: 'F04',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject null' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'reject', error: null }];
        },
        afterFault: o => expectTransient(o, 2, 'null'),
      }));

    it('F05 fetch hangs honouring abort → 408 network.timeout at 20 s, transient', () =>
      scenario({
        id: 'F05',
        family: 'fetch',
        faults: 1,
        inputs: {
          outcome: 'hang honorAbort',
          timeoutMs: API_REQUEST_TIMEOUT_MS,
        },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'hang', honorAbort: true }];
        },
        afterFault: o => {
          expect(o['settleMs']).toBe(API_REQUEST_TIMEOUT_MS);
          expectTransient(o, 2, 'took too long to respond');
          expect(o['abortedRequests']).toBe(1);
          expect(o['hangingRequests']).toBe(0);
        },
      }));

    it('F07 fetch slow 19 s (inside the timeout) then 2xx → delivered', () =>
      scenario({
        id: 'F07',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'slow 19s ok' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'slow', ms: 19_000, then: { kind: 'ok' } }];
        },
        afterFault: o => {
          expectDelivered(o);
          expect(o['abortedRequests']).toBe(0);
        },
      }));

    it('F08 fetch slow 21 s (past the timeout) → aborted 408, then the retry delivers', () =>
      scenario({
        id: 'F08',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'slow 21s ok' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'slow', ms: 21_000, then: { kind: 'ok' } }];
        },
        afterFault: o => {
          expect(o['abortedRequests']).toBe(1);
          expect(o['settleMs']).toBe(API_REQUEST_TIMEOUT_MS);
          expectTransient(o, 2, 'took too long to respond');
        },
      }));

    it('F09 fetch resolves undefined (not a Response) → transient', () =>
      scenario({
        id: 'F09',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'nonResponse undefined' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'nonResponse', value: undefined }];
        },
        afterFault: o => expectTransient(o, 2),
      }));

    it('F10 fetch resolves a plain object without json() → transient', () =>
      scenario({
        id: 'F10',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'nonResponse {}' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            { kind: 'nonResponse', value: { ok: true, status: 200 } },
          ];
        },
        afterFault: o => expectTransient(o, 2),
      }));

    const transientStatuses: Array<[string, number, boolean]> = [
      ['F11', 500, false],
      ['F12', 502, true],
      ['F13', 503, false],
      ['F14', 504, true],
      ['F22', 408, false],
      ['F25', 429, false],
    ];
    for (const [id, status, nonJson] of transientStatuses) {
      it(`${id} HTTP ${status}${nonJson ? ' (non-JSON body)' : ''} → transient, attempts untouched`, () =>
        scenario({
          id,
          family: 'fetch',
          faults: 1,
          inputs: { outcome: `status ${status}`, nonJson },
          arrange: () => {
            pushShot('shot-1');
            pushShot('shot-2');
            server.script = [
              {
                kind: 'status',
                status,
                nonJson,
                body: nonJson
                  ? undefined
                  : { error: { code: `server.${status}`, message: 'nope' } },
              },
            ];
          },
          afterFault: o =>
            expectTransient(o, 2, nonJson ? `status-${status}` : 'nope'),
        }));
    }

    const permanentStatuses: Array<[string, number]> = [
      ['F19', 403],
      ['F20', 400],
      ['F21', 404],
      ['F23', 409],
      ['F24', 422],
      ['F26', 418],
    ];
    for (const [id, status] of permanentStatuses) {
      it(`${id} HTTP ${status} → permanent, exactly one attempt consumed per drain`, () =>
        scenario({
          id,
          family: 'fetch',
          faults: 1,
          inputs: { outcome: `status ${status}` },
          arrange: () => {
            pushShot('shot-1');
            pushShot('shot-2');
            server.script = [
              {
                kind: 'status',
                status,
                body: {
                  error: { code: `client.${status}`, message: 'refused' },
                },
              },
            ];
          },
          afterFault: o => expectPermanent(o, 2, 'refused'),
        }));
    }

    it('F15 HTTP 401 with a bearer → unauthorized listener fires once, rows transient', () =>
      scenario({
        id: 'F15',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'status 401' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            {
              kind: 'status',
              status: 401,
              body: { error: { code: 'auth.expired', message: 'expired' } },
            },
          ];
          const listener = jest.fn();
          setApiUnauthorizedListener(listener);
          (server as unknown as { listener: jest.Mock }).listener = listener;
        },
        afterFault: o => {
          expectTransient(o, 2, 'expired');
          const listener = (server as unknown as { listener: jest.Mock })
            .listener;
          expect(listener).toHaveBeenCalledTimes(1);
          expect(listener.mock.calls[0]![0]).toMatchObject({
            canonicalAppUserId: USER_A,
          });
        },
      }));

    it('F16 HTTP 401 whose listener throws → the throw is contained, rows transient', () =>
      scenario({
        id: 'F16',
        family: 'fetch',
        faults: 2,
        inputs: { outcome: 'status 401 + listener throws' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'status', status: 401 }];
          setApiUnauthorizedListener(() => {
            throw new Error('listener exploded');
          });
        },
        afterFault: o => expectTransient(o, 2, 'listener exploded'),
      }));

    it('F17 HTTP 401 whose listener re-configures the runtime re-entrantly → one live generation, rows delivered', () =>
      scenario({
        id: 'F17',
        family: 'fetch',
        faults: 2,
        inputs: { outcome: 'status 401 + re-entrant configure' },
        maxInFlight: 2,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'status', status: 401 }];
          setApiUnauthorizedListener(() => {
            clearSyncRuntime();
            establishApiSession(sessionFor(USER_A, '-rotated'));
            configureSyncRuntime(sessionFor(USER_A, '-rotated'));
          });
        },
        afterFault: o => {
          expectDelivered(o);
          const authHeaders = server.requests.map(r => r.authorization);
          expect(authHeaders[authHeaders.length - 1]).toBe(
            `Bearer ${sessionFor(USER_A, '-rotated').bearerToken}`,
          );
        },
      }));

    it('F18 HTTP 401 whose listener signs the user out → no further requests, rows kept for the next sign-in', () =>
      scenario({
        id: 'F18',
        family: 'fetch',
        faults: 2,
        inputs: { outcome: 'status 401 + sign-out' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'status', status: 401 }];
          setApiUnauthorizedListener(() => {
            clearSyncRuntime();
            clearApiSession();
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          });
        },
        afterFault: o => {
          const r = rows(o);
          expect(r).toHaveLength(2);
          for (const row of r) expect(row.attempts).toBe(0);
          expect(o['requestsAfterFault']).toBe(1);
          expect(o['timersAfterFault']).toBe(0);
          expect(o['timerDrove']).toBe(false);
          // Signing back in drains what was kept.
          establishApiSession(sessionFor(USER_A));
          setActiveDataOwner(ownerA);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));

    it('F27 2xx with a non-JSON body → transient (json() null is not a verdict)', () =>
      scenario({
        id: 'F27',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'jsonRejects' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'jsonRejects' }];
        },
        afterFault: o => expectTransient(o, 2),
      }));

    const malformedBodies: Array<[string, string, unknown]> = [
      ['F28', 'null', null],
      ['F29', 'array', ['shot-1', 'shot-2']],
      ['F30', 'string', 'ok'],
      ['F31', '{} (no acceptedIds / rejected)', {}],
      [
        'F33',
        'acceptedIds is a string',
        { acceptedIds: 'shot-1', rejected: [] },
      ],
      ['F34', 'acceptedIds numbers', { acceptedIds: [0, 1], rejected: [] }],
      [
        'F35',
        'rejected items without id',
        { acceptedIds: [], rejected: [{}, { code: 'x' }] },
      ],
      [
        'F38',
        'rejected code not a string',
        {
          acceptedIds: [],
          rejected: [{ id: 'shot-1' }, { id: 'shot-2', code: 7 }],
        },
      ],
    ];
    for (const [id, label, body] of malformedBodies) {
      it(`${id} 2xx malformed body (${label}) → never a receipt; row kept with its error`, () =>
        scenario({
          id,
          family: 'fetch',
          faults: 1,
          inputs: { outcome: `body ${label}` },
          arrange: () => {
            pushShot('shot-1');
            pushShot('shot-2');
            server.script = [{ kind: 'body', body }];
          },
          afterFault: o => {
            const r = rows(o);
            expect(r).toHaveLength(2);
            for (const row of r) {
              expect(row.lastError).not.toBeNull();
              // A shape that throws before any verdict is transient; a shape
              // that parses but names no id is "unacknowledged" (permanent).
              expect([0, 1]).toContain(row.attempts);
            }
            expect(o['receipts'] ?? []).toEqual([]);
            expect(o['drainSettledWithin60s']).toBe(true);
            expect(o['timersAfterFault']).toBe(1);
            expect(o['timerDrove']).toBe(true);
          },
        }));
    }

    it('F32 2xx acknowledging nothing → permanent "shot.sync_unacknowledged", bounded at OUTBOX_MAX_ATTEMPTS', () =>
      scenario({
        id: 'F32',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'ok accept none (persistent)' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.defaultOutcome = { kind: 'ok', accept: 'none' };
        },
        afterFault: o => {
          for (const row of rows(o)) {
            expect(row.lastError).toContain('shot.sync_unacknowledged');
            expect(row.attempts).toBeGreaterThanOrEqual(1);
            expect(row.attempts).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
          }
          expect(o['timerDrove']).toBe(true);
        },
        mayRemain: row => row.attempts === OUTBOX_MAX_ATTEMPTS,
      }));

    it('F36 per-item transient rejection (shot.write_failed) → attempts untouched', () =>
      scenario({
        id: 'F36',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject shot.write_failed' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            {
              kind: 'ok',
              accept: 'none',
              reject: [
                { id: 'shot-1', code: 'shot.write_failed' },
                { id: 'shot-2', code: 'shot.write_failed' },
              ],
            },
          ];
        },
        afterFault: o => expectTransient(o, 2, 'shot.write_failed'),
      }));

    it('F37 per-item permanent rejection (shot.invalid_payload) → one attempt consumed', () =>
      scenario({
        id: 'F37',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject shot.invalid_payload' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            {
              kind: 'ok',
              accept: 'none',
              reject: [
                { id: 'shot-1', code: 'shot.invalid_payload' },
                { id: 'shot-2', code: 'shot.invalid_payload' },
              ],
            },
          ];
        },
        afterFault: o => expectPermanent(o, 2, 'shot.invalid_payload'),
      }));

    it('F39 partial verdict: one accepted, one transiently rejected, one unmentioned', () =>
      scenario({
        id: 'F39',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'partial verdict' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          pushShot('shot-3');
          server.script = [
            {
              kind: 'ok',
              accept: ['shot-1'],
              reject: [{ id: 'shot-2', code: 'shot.write_failed' }],
            },
          ];
        },
        afterFault: o => {
          const r = rows(o);
          // shot-1 left with a receipt; shot-2 transient; shot-3 permanent.
          expect(r.map(row => row.attempts).sort()).toEqual([0, 1]);
          expect(r.map(row => row.lastError).join('|')).toContain(
            'shot.write_failed',
          );
          expect(r.map(row => row.lastError).join('|')).toContain(
            'shot.sync_unacknowledged',
          );
          expect(o['receiptsAfterFault']).toEqual(['shot-1']);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('F40 id both accepted and rejected → accepted wins, receipt written exactly once', () =>
      scenario({
        id: 'F40',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'conflicting verdict' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            {
              kind: 'ok',
              reject: [{ id: 'shot-1', code: 'shot.invalid_payload' }],
            },
          ];
        },
        afterFault: o => {
          expectDelivered(o);
          expect(
            db.inner.receipts.filter(r => r.entityId === 'shot-1'),
          ).toHaveLength(1);
        },
      }));

    it('F41 acceptedIds duplicated + unknown ids → each row receipted once, unknown ids ignored', () =>
      scenario({
        id: 'F41',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'duplicate + unknown acceptedIds' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            { kind: 'ok', duplicateAccepted: true, acceptUnknown: ['ghost-1'] },
          ];
        },
        afterFault: o => {
          expectDelivered(o);
          expect(db.inner.receipts.map(r => r.entityId).sort()).toEqual([
            'shot-1',
            'shot-2',
          ]);
        },
      }));

    it('F42 response.json() throws synchronously → transient', () =>
      scenario({
        id: 'F42',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'jsonThrows' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'jsonThrows' }];
        },
        afterFault: o => expectTransient(o, 2, 'json() threw synchronously'),
      }));

    it('F45 response.json() slow 30 s (no body timeout) → still delivered, no stall', () =>
      scenario({
        id: 'F45',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'jsonSlow 30s' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'jsonSlow', ms: 30_000 }];
        },
        afterFault: o => expectDelivered(o),
      }));

    it('F46 status 200 with ok=false → treated as a failure, never a receipt', () =>
      scenario({
        id: 'F46',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'okFalse200' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'okFalse200' }];
        },
        afterFault: o => {
          const r = rows(o);
          expect(r).toHaveLength(2);
          for (const row of r) expect(row.lastError).toContain('ok=false');
          expect(o['receiptsAfterFault']).toEqual([]);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('F47 1 MB of junk beside a valid verdict → delivered', () =>
      scenario({
        id: 'F47',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'junk 1MB' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'ok', junkBytes: 1_048_576 }];
        },
        afterFault: o => expectDelivered(o),
      }));

    it('F48 a 50-row batch accepted in one verdict → 50 receipts, one request', () =>
      scenario({
        id: 'F48',
        family: 'fetch',
        faults: 0,
        inputs: { outcome: 'ok ×50' },
        arrange: () => {
          for (let i = 0; i < 50; i += 1) pushShot(`shot-${i}`);
        },
        afterFault: o => {
          expectDelivered(o);
          expect(uniqueReceipts(db)).toHaveLength(50);
          expect(
            server.requests.filter(r => r.path === '/v1/shots:sync'),
          ).toHaveLength(1);
        },
      }));

    it('F49 getRuntimePublicConfig throws while building headers → transient, no request sent', () =>
      scenario({
        id: 'F49',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'runtimeConfig throws once' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          let thrown = false;
          (getRuntimePublicConfig as jest.Mock).mockImplementation(() => {
            if (!thrown) {
              thrown = true;
              throw new Error('runtime config unavailable');
            }
            return { appVersion: '0.0.0-stress' };
          });
        },
        afterFault: o => {
          expectTransient(o, 2, 'runtime config unavailable');
          expect(o['requestsAfterFault']).toBe(0);
        },
      }));

    it('F50 fetch rejects "AbortError" while NOT aborted by the client → transient', () =>
      scenario({
        id: 'F50',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'reject AbortError' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          const error = new Error('Aborted');
          error.name = 'AbortError';
          server.script = [{ kind: 'reject', error }];
        },
        afterFault: o => {
          expectTransient(o, 2, 'Aborted');
          expect(rows(o)[0]!.lastError).not.toContain('took too long');
        },
      }));

    it('F51 session.create 500 keeps its shot transient ("session_not_found") and both drain once the server heals', () =>
      scenario({
        id: 'F51',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'session.create 500, strict sessions' },
        arrange: () => {
          server.strictSessions = true;
          pushShot('shot-1', 'sess-1');
          push('session.create', sessionPayload('sess-1'), 'sess-1');
          server.script = [{ kind: 'status', status: 500 }];
        },
        afterFault: o => {
          const r = rows(o);
          if (r.length > 0) {
            for (const row of r) expect(row.attempts).toBe(0);
          }
          expect(o['drainSettledWithin60s']).toBe(true);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('F52 session.create permanently refused (400) → its shot retries transiently (pre-existing, pinned by syncRuntimeMatrix "orphanSessionUnbounded")', () =>
      scenario({
        id: 'F52',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'session.create 400 forever, strict sessions' },
        arrange: () => {
          server.strictSessions = true;
          pushShot('shot-1', 'sess-1');
          push('session.create', sessionPayload('sess-1'), 'sess-1');
          server.script = Array.from({ length: 12 }, () => ({
            kind: 'status' as const,
            status: 400,
            body: { error: { code: 'session.invalid', message: 'bad' } },
          }));
        },
        afterFault: o => {
          expect(o['drainSettledWithin60s']).toBe(true);
          expect(o['timersAfterFault']).toBe(1);
        },
        mayRemain: row =>
          (row.kind === 'session.create' && row.attempts >= 1) ||
          (row.kind === 'shot.sync' &&
            row.attempts === 0 &&
            (row.lastError ?? '').includes(SESSION_NOT_FOUND_REJECTION)),
      }));

    it('F53 evaluation.trial upload 503 then heals → trial row kept transiently then deleted', () =>
      scenario({
        id: 'F53',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'trials 503' },
        arrange: () => {
          push('evaluation.trial', trialPayload('trial-1'), 'trial-1');
          server.script = [{ kind: 'status', status: 503 }];
        },
        afterFault: o => {
          const r = rows(o);
          if (r.length > 0) expect(r[0]!.attempts).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('F54 evaluation.trial verdict acknowledges nothing → permanent, bounded', () =>
      scenario({
        id: 'F54',
        family: 'fetch',
        faults: 1,
        inputs: { outcome: 'trials accept none forever' },
        arrange: () => {
          push('evaluation.trial', trialPayload('trial-1'), 'trial-1');
          server.defaultOutcome = { kind: 'ok', accept: 'none' };
        },
        afterFault: o => {
          expect(rows(o)[0]!.lastError).toContain(
            'evaluation.trial_unacknowledged',
          );
          expect(o['timersAfterFault']).toBe(1);
        },
        mayRemain: row => row.attempts === OUTBOX_MAX_ATTEMPTS,
      }));
  });

  // ─── D: SQLite ───────────────────────────────────────────────────────────

  describe('D SQLite', () => {
    it('D01 getDb() throws → drain fails closed, timer armed, nothing written', () =>
      scenario({
        id: 'D01',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'getDb throws' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          getDbFault = new Error('sqlite open failed');
        },
        afterFault: o => {
          expect(o['requestsAfterFault']).toBe(0);
          expect(o['drainsStarted']).toBe(0);
          for (const row of rows(o)) {
            expect(row.attempts).toBe(0);
            expect(row.lastError).toBeNull();
          }
          expect(o['queueStatusAfterFault']).toEqual({
            state: 'queued',
            pending: 2,
          });
          expect(o['timersAfterFault']).toBe(1);
          expect(o['timerDrove']).toBe(false); // getDb still throws
        },
      }));

    for (const [id, mode] of [
      ['D02', 'reject'],
      ['D15', 'throwSync'],
    ] as const) {
      it(`${id} outbox SELECT ${mode}s → drain fails closed, timer armed`, () =>
        scenario({
          id,
          family: 'sqlite',
          faults: 1,
          inputs: { fault: `SELECT ${mode}` },
          arrange: () => {
            pushShot('shot-1');
            pushShot('shot-2');
            db.addFault({ needle: 'SELECT id, kind, payload', mode });
          },
          afterFault: o => {
            expect(o['requestsAfterFault']).toBe(0);
            expect(o['timersAfterFault']).toBe(1);
            expect(o['timerDrove']).toBe(true);
            for (const row of rows(o)) expect(row.attempts).toBe(0);
          },
        }));
    }

    it('D04 outbox SELECT slow 5 s → delivered, no stall', () =>
      scenario({
        id: 'D04',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'SELECT slow 5s' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({
            needle: 'SELECT id, kind, payload',
            mode: 'slow',
            slowMs: 5_000,
          });
        },
        afterFault: o => expectDelivered(o),
      }));

    it('D05 outbox SELECT returns malformed rows → drain completes, no request for garbage, no crash', () =>
      scenario({
        id: 'D05',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'SELECT malformedRows' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({
            needle: 'SELECT id, kind, payload',
            mode: 'malformedRows',
          });
        },
        afterFault: o => {
          expect(o['drainSettledWithin60s']).toBe(true);
          expect(o['timersAfterFault']).toBe(1);
          for (const row of rows(o)) expect(row.attempts).toBe(0);
        },
      }));

    it('D06 outbox SELECT returns rows with attempts as strings / NaN → bounded, no crash', () =>
      scenario({
        id: 'D06',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'SELECT attempts typed wrong' },
        arrange: () => {
          pushShot('shot-1');
          db.addFault({
            needle: 'SELECT id, kind, payload',
            mode: 'malformedRows',
            rows: [
              {
                id: 1,
                kind: 'shot.sync',
                payload: JSON.stringify(shotPayload('shot-1', null)),
                attempts: '7',
              },
              {
                id: 2,
                kind: 'shot.sync',
                payload: JSON.stringify(shotPayload('shot-2', null)),
                attempts: NaN,
              },
            ],
          });
        },
        afterFault: o => {
          expect(o['drainSettledWithin60s']).toBe(true);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    for (const [id, mode] of [
      ['D16', 'noRowsField'],
      ['D17', 'nullResult'],
    ] as const) {
      it(`${id} outbox SELECT resolves ${mode} → drain fails closed, retried`, () =>
        scenario({
          id,
          family: 'sqlite',
          faults: 1,
          inputs: { fault: `SELECT ${mode}` },
          arrange: () => {
            pushShot('shot-1');
            pushShot('shot-2');
            db.addFault({ needle: 'SELECT id, kind, payload', mode });
          },
          afterFault: o => {
            expect(o['requestsAfterFault']).toBe(0);
            expect(o['timersAfterFault']).toBe(1);
            expect(o['timerDrove']).toBe(true);
          },
        }));
    }

    it('D07 UPDATE last_error rejects while recording a transient failure → drain throws, rows intact', () =>
      scenario({
        id: 'D07',
        family: 'sqlite',
        faults: 2,
        inputs: { fault: '503 + UPDATE reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'status', status: 503 }];
          db.addFault({
            needle: 'UPDATE outbox SET last_error',
            mode: 'reject',
          });
        },
        afterFault: o => {
          for (const row of rows(o)) expect(row.attempts).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
          expect(o['timerDrove']).toBe(true);
        },
      }));

    it('D14 UPDATE attempts+1 rejects while recording a permanent failure → attempt not lost, row retried', () =>
      scenario({
        id: 'D14',
        family: 'sqlite',
        faults: 2,
        inputs: { fault: '400 + UPDATE attempts reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'status', status: 400 }];
          db.addFault({ needle: 'attempts = attempts + 1', mode: 'reject' });
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
          expect(o['timerDrove']).toBe(true);
          for (const row of rows(o))
            expect(row.attempts).toBeLessThanOrEqual(1);
        },
      }));

    it('D08 receipt INSERT rejects → transaction rolled back, row kept, resent and receipted after heal', () =>
      scenario({
        id: 'D08',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'INSERT sync_receipt reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({
            needle: 'INSERT OR REPLACE INTO sync_receipt',
            mode: 'reject',
          });
        },
        afterFault: o => {
          const r = rows(o);
          expect(r.length).toBeGreaterThanOrEqual(1);
          for (const row of r) {
            expect(row.attempts).toBe(0);
            expect(row.lastError).toContain('injected sqlite reject');
          }
          expect(db.inner.openTransactions()).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('D09 DELETE inside the receipt transaction rejects → receipt rolled back with it, rest of the batch deferred', () =>
      scenario({
        id: 'D09',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'DELETE (in txn) reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({ needle: 'DELETE FROM outbox', mode: 'reject' });
        },
        afterFault: o => {
          expect(db.inner.openTransactions()).toBe(0);
          // The receipt of the failed row must not survive the rollback, and
          // the batch loop stops at the first receipt failure: every row is
          // kept (transient, no attempt consumed) and no receipt exists.
          expectTransient(o, 2, 'injected sqlite reject');
          expect(o['receiptsAfterFault']).toEqual([]);
        },
      }));

    it('D10 COMMIT rejects → rolled back, row kept, no orphaned transaction', () =>
      scenario({
        id: 'D10',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'COMMIT reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({ needle: 'COMMIT', mode: 'reject' });
        },
        afterFault: o => {
          expect(db.inner.openTransactions()).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('D12 BEGIN IMMEDIATE rejects (busy) → whole batch transient, retried', () =>
      scenario({
        id: 'D12',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'BEGIN reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({ needle: 'BEGIN IMMEDIATE', mode: 'reject' });
        },
        afterFault: o => {
          for (const row of rows(o)) expect(row.attempts).toBe(0);
          expect(db.inner.openTransactions()).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('D13 trailing count(*) rejects after receipts committed → receipts durable, drain counted as failed, timer armed', () =>
      scenario({
        id: 'D13',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'count(*) reject' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({ needle: 'count(*)', mode: 'reject' });
        },
        afterFault: o => {
          expect(rows(o)).toEqual([]);
          expect(uniqueReceipts(db)).toHaveLength(2);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('D18 DELETE silently no-ops (partial write) → receipt exists, row resent next drain, server idempotent', () =>
      scenario({
        id: 'D18',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'DELETE noop once' },
        arrange: () => {
          pushShot('shot-1');
          db.addFault({ needle: 'DELETE FROM outbox', mode: 'noop' });
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
          expect(o['timerDrove']).toBe(true);
        },
      }));

    it('D19 receipt INSERT slow 25 s (no SQLite timeout) → delivered eventually, no stall', () =>
      scenario({
        id: 'D19',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: 'INSERT receipt slow 25s' },
        arrange: () => {
          pushShot('shot-1');
          db.addFault({
            needle: 'INSERT OR REPLACE INTO sync_receipt',
            mode: 'slow',
            slowMs: 25_000,
          });
        },
        afterFault: o => {
          expect(o['drainSettledWithin60s']).toBe(true);
          expect(o['timersAfterFault']).toBe(1);
          expect(db.inner.openTransactions()).toBe(0);
        },
      }));

    it('D20 every 2nd statement rejects for the first 6 statements → converges after heal', () =>
      scenario({
        id: 'D20',
        family: 'sqlite',
        faults: 3,
        inputs: { fault: 'intermittent rejects' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          db.addFault({
            needle: 'SELECT id, kind, payload',
            mode: 'reject',
            times: 1,
          });
          db.addFault({
            needle: 'INSERT OR REPLACE INTO sync_receipt',
            mode: 'reject',
            times: 1,
          });
          db.addFault({ needle: 'count(*)', mode: 'reject', times: 1 });
        },
        afterFault: o => {
          expect(db.inner.openTransactions()).toBe(0);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('D21 a row of another owner is never touched by the faulted drain', () =>
      scenario({
        id: 'D21',
        family: 'sqlite',
        faults: 1,
        inputs: { fault: '503 with foreign owner row' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-b', null, ownerB);
          server.script = [{ kind: 'status', status: 503 }];
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
          const foreign = outboxRowsFor(db, ownerB);
          expect(foreign).toHaveLength(1);
          expect(foreign[0]!.attempts).toBe(0);
          expect(foreign[0]!.last_error).toBeNull();
          expect(
            server.requests.every(r => !r.entityIds.includes('shot-b')),
          ).toBe(true);
        },
        mayRemain: () => false,
      }));
  });

  // ─── A: AppState ─────────────────────────────────────────────────────────

  describe('A AppState', () => {
    it('A01 addEventListener throws → configure throws, no half-armed timer; explicit trigger still drains', () =>
      scenario({
        id: 'A01',
        family: 'appstate',
        faults: 1,
        inputs: { fault: 'addEventListener throws' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          appState.mode = 'throwOnAdd';
        },
        act: async () => {
          // The registration threw before the initial drain ran.
          expect(server.requests).toHaveLength(0);
          expect(runtimeTimers()).toBe(0);
          triggerOutboxSync();
          await flushMicrotasks(30);
        },
        afterFault: o => {
          expect(o['configureError']).toContain(
            'injected AppState.addEventListener',
          );
          expectDelivered(o);
        },
      }));

    // A02 (subscription.remove throws) and A03 (no subscription returned)
    // poison the module-level runtime state for the rest of the process and
    // therefore live in syncRuntimeAppStateTeardown.stress.test.ts, one
    // isolated module registry per case.

    it('A04 listener fires "active" synchronously during registration → one drain, one timer', () =>
      scenario({
        id: 'A04',
        family: 'appstate',
        faults: 1,
        inputs: { fault: 'fireActiveDuringAdd' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          appState.mode = 'fireActiveDuringAdd';
        },
        afterFault: o => {
          expectDelivered(o);
          expect(
            server.requests.filter(r => r.path === '/v1/shots:sync'),
          ).toHaveLength(1);
        },
      }));

    it('A05 1000 "active" events in one tick while the request hangs → one in-flight request, one timer after', () =>
      scenario({
        id: 'A05',
        family: 'appstate',
        faults: 2,
        inputs: { fault: 'hang + 1000 active' },
        explicitTriggers: 1000,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'hang', honorAbort: true }];
        },
        act: async () => {
          for (let i = 0; i < 1000; i += 1) appState.fire('active');
          await flushMicrotasks(10);
          expect(server.requests).toHaveLength(1);
        },
        afterFault: o => {
          expect(o['abortedRequests']).toBe(1);
          expect(o['timersAfterFault']).toBe(1);
          expect(o['maxInFlight'] ?? server.maxInFlight).toBeLessThanOrEqual(1);
        },
      }));

    it('A06 non-active / non-string states never start a drain', () =>
      scenario({
        id: 'A06',
        family: 'appstate',
        faults: 7,
        inputs: {
          states: [
            'background',
            'inactive',
            'unknown',
            'extension',
            undefined,
            null,
            {},
          ],
        },
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'status', status: 503 }];
        },
        act: async () => {
          const before = drainCount(db);
          for (const state of [
            'background',
            'inactive',
            'unknown',
            'extension',
            undefined,
            null,
            {},
          ]) {
            appState.fire(state);
          }
          await flushMicrotasks(10);
          expect(drainCount(db)).toBe(before);
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('A08 "active" after clearSyncRuntime → no request, no timer', () =>
      scenario({
        id: 'A08',
        family: 'appstate',
        faults: 1,
        inputs: { fault: 'active after clear' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'status', status: 503 }];
        },
        act: async () => {
          await advance(1_000);
          clearSyncRuntime();
          const before = server.requests.length;
          appState.fire('active');
          triggerOutboxSync();
          await flushMicrotasks(10);
          expect(server.requests.length).toBe(before);
          expect(runtimeTimers()).toBe(0);
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(0);
          expect(o['timerDrove']).toBe(false);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));

    it('A09 foreground/background storm across 10 minutes while the server flaps → recovers, ≤1 in flight', () =>
      scenario({
        id: 'A09',
        family: 'appstate',
        faults: 12,
        inputs: { flaps: 40 },
        explicitTriggers: 40,
        arrange: () => {
          for (let i = 0; i < 6; i += 1) pushShot(`shot-${i}`);
          const outcomes: FetchOutcome[] = [
            { kind: 'status', status: 503 },
            { kind: 'reject', error: new TypeError('Network request failed') },
            { kind: 'hang', honorAbort: true },
            { kind: 'status', status: 429 },
            { kind: 'slow', ms: 10_000, then: { kind: 'status', status: 500 } },
            { kind: 'jsonRejects' },
          ];
          server.script = [...outcomes, ...outcomes];
        },
        act: async () => {
          for (let i = 0; i < 40; i += 1) {
            appState.fire(i % 2 === 0 ? 'background' : 'active');
            await advance(15_000);
          }
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
        },
      }));
  });

  // ─── S: session / owner store ────────────────────────────────────────────

  describe('S session / owner store', () => {
    it('S01 bearer cleared before the first drain → request goes out unauthenticated, 401 without listener, transient', () =>
      scenario({
        id: 'S01',
        family: 'session',
        faults: 1,
        inputs: { fault: 'no bearer' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          clearApiSession();
          server.script = [{ kind: 'status', status: 401 }];
          const listener = jest.fn();
          setApiUnauthorizedListener(listener);
          (server as unknown as { listener: jest.Mock }).listener = listener;
        },
        act: async () => {
          expect(server.requests[0]!.authorization).toBeNull();
          establishApiSession(sessionFor(USER_A));
        },
        afterFault: o => {
          const listener = (server as unknown as { listener: jest.Mock })
            .listener;
          expect(listener).not.toHaveBeenCalled();
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('S02 bearer rotated while a request hangs → the retry carries the new bearer; the late 401 for the old token is ignored', () =>
      scenario({
        id: 'S02',
        family: 'session',
        faults: 2,
        inputs: { fault: 'hang + rotate' },
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [
            { kind: 'slow', ms: 5_000, then: { kind: 'status', status: 401 } },
          ];
          const listener = jest.fn();
          setApiUnauthorizedListener(listener);
          (server as unknown as { listener: jest.Mock }).listener = listener;
        },
        act: async () => {
          establishApiSession(sessionFor(USER_A, '-rotated'));
        },
        afterFault: o => {
          const listener = (server as unknown as { listener: jest.Mock })
            .listener;
          expect(listener).not.toHaveBeenCalled();
          expect(server.requests[0]!.authorization).toBe(
            `Bearer ${sessionFor(USER_A).bearerToken}`,
          );
          expect(server.requests[1]!.authorization).toBe(
            `Bearer ${sessionFor(USER_A, '-rotated').bearerToken}`,
          );
          // The late 401 is recorded as a transient failure (no attempt
          // consumed, no sign-out); the retry above used the new bearer.
          expectTransient(o, 2, '401');
        },
      }));

    it('S03 session swapped to another account while a request is in flight → old generation stops, new owner isolated', () =>
      scenario({
        id: 'S03',
        family: 'session',
        faults: 1,
        inputs: { fault: 'swap account mid-flight' },
        noRecovery: true,
        maxInFlight: 2,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-b', null, ownerB);
          server.script = [{ kind: 'slow', ms: 5_000, then: { kind: 'ok' } }];
        },
        act: async () => {
          clearSyncRuntime();
          clearApiSession();
          establishApiSession(sessionFor(USER_B));
          setActiveDataOwner(ownerB);
          configureSyncRuntime(sessionFor(USER_B));
          await flushMicrotasks(20);
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
          expect(outboxRowsFor(db, ownerB)).toEqual([]);
          expect(
            uniqueReceipts(db).map(r => `${r.owner.slice(0, 4)}:${r.entityId}`),
          ).toContain(`${ownerB.slice(0, 4)}:shot-b`);
          // A's row was in flight when A signed out: whatever the late
          // response did, it must not have written B-owned state.
          expect(
            uniqueReceipts(db).filter(
              r => r.owner === ownerB && r.entityId === 'shot-1',
            ),
          ).toEqual([]);
          expect(
            server.requests.every(
              r =>
                !(
                  r.entityIds.includes('shot-b') &&
                  r.entityIds.includes('shot-1')
                ),
            ),
          ).toBe(true);
        },
      }));

    it('S04 active owner is signed-out while configured → no drain, 30 s poll, no failure escalation', () =>
      scenario({
        id: 'S04',
        family: 'session',
        faults: 1,
        inputs: { fault: 'owner mismatch signed-out' },
        arrange: () => {
          pushShot('shot-1');
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        },
        act: async () => {
          expect(server.requests).toHaveLength(0);
          expect(runtimeTimers()).toBe(1);
          await advance(SYNC_RETRY_BASE_MS * 3);
          expect(server.requests).toHaveLength(0);
          setActiveDataOwner(ownerA);
          triggerOutboxSync();
          await flushMicrotasks(20);
        },
        afterFault: o => expectDelivered(o),
      }));

    it('S05 active owner is the guest owner → no drain of the signed-in rows', () =>
      scenario({
        id: 'S05',
        family: 'session',
        faults: 1,
        inputs: { fault: 'owner mismatch guest' },
        arrange: () => {
          pushShot('shot-1');
          setActiveDataOwner(GUEST_DATA_OWNER);
        },
        act: async () => {
          expect(server.requests).toHaveLength(0);
          await advance(SYNC_RETRY_BASE_MS * 3);
          expect(server.requests).toHaveLength(0);
          setActiveDataOwner(ownerA);
          triggerOutboxSync();
          await flushMicrotasks(20);
        },
        afterFault: o => expectDelivered(o),
      }));

    it('S06 configure with a non-UUID account id → throws, runtime left empty, trigger is a no-op', () =>
      scenario({
        id: 'S06',
        family: 'session',
        faults: 1,
        inputs: { fault: 'invalid uuid' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
        },
        act: async () => {
          let thrown: string | null = null;
          try {
            configureSyncRuntime({
              ...sessionFor(USER_A),
              canonicalAppUserId: 'not-a-uuid',
            });
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error);
          }
          expect(thrown).toContain('canonical backend UUID');
          expect(runtimeTimers()).toBe(0);
          triggerOutboxSync();
          appState.fire('active');
          await flushMicrotasks(10);
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(0);
          // Everything before the bad configure was already delivered.
          expect(rows(o)).toEqual([]);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));

    it('S07 configure with an upper-case UUID → owner normalised, bearer resolved, rows drained', () =>
      scenario({
        id: 'S07',
        family: 'session',
        faults: 1,
        inputs: { fault: 'uppercase uuid' },
        arrange: () => {
          pushShot('shot-1');
          clearApiSession();
          establishApiSession({
            ...sessionFor(USER_A),
            canonicalAppUserId: USER_A.toUpperCase(),
          });
        },
        configure: () => {
          configureSyncRuntime({
            ...sessionFor(USER_A),
            canonicalAppUserId: USER_A.toUpperCase(),
          });
        },
        afterFault: o => {
          expectDelivered(o);
          expect(server.requests[0]!.authorization).toBe(
            `Bearer ${sessionFor(USER_A).bearerToken}`,
          );
        },
      }));

    it('S08 configure twice in one tick → one listener, one timer; the superseded drain is NOT cancelled (observed request count recorded)', () =>
      scenario({
        id: 'S08',
        family: 'session',
        faults: 1,
        inputs: { fault: 'double configure same tick' },
        maxInFlight: 2,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
        },
        configure: () => {
          configureSyncRuntime(sessionFor(USER_A));
          configureSyncRuntime(sessionFor(USER_A));
        },
        afterFault: o => {
          expectDelivered(o);
          expect(appState.handlers).toHaveLength(1);
          expect(appState.removals).toBe(1);
          o['shotSyncRequests'] = server.requests.filter(
            r => r.path === '/v1/shots:sync',
          ).length;
          expect(o['shotSyncRequests']).toBeGreaterThanOrEqual(1);
        },
      }));

    it('S09 clearSyncRuntime twice → idempotent, zero timers, no request', () =>
      scenario({
        id: 'S09',
        family: 'session',
        faults: 1,
        inputs: { fault: 'double clear' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'status', status: 503 }];
        },
        act: async () => {
          await advance(1_000);
          clearSyncRuntime();
          clearSyncRuntime();
          expect(runtimeTimers()).toBe(0);
        },
        afterFault: o => {
          expect(o['requestsAfterFault']).toBe(1);
          expect(o['timersAfterFault']).toBe(0);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));

    it('S10 clearSyncRuntime while a drain is in flight → the drain finishes, writes its receipts, arms no timer', () =>
      scenario({
        id: 'S10',
        family: 'session',
        faults: 1,
        inputs: { fault: 'clear mid-flight' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'slow', ms: 5_000, then: { kind: 'ok' } }];
        },
        act: async () => {
          clearSyncRuntime();
        },
        afterFault: o => {
          expect(rows(o)).toEqual([]);
          expect(uniqueReceipts(db).map(r => r.entityId)).toEqual(['shot-1']);
          expect(o['timersAfterFault']).toBe(0);
          expect(o['timerDrove']).toBe(false);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));

    it('S11 sign-out + sign-in of the SAME account while a drain hangs → two generations overlap (observed), outbox still converges', () =>
      scenario({
        id: 'S11',
        family: 'session',
        faults: 1,
        inputs: { fault: 'reconfigure same user mid-flight' },
        maxInFlight: 2,
        arrange: () => {
          pushShot('shot-1');
          pushShot('shot-2');
          server.script = [{ kind: 'slow', ms: 10_000, then: { kind: 'ok' } }];
        },
        act: async () => {
          clearSyncRuntime();
          clearApiSession();
          establishApiSession(sessionFor(USER_A, '-2'));
          configureSyncRuntime(sessionFor(USER_A, '-2'));
          await flushMicrotasks(20);
        },
        afterFault: o => {
          expectDelivered(o);
          o['overlappingGenerations'] = server.maxInFlight;
          o['shotSyncRequests'] = server.requests.filter(
            r => r.path === '/v1/shots:sync',
          ).length;
          o['duplicateSends'] = server.requests
            .flatMap(r => r.entityIds)
            .filter((id, i, all) => all.indexOf(id) !== i).length;
        },
      }));

    it('S12 triggerOutboxSync ×1000 while a request hangs → one in-flight request', () =>
      scenario({
        id: 'S12',
        family: 'session',
        faults: 2,
        inputs: { fault: 'hang + 1000 triggers' },
        explicitTriggers: 1000,
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'hang', honorAbort: true }];
        },
        act: async () => {
          for (let i = 0; i < 1000; i += 1) triggerOutboxSync();
          await flushMicrotasks(10);
          expect(server.requests).toHaveLength(1);
        },
        afterFault: o => {
          expect(o['abortedRequests']).toBe(1);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('S13 triggerOutboxSync before any configure → no-op, nothing thrown', () =>
      scenario({
        id: 'S13',
        family: 'session',
        faults: 1,
        inputs: { fault: 'trigger before configure' },
        arrange: () => {
          pushShot('shot-1');
          clearSyncRuntime();
          triggerOutboxSync();
          expect(runtimeTimers()).toBe(0);
        },
        afterFault: o => expectDelivered(o),
      }));
  });

  // ─── C: clock / retry jitter ─────────────────────────────────────────────

  describe('C clock / retry jitter', () => {
    it('C01 Math.random pinned to 0 → minimum cadence 24 s, never faster', () =>
      scenario({
        id: 'C01',
        family: 'clock',
        faults: 1,
        inputs: { random: 0 },
        explicitTriggers: 0,
        arrange: () => {
          pushShot('shot-1');
          Math.random = () => 0;
          server.defaultOutcome = { kind: 'status', status: 503 };
        },
        afterFault: o => {
          const gaps = server.requests
            .slice(1)
            .map((r, i) => r.atMs - server.requests[i]!.atMs);
          for (const gap of gaps) {
            expect(gap).toBeGreaterThanOrEqual(
              SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO) - 1,
            );
          }
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('C02 Math.random pinned to 1 → maximum jitter, backoff capped at SYNC_RETRY_MAX_MS × 1.2', () =>
      scenario({
        id: 'C02',
        family: 'clock',
        faults: 1,
        inputs: { random: 1 },
        arrange: () => {
          pushShot('shot-1');
          Math.random = () => 1;
          server.defaultOutcome = { kind: 'status', status: 503 };
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(1);
          for (let n = 0; n < 40; n += 1) {
            expect(nextSyncRetryDelayMs(n, () => 1)).toBeLessThanOrEqual(
              SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO),
            );
          }
        },
      }));

    it('C03 Math.random returns NaN → retry delay NaN (observed: fires at once); still ≤1 in flight, recovers', () =>
      scenario({
        id: 'C03',
        family: 'clock',
        faults: 1,
        inputs: { random: 'NaN' },
        explicitTriggers: 100,
        arrange: () => {
          pushShot('shot-1');
          Math.random = () => NaN;
          server.script = [{ kind: 'status', status: 503 }];
        },
        afterFault: o => {
          o['delayWithNaN'] = nextSyncRetryDelayMs(0, () => NaN);
          expect(o['timersAfterFault']).toBe(1);
        },
      }));

    it('C05 consecutive failures escalate 60 s → 120 → 240 → 300 (cap) and drop back to the 30 s base after one success', () =>
      scenario({
        id: 'C05',
        family: 'clock',
        faults: 6,
        inputs: { failures: 6 },
        arrange: () => {
          pushShot('shot-1');
          Math.random = () => 0.5;
          server.script = Array.from({ length: 6 }, () => ({
            kind: 'status' as const,
            status: 503,
          }));
        },
        act: async () => {
          // Jitter pinned to 0: requests at 0, 60, 180, 420, 720, 1020 s
          // (six 503s) and the first success at 1320 s.
          await advance(1_320_000);
          expect(server.requests).toHaveLength(7);
          // A new row after the success must ride the 30 s base cadence.
          pushShot('shot-2');
          await advance(30_000);
        },
        afterFault: o => {
          const gaps = server.requests
            .slice(1)
            .map((r, i) => r.atMs - server.requests[i]!.atMs);
          o['gapsMs'] = gaps;
          // consecutiveFailures is incremented BEFORE the delay is computed,
          // so the first retry after a failure already waits 2 × base.
          expect(gaps.slice(0, 6)).toEqual([
            60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
          ]);
          // After the first success (request 7) the cadence is back at base.
          expect(gaps[6]).toBe(30_000);
        },
      }));

    it('C06 timer cleared on clearSyncRuntime → nothing fires after 10 minutes', () =>
      scenario({
        id: 'C06',
        family: 'clock',
        faults: 1,
        inputs: { fault: 'clear then wait 10 min' },
        noRecovery: true,
        arrange: () => {
          pushShot('shot-1');
          server.script = [{ kind: 'status', status: 503 }];
        },
        act: async () => {
          await advance(1_000);
          clearSyncRuntime();
          await advance(10 * 60_000);
          expect(server.requests).toHaveLength(1);
        },
        afterFault: o => {
          expect(o['timersAfterFault']).toBe(0);
          configureSyncRuntime(sessionFor(USER_A));
        },
      }));
  });

  // ─── KNOWN BROKEN: unsettled dependency promises wedge the generation ────

  describe('KNOWN BROKEN — FI-1: a dependency promise that never settles inside a drain wedges the runtime generation', () => {
    async function wedge(
      id: string,
      label: string,
      arrange: () => void,
    ): Promise<void> {
      await recordFault(
        SUITE,
        'wedge',
        id,
        null,
        { fault: label },
        async o => {
          pushShot('shot-1');
          pushShot('shot-2');
          arrange();
          configureSyncRuntime(sessionFor(USER_A));
          await flushMicrotasks(20);
          await advance(SPINNER_WINDOW_MS);
          o['timersAfter60s'] = runtimeTimers();
          o['drainsCompleted'] = drainsCompleted(db);
          const drainsBefore = drainCount(db);
          const requestsBefore = server.requests.length;
          // The retry control and the foreground event are both ignored…
          triggerOutboxSync();
          appState.fire('active');
          for (let i = 0; i < 100; i += 1) appState.fire('active');
          await flushMicrotasks(20);
          await advance(LIVENESS_WINDOW_MS);
          await advance(LIVENESS_WINDOW_MS);
          o['drainsStartedDuringLiveness'] = drainCount(db) - drainsBefore;
          o['requestsDuringLiveness'] = server.requests.length - requestsBefore;
          o['rows'] = rowsSnapshot();
          o['queueStatus'] = queueStatus();
          // …until the runtime is reconfigured (sign-in / relaunch path).
          healEverything();
          clearSyncRuntime();
          configureSyncRuntime(sessionFor(USER_A));
          await flushMicrotasks(30);
          await advance(LIVENESS_WINDOW_MS);
          o['rowsAfterReconfigure'] = rowsSnapshot();
          o['violations'] = persistedStateViolations(db, server, enqueued);
          o['unhandledRejections'] = sentinel.take();

          // Pinned CURRENT behaviour (the finding):
          expect(o['timersAfter60s']).toBe(0);
          expect(o['drainsStartedDuringLiveness']).toBe(0);
          expect(o['requestsDuringLiveness']).toBe(0);
          // Rows stay queued, silently — no last_error was recorded either.
          expect(o['queueStatus']).toEqual({ state: 'queued', pending: 2 });
          // What still holds: no corruption, no fake success, and the
          // reconfigure path recovers everything.
          expect(o['violations']).toEqual([]);
          expect(o['unhandledRejections']).toEqual([]);
          expect(o['rowsAfterReconfigure']).toEqual([]);
          expect(runtimeTimers()).toBe(1);
          return 1;
        },
        { knownBroken: true },
      );
    }

    it('F06 fetch hangs and IGNORES the abort signal (INFERRED unreachable with RN whatwg-fetch, which honours xhr.abort)', () =>
      wedge('F06', 'fetch hang ignoring abort', () => {
        server.script = [{ kind: 'hang', honorAbort: false }];
      }));

    it('F44 response.json() never settles (INFERRED unreachable with RN whatwg-fetch: the body is fully buffered before fetch resolves)', () =>
      wedge('F44', 'json() hangs', () => {
        server.script = [{ kind: 'jsonHangs' }];
      }));

    it('D03 outbox SELECT never settles (SQLite driver hang — UNKNOWN whether op-sqlite can do this)', () =>
      wedge('D03', 'SELECT hang', () => {
        db.addFault({ needle: 'SELECT id, kind, payload', mode: 'hang' });
      }));

    it('D11 receipt INSERT never settles inside the transaction → generation wedged with an OPEN transaction', () =>
      recordFault(
        SUITE,
        'wedge',
        'D11',
        null,
        { fault: 'INSERT receipt hang' },
        async o => {
          pushShot('shot-1');
          db.addFault({
            needle: 'INSERT OR REPLACE INTO sync_receipt',
            mode: 'hang',
          });
          configureSyncRuntime(sessionFor(USER_A));
          await flushMicrotasks(20);
          await advance(SPINNER_WINDOW_MS);
          await advance(LIVENESS_WINDOW_MS);
          o['timers'] = runtimeTimers();
          o['openTransactions'] = db.inner.openTransactions();
          o['queueStatus'] = queueStatus();
          expect(o['timers']).toBe(0);
          expect(o['openTransactions']).toBe(1);
          expect(o['queueStatus']).toEqual({ state: 'queued', pending: 1 });
          expect(sentinel.take()).toEqual([]);
          return 1;
        },
        { knownBroken: true },
      ));
  });
});
