/**
 * stress / mod-sync-runtime — seeded RANDOMIZED campaign: reconnect storms
 * and AppState flaps against the real `syncRuntime.ts` + `drainOutbox`.
 *
 * Each iteration is fully determined by its seed: a random outbox (owner A
 * shots / sessions / trials, plus owner-B rows that must never be uploaded
 * under A), a random fault script for the fake server (statuses, throws,
 * rejects, abort-honouring hangs, slow answers, malformed bodies, partial
 * verdicts), random SQLite faults, and a random timeline of foreground /
 * background flaps, `triggerOutboxSync` bursts, bearer rotations and rows
 * arriving mid-storm. Never-settling dependencies are excluded here on
 * purpose — the catalog suite pins those as KNOWN_BROKEN (FI-1).
 *
 * After the storm every fault is lifted and the retry control is exercised
 * once (`triggerOutboxSync` + one `active`): within 60 s of fake time the
 * queue must be idle, or `needs_attention` only for rows whose attempts are
 * exhausted. Invariants on top: one in-flight request at a time, bounded
 * request cadence, no receipt without server acceptance, no row deleted
 * without a receipt, no cross-owner upload, no orphaned transaction, no
 * unhandled rejection, exactly one retry timer at rest.
 *
 * Scale: `STRESS_ITER` seeds per family (default 24 → 48 iterations).
 * Replay one seed: `STRESS_SEED=<n> npx jest --ci <this file> -t 'seed <n>'`.
 */
import { AppState } from 'react-native';
import { getDb } from '../../src/data/db';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { API_REQUEST_TIMEOUT_MS } from '../../src/data/api';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
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
  flushFaultRecords,
  flushMicrotasks,
  maxRequestsInAnyMinute,
  outboxRowsFor,
  persistedStateViolations,
  recordFault,
  seededRng,
  sessionFor,
  sessionPayload,
  shotPayload,
  stressSeeds,
  trialPayload,
  unhandledRejectionSentinel,
  uniqueReceipts,
  type AppStateHarness,
  type DbFault,
  type EnqueuedRow,
  type FakeServer,
  type FaultingDb,
  type FetchOutcome,
  type Rng,
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

const SUITE = 'syncRuntimeReconnectStorm';
const RECOVERY_WINDOW_MS = 60_000;

const ownerA = canonicalDataOwner(USER_A);
const ownerB = canonicalDataOwner(USER_B);

const sentinel = unhandledRejectionSentinel();
const realFetch = globalThis.fetch;

let db: FaultingDb;
let server: FakeServer;
let appState: AppStateHarness;
let enqueued: EnqueuedRow[];
/** Fake-clock timestamps of every drain start (`getDb()` is called exactly
 * once per drain by the runtime). */
let drainStartsMs: number[];
const realRandom = Math.random;

// ─── Plan generation (pure function of the seed) ───────────────────────────

type RowPlan =
  | {
      kind: 'shot.sync';
      id: string;
      sessionId: string | null;
      owner: 'A' | 'B';
    }
  | { kind: 'session.create'; id: string; owner: 'A' }
  | { kind: 'evaluation.trial'; id: string; owner: 'A' };

type EventPlan =
  | { atMs: number; kind: 'active' }
  | { atMs: number; kind: 'background' }
  | { atMs: number; kind: 'inactive' }
  | { atMs: number; kind: 'flap'; count: number }
  | { atMs: number; kind: 'trigger'; count: number }
  | { atMs: number; kind: 'rotateBearer'; suffix: string }
  | { atMs: number; kind: 'pushShot'; id: string };

interface Plan {
  family: Family;
  seed: number;
  rows: RowPlan[];
  script: FetchOutcome[];
  dbFaults: DbFault[];
  events: EventPlan[];
  stormMs: number;
  /** Distinct injected faults (server script entries that are not `ok`,
   * plus SQLite faults) — counted, never estimated. */
  faults: number;
}

type Family = 'reconnect-storm' | 'appstate-flap';

const TRANSIENT_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;
const PERMANENT_STATUSES = [400, 403, 404, 409, 413, 422] as const;

function randomOutcome(
  rng: Rng,
  ids: readonly string[],
  depth = 0,
): FetchOutcome {
  const someId = () => rng.pick(ids);
  const kind = rng.weighted<string>([
    ['ok', 30],
    ['transientStatus', 22],
    ['permanentStatus', 5],
    ['throwSync', 6],
    ['reject', 8],
    ['hangAbort', 6],
    ['slow', depth === 0 ? 8 : 0],
    ['body', 5],
    ['nonResponse', 3],
    ['jsonRejects', 3],
    ['jsonThrows', 2],
    ['okFalse200', 2],
    ['partial', 6],
  ]);
  switch (kind) {
    case 'ok':
      return { kind: 'ok' };
    case 'transientStatus':
      return {
        kind: 'status',
        status: rng.pick(TRANSIENT_STATUSES),
        nonJson: rng.chance(0.3),
      };
    case 'permanentStatus':
      return {
        kind: 'status',
        status: rng.pick(PERMANENT_STATUSES),
        nonJson: rng.chance(0.3),
      };
    case 'throwSync':
      return {
        kind: 'throwSync',
        error: new TypeError('Network request failed'),
      };
    case 'reject':
      return { kind: 'reject', error: new TypeError('Network request failed') };
    case 'hangAbort':
      return { kind: 'hang', honorAbort: true };
    case 'slow':
      return {
        kind: 'slow',
        ms: rng.int(500, API_REQUEST_TIMEOUT_MS + 5_000),
        then: randomOutcome(rng, ids, depth + 1),
      };
    case 'body':
      return {
        kind: 'body',
        body: rng.pick<unknown>([
          null,
          'oops',
          42,
          [],
          { accepted: someId() },
          { accepted: null, rejected: null },
          { results: [] },
          { accepted: [{ id: someId() }] },
          { accepted: [], rejected: [{ id: someId() }] },
          { accepted: [], rejected: [{ id: someId(), code: 42 }] },
        ]),
      };
    case 'nonResponse':
      return {
        kind: 'nonResponse',
        value: rng.pick<unknown>([undefined, null, 'x', {}]),
      };
    case 'jsonRejects':
      return { kind: 'jsonRejects' };
    case 'jsonThrows':
      return { kind: 'jsonThrows' };
    case 'okFalse200':
      return { kind: 'okFalse200' };
    default: {
      // Partial verdict: some ids accepted, one rejected, the rest unmentioned.
      const accept = ids.filter(() => rng.chance(0.5));
      return {
        kind: 'ok',
        accept,
        reject: [
          {
            id: someId(),
            code: rng.pick([
              'shot.write_failed',
              'shot.invalid',
              'shot.session_not_found',
            ]),
          },
        ],
      };
    }
  }
}

function isFault(outcome: FetchOutcome): boolean {
  if (outcome.kind !== 'ok') return true;
  return outcome.accept !== undefined || outcome.reject !== undefined;
}

const DB_NEEDLES = [
  'SELECT id, kind, payload',
  'INSERT OR REPLACE INTO sync_receipt',
  'DELETE FROM outbox',
  'COMMIT',
  'UPDATE outbox SET',
  'SELECT 1 FROM sync_receipt',
] as const;

function randomDbFaults(rng: Rng): DbFault[] {
  const faults: DbFault[] = [];
  const count = rng.weighted([
    [0, 40],
    [1, 35],
    [2, 20],
    [3, 5],
  ]);
  for (let i = 0; i < count; i += 1) {
    const needle = rng.pick(DB_NEEDLES);
    // A statement that silently does nothing is only a real SQLite shape
    // for reads (an empty result set); writes either apply or throw.
    const mode = rng.weighted<DbFault['mode']>([
      ['reject', 40],
      ['throwSync', 20],
      ['slow', 30],
      ['noop', needle.startsWith('SELECT') ? 10 : 0],
    ]);
    faults.push({
      needle,
      mode,
      times: rng.int(1, 3),
      ...(mode === 'slow' ? { slowMs: rng.int(100, 4_000) } : {}),
    });
  }
  return faults;
}

function buildPlan(family: Family, seed: number): Plan {
  const rng = seededRng(seed);
  const rows: RowPlan[] = [];
  const shotCount = rng.int(1, 12);
  const sessionCount = rng.int(0, 2);
  for (let s = 0; s < sessionCount; s += 1) {
    rows.push({ kind: 'session.create', id: `sess-${seed}-${s}`, owner: 'A' });
  }
  for (let i = 0; i < shotCount; i += 1) {
    const sessionId =
      sessionCount > 0 && rng.chance(0.4)
        ? `sess-${seed}-${rng.int(0, sessionCount - 1)}`
        : null;
    rows.push({
      kind: 'shot.sync',
      id: `shot-${seed}-${i}`,
      sessionId,
      owner: 'A',
    });
  }
  if (rng.chance(0.3)) {
    rows.push({ kind: 'evaluation.trial', id: `trial-${seed}`, owner: 'A' });
  }
  const bCount = rng.int(0, 3);
  for (let i = 0; i < bCount; i += 1) {
    rows.push({
      kind: 'shot.sync',
      id: `shot-b-${seed}-${i}`,
      sessionId: null,
      owner: 'B',
    });
  }

  const shotIds = rows
    .filter(r => r.kind === 'shot.sync' && r.owner === 'A')
    .map(r => r.id);
  const scriptLength =
    family === 'reconnect-storm' ? rng.int(6, 30) : rng.int(2, 10);
  const script: FetchOutcome[] = [];
  for (let i = 0; i < scriptLength; i += 1) {
    script.push(randomOutcome(rng, shotIds));
  }

  const dbFaults = randomDbFaults(rng);

  const stormMs = rng.int(2, 10) * 60_000;
  const events: EventPlan[] = [];
  const eventCount =
    family === 'appstate-flap' ? rng.int(10, 40) : rng.int(2, 12);
  for (let i = 0; i < eventCount; i += 1) {
    const atMs = rng.int(0, stormMs);
    const kind = rng.weighted<EventPlan['kind']>(
      family === 'appstate-flap'
        ? [
            ['active', 30],
            ['background', 20],
            ['inactive', 10],
            ['flap', 25],
            ['trigger', 5],
            ['rotateBearer', 5],
            ['pushShot', 5],
          ]
        : [
            ['active', 20],
            ['background', 10],
            ['inactive', 5],
            ['flap', 5],
            ['trigger', 25],
            ['rotateBearer', 15],
            ['pushShot', 20],
          ],
    );
    switch (kind) {
      case 'flap':
        events.push({ atMs, kind, count: rng.int(2, 20) });
        break;
      case 'trigger':
        events.push({ atMs, kind, count: rng.int(1, 10) });
        break;
      case 'rotateBearer':
        events.push({ atMs, kind, suffix: `-r${i}` });
        break;
      case 'pushShot':
        events.push({ atMs, kind, id: `shot-${seed}-late-${i}` });
        break;
      default:
        events.push({ atMs, kind });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);

  const faults = script.filter(isFault).length + dbFaults.length;
  return { family, seed, rows, script, dbFaults, events, stormMs, faults };
}

// ─── Fixture wiring (same boundary doubles as the catalog suite) ───────────

function push(row: RowPlan): EnqueuedRow {
  const owner = row.owner === 'A' ? ownerA : ownerB;
  const payload =
    row.kind === 'shot.sync'
      ? shotPayload(row.id, row.sessionId)
      : row.kind === 'session.create'
        ? sessionPayload(row.id)
        : trialPayload(row.id);
  db.inner.push(row.kind, payload, owner);
  const inserted = db.inner.outbox[db.inner.outbox.length - 1]!;
  const record = {
    id: inserted.id,
    owner,
    kind: row.kind,
    entityId: row.id,
    wellFormed: true,
  };
  enqueued.push(record);
  return record;
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

function runtimeTimers(): number {
  return jest.getTimerCount() - db.pendingSlow - server.pendingSlow;
}

/** Max drains started in any sliding 60 s window of fake time. */
function maxDrainsInAnyMinute(): number {
  const times = [...drainStartsMs].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi]! - times[lo]! > 60_000) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/** Every request must carry an owner-A bearer and only owner-A entities. */
function crossOwnerViolations(): string[] {
  const out: string[] = [];
  const ownerOf = new Map<string, string>();
  for (const row of enqueued) ownerOf.set(row.entityId, row.owner);
  for (const request of server.requests) {
    if (
      !request.authorization?.startsWith(`Bearer bearer-${USER_A.slice(0, 4)}`)
    ) {
      out.push(
        `request #${request.seq} bearer ${request.authorization ?? 'null'}`,
      );
    }
    for (const entityId of request.entityIds) {
      const owner = ownerOf.get(entityId);
      if (owner !== undefined && owner !== ownerA) {
        out.push(`request #${request.seq} carried owner-B entity ${entityId}`);
      }
    }
  }
  return out;
}

async function runIteration(
  plan: Plan,
  o: Record<string, unknown>,
): Promise<number> {
  // Retry jitter draws from the seed too, so the whole run replays.
  const jitter = seededRng(plan.seed ^ 0x9e3779b9);
  Math.random = () => jitter.next();
  for (const row of plan.rows) push(row);
  server.script = [...plan.script];
  server.strictSessions = false;
  for (const fault of plan.dbFaults) db.addFault({ ...fault });
  o['plan'] = {
    rows: plan.rows.length,
    ownerBRows: plan.rows.filter(r => r.owner === 'B').length,
    script: plan.script.map(s =>
      s.kind === 'status'
        ? `status:${s.status}`
        : s.kind === 'slow'
          ? `slow:${s.ms}>${s.then.kind}`
          : s.kind,
    ),
    dbFaults: plan.dbFaults.map(f => `${f.mode}@${f.needle}`),
    events: plan.events.map(e => `${e.atMs}:${e.kind}`),
    stormMs: plan.stormMs,
  };

  configureSyncRuntime(sessionFor(USER_A));
  await flushMicrotasks(20);

  // ── storm: replay the timeline in fake time ─────────────────────────
  let now = 0;
  let explicitEvents = 0;
  for (const event of plan.events) {
    if (event.atMs > now) {
      await advance(event.atMs - now, 1_000);
      now = event.atMs;
    }
    switch (event.kind) {
      case 'active':
        appState.fire('active');
        explicitEvents += 1;
        break;
      case 'background':
        appState.fire('background');
        break;
      case 'inactive':
        appState.fire('inactive');
        break;
      case 'flap':
        for (let i = 0; i < event.count; i += 1) {
          appState.fire(i % 2 === 0 ? 'background' : 'active');
        }
        explicitEvents += Math.floor(event.count / 2);
        break;
      case 'trigger':
        for (let i = 0; i < event.count; i += 1) triggerOutboxSync();
        explicitEvents += event.count;
        break;
      case 'rotateBearer':
        establishApiSession(sessionFor(USER_A, event.suffix));
        break;
      case 'pushShot':
        push({ kind: 'shot.sync', id: event.id, sessionId: null, owner: 'A' });
        triggerOutboxSync();
        explicitEvents += 1;
        break;
      default: {
        const never: never = event;
        throw new Error(`unknown event ${String(never)}`);
      }
    }
    await flushMicrotasks(4);
  }
  if (plan.stormMs > now) await advance(plan.stormMs - now, 1_000);

  o['explicitEvents'] = explicitEvents;
  o['requestsDuringStorm'] = server.requests.length;
  o['drainsDuringStorm'] = drainCount(db);
  o['maxInFlightDuringStorm'] = server.maxInFlight;
  o['rowsAfterStorm'] = outboxRowsFor(db, ownerA).map(r => ({
    id: r.id,
    attempts: r.attempts,
    lastError: r.last_error,
  }));
  o['queueAfterStorm'] = queueStatus();
  o['scriptLeft'] = server.script.length;
  o['dbFaultsLeft'] = db.faults.reduce(
    (n, f) => n + (f as DbFault & { remaining: number }).remaining,
    0,
  );

  // ── heal + retry control → recovery within 60 s ─────────────────────
  server.script = [];
  server.defaultOutcome = { kind: 'ok' };
  db.clearFaults();
  // Let whatever is in flight (≤ one request, ≤ 20 s) settle first.
  await advance(API_REQUEST_TIMEOUT_MS + 5_000, 1_000);
  const drainsBeforeControl = drainCount(db);
  triggerOutboxSync();
  appState.fire('active');
  await flushMicrotasks(30);
  o['controlDrove'] = drainCount(db) > drainsBeforeControl;
  let recoveredAtMs: number | null = null;
  for (let t = 0; t <= RECOVERY_WINDOW_MS; t += 1_000) {
    const pending = outboxRowsFor(db, ownerA).filter(
      r => r.attempts < OUTBOX_MAX_ATTEMPTS,
    );
    if (pending.length === 0 && server.inFlight === 0 && db.hanging === 0) {
      recoveredAtMs = t;
      break;
    }
    await advance(1_000, 1_000);
  }
  o['recoveredAtMs'] = recoveredAtMs;
  o['queueAfterRecovery'] = queueStatus();
  o['rowsAfterRecovery'] = outboxRowsFor(db, ownerA).map(r => ({
    id: r.id,
    attempts: r.attempts,
    lastError: r.last_error,
  }));
  o['ownerBRowsIntact'] = outboxRowsFor(db, ownerB).length;
  o['requestsTotal'] = server.requests.length;
  o['drainsTotal'] = drainStartsMs.length;
  o['maxInFlight'] = server.maxInFlight;
  o['maxRequestsInAnyMinute'] = maxRequestsInAnyMinute(server);
  o['maxDrainsInAnyMinute'] = maxDrainsInAnyMinute();
  o['receipts'] = uniqueReceipts(db).length;
  o['timersAtRest'] = runtimeTimers();
  o['violations'] = persistedStateViolations(db, server, enqueued);
  o['crossOwner'] = crossOwnerViolations();
  o['unhandledRejections'] = sentinel.take();

  // ── invariants ──────────────────────────────────────────────────────
  expect(o['controlDrove']).toBe(true);
  expect(recoveredAtMs).not.toBeNull();
  const after = queueStatus();
  if (after.state === 'needs_attention') {
    expect(after.pending).toBe(0);
    for (const row of outboxRowsFor(db, ownerA)) {
      expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(row.last_error).not.toBeNull();
    }
  } else {
    expect(after).toEqual({ state: 'idle' });
  }
  expect(o['ownerBRowsIntact']).toBe(
    plan.rows.filter(r => r.owner === 'B').length,
  );
  expect(server.maxInFlight).toBeLessThanOrEqual(1);
  // Timer cadence alone is ≤ 4 drains / min (30 s base − 20 % jitter);
  // every explicit foreground / trigger event may add at most one drain.
  // A drain issues one request per session row + one per shot batch + one
  // per trial batch, so cadence is bounded on drains, not requests.
  expect(maxDrainsInAnyMinute()).toBeLessThanOrEqual(4 + explicitEvents + 1);
  expect(o['violations']).toEqual([]);
  expect(o['crossOwner']).toEqual([]);
  expect(o['unhandledRejections']).toEqual([]);
  expect(runtimeTimers()).toBe(1);
  return plan.faults;
}

// ─── Suite ─────────────────────────────────────────────────────────────────

describe('stress/mod-sync-runtime failure-injection — seeded reconnect storms / AppState flaps', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    db = createFaultingDb();
    server = createFakeServer();
    appState = createAppStateHarness();
    enqueued = [];
    drainStartsMs = [];
    (getDb as jest.Mock).mockImplementation(() => {
      drainStartsMs.push(Date.now());
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
    Math.random = realRandom;
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    globalThis.fetch = realFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    sentinel.dispose();
    flushFaultRecords(SUITE);
  });

  for (const family of ['reconnect-storm', 'appstate-flap'] as const) {
    describe(family, () => {
      for (const seed of stressSeeds(family)) {
        const plan = buildPlan(family, seed);
        it(`seed ${seed}: ${plan.rows.length} rows, ${plan.script.length} scripted answers, ${plan.dbFaults.length} sqlite faults, ${plan.events.length} events over ${plan.stormMs / 60_000} min`, async () => {
          await recordFault(
            SUITE,
            family,
            `seed:${seed}`,
            seed,
            {
              replay: `STRESS_SEED=${seed} npx jest --ci __tests__/stress/syncRuntimeReconnectStorm.stress.test.ts -t '${family} seed ${seed}'`,
              rows: plan.rows.length,
              scriptLength: plan.script.length,
              dbFaults: plan.dbFaults.length,
              events: plan.events.length,
              stormMs: plan.stormMs,
            },
            o => runIteration(plan, o),
          );
        });
      }
    });
  }
});
