/// <reference types="node" />
/**
 * Adjudication harness: a real-SQLite stand-in for `@op-engineering/op-sqlite`
 * built on Node's `node:sqlite` (SQLite 3.47 on Node 22.12; requires
 * `NODE_OPTIONS=--experimental-sqlite` below Node 22.13). The migrations in
 * `src/data/db.ts` and every statement in `repository.ts` / `sync.ts` run for
 * real (DDL, json_extract, BEGIN IMMEDIATE, INSERT OR REPLACE).
 *
 * Fidelity (labelled INFERRED for the device): op-sqlite hands out ONE
 * connection per `open()`; `execute` resolves asynchronously and statements
 * from concurrent callers interleave at statement granularity. `execute` here
 * yields one microtask before running so two in-flight callers interleave the
 * same way.
 *
 * The module fails loudly when `node:sqlite` is missing — it never skips.
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export type SqlParam = string | number | bigint | null | Uint8Array;

function loadDatabaseSync(): typeof DatabaseSyncType {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sqlite') as typeof import('node:sqlite'))
      .DatabaseSync;
  } catch (error) {
    throw new Error(
      `node:sqlite unavailable under ${process.version}; run with ` +
        `NODE_OPTIONS=--experimental-sqlite (Node 22.5-22.12) or Node >= 22.13. ` +
        `Cause: ${String(error)}`,
    );
  }
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
  throw new TypeError(`Unsupported parameter ${typeof value} for: ${sql}`);
}

export interface RealOpSqliteDb {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
  /** Every statement issued, in order. */
  readonly log: string[];
}

export interface RealOpSqliteModule {
  open(options: { name: string }): RealOpSqliteDb;
  /** Handles opened so far (the newest is the live one). */
  readonly opened: RealOpSqliteDb[];
  /** Runs a raw statement against the backing file BEFORE `open()` is
   * called, e.g. to plant legacy rows the way a previous app build left
   * them. */
  seed(sql: string, params?: unknown[]): void;
  /** Deletes the backing file so the next test starts from a blank device. */
  reset(): void;
}

let counter = 0;

/**
 * Creates a module mock whose `open()` returns a handle onto a real on-disk
 * SQLite file (so re-opening after a failed migration sees the same rows, as
 * on device).
 */
export function createRealOpSqliteModule(): RealOpSqliteModule {
  const DatabaseSync = loadDatabaseSync();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-adjudicate-'));
  const file = path.join(dir, `pickle-sensei-${++counter}.db`);
  const opened: RealOpSqliteDb[] = [];

  const openRaw = () => new DatabaseSync(file);

  return {
    opened,
    seed(sql, params = []) {
      const raw = openRaw();
      try {
        raw.prepare(sql).run(...params.map(p => toParam(p, sql)));
      } finally {
        raw.close();
      }
    },
    reset() {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${file}${suffix}`);
        } catch {
          // absent
        }
      }
    },
    open() {
      const raw = openRaw();
      const log: string[] = [];
      const run = (sql: string, params: unknown[] = []) => {
        log.push(sql);
        const rows = raw
          .prepare(sql)
          .all(...params.map(p => toParam(p, sql)))
          .map(row => ({ ...(row as Record<string, unknown>) }));
        return { rows };
      };
      const handle: RealOpSqliteDb = {
        log,
        executeSync: run,
        async execute(sql, params = []) {
          await Promise.resolve();
          return run(sql, params);
        },
        close() {
          raw.close();
        },
      };
      opened.push(handle);
      return handle;
    },
  };
}
