/**
 * Adversary round 8 — candidate `devin/fix8-mds-sqlite-a` @ 24fd777b.
 * Claim (1): "every standalone write (kv, trialCapture, repository) goes
 * through the lease" and the lease is "reentrant". transaction.ts documents
 * reentrancy for nested calls ON THE SAME LEASE OBJECT, but every public
 * entry point (`runInTransaction`, `withConnection`, `setKv`, …) mints a
 * fresh Lease — so a standalone write issued while a repository transaction
 * is open on the same connection waits for itself, forever, with no error
 * and `connectionWaiters()` stuck at 1.
 *
 * This file is isolated: after the deadlock the process-wide lease stays
 * held, so no later test in the same worker could take the connection.
 */
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
import { getKv, setKv } from '../../../src/data/repository';
import {
  connectionLease,
  connectionWaiters,
  runInTransaction,
} from '../../../src/data/transaction';
import { CANONICAL_USER } from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

async function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ kind: 'done'; value: T } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.then(value => ({ kind: 'done' as const, value })),
    new Promise<{ kind: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

describe('attack-fix8-a L2 — standalone write inside an open repository transaction', () => {
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('L2.1 probe — nested hold/transaction on the SAME lease object runs inline (documented reentrancy holds)', async () => {
    setActiveDataOwner(OWNER);
    const db = getDb();
    const lease = connectionLease(db);
    const outcome = await bounded(
      lease.transaction(async () => {
        await lease.hold(() =>
          db.execute(
            `INSERT OR REPLACE INTO kv (key, value) VALUES ('same', 'lease')`,
          ),
        );
        return lease.hold(() =>
          db.execute(`SELECT value FROM kv WHERE key = 'same'`),
        );
      }),
      1_000,
    );
    expect(outcome).toEqual({
      kind: 'done',
      value: { rows: [{ value: 'lease' }] },
    });
    expect(connectionWaiters()).toBe(0);
  });

  it('L2.2 BREAK — setKv (withConnection) inside runInTransaction on the same connection never completes: no error, one waiter forever', async () => {
    setActiveDataOwner(OWNER);
    const db = getDb();
    const outcome = await bounded(
      runInTransaction(db, async () => {
        await setKv(db, 'nested', 'write');
        return getKv(db, 'nested');
      }),
      1_000,
    );
    // Observed: { kind: 'timeout' } with connectionWaiters() === 1 and the
    // transaction left open (BEGIN IMMEDIATE never reaches COMMIT/ROLLBACK).
    // Expected under the reentrancy claim: 'write', waiters 0.
    expect({ outcome, waiters: connectionWaiters() }).toEqual({
      outcome: { kind: 'done', value: 'write' },
      waiters: 0,
    });
  });
});
