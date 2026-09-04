import type { LocalDb } from './db';

/**
 * The single connection-access primitive for the local store. Lives beside
 * db.ts (which is the native op-sqlite boundary) so the pure data layer —
 * repository.ts, sync.ts and their fake-driver tests — can use it without
 * loading the native module.
 *
 * The store is ONE SQLite connection, and a transaction belongs to the
 * connection, not to the caller that opened it: a statement issued by anyone
 * while a `BEGIN IMMEDIATE` is open joins that transaction — it sees its
 * uncommitted rows and is rolled back with it. So every group of statements
 * that must not interleave with a repository transaction (the outbox drain's
 * page reads, verdict bookkeeping, receipts, self-heal inserts) takes a turn
 * on this queue too, through `runExclusive`; `runInTransaction` is one such
 * turn that wraps its statements in BEGIN IMMEDIATE … COMMIT. Between turns
 * the connection is always in autocommit with everything earlier committed
 * or rolled back.
 *
 * The queue is process-wide, not keyed by the `LocalDb` handle: a handle is
 * only a facade over the connection (`getDb()` hands out one; callers may
 * decorate it), so two handles never mean two connections here, while two
 * connections would only be over-serialized — never interleaved.
 */
let connectionQueue: Promise<void> = Promise.resolve();

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
 * The connection, held for one turn. `transaction` opens BEGIN IMMEDIATE …
 * COMMIT (ROLLBACK on failure) on `db` without queueing again — the caller
 * already holds the turn — so a statement group can mix plain autocommit
 * statements and transactions without ever nesting a BEGIN.
 */
export interface ConnectionTurn {
  transaction<T>(db: LocalDb, operation: () => Promise<T>): Promise<T>;
}

const connectionTurn: ConnectionTurn = {
  transaction: runTransactionNow,
};

/**
 * Runs `operation` after every earlier turn on the connection has finished
 * and before any later one starts. Statements issued inside `operation` run
 * in autocommit unless wrapped by `turn.transaction`. Do not open
 * transactions with bare `db.execute`; do not call `runExclusive` or
 * `runInTransaction` from inside `operation` (it would wait on itself).
 */
export function runExclusive<T>(
  operation: (turn: ConnectionTurn) => Promise<T>,
): Promise<T> {
  const turn = connectionQueue.then(() => operation(connectionTurn));
  connectionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/**
 * Runs `operation` inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on failure)
 * as one exclusive turn on the connection, so transactions never nest and
 * no other turn's statements land inside it.
 */
export function runInTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  return runExclusive(turn => turn.transaction(db, operation));
}
