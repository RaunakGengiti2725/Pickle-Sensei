/**
 * MDS-2 regression: transactions on the ONE shared SQLite connection must be
 * serialized.
 *
 * `getDb()` hands every caller the same op-sqlite connection, whose `execute`
 * resolves asynchronously — so a scoring run finishing (`saveAnalysis`) and a
 * timer/foreground drain writing an accepted shot's receipt (`drainOutbox`)
 * can both be in flight. SQLite has no nested transactions on one connection:
 * whichever `BEGIN IMMEDIATE` lands second used to fail with "cannot start a
 * transaction within a transaction", and its ROLLBACK tore down the other
 * caller's transaction, losing either a scored rating or an accepted shot's
 * receipt.
 *
 * Contract asserted here, against real SQLite, in BOTH orderings:
 *   1. both writers' transactions commit (no statement raises "cannot start a
 *      transaction within a transaction" or "no transaction is active"),
 *   2. the rating is durably saved AND the accepted shot's receipt exists,
 *   3. no transaction's statements interleave with another transaction's —
 *      at most one writer is inside a transaction at any point in the
 *      statement timeline of the shared connection.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/localDbTransactionSerialization.test.ts
 */
import { createRealSqliteModule } from '../test-support/realSqlite';

const mockSqlite = createRealSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import type { LocalDb } from '../src/data/db';
import { getDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../test-support/localDataFixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

type Actor = 'save' | 'drain';

interface TimelineEntry {
  actor: Actor;
  sql: string;
}

/** Records every statement of every actor on the shared connection, plus the
 * errors those statements raised, so ordering can be asserted afterwards. */
function recorder() {
  const timeline: TimelineEntry[] = [];
  const errors: string[] = [];
  const as = (actor: Actor, db: LocalDb): LocalDb => ({
    async execute(sql, params) {
      timeline.push({ actor, sql });
      try {
        return await db.execute(sql, params);
      } catch (error) {
        errors.push(String(error));
        throw error;
      }
    },
    close: () => db.close(),
  });
  return { timeline, errors, as };
}

/**
 * Every point where two actors' transactions overlapped on the shared
 * connection: a BEGIN issued while another actor's transaction is open, or a
 * COMMIT/ROLLBACK closing a transaction the issuer does not own. While at
 * most one actor is ever inside a transaction, no transaction's statements
 * can interleave with another transaction's.
 */
function transactionOverlaps(timeline: TimelineEntry[]): string[] {
  const overlaps: string[] = [];
  let holder: Actor | null = null;
  for (const { actor, sql } of timeline) {
    if (sql === 'BEGIN IMMEDIATE') {
      if (holder !== null) {
        overlaps.push(`${actor} BEGIN while ${holder} held a transaction`);
      }
      holder = actor;
      continue;
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (holder !== null && holder !== actor) {
        overlaps.push(`${actor} ${sql} while ${holder} held a transaction`);
      }
      holder = null;
    }
  }
  return overlaps;
}

function acceptAll(): SyncTransport {
  return {
    async syncShots(shots) {
      return {
        acceptedIds: shots.map(shot =>
          String((shot as Record<string, unknown>)['id']),
        ),
        rejected: [],
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

async function settled<T>(promise: Promise<T>): Promise<string> {
  const [result] = await Promise.allSettled([promise]);
  return result.status === 'fulfilled'
    ? 'fulfilled'
    : `rejected: ${String(result.reason)}`;
}

describe('local SQLite transactions are serialized on the shared connection', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute('DELETE FROM outbox');
    await db.execute('DELETE FROM local_shot');
    await db.execute('DELETE FROM sync_receipt');
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('a rating saved while the drain holds its receipt transaction still commits, and neither transaction interleaves', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const record = recorder();
    let save: Promise<string> | null = null;
    const drainDb = record.as(
      'drain',
      // The scoring run finishes while the drain is inside its transaction.
      observe(db, sql => {
        if (sql.includes('INSERT OR REPLACE INTO sync_receipt') && !save) {
          save = settled(
            saveAnalysis(
              record.as('save', db),
              realAnalysis({ id: shotId(2) }),
              PERMIT_ID,
            ),
          );
        }
      }),
    );

    const drain = await settled(drainOutbox(drainDb, acceptAll()));
    if (!save) throw new Error('the interleaving hook never fired');

    expect(await save).toBe('fulfilled');
    expect(drain).toBe('fulfilled');
    expect(record.errors).toEqual([]);
    expect(transactionOverlaps(record.timeline)).toEqual([]);
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect((await outboxRows(db, OWNER)).map(row => row.kind)).toEqual([
      'shot.sync',
    ]);
  });

  it('an accepted shot still gets its receipt while a save transaction is open, and neither transaction interleaves', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const record = recorder();
    let drain: Promise<string> | null = null;
    const saveDb = record.as(
      'save',
      // The runtime's drain (already past its network call) lands its receipt
      // while the save transaction is open — the mirror ordering.
      observe(db, sql => {
        if (sql.startsWith('INSERT INTO outbox') && !drain) {
          drain = settled(drainOutbox(record.as('drain', db), acceptAll()));
        }
      }),
    );

    const save = await settled(
      saveAnalysis(saveDb, realAnalysis({ id: shotId(2) }), PERMIT_ID),
    );
    if (!drain) throw new Error('the interleaving hook never fired');

    expect(await drain).toBe('fulfilled');
    expect(save).toBe('fulfilled');
    expect(record.errors).toEqual([]);
    expect(transactionOverlaps(record.timeline)).toEqual([]);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    expect((await outboxRows(db, OWNER)).map(row => row.kind)).toEqual([
      'shot.sync',
    ]);
  });
});

/** Fires `onStatement` just before a statement runs — the moment another
 * caller would be scheduled onto the shared connection on device. */
function observe(db: LocalDb, onStatement: (sql: string) => void): LocalDb {
  return {
    async execute(sql, params) {
      onStatement(sql);
      return db.execute(sql, params);
    },
    close: () => db.close(),
  };
}
