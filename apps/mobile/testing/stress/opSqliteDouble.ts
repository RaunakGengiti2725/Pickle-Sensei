/**
 * Failure-injection double for `@op-engineering/op-sqlite`, backed by a REAL
 * SQLite database (`node:sqlite`, Node >= 22.13). The production `getDb()`
 * (migrations + account-scoped schema) and every repository query run
 * unchanged against it; the double only decides, per statement, whether the
 * engine answers honestly or misbehaves the way a hostile device would:
 * synchronous throw, rejection, a reply that never comes, a slow reply (real
 * `setTimeout`, so Jest fake timers drive it), or a reply whose ROWS have
 * been replaced/mutated (malformed / partial data).
 *
 * It also records every statement (so a read-only screen can be proven to
 * never write) and snapshots every table (so persisted state can be proven
 * byte-identical after a scenario).
 *
 * Node built-ins are declared locally: apps/mobile types only `jest`.
 */
declare const require: (id: string) => unknown;

export interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
export interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

export type StatementFaultMode = 'throw' | 'reject' | 'never' | 'slow' | 'rows';

export interface StatementFault {
  /** Which statements this fault hits (tested against the SQL text). */
  match: RegExp;
  mode: StatementFaultMode;
  /** `slow`: milliseconds before the honest rows are returned. */
  delayMs?: number;
  /** `rows`: replaces the honest rows (receives them for partial mutation). */
  rows?: (
    honest: Record<string, unknown>[],
    params: unknown[],
  ) => Record<string, unknown>[];
  /** How many matching statements to hit (default: every one). */
  times?: number;
  /** Bookkeeping: how many statements this fault actually hit. */
  hits?: number;
}

export interface OpenFault {
  /** `open()` itself throws (the engine cannot open the file). */
  open?: boolean;
  /** The first `executeSync` (a migration statement) throws. */
  migration?: boolean;
}

export interface StatementLogEntry {
  sql: string;
  params: unknown[];
  outcome: 'ok' | StatementFaultMode;
}

export interface OpSqliteDouble {
  /** The `open` the production module imports. */
  open: (options: { name: string }) => unknown;
  /** The raw database for seeding / snapshots (bypasses every fault). */
  raw(): DatabaseSync;
  /** Empty every table (schema kept). */
  reset(): void;
  setStatementFaults(faults: StatementFault[]): void;
  setOpenFault(fault: OpenFault): void;
  clearFaults(): void;
  log: StatementLogEntry[];
  clearLog(): void;
  /** Deterministic dump of every user table, ordered by rowid. */
  snapshot(): Record<string, Record<string, unknown>[]>;
  /** Number of handles `open()` produced so far. */
  opens: number;
  /** Rejections/hangs still outstanding (so a test can settle or abandon them). */
  pending: number;
}

function bind(params: unknown[]): (string | number | null)[] {
  return params.map(value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
  });
}

export function createOpSqliteDouble(): OpSqliteDouble {
  const db = new DatabaseSync(':memory:');
  let statementFaults: StatementFault[] = [];
  let openFault: OpenFault = {};
  const log: StatementLogEntry[] = [];
  const double: OpSqliteDouble = {
    opens: 0,
    pending: 0,
    log,
    raw: () => db,
    reset() {
      // Rows go, schema stays: the production `getDb()` handle is a process
      // singleton that only migrates once, exactly like the app.
      for (const table of Object.keys(double.snapshot())) {
        db.exec(`DELETE FROM "${table}"`);
      }
    },
    setStatementFaults(faults) {
      statementFaults = faults.map(fault => ({ ...fault, hits: 0 }));
    },
    setOpenFault(fault) {
      openFault = { ...fault };
    },
    clearFaults() {
      statementFaults = [];
      openFault = {};
    },
    clearLog() {
      log.length = 0;
    },
    snapshot() {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all()
        .map(row => String(row['name']));
      const out: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables) {
        out[table] = db
          .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
          .all();
      }
      return out;
    },
    open() {
      if (openFault.open) {
        throw new Error('injected: op-sqlite open() failed');
      }
      double.opens += 1;
      let migrationStatements = 0;
      const run = (sql: string, params: unknown[]) => ({
        rows: db.prepare(sql).all(...bind(params)),
      });
      return {
        executeSync: (sql: string, params: unknown[] = []) => {
          migrationStatements += 1;
          if (openFault.migration && migrationStatements === 1) {
            throw new Error('injected: migration statement failed');
          }
          return run(sql, params);
        },
        execute: (sql: string, params: unknown[] = []) => {
          const fault = statementFaults.find(
            candidate =>
              candidate.match.test(sql) &&
              (candidate.times === undefined ||
                (candidate.hits ?? 0) < candidate.times),
          );
          if (!fault) {
            log.push({ sql, params, outcome: 'ok' });
            return Promise.resolve(run(sql, params));
          }
          fault.hits = (fault.hits ?? 0) + 1;
          log.push({ sql, params, outcome: fault.mode });
          switch (fault.mode) {
            case 'throw':
              throw new Error(`injected: sqlite threw on ${fault.match}`);
            case 'reject':
              return Promise.reject(
                new Error(`injected: sqlite rejected on ${fault.match}`),
              );
            case 'never':
              double.pending += 1;
              return new Promise(() => {});
            case 'slow': {
              const honest = run(sql, params);
              double.pending += 1;
              return new Promise(resolve => {
                setTimeout(() => {
                  double.pending -= 1;
                  resolve(honest);
                }, fault.delayMs ?? 1000);
              });
            }
            case 'rows': {
              const honest = run(sql, params);
              return Promise.resolve({
                rows: fault.rows ? fault.rows(honest.rows, params) : [],
              });
            }
          }
        },
        close: () => {},
      };
    },
  };
  return double;
}
