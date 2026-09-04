/**
 * XC journey-history-library-delete — REAL SQLite behind the production
 * `getDb()`.
 *
 * `@op-engineering/op-sqlite` is a native module and cannot open a database
 * under jest on Linux, so every existing repository/sync test scripts a fake
 * `LocalDb`. That fake can only pin the SQL text the code emits; it cannot
 * observe what SQLite actually does with `INSERT OR REPLACE`, composite
 * primary keys, `BEGIN IMMEDIATE`/`ROLLBACK`, or a statement that fails
 * midway through a transaction. This adapter implements the exact subset of
 * the op-sqlite `DB` surface that `src/data/db.ts` uses (`executeSync`,
 * `execute`, `close`) on top of Node's built-in `node:sqlite`, so a test can
 * `jest.mock('@op-engineering/op-sqlite', ...)` and let the REAL
 * `openMigrated()` run the REAL local migrations against a real engine.
 *
 * Engine: `node:sqlite` in-process on Node >= 22.13 (or any Node started
 * with `--experimental-sqlite`); on Node 22.5–22.12 without the flag the
 * same engine runs on a worker thread that carries the flag itself
 * (`workerSqlite.ts`). When neither works the open FAILS with an explicit
 * error — it never silently skips.
 *
 * Fault injection: `failNext(matcher)` makes the next statement whose SQL
 * matches throw exactly once, BEFORE it reaches SQLite — modelling a driver /
 * disk-full / interrupted write at a chosen statement so the surrounding
 * transaction logic is exercised for real.
 */

// The mobile tsconfig has no Node types; declare the few globals we use (same
// pattern as the existing __tests__ that read __dirname / process.env).
declare const process: {
  version: string;
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number };
};
declare const __dirname: string;
declare const require: (id: string) => unknown;

type SqlInput = null | number | bigint | string | Uint8Array;

interface StatementSyncLike {
  all(...params: SqlInput[]): unknown[];
  run(...params: SqlInput[]): { changes: number | bigint };
}

interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  exec(sql: string): void;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
}

export interface SqlCall {
  seq: number;
  sql: string;
  params: unknown[];
  outcome: 'ok' | 'injected_failure' | 'sqlite_error';
  error?: string;
}

export interface InjectedFault {
  /** Substring or regular expression matched against the statement SQL. */
  match: string | RegExp;
  /** Error message thrown in place of the statement. */
  message: string;
  /** How many matching statements should fail (default 1). */
  times?: number;
}

export type SqliteEngine = 'node:sqlite' | 'node:sqlite@worker';

let engine: SqliteEngine | null = null;
let loaded: NodeSqliteModule | null = null;

/** Which engine backs the drivers (`null` until the first open). */
export function sqliteEngine(): SqliteEngine | null {
  return engine;
}

function loadNodeSqlite(): NodeSqliteModule {
  if (loaded) return loaded;
  loaded = resolveNodeSqlite();
  return loaded;
}

function resolveNodeSqlite(): NodeSqliteModule {
  try {
    const mod = require('node:sqlite') as NodeSqliteModule;
    engine = 'node:sqlite';
    return mod;
  } catch (inProcessError) {
    try {
      const { WorkerDatabaseSync } =
        require('./workerSqlite') as typeof import('./workerSqlite');
      // Constructing one proves the worker can load node:sqlite at all.
      new WorkerDatabaseSync(':memory:').close();
      engine = 'node:sqlite@worker';
      return { DatabaseSync: WorkerDatabaseSync };
    } catch (workerError) {
      throw new Error(
        `node:sqlite is unavailable on ${process.version} both in-process ` +
          `(${String(inProcessError)}) and on a --experimental-sqlite worker ` +
          `(${String(workerError)}). Run under Node >= 22.13 or with ` +
          `NODE_OPTIONS=--experimental-sqlite.`,
      );
    }
  }
}

const RESULT_ROWS_STATEMENT = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

function toBindable(value: unknown): SqlInput {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function toPlainRow(row: unknown): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    plain[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return plain;
}

export class RealSqliteDriver {
  private readonly db: DatabaseSyncLike;
  private faults: Array<InjectedFault & { remaining: number }> = [];
  private seq = 0;
  private closed = false;
  /** Extra microtask hops before each async statement (0 = none). Lets a
   * seeded fuzzer explore the interleavings two concurrent callers of one
   * connection can produce on a device. */
  jitter: (() => number) | null = null;
  /** The most recent statements the production code issued, in order
   * (bounded so a long fuzz run does not hoard the whole SQL history). */
  readonly calls: SqlCall[] = [];
  static readonly CALL_LOG_LIMIT = 4000;

  private record(call: SqlCall): void {
    this.calls.push(call);
    if (this.calls.length > RealSqliteDriver.CALL_LOG_LIMIT) {
      this.calls.splice(0, this.calls.length - RealSqliteDriver.CALL_LOG_LIMIT);
    }
  }
  /** Total statements attempted (including injected failures). */
  get statementCount(): number {
    return this.seq;
  }

  constructor(readonly path: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(path);
  }

  failNext(fault: InjectedFault): void {
    this.faults.push({ ...fault, remaining: fault.times ?? 1 });
  }

  pendingFaults(): number {
    return this.faults.reduce((sum, fault) => sum + fault.remaining, 0);
  }

  private takeFault(sql: string): InjectedFault | null {
    for (const fault of this.faults) {
      const hit =
        typeof fault.match === 'string'
          ? sql.includes(fault.match)
          : fault.match.test(sql);
      if (hit && fault.remaining > 0) {
        fault.remaining -= 1;
        if (fault.remaining === 0) {
          this.faults = this.faults.filter(f => f !== fault);
        }
        return fault;
      }
    }
    return null;
  }

  executeSync(
    sql: string,
    params: unknown[] = [],
  ): { rows: Record<string, unknown>[] } {
    const seq = ++this.seq;
    const fault = this.takeFault(sql);
    if (fault) {
      this.record({
        seq,
        sql,
        params,
        outcome: 'injected_failure',
        error: fault.message,
      });
      throw new Error(fault.message);
    }
    if (this.closed) {
      throw new Error('RealSqliteDriver: database is closed');
    }
    try {
      const bound = params.map(toBindable);
      if (RESULT_ROWS_STATEMENT.test(sql)) {
        const rows = this.db
          .prepare(sql)
          .all(...bound)
          .map(toPlainRow);
        this.record({ seq, sql, params, outcome: 'ok' });
        return { rows };
      }
      if (bound.length === 0) {
        this.db.exec(sql);
      } else {
        this.db.prepare(sql).run(...bound);
      }
      this.record({ seq, sql, params, outcome: 'ok' });
      return { rows: [] };
    } catch (error) {
      this.record({
        seq,
        sql,
        params,
        outcome: 'sqlite_error',
        error: String(error),
      });
      throw error;
    }
  }

  /** Asynchronous like op-sqlite: the statement runs on a later microtask so
   * two concurrent callers interleave the way they would on a device. */
  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    await Promise.resolve();
    const hops = this.jitter ? this.jitter() : 0;
    for (let i = 0; i < hops; i++) {
      await Promise.resolve();
    }
    return this.executeSync(sql, params);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Raw table dump, deterministic order, bypassing every owner filter. */
  dump(table: string, orderBy = 'rowid'): Record<string, unknown>[] {
    return this.executeSync(`SELECT * FROM ${table} ORDER BY ${orderBy}`).rows;
  }

  count(table: string, where = '1=1', params: unknown[] = []): number {
    const { rows } = this.executeSync(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.['n'] ?? 0);
  }

  inTransaction(): boolean {
    // `BEGIN` while a transaction is open throws; probe via a savepoint-free
    // read of sqlite's autocommit flag exposed through a no-op statement.
    try {
      this.db.exec('BEGIN');
      this.db.exec('ROLLBACK');
      return false;
    } catch {
      return true;
    }
  }
}

/** The op-sqlite `open()` replacement; every open is a fresh in-memory DB
 * unless `XC_SQLITE_FILE` points at a file path (persistence across
 * close/reopen). */
let current: RealSqliteDriver | null = null;
const opened: RealSqliteDriver[] = [];

export function openRealSqlite(_options?: { name?: string }): RealSqliteDriver {
  const path = process.env['XC_SQLITE_FILE'] ?? ':memory:';
  const driver = new RealSqliteDriver(path);
  current = driver;
  opened.push(driver);
  return driver;
}

export function currentDriver(): RealSqliteDriver {
  if (!current) {
    throw new Error(
      'No real SQLite driver is open — call getDb() before inspecting it.',
    );
  }
  return current;
}

export function openedDriverCount(): number {
  return opened.length;
}

/** Owner-scoped tables exactly as `repository.ts` OWNER_SCOPED_TABLES lists
 * them (duplicated here on purpose: the harness must not import a private
 * constant to decide what "all rows for an owner" means). */
export const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'outbox',
  'sync_receipt',
  'local_analysis_record',
] as const;

export type OwnerTable = (typeof OWNER_TABLES)[number];

export interface OwnerSnapshot {
  owner: string;
  counts: Record<OwnerTable, number>;
  shotIds: string[];
  queuedShotIds: string[];
  receiptShotIds: string[];
  recordIds: string[];
  captureIds: string[];
  kvKeys: string[];
}

export function snapshotOwner(
  driver: RealSqliteDriver,
  owner: string,
): OwnerSnapshot {
  const counts = {} as Record<OwnerTable, number>;
  for (const table of OWNER_TABLES) {
    counts[table] = driver.count(table, 'owner_key = ?', [owner]);
  }
  const ids = (sql: string, key: string): string[] =>
    driver
      .executeSync(sql, [owner])
      .rows.map(row => String(row[key]))
      .sort();
  return {
    owner,
    counts,
    shotIds: ids('SELECT id FROM local_shot WHERE owner_key = ?', 'id'),
    queuedShotIds: ids(
      `SELECT json_extract(payload, '$.id') AS id FROM outbox
       WHERE owner_key = ? AND kind = 'shot.sync'`,
      'id',
    ),
    receiptShotIds: ids(
      `SELECT entity_id AS id FROM sync_receipt
       WHERE owner_key = ? AND kind = 'shot.sync'`,
      'id',
    ),
    recordIds: ids(
      'SELECT id FROM local_analysis_record WHERE owner_key = ?',
      'id',
    ),
    captureIds: ids('SELECT id FROM local_capture WHERE owner_key = ?', 'id'),
    kvKeys: driver
      .executeSync('SELECT key FROM kv WHERE key LIKE ?', [`%:${owner}`])
      .rows.map(row => String(row['key']))
      .sort(),
  };
}

/**
 * Structural ghost-row audit over the WHOLE database (every owner).
 * A "ghost" is a row that refers to a shot/capture that no longer exists for
 * the same owner, or two rows that contradict each other about one shot.
 */
export interface GhostAudit {
  outboxWithoutShot: Array<{ owner: string; shotId: string }>;
  receiptWithoutShot: Array<{ owner: string; shotId: string }>;
  receiptAndQueued: Array<{ owner: string; shotId: string }>;
  recordWithoutCapture: Array<{ owner: string; recordId: string }>;
  scoredRecordWithoutShot: Array<{ owner: string; recordId: string }>;
  outboxWrongOwner: Array<{ owner: string; shotId: string; shotOwner: string }>;
  total: number;
}

export function auditGhosts(driver: RealSqliteDriver): GhostAudit {
  const q = (sql: string) => driver.executeSync(sql).rows;
  const outboxWithoutShot = q(
    `SELECT o.owner_key AS owner, json_extract(o.payload, '$.id') AS shotId
     FROM outbox o
     WHERE o.kind = 'shot.sync'
       AND NOT EXISTS (SELECT 1 FROM local_shot s
                       WHERE s.owner_key = o.owner_key
                         AND s.id = json_extract(o.payload, '$.id'))
     ORDER BY o.id`,
  ).map(r => ({ owner: String(r['owner']), shotId: String(r['shotId']) }));
  const receiptWithoutShot = q(
    `SELECT r.owner_key AS owner, r.entity_id AS shotId
     FROM sync_receipt r
     WHERE r.kind = 'shot.sync'
       AND NOT EXISTS (SELECT 1 FROM local_shot s
                       WHERE s.owner_key = r.owner_key AND s.id = r.entity_id)
     ORDER BY r.owner_key, r.entity_id`,
  ).map(r => ({ owner: String(r['owner']), shotId: String(r['shotId']) }));
  const receiptAndQueued = q(
    `SELECT r.owner_key AS owner, r.entity_id AS shotId
     FROM sync_receipt r
     WHERE r.kind = 'shot.sync'
       AND EXISTS (SELECT 1 FROM outbox o
                   WHERE o.owner_key = r.owner_key AND o.kind = 'shot.sync'
                     AND json_extract(o.payload, '$.id') = r.entity_id)
     ORDER BY r.owner_key, r.entity_id`,
  ).map(r => ({ owner: String(r['owner']), shotId: String(r['shotId']) }));
  const recordWithoutCapture = q(
    `SELECT a.owner_key AS owner, a.id AS recordId
     FROM local_analysis_record a
     WHERE NOT EXISTS (SELECT 1 FROM local_capture c
                       WHERE c.owner_key = a.owner_key AND c.id = a.capture_id)
     ORDER BY a.owner_key, a.id`,
  ).map(r => ({ owner: String(r['owner']), recordId: String(r['recordId']) }));
  const scoredRecordWithoutShot = q(
    `SELECT a.owner_key AS owner, a.id AS recordId
     FROM local_analysis_record a
     WHERE json_extract(a.record, '$.result.resultKind') = 'scored'
       AND NOT EXISTS (SELECT 1 FROM local_shot s
                       WHERE s.owner_key = a.owner_key AND s.id = a.id)
     ORDER BY a.owner_key, a.id`,
  ).map(r => ({ owner: String(r['owner']), recordId: String(r['recordId']) }));
  const outboxWrongOwner = q(
    `SELECT o.owner_key AS owner, json_extract(o.payload, '$.id') AS shotId,
            s.owner_key AS shotOwner
     FROM outbox o JOIN local_shot s ON s.id = json_extract(o.payload, '$.id')
     WHERE o.kind = 'shot.sync' AND s.owner_key <> o.owner_key
     ORDER BY o.id`,
  ).map(r => ({
    owner: String(r['owner']),
    shotId: String(r['shotId']),
    shotOwner: String(r['shotOwner']),
  }));
  return {
    outboxWithoutShot,
    receiptWithoutShot,
    receiptAndQueued,
    recordWithoutCapture,
    scoredRecordWithoutShot,
    outboxWrongOwner,
    total:
      outboxWithoutShot.length +
      receiptWithoutShot.length +
      receiptAndQueued.length +
      recordWithoutCapture.length +
      scoredRecordWithoutShot.length +
      outboxWrongOwner.length,
  };
}

/** Deterministic PRNG (mulberry32) so every failing run replays from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const index = Math.floor(rand() * items.length);
  const item = items[index];
  if (item === undefined) {
    throw new Error('pick() from an empty list');
  }
  return item;
}

/** Deterministic RFC-4122-shaped id from (seed, counter) so ids are valid
 * canonical UUIDs where the code requires one. */
export function seededUuid(rand: () => number): string {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const block = (n: number) => Array.from({ length: n }, hex).join('');
  const variant = ['8', '9', 'a', 'b'][Math.floor(rand() * 4)] ?? '8';
  return `${block(8)}-${block(4)}-4${block(3)}-${variant}${block(3)}-${block(12)}`;
}

/** Artifact sink: JSON tables the report links to. Written under
 * `<repo>/artifacts/xc-journey-history-library-delete/` unless
 * `XC_ARTIFACT_DIR` overrides it. */
export function writeArtifact(name: string, data: unknown): string {
  const { mkdirSync, writeFileSync } = require('fs') as {
    mkdirSync: (path: string, options: { recursive: boolean }) => void;
    writeFileSync: (path: string, content: string) => void;
  };
  const { join, resolve } = require('path') as {
    join: (...parts: string[]) => string;
    resolve: (...parts: string[]) => string;
  };
  const dir =
    process.env['XC_ARTIFACT_DIR'] ??
    resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'artifacts',
      'xc-journey-history-library-delete',
    );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
}
