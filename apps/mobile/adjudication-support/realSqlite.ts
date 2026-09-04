/// <reference types="node" />
/**
 * Real-SQLite stand-in for `@op-engineering/op-sqlite` used by the structural
 * audit suites under `__tests__/audit/`. Every other data-layer test drives
 * `LocalDb` fakes that never execute SQL; this harness runs the ACTUAL
 * statements in `src/data/db.ts`, `repository.ts` and `sync.ts` against a
 * single SQLite connection (Node's built-in `node:sqlite`, SQLite 3.47+), so
 * DDL, `json_extract`, `INSERT OR REPLACE`, `BEGIN IMMEDIATE` and the legacy
 * table rebuild are exercised for real.
 *
 * Fidelity notes (label: INFERRED for the device):
 * - op-sqlite opens ONE sqlite3 connection per `open()`; `execute` and
 *   `executeSync` share it. This harness does the same: statements run
 *   serially on one connection in the order the JS code issues them.
 * - Node 22.12 needs `NODE_OPTIONS=--experimental-sqlite`; Node >= 22.13
 *   ships `node:sqlite` unflagged. The suites fail loudly (never skip) when
 *   the module is unavailable.
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { LocalDb } from '../src/data/db';

function loadDatabaseSync(): typeof DatabaseSyncType {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sqlite') as typeof import('node:sqlite'))
      .DatabaseSync;
  } catch (error) {
    throw new Error(
      `node:sqlite is unavailable under ${process.version}. Run the audit suites with ` +
        `NODE_OPTIONS=--experimental-sqlite (Node 22.5-22.12) or Node >= 22.13. ` +
        `Original error: ${String(error)}`,
    );
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RealSqliteHandle {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
  /** Every statement issued through this handle, in order (for assertions). */
  readonly log: string[];
}

function toParam(value: unknown, sql: string): SqlParam {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new TypeError(
    `Unsupported SQLite parameter ${typeof value} for statement: ${sql}`,
  );
}

function plainRow(row: unknown): Record<string, unknown> {
  // node:sqlite returns null-prototype objects; copy onto a plain object so
  // `toEqual`/`Object.keys` behave like op-sqlite's row objects.
  return { ...(row as Record<string, unknown>) };
}

/** Opens a real SQLite database (in memory unless a path is given). */
export function openRealSqlite(path = ':memory:'): RealSqliteHandle {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(path);
  const log: string[] = [];
  const run = (sql: string, params: unknown[] = []) => {
    log.push(sql);
    const statement = db.prepare(sql);
    const bound = params.map(value => toParam(value, sql));
    const rows = statement.all(...bound).map(plainRow);
    return { rows };
  };
  return {
    log,
    executeSync: run,
    async execute(sql, params = []) {
      // Yield like the native bridge does, so two in-flight callers
      // interleave at statement granularity exactly as they would on device.
      await Promise.resolve();
      return run(sql, params);
    },
    close() {
      db.close();
    },
  };
}

/** Wraps a handle as the app's `LocalDb`, optionally observing each statement
 * BEFORE it runs (used to schedule a competing writer mid-transaction). */
export function asLocalDb(
  handle: RealSqliteHandle,
  onStatement?: (sql: string, params: unknown[]) => void,
): LocalDb {
  return {
    async execute(sql, params = []) {
      onStatement?.(sql, params);
      return handle.execute(sql, params);
    },
    close() {
      handle.close();
    },
  };
}
