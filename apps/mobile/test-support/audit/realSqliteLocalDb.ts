/**
 * Real-SQL harness for the structural audit of `src/data`.
 *
 * Every existing suite fakes `LocalDb.execute`, so DDL, CHECK constraints,
 * `json_extract`, `INSERT OR REPLACE`, `BEGIN IMMEDIATE` and the legacy
 * table rebuild never execute on Linux. This helper runs them against a real
 * in-memory SQLite database through Node's built-in `node:sqlite`.
 *
 * Requirements: Node ≥ 22.5 with the module enabled —
 *   `NODE_OPTIONS=--experimental-sqlite npx jest __tests__/audit/structural2`
 * (Node ≥ 22.13 / 23.4 ships it unflagged). When the module is missing the
 * import throws `ERR_UNKNOWN_BUILTIN_MODULE`; that is a loud failure, never a
 * silent skip.
 *
 * `execute` yields to the microtask queue before touching SQLite so two
 * concurrent callers interleave statement-by-statement exactly like the
 * asynchronous op-sqlite bridge does on device (one connection, one
 * statement per round trip, no cross-call transaction lock).
 */
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import type { LocalDb } from '../../src/data/db';

type SqlParam = null | number | bigint | string | Uint8Array;

export interface RealSqliteLocalDb extends LocalDb {
  readonly raw: DatabaseSync;
  /** Synchronous escape hatch for arranging state / asserting rows. */
  query(sql: string, params?: unknown[]): Record<string, unknown>[];
  /** Number of asynchronous `execute` calls served so far. */
  readonly executeCount: number;
}

const READ_STATEMENT = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

function toParam(value: unknown): SqlParam {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(
    `realSqliteLocalDb: unsupported bind parameter type ${typeof value}`,
  );
}

export function runSql(
  raw: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  const statement = raw.prepare(sql);
  const bound = params.map(toParam);
  if (READ_STATEMENT.test(sql)) {
    return statement.all(...bound).map(row => ({ ...row }));
  }
  statement.run(...bound);
  return [];
}

/** Opens a fresh in-memory database exposing the production `LocalDb` shape. */
export function openRealSqliteLocalDb(
  raw: DatabaseSync = new DatabaseSync(':memory:'),
): RealSqliteLocalDb {
  let executeCount = 0;
  return {
    raw,
    get executeCount() {
      return executeCount;
    },
    query(sql, params = []) {
      return runSql(raw, sql, params);
    },
    async execute(sql, params = []) {
      // One await per statement: mirrors the asynchronous native round trip
      // and lets other pending callers run between two statements.
      await Promise.resolve();
      executeCount += 1;
      return { rows: runSql(raw, sql, params) };
    },
    close() {
      raw.close();
    },
  };
}

/**
 * Minimal stand-in for `@op-engineering/op-sqlite`'s `DB` handle, backed by
 * the same real database, so `src/data/db.ts#getDb()` can run its migrations
 * for real: `jest.mock('@op-engineering/op-sqlite', () => ({ open: () =>
 * opSqliteHandleFor(raw) }))`.
 */
export function opSqliteHandleFor(raw: DatabaseSync) {
  return {
    executeSync(sql: string, params: unknown[] = []) {
      return { rows: runSql(raw, sql, params) };
    },
    async execute(sql: string, params: unknown[] = []) {
      await Promise.resolve();
      return { rows: runSql(raw, sql, params) };
    },
    close() {
      raw.close();
    },
  };
}
