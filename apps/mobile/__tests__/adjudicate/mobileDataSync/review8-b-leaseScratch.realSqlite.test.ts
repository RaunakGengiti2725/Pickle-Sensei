/**
 * Review round 8 (candidate B, d1c42d78) — independent reviewer scratch probes
 * on real node:sqlite for R3 (lease correctness) and R4 (bounds). NOT part of
 * the candidate; lives on devin/review8-sqlite-b-scratch only.
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
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import {
  leaseWaiters,
  runInTransaction,
  runStatement,
} from '../../../src/data/transaction';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET_A = 'a8a8a8a8-0000-4000-8000-000000000001';
const SET_B = 'a8a8a8a8-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function settledFlag<T>(p: Promise<T>): () => boolean {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
  await db.execute(`DELETE FROM sync_set_state`);
}

describe('review8 candidate B — lease scratch (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('R3a — saveAnalysis started mid-drain completes while the drain is parked on a pending-forever network call (ms measured)', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9001), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const createGate = deferred<void>();
    let createCalls = 0;
    const transport: SyncTransport = {
      async createSession() {
        createCalls += 1;
        await createGate.promise; // pending forever until we say so
      },
      async finalizeSession() {},
      async syncShots(shots) {
        return {
          acceptedIds: shots.map(s => String((s as { id: unknown }).id)),
          rejected: [],
        };
      },
    };
    const drain = drainOutbox(db, transport);
    const drainDone = settledFlag(drain);
    // Let the drain reach its first network await.
    for (let i = 0; i < 50 && createCalls === 0; i += 1) await ticks(20);
    expect(createCalls).toBe(1);
    const t0 = performance.now();
    const save = saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9002), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const saveDone = settledFlag(save);
    for (let i = 0; i < 200 && !saveDone(); i += 1) await ticks(50);
    const elapsedMs = performance.now() - t0;
    expect({ saveDone: saveDone(), drainDone: drainDone() }).toEqual({
      saveDone: true,
      drainDone: false,
    });
    console.log(
      `R3a saveAnalysis mid-drain elapsed ms: ${elapsedMs.toFixed(2)}`,
    );
    expect(elapsedMs).toBeLessThan(1000);
    expect((await getShotOutboxStatus(db, shotId(0x9002))).state).toBe(
      'queued',
    );
    expect(leaseWaiters().pending).toBe(0);
    createGate.resolve();
    await drain;
  });

  it('R3b — no lease leak: throw inside a statement group, bad SQL, SQLITE_FULL on COMMIT, closed connection, malformed row', async () => {
    // 1. Operation throws inside runInTransaction → rolled back, lease free.
    await expect(
      runInTransaction(db, async () => {
        await db.execute(
          `INSERT INTO kv (key, value) VALUES ('review8:leak', 'x')`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(
      (
        await runStatement(
          db,
          `SELECT value FROM kv WHERE key = 'review8:leak'`,
        )
      ).rows,
    ).toEqual([]);
    // 2. Bad SQL through runStatement.
    await expect(runStatement(db, `SELEKT nonsense`)).rejects.toThrow();
    expect((await runStatement(db, `SELECT 1 AS one`)).rows).toEqual([
      { one: 1 },
    ]);
    // 3. SQLITE_FULL on COMMIT (simulated at the LocalDb facade).
    let failCommit = true;
    const fullDb: LocalDb = {
      async execute(sql, params) {
        if (sql === 'COMMIT' && failCommit) {
          failCommit = false;
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await expect(
      runInTransaction(fullDb, async () => {
        await fullDb.execute(
          `INSERT INTO kv (key, value) VALUES ('review8:full', 'x')`,
        );
      }),
    ).rejects.toThrow('SQLITE_FULL');
    expect(
      (
        await runStatement(
          db,
          `SELECT value FROM kv WHERE key = 'review8:full'`,
        )
      ).rows,
    ).toEqual([]);
    // Connection is not stuck in a transaction: BEGIN IMMEDIATE must succeed.
    await runInTransaction(db, async () => {
      await db.execute(
        `INSERT INTO kv (key, value) VALUES ('review8:ok', '1')`,
      );
    });
    // 4. SQLITE_BUSY-shaped failure on BEGIN itself.
    let failBegin = true;
    const busyDb: LocalDb = {
      async execute(sql, params) {
        if (sql === 'BEGIN IMMEDIATE' && failBegin) {
          failBegin = false;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await expect(runInTransaction(busyDb, async () => {})).rejects.toThrow(
      'SQLITE_BUSY',
    );
    expect(leaseWaiters().pending).toBe(0);
    // 5. Closed connection: statement rejects, lease free; re-open works.
    getDb().close();
    await expect(runStatement(db, `SELECT 1`)).rejects.toThrow();
    expect(leaseWaiters().pending).toBe(0);
    db = getDb();
    expect((await runStatement(db, `SELECT 1 AS one`)).rows).toEqual([
      { one: 1 },
    ]);
    // 6. Malformed rows in every kind never wedge the lease or the drain.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'null')`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', '{not json')`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'evaluation.trial', '[1]')`,
      [OWNER],
    );
    const r = await drainOutbox(db, {
      ...acceptAllTransport(),
      uploadEvaluationTrials: async () => ({
        acceptedTrialIds: [],
        rejected: [],
      }),
    });
    expect(r).toEqual({ synced: 0, failed: 3, remaining: 3 });
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(x => x.attempts)).toEqual([8, 8, 8]);
    expect(rows.every(x => x.last_error !== null)).toBe(true);
    expect(await drainOutbox(db, acceptAllTransport())).toEqual({
      synced: 0,
      failed: 0,
      remaining: 3,
    });
    expect(leaseWaiters().pending).toBe(0);
  });

  it('R3c — HAZARD documented: runStatement nested inside runInTransaction on the same queue never resolves (no production caller does this)', async () => {
    const nested = runInTransaction(db, async () =>
      runStatement(db, `SELECT 1 AS one`),
    );
    const done = settledFlag(nested);
    await ticks(2000);
    // Documented behaviour: the inner turn waits for the outer turn, which
    // waits for the inner → deadlock. Recorded as a lease risk; grep shows no
    // caller in src/. We do NOT leave the queue wedged for the other tests:
    // the connection queue is process-wide, so we stop here.
    expect(done()).toBe(false);
    // Anything queued behind it is stuck as well — this is why it matters.
    const behind = runStatement(db, `SELECT 2 AS two`);
    const behindDone = settledFlag(behind);
    await ticks(500);
    expect(behindDone()).toBe(false);
    expect(leaseWaiters().pending).toBeGreaterThanOrEqual(1);
    // The process-wide queue is now wedged for this jest worker; this is the
    // LAST test of the file on purpose. Remaining probes live in
    // review8-b-boundsScratch.realSqlite.test.ts.
  });
});
