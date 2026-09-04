import type { LocalDb } from './db';

/**
 * The app holds ONE SQLite connection and SQLite transactions are per
 * connection: a statement issued while another caller's BEGIN is open joins
 * that transaction (and is rolled back with it), and a SELECT issued then
 * reads its uncommitted rows. Every statement group that must do neither
 * takes the connection through this module, which hands it to one holder at
 * a time, in arrival order.
 *
 *  - `runInTransaction` holds the connection for exactly one
 *    BEGIN IMMEDIATE … COMMIT/ROLLBACK.
 *  - `withConnection` holds it for a longer unit of work (an outbox drain:
 *    read a page, offer it, settle it). Inside, `lease.transaction` opens a
 *    transaction directly — never nested — and `lease.suspendWhile` brackets
 *    an await that does not touch the connection (a network call). Ordinary
 *    callers still wait for the whole unit; only a PREEMPTING caller
 *    (`runPreemptingTransaction`: purging an owner's bucket) may run inside
 *    such a window, so the drain's statements never interleave with anyone
 *    else's and its verdicts land only in committed state.
 *
 * A holder must not take the connection again from inside its own unit of
 * work (it would wait for itself).
 */
export interface ConnectionLease {
  /** BEGIN IMMEDIATE … COMMIT (ROLLBACK on error) on the held connection. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Runs `work` (which must not touch the connection) and holds the
   * connection again before returning; a preempting caller may have used it
   * meanwhile, so the holder re-reads whatever it relies on.
   */
  suspendWhile<T>(work: () => Promise<T>): Promise<T>;
}

class Lease implements ConnectionLease {
  suspended = false;
  resumeWaiter: (() => void) | null = null;

  constructor(
    private readonly db: LocalDb,
    readonly start: () => void,
  ) {}

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.suspended) {
      throw new Error(
        'A suspended connection lease cannot open a transaction.',
      );
    }
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
  }

  async suspendWhile<T>(work: () => Promise<T>): Promise<T> {
    if (holder !== this || this.suspended) {
      throw new Error('Only the connection holder can suspend its lease.');
    }
    this.suspended = true;
    startPreemptor();
    try {
      return await work();
    } finally {
      if (preemptor !== null) {
        // `release` clears `suspended` synchronously before resuming, so no
        // further preemptor can start in the gap.
        await new Promise<void>(resolve => {
          this.resumeWaiter = resolve;
        });
      } else {
        this.suspended = false;
      }
    }
  }
}

/** The lease that owns the connection (it may be suspended). */
let holder: Lease | null = null;
/** A preempting lease running while `holder` is suspended. */
let preemptor: Lease | null = null;
const preemptingQueue: Lease[] = [];
const waitingQueue: Lease[] = [];

function startPreemptor(): void {
  if (
    holder !== null &&
    holder.suspended &&
    preemptor === null &&
    preemptingQueue.length > 0
  ) {
    preemptor = preemptingQueue.shift()!;
    preemptor.start();
  }
}

function release(lease: Lease): void {
  if (lease === preemptor) {
    preemptor = null;
    const owner = holder;
    if (owner !== null && owner.resumeWaiter !== null) {
      const resume = owner.resumeWaiter;
      owner.resumeWaiter = null;
      owner.suspended = false;
      resume();
      return;
    }
    startPreemptor();
    return;
  }
  if (lease !== holder) return;
  holder = preemptingQueue.shift() ?? waitingQueue.shift() ?? null;
  holder?.start();
}

function acquire(db: LocalDb, preempting: boolean): Promise<Lease> {
  return new Promise<Lease>(resolve => {
    const lease = new Lease(db, () => resolve(lease));
    if (holder === null) {
      holder = lease;
      lease.start();
      return;
    }
    if (preempting) {
      preemptingQueue.push(lease);
      startPreemptor();
      return;
    }
    waitingQueue.push(lease);
  });
}

async function hold<T>(
  db: LocalDb,
  preempting: boolean,
  operation: (lease: ConnectionLease) => Promise<T>,
): Promise<T> {
  const lease = await acquire(db, preempting);
  try {
    return await operation(lease);
  } finally {
    release(lease);
  }
}

/** Holds the connection for `operation`; see the module comment. */
export function withConnection<T>(
  db: LocalDb,
  operation: (lease: ConnectionLease) => Promise<T>,
): Promise<T> {
  return hold(db, false, operation);
}

/** One transaction, serialized behind every earlier holder. */
export function runInTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  return hold(db, false, lease => lease.transaction(operation));
}

/**
 * One transaction that may run INSIDE a suspended holder's unit of work
 * instead of waiting for it — for writes that invalidate that unit anyway
 * (purging the owner's bucket while a drain awaits the server); the holder
 * learns of it through the state the write leaves behind (a purge
 * generation, the rows themselves).
 */
export function runPreemptingTransaction<T>(
  db: LocalDb,
  operation: () => Promise<T>,
): Promise<T> {
  return hold(db, true, lease => lease.transaction(operation));
}
