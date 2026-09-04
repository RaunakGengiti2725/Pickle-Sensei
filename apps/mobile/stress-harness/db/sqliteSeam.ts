/**
 * op-sqlite seam for the concurrency stress suites.
 *
 * `apps/mobile/src/data/db.ts` opens its handle through
 * `@op-engineering/op-sqlite`'s `open({ name })`. The suites mock that module
 * with `makeSeam()`, which backs every handle with a REAL `node:sqlite`
 * `DatabaseSync` on a per-scenario temp file, drives the seeded scheduler at
 * every async `execute`, tracks open/close so leaked handles are visible, and
 * can inject the two fault classes the production module has to survive:
 * an `open()` that throws (disk failure) and an `executeSync` that throws at a
 * chosen statement index (interrupted migration).
 */
import {
  fs,
  path,
  loadNodeSqlite,
  type NodeSqlite,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import type { Scheduler } from './scheduler';

export type JournalMode = 'delete' | 'wal';

export interface SeamFaults {
  /** `open()` throws this many times before succeeding. */
  openFailures: number;
  /** `executeSync` throws when this 0-based statement index runs. */
  syncFailAtStatement: number | null;
  /** Error message used for injected faults. */
  message: string;
}

export interface OpSqliteHandle {
  executeSync(sql: string, params?: unknown[]): { rows: unknown[] };
  execute(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): void;
}

export interface TrackedHandle {
  id: number;
  file: string;
  inner: SqliteDatabaseSync;
  closed: boolean;
  syncStatements: number;
  asyncStatements: number;
}

export interface Seam {
  sqlite: NodeSqlite;
  dir: string;
  dbFile: string;
  handles: TrackedHandle[];
  opens: number;
  openAttempts: number;
  faults: SeamFaults;
  /** The injected statement fault fires once (the retry must succeed). */
  syncFaultFired: boolean;
  journalMode: JournalMode;
  scheduler: Scheduler | null;
  /** Runs before the synchronous statement at `index` (another actor's turn). */
  beforeSync: ((index: number, sql: string) => void) | null;
  /** Statements seen through any handle, tagged with the handle id. */
  statements: string[];
  open(name: string): OpSqliteHandle;
  /** A second, independent connection to the same file (another actor). */
  rawConnection(): SqliteDatabaseSync;
  liveHandles(): TrackedHandle[];
  closeAll(): void;
  destroy(): void;
}

export const DB_FILE = 'pickle-sensei.db';

export const NO_FAULTS: SeamFaults = {
  openFailures: 0,
  syncFailAtStatement: null,
  message: 'disk I/O error',
};

let seamCounter = 0;

export function makeSeam(options: {
  rootDir: string;
  journalMode: JournalMode;
  faults?: SeamFaults;
  scheduler?: Scheduler | null;
}): Seam {
  const sqlite = loadNodeSqlite();
  if (!sqlite) throw new Error('node:sqlite unavailable');
  seamCounter += 1;
  const dir = path.join(options.rootDir, `seam-${seamCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seam: Seam = {
    sqlite,
    dir,
    dbFile: path.join(dir, DB_FILE),
    handles: [],
    opens: 0,
    openAttempts: 0,
    faults: options.faults ?? NO_FAULTS,
    syncFaultFired: false,
    journalMode: options.journalMode,
    scheduler: options.scheduler ?? null,
    beforeSync: null,
    statements: [],
    open(name: string) {
      seam.openAttempts += 1;
      if (seam.openAttempts <= seam.faults.openFailures) {
        throw new Error(seam.faults.message);
      }
      seam.opens += 1;
      const inner = new sqlite.DatabaseSync(path.join(dir, name));
      inner.exec(`PRAGMA journal_mode=${seam.journalMode}`);
      const handle: TrackedHandle = {
        id: seam.handles.length + 1,
        file: path.join(dir, name),
        inner,
        closed: false,
        syncStatements: 0,
        asyncStatements: 0,
      };
      seam.handles.push(handle);
      const run = (sql: string, params: unknown[]) => {
        seam.statements.push(`h${handle.id}:${compact(sql)}`);
        const rows = inner
          .prepare(sql)
          .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
        return { rows };
      };
      return {
        executeSync: (sql: string, params: unknown[] = []) => {
          const index = handle.syncStatements;
          handle.syncStatements += 1;
          seam.beforeSync?.(index, sql);
          if (
            seam.faults.syncFailAtStatement !== null &&
            !seam.syncFaultFired &&
            index === seam.faults.syncFailAtStatement
          ) {
            seam.syncFaultFired = true;
            seam.statements.push(`h${handle.id}:FAULT@${index}`);
            throw new Error(seam.faults.message);
          }
          return run(sql, params);
        },
        execute: async (sql: string, params: unknown[] = []) => {
          handle.asyncStatements += 1;
          const tag = `h${handle.id}:${compact(sql)}`;
          if (seam.scheduler) await seam.scheduler.yieldPoint(`>${tag}`);
          if (handle.closed) {
            throw new Error('database is not open');
          }
          try {
            const result = run(sql, params);
            seam.scheduler?.record(tag);
            if (seam.scheduler) await seam.scheduler.yieldPoint(`<${tag}`);
            return result;
          } catch (error) {
            seam.scheduler?.record(`${tag}!${errorMessage(error)}`);
            throw error;
          }
        },
        close: () => {
          if (handle.closed) throw new Error('database is not open');
          handle.closed = true;
          inner.close();
        },
      };
    },
    rawConnection() {
      // WAL is persistent in the file; the first handle already set it.
      return new sqlite.DatabaseSync(seam.dbFile);
    },
    liveHandles() {
      return seam.handles.filter(handle => !handle.closed);
    },
    closeAll() {
      for (const handle of seam.handles) {
        if (!handle.closed) {
          handle.closed = true;
          try {
            handle.inner.close();
          } catch {
            // Already closed by the engine.
          }
        }
      }
    },
    destroy() {
      seam.closeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return seam;
}

export function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 48);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `PRAGMA integrity_check` on an independent connection. */
export function integrityOk(seam: Seam): boolean {
  const raw = seam.rawConnection();
  try {
    const rows = raw.prepare('PRAGMA integrity_check').all() as Array<
      Record<string, unknown>
    >;
    return rows.length === 1 && rows[0]?.['integrity_check'] === 'ok';
  } finally {
    raw.close();
  }
}

export interface SchemaProbe {
  tables: string[];
  ownerScoped: Record<string, boolean>;
  leftoverTempTables: string[];
  outboxHasOwner: boolean;
  captureHasPayload: boolean;
  captureHasConsent: boolean;
}

const OWNER_TABLES = ['local_shot', 'local_session', 'local_capture'] as const;

/** Shape of the schema on disk, read through an independent connection. */
export function probeSchema(seam: Seam): SchemaProbe {
  const raw = seam.rawConnection();
  try {
    const tables = (
      raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map(row => row.name);
    const columns = (table: string) =>
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        pk: number;
      }>;
    const ownerScoped: Record<string, boolean> = {};
    for (const table of OWNER_TABLES) {
      const info = columns(table);
      const pk = info.filter(column => column.pk > 0).map(c => c.name);
      ownerScoped[table] =
        pk.length === 2 && pk.includes('owner_key') && pk.includes('id');
    }
    const captureColumns = columns('local_capture').map(c => c.name);
    return {
      tables,
      ownerScoped,
      leftoverTempTables: tables.filter(name => name.endsWith('_account_v2')),
      outboxHasOwner: columns('outbox').some(c => c.name === 'owner_key'),
      captureHasPayload: captureColumns.includes('payload'),
      captureHasConsent: captureColumns.includes('training_consent'),
    };
  } finally {
    raw.close();
  }
}

export const CURRENT_TABLES = [
  'kv',
  'local_analysis_record',
  'local_capture',
  'local_session',
  'local_shot',
  'outbox',
  'sync_receipt',
];

export function schemaIsCurrent(probe: SchemaProbe): boolean {
  return (
    JSON.stringify(probe.tables) === JSON.stringify(CURRENT_TABLES) &&
    Object.values(probe.ownerScoped).every(Boolean) &&
    probe.leftoverTempTables.length === 0 &&
    probe.outboxHasOwner &&
    probe.captureHasPayload &&
    probe.captureHasConsent
  );
}

export function countRows(
  raw: SqliteDatabaseSync,
  sql: string,
  params: SqlInputValue[] = [],
): number {
  const row = raw.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}
