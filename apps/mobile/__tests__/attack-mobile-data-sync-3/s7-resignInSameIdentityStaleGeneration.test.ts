/**
 * Adversarial pass 3 / scenario 7 — sign-out + re-sign-in as the SAME
 * canonical identity while a drain from the previous sync-runtime generation
 * is still in flight.
 *
 *  HELD   the stale generation's NEXT request resolves the fresh bearer through
 *         `bearerTokenFor()` (same canonical id → new access token), and the
 *         stale generation never reschedules or re-arms an AppState listener.
 *  OBSERVED  `runningGenerations` is keyed per generation, so the fresh
 *         generation's immediate drain runs CONCURRENTLY with the stale one
 *         over the same owner rows: the same shot is POSTed twice (once per
 *         bearer) and a permanent rejection burns two attempts for one logical
 *         cycle. On a single SQLite connection the two drains' receipt
 *         transactions can also interleave (`BEGIN IMMEDIATE` inside an open
 *         transaction is a SQLite error) — modelled here with SQLite
 *         transaction semantics in the fake.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
import { getDb } from '../../src/data/db';

const CANONICAL = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const owner = canonicalDataOwner(CANONICAL);

function session(bearer: string, id = CANONICAL): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken: bearer,
    canonicalAppUserId: id,
    provider: 'apple',
  };
}

// --- stateful outbox with SQLite transaction semantics --------------------

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function fakeDb() {
  const state = {
    outbox: [] as OutboxRow[],
    receipts: [] as string[],
    nextId: 1,
  };
  const log: string[] = [];
  let snapshot: typeof state | null = null;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const db: LocalDb = {
    async execute(rawSql, params = []) {
      const sql = norm(rawSql);
      log.push(sql);
      if (sql === 'BEGIN IMMEDIATE') {
        if (snapshot)
          throw new Error('cannot start a transaction within a transaction');
        snapshot = JSON.parse(JSON.stringify(state));
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        if (!snapshot)
          throw new Error('cannot commit - no transaction is active');
        snapshot = null;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        if (!snapshot)
          throw new Error('cannot rollback - no transaction is active');
        Object.assign(state, snapshot);
        snapshot = null;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload, attempts FROM outbox')) {
        const [o, cap] = params as [string, number];
        return {
          rows: state.outbox
            .filter(r => r.owner_key === o && r.attempts < cap)
            .map(r => ({
              id: r.id,
              kind: r.kind,
              payload: r.payload,
              attempts: r.attempts,
            })),
        };
      }
      if (
        sql.startsWith(
          'UPDATE outbox SET attempts = attempts + 1, last_error = ?',
        )
      ) {
        const [err, o, id] = params as [string, string, number];
        for (const r of state.outbox) {
          if (r.owner_key === o && r.id === id) {
            r.attempts += 1;
            r.last_error = err;
          }
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox SET last_error = ?')) {
        const [err, o, id] = params as [string, string, number];
        for (const r of state.outbox)
          if (r.owner_key === o && r.id === id) r.last_error = err;
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const [o, id] = params as [string, number];
        state.outbox = state.outbox.filter(
          r => !(r.owner_key === o && r.id === id),
        );
        return { rows: [] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
        state.receipts.push(String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*) AS n FROM outbox')) {
        const [o] = params as [string];
        return {
          rows: [{ n: state.outbox.filter(r => r.owner_key === o).length }],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const seed = (kind: string, payload: Record<string, unknown>, o = owner) => {
    state.outbox.push({
      id: state.nextId++,
      owner_key: o,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, state, log, seed };
}

const shotPayload = (id: string) => ({
  id,
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-30T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1, endMs: 2 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7,
  analysisConfidence: 0.8,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'm',
    poseModelVersion: 'p',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 's',
    phaseModelVersion: 'ph',
    scoringModelVersion: 'sc',
    shotConfigVersion: 'c',
  },
  source: 'real',
  analysisPermitId: `permit-${id}`,
});

// --- controllable fetch -----------------------------------------------------

interface Captured {
  url: string;
  bearer: string | null;
  body: unknown;
  resolve: (body: unknown, status?: number) => void;
}

function controllableFetch() {
  const calls: Captured[] = [];
  const waiters: Array<() => void> = [];
  const fetchMock = jest.fn(
    (url: string, init?: RequestInit) =>
      new Promise<Response>(resolve => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers['authorization'] ?? null;
        calls.push({
          url,
          bearer: auth ? auth.replace(/^Bearer /, '') : null,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          resolve: (body, status = 200) =>
            resolve({
              ok: status < 300,
              status,
              statusText: 'x',
              json: async () => body,
            } as unknown as Response),
        });
        waiters.splice(0).forEach(w => w());
      }),
  );
  const nextCall = (): Promise<Captured> =>
    new Promise(resolve => {
      const idx = calls.length;
      const check = () => {
        if (calls.length > idx) resolve(calls[idx]!);
        else waiters.push(check);
      };
      check();
    });
  return { fetchMock, calls, nextCall };
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  });
});
afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  delete (globalThis as { fetch?: unknown }).fetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  jest.advanceTimersByTime(0);
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('attack S7 — re-sign-in as the SAME canonical id during an in-flight drain', () => {
  it('the stale generation resolves the FRESH bearer for its next request and never reschedules', async () => {
    const { db, seed, state } = fakeDb();
    (getDb as jest.Mock).mockReturnValue(db);
    seed('session.create', {
      id: 'sess-1',
      startedAt: '2026-08-30T09:00:00.000Z',
    });
    seed('shot.sync', shotPayload('shot-1'));
    const { fetchMock, calls, nextCall } = controllableFetch();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const addListener = jest.spyOn(AppState, 'addEventListener');

    // Generation A signs in and drains: first request is the session row.
    setActiveDataOwner(owner);
    establishApiSession(session('bearer-A'));
    configureSyncRuntime(session('bearer-A'));
    const first = await nextCall();
    expect(first.url).toBe('https://api.test/v1/sessions');
    expect(first.bearer).toBe('bearer-A');

    // Sign out (authStore.clearSyncedRuntime order) and re-sign-in as the
    // same identity with a rotated access token. Generation B will start
    // its own drain immediately — hold its request(s) for now.
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(owner);
    establishApiSession(session('bearer-B'));
    configureSyncRuntime(session('bearer-B'));
    const genBFirst = await nextCall();
    expect(genBFirst.bearer).toBe('bearer-B');

    // Let the STALE drain continue: its next request (the shot batch) must
    // carry bearer-B — bearerTokenFor(sameCanonicalId) → the fresh session.
    first.resolve({ ok: true });
    const staleSecond = await nextCall();
    expect(staleSecond.url).toBe('https://api.test/v1/shots:sync');
    expect(staleSecond.bearer).toBe('bearer-B');
    expect(
      (staleSecond.body as { shots: Array<{ id: string }> }).shots.map(
        s => s.id,
      ),
    ).toEqual(['shot-1']);

    // Finish both drains with acceptance.
    staleSecond.resolve({ acceptedIds: ['shot-1'], rejected: [] });
    await settle();
    genBFirst.resolve({ ok: true });
    await settle();
    for (const c of calls.filter(
      c => c.url.endsWith('/v1/shots:sync') && c !== staleSecond,
    )) {
      c.resolve({ acceptedIds: ['shot-1'], rejected: [] });
    }
    await settle();

    // Only ONE AppState listener was left armed (generation B's); the
    // stale generation's listener was removed on clearSyncRuntime.
    expect(addListener).toHaveBeenCalledTimes(2);
    const removeCalls = addListener.mock.results.map(
      r => r.value as { remove: jest.Mock },
    );
    expect(removeCalls).toHaveLength(2);

    // Advance past the retry ceiling: only generation B's timer fires drains.
    const callsBefore = calls.length;
    jest.advanceTimersByTime(6 * 60_000);
    await settle();
    const newCalls = calls.slice(callsBefore);
    // Outbox is empty after acceptance → a drain issues no requests at all.
    expect(newCalls).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(
      state.receipts.filter(r => r === 'shot-1').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('re-sign-in as a DIFFERENT canonical id: the stale drain issues its next request with NO bearer (fail closed)', async () => {
    const { db, seed } = fakeDb();
    (getDb as jest.Mock).mockReturnValue(db);
    seed('session.create', { id: 'sess-1' });
    seed('shot.sync', shotPayload('shot-1'));
    const { fetchMock, nextCall, calls } = controllableFetch();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    setActiveDataOwner(owner);
    establishApiSession(session('bearer-A'));
    configureSyncRuntime(session('bearer-A'));
    const first = await nextCall();
    expect(first.bearer).toBe('bearer-A');

    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(canonicalDataOwner(OTHER));
    establishApiSession(session('bearer-OTHER', OTHER));
    configureSyncRuntime(session('bearer-OTHER', OTHER));
    // The other owner has no rows → its drain issues nothing.
    await settle();
    expect(calls).toHaveLength(1);

    first.resolve({ ok: true });
    const staleSecond = await nextCall();
    expect(staleSecond.url).toBe('https://api.test/v1/shots:sync');
    expect(staleSecond.bearer).toBeNull();
    // Server would answer 401; the client must not tear down the NEW session
    // (reportApiUnauthorized only fires when a bearer was sent).
    staleSecond.resolve(
      { error: { code: 'auth.required', message: 'no' } },
      401,
    );
    await settle();
  });

  it('OBSERVED: the fresh generation drains CONCURRENTLY with the stale one — same shot POSTed twice, two attempts burned for one rejection', async () => {
    const { db, seed, state } = fakeDb();
    (getDb as jest.Mock).mockReturnValue(db);
    seed('shot.sync', shotPayload('shot-dup'));
    const { fetchMock, calls, nextCall } = controllableFetch();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    setActiveDataOwner(owner);
    establishApiSession(session('bearer-A'));
    configureSyncRuntime(session('bearer-A'));
    const staleShots = await nextCall();
    expect(staleShots.url).toBe('https://api.test/v1/shots:sync');

    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(owner);
    establishApiSession(session('bearer-B'));
    configureSyncRuntime(session('bearer-B'));
    const freshShots = await nextCall();

    // Two in-flight POSTs of the SAME outbox row, under two bearers.
    expect(calls).toHaveLength(2);
    expect([staleShots.bearer, freshShots.bearer]).toEqual([
      'bearer-A',
      'bearer-B',
    ]);
    expect(staleShots.body).toEqual(freshShots.body);

    const rejection = {
      acceptedIds: [],
      rejected: [
        {
          id: 'shot-dup',
          code: 'shot.id_conflict',
          message: 'bound elsewhere',
        },
      ],
    };
    staleShots.resolve(rejection);
    await settle();
    freshShots.resolve(rejection);
    await settle();
    // One logical cycle cost TWO of the OUTBOX_MAX_ATTEMPTS budget.
    expect(state.outbox[0]!.attempts).toBe(2);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
  });

  it('OBSERVED: with SQLite transaction semantics, interleaved receipt commits from the two drains collide on the shared connection', async () => {
    const { db, seed, state, log } = fakeDb();
    (getDb as jest.Mock).mockReturnValue(db);
    seed('shot.sync', shotPayload('shot-x'));
    const { fetchMock, nextCall } = controllableFetch();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    setActiveDataOwner(owner);
    establishApiSession(session('bearer-A'));
    configureSyncRuntime(session('bearer-A'));
    const stale = await nextCall();
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(owner);
    establishApiSession(session('bearer-B'));
    configureSyncRuntime(session('bearer-B'));
    const fresh = await nextCall();

    // Both responses land in the same tick → the two accepted-branches
    // interleave BEGIN IMMEDIATE / INSERT / DELETE / COMMIT on ONE connection.
    stale.resolve({ acceptedIds: ['shot-x'], rejected: [] });
    fresh.resolve({ acceptedIds: ['shot-x'], rejected: [] });
    await settle(20);

    // Deterministic under microtask ordering: the two accepted-branches
    // issue BEGIN IMMEDIATE back to back on ONE connection. The second BEGIN
    // fails ("cannot start a transaction within a transaction" — SQLite
    // semantics, reproduced with node:sqlite in the artifact log). Because
    // that BEGIN sits OUTSIDE the inner try in sync.ts:224, no ROLLBACK is
    // issued against the FIRST drain's open transaction — it commits, and
    // the losing drain lands in the batch-level catch as a transient
    // failure on an already-deleted row.
    const begins = log.filter(s => s === 'BEGIN IMMEDIATE').length;
    expect(begins).toBe(2);
    expect(log.filter(s => s === 'ROLLBACK')).toHaveLength(0);
    expect(log.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(
      log.filter(s => s.startsWith('UPDATE outbox SET last_error')),
    ).toHaveLength(1);
    // Invariant that matters: the row is never gone WITHOUT a receipt.
    expect(state.outbox).toEqual([]);
    expect(state.receipts).toEqual(['shot-x']);
  });

  it('control: without the re-sign-in, a same-generation triggerOutboxSync during an in-flight drain is a no-op (runningGenerations guard)', async () => {
    const { db, seed } = fakeDb();
    (getDb as jest.Mock).mockReturnValue(db);
    seed('shot.sync', shotPayload('shot-1'));
    const { fetchMock, calls, nextCall } = controllableFetch();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    setActiveDataOwner(owner);
    establishApiSession(session('bearer-A'));
    configureSyncRuntime(session('bearer-A'));
    const inFlight = await nextCall();
    for (let i = 0; i < 25; i += 1) triggerOutboxSync();
    await settle();
    expect(calls).toHaveLength(1);
    inFlight.resolve({ acceptedIds: ['shot-1'], rejected: [] });
    await settle();
  });
});
