/// <reference types="node" />
/**
 * Real-SQLite stand-in for `@op-engineering/op-sqlite`, built on Node's
 * `node:sqlite` (requires `NODE_OPTIONS=--experimental-sqlite` below Node
 * 22.13). Data-layer suites that must exercise the ACTUAL statements — the
 * `src/data/db.ts` migrations, `repository.ts` writes, the `sync.ts` drain —
 * mock op-sqlite with this module instead of a hand-written `LocalDb` fake, so
 * DDL, `json_valid`/`json_extract`, `BEGIN IMMEDIATE` and the outbox window
 * run for real.
 *
 * Fidelity (INFERRED for the device): op-sqlite hands out ONE connection per
 * `open()` and its `execute` resolves asynchronously, so statements from two
 * in-flight callers interleave at statement granularity. `execute` here yields
 * one microtask before running to reproduce exactly that.
 *
 * The module fails loudly when `node:sqlite` is unavailable — it never skips.
 *
 * Lives outside `__tests__/` on purpose: jest's default `testMatch` treats
 * every file under `__tests__/` as a suite.
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

export interface RealSqliteDb {
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
  /** Every statement issued through this connection, in execution order. */
  readonly log: string[];
}

export interface RealSqliteModule {
  open(options: { name: string }): RealSqliteDb;
  /** Connections opened so far; the newest one is live. */
  readonly opened: RealSqliteDb[];
  /** Runs a raw statement against the backing file without going through
   * `open()`, e.g. to plant a row the way a previous app build left it. */
  seed(sql: string, params?: unknown[]): void;
  /** Deletes the backing file so the next suite starts from a blank device. */
  reset(): void;
}

let counter = 0;

/** Creates an op-sqlite module mock backed by a real on-disk SQLite file, so
 * re-opening after a failed migration sees the same rows, as on device. */
export function createRealSqliteModule(): RealSqliteModule {
  const DatabaseSync = loadDatabaseSync();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-localdb-'));
  const file = path.join(dir, `pickle-sensei-${++counter}.db`);
  const opened: RealSqliteDb[] = [];
  const openRaw = () => new DatabaseSync(file);

  return {
    opened,
    seed(sql, params = []) {
      const raw = openRaw();
      try {
        raw.prepare(sql).run(...params.map(value => toParam(value, sql)));
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
          .all(...params.map(value => toParam(value, sql)))
          .map(row => ({ ...(row as Record<string, unknown>) }));
        return { rows };
      };
      const handle: RealSqliteDb = {
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
