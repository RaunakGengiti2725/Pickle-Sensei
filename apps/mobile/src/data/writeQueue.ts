import type { LocalDb } from './db';

/**
 * One write queue per connection. SQLite allows a single open transaction per
 * connection: a `BEGIN` issued while another caller's transaction is open
 * fails ("cannot start a transaction within a transaction") and the loser's
 * `ROLLBACK` then tears down the winner's work. Every transaction on a
 * `LocalDb` — and every write that must not land inside somebody else's
 * transaction — takes this lock first, so callers queue in FIFO order instead
 * of interleaving on the connection.
 */
const writeQueues = new WeakMap<LocalDb, Promise<void>>();

export async function withWriteLock<T>(
  db: LocalDb,
  task: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(db) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  writeQueues.set(db, turn);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (writeQueues.get(db) === turn) writeQueues.delete(db);
  }
}

/**
 * Runs `operation` inside `BEGIN IMMEDIATE … COMMIT` on `db`, serialized
 * behind every other transaction on the same connection. A failure inside
 * rolls the whole unit back and rethrows the original error.
 */
export function withWriteTransaction(
  db: LocalDb,
  operation: () => Promise<void>,
): Promise<void> {
  return withWriteLock(db, async () => {
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
  });
}
