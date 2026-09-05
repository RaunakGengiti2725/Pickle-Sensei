/**
 * Adversary round 8 — candidate `devin/fix8-mds-sqlite-a` @ 24fd777b.
 * Claim (1): the lease is held per statement group, released across every
 * network await and on every error path; "a statement group that fails
 * (disk full, a closed database) is a row-level failure, never a thrown
 * drain and never a leaked connection" (sync.ts, drainOwnerOutbox doc).
 *
 * Real `node:sqlite` on disk; the faults are REAL: SQLITE_BUSY from a second
 * connection holding a write lock, SQLITE_FULL via `max_page_count`, the
 * live database closed during a network await. Only the transport is mocked.
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
  getKv,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  setKv,
} from '../../../src/data/repository';
import { connectionWaiters } from '../../../src/data/transaction';
import { drainOutbox, type SyncTransport } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

interface Accepting extends SyncTransport {
  offers: string[][];
}

function accepting(): Accepting {
  const offers: string[][] = [];
  return {
    offers,
    async createSession() {},
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      offers.push(ids);
      return { acceptedIds: ids, rejected: [] };
    },
  };
}

async function drainOutcome(db: LocalDb, t: SyncTransport) {
  try {
    return { kind: 'resolved' as const, result: await drainOutbox(db, t) };
  } catch (error) {
    return { kind: 'thrown' as const, error: String(error) };
  }
}

describe('attack-fix8-a L1 — lease error paths under real SQLite faults', () => {
  let db: LocalDb;
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
    await db.execute(`DELETE FROM kv`);
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('L1.1 probe — SQLITE_BUSY (second connection holds BEGIN IMMEDIATE) during settlement: drain resolves, row uncharged, lease released, next drain delivers', async () => {
    const list = await db.execute('PRAGMA database_list');
    const file = String(list.rows[0]?.['file']);
    const { DatabaseSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:sqlite') as typeof import('node:sqlite');
    const other = new DatabaseSync(file);
    const id = shotId(0xc100);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const t = accepting();
    const inner = t.syncShots.bind(t);
    t.syncShots = async shots => {
      other.exec('BEGIN IMMEDIATE');
      return inner(shots);
    };
    const first = await drainOutcome(db, t);
    other.exec('ROLLBACK');
    other.close();
    expect(first).toEqual({
      kind: 'resolved',
      result: { synced: 0, failed: 1, remaining: 1 },
    });
    expect(connectionWaiters()).toBe(0);
    expect(await getShotOutboxStatus(db, id)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(await hasShotSyncReceipt(db, id)).toBe(false);
    t.syncShots = inner;
    expect(await drainOutbox(db, t)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await hasShotSyncReceipt(db, id)).toBe(true);
    expect(t.offers).toEqual([[id], [id]]);
  });

  it('L1.2 probe — SQLITE_FULL (max_page_count) when the accepted receipt is written: uncharged, no receipt, re-offered once space returns', async () => {
    const id = shotId(0xc200);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const t = accepting();
    const inner = t.syncShots.bind(t);
    let fullError = '';
    t.syncShots = async shots => {
      const pages = await db.execute('PRAGMA page_count');
      await db.execute(
        `PRAGMA max_page_count = ${Number(pages.rows[0]?.['page_count'])}`,
      );
      for (let i = 0; i < 100_000 && fullError === ''; i += 1) {
        try {
          await db.execute(
            `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES ('zz', 'junk', ?)`,
            [`j${i}-${'x'.repeat(200)}`],
          );
        } catch (error) {
          fullError = String(error);
        }
      }
      return inner(shots);
    };
    const first = await drainOutcome(db, t);
    expect(fullError).toContain('full');
    expect(first).toEqual({
      kind: 'resolved',
      result: { synced: 0, failed: 1, remaining: 1 },
    });
    expect(connectionWaiters()).toBe(0);
    const { rows } = await db.execute(
      `SELECT attempts, refusals, last_error FROM outbox WHERE owner_key = ?`,
      [OWNER],
    );
    expect(rows).toEqual([
      {
        attempts: 0,
        refusals: 0,
        last_error: 'Error: database or disk is full',
      },
    ]);
    expect(await hasShotSyncReceipt(db, id)).toBe(false);
    await db.execute(`PRAGMA max_page_count = 1073741823`);
    await db.execute(`DELETE FROM sync_receipt WHERE owner_key = 'zz'`);
    t.syncShots = inner;
    expect(await drainOutbox(db, t)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await hasShotSyncReceipt(db, id)).toBe(true);
    expect(t.offers).toEqual([[id], [id]]);
  });

  it('L1.3 BREAK — the database closed during the network await: the drain THROWS ("never a thrown drain"), though the lease is released and nothing is charged', async () => {
    const id = shotId(0xc300);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const t = accepting();
    const inner = t.syncShots.bind(t);
    let closeOnce = true;
    t.syncShots = async shots => {
      if (closeOnce) {
        closeOnce = false;
        getDb().close();
      }
      return inner(shots);
    };
    const first = await drainOutcome(db, t);
    // Lease: not leaked (the re-opened handle serves a save and a drain).
    expect(connectionWaiters()).toBe(0);
    const fresh = getDb();
    expect(await getShotOutboxStatus(fresh, id)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(await hasShotSyncReceipt(fresh, id)).toBe(false);
    expect(await drainOutbox(fresh, t)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    db = fresh;
    // Observed: { kind: 'thrown', error: 'Error: database is not open' }.
    // Expected per the documented invariant: a resolved drain reporting the
    // failed row.
    expect(first).toEqual({
      kind: 'resolved',
      result: { synced: 0, failed: 1, remaining: 1 },
    });
  });

  it('L1.4 probe — transport throws synchronously BEFORE any await (lease already released): row uncharged, drain resolves', async () => {
    const id = shotId(0xc400);
    await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    const t = accepting();
    t.syncShots = () => {
      throw new TypeError('transport exploded before the request');
    };
    expect(await drainOutcome(db, t)).toEqual({
      kind: 'resolved',
      result: { synced: 0, failed: 1, remaining: 1 },
    });
    expect(connectionWaiters()).toBe(0);
    expect(await getShotOutboxStatus(db, id)).toMatchObject({
      state: 'queued',
      attempts: 0,
      lastError: 'TypeError: transport exploded before the request',
    });
  });

  it('L1.5 probe — 1,000 seeded interleaved saveAnalysis/drain/kv/purge calls: no hang, no lost or duplicated row; records the peak waiter depth', async () => {
    const t = accepting();
    let maxWaiters = 0;
    const tick = () => {
      maxWaiters = Math.max(maxWaiters, connectionWaiters());
    };
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ops: Promise<unknown>[] = [];
    let saves = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = rnd();
      if (r < 0.5) {
        saves += 1;
        ops.push(
          saveAnalysis(
            db,
            realAnalysis({ id: shotId(0xc500 + i) }),
            PERMIT_ID,
          ).then(tick),
        );
      } else if (r < 0.8) {
        ops.push(drainOutbox(db, t).then(tick));
      } else if (r < 0.98) {
        ops.push(setKv(db, `k${i % 10}`, `v${i}`).then(tick));
        ops.push(getKv(db, `k${i % 10}`).then(tick));
      } else {
        ops.push(purgeOwnerData(db, OWNER).then(tick));
      }
      tick();
    }
    await Promise.all(ops);
    await drainOutbox(db, t);
    expect(connectionWaiters()).toBe(0);
    const count = async (sql: string) =>
      Number((await db.execute(sql, [OWNER])).rows[0]?.['n']);
    const shots = await count(
      `SELECT count(*) AS n FROM local_shot WHERE owner_key = ?`,
    );
    const receipts = await count(
      `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ?`,
    );
    const outbox = await count(
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
    );
    // Every surviving local shot has exactly one receipt and the queue is
    // empty; purges (preempting) ran ahead of the ordinary queue.
    expect({ outbox, receiptsMatchShots: receipts === shots }).toEqual({
      outbox: 0,
      receiptsMatchShots: true,
    });
    expect(shots).toBeLessThanOrEqual(saves);
    const accepted = new Set(t.offers.flat());
    expect(accepted.size).toBeGreaterThanOrEqual(shots);
    // Measured lease_waiters_max for the deliverable (a burst of 1,000
    // concurrent callers queues; it does not leak — waiters return to 0).
    expect(maxWaiters).toBeGreaterThan(0);
    expect(maxWaiters).toBeLessThanOrEqual(1000);
  }, 60_000);
});
