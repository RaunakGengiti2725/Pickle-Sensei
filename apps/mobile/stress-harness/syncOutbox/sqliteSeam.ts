import {
  loadNodeSqlite,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import type { Scheduler } from './scheduler';

/**
 * `@op-engineering/op-sqlite` stand-in for the stress campaign, backed by a
 * REAL SQLite database (node:sqlite, in-memory) so BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK, "cannot start a transaction within a transaction", PRIMARY KEY
 * conflicts and INSERT OR REPLACE behave exactly like the device library.
 *
 * Execution model (INFERRED from the vendored op-sqlite 18.1.4 sources:
 * one connection, one worker thread per connection, statements executed in
 * FIFO issue order, results delivered to JS on a later event-loop turn):
 *   - `execute()` enqueues the statement immediately (issue order = execution
 *     order),
 *   - the caller's promise settles after a seeded number of event-loop hops,
 *   - when a caller wakes up, every statement queued before its own has
 *     already run — exactly like the native thread draining its queue while
 *     JS callbacks are still in flight.
 * Statement errors are thrown to the issuing caller only, like op-sqlite.
 */
interface Ticket {
  actor: string;
  sql: string;
  params: unknown[];
  executed: boolean;
  rows: Record<string, unknown>[];
  error: unknown;
}

export interface StatementLogEntry {
  seq: number;
  /** Actor that issued the statement (set synchronously by the harness). */
  actor: string;
  sql: string;
  params: unknown[];
  ok: boolean;
  error?: string;
}

export interface SeamHandle {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

export class SqliteSeam {
  private scheduler: Scheduler | null = null;
  private inner: SqliteDatabaseSync | null = null;
  private readonly queue: Ticket[] = [];
  readonly log: StatementLogEntry[] = [];
  opens = 0;
  /** Name of the actor whose synchronous continuation is issuing statements. */
  currentActor = 'harness';

  /** Every statement after this call is scheduled with `scheduler`. */
  attach(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  resetLog(): void {
    this.log.length = 0;
  }

  /** Direct, unscheduled access for seeding and invariant checks. */
  raw(): SqliteDatabaseSync {
    if (!this.inner) throw new Error('sqlite seam: no open database');
    return this.inner;
  }

  open(): SeamHandle {
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      throw new Error(
        'node:sqlite unavailable — Node >= 22.13 (or --experimental-sqlite) is required for the stress campaign',
      );
    }
    this.opens += 1;
    const inner = new sqlite.DatabaseSync(':memory:');
    this.inner = inner;
    this.queue.length = 0;

    const run = (ticket: Ticket) => {
      const entry: StatementLogEntry = {
        seq: this.log.length,
        actor: ticket.actor,
        sql: ticket.sql,
        params: ticket.params,
        ok: true,
      };
      try {
        ticket.rows = inner
          .prepare(ticket.sql)
          .all(...(ticket.params as SqlInputValue[])) as Record<
          string,
          unknown
        >[];
      } catch (error) {
        ticket.error = error;
        entry.ok = false;
        entry.error = error instanceof Error ? error.message : String(error);
      }
      ticket.executed = true;
      this.log.push(entry);
    };

    const drainThrough = (ticket: Ticket) => {
      while (this.queue.length > 0) {
        const head = this.queue[0] as Ticket;
        if (head.executed) {
          this.queue.shift();
          continue;
        }
        run(head);
        this.queue.shift();
        if (head === ticket) return;
      }
      if (!ticket.executed) run(ticket);
    };

    return {
      executeSync: (sql, params = []) => {
        const ticket: Ticket = {
          actor: this.currentActor,
          sql,
          params,
          executed: false,
          rows: [],
          error: null,
        };
        // Synchronous statements (migrations) run ahead of anything queued —
        // op-sqlite executes them on the calling thread.
        run(ticket);
        if (ticket.error) throw ticket.error;
        return { rows: ticket.rows };
      },
      execute: async (sql, params = []) => {
        const ticket: Ticket = {
          actor: this.currentActor,
          sql,
          params,
          executed: false,
          rows: [],
          error: null,
        };
        this.queue.push(ticket);
        if (this.scheduler) await this.scheduler.dbRoundTrip();
        drainThrough(ticket);
        if (ticket.error) throw ticket.error;
        return { rows: ticket.rows };
      },
      close: () => {
        inner.close();
        if (this.inner === inner) this.inner = null;
      },
    };
  }
}

/** Process-wide seam instance the `jest.mock('@op-engineering/op-sqlite')`
 * factory in each stress suite forwards to. */
export const seam = new SqliteSeam();
