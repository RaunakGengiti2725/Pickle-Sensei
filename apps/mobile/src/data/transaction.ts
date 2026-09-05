import type { LocalDb } from './db';

/**
 * The app holds ONE SQLite connection and SQLite transactions are per
 * connection: a statement issued while another caller's BEGIN is open joins
 * that transaction (and is rolled back with it), and a SELECT issued then
 * reads its uncommitted rows. Every statement group that must do neither
 * takes the connection through this module, which hands it to one holder at
 * a time, in arrival order, for exactly one statement group:
 *
 *  - `runInTransaction` holds the connection for one
 *    BEGIN IMMEDIATE … COMMIT/ROLLBACK.
 *  - `withConnection` holds it for a short run of autocommit statements
 *    (a page SELECT, a verdict UPDATE) that must not land inside anyone
 *    else's open transaction.
 *  - `connectionLease` gives a longer unit of work (an outbox drain) a handle
 *    whose `hold` / `transaction` take the connection per statement group
 *    and let it go before returning. Nothing is held BETWEEN groups — in
 *    particular not while the unit awaits the network — so a repository
 *    transaction started during a network round trip commits before the
 *    unit's next statement group, and a purge of the owner can run in the
 *    same window (the unit re-reads what it relies on after every gap).
 *    Nested `hold`/`transaction` calls on the same lease run inline on the
 *    already-held connection instead of waiting for themselves.
 *
 * Every acquire is paired with a release in a `finally`, so a statement that
 * throws (disk full, SQLITE_BUSY on BEGIN, a closed database) hands the
 * connection to the next waiter exactly as a successful one does.
 */
export interface ConnectionLease {
  /** Runs `statements` (autocommit, no BEGIN) while holding the connection. */
  hold<T>(statements: () => Promise<T>): Promise<T>;
  /** BEGIN IMMEDIATE … COMMIT (ROLLBACK on error) while holding the connection. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

interface Waiter {
  start(): void;
}

/** Whether some caller currently holds the connection. */
let held = false;
/** Callers that may run ahead of ordinary waiters (an owner purge). */
const preemptingQueue: Waiter[] = [];
/** Ordinary callers, served in arrival order. */
const waitingQueue: Waiter[] = [];

function acquire(preempting: boolean): Promise<void> {
  if (!held) {
    held = true;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    (preempting ? preemptingQueue : waitingQueue).push({ start: resolve });
  });
}

function release(): void {
  const next = preemptingQueue.shift() ?? waitingQueue.shift();
  if (next === undefined) {
    held = false;
    return;
  }
  // The connection passes straight to `next`: `held` stays true.
  next.start();
}

/** Number of callers waiting for the connection right now (diagnostics). */
export function connectionWaiters(): number {
  return preemptingQueue.length + waitingQueue.length;
}

class Lease implements ConnectionLease {
  private depth = 0;

  constructor(
    private readonly db: LocalDb,
    private readonly preempting: boolean,
  ) {}

  async hold<T>(statements: () => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return await statements();
      } finally {
        this.depth -= 1;
      }
    }
    await acquire(this.preempting);
    this.depth = 1;
    try {
      return await statements();
    } finally {
      this.depth = 0;
      release();
    }
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.hold(async () => {
      await this.db.execute('BEGIN IMMEDIATE');
      try {
        const result = await operation();
        await this.db.execute('COMMIT');
        return result;
      } catch (error) {
        try {
          await this.db.execute('ROLLBACK');
        } catch {
          // Preserve the original persistence error.
        }
        throw error;
      }
    });
  }
}

/** A lease for a unit of work that takes the connection per statement group. */
export function connectionLease(db: LocalDb): ConnectionLease {
  return new Lease(db, false);
}

/** Holds the connection for one group of autocommit statements. */
export function withConnection<T>(
  db: LocalDb,
  statements: () => Promise<T>,
): Promise<T> {
  return new Lease(db, false).hold(statements);
}

/** One transaction, serialized behind every earlier caller. */
export function runInTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  return new Lease(db, false).transaction(operation);
}

/**
 * One transaction served ahead of the ordinary queue, for a write that
 * invalidates the work of whoever is waiting (purging the owner's bucket
 * while a drain awaits the server); the affected unit learns of it through
 * the state the write leaves behind (a purge generation, the rows
 * themselves). It still waits for the statement group in flight.
 */
export function runPreemptingTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  return new Lease(db, true).transaction(operation);
}
