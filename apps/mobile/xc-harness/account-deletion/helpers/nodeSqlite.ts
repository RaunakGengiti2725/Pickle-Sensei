/**
 * A REAL SQLite engine for the deletion harness.
 *
 * `@op-engineering/op-sqlite` is replaced (per test file, via `jest.mock`)
 * with this shim backed by Node's built-in `node:sqlite` so that
 * `src/data/db.ts` runs its genuine migrations and every repository query
 * executes against a real relational store. Nothing about the app's schema
 * or SQL is faked — only the native bridge.
 *
 * Requires `NODE_OPTIONS=--experimental-sqlite` on Node 22.x (unflagged on
 * newer runtimes). The harness runner (`xc-harness/run.sh`) sets it.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface OpSqliteLike {
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

export interface NodeSqliteHandle {
  /** The live engine; reopened by `reset()` to model a fresh install. */
  db: DatabaseSync;
  /** Fault injection: throws from every statement matching the regex. */
  failOn: RegExp | null;
  /** When set, only the next N matching statements fail (then `failOn` is
   * cleared); null = every match fails. */
  failRemaining: number | null;
  /** Every statement executed, in order (for replay artifacts). */
  log: Array<{ sql: string; params: unknown[] }>;
  /** Drops the database entirely (fresh install / different device). */
  reset(): void;
}

function isReadStatement(sql: string): boolean {
  return /^\s*(select|pragma|with|explain)/i.test(sql);
}

export function createNodeSqliteHandle(): NodeSqliteHandle {
  const handle: NodeSqliteHandle = {
    db: new DatabaseSync(':memory:'),
    failOn: null,
    failRemaining: null,
    log: [],
    reset() {
      try {
        handle.db.close();
      } catch {
        // Already closed.
      }
      handle.db = new DatabaseSync(':memory:');
      handle.log = [];
    },
  };
  return handle;
}

/** Builds the `open()` replacement for `@op-engineering/op-sqlite`. */
export function opSqliteFromHandle(handle: NodeSqliteHandle): {
  open: (options: { name: string }) => OpSqliteLike;
} {
  return {
    open() {
      return {
        executeSync(sql, params = []) {
          handle.log.push({ sql, params });
          if (handle.failOn && handle.failOn.test(sql)) {
            if (handle.failRemaining !== null) {
              handle.failRemaining -= 1;
              if (handle.failRemaining <= 0) {
                handle.failOn = null;
                handle.failRemaining = null;
              }
            }
            throw new Error(`injected sqlite failure: ${sql.slice(0, 40)}`);
          }
          const statement = handle.db.prepare(sql);
          const bound = params as SQLInputValue[];
          if (isReadStatement(sql)) {
            return {
              rows: statement.all(...bound) as Record<string, unknown>[],
            };
          }
          statement.run(...bound);
          return { rows: [] };
        },
        async execute(sql, params = []) {
          return this.executeSync(sql, params);
        },
        close() {
          // The handle owns the engine's lifetime so the app's `getDb()`
          // singleton can be torn down and reopened against the same file.
        },
      };
    },
  };
}

export interface TableDump {
  table: string;
  rows: Record<string, unknown>[];
}

/** Every user table with every row — the raw material for survival matrices. */
export function dumpDatabase(handle: NodeSqliteHandle): TableDump[] {
  const tables = handle.db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    table: name,
    rows: handle.db.prepare(`SELECT * FROM "${name}"`).all() as Record<
      string,
      unknown
    >[],
  }));
}

/** Rows anywhere in the database whose serialized form contains `needle`. */
export function grepDatabase(
  handle: NodeSqliteHandle,
  needle: string,
): Array<{ table: string; row: Record<string, unknown> }> {
  const hits: Array<{ table: string; row: Record<string, unknown> }> = [];
  for (const { table, rows } of dumpDatabase(handle)) {
    for (const row of rows) {
      if (JSON.stringify(row).includes(needle)) hits.push({ table, row });
    }
  }
  return hits;
}
