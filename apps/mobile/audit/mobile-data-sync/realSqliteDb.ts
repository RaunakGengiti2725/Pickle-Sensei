/**
 * Audit harness adapter: runs the app's real SQL (db.ts migrations,
 * repository.ts, sync.ts) against a real SQLite engine (Node's built-in
 * `node:sqlite`) instead of the string-matching fakes the regular suites use.
 *
 * Requires Node >= 22.5 with `--experimental-sqlite` (unflagged from 22.13):
 *   NODE_OPTIONS=--experimental-sqlite npx jest --testMatch '**\/audit/**\/*.harness.ts'
 *
 * Statements execute in call order on ONE connection, mirroring op-sqlite's
 * single-connection singleton in db.ts. `execute` resolves on a later
 * macrotask so two concurrent callers interleave the way they do on device
 * (each `await db.execute` yields to the event loop).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface StatementLike {
  all(...params: unknown[]): unknown[];
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
}

function loadNodeSqlite(): NodeSqliteModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional built-in, resolved at run time
    return require('node:sqlite') as NodeSqliteModule;
  } catch (error) {
    throw new Error(
      `node:sqlite is unavailable (${String(
        error,
      )}). Run with NODE_OPTIONS=--experimental-sqlite on Node 22.5–22.12, or Node >= 22.13.`,
    );
  }
}

export interface RealSqliteHandle {
  executeSync(sql: string, params?: unknown[]): { rows: unknown[] };
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): void;
  /** Every statement executed, in order — for asserting SQL-level behaviour. */
  readonly log: string[];
}

export interface RealSqliteFixture {
  /** Directory holding the database file; a re-`open` of the same name
   * reopens the same file (simulates an app relaunch). */
  dir: string;
  /** Number of times `open` was called (each = one process-level open). */
  opens: number;
  /** Raw handle to the CURRENT connection (null after close). */
  current: RealSqliteHandle | null;
  /** op-sqlite `open` replacement to install via jest.mock. */
  open(options: { name: string }): RealSqliteHandle;
  /** Runs SQL directly against a fresh, separate connection (for seeding
   * legacy schemas and inspecting state without going through the app). */
  raw<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

function bind(params: unknown[]): unknown[] {
  return params.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

export function createRealSqliteFixture(): RealSqliteFixture {
  const { DatabaseSync } = loadNodeSqlite();
  const dir = mkdtempSync(join(tmpdir(), 'pickle-audit-sqlite-'));
  const fixture: RealSqliteFixture = {
    dir,
    opens: 0,
    current: null,
    open({ name }) {
      fixture.opens += 1;
      const db = new DatabaseSync(join(dir, name));
      const log: string[] = [];
      const run = (sql: string, params: unknown[] = []) => {
        log.push(sql);
        const rows = db.prepare(sql).all(...bind(params));
        return { rows: rows.map(row => ({ ...(row as object) })) };
      };
      const handle: RealSqliteHandle = {
        log,
        executeSync: run,
        async execute(sql, params = []) {
          await new Promise<void>(resolve => setImmediate(resolve));
          return run(sql, params);
        },
        close() {
          db.close();
          if (fixture.current === handle) fixture.current = null;
        },
      };
      fixture.current = handle;
      return handle;
    },
    raw(sql, params = []) {
      const db = new DatabaseSync(join(dir, 'pickle-sensei.db'));
      try {
        return db
          .prepare(sql)
          .all(...bind(params))
          .map(row => ({ ...(row as object) })) as never;
      } finally {
        db.close();
      }
    },
  };
  return fixture;
}
