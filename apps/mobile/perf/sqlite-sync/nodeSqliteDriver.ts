/**
 * node:sqlite-backed stand-in for `@op-engineering/op-sqlite`'s `open()`.
 *
 * The production `LocalDb` (src/data/db.ts) only touches three members of the
 * op-sqlite handle: `executeSync` (migrations), `execute` (everything else)
 * and `close`. This driver implements exactly those over Node's built-in
 * SQLite so the REAL migrations, repository and sync modules run unmodified
 * against a real SQLite engine on Linux.
 *
 * Every statement is recorded with its wall-clock cost so scenarios can
 * attribute time to individual SQL shapes and run EXPLAIN QUERY PLAN on the
 * exact SQL + parameters the production code issued.
 *
 * Fidelity notes (INFERRED from op-sqlite 18.1.4 sources in node_modules):
 * - op-sqlite bundles SQLite 3.51.3 on iOS (cpp/sqlite3.h) and compiles with
 *   SQLITE_DEFAULT_WAL_SYNCHRONOUS=1; Node's engine version is reported in
 *   the run metadata. Query plans are compared for shape, not for timing
 *   parity with an iPhone.
 * - op-sqlite's `execute` resolves on a later macrotask (the statement runs
 *   on a native worker). `hop` emulates that so concurrent callers interleave
 *   the way they would on device.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The react-native jest preset replaces `performance.now` with `Date.now`
 * (1 ms resolution), so every timing in this harness reads the monotonic
 * nanosecond clock instead.
 */
export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export interface StatementRecord {
  seq: number;
  sql: string;
  params: unknown[];
  sync: boolean;
  durationMs: number;
  rowCount: number;
  error: string | null;
}

export interface OpenParams {
  name: string;
  location?: string;
  encryptionKey?: string;
}

export interface HarnessHandle {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  close(): void;
}

export interface HarnessDriver {
  /** Run directory: the database file lives in `<dir>/db`, artifacts beside it. */
  dir: string;
  /** Path of the most recently opened database file. */
  filePath: string | null;
  /** Live connection (null after close()). */
  db: DatabaseSync | null;
  records: StatementRecord[];
  recording: boolean;
  /** Emulate op-sqlite's async native round trip between calls. */
  hop: boolean;
  opens: number;
  /** Hook fired after each statement completes (used by concurrency probes). */
  onStatement: ((record: StatementRecord) => void) | null;
  /** Optional per-open pragmas (e.g. journal_mode=WAL) applied after open. */
  openPragmas: string[];
}

const driver: HarnessDriver = {
  dir: join(process.cwd(), 'artifacts', 'perf-sqlite-sync', 'adhoc'),
  filePath: null,
  db: null,
  records: [],
  recording: false,
  hop: true,
  opens: 0,
  onStatement: null,
  openPragmas: [],
};

let seq = 0;

export function getHarnessDriver(): HarnessDriver {
  return driver;
}

export function configureHarnessDriver(
  patch: Partial<Pick<HarnessDriver, 'dir' | 'hop' | 'openPragmas'>>,
): void {
  Object.assign(driver, patch);
}

export function resetRecords(): StatementRecord[] {
  const out = driver.records;
  driver.records = [];
  return out;
}

export function requireDb(): DatabaseSync {
  if (!driver.db) throw new Error('harness database is not open');
  return driver.db;
}

function bindable(
  value: unknown,
): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

function toRows(raw: unknown[]): Record<string, unknown>[] {
  return raw.map(row => ({ ...(row as Record<string, unknown>) }));
}

function run(
  sql: string,
  params: unknown[],
  sync: boolean,
): { rows: Record<string, unknown>[] } {
  const db = requireDb();
  const started = nowMs();
  let rows: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const statement = db.prepare(sql);
    rows = toRows(statement.all(...params.map(bindable)));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const record: StatementRecord = {
      seq: ++seq,
      sql,
      params,
      sync,
      durationMs: nowMs() - started,
      rowCount: rows.length,
      error,
    };
    if (driver.recording) driver.records.push(record);
    driver.onStatement?.(record);
  }
  return { rows };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function openHarnessDatabase(params: OpenParams): HarnessHandle {
  if (driver.db) {
    throw new Error(
      'harness database already open — production getDb() must reuse its instance',
    );
  }
  const dbDir = join(driver.dir, 'db');
  mkdirSync(dbDir, { recursive: true });
  const filePath = join(dbDir, params.name);
  const db = new DatabaseSync(filePath);
  for (const pragma of driver.openPragmas) db.exec(pragma);
  driver.db = db;
  driver.filePath = filePath;
  driver.opens += 1;
  return {
    executeSync(sql, statementParams = []) {
      return run(sql, statementParams, true);
    },
    async execute(sql, statementParams = []) {
      if (driver.hop) await nextTurn();
      return run(sql, statementParams, false);
    },
    close() {
      if (driver.db) {
        driver.db.close();
        driver.db = null;
      }
    },
  };
}

/** Module shape handed to `jest.mock('@op-engineering/op-sqlite', …)`. */
export const opSqliteShim = {
  open: openHarnessDatabase,
};

export interface PlanLine {
  id: number;
  parent: number;
  detail: string;
}

export function explainQueryPlan(sql: string, params: unknown[]): PlanLine[] {
  const db = requireDb();
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  const rows = statement.all(...params.map(bindable)) as Array<
    Record<string, unknown>
  >;
  return rows.map(row => ({
    id: Number(row['id']),
    parent: Number(row['parent']),
    detail: String(row['detail']),
  }));
}

export function sqliteVersion(): string {
  const db = requireDb();
  const row = db.prepare('SELECT sqlite_version() AS v').get() as {
    v: string;
  };
  return row.v;
}

export function pragmaValue(name: string): unknown {
  const db = requireDb();
  const row = db.prepare(`PRAGMA ${name}`).get() as
    Record<string, unknown> | undefined;
  if (!row) return null;
  const values = Object.values(row);
  return values.length === 1 ? values[0] : row;
}

export function databaseFileBytes(): number {
  const pageCount = Number(pragmaValue('page_count'));
  const pageSize = Number(pragmaValue('page_size'));
  return pageCount * pageSize;
}

export function artifactPath(...parts: string[]): string {
  const path = join(driver.dir, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
