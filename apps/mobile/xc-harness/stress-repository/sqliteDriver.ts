/**
 * Real-SQLite driver for the repository stress suites.
 *
 * `opSqliteMockModule()` is the factory a test passes to
 * `jest.mock('@op-engineering/op-sqlite', …)`: every `open()` creates a fresh
 * in-memory node:sqlite database, so the production `getDb()` runs
 * LOCAL_MIGRATIONS + ensureAccountScopedSchema on a genuine SQLite engine and
 * `db.close()` discards the whole store. `execute` yields 1–4 microtasks
 * (seeded per opened store) before touching SQLite, mirroring the real
 * driver's async thread hop with jitter, so two un-sequenced repository
 * calls interleave at statement granularity in a seed-determined order.
 */
import type { LocalDb } from '../../src/data/db';
import type { StressDb } from './campaign';
import {
  loadNodeSqlite,
  type SqliteDatabaseSync,
  type SqlInputValue,
} from '../lifecycle-persistence/nodeShim';
import { makePrng } from '../lifecycle-persistence/seeds';

export interface TransactionAwareDatabase extends SqliteDatabaseSync {
  readonly isTransaction: boolean;
}

export const driverState: {
  current: TransactionAwareDatabase | null;
  /** Extra microtask hops before each statement (0–3). */
  jitter: () => number;
} = {
  current: null,
  jitter: () => 0,
};

export function requireNodeSqlite(): new (
  location: string,
) => TransactionAwareDatabase {
  const sqlite = loadNodeSqlite();
  if (!sqlite) {
    throw new Error(
      'node:sqlite is unavailable: run on Node >= 22.13 (package.json engines) or with --experimental-sqlite.',
    );
  }
  return sqlite.DatabaseSync as new (
    location: string,
  ) => TransactionAwareDatabase;
}

export function opSqliteMockModule(): {
  open: (options: { name: string }) => {
    executeSync: (sql: string) => { rows: unknown[] };
    execute: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    close: () => void;
  };
} {
  const DatabaseSync = requireNodeSqlite();
  return {
    open: () => {
      const real = new DatabaseSync(':memory:');
      driverState.current = real;
      return {
        executeSync: (sql: string) => ({ rows: real.prepare(sql).all() }),
        execute: async (sql: string, params: unknown[] = []) => {
          const hops = driverState.jitter();
          for (let hop = 0; hop <= hops; hop++) await Promise.resolve();
          return {
            rows: real.prepare(sql).all(...(params as SqlInputValue[])),
          };
        },
        close: () => real.close(),
      };
    },
  };
}

/** Production LocalDb over the mocked driver plus a transaction probe; the
 * statement-scheduling jitter is a pure function of `seed`. */
export function openStressDb(getDb: () => LocalDb, seed: number): StressDb {
  const db = getDb();
  const real = driverState.current;
  if (!real) throw new Error('op-sqlite mock did not open a database');
  const rng = makePrng((seed ^ 0x5bd1e995) >>> 0);
  driverState.jitter = () => Math.floor(rng() * 4);
  return {
    execute: (sql, params) => db.execute(sql, params),
    close: () => db.close(),
    inTransaction: () => real.isTransaction,
  };
}
