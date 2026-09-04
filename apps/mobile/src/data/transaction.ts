import type { LocalDb } from './db';

/**
 * The single transaction entry point for the local store. Lives beside
 * db.ts (which is the native op-sqlite boundary) so the pure data layer —
 * repository.ts, sync.ts and their fake-driver tests — can use it without
 * loading the native module.
 *
 * The store is ONE SQLite connection and SQLite has no nested transactions,
 * so every writer that opens its own `BEGIN IMMEDIATE` (repository saves, the
 * outbox drain's receipt/delete) must take a turn on this process-wide queue;
 * otherwise two interleaved writers collide ("cannot start a transaction
 * within a transaction") and the loser's ROLLBACK tears down the winner's
 * uncommitted work.
 */
let transactionQueue: Promise<void> = Promise.resolve();

async function runTransactionNow<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  await db.execute('BEGIN IMMEDIATE');
  try {
    const result = await operation();
    await db.execute('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

/**
 * Runs `operation` inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on failure)
 * after every earlier transaction in the process has finished, so
 * transactions never nest on the shared connection. Do not open transactions
 * with bare `db.execute`; do not start a nested `runInTransaction` from
 * inside `operation` (it would wait on itself).
 */
export function runInTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  const turn = transactionQueue.then(() => runTransactionNow(db, operation));
  transactionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}
