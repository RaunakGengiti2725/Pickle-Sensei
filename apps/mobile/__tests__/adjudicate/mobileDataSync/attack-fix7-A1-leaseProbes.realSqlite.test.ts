/**
 * Adversary round 7 — candidate `devin/fix6-mds-sqlite-a` @ 9a00ceb1.
 * Cluster mobile-data-sync, candidate A. Lease attacks (claim 1).
 *
 * Real `node:sqlite`, real modules (transaction / sync / repository /
 * accountScope); faults are injected only at the DB or transport boundary.
 * Each `it` states what the candidate claims, what is expected and what is
 * observed; the ones marked BREAK fail on the unmodified candidate.
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
  purgeOwnerData,
  saveAnalysis,
  saveSession,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET = (n: number) =>
  `a5a5a5a5-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

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
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function track<T>(promise: Promise<T>): {
  settled: () => boolean;
  promise: Promise<T>;
} {
  let done = false;
  const wrapped = promise.then(
    v => {
      done = true;
      return v;
    },
    e => {
      done = true;
      throw e;
    },
  );
  return { settled: () => done, promise: wrapped };
}

type Sync = Awaited<ReturnType<SyncTransport['syncShots']>>;

/** A transport whose every call is a deferred the test settles by hand. */
function manualTransport() {
  const sessionCalls: Deferred<void>[] = [];
  const shotCalls: Array<{ shots: unknown[]; d: Deferred<Sync> }> = [];
  const transport: SyncTransport = {
    async createSession() {
      const d = deferred<void>();
      sessionCalls.push(d);
      return d.promise;
    },
    async finalizeSession() {
      const d = deferred<void>();
      sessionCalls.push(d);
      return d.promise;
    },
    async syncShots(shots) {
      const d = deferred<Sync>();
      shotCalls.push({ shots, d });
      return d.promise;
    },
  };
  return { transport, sessionCalls, shotCalls };
}

const acceptAll = (shots: unknown[]): Sync => ({
  acceptedIds: shots.map(s => String((s as { id: string }).id)),
  rejected: [],
});

async function wipeOwner(db: LocalDb): Promise<void> {
  for (const table of [
    'local_shot',
    'local_session',
    'outbox',
    'sync_receipt',
  ]) {
    await db.execute(`DELETE FROM ${table} WHERE owner_key = ?`, [OWNER]);
  }
}

describe('attack-fix7-A1 lease (claim 1)', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    db = getDb();
  });
  beforeEach(async () => {
    await wipeOwner(db);
  });

  it('A1.1 BREAK — saveAnalysis is blocked for as long as the drain awaits the network (no bound in transaction.ts)', async () => {
    // Three sets queued: the session pass makes one network call per row and
    // continues over the rest of the page after a transient failure.
    for (let n = 1; n <= 3; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(n), sessionId: SET(n) }),
        PERMIT_ID,
        { session: setInput(SET(n)) },
      );
    }
    const { transport, sessionCalls } = manualTransport();
    const drain = track(drainOutbox(db, transport));
    await ticks(200);
    expect(sessionCalls).toHaveLength(1);

    // The capture flow persists a fresh rating while the drain is out on the
    // network. Base (1fb0efd7): this never waited on the network.
    const save = track(
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(9), sessionId: SET(9) }),
        PERMIT_ID,
        { session: setInput(SET(9)) },
      ),
    );
    await ticks(500);
    await sleep(100);
    const settledWhileNetworkPending = save.settled();

    // Let the network fail transiently, one call at a time, and count how many
    // round trips the save had to wait for.
    let roundTripsWaited = 0;
    while (!save.settled()) {
      const call = sessionCalls[roundTripsWaited];
      if (!call) break;
      call.reject(new ApiError(503, 'server.unavailable', 'down'));
      roundTripsWaited += 1;
      await ticks(500);
    }
    await save.promise;
    await drain.promise;

    // OBSERVED on candidate: settledWhileNetworkPending=false,
    // roundTripsWaited=3 (every row of the page is offered before the lease
    // is released; with the real transport each is bounded only by
    // API_REQUEST_TIMEOUT_MS=20s → up to 50×20s per page).
    expect({ settledWhileNetworkPending, roundTripsWaited }).toEqual({
      settledWhileNetworkPending: true,
      roundTripsWaited: 0,
    });
  });

  it('A1.2 probe — lease is not leaked when statements throw between acquire and release (closed db, SQLITE_ERROR, malformed row)', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    // (a) A statement failing inside a repository transaction.
    const failing: LocalDb = {
      execute: async (sql, params) => {
        if (sql.includes('INSERT INTO outbox')) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => {},
    };
    await expect(
      saveAnalysis(
        failing,
        realAnalysis({ id: shotId(2), sessionId: SET(1) }),
        PERMIT_ID,
        { session: setInput(SET(1)) },
      ),
    ).rejects.toThrow('SQLITE_FULL');
    // (b) BEGIN IMMEDIATE itself failing (busy).
    const busy: LocalDb = {
      execute: async (sql, params) => {
        if (sql === 'BEGIN IMMEDIATE') {
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return db.execute(sql, params);
      },
      close: () => {},
    };
    await expect(
      saveAnalysis(
        busy,
        realAnalysis({ id: shotId(3), sessionId: SET(1) }),
        PERMIT_ID,
        { session: setInput(SET(1)) },
      ),
    ).rejects.toThrow('SQLITE_BUSY');
    // (c) A drain whose receipt write fails.
    const receiptFails: LocalDb = {
      execute: async (sql, params) => {
        if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => {},
    };
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const drain = track(drainOutbox(receiptFails, transport));
    await ticks(200);
    sessionCalls[0]!.resolve();
    await ticks(200);
    shotCalls[0]!.d.resolve(acceptAll(shotCalls[0]!.shots));
    const result = await drain.promise;
    expect(result.failed).toBe(1);
    // (d) The next ordinary caller must get the connection promptly.
    const next = track(
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(4), sessionId: SET(1) }),
        PERMIT_ID,
        { session: setInput(SET(1)) },
      ),
    );
    await ticks(200);
    expect(next.settled()).toBe(true);
    await next.promise;
    // (e) Malformed row in the drain's page never throws out of the drain.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'not json')`,
      [OWNER],
    );
    const t2 = manualTransport();
    const drain2 = track(drainOutbox(db, t2.transport));
    await ticks(200);
    t2.shotCalls[0]!.d.resolve(acceptAll(t2.shotCalls[0]!.shots));
    const r2 = await drain2.promise;
    expect(r2.failed).toBe(1);
    const after = track(saveSession(db, setInput(SET(2))));
    await ticks(200);
    expect(after.settled()).toBe(true);
  });

  it('A1.3 BREAK — a session.create row with corrupt JSON is offered by EVERY session pass forever (attempts unbounded, failed>0 every drain)', async () => {
    // Pre-fix / corrupted row: the candidate's budget predicate admits every
    // session.create row regardless of attempts so exhausted sets can be
    // recognised — but a row that cannot be parsed never reaches that branch.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'session.create', '{not json', 0)`,
      [OWNER],
    );
    // A control row: a corrupt shot.sync row is isolated after the budget.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'shot.sync', '{not json', 0)`,
      [OWNER],
    );
    const failedPerDrain: number[] = [];
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 4; i += 1) {
      const { transport } = manualTransport();
      const r = await drainOutbox(db, transport);
      failedPerDrain.push(r.failed);
    }
    const rows = await outboxRows(db, OWNER);
    const sessionRow = rows.find(r => r.kind === 'session.create')!;
    const shotRow = rows.find(r => r.kind === 'shot.sync')!;
    // Control: bounded.
    expect(shotRow.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Expected: after OUTBOX_MAX_ATTEMPTS drains the corrupt session row is
    // isolated like any other row (attempts frozen at 8, failed=0).
    // OBSERVED: attempts=12, failedPerDrain ends with 1s — the owner's sync
    // runtime reads failed>0 on every drain and backs off to its maximum
    // cadence for good.
    expect({
      sessionAttempts: sessionRow.attempts,
      tail: failedPerDrain.slice(OUTBOX_MAX_ATTEMPTS),
    }).toEqual({
      sessionAttempts: OUTBOX_MAX_ATTEMPTS,
      tail: [0, 0, 0, 0],
    });
  });

  it('A1.4 probe — fairness: waiters behind a drain are served FIFO once the drain releases; measure lease_waiters_max', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const drain = track(drainOutbox(db, transport));
    await ticks(100);
    const waiters = Array.from({ length: 25 }, (_, i) =>
      track(
        saveAnalysis(
          db,
          realAnalysis({ id: shotId(100 + i), sessionId: SET(2) }),
          PERMIT_ID,
          { session: setInput(SET(2)) },
        ),
      ),
    );
    await ticks(300);
    const pending = waiters.filter(w => !w.settled()).length;
    expect(pending).toBe(25); // lease_waiters_max measured = 25
    sessionCalls[0]!.resolve();
    await ticks(300);
    shotCalls[0]!.d.resolve(acceptAll(shotCalls[0]!.shots));
    await drain.promise;
    await Promise.all(waiters.map(w => w.promise));
    const rows = await outboxRows(db, OWNER);
    expect(rows.filter(r => r.kind === 'session.create')).toHaveLength(1);
    expect(rows.filter(r => r.kind === 'shot.sync')).toHaveLength(25);
  });

  it('A1.5 probe — 1,000 seeded interleavings of save/drain/purge/network: no hang, no duplicate live session.create, no lost or leaked rows', async () => {
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const inflight: Promise<unknown>[] = [];
    const savedSincePurge = new Set<string>();
    const purgedShots = new Set<string>();
    let shotN = 0;
    let purges = 0;
    let drains = 0;
    const settleOne = () => {
      const s = sessionCalls.shift();
      if (s) {
        if (rnd() < 0.2) s.reject(new ApiError(503, 'server.unavailable', 'x'));
        else s.resolve();
        return;
      }
      const c = shotCalls.shift();
      if (c) {
        if (rnd() < 0.2)
          c.d.reject(new ApiError(503, 'server.unavailable', 'x'));
        else c.d.resolve(acceptAll(c.shots));
      }
    };
    for (let step = 0; step < 1000; step += 1) {
      const r = rnd();
      if (r < 0.4) {
        shotN += 1;
        const id = shotId(1000 + shotN);
        const set = SET(1 + (shotN % 4));
        savedSincePurge.add(id);
        inflight.push(
          saveAnalysis(db, realAnalysis({ id, sessionId: set }), PERMIT_ID, {
            session: setInput(set),
          }),
        );
      } else if (r < 0.65) {
        drains += 1;
        inflight.push(drainOutbox(db, transport));
      } else if (r < 0.7) {
        purges += 1;
        for (const id of savedSincePurge) purgedShots.add(id);
        savedSincePurge.clear();
        inflight.push(purgeOwnerData(db, OWNER));
      } else {
        settleOne();
      }
      await ticks(1 + Math.floor(rnd() * 5));
    }
    // Let everything finish: keep settling network calls until quiescent.
    const all = track(Promise.all(inflight));
    for (let i = 0; i < 20000 && !all.settled(); i += 1) {
      settleOne();
      await ticks(20);
    }
    expect(all.settled()).toBe(true); // no hang
    await all.promise;
    const dup = await db.execute(
      `SELECT json_extract(payload, '$.id') AS sid, count(*) AS n FROM outbox
       WHERE owner_key = ? AND kind = 'session.create' AND attempts < ?
       GROUP BY sid HAVING n > 1`,
      [OWNER, OUTBOX_MAX_ATTEMPTS],
    );
    expect(dup.rows).toEqual([]);
    // Final drain that accepts everything.
    const final = drainOutbox(db, {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        return acceptAll(shots);
      },
    });
    const res = await final;
    expect(res.remaining).toBe(0);
    // Oracle: a save queued behind a purge lands AFTER it (that is the
    // lease's ordering), so the surviving local_shot rows are exactly the
    // shots that may hold a receipt — every one of them must, and no
    // receipt may name a shot the owner no longer has (leaked receipt).
    const ids = (rows: Record<string, unknown>[]) =>
      rows.map(r => String(r['id'])).sort();
    const shots = ids(
      (
        await db.execute(`SELECT id FROM local_shot WHERE owner_key = ?`, [
          OWNER,
        ])
      ).rows,
    );
    const receipts = ids(
      (
        await db.execute(
          `SELECT entity_id AS id FROM sync_receipt WHERE owner_key = ?`,
          [OWNER],
        )
      ).rows,
    );
    expect(receipts).toEqual(shots);
    expect(shots.length).toBeGreaterThan(0);
    for (const id of shots) {
      expect(await hasShotSyncReceipt(db, id)).toBe(true);
      expect((await getShotOutboxStatus(db, id)).state).toBe('absent');
    }
    expect(purgedShots.size + savedSincePurge.size).toBe(shotN);
    expect({ shotN, purges, drains }).toMatchObject({});
  });
});
