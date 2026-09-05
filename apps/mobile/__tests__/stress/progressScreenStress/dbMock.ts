/**
 * A REAL SQLite database (node:sqlite, Node >= 22.13) standing in for the
 * native `@op-engineering/op-sqlite` binding, so the production `getDb()`
 * migrations and every repository query run unmodified. The stress runner
 * reaches the raw handle to plant rows an older build could have left
 * behind and to inject the storage fault ProgressScreen's error state exists
 * for.
 */

// apps/mobile types only `jest` (no @types/node) so app code cannot lean on
// Node APIs; this harness declares the exact node:sqlite surface it drives.
declare const require: (id: string) => unknown;

export type SqlParam = string | number | null;

export interface SqliteStatement {
  all(...params: SqlParam[]): Record<string, unknown>[];
  run(...params: SqlParam[]): unknown;
}

export interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

export interface DbMockState {
  real: DatabaseSync | null;
  /** When true every async query rejects like a storage layer that cannot
   * open the file; synchronous migration statements are unaffected. */
  fault: boolean;
  /** Async queries currently awaiting resolution (settling signal). */
  pending: number;
  /** Total async queries issued (trace signal). */
  queries: number;
}

export const dbMockState: DbMockState = {
  real: null,
  fault: false,
  pending: 0,
  queries: 0,
};

export function openFreshDatabase(): DatabaseSync {
  dbMockState.real?.close();
  const db = new DatabaseSync(':memory:');
  dbMockState.real = db;
  dbMockState.fault = false;
  dbMockState.pending = 0;
  dbMockState.queries = 0;
  return db;
}

export function requireRawDb(): DatabaseSync {
  if (!dbMockState.real) throw new Error('stress harness: no database open');
  return dbMockState.real;
}

/** Factory for `jest.mock('@op-engineering/op-sqlite', ...)`. */
export function createOpSqliteMock() {
  return {
    open: () => ({
      executeSync: (sql: string) => ({
        rows: requireRawDb().prepare(sql).all(),
      }),
      execute: async (sql: string, params: unknown[] = []) => {
        dbMockState.queries += 1;
        dbMockState.pending += 1;
        try {
          // Yield once so the query is observably asynchronous, like the
          // native binding's JSI promise.
          await Promise.resolve();
          if (dbMockState.fault) {
            throw new Error('SQLITE_CANTOPEN: unable to open database file');
          }
          return {
            rows: requireRawDb()
              .prepare(sql)
              .all(...(params as SqlParam[])),
          };
        } finally {
          dbMockState.pending -= 1;
        }
      },
      close: () => {
        // The stress runner owns the handle's lifetime.
      },
    }),
  };
}
