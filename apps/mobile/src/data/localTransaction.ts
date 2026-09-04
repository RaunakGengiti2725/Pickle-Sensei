import type { LocalDb } from './db';

/**
 * Serializes transaction scopes across every caller of the ONE connection
 * `getDb()` hands out. SQLite has no nested transactions on a single
 * connection, and op-sqlite's `execute` resolves asynchronously, so a scoring
 * run's `saveAnalysis` and a timer/foreground `drainOutbox` can otherwise both
 * issue `BEGIN IMMEDIATE`: the second one fails with "cannot start a
 * transaction within a transaction" and its ROLLBACK tears down the first
 * one's transaction, losing a scored rating or an accepted shot's receipt.
 *
 * Callers queue here, run their whole BEGIN…COMMIT alone, and keep the
 * original failure (a ROLLBACK that itself fails never replaces it). Nesting
 * one transaction scope inside another would deadlock the queue — a
 * transaction body must issue plain statements only.
 *
 * Lives apart from db.ts on purpose: db.ts loads the native op-sqlite module,
 * and the pure data layer (repository.ts, sync.ts) only ever imported its
 * types so Jest can drive it with a fake driver.
 */
let transactionQueue: Promise<void> = Promise.resolve();

export function withLocalTransaction(
  db: LocalDb,
  operation: () => Promise<void>,
): Promise<void> {
  const turn = transactionQueue.then(() => runTransaction(db, operation));
  // One caller's failure must not reject the next caller's turn.
  transactionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

async function runTransaction(
  db: LocalDb,
  operation: () => Promise<void>,
): Promise<void> {
  await db.execute('BEGIN IMMEDIATE');
  try {
    await operation();
    await db.execute('COMMIT');
  } catch (error) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}
