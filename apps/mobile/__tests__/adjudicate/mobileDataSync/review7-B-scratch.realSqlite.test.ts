/**
 * Round-7 independent review of candidate B (7bd9d7af) — scratch probes on
 * real node:sqlite. NOT part of the candidate; lives on devin/review7-B-scratch.
 *
 * R3(b) lease liveness: drain awaiting network vs repository txn; repository
 *       txn holding the lease while a receipt lands; account switch mid-drain;
 *       overlapping drains (generation bump shape).
 * R3(c) lease release on every error path: statement-group throw, closed
 *       connection, SQLITE_BUSY from a second connection, drain receipt throw.
 * R3(e) 1,000 interleaved saveAnalysis/drain calls: bounded in-flight turns,
 *       queue fully drained afterwards, exact receipts.
 * R4    re-arm bound with a server that refuses createSession forever;
 *       idle drains do zero work; a new shot buys exactly one more round;
 *       legacy (pre-fix) exhausted rows after upgrade; owner isolation of
 *       re-arm/unpark.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import * as transaction from '../../../src/data/transaction';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner('22222222-2222-4333-8444-555555555555');
const SET_A = 'a5a5a5a5-0000-4000-8000-000000000001';
const SET_B = 'a5a5a5a5-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function settle(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}
function settledFlag(p: Promise<unknown>): () => boolean {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

interface Emulator extends SyncTransport {
  created: string[];
  offered: string[][];
  createError: (() => Error) | null;
  knownSessions: Set<string>;
}
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const created: string[] = [];
  const offered: string[][] = [];
  const emulator: Emulator = {
    created,
    offered,
    createError: null,
    knownSessions,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
      if (emulator.createError) throw emulator.createError();
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
        if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          });
        } else acceptedIds.push(shot.id);
      }
      offered.push(ids);
      return { acceptedIds, rejected };
    },
  };
  return emulator;
}

/** Proves no transaction is open on the connection right now. */
async function assertAutocommit(db: LocalDb): Promise<void> {
  await db.execute('BEGIN IMMEDIATE');
  await db.execute('ROLLBACK');
}

async function wipe(db: LocalDb): Promise<void> {
  for (const t of ['outbox', 'local_shot', 'local_session', 'sync_receipt']) {
    await db.execute(`DELETE FROM ${t}`);
  }
}

describe('review7-B scratch: lease liveness (R3b)', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await wipe(db);
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('drain awaiting the network does not hold the lease: a saveAnalysis commits meanwhile', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const gate = deferred<void>();
    const transport = acceptAllTransport();
    const slow: SyncTransport = {
      ...transport,
      async syncShots(shots) {
        await gate.promise;
        return transport.syncShots(shots);
      },
    };
    const drain = drainOutbox(db, slow);
    await settle();
    const save = saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    const saveDone = settledFlag(save);
    await settle();
    expect(saveDone()).toBe(true); // did not wait for the network
    await save;
    gate.resolve();
    const result = await drain;
    expect(result).toMatchObject({ synced: 1, failed: 0, remaining: 1 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(false);
    await assertAutocommit(db);
  });

  it('receipt landing while a repository txn holds the lease waits for COMMIT and is then durable', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const serverAnswers = deferred<void>();
    const releaseSave = deferred<void>();
    const transport = acceptAllTransport();
    const slow: SyncTransport = {
      ...transport,
      async syncShots(shots) {
        await serverAnswers.promise;
        return transport.syncShots(shots);
      },
    };
    const drain = drainOutbox(db, slow);
    await settle();
    // Save whose INSERT INTO outbox stalls (holding BEGIN IMMEDIATE open).
    let stalled = false;
    const stalling: LocalDb = {
      async execute(sql, params) {
        if (!stalled && /INSERT INTO outbox/.test(sql)) {
          stalled = true;
          await releaseSave.promise;
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    const save = saveAnalysis(
      stalling,
      realAnalysis({ id: shotId(2) }),
      PERMIT_ID,
    );
    await settle();
    expect(stalled).toBe(true);
    serverAnswers.resolve();
    const drainDone = settledFlag(drain);
    await settle();
    expect(drainDone()).toBe(false); // receipt waits behind the open txn
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(false);
    releaseSave.resolve();
    await save;
    await drain;
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
    await assertAutocommit(db);
  });

  it('account switch mid-drain: receipts stay in the old owner bucket, new owner drains independently', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const gate = deferred<void>();
    const transportA = acceptAllTransport();
    const slowA: SyncTransport = {
      ...transportA,
      async syncShots(shots) {
        await gate.promise;
        return transportA.syncShots(shots);
      },
    };
    const drainA = drainOutbox(db, slowA);
    await settle();
    setActiveDataOwner(OWNER_B);
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    const drainB = drainOutbox(db, acceptAllTransport());
    const resB = await drainB; // not blocked by A's in-flight network call
    expect(resB).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    gate.resolve();
    expect(await drainA).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    const receipts = await db.execute(
      `SELECT owner_key, entity_id FROM sync_receipt ORDER BY entity_id`,
    );
    expect(receipts.rows).toEqual([
      { owner_key: OWNER, entity_id: shotId(1) },
      { owner_key: OWNER_B, entity_id: shotId(2) },
    ]);
    setActiveDataOwner(OWNER);
    await assertAutocommit(db);
  });

  it('overlapping drains for one owner (generation bump shape): second waits, one createSession, both settle', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    const gate = deferred<void>();
    const emulator = serverEmulator();
    let createCalls = 0;
    const slow: SyncTransport = {
      ...emulator,
      async createSession(session) {
        createCalls += 1;
        await gate.promise;
        return emulator.createSession(session);
      },
    };
    const d1 = drainOutbox(db, slow);
    const d2 = drainOutbox(db, slow);
    const d3 = drainOutbox(db, slow);
    await settle();
    expect(createCalls).toBe(1);
    gate.resolve();
    const results = await Promise.all([d1, d2, d3]);
    expect(results[0]).toMatchObject({ synced: 2, failed: 0, remaining: 0 });
    expect(results[1]).toMatchObject({ synced: 0, failed: 0, remaining: 0 });
    expect(results[2]).toMatchObject({ synced: 0, failed: 0, remaining: 0 });
    expect(emulator.created).toEqual([SET_A]);
    expect(emulator.offered).toEqual([[shotId(1)]]);
    await assertAutocommit(db);
  });
});

describe('review7-B scratch: lease release on error paths (R3c)', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await wipe(db);
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  async function leaseIsFree(): Promise<void> {
    const probe = transaction.runExclusive(() => Promise.resolve(42));
    const done = settledFlag(probe);
    await settle(10);
    expect(done()).toBe(true);
    expect(await probe).toBe(42);
  }

  it('statement-group throw inside runInTransaction: rolled back, lease free, no open txn', async () => {
    const faulty: LocalDb = {
      async execute(sql, params) {
        if (/INSERT INTO outbox/.test(sql)) {
          throw new Error('[op-sqlite] SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await expect(
      saveAnalysis(faulty, realAnalysis({ id: shotId(1) }), PERMIT_ID),
    ).rejects.toThrow(/SQLITE_FULL/);
    await leaseIsFree();
    await assertAutocommit(db);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
  });

  it('closed connection inside a turn: the turn rejects and the lease is free', async () => {
    const closed: LocalDb = {
      async execute() {
        throw new Error('[op-sqlite] database is closed');
      },
      close: () => undefined,
    };
    await expect(
      saveAnalysis(closed, realAnalysis({ id: shotId(1) }), PERMIT_ID),
    ).rejects.toThrow(/closed/);
    await expect(
      transaction.runExclusive(async () => {
        await closed.execute('SELECT 1');
      }),
    ).rejects.toThrow(/closed/);
    await leaseIsFree();
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
  });

  it('a REAL close of the underlying handle mid-turn releases the lease; a reopened handle works', async () => {
    const live = getDb();
    const closing: LocalDb = {
      async execute(sql, params) {
        if (/INSERT INTO outbox/.test(sql)) live.close();
        return live.execute(sql, params);
      },
      close: () => live.close(),
    };
    await expect(
      saveAnalysis(closing, realAnalysis({ id: shotId(1) }), PERMIT_ID),
    ).rejects.toThrow();
    await leaseIsFree();
    db = getDb(); // reopen (fresh instance)
    await wipe(db);
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
    await assertAutocommit(db);
  });

  it('SQLITE_BUSY on BEGIN IMMEDIATE (another connection holds a write txn): rejects, lease free, retry succeeds', async () => {
    // A second raw connection on the same file holding a write lock.
    const { DatabaseSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:sqlite') as typeof import('node:sqlite');
    const file = (mockSqlite as unknown as { opened: Array<{ log: string[] }> })
      .opened.length; // just to keep the reference; path is internal
    void file;
    // Find the db path by asking sqlite itself.
    const { rows } = await db.execute(`PRAGMA database_list`);
    const path = String(rows[0]!['file']);
    const other = new DatabaseSync(path);
    other.exec('BEGIN IMMEDIATE');
    try {
      await expect(
        saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID),
      ).rejects.toThrow(/SQLITE_BUSY|database is locked/);
      await leaseIsFree();
      const drain = drainOutbox(db, acceptAllTransport());
      const drainDone = settledFlag(drain);
      await settle(50);
      // The drain's autocommit reads may be blocked by the other writer or
      // may succeed (reads are fine in rollback-journal mode with a RESERVED
      // lock); either way the lease is not stuck once the lock is gone.
      void drainDone;
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    await leaseIsFree();
    await saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID);
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
    await assertAutocommit(db);
  });

  it('a throw inside a DRAIN statement group (receipt INSERT fails) rejects the drain, frees the lease, leaves no txn open', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    let tripped = false;
    const faulty: LocalDb = {
      async execute(sql, params) {
        if (!tripped && /INSERT OR REPLACE INTO sync_receipt/.test(sql)) {
          tripped = true;
          throw new Error('[op-sqlite] SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    // Same shape as 1fb0efd7: the local write failure is caught by the
    // shot-pass catch and recorded as a NON-permanent failure (no attempt
    // charged); the drain resolves rather than rejecting.
    const result = await drainOutbox(faulty, acceptAllTransport());
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    await leaseIsFree();
    await assertAutocommit(db);
    // Row survived (txn rolled back), no receipt; the next drain delivers it.
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 0 });
    expect(String(rows[0]!.last_error)).toMatch(/SQLITE_FULL/);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(false);
    const again = await drainOutbox(db, acceptAllTransport());
    expect(again).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
  });

  it('a transport that throws synchronously / non-Error still frees the lease', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const weird: SyncTransport = {
      syncShots: () => {
        throw 'boom';
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    const result = await drainOutbox(db, weird);
    expect(result).toMatchObject({ synced: 0, failed: 1, remaining: 1 });
    await leaseIsFree();
    await assertAutocommit(db);
  });
});

describe('review7-B scratch: 1,000 interleaved saveAnalysis/drain (R3e)', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await wipe(db);
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('bounded in-flight turns, every shot receipted exactly once, queue idle afterwards', async () => {
    const original = transaction.runExclusive;
    let inFlight = 0;
    let maxInFlight = 0;
    let turns = 0;
    const spy = jest
      .spyOn(transaction, 'runExclusive')
      .mockImplementation(
        <T>(op: (t: transaction.ConnectionTurn) => Promise<T>) => {
          inFlight += 1;
          turns += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const p = original(op);
          void p.then(
            () => {
              inFlight -= 1;
            },
            () => {
              inFlight -= 1;
            },
          );
          return p;
        },
      );
    try {
      const transport = acceptAllTransport();
      const pending: Promise<unknown>[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 500; i += 1) {
        pending.push(
          saveAnalysis(db, realAnalysis({ id: shotId(1000 + i) }), PERMIT_ID),
        );
        pending.push(drainOutbox(db, transport));
      }
      const results = await Promise.allSettled(pending);
      const elapsedMs = Date.now() - t0;
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(0);
      // Final sweep for anything the last drain left behind.
      await drainOutbox(db, transport);
      const receipts = await db.execute(
        `SELECT COUNT(*) AS n FROM sync_receipt WHERE owner_key = ?`,
        [OWNER],
      );
      expect(Number(receipts.rows[0]!['n'])).toBe(500);
      expect(await outboxRows(db, OWNER)).toHaveLength(0);
      // Every accepted id was offered exactly once across all drains.
      const offered = transport.syncCalls
        .flat()
        .map(s => String((s as { id: unknown }).id));
      expect(offered).toHaveLength(500);
      expect(new Set(offered).size).toBe(500);
      // in-flight is the pending-waiter depth: bounded by the callers issued
      // (each caller holds at most one queued turn at a time).
      expect(maxInFlight).toBeLessThanOrEqual(1000);
      expect(inFlight).toBe(0);
      console.info(
        `[review7-B] 1000 interleaved calls: turns=${turns} maxInFlight=${maxInFlight} elapsedMs=${elapsedMs} syncCalls=${transport.syncCalls.length}`,
      );
      // Queue idle: a fresh turn runs within a handful of microtasks.
      const probe = original(() => Promise.resolve(1));
      const done = settledFlag(probe);
      await settle(5);
      expect(done()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('review7-B scratch: recoverability bounds (R4)', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await wipe(db);
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('createSession refused forever: exactly OUTBOX_MAX_ATTEMPTS createSession calls, shot parked, idle drains do ZERO network work and add ZERO rows', async () => {
    const emulator = serverEmulator();
    emulator.createError = () =>
      new ApiError(422, 'validation.session', 'refused');
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    for (let i = 0; i < 40; i += 1) await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    // Shot: offered at most once per drain while the set had budget; parked after.
    const offers = emulator.offered.length;
    expect(offers).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS + 1);
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.kind === 'session.create')).toMatchObject({
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      state: 'orphaned',
    });
    // Idle drains: nothing more.
    for (let i = 0; i < 20; i += 1) await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(emulator.offered).toHaveLength(offers);
    expect(await outboxRows(db, OWNER)).toHaveLength(2);

    // A new shot joining the set buys exactly ONE more round of the budget.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(2), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    expect(await outboxRows(db, OWNER)).toHaveLength(3); // no second session.create row
    for (let i = 0; i < 40; i += 1) await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(2 * OUTBOX_MAX_ATTEMPTS);
    expect(await outboxRows(db, OWNER)).toHaveLength(3);
    expect(await getShotOutboxStatus(db, shotId(2))).toMatchObject({
      state: 'orphaned',
    });
    // Server relents; a third shot re-arms; ONE createSession; everything delivered.
    emulator.createError = null;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(3), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(2 * OUTBOX_MAX_ATTEMPTS + 1);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    for (const n of [1, 2, 3]) {
      expect(await hasShotSyncReceipt(db, shotId(n))).toBe(true);
    }
    await assertAutocommit(db);
  });

  it('parked shots are re-offered exactly once per unpark (accepted session.create), not on idle drains', async () => {
    const emulator = serverEmulator();
    emulator.createError = () =>
      new ApiError(422, 'validation.session', 'refused');
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      await drainOutbox(db, emulator);
    }
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      state: 'orphaned',
    });
    const offersBefore = emulator.offered.length;
    for (let i = 0; i < 5; i += 1) await drainOutbox(db, emulator);
    expect(emulator.offered).toHaveLength(offersBefore);
    // Unpark event: re-arm via new shot, server now accepts.
    emulator.createError = null;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(2), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    await drainOutbox(db, emulator);
    const offersAfter = emulator.offered.slice(offersBefore).flat();
    expect(offersAfter.filter(id => id === shotId(1))).toHaveLength(1);
    expect(offersAfter.filter(id => id === shotId(2))).toHaveLength(1);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
  });

  it('inconsistent server (createSession OK, shot still session_not_found): rows stay bounded (≤2 per set), work is one createSession + one offer per drain', async () => {
    // Not reachable through the real edge (createSession only succeeds when
    // the owner's session row exists → apply_synced_shot finds it); recorded
    // to characterise the worst case.
    const emulator = serverEmulator();
    const stubborn: SyncTransport = {
      ...emulator,
      async createSession(session) {
        await emulator.createSession(session);
        emulator.knownSessions.clear();
      },
    };
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    let maxRows = 0;
    for (let i = 0; i < 60; i += 1) {
      await drainOutbox(db, stubborn);
      maxRows = Math.max(maxRows, (await outboxRows(db, OWNER)).length);
    }
    expect(maxRows).toBeLessThanOrEqual(2);
    console.info(
      `[review7-B] inconsistent server after 60 drains: created=${emulator.created.length} offered=${emulator.offered.length} rows=${(await outboxRows(db, OWNER)).length}`,
    );
  });

  it('legacy pre-fix rows after upgrade: exhausted session.create parks its shots (no attempt burned); exhausted shot with a non-session error stays dead', async () => {
    const emulator = serverEmulator();
    // Pre-fix session.create exhausted with an old-style error.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, ?)`,
      [
        OWNER,
        JSON.stringify(setInput(SET_A)),
        OUTBOX_MAX_ATTEMPTS,
        'ApiError: 422 validation.session',
      ],
    );
    await db.execute(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, '2026-08-26T18:00:00.000Z')`,
      [OWNER, SET_A],
    );
    // Pre-fix shot of that set: attempts 0, old transient last_error.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, 0, ?)`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(1), sessionId: SET_A }),
          analysisPermitId: PERMIT_ID,
        }),
        `${SESSION_NOT_FOUND_REJECTION}: Session not found or not yours.`,
      ],
    );
    // Pre-fix exhausted shot with a permanent non-session error.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, ?, ?)`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(2), sessionId: null }),
          analysisPermitId: PERMIT_ID,
        }),
        OUTBOX_MAX_ATTEMPTS,
        'access.permit_expired: Analysis permit expired.',
      ],
    );
    for (let i = 0; i < 5; i += 1) await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(0); // exhausted set is not re-asked by itself
    expect(emulator.offered).toEqual([[shotId(1)]]); // one offer → parked
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      state: 'orphaned',
      attempts: 0,
    });
    expect(await getShotOutboxStatus(db, shotId(2))).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    // New shot to the legacy set re-arms it; the server accepts; legacy shot delivered.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(3), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    await drainOutbox(db, emulator);
    expect(emulator.created).toEqual([SET_A]);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(3))).toBe(true);
    expect(await getShotOutboxStatus(db, shotId(2))).toMatchObject({
      state: 'exhausted',
    });
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
  });

  it('re-arm and unpark are owner-isolated', async () => {
    const emulator = serverEmulator();
    emulator.createError = () =>
      new ApiError(422, 'validation.session', 'refused');
    // Owner A and owner B both have set SET_A id? Use distinct ids but same flow.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    setActiveDataOwner(OWNER_B);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(2), sessionId: SET_B }),
      PERMIT_ID,
      {
        session: setInput(SET_B),
      },
    );
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 1; i += 1) {
      setActiveDataOwner(OWNER);
      await drainOutbox(db, emulator);
      setActiveDataOwner(OWNER_B);
      await drainOutbox(db, emulator);
    }
    setActiveDataOwner(OWNER);
    expect(await getShotOutboxStatus(db, shotId(1))).toMatchObject({
      state: 'orphaned',
    });
    setActiveDataOwner(OWNER_B);
    expect(await getShotOutboxStatus(db, shotId(2))).toMatchObject({
      state: 'orphaned',
    });
    // Owner A adds a shot → only A's set is re-armed; server accepts now.
    emulator.createError = null;
    setActiveDataOwner(OWNER);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(3), sessionId: SET_A }),
      PERMIT_ID,
      {
        session: setInput(SET_A),
      },
    );
    const createdBefore = emulator.created.length;
    await drainOutbox(db, emulator);
    expect(emulator.created.slice(createdBefore)).toEqual([SET_A]);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    // B untouched: still parked, its exhausted row still exhausted.
    setActiveDataOwner(OWNER_B);
    await drainOutbox(db, emulator);
    expect(emulator.created.slice(createdBefore)).toEqual([SET_A]);
    expect(await getShotOutboxStatus(db, shotId(2))).toMatchObject({
      state: 'orphaned',
    });
    const rowsB = await outboxRows(db, OWNER_B);
    expect(rowsB.find(r => r.kind === 'session.create')).toMatchObject({
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    setActiveDataOwner(OWNER);
  });

  it('saveSession on an exhausted set does not create a second live row… (documents whether saveSession re-arms)', async () => {
    const emulator = serverEmulator();
    emulator.createError = () =>
      new ApiError(422, 'validation.session', 'refused');
    await saveSession(db, setInput(SET_A));
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 1; i += 1)
      await drainOutbox(db, emulator);
    expect(emulator.created).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    await saveSession(db, setInput(SET_A)); // e.g. commitPracticeSet on relaunch
    const rows = await outboxRows(db, OWNER);
    console.info(
      `[review7-B] saveSession after exhaustion → rows=${JSON.stringify(rows)}`,
    );
    emulator.createError = null;
    await drainOutbox(db, emulator);
    console.info(
      `[review7-B] … after drain created=${emulator.created.length} rows=${(await outboxRows(db, OWNER)).length}`,
    );
    expect(
      (await outboxRows(db, OWNER)).filter(
        r => r.kind === 'session.create' && r.attempts < OUTBOX_MAX_ATTEMPTS,
      ),
    ).toHaveLength(0);
  });
});
