import { DatabaseSync } from 'node:sqlite';

/**
 * In-memory replacement for `@op-engineering/op-sqlite` (its JSI binding is
 * BLOCKED_EXTERNAL on Linux). Every `open()` returns a FRESH `:memory:`
 * database so a stress sequence starts from an empty local store, and the
 * production migrations in `src/data/db.ts` run against real SQLite — the
 * UNIQUE constraints, defaults and transactions are the ones the device has.
 *
 * Wire it up from a test file with:
 *   jest.mock('@op-engineering/op-sqlite', () =>
 *     require('../../testing/stress/sqliteMemory').opSqliteModule);
 */
type Params = Array<string | number | null | bigint | Uint8Array>;

interface OpenedDb {
  executeSync(sql: string, params?: unknown[]): { rows: unknown[] };
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): void;
}

const state: { current: DatabaseSync | null; opens: number } = {
  current: null,
  opens: 0,
};

function run(
  db: DatabaseSync,
  sql: string,
  params: unknown[],
): { rows: unknown[] } {
  const statement = db.prepare(sql);
  return { rows: statement.all(...(params as Params)) as unknown[] };
}

export const opSqliteModule = {
  open: (_options: { name: string }): OpenedDb => {
    const db = new DatabaseSync(':memory:');
    state.current = db;
    state.opens += 1;
    return {
      executeSync: (sql, params = []) => run(db, sql, params),
      execute: async (sql, params = []) => run(db, sql, params),
      close: () => {
        if (state.current === db) state.current = null;
        db.close();
      },
    };
  },
};

/** The database the app currently has open (null before first `getDb()`). */
export function currentMemoryDb(): DatabaseSync | null {
  return state.current;
}

export function memoryDbOpenCount(): number {
  return state.opens;
}

/** Synchronous read for invariant checks. */
export function countRows(sql: string, params: Params = []): number {
  const db = state.current;
  if (!db) return 0;
  const row = db.prepare(sql).get(...params) as
    { n?: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

export function selectRows<T extends Record<string, unknown>>(
  sql: string,
  params: Params = [],
): T[] {
  const db = state.current;
  if (!db) return [];
  return db.prepare(sql).all(...params) as T[];
}
