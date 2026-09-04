/**
 * Review round 7 (candidate A, 9a00ceb1) — scratch probes for the connection
 * lease in src/data/transaction.ts, on real node:sqlite:
 *
 *  L1 deadlock: a drain awaiting the network while saveAnalysis wants the
 *     lease — the save waits for the drain and then commits.
 *  L2 deadlock: a repository txn awaiting inside the lease while a drain
 *     (receipt) wants it — the drain waits, then receipts.
 *  L3 purge preempts the suspended drain and the drain settles nothing.
 *  L4 account switch mid-drain: the drain stays bound to its owner; a drain
 *     for the new owner waits and then runs.
 *  L5 release on every error path: BEGIN IMMEDIATE throws (SQLITE_BUSY),
 *     throw inside a statement group, closed connection, throw inside a
 *     suspended network window, throw inside withConnection with a
 *     preemptor queued.
 *  L6 1,000 interleaved saveAnalysis / drain calls: all settle, no leaked
 *     holder, outstanding waiters never exceed the number of callers.
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
  getAnalysis,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import {
  runInTransaction,
  runPreemptingTransaction,
  withConnection,
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
const OTHER_USER = '22222222-2222-4333-8444-555555555555';
const OTHER = canonicalDataOwner(OTHER_USER);

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

async function settleMicrotasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([p]);
  return result;
}

/** A transport whose syncShots call blocks until `gate` resolves. */
function gatedTransport(gate: Promise<void>) {
  const base = acceptAllTransport();
  let calls = 0;
  const transport: SyncTransport & { calls: () => number } = {
    calls: () => calls,
    async syncShots(shots) {
      calls += 1;
      await gate;
      return base.syncShots(shots);
    },
    createSession: base.createSession,
    finalizeSession: base.finalizeSession,
  };
  return { transport, base };
}

/** Probe: does a fresh transaction run right away (lease free)? */
async function leaseIsFree(db: LocalDb): Promise<boolean> {
  let ran = false;
  const p = runInTransaction(db, async () => {
    ran = true;
  });
  await settleMicrotasks(10);
  await p;
  return ran;
}

describe('review7 / connection lease liveness (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('L1: saveAnalysis wanting the lease while a drain awaits the network waits for the drain, then commits (no deadlock)', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const gate = deferred<void>();
    const { transport } = gatedTransport(gate.promise);
    const drain = drainOutbox(db, transport);
    await settleMicrotasks(50);
    expect(transport.calls()).toBe(1);

    let saved = false;
    const save = saveAnalysis(
      db,
      realAnalysis({ id: shotId(2) }),
      PERMIT_ID,
    ).then(() => {
      saved = true;
    });
    await settleMicrotasks(50);
    // Ordinary callers wait for the whole drain (by design).
    expect(saved).toBe(false);

    gate.resolve();
    const result = await drain;
    await save;
    expect(saved).toBe(true);
    expect(result).toMatchObject({ synced: 1, failed: 0 });
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    expect(await outboxRows(db, OWNER)).toHaveLength(1);
    expect(await leaseIsFree(db)).toBe(true);
  });

  it('L2: a drain wanting the lease while a repository txn is open waits, then receipts against committed state only', async () => {
    const hold = deferred<void>();
    const txn = runInTransaction(db, async () => {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
        [
          OWNER,
          JSON.stringify({
            ...realAnalysis({ id: shotId(3) }),
            analysisPermitId: PERMIT_ID,
          }),
        ],
      );
      await hold.promise;
    });
    await settleMicrotasks(20);
    const transport = acceptAllTransport();
    const drain = drainOutbox(db, transport);
    await settleMicrotasks(50);
    expect(transport.syncCalls).toHaveLength(0);
    hold.resolve();
    await txn;
    const result = await drain;
    expect(result).toMatchObject({ synced: 1 });
    expect(await hasShotSyncReceipt(db, shotId(3))).toBe(true);
    expect(await leaseIsFree(db)).toBe(true);
  });

  it('L3: purgeOwnerData preempts a drain suspended on the network; the drain settles nothing and no receipt survives', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(4) }), PERMIT_ID);
    const gate = deferred<void>();
    const { transport } = gatedTransport(gate.promise);
    const drain = drainOutbox(db, transport);
    await settleMicrotasks(50);
    expect(transport.calls()).toBe(1);

    let purged = false;
    const purge = purgeOwnerData(db, OWNER).then(() => {
      purged = true;
    });
    await settleMicrotasks(200);
    // The purge ran INSIDE the network window, not after the drain.
    expect(purged).toBe(true);
    await purge;

    gate.resolve();
    const result = await drain;
    expect(result).toMatchObject({ synced: 0 });
    expect(await hasShotSyncReceipt(db, shotId(4))).toBe(false);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    expect(await leaseIsFree(db)).toBe(true);
  });

  it('L4: an account switch mid-drain leaves the drain bound to its owner; the new owner drains afterwards', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(5) }), PERMIT_ID);
    const gate = deferred<void>();
    const { transport } = gatedTransport(gate.promise);
    const drainA = drainOutbox(db, transport);
    await settleMicrotasks(50);

    setActiveDataOwner(OTHER);
    // The new owner's save and drain both queue behind drainA (ordinary
    // callers wait for the whole unit) — they must not deadlock it.
    const saveB = saveAnalysis(db, realAnalysis({ id: shotId(6) }), PERMIT_ID);
    const transportB = acceptAllTransport();
    const drainB = drainOutbox(db, transportB);
    await settleMicrotasks(50);
    expect(transportB.syncCalls).toHaveLength(0);

    gate.resolve();
    const a = await drainA;
    await saveB;
    const b = await drainB;
    expect(a).toMatchObject({ synced: 1 });
    expect(b).toMatchObject({ synced: 1 });
    // drainA settled OWNER's row (its bearer), never OTHER's; drainB the reverse.
    expect(transport.calls()).toBe(1);
    expect(transportB.syncCalls.flat()).toHaveLength(1);
    expect(await hasShotSyncReceipt(db, shotId(6))).toBe(true);
    setActiveDataOwner(OWNER);
    expect(await hasShotSyncReceipt(db, shotId(5))).toBe(true);
    expect(await leaseIsFree(db)).toBe(true);
  });

  it('L5: the lease is released on every error path', async () => {
    // (a) BEGIN IMMEDIATE itself fails (SQLITE_BUSY).
    const busyDb: LocalDb = {
      async execute(sql, params) {
        if (sql === 'BEGIN IMMEDIATE') {
          throw new Error('[op-sqlite] SQLITE_BUSY: database is locked');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await expect(runInTransaction(busyDb, async () => {})).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    expect(await leaseIsFree(db)).toBe(true);

    // (b) throw inside a statement group.
    await expect(
      runInTransaction(db, async () => {
        await db.execute(`INSERT INTO nope VALUES (1)`);
      }),
    ).rejects.toThrow();
    expect(await leaseIsFree(db)).toBe(true);
    await expect(
      withConnection(db, async lease => {
        await lease.transaction(async () => {
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');
    expect(await leaseIsFree(db)).toBe(true);

    // (c) closed connection: every statement fails.
    const closedDb: LocalDb = {
      async execute() {
        throw new Error('[op-sqlite] database is closed');
      },
      close: () => undefined,
    };
    await expect(
      runInTransaction(closedDb, async () => {}),
    ).rejects.toThrow(/closed/);
    await expect(drainOutbox(closedDb, acceptAllTransport())).rejects.toThrow(
      /closed/,
    );
    expect(await leaseIsFree(db)).toBe(true);

    // (d) throw inside the suspended network window.
    await expect(
      withConnection(db, async lease =>
        lease.suspendWhile(async () => {
          throw new Error('network');
        }),
      ),
    ).rejects.toThrow('network');
    expect(await leaseIsFree(db)).toBe(true);

    // (e) throw inside the network window WHILE a preemptor is running.
    const purgeHold = deferred<void>();
    const netFail = deferred<void>();
    const unit = withConnection(db, async lease =>
      lease.suspendWhile(() => netFail.promise),
    );
    await settleMicrotasks(10);
    let preemptorDone = false;
    const preempt = runPreemptingTransaction(db, async () => {
      await purgeHold.promise;
      preemptorDone = true;
    });
    await settleMicrotasks(10);
    netFail.reject(new Error('network down'));
    await settleMicrotasks(10);
    expect(preemptorDone).toBe(false);
    purgeHold.resolve();
    await preempt;
    await expect(unit).rejects.toThrow('network down');
    expect(await leaseIsFree(db)).toBe(true);

    // (f) a suspended lease refuses to open a transaction, and the error
    // releases the connection.
    await expect(
      withConnection(db, async lease =>
        lease.suspendWhile(async () => {
          await lease.transaction(async () => {});
        }),
      ),
    ).rejects.toThrow(/suspended/);
    expect(await leaseIsFree(db)).toBe(true);

    // (g) COMMIT fails: ROLLBACK is issued and the lease is released.
    let commits = 0;
    const commitFail: LocalDb = {
      async execute(sql, params) {
        if (sql === 'COMMIT' && commits++ === 0) {
          throw new Error('[op-sqlite] SQLITE_FULL');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await expect(
      saveAnalysis(commitFail, realAnalysis({ id: shotId(7) }), PERMIT_ID),
    ).rejects.toThrow(/SQLITE_FULL/);
    expect(await getAnalysis(db, shotId(7))).toBeNull();
    expect(await leaseIsFree(db)).toBe(true);
  });

  it('L6: 1,000 interleaved saveAnalysis / drain calls all settle with no leaked holder and bounded waiters', async () => {
    const transport = acceptAllTransport();
    let outstanding = 0;
    let maxOutstanding = 0;
    const track = <T>(p: Promise<T>): Promise<T> => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      return p.finally(() => {
        outstanding -= 1;
      });
    };
    const started = Date.now();
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i += 1) {
      if (i % 2 === 0) {
        calls.push(
          track(
            saveAnalysis(db, realAnalysis({ id: shotId(100 + i) }), PERMIT_ID),
          ),
        );
      } else {
        calls.push(track(drainOutbox(db, transport)));
      }
      if (i % 97 === 0) await settleMicrotasks(3);
    }
    const results = await Promise.allSettled(calls);
    const elapsedMs = Date.now() - started;
    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected).toEqual([]);
    expect(outstanding).toBe(0);
    expect(maxOutstanding).toBeLessThanOrEqual(1000);
    // Every saved shot was either receipted by one of the drains or is still
    // queued (never lost, never duplicated).
    const rows = await outboxRows(db, OWNER);
    const { rows: receipts } = await db.execute(
      `SELECT COUNT(*) AS n FROM sync_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    expect(rows.length + Number(receipts[0]!['n'])).toBe(500);
    const offered = transport.syncCalls.flat().map(s => String((s as { id: string }).id));
    expect(new Set(offered).size).toBe(offered.length);
    expect(await leaseIsFree(db)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `review7 L6: 1000 calls settled in ${elapsedMs}ms, maxOutstanding=${maxOutstanding}, receipts=${String(receipts[0]!['n'])}, remaining=${rows.length}`,
    );
  });
});
