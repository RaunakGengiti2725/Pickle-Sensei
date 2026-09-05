/**
 * Adversary round 7 — candidate `devin/fix6-mds-sqlite-a` @ 9a00ceb1.
 * Purge / owner fence attacks (claim 2) on real `node:sqlite` through the
 * real modules; faults only at the transport boundary.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
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

const OWNER_A = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner('22222222-3333-4444-8555-666666666666');
const SET_X = 'a5a5a5a5-0000-4000-8000-000000000001';
const SET_Y = 'a5a5a5a5-0000-4000-8000-000000000002';

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
type Sync = Awaited<ReturnType<SyncTransport['syncShots']>>;
const acceptAll = (shots: unknown[]): Sync => ({
  acceptedIds: shots.map(s => String((s as { id: string }).id)),
  rejected: [],
});
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

async function ownerFootprint(db: LocalDb, owner: string) {
  const count = async (table: string) =>
    Number(
      (
        await db.execute(
          `SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`,
          [owner],
        )
      ).rows[0]!['n'],
    );
  return {
    local_shot: await count('local_shot'),
    local_session: await count('local_session'),
    outbox: await count('outbox'),
    sync_receipt: await count('sync_receipt'),
  };
}

async function wipe(db: LocalDb): Promise<void> {
  for (const table of ['local_shot', 'local_session', 'outbox', 'sync_receipt'])
    await db.execute(`DELETE FROM ${table}`);
}

async function saveShot(db: LocalDb, n: number, set: string) {
  await saveAnalysis(
    db,
    realAnalysis({ id: shotId(n), sessionId: set }),
    PERMIT_ID,
    { session: setInput(set) },
  );
}

describe('attack-fix7-A2 purge / owner fence (claim 2)', () => {
  let db: LocalDb;
  beforeAll(() => {
    db = getDb();
  });
  beforeEach(async () => {
    setActiveDataOwner(OWNER_A);
    await wipe(db);
  });

  it('A2.1 probe — server answer lands while the purge transaction is still running: the resumed drain is fenced and issues no settlement statement', async () => {
    await saveShot(db, 1, SET_X);
    const log: string[] = [];
    const spy: LocalDb = {
      execute: async (sql, params) => {
        log.push(sql.replace(/\s+/g, ' ').trim());
        return db.execute(sql, params);
      },
      close() {},
    };
    let purge: Promise<void> | null = null;
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        // Account deletion confirmed while this batch is on the wire: the
        // purge preempts the suspended lease and is mid-transaction when the
        // server's 2xx arrives.
        purge = purgeOwnerData(spy, OWNER_A);
        await ticks(5);
        return acceptAll(shots);
      },
    };
    const result = await drainOutbox(spy, transport);
    await purge!;
    const purgeCommit = log.lastIndexOf('COMMIT');
    const afterPurge = log.slice(purgeCommit + 1);
    expect(await ownerFootprint(db, OWNER_A)).toEqual({
      local_shot: 0,
      local_session: 0,
      outbox: 0,
      sync_receipt: 0,
    });
    // Claim 2: the round trip is `fenced`; the drain issues no settlement
    // statement and reports the shot neither synced nor failed. Note the
    // ordering this relies on: `markOwnerPurged` runs only after the purge's
    // lease is released, i.e. after `release()` has already resumed the
    // drain — the fence check wins by microtask depth, not by construction.
    expect({
      result,
      settlementStatementsAfterPurge: afterPurge.filter(
        s => !s.startsWith('SELECT count(*)'),
      ),
    }).toEqual({
      result: { synced: 1, failed: 0, remaining: 0 },
      settlementStatementsAfterPurge: [],
    });
  });

  it('A2.2 probe — purge queued in the SAME tick the accept lands (after the await continuation) leaves no receipt or row', async () => {
    await saveShot(db, 1, SET_X);
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const drain = drainOutbox(db, transport);
    await ticks(50);
    sessionCalls[0]!.resolve();
    await ticks(50);
    const call = shotCalls[0]!;
    // Register the purge AFTER the drain's own `await` so its callback runs
    // one microtask after the drain resumes (the lease is no longer suspended).
    let purge: Promise<void> | null = null;
    void call.d.promise.then(() => {
      purge = purgeOwnerData(db, OWNER_A);
    });
    call.d.resolve(acceptAll(call.shots));
    const result = await drain;
    await purge!;
    expect(result.synced).toBe(1); // the receipt WAS written…
    // …and the purge that ran after the drain removed it with the bucket.
    expect(await ownerFootprint(db, OWNER_A)).toEqual({
      local_shot: 0,
      local_session: 0,
      outbox: 0,
      sync_receipt: 0,
    });
  });

  it('A2.3 probe — purge then immediate re-sign-in of the SAME owner: the stale drain settles nothing for the new incarnation', async () => {
    await saveShot(db, 1, SET_X);
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const stale = drainOutbox(db, transport);
    await ticks(50);
    sessionCalls[0]!.resolve();
    await ticks(50);
    expect(shotCalls).toHaveLength(1);
    // Account deleted while the shot batch is in flight…
    const purge = purgeOwnerData(db, OWNER_A);
    await ticks(50);
    await purge;
    // …then the same person signs in again and rates a shot in a NEW set
    // while the stale batch is still out. The save queues behind the drain.
    const save = saveShot(db, 2, SET_Y);
    await ticks(50);
    shotCalls[0]!.d.resolve(acceptAll(shotCalls[0]!.shots));
    const staleResult = await stale;
    await save;
    expect(staleResult).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(false);
    expect((await getShotOutboxStatus(db, shotId(2))).state).toBe('queued');
    // The new incarnation drains normally.
    const fresh = manualTransport();
    const d2 = drainOutbox(db, fresh.transport);
    await ticks(50);
    fresh.sessionCalls[0]!.resolve();
    await ticks(50);
    fresh.shotCalls[0]!.d.resolve(acceptAll(fresh.shotCalls[0]!.shots));
    expect((await d2).synced).toBe(2);
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(true);
    expect(await ownerFootprint(db, OWNER_A)).toEqual({
      local_shot: 1,
      local_session: 1,
      outbox: 0,
      sync_receipt: 1,
    });
  });

  it('A2.4 probe — owner A drain awaiting the network while owner B becomes active and drains: each owner gets exactly its own receipts', async () => {
    await saveShot(db, 1, SET_X);
    const ta = manualTransport();
    const drainA = drainOutbox(db, ta.transport);
    await ticks(50);
    ta.sessionCalls[0]!.resolve();
    await ticks(50);
    expect(ta.shotCalls).toHaveLength(1);
    setActiveDataOwner(OWNER_B);
    const saveB = saveShot(db, 2, SET_Y);
    const tb = manualTransport();
    const drainB = drainOutbox(db, tb.transport);
    // Fix round 8 (L1): the connection is let go while A awaits the network,
    // so B's save commits and B's drain reaches its own transport call while
    // A's shot upload is still pending — no owner waits behind another
    // owner's network round trip. (Written against the round-6 base, this
    // probe pinned the opposite: B's save and drain queued behind A's WHOLE
    // drain, the L1 starvation the round fixes.)
    await saveB;
    for (let i = 0; i < 2000 && tb.sessionCalls.length === 0; i += 1) {
      await ticks(1);
    }
    expect(tb.sessionCalls).toHaveLength(1);
    expect(ta.shotCalls).toHaveLength(1);
    ta.shotCalls[0]!.d.resolve(acceptAll(ta.shotCalls[0]!.shots));
    const ra = await drainA;
    tb.sessionCalls[0]!.resolve();
    await ticks(50);
    tb.shotCalls[0]!.d.resolve(acceptAll(tb.shotCalls[0]!.shots));
    const rb = await drainB;
    expect([ra.synced, rb.synced]).toEqual([2, 2]);
    expect(await ownerFootprint(db, OWNER_A)).toMatchObject({
      outbox: 0,
      sync_receipt: 1,
    });
    expect(await ownerFootprint(db, OWNER_B)).toMatchObject({
      outbox: 0,
      sync_receipt: 1,
    });
    const receipts = await db.execute(
      `SELECT owner_key, entity_id FROM sync_receipt ORDER BY owner_key`,
    );
    expect(receipts.rows).toEqual([
      { owner_key: OWNER_A, entity_id: shotId(1) },
      { owner_key: OWNER_B, entity_id: shotId(2) },
    ]);
    expect(getActiveDataOwner()).toBe(OWNER_B);
  });

  it('A2.5 probe — an accepted session.create for owner B never unparks owner A parked shots of the same set id', async () => {
    // Owner A: set X refused 8 times, shot parked.
    await saveShot(db, 1, SET_X);
    const refuse: SyncTransport = {
      async createSession() {
        throw new ApiError(409, 'session.id_conflict', 'belongs to another');
      },
      async finalizeSession() {},
      async syncShots(shots) {
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: string }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          })),
        };
      },
    };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, refuse);
    }
    expect((await getShotOutboxStatus(db, shotId(1))).state).toBe('orphaned');
    // Owner B owns set X on the server and creates it fine.
    setActiveDataOwner(OWNER_B);
    await saveShot(db, 2, SET_X);
    const accept: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        return acceptAll(shots);
      },
    };
    expect((await drainOutbox(db, accept)).synced).toBe(2);
    setActiveDataOwner(OWNER_A);
    const rowsA = await outboxRows(db, OWNER_A);
    expect(rowsA.map(r => [r.kind, r.attempts])).toEqual([
      ['session.create', OUTBOX_MAX_ATTEMPTS],
      ['shot.sync', 0],
    ]);
    expect((await getShotOutboxStatus(db, shotId(1))).state).toBe('orphaned');
  });

  it('A2.6 probe — purge during the SESSION pass round trip: the accepted create is not retired for the purged owner and nothing survives', async () => {
    await saveShot(db, 1, SET_X);
    const { transport, sessionCalls } = manualTransport();
    const drain = drainOutbox(db, transport);
    await ticks(50);
    const purge = purgeOwnerData(db, OWNER_A);
    await ticks(50);
    await purge;
    sessionCalls[0]!.resolve();
    const result = await drain;
    expect(result).toEqual({ synced: 0, failed: 0, remaining: 0 });
    expect(await ownerFootprint(db, OWNER_A)).toEqual({
      local_shot: 0,
      local_session: 0,
      outbox: 0,
      sync_receipt: 0,
    });
  });

  it('A2.7 probe — a purge that completes BEFORE a queued drain starts does not spuriously fence that drain', async () => {
    // Drain queued behind a purge in the same tick: the drain must still
    // settle rows saved by the new incarnation.
    await saveShot(db, 1, SET_X);
    const purge = purgeOwnerData(db, OWNER_A);
    const { transport, sessionCalls, shotCalls } = manualTransport();
    const drain = drainOutbox(db, transport);
    await purge;
    await ticks(50);
    // Nothing to offer (bucket empty) → drain ends.
    expect(sessionCalls).toHaveLength(0);
    expect(shotCalls).toHaveLength(0);
    expect(await drain).toEqual({ synced: 0, failed: 0, remaining: 0 });
    // Re-sign-in, save, drain: the fresh drain works.
    await saveShot(db, 2, SET_Y);
    const t2 = manualTransport();
    const d2 = drainOutbox(db, t2.transport);
    await ticks(50);
    t2.sessionCalls[0]!.resolve();
    await ticks(50);
    t2.shotCalls[0]!.d.resolve(acceptAll(t2.shotCalls[0]!.shots));
    expect((await d2).synced).toBe(2);
  });
});
