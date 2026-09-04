/**
 * C2 — `saveAnalysis()` (repository.ts `inTransaction`) and the accepted-shot
 * receipt block in `drainOutbox()` (sync.ts) both issue `BEGIN IMMEDIATE` on
 * the ONE shared connection returned by `getDb()`. SQLite has no nested
 * transactions on a single connection, so whichever caller's BEGIN lands
 * second fails with "cannot start a transaction within a transaction"; its
 * ROLLBACK then tears down the OTHER caller's open transaction, whose COMMIT
 * fails with "no transaction is active".
 *
 * Both orderings are driven here with the real statements against real
 * SQLite; the interleaving point is the microtask boundary every native
 * `execute` crosses. Expected (fails on baseline, passes when the two writers
 * are serialised or share one transaction scope): a new rating is durably
 * saved AND an accepted shot's receipt is written, regardless of ordering.
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
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

/** Wraps the shared connection so a hook can fire when a given statement is
 * about to run — the moment another caller would be scheduled on device. */
function observed(db: LocalDb, onStatement: (sql: string) => void): LocalDb {
  return {
    async execute(sql, params) {
      onStatement(sql);
      return db.execute(sql, params);
    },
    close: () => db.close(),
  };
}

async function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([p]);
  return result;
}

function describeSettled(result: PromiseSettledResult<unknown>): string {
  return result.status === 'fulfilled'
    ? 'fulfilled'
    : `rejected: ${String(result.reason)}`;
}

/** Statements the live connection ran since `from`, in order. */
function statementLog(from: number): string[] {
  const live = mockSqlite.opened[mockSqlite.opened.length - 1];
  if (!live) throw new Error('no connection opened');
  return live.log.slice(from);
}

/** Every BEGIN must be closed by COMMIT/ROLLBACK before the next BEGIN —
 * SQLite has no nested transactions on one connection. */
function maxTransactionDepth(log: string[]): number {
  let depth = 0;
  let max = 0;
  for (const sql of log) {
    const head = sql.trim().toUpperCase();
    if (head.startsWith('BEGIN')) {
      depth++;
      max = Math.max(max, depth);
    } else if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

describe('C2: shared-connection BEGIN IMMEDIATE collision (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('ordering A: drain receipt txn opens first; a concurrent saveAnalysis must still persist the new rating', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const logStart = statementLog(0).length;
    let saved: Promise<PromiseSettledResult<void>> | null = null;
    const drainDb = observed(db, sql => {
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt') && !saved) {
        // The user's next rating finishes while the drain is inside its txn.
        saved = settle(
          saveAnalysis(db, realAnalysis({ id: shotId(2) }), PERMIT_ID),
        );
      }
    });
    const drainResult = await settle(
      drainOutbox(drainDb, acceptAllTransport()),
    );
    if (!saved) throw new Error('interleaving hook never fired');
    const saveResult = await saved;

    expect(describeSettled(saveResult)).toBe('fulfilled');
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toContain(
      'shot.sync',
    );
    expect(describeSettled(drainResult)).toBe('fulfilled');
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_error ?? '').not.toContain('transaction');
    expect(maxTransactionDepth(statementLog(logStart))).toBe(1);
  });

  it('ordering B: saveAnalysis opens first; a concurrent accepted-shot receipt must still be recorded', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const logStart = statementLog(0).length;
    const transport = acceptAllTransport();
    let drain: Promise<PromiseSettledResult<unknown>> | null = null;
    const saveDb = observed(db, sql => {
      if (sql.includes('INSERT INTO outbox') && !drain) {
        // The runtime's drain (already past its network call) lands its
        // receipt while the save transaction is open.
        drain = settle(drainOutbox(db, transport));
      }
    });
    const saveResult = await settle(
      saveAnalysis(saveDb, realAnalysis({ id: shotId(2) }), PERMIT_ID),
    );
    if (!drain) throw new Error('interleaving hook never fired');
    const drainResult = await drain;

    expect(describeSettled(drainResult)).toBe('fulfilled');
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(describeSettled(saveResult)).toBe('fulfilled');
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    // The drain requested while the save was open runs after its COMMIT and
    // reads the committed queue: the second rating is delivered by it too.
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(true);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    expect(maxTransactionDepth(statementLog(logStart))).toBe(1);
  });
});
