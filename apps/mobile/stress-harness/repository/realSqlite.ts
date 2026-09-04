/**
 * Real SQLite behind the production `getDb()` for the repository stress
 * harness.
 *
 * The test file mocks `@op-engineering/op-sqlite` so its `open()` resolves to
 * `opSqliteShim.open`, which hands back a `node:sqlite` in-memory database
 * wrapped in op-sqlite's `{execute, executeSync, close}` surface. The
 * production module then runs its own migrations on it, so every scenario
 * exercises the shipped schema (owner-scoped PRIMARY KEYs, CHECK constraints,
 * indexes) instead of a hand-copied DDL.
 *
 * `node:sqlite` is behind `--experimental-sqlite` on Node 22.5–22.12; the
 * suites re-execute themselves under the flag when it is missing (see
 * `reexec.ts`), so a plain `npx jest` still runs (never skips) the campaign.
 */
import type { LocalDb } from '../../src/data/db';
import {
  fs,
  loadNodeSqlite,
  os,
  path,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

export const sqlite = loadNodeSqlite();

const SQL_RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

let scratchDir: string | null = null;
function scratchFile(index: number): string {
  if (!scratchDir) {
    scratchDir = path.join(
      os.tmpdir(),
      'pickle-stress',
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(scratchDir, { recursive: true });
  }
  return path.join(scratchDir, `db-${index}.sqlite`);
}

export interface OpSqliteLike {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows?: Record<string, unknown>[] }>;
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows?: Record<string, unknown>[] };
  close(): void;
}

/** The op-sqlite seam. `current` is the raw connection the production
 * `LocalDb` is talking to — the harness reads it directly for snapshots and
 * to plant persisted corruption "behind" the repository. */
export const opSqliteShim = {
  current: null as SqliteDatabaseSync | null,
  currentPath: null as string | null,
  /** When set, the next `open()` reuses this file instead of a fresh one
   * (models an app relaunch opening the same on-device database). */
  reopenFile: null as string | null,
  opens: 0,
  /** File-backed (not `:memory:`) so a connection closed mid-flight can be
   * reopened and its persisted state inspected — what a relaunch sees. */
  open(_name: string): OpSqliteLike {
    if (!sqlite) throw new Error('node:sqlite unavailable');
    opSqliteShim.opens += 1;
    const file = opSqliteShim.reopenFile ?? scratchFile(opSqliteShim.opens);
    opSqliteShim.reopenFile = null;
    const inner = new sqlite.DatabaseSync(file);
    opSqliteShim.current = inner;
    opSqliteShim.currentPath = file;
    const run = (sql: string, params: unknown[]) => {
      const statement = inner.prepare(sql);
      if (SQL_RETURNS_ROWS.test(sql)) {
        return {
          rows: statement.all(...(params as SqlInputValue[])) as Record<
            string,
            unknown
          >[],
        };
      }
      statement.run(...(params as SqlInputValue[]));
      return { rows: [] as Record<string, unknown>[] };
    };
    return {
      executeSync: (sql, params = []) => run(sql, params),
      execute: async (sql, params = []) => run(sql, params),
      close: () => {
        inner.close();
        if (opSqliteShim.current === inner) opSqliteShim.current = null;
      },
    };
  },
};

export interface RealDbHandle {
  /** The production LocalDb (migrated by src/data/db.ts). */
  db: LocalDb;
  /** Raw node:sqlite connection underneath it. */
  raw: SqliteDatabaseSync;
  /** Backing file. */
  file: string;
  /** A second connection to the same file (what a relaunch would open);
   * usable after the primary connection was closed by a fault. */
  reopen(): SqliteDatabaseSync;
  close(): void;
}

/** Opens a fresh migrated database through the production module. The
 * caller passes `getDb` from `src/data/db` so this module never imports the
 * mocked package itself. */
export function openMigratedDb(getDb: () => LocalDb): RealDbHandle {
  const db = getDb();
  const raw = opSqliteShim.current;
  const file = opSqliteShim.currentPath;
  if (!raw || !file) {
    throw new Error('op-sqlite shim did not open a connection');
  }
  const extras: SqliteDatabaseSync[] = [];
  return {
    db,
    raw,
    file,
    reopen() {
      if (!sqlite) throw new Error('node:sqlite unavailable');
      const again = new sqlite.DatabaseSync(file);
      extras.push(again);
      return again;
    },
    close() {
      for (const extra of extras) {
        try {
          extra.close();
        } catch {
          // Already closed.
        }
      }
      try {
        db.close();
      } catch {
        // Already closed by a scenario; nothing to release.
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Best-effort scratch cleanup.
      }
    },
  };
}

export const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
] as const;
export type OwnerTable = (typeof OWNER_TABLES)[number];

export type TableSnapshot = Record<string, string[]>;

/** Deterministic fingerprint of every row in every table (kv included),
 * ordered so two snapshots compare with a plain deep-equal. */
export function snapshotAll(raw: SqliteDatabaseSync): TableSnapshot {
  const snapshot: TableSnapshot = {};
  for (const table of [...OWNER_TABLES, 'kv']) {
    const rows = raw.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      unknown
    >[];
    snapshot[table] = rows
      .map(row =>
        JSON.stringify(
          Object.keys(row)
            .sort()
            .map(key => [key, row[key]]),
        ),
      )
      .sort();
  }
  return snapshot;
}

export function snapshotOwner(
  raw: SqliteDatabaseSync,
  owner: string,
): TableSnapshot {
  const snapshot: TableSnapshot = {};
  for (const table of OWNER_TABLES) {
    const rows = raw
      .prepare(`SELECT * FROM ${table} WHERE owner_key = ?`)
      .all(owner) as Record<string, unknown>[];
    snapshot[table] = rows
      .map(row =>
        JSON.stringify(
          Object.keys(row)
            .sort()
            .map(key => [key, row[key]]),
        ),
      )
      .sort();
  }
  snapshot['kv'] = (
    raw
      .prepare(`SELECT key, value FROM kv WHERE key LIKE ?`)
      .all(`%:${owner}`) as Record<string, unknown>[]
  )
    .map(row => JSON.stringify([row['key'], row['value']]))
    .sort();
  return snapshot;
}

export function sameSnapshot(a: TableSnapshot, b: TableSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function countRows(
  raw: SqliteDatabaseSync,
  table: string,
  owner?: string,
): number {
  const row = (
    owner === undefined
      ? raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()
      : raw
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
          .get(owner)
  ) as { n: number | bigint };
  return Number(row.n);
}

/** True when the connection is NOT inside an open transaction — a
 * `BEGIN`/`ROLLBACK` pair succeeds only in autocommit mode. A connection left
 * mid-transaction by a failed operation would make every later
 * `BEGIN IMMEDIATE` fail ("cannot start a transaction within a transaction"). */
export function inAutocommit(raw: SqliteDatabaseSync): boolean {
  try {
    raw.exec('BEGIN');
  } catch {
    return false;
  }
  raw.exec('ROLLBACK');
  return true;
}

/** Recovers a connection a scenario deliberately left mid-transaction so
 * the next scenario on the same handle starts clean. */
export function forceAutocommit(raw: SqliteDatabaseSync): void {
  try {
    raw.exec('ROLLBACK');
  } catch {
    // Already in autocommit.
  }
}

/** Referential invariants the repository's transactions are meant to keep:
 * every shot.sync outbox row has its local_shot, every session.create /
 * session.finalize row has its local_session, and a finalized session has
 * ended. Violations are torn writes. */
export function tornWrites(raw: SqliteDatabaseSync): string[] {
  const problems: string[] = [];
  const orphanShotSync = raw
    .prepare(
      `SELECT o.owner_key, o.id FROM outbox o
       WHERE o.kind = 'shot.sync' AND json_valid(o.payload)
         AND NOT EXISTS (
           SELECT 1 FROM local_shot s
           WHERE s.owner_key = o.owner_key
             AND s.id = json_extract(o.payload, '$.id'))`,
    )
    .all() as { owner_key: string; id: number }[];
  for (const row of orphanShotSync) {
    problems.push(`outbox#${row.id}(shot.sync) has no local_shot`);
  }
  const orphanSession = raw
    .prepare(
      `SELECT o.owner_key, o.id, o.kind FROM outbox o
       WHERE o.kind IN ('session.create', 'session.finalize')
         AND json_valid(o.payload)
         AND NOT EXISTS (
           SELECT 1 FROM local_session s
           WHERE s.owner_key = o.owner_key
             AND s.id = json_extract(o.payload, '$.id'))`,
    )
    .all() as { owner_key: string; id: number; kind: string }[];
  for (const row of orphanSession) {
    problems.push(`outbox#${row.id}(${row.kind}) has no local_session`);
  }
  const shotWithoutOutbox = raw
    .prepare(
      `SELECT s.owner_key, s.id FROM local_shot s
       WHERE s.result_kind = 'scored'
         AND NOT EXISTS (
           SELECT 1 FROM outbox o
           WHERE o.owner_key = s.owner_key AND o.kind = 'shot.sync'
             AND json_valid(o.payload)
             AND json_extract(o.payload, '$.id') = s.id)
         AND NOT EXISTS (
           SELECT 1 FROM sync_receipt r
           WHERE r.owner_key = s.owner_key AND r.kind = 'shot.sync'
             AND r.entity_id = s.id)`,
    )
    .all() as { owner_key: string; id: string }[];
  for (const row of shotWithoutOutbox) {
    problems.push(`scored local_shot ${row.id} has no outbox row or receipt`);
  }
  return problems;
}
