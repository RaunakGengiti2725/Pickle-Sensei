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
 *
 * A holder's contract: while it holds the connection it awaits nothing but
 * its own statements (and nested calls on its own lease). A holder that
 * instead awaits a FRESH acquisition of the connection — `setKv`
 * (withConnection) inside `runInTransaction`, say — would wait for itself
 * forever, and every other waiter with it. The module detects that stall
 * (`statementStarted` / `statementSettled` from the LocalDb wrapper tell it
 * whether the holder has a statement in flight; a held connection with no
 * statement in flight that is neither released nor issues a statement
 * within one macrotask turn is a holder awaiting something only the
 * connection can deliver) and lets the newest waiter PARTICIPATE: it runs
 * inline on the held connection — inside the holder's open transaction if
 * there is one (its own BEGIN is skipped; its failure rolls the holder
 * back) — and returns the connection to the holder, not to the queue. The
 * nested call is the newest arrival in the turn that stalled; every later
 * turn that still stalls admits the next newest. No caller ever hangs.
 */
export interface ConnectionLease {
  /** Runs `statements` (autocommit, no BEGIN) while holding the connection. */
  hold<T>(statements: () => Promise<T>): Promise<T>;
  /** BEGIN IMMEDIATE … COMMIT (ROLLBACK on error) while holding the connection. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

interface Waiter {
  /** Arrival order across both queues. */
  seq: number;
  /** `participating`: run on the connection its stalled holder still holds. */
  start(participating: boolean): void;
}

/** Whether some caller currently holds the connection. */
let held = false;
/** Callers that may run ahead of ordinary waiters (an owner purge). */
const preemptingQueue: Waiter[] = [];
/** Ordinary callers, served in arrival order. */
const waitingQueue: Waiter[] = [];
let arrivals = 0;
/** Most callers ever waiting at once since the last `resetConnectionWaiterPeak`. */
let waitersPeak = 0;

/** Whether the holder has a BEGIN open (Lease.transaction). */
let transactionOpen = false;
/** Statements in flight on the connection (LocalDb.execute, any caller). */
let statementsInFlight = 0;
/** Statements that started since the stall watchdog last looked. */
let statementsSinceWatch = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function noteWaiters(): void {
  const waiting = preemptingQueue.length + waitingQueue.length;
  if (waiting > waitersPeak) waitersPeak = waiting;
}

/** Called by the LocalDb wrapper around every statement. */
export function statementStarted(): void {
  statementsInFlight += 1;
  statementsSinceWatch += 1;
}

export function statementSettled(): void {
  statementsInFlight -= 1;
  armWatchdog();
}

/**
 * Schedules one stall check for after the current microtask drain, when
 * the connection is held, nothing is in flight and someone is waiting. A
 * holder that is making progress issues its next statement (or releases)
 * within that drain; one that does not is stalled on a waiter of its own.
 */
function armWatchdog(): void {
  if (watchdog !== null) return;
  if (!held || statementsInFlight > 0) return;
  if (preemptingQueue.length + waitingQueue.length === 0) return;
  statementsSinceWatch = 0;
  watchdog = setTimeout(checkStall, 0);
}

function checkStall(): void {
  watchdog = null;
  if (!held || statementsInFlight > 0 || statementsSinceWatch > 0) {
    // Progress since the check was armed; re-arm only if still worth it.
    armWatchdog();
    return;
  }
  const newest = [...preemptingQueue, ...waitingQueue].sort(
    (a, b) => b.seq - a.seq,
  )[0];
  if (newest === undefined) return;
  const queue = preemptingQueue.includes(newest)
    ? preemptingQueue
    : waitingQueue;
  queue.splice(queue.indexOf(newest), 1);
  newest.start(true);
}

/** Resolves once the caller may use the connection; `true` when it does so
 * as a participant of the stalled holder's statement group. */
function acquire(preempting: boolean): Promise<boolean> {
  if (!held) {
    held = true;
    return Promise.resolve(false);
  }
  return new Promise<boolean>(resolve => {
    arrivals += 1;
    (preempting ? preemptingQueue : waitingQueue).push({
      seq: arrivals,
      start: resolve,
    });
    noteWaiters();
    armWatchdog();
  });
}

function release(): void {
  const next = preemptingQueue.shift() ?? waitingQueue.shift();
  if (next === undefined) {
    held = false;
    return;
  }
  // The connection passes straight to `next`: `held` stays true.
  next.start(false);
  armWatchdog();
}

/** Number of callers waiting for the connection right now (diagnostics). */
export function connectionWaiters(): number {
  return preemptingQueue.length + waitingQueue.length;
}

/** Diagnostics: the most callers that ever waited at once, and the callers
 * waiting now. `reset` starts the peak over. */
export function leaseWaiters(): { pending: number; peak: number } {
  return { pending: connectionWaiters(), peak: waitersPeak };
}

export function resetConnectionWaiterPeak(): void {
  waitersPeak = connectionWaiters();
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
    const participating = await acquire(this.preempting);
    this.depth = 1;
    try {
      return await statements();
    } finally {
      this.depth = 0;
      // A participant hands the connection back to the holder it joined,
      // whose own release serves the queue.
      if (!participating) release();
    }
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.hold(async () => {
      // Inside a holder's open transaction (a participant, or a nested call
      // on this lease) the operation joins it: its statements commit or roll
      // back with the holder's.
      if (transactionOpen) return operation();
      await this.db.execute('BEGIN IMMEDIATE');
      transactionOpen = true;
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
      } finally {
        transactionOpen = false;
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
