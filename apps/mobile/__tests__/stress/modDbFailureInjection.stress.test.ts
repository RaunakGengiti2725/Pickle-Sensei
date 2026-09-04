/**
 * mod-db failure-injection stress campaign — `src/data/db.ts` open/migrate.
 *
 * The production module is loaded UNMODIFIED (`jest.requireActual` inside
 * `jest.isolateModules`) on top of an op-sqlite seam that runs every statement
 * against a REAL SQLite file (`node:sqlite`) and can inject, per seed:
 *
 *   driver faults    executeSync throws (10 error shapes × pre/post statement,
 *                    once / persistent / every-other), malformed PRAGMA
 *                    table_info result shapes, `open()` throwing or returning
 *                    junk, `close()` throwing, async `execute` reject /
 *                    sync-throw / never-resolves / slow / malformed result
 *   disk faults      another connection holding a reader / writer / exclusive
 *                    lock (concurrent open), disk full (max_page_count),
 *                    read-only file / directory, corrupted header, corrupted
 *                    page, truncated file, garbage hot journal
 *   row faults       every seeded population carries malformed shot / outbox
 *                    payloads (RAW_STRING_VARIANTS) and fixture rows
 *   wrapper faults   stale wrapper after close, double close, two wrappers,
 *                    close with in-flight executes, N×getDb reuse
 *
 * against the historical on-disk schemas (fresh, v0 unscoped, v1, v1b, and an
 * already-migrated v2). Each iteration is replayable from its seed alone.
 *
 * Per iteration the campaign asserts: the injected error is surfaced (never
 * masked, never a fake success), the native handle is released and no dead
 * handle stays cached, the file never holds a half-applied migration
 * (`*_account_v2` leftovers / lost rows), the next open after the fault is
 * cleared recovers, and the recovered database is schema-current, passes
 * `PRAGMA integrity_check`, purged fixtures, and preserved every real shot /
 * session / outbox row / capture / kv value byte-for-byte with its owner.
 *
 * Scale: `STRESS_ITER` seeded iterations (default 400; the campaign run for
 * the report used 3000) plus the fixed-factor fault suite (one row per
 * injected fault). Replay: `STRESS_SEEDS=12,77 STRESS_REPEAT=10`.
 * Artifacts (gitignored `artifacts/stress-mod-db/`, override with
 * STRESS_ARTIFACT_DIR): `mod-db-failure-injection.rows.json` (seed → inputs,
 * observed, invariants, ok), `.summary.json`, `.matrix.md`.
 *
 * Runtime: needs `node:sqlite` (Node >= 22.13, or 22.5–22.12 with
 * --experimental-sqlite — the suite re-execs itself under the flag).
 */

import type { LocalDb } from '../../src/data/db';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';
import {
  childProcess,
  fs as shimFs,
  loadNodeSqlite,
  nodeProcess,
  os,
  path,
  resolveModule,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
  RAW_STRING_VARIANTS,
  RAW_VARIANT_NAMES,
  makePrng,
  pick,
} from '../../xc-harness/lifecycle-persistence/seeds';

declare const __dirname: string;
declare const __filename: string;
declare const require: (id: string) => unknown;

// ─── Node surface beyond the shared shim ─────────────────────────────────────

interface StressFs {
  copyFileSync(src: string, dest: string): void;
  truncateSync(file: string, length: number): void;
  readFileSync(file: string): Uint8Array;
  writeFileSync(file: string, data: string | Uint8Array): void;
  openSync(file: string, flags: string): number;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
  statSync(file: string): { size: number };
  existsSync(target: string): boolean;
  chmodSync(target: string, mode: number): void;
  mkdirSync(dir: string, options?: { recursive?: boolean }): void;
  rmSync(
    target: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
}

const fs = require('node:fs') as StressFs;

interface StatementIterator {
  next(): { done: boolean; value: unknown };
  return(): unknown;
}

interface StressStatement {
  all(...params: SqlInputValue[]): unknown[];
  get(...params: SqlInputValue[]): unknown;
  run(...params: SqlInputValue[]): unknown;
  iterate(...params: SqlInputValue[]): StatementIterator;
}

interface StressDatabase extends SqliteDatabaseSync {
  prepare(sql: string): StressStatement;
}

interface StressSqlite {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean },
  ) => StressDatabase;
}

const sqlite = loadNodeSqlite() as StressSqlite | null;

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const SUITE = 'mod-db-failure-injection';
const DB_FILE = 'pickle-sensei.db';
const DEFAULT_ITER = 400;
const CHUNK = 100;

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const STRESS_ITER = envInt('STRESS_ITER', DEFAULT_ITER);
const STRESS_REPEAT = Math.max(1, envInt('STRESS_REPEAT', 1));
const STRESS_SEEDS: number[] | null = (() => {
  const raw = nodeProcess.env['STRESS_SEEDS'];
  if (!raw) return null;
  const seeds = raw
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));
  return seeds.length > 0 ? seeds : null;
})();

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-mod-db');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
  return file;
}

// ─── Fault catalogue ─────────────────────────────────────────────────────────

const ERROR_SHAPES = [
  'ioerr',
  'full',
  'busy',
  'locked',
  'corrupt',
  'readonly',
  'cantopen',
  'typeerror',
  'string',
  'null',
  'plain-object',
] as const;
type ErrorShape = (typeof ERROR_SHAPES)[number];

const STATEMENT_ANCHORS = [
  'first',
  'purge-outbox',
  'begin-immediate',
  'rebuild-insert',
  'drop-legacy',
  'add-column',
  'commit',
  'last',
  'seeded-index',
] as const;
type StatementAnchor = (typeof STATEMENT_ANCHORS)[number];

const FAULT_MODES = ['once', 'persistent', 'every-other'] as const;
type FaultMode = (typeof FAULT_MODES)[number];

const MALFORMED_SHAPES = [
  'undefined-result',
  'null-result',
  'empty-object',
  'rows-null',
  'rows-string',
  'rows-number',
  'rows-empty',
  'rows-empty-objects',
  'rows-null-entries',
  'pk-strings',
  'pk-null',
  'pk-bool',
  'pk-negative',
  'name-numbers',
  'name-missing',
  'rows-duplicated',
  'rows-reversed',
  'rows-extra-junk',
  'rows-foreign-table',
] as const;
type MalformedShape = (typeof MALFORMED_SHAPES)[number];

const OPEN_FAULTS = [
  'throw-error',
  'throw-string',
  'throw-null',
  'return-null',
  'return-undefined',
  'return-empty-object',
  'return-no-close',
  'return-executeSync-throws-always',
] as const;
type OpenFault = (typeof OPEN_FAULTS)[number];

const CLOSE_FAULTS = [
  'throw-after-native-close',
  'throw-without-native-close',
] as const;
type CloseFault = (typeof CLOSE_FAULTS)[number];
const CLOSE_WHEN = ['migration-failure', 'wrapper-close'] as const;
type CloseWhen = (typeof CLOSE_WHEN)[number];

const ASYNC_FAULTS = [
  'reject',
  'throw-sync',
  'never-resolves',
  'slow-5s',
  'undefined-result',
  'null-result',
  'rows-null',
  'rows-undefined',
  'rows-string',
] as const;
type AsyncFault = (typeof ASYNC_FAULTS)[number];

const DISK_FAULTS = [
  'lock-reader',
  'lock-writer',
  'lock-exclusive',
  'disk-full',
  'readonly-file',
  'readonly-dir',
  'corrupt-header',
  'corrupt-page',
  'truncate',
  'garbage-journal',
] as const;
type DiskFault = (typeof DISK_FAULTS)[number];
const UNRECOVERABLE_DISK: ReadonlySet<DiskFault> = new Set<DiskFault>([
  'corrupt-header',
  'corrupt-page',
  'truncate',
]);

const WRAPPER_SCENARIOS = [
  'stale-wrapper-after-close',
  'double-close',
  'two-wrappers-one-closed',
  'close-with-inflight-executes',
  'getdb-reuse-x50',
] as const;
type WrapperScenario = (typeof WRAPPER_SCENARIOS)[number];

const SCHEMAS = [
  'fresh',
  'v0-unscoped',
  'v1-52ba173',
  'v1b-b2731c9',
  'v2-current',
] as const;
type SchemaName = (typeof SCHEMAS)[number];

type FaultPlan =
  | { family: 'none' }
  | {
      family: 'stmt-throw';
      shape: ErrorShape;
      anchor: StatementAnchor;
      phase: 'pre' | 'post';
      mode: FaultMode;
      seededIndex: number;
    }
  | {
      family: 'stmt-malformed';
      shape: MalformedShape;
      pragmaIndex: number;
      mode: FaultMode;
    }
  | { family: 'open'; kind: OpenFault; mode: FaultMode }
  | {
      family: 'close';
      kind: CloseFault;
      when: CloseWhen;
      withMigrationFault: boolean;
    }
  | { family: 'async'; kind: AsyncFault; mode: FaultMode }
  | { family: 'disk'; kind: DiskFault; seededOffset: number }
  | { family: 'wrapper'; kind: WrapperScenario };

// ─── op-sqlite seam ──────────────────────────────────────────────────────────

interface MockHandle {
  id: number;
  inner: StressDatabase | null;
  closed: boolean;
  closeCalls: number;
  nativeClosed: boolean;
}

interface Harness {
  dir: string;
  opens: number;
  statements: string[];
  pragmaCalls: number;
  handles: MockHandle[];
  fault: FaultPlan | null;
  firedCount: number;
  firedAt: string[];
  lastInjected: unknown[];
  /** Armed only while a specific scenario needs it; cleared before recovery. */
  disarmed: boolean;
  diskFull: boolean;
  closeFaultArmed: boolean;
  /** Close faults live in their own slot so a statement fault can be armed at the same time. */
  closeFault: FaultPlan | null;
  asyncArmed: boolean;
  asyncDelayMs: number;
}

const harness: Harness = {
  dir: '',
  opens: 0,
  statements: [],
  pragmaCalls: 0,
  handles: [],
  fault: null,
  firedCount: 0,
  firedAt: [],
  lastInjected: [],
  disarmed: true,
  diskFull: false,
  closeFaultArmed: false,
  closeFault: null,
  asyncArmed: false,
  asyncDelayMs: 0,
};

function resetHarness(dir: string): void {
  harness.dir = dir;
  harness.opens = 0;
  harness.statements = [];
  harness.pragmaCalls = 0;
  harness.handles = [];
  harness.fault = null;
  harness.firedCount = 0;
  harness.firedAt = [];
  harness.lastInjected = [];
  harness.disarmed = true;
  harness.diskFull = false;
  harness.closeFaultArmed = false;
  harness.closeFault = null;
  harness.asyncArmed = false;
  harness.asyncDelayMs = 0;
}

function makeInjected(shape: ErrorShape, where: string): unknown {
  const tag = `[injected:${where}]`;
  switch (shape) {
    case 'ioerr':
      return new Error(`${tag} [op-sqlite] SQLITE_IOERR: disk I/O error`);
    case 'full':
      return new Error(
        `${tag} [op-sqlite] SQLITE_FULL: database or disk is full`,
      );
    case 'busy':
      return new Error(`${tag} [op-sqlite] SQLITE_BUSY: database is locked`);
    case 'locked':
      return new Error(
        `${tag} [op-sqlite] SQLITE_LOCKED: database table is locked`,
      );
    case 'corrupt':
      return new Error(
        `${tag} [op-sqlite] SQLITE_CORRUPT: database disk image is malformed`,
      );
    case 'readonly':
      return new Error(
        `${tag} [op-sqlite] SQLITE_READONLY: attempt to write a readonly database`,
      );
    case 'cantopen':
      return new Error(
        `${tag} [op-sqlite] SQLITE_CANTOPEN: unable to open database file`,
      );
    case 'typeerror':
      return new TypeError(`${tag} Cannot read properties of undefined`);
    case 'string':
      return `${tag} bare string thrown by driver`;
    case 'null':
      return null;
    case 'plain-object':
      return { code: 'SQLITE_ERROR', tag };
  }
}

function fire(where: string, injected: unknown): void {
  harness.firedCount += 1;
  harness.firedAt.push(where);
  harness.lastInjected.push(injected);
}

function modeHit(mode: FaultMode, hits: number): boolean {
  if (mode === 'once') return hits === 0;
  if (mode === 'persistent') return true;
  return hits % 2 === 0;
}

function anchorIndex(
  anchor: StatementAnchor,
  probe: string[],
  seededIndex: number,
): number {
  const find = (pred: (sql: string) => boolean, fromEnd = false): number => {
    const list = fromEnd ? [...probe].reverse() : probe;
    const i = list.findIndex(pred);
    if (i < 0) return -1;
    return fromEnd ? probe.length - 1 - i : i;
  };
  switch (anchor) {
    case 'first':
      return 0;
    case 'purge-outbox':
      return find(sql => /DELETE FROM outbox/i.test(sql));
    case 'begin-immediate':
      return find(sql => /^BEGIN IMMEDIATE$/i.test(sql.trim()));
    case 'rebuild-insert':
      return find(sql => /INSERT OR IGNORE INTO \w+_account_v2/i.test(sql));
    case 'drop-legacy':
      return find(sql =>
        /^DROP TABLE (local_shot|local_session|local_capture)$/i.test(
          sql.trim(),
        ),
      );
    case 'add-column':
      return find(sql => /ALTER TABLE \w+ ADD COLUMN/i.test(sql));
    case 'commit':
      return find(sql => /^COMMIT$/i.test(sql.trim()));
    case 'last':
      return probe.length - 1;
    case 'seeded-index':
      return probe.length === 0 ? 0 : seededIndex % probe.length;
  }
}

/** Resolved once per scenario from the fault-free probe run. */
let resolvedStatementIndex = -1;
let stmtHits = 0;
let pragmaHits = 0;
let asyncHits = 0;

function malformedPragma(
  shape: MalformedShape,
  rows: Record<string, unknown>[],
): unknown {
  switch (shape) {
    case 'undefined-result':
      return undefined;
    case 'null-result':
      return null;
    case 'empty-object':
      return {};
    case 'rows-null':
      return { rows: null };
    case 'rows-string':
      return { rows: 'not an array' };
    case 'rows-number':
      return { rows: 42 };
    case 'rows-empty':
      return { rows: [] };
    case 'rows-empty-objects':
      return { rows: rows.map(() => ({})) };
    case 'rows-null-entries':
      return { rows: rows.map(() => null) };
    case 'pk-strings':
      return { rows: rows.map(r => ({ ...r, pk: String(r['pk']) })) };
    case 'pk-null':
      return { rows: rows.map(r => ({ ...r, pk: null })) };
    case 'pk-bool':
      return { rows: rows.map(r => ({ ...r, pk: Number(r['pk']) > 0 })) };
    case 'pk-negative':
      return { rows: rows.map(r => ({ ...r, pk: -Number(r['pk']) })) };
    case 'name-numbers':
      return { rows: rows.map((r, i) => ({ ...r, name: i })) };
    case 'name-missing':
      return {
        rows: rows.map(r => {
          const copy: Record<string, unknown> = { ...r };
          delete copy['name'];
          return copy;
        }),
      };
    case 'rows-duplicated':
      return { rows: [...rows, ...rows] };
    case 'rows-reversed':
      return { rows: [...rows].reverse() };
    case 'rows-extra-junk':
      return {
        rows: [...rows, { cid: 99, name: 'ghost', type: 'TEXT', pk: 0 }],
      };
    case 'rows-foreign-table':
      return {
        rows: [
          {
            cid: 0,
            name: 'key',
            type: 'TEXT',
            notnull: 0,
            dflt_value: null,
            pk: 1,
          },
          {
            cid: 1,
            name: 'value',
            type: 'TEXT',
            notnull: 1,
            dflt_value: null,
            pk: 0,
          },
        ],
      };
  }
}

function runStatement(
  handle: MockHandle,
  sql: string,
  params: unknown[],
): { rows: Record<string, unknown>[] } {
  if (!handle.inner) {
    throw new Error('[op-sqlite][executeSync] database is closed');
  }
  const rows = handle.inner
    .prepare(sql)
    .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
  return { rows };
}

function executeSyncImpl(
  handle: MockHandle,
  sql: string,
  params: unknown[],
): unknown {
  if (handle.closed) {
    throw new Error('[op-sqlite][executeSync] database is closed');
  }
  const index = harness.statements.length;
  harness.statements.push(sql);
  const fault = harness.disarmed ? null : harness.fault;

  if (
    fault &&
    fault.family === 'stmt-throw' &&
    index === resolvedStatementIndex
  ) {
    const hit = modeHit(fault.mode, stmtHits);
    stmtHits += 1;
    if (hit && fault.phase === 'pre') {
      const injected = makeInjected(fault.shape, `stmt#${index}:pre`);
      fire(`stmt#${index}:pre`, injected);
      throw injected;
    }
    const result = runStatement(handle, sql, params);
    if (hit) {
      const injected = makeInjected(fault.shape, `stmt#${index}:post`);
      fire(`stmt#${index}:post`, injected);
      throw injected;
    }
    return result;
  }

  if (
    fault &&
    fault.family === 'open' &&
    (fault.kind === 'return-executeSync-throws-always' ||
      fault.kind === 'return-no-close')
  ) {
    // `return-no-close`: a handle that fails its first statement AND has no
    // close() — exercises db.ts's "preserve the original migration error" path.
    const injected = makeInjected('ioerr', `open-handle-executeSync#${index}`);
    fire(`open-handle-executeSync#${index}`, injected);
    throw injected;
  }

  const result = runStatement(handle, sql, params);
  if (/^\s*PRAGMA table_info/i.test(sql)) {
    const pragmaIndex = harness.pragmaCalls;
    harness.pragmaCalls += 1;
    if (
      fault &&
      fault.family === 'stmt-malformed' &&
      (fault.mode === 'persistent' || pragmaIndex === fault.pragmaIndex)
    ) {
      const hit = modeHit(fault.mode, pragmaHits);
      pragmaHits += 1;
      if (hit) {
        fire(`pragma#${pragmaIndex}:${sql.trim()}`, fault.shape);
        return malformedPragma(fault.shape, result.rows);
      }
    }
  }
  return result;
}

function executeAsyncImpl(
  handle: MockHandle,
  sql: string,
  params: unknown[],
): Promise<unknown> {
  if (handle.closed) {
    // op-sqlite's HFN throws synchronously before promisify.
    throw new Error('[op-sqlite][execute] database is closed');
  }
  harness.statements.push(sql);
  const fault = harness.asyncArmed ? harness.fault : null;
  const result = runStatement(handle, sql, params);
  const settle = (value: unknown): Promise<unknown> =>
    harness.asyncDelayMs > 0
      ? new Promise(resolve =>
          setTimeout(() => resolve(value), harness.asyncDelayMs),
        )
      : Promise.resolve(value);
  if (fault && fault.family === 'async') {
    const hit = modeHit(fault.mode, asyncHits);
    asyncHits += 1;
    if (hit) {
      switch (fault.kind) {
        case 'reject': {
          const injected = makeInjected('ioerr', 'execute:reject');
          fire('execute:reject', injected);
          return Promise.reject(injected);
        }
        case 'throw-sync': {
          const injected = makeInjected('typeerror', 'execute:throw-sync');
          fire('execute:throw-sync', injected);
          throw injected;
        }
        case 'never-resolves':
          fire('execute:never', 'never');
          return new Promise(() => undefined);
        case 'slow-5s':
          fire('execute:slow', 'slow');
          return new Promise(resolve =>
            setTimeout(() => resolve(result), 5000),
          );
        case 'undefined-result':
          fire('execute:undefined-result', undefined);
          return settle(undefined);
        case 'null-result':
          fire('execute:null-result', null);
          return settle(null);
        case 'rows-null':
          fire('execute:rows-null', null);
          return settle({ rows: null });
        case 'rows-undefined':
          fire('execute:rows-undefined', undefined);
          return settle({});
        case 'rows-string':
          fire('execute:rows-string', 'rows-string');
          return settle({ rows: 'garbage' });
      }
    }
  }
  return settle(result);
}

function closeImpl(handle: MockHandle): void {
  handle.closeCalls += 1;
  const fault =
    harness.closeFaultArmed && !harness.disarmed ? harness.closeFault : null;
  if (fault && fault.family === 'close') {
    if (fault.kind === 'throw-after-native-close') {
      handle.closed = true;
      if (handle.inner) {
        handle.inner.close();
        handle.inner = null;
        handle.nativeClosed = true;
      }
    }
    const injected = makeInjected('ioerr', `close:${fault.kind}`);
    fire(`close:${fault.kind}`, injected);
    throw injected;
  }
  // op-sqlite: close() never throws, a second close() is a no-op.
  handle.closed = true;
  if (handle.inner) {
    handle.inner.close();
    handle.inner = null;
    handle.nativeClosed = true;
  }
}

function openImpl(name: string): unknown {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  harness.opens += 1;
  const fault = harness.disarmed ? null : harness.fault;
  const openHits = harness.opens - 1;
  if (fault && fault.family === 'open' && modeHit(fault.mode, openHits)) {
    switch (fault.kind) {
      case 'throw-error': {
        const injected = makeInjected('cantopen', 'open');
        fire('open:throw-error', injected);
        throw injected;
      }
      case 'throw-string': {
        const injected = makeInjected('string', 'open');
        fire('open:throw-string', injected);
        throw injected;
      }
      case 'throw-null':
        fire('open:throw-null', null);
        throw null;
      case 'return-null':
        fire('open:return-null', null);
        return null;
      case 'return-undefined':
        fire('open:return-undefined', undefined);
        return undefined;
      case 'return-empty-object':
        fire('open:return-empty-object', {});
        return {};
      case 'return-no-close':
      case 'return-executeSync-throws-always':
        break;
    }
  }
  const inner = new sqlite.DatabaseSync(path.join(harness.dir, name));
  if (harness.diskFull) {
    const pages = Number(
      (inner.prepare('PRAGMA page_count').get() as { page_count: number })
        .page_count,
    );
    inner.exec(`PRAGMA max_page_count = ${Math.max(1, pages)}`);
  }
  const handle: MockHandle = {
    id: harness.handles.length,
    inner,
    closed: false,
    closeCalls: 0,
    nativeClosed: false,
  };
  harness.handles.push(handle);
  const api: Record<string, unknown> = {
    executeSync: (sql: string, params: unknown[] = []) =>
      executeSyncImpl(handle, sql, params),
    execute: (sql: string, params: unknown[] = []) =>
      executeAsyncImpl(handle, sql, params),
    close: () => closeImpl(handle),
  };
  if (fault && fault.family === 'open' && fault.kind === 'return-no-close') {
    fire('open:return-no-close', 'no-close');
    delete api['close'];
  }
  return api;
}

const mockOpSqlite = {
  open: (options: { name: string }) => openImpl(options.name),
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

// ─── Historical schemas (DDL as shipped at the named commits) ────────────────

const V0_DDL = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
     result_kind TEXT NOT NULL, source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_local_shot_time ON local_shot (captured_at DESC)`,
  `CREATE TABLE IF NOT EXISTS local_session (
     id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT, focus_checkpoint TEXT,
     started_at TEXT NOT NULL, ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0,
     summary TEXT)`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
];

const V1_DDL = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
     result_kind TEXT NOT NULL, source TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL, PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE IF NOT EXISTS local_session (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL, shot_type TEXT,
     focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0, summary TEXT, PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE IF NOT EXISTS local_capture (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
     width INTEGER NOT NULL, height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')), payload TEXT,
     PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, kind TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id))`,
  `CREATE TABLE IF NOT EXISTS local_analysis_record (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, capture_id TEXT NOT NULL,
     created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
     scoring_model_version TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (owner_key, id))`,
];

interface SchemaShape {
  hasTables: boolean;
  scoped: boolean;
  capture: boolean;
  strokeSeed: boolean;
}

function shapeOf(schema: SchemaName): SchemaShape {
  switch (schema) {
    case 'fresh':
      return {
        hasTables: false,
        scoped: false,
        capture: false,
        strokeSeed: false,
      };
    case 'v0-unscoped':
      return {
        hasTables: true,
        scoped: false,
        capture: false,
        strokeSeed: false,
      };
    case 'v1-52ba173':
      return {
        hasTables: true,
        scoped: true,
        capture: true,
        strokeSeed: false,
      };
    case 'v1b-b2731c9':
    case 'v2-current':
      return { hasTables: true, scoped: true, capture: true, strokeSeed: true };
  }
}

// ─── Seeded population ───────────────────────────────────────────────────────

interface SeedShot {
  owner: string;
  id: string;
  sessionId: string | null;
  source: 'real' | 'fixture' | 'demo';
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: 'scored' | 'low_confidence';
  favorite: 0 | 1;
  payload: string;
}
interface SeedSession {
  owner: string;
  id: string;
  completed: 0 | 1;
  summary: string | null;
  startedAt: string;
}
interface SeedOutbox {
  owner: string;
  kind: string;
  payload: string;
}
interface SeedCapture {
  owner: string;
  id: string;
  uri: string;
  status: 'awaiting_model' | 'analyzed';
  payload: string | null;
  declaredStroke: string | null;
  targetSeed: string | null;
}
interface Population {
  shots: SeedShot[];
  sessions: SeedSession[];
  outbox: SeedOutbox[];
  captures: SeedCapture[];
  kv: Record<string, string>;
  malformedCount: number;
}

const OWNERS = [GUEST_DATA_OWNER, CANONICAL_ID, OTHER_CANONICAL_ID] as const;
const RAW_NAMES = RAW_VARIANT_NAMES.filter(
  n => n !== 'absent' && n !== 'huge-1mb' && n !== 'nul-bytes',
);
const KV_KEYS = [
  'auth.local-mode',
  'auth.last-provider',
  `profile:${GUEST_DATA_OWNER}`,
  `profile:${CANONICAL_ID}`,
  'onboarding.pending-profile',
  'review.prompt-state',
  'walkthrough.device-complete',
  'consent.training',
] as const;

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function population(seed: number, shape: SchemaShape): Population {
  if (!shape.hasTables) {
    return {
      shots: [],
      sessions: [],
      outbox: [],
      captures: [],
      kv: {},
      malformedCount: 0,
    };
  }
  const rng = makePrng(seed ^ 0x5eed);
  const owners: readonly string[] = shape.scoped ? OWNERS : [GUEST_DATA_OWNER];
  let malformedCount = 0;
  const rawVariant = (): string => {
    malformedCount += 1;
    return RAW_STRING_VARIANTS[pick(rng, RAW_NAMES)] as string;
  };
  const sessions: SeedSession[] = [];
  const sessionCount = Math.floor(rng() * 6);
  for (let i = 0; i < sessionCount; i += 1) {
    const kind = pick(rng, [
      'complete-with-shots',
      'incomplete-with-shots',
      'incomplete-no-shots',
      'complete-no-shots',
      'complete-fixture-no-shots',
    ] as const);
    sessions.push({
      owner: pick(rng, owners),
      id: `sess-${seed}-${i}-${kind}`,
      completed: kind.startsWith('complete') ? 1 : 0,
      summary:
        kind === 'complete-fixture-no-shots'
          ? 'fixture summary'
          : kind.startsWith('complete')
            ? rng() < 0.2
              ? rawVariant()
              : `summary ${i}`
            : null,
      startedAt: isoAt(i),
    });
  }
  const shotSessions = sessions.filter(s => s.id.includes('-with-shots'));
  const shots: SeedShot[] = [];
  const makeShot = (i: number, source: SeedShot['source']): SeedShot => {
    const owner = pick(rng, owners);
    const attached =
      shotSessions.length > 0 && rng() < 0.6 ? pick(rng, shotSessions) : null;
    const corrupt = rng() < 0.25;
    const scored = rng() < 0.8;
    const id = `shot-${seed}-${source}-${i}`;
    return {
      owner: attached ? attached.owner : owner,
      id,
      sessionId: attached ? attached.id : null,
      source,
      capturedAt: isoAt(1000 + i),
      overallScore: scored ? Math.round(rng() * 1000) / 10 : null,
      confidence: Math.round(rng() * 1000) / 1000,
      resultKind: scored ? 'scored' : 'low_confidence',
      favorite: rng() < 0.2 ? 1 : 0,
      payload: corrupt
        ? rawVariant()
        : JSON.stringify({ id, source, shotType: 'forehand_drive', i }),
    };
  };
  const realCount = Math.floor(rng() * 25);
  const fixtureCount = Math.floor(rng() * 5);
  for (let i = 0; i < realCount; i += 1) shots.push(makeShot(i, 'real'));
  for (let i = 0; i < fixtureCount; i += 1) {
    shots.push(makeShot(i, pick(rng, ['fixture', 'demo'] as const)));
  }
  const outbox: SeedOutbox[] = [];
  const outboxCount = Math.floor(rng() * 8);
  for (let i = 0; i < outboxCount; i += 1) {
    const kind = pick(rng, [
      'shot.sync-real',
      'shot.sync-fixture',
      'shot.sync-nosource',
      'shot.sync-malformed',
      'capture.upload',
      'session.finish',
    ] as const);
    outbox.push({
      owner: pick(rng, owners),
      kind: kind.startsWith('shot.sync') ? 'shot.sync' : kind,
      payload:
        kind === 'shot.sync-real'
          ? JSON.stringify({ id: `ob-${seed}-${i}`, source: 'real' })
          : kind === 'shot.sync-fixture'
            ? JSON.stringify({ id: `ob-${seed}-${i}`, source: 'fixture' })
            : kind === 'shot.sync-nosource'
              ? JSON.stringify({ id: `ob-${seed}-${i}` })
              : kind === 'shot.sync-malformed'
                ? rawVariant()
                : JSON.stringify({ kind, i }),
    });
  }
  const captures: SeedCapture[] = [];
  if (shape.capture) {
    const captureCount = Math.floor(rng() * 5);
    for (let i = 0; i < captureCount; i += 1) {
      captures.push({
        owner: pick(rng, owners),
        id: `cap-${seed}-${i}`,
        uri: `file:///captures/${seed}/${i}.mov`,
        status: rng() < 0.5 ? 'awaiting_model' : 'analyzed',
        payload:
          rng() < 0.3
            ? null
            : rng() < 0.3
              ? rawVariant()
              : JSON.stringify({ i }),
        declaredStroke:
          shape.strokeSeed && rng() < 0.5 ? 'forehand_drive' : null,
        targetSeed: shape.strokeSeed && rng() < 0.5 ? `seed-${i}` : null,
      });
    }
  }
  const kv: Record<string, string> = {};
  const kvCount = Math.floor(rng() * KV_KEYS.length);
  for (let i = 0; i < kvCount; i += 1) {
    const key = pick(rng, KV_KEYS);
    kv[key] = rng() < 0.5 ? rawVariant() : JSON.stringify({ key, seed });
  }
  return { shots, sessions, outbox, captures, kv, malformedCount };
}

function seedFile(file: string, schema: SchemaName, pop: Population): void {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const shape = shapeOf(schema);
  if (!shape.hasTables) return;
  const db = new sqlite.DatabaseSync(file);
  try {
    for (const sql of shape.scoped ? V1_DDL : V0_DDL) db.exec(sql);
    if (shape.strokeSeed) {
      db.exec('ALTER TABLE local_capture ADD COLUMN declared_stroke TEXT');
      db.exec('ALTER TABLE local_capture ADD COLUMN target_seed TEXT');
    }
    const kvStmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(pop.kv)) kvStmt.run(k, v);
    for (const s of pop.sessions) {
      if (shape.scoped) {
        db.prepare(
          `INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          s.owner,
          s.id,
          'free',
          null,
          null,
          s.startedAt,
          null,
          s.completed,
          s.summary,
        );
      } else {
        db.prepare(
          `INSERT INTO local_session (id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          s.id,
          'free',
          null,
          null,
          s.startedAt,
          null,
          s.completed,
          s.summary,
        );
      }
    }
    for (const s of pop.shots) {
      if (shape.scoped) {
        db.prepare(
          `INSERT INTO local_shot (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          s.owner,
          s.id,
          s.sessionId,
          'forehand_drive',
          s.capturedAt,
          s.overallScore,
          s.confidence,
          s.resultKind,
          s.source,
          s.favorite,
          s.payload,
        );
      } else {
        db.prepare(
          `INSERT INTO local_shot (id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          s.id,
          s.sessionId,
          'forehand_drive',
          s.capturedAt,
          s.overallScore,
          s.confidence,
          s.resultKind,
          s.source,
          s.favorite,
          s.payload,
        );
      }
    }
    for (const o of pop.outbox) {
      if (shape.scoped) {
        db.prepare(
          'INSERT INTO outbox (owner_key, kind, payload) VALUES (?,?,?)',
        ).run(o.owner, o.kind, o.payload);
      } else {
        db.prepare('INSERT INTO outbox (kind, payload) VALUES (?,?)').run(
          o.kind,
          o.payload,
        );
      }
    }
    for (const c of pop.captures) {
      if (shape.strokeSeed) {
        db.prepare(
          `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload,declared_stroke,target_seed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          c.owner,
          c.id,
          c.uri,
          'forehand_drive',
          isoAt(5000),
          4000,
          30,
          1080,
          1920,
          c.status,
          c.payload,
          c.declaredStroke,
          c.targetSeed,
        );
      } else {
        db.prepare(
          `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          c.owner,
          c.id,
          c.uri,
          'forehand_drive',
          isoAt(5000),
          4000,
          30,
          1080,
          1920,
          c.status,
          c.payload,
        );
      }
    }
  } finally {
    db.close();
  }
}

// ─── Expected post-migration state ───────────────────────────────────────────

interface Expected {
  shots: string[];
  sessions: string[];
  outbox: string[];
  captures: string[];
  kv: string[];
}

function sortedKeys(list: string[]): string[] {
  return [...list].sort();
}

function expectedAfterMigration(pop: Population, shape: SchemaShape): Expected {
  const ownerOf = (owner: string): string =>
    shape.scoped ? owner : GUEST_DATA_OWNER;
  const realShots = pop.shots.filter(s => s.source === 'real');
  const survivingSessionIds = new Set(
    realShots.map(s => s.sessionId).filter((id): id is string => id !== null),
  );
  const sessions = pop.sessions.filter(
    s =>
      survivingSessionIds.has(s.id) ||
      (s.completed === 1 && !(s.summary ?? '').includes('fixture')),
  );
  const outbox = pop.outbox.filter(o => {
    if (o.kind !== 'shot.sync') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(o.payload);
    } catch {
      return true; // not JSON → json_valid() = 0 → kept for row-level handling
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return true; // json_extract('$.source') → NULL → predicate NULL → kept
    }
    const source = (parsed as Record<string, unknown>)['source'];
    if (source === undefined || source === null) return true;
    return String(source) === 'real';
  });
  return {
    shots: sortedKeys(
      realShots.map(
        s =>
          `${ownerOf(s.owner)}|${s.id}|${s.payload}|${s.favorite}|${s.overallScore}`,
      ),
    ),
    sessions: sortedKeys(
      sessions.map(
        s => `${ownerOf(s.owner)}|${s.id}|${s.completed}|${s.summary}`,
      ),
    ),
    outbox: sortedKeys(
      outbox.map(o => `${ownerOf(o.owner)}|${o.kind}|${o.payload}`),
    ),
    captures: sortedKeys(
      pop.captures.map(
        c =>
          `${c.owner}|${c.id}|${c.uri}|${c.status}|${c.payload}|${c.declaredStroke}|${c.targetSeed}|not_asked`,
      ),
    ),
    kv: sortedKeys(Object.entries(pop.kv).map(([k, v]) => `${k}|${v}`)),
  };
}

const CURRENT_TABLES = [
  'kv',
  'local_shot',
  'local_session',
  'local_capture',
  'outbox',
  'sync_receipt',
  'local_analysis_record',
];
const CURRENT_INDEXES = [
  'idx_local_shot_owner_time',
  'idx_local_capture_owner_time',
  'idx_outbox_owner_created',
  'idx_local_analysis_capture',
];

interface FileState {
  tables: string[];
  indexes: string[];
  tempTables: string[];
  integrity: string;
  realShotKeys: string[] | null;
  realShotIdCount: number | null;
  schemaCurrent: boolean;
  columns: Record<string, string[]>;
}

/** Inspect the on-disk file through an independent connection. */
function inspectFile(file: string): FileState | { unreadable: string } {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  let db: StressDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const master = db
      .prepare(`SELECT type, name FROM sqlite_master ORDER BY name`)
      .all() as { type: string; name: string }[];
    const tables = master.filter(r => r.type === 'table').map(r => r.name);
    const indexes = master.filter(r => r.type === 'index').map(r => r.name);
    const tempTables = tables.filter(t => t.endsWith('_account_v2'));
    const integrity = String(
      (db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[
        'integrity_check'
      ],
    );
    const columns: Record<string, string[]> = {};
    for (const t of tables) {
      columns[t] = (
        db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]
      ).map(r => r.name);
    }
    let realShotKeys: string[] | null = null;
    let realShotIdCount: number | null = null;
    if (tables.includes('local_shot')) {
      const hasOwner = (columns['local_shot'] ?? []).includes('owner_key');
      const rows = db
        .prepare(
          `SELECT ${hasOwner ? 'owner_key' : `'${GUEST_DATA_OWNER}'`} AS owner_key, id, payload, favorite, overall_score
             FROM local_shot WHERE source = 'real'`,
        )
        .all() as Record<string, unknown>[];
      realShotKeys = sortedKeys(
        rows.map(
          r =>
            `${r['owner_key']}|${r['id']}|${r['payload']}|${r['favorite']}|${r['overall_score']}`,
        ),
      );
      realShotIdCount = rows.length;
    }
    const schemaCurrent =
      CURRENT_TABLES.every(t => tables.includes(t)) &&
      CURRENT_INDEXES.every(i => indexes.includes(i)) &&
      tempTables.length === 0 &&
      ['owner_key', 'id'].every(c =>
        (columns['local_shot'] ?? []).includes(c),
      ) &&
      ['owner_key', 'id'].every(c =>
        (columns['local_session'] ?? []).includes(c),
      ) &&
      [
        'owner_key',
        'payload',
        'declared_stroke',
        'target_seed',
        'training_consent',
      ].every(c => (columns['local_capture'] ?? []).includes(c)) &&
      (columns['outbox'] ?? []).includes('owner_key');
    return {
      tables,
      indexes,
      tempTables,
      integrity,
      realShotKeys,
      realShotIdCount,
      schemaCurrent,
      columns,
    };
  } catch (error) {
    return { unreadable: errorText(error) };
  } finally {
    db?.close();
  }
}

/**
 * `node:sqlite` errors are created in Node's realm, so `instanceof Error` is
 * false inside the Jest vm context — duck-type instead.
 */
function isErrorLike(
  error: unknown,
): error is { name?: unknown; message: string } {
  if (error instanceof Error) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { stack?: unknown }).stack === 'string'
  );
}

function errorMessage(error: unknown): string {
  return isErrorLike(error) ? error.message : '';
}

function errorText(error: unknown): string {
  if (isErrorLike(error)) {
    const code = (error as { code?: unknown }).code;
    return `${String(error.name ?? 'Error')}: ${error.message}${typeof code === 'string' ? ` [${code}]` : ''}`;
  }
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  if (typeof error === 'string') return `string: ${error}`;
  try {
    return `${typeof error}: ${JSON.stringify(error)}`;
  } catch {
    return typeof error;
  }
}

async function readAll(
  db: LocalDb,
  sql: string,
): Promise<Record<string, unknown>[]> {
  return (await db.execute(sql)).rows;
}

async function verifyRecovered(
  db: LocalDb,
  expected: Expected,
  file: string,
): Promise<{
  invariants: Record<string, boolean>;
  observed: Record<string, unknown>;
}> {
  const state = inspectFile(file);
  const observed: Record<string, unknown> = {};
  const invariants: Record<string, boolean> = {};
  if ('unreadable' in state) {
    observed['fileUnreadable'] = state.unreadable;
    return {
      invariants: { schemaCurrent: false, integrityOk: false },
      observed,
    };
  }
  invariants['schemaCurrent'] = state.schemaCurrent;
  invariants['integrityOk'] = state.integrity === 'ok';
  invariants['noTempTables'] = state.tempTables.length === 0;
  observed['integrity'] = state.integrity;

  const shots = (
    await readAll(
      db,
      `SELECT owner_key, id, payload, favorite, overall_score FROM local_shot WHERE source = 'real'`,
    )
  ).map(
    r =>
      `${r['owner_key']}|${r['id']}|${r['payload']}|${r['favorite']}|${r['overall_score']}`,
  );
  const fixtures = await readAll(
    db,
    `SELECT count(*) AS n FROM local_shot WHERE source <> 'real'`,
  );
  const sessions = (
    await readAll(
      db,
      `SELECT owner_key, id, completed, summary FROM local_session`,
    )
  ).map(r => `${r['owner_key']}|${r['id']}|${r['completed']}|${r['summary']}`);
  const outbox = (
    await readAll(db, `SELECT owner_key, kind, payload FROM outbox`)
  ).map(r => `${r['owner_key']}|${r['kind']}|${r['payload']}`);
  const captures = (
    await readAll(
      db,
      `SELECT owner_key, id, uri, status, payload, declared_stroke, target_seed, training_consent FROM local_capture`,
    )
  ).map(
    r =>
      `${r['owner_key']}|${r['id']}|${r['uri']}|${r['status']}|${r['payload']}|${r['declared_stroke']}|${r['target_seed']}|${r['training_consent']}`,
  );
  const kv = (await readAll(db, `SELECT key, value FROM kv`)).map(
    r => `${r['key']}|${r['value']}`,
  );
  const fixtureOutbox = await readAll(
    db,
    `SELECT count(*) AS n FROM outbox WHERE kind='shot.sync' AND json_valid(payload) AND json_extract(payload,'$.source') <> 'real'`,
  );

  const same = (a: string[], b: string[]): boolean =>
    a.length === b.length && sortedKeys(a).every((v, i) => v === b[i]);
  invariants['realShotsPreserved'] = same(shots, expected.shots);
  invariants['fixturesPurged'] =
    Number(fixtures[0]?.['n']) === 0 && Number(fixtureOutbox[0]?.['n']) === 0;
  invariants['sessionsPreserved'] = same(sessions, expected.sessions);
  invariants['outboxPreserved'] = same(outbox, expected.outbox);
  invariants['capturesPreserved'] = same(captures, expected.captures);
  invariants['kvPreserved'] = same(kv, expected.kv);
  observed['counts'] = {
    shots: shots.length,
    sessions: sessions.length,
    outbox: outbox.length,
    captures: captures.length,
    kv: kv.length,
  };
  if (!invariants['realShotsPreserved']) {
    observed['shotsDiff'] = {
      missing: expected.shots.filter(k => !shots.includes(k)).slice(0, 5),
      unexpected: shots.filter(k => !expected.shots.includes(k)).slice(0, 5),
    };
  }
  if (!invariants['capturesPreserved']) {
    observed['capturesDiff'] = {
      missing: expected.captures.filter(k => !captures.includes(k)).slice(0, 5),
      unexpected: captures
        .filter(k => !expected.captures.includes(k))
        .slice(0, 5),
    };
  }
  if (!invariants['sessionsPreserved']) {
    observed['sessionsDiff'] = {
      missing: expected.sessions.filter(k => !sessions.includes(k)).slice(0, 5),
      unexpected: sessions
        .filter(k => !expected.sessions.includes(k))
        .slice(0, 5),
    };
  }
  if (!invariants['outboxPreserved']) {
    observed['outboxDiff'] = {
      missing: expected.outbox.filter(k => !outbox.includes(k)).slice(0, 5),
      unexpected: outbox.filter(k => !expected.outbox.includes(k)).slice(0, 5),
    };
  }
  return { invariants, observed };
}

// ─── Scenario plan from a seed ───────────────────────────────────────────────

interface Scenario {
  seed: number;
  schema: SchemaName;
  fault: FaultPlan;
}

const FAMILY_WEIGHTS: readonly [FaultPlan['family'], number][] = [
  ['stmt-throw', 30],
  ['stmt-malformed', 16],
  ['open', 8],
  ['close', 8],
  ['async', 10],
  ['disk', 18],
  ['wrapper', 6],
  ['none', 4],
];

function planFromSeed(seed: number): Scenario {
  const rng = makePrng(seed);
  const schema = pick(rng, SCHEMAS);
  const roll = rng() * FAMILY_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  let family: FaultPlan['family'] = 'none';
  for (const [f, w] of FAMILY_WEIGHTS) {
    acc += w;
    if (roll < acc) {
      family = f;
      break;
    }
  }
  const fault: FaultPlan = (() => {
    switch (family) {
      case 'stmt-throw':
        return {
          family,
          shape: pick(rng, ERROR_SHAPES),
          anchor: pick(rng, STATEMENT_ANCHORS),
          phase: rng() < 0.7 ? ('pre' as const) : ('post' as const),
          mode: pick(rng, FAULT_MODES),
          seededIndex: Math.floor(rng() * 64),
        };
      case 'stmt-malformed':
        return {
          family,
          shape: pick(rng, MALFORMED_SHAPES),
          pragmaIndex: Math.floor(rng() * 12),
          mode: pick(rng, FAULT_MODES),
        };
      case 'open':
        return {
          family,
          kind: pick(rng, OPEN_FAULTS),
          mode: pick(rng, FAULT_MODES),
        };
      case 'close':
        return {
          family,
          kind: pick(rng, CLOSE_FAULTS),
          when: pick(rng, CLOSE_WHEN),
          withMigrationFault: rng() < 0.5,
        };
      case 'async':
        return {
          family,
          kind: pick(rng, ASYNC_FAULTS),
          mode: pick(rng, FAULT_MODES),
        };
      case 'disk':
        return {
          family,
          kind: pick(rng, DISK_FAULTS),
          seededOffset: Math.floor(rng() * 4096),
        };
      case 'wrapper':
        return { family, kind: pick(rng, WRAPPER_SCENARIOS) };
      case 'none':
        return { family };
    }
  })();
  return { seed, schema, fault };
}

// ─── Scenario execution ──────────────────────────────────────────────────────

interface Row {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  /** HELD, BROKEN:<known defect id>, or BROKEN:unclassified. */
  classification: string;
  durationMs: number;
}

/**
 * Reproduced db.ts defects. Each one is pinned by a `test.failing` case below
 * (the suite stays green while the defect exists; once db.ts is fixed the
 * pin turns red so the entry — and the pin — get removed). Any failing row
 * that matches none of these is `BROKEN:unclassified` and fails the campaign.
 */
interface KnownDefect {
  id: string;
  /** Deterministic repro (seed range 0x7e000000+, replayable via STRESS_SEEDS). */
  pin: Scenario;
  matches(row: Row): boolean;
}

const PIN_SEED_BASE = 0x7e000000;

const KNOWN_DEFECTS: KnownDefect[] = [
  {
    // ensureAccountScopedSchema rebuilds local_capture through
    // local_capture_account_v2, whose column list stops at `payload`. When
    // PRAGMA table_info(local_capture) yields rows the pk/name filter cannot
    // read, hasAccountPrimaryKey() is false, the rebuild runs on an already
    // current table and declared_stroke / target_seed / training_consent are
    // written back as NULL / 'not_asked'. COMMIT succeeds: silent data loss.
    id: 'capture-rebuild-drops-late-columns',
    pin: {
      seed: PIN_SEED_BASE + 4,
      schema: 'v2-current',
      // pragma #2 = PRAGMA table_info(local_capture) inside hasAccountPrimaryKey.
      fault: {
        family: 'stmt-malformed',
        shape: 'rows-empty',
        pragmaIndex: 2,
        mode: 'once',
      },
    },
    matches: row => {
      const fault = String(row.inputs['fault']);
      if (!fault.startsWith('stmt-malformed/')) return false;
      if (
        !row.failed.every(
          f => f === 'capturesPreserved' || f === 'reopenPreservesRows',
        )
      ) {
        return false;
      }
      const diff = row.observed['capturesDiff'] as
        { unexpected?: string[] } | undefined;
      const unexpected = diff?.unexpected ?? [];
      return (
        unexpected.length > 0 &&
        unexpected.every(k => {
          const parts = k.split('|');
          return (
            parts[5] === 'null' &&
            parts[6] === 'null' &&
            parts[7] === 'not_asked'
          );
        })
      );
    },
  },
  {
    // LocalDb.close() runs `db.close(); instance = null;` — if the native close
    // throws, the module keeps the (already invalidated) handle cached, every
    // later getDb() hands out wrappers on a closed database and nothing short
    // of an app restart reopens it.
    id: 'close-throw-strands-dead-singleton',
    pin: {
      seed: PIN_SEED_BASE + 1,
      schema: 'v2-current',
      fault: {
        family: 'close',
        kind: 'throw-after-native-close',
        when: 'wrapper-close',
        withMigrationFault: false,
      },
    },
    matches: row => {
      const fault = String(row.inputs['fault']);
      return (
        fault.startsWith('close/throw-after-native-close/wrapper-close') &&
        row.failed.length === 1 &&
        row.failed[0] === 'noDeadHandleCachedAfterCloseFault' &&
        row.observed['nativeClosedAfterCloseFault'] === true
      );
    },
  },
];

function classify(row: Omit<Row, 'classification'>): string {
  if (row.ok) return 'HELD';
  const full = { ...row, classification: '' };
  const known = KNOWN_DEFECTS.find(d => d.matches(full));
  return known ? `BROKEN:${known.id}` : 'BROKEN:unclassified';
}

let scenarioCounter = 0;

function scenarioDir(seed: number): string {
  const base = path.join(
    os.tmpdir(),
    `stress-mod-db-${nodeProcess.env['STRESS_RUN_TAG'] ?? 'run'}`,
  );
  const dir = path.join(base, `${seed}-${scenarioCounter}`);
  scenarioCounter += 1;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, DB_FILE);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  } catch {
    // best effort
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Fault-free open on a private copy: statement list for anchor resolution. */
function probeStatements(file: string, dir: string): string[] {
  const probeDir = path.join(dir, 'probe');
  fs.mkdirSync(probeDir, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(probeDir, DB_FILE));
  const saved = {
    dir: harness.dir,
    statements: harness.statements,
    opens: harness.opens,
    handles: harness.handles,
    pragmaCalls: harness.pragmaCalls,
    disarmed: harness.disarmed,
  };
  harness.dir = probeDir;
  harness.statements = [];
  harness.handles = [];
  harness.disarmed = true;
  try {
    const getDb = loadGetDb();
    const db = getDb();
    db.close();
    return harness.statements;
  } finally {
    harness.dir = saved.dir;
    harness.statements = saved.statements;
    harness.opens = saved.opens;
    harness.handles = saved.handles;
    harness.pragmaCalls = saved.pragmaCalls;
    harness.disarmed = saved.disarmed;
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

/** Bring a v1b file to the current schema with a fault-free open (v2-current). */
function preMigrate(): void {
  harness.disarmed = true;
  const getDb = loadGetDb();
  getDb().close();
  harness.statements = [];
  harness.handles = [];
  harness.opens = 0;
  harness.pragmaCalls = 0;
}

function corruptBytes(file: string, offset: number, bytes: Uint8Array): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, offset);
  } finally {
    fs.closeSync(fd);
  }
}

interface DiskHold {
  release(): void;
}

function armDisk(
  kind: DiskFault,
  file: string,
  dir: string,
  seededOffset: number,
  rng: () => number,
): DiskHold {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const noop: DiskHold = { release: () => undefined };
  const ensureFile = (): void => {
    if (!fs.existsSync(file)) {
      const d = new sqlite.DatabaseSync(file);
      d.exec('PRAGMA user_version = 0');
      d.close();
    }
  };
  switch (kind) {
    case 'lock-reader': {
      ensureFile();
      const other = new sqlite.DatabaseSync(file);
      const it = other
        .prepare(
          'SELECT name FROM sqlite_master UNION ALL SELECT name FROM sqlite_master',
        )
        .iterate();
      it.next();
      return {
        release: () => {
          it.return();
          other.close();
        },
      };
    }
    case 'lock-writer': {
      ensureFile();
      const other = new sqlite.DatabaseSync(file);
      other.exec('BEGIN IMMEDIATE');
      return {
        release: () => {
          other.exec('ROLLBACK');
          other.close();
        },
      };
    }
    case 'lock-exclusive': {
      ensureFile();
      const other = new sqlite.DatabaseSync(file);
      other.exec('BEGIN EXCLUSIVE');
      return {
        release: () => {
          other.exec('ROLLBACK');
          other.close();
        },
      };
    }
    case 'disk-full':
      harness.diskFull = true;
      return {
        release: () => {
          harness.diskFull = false;
        },
      };
    case 'readonly-file':
      ensureFile();
      fs.chmodSync(file, 0o444);
      return { release: () => fs.chmodSync(file, 0o644) };
    case 'readonly-dir':
      fs.chmodSync(dir, 0o555);
      return { release: () => fs.chmodSync(dir, 0o755) };
    case 'corrupt-header': {
      ensureFile();
      const junk = new Uint8Array(16);
      for (let i = 0; i < junk.length; i += 1)
        junk[i] = Math.floor(rng() * 256);
      corruptBytes(file, 0, junk);
      return noop;
    }
    case 'corrupt-page': {
      ensureFile();
      const size = fs.statSync(file).size;
      const junk = new Uint8Array(64);
      for (let i = 0; i < junk.length; i += 1)
        junk[i] = Math.floor(rng() * 256);
      const offset = size <= 128 ? 100 : 100 + (seededOffset % (size - 164));
      corruptBytes(file, offset, junk);
      return noop;
    }
    case 'truncate': {
      ensureFile();
      const size = fs.statSync(file).size;
      fs.truncateSync(
        file,
        Math.max(1, Math.floor((size * ((seededOffset % 90) + 5)) / 100)),
      );
      return noop;
    }
    case 'garbage-journal': {
      ensureFile();
      const junk = new Uint8Array(512 + (seededOffset % 512));
      for (let i = 0; i < junk.length; i += 1)
        junk[i] = Math.floor(rng() * 256);
      fs.writeFileSync(`${file}-journal`, junk);
      return { release: () => fs.rmSync(`${file}-journal`, { force: true }) };
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function faultLabel(fault: FaultPlan): string {
  switch (fault.family) {
    case 'none':
      return 'none';
    case 'stmt-throw':
      return `stmt-throw/${fault.shape}/${fault.anchor}/${fault.phase}/${fault.mode}`;
    case 'stmt-malformed':
      return `stmt-malformed/${fault.shape}/pragma${fault.pragmaIndex}/${fault.mode}`;
    case 'open':
      return `open/${fault.kind}/${fault.mode}`;
    case 'close':
      return `close/${fault.kind}/${fault.when}${fault.withMigrationFault ? '+migration-fault' : ''}`;
    case 'async':
      return `async/${fault.kind}/${fault.mode}`;
    case 'disk':
      return `disk/${fault.kind}`;
    case 'wrapper':
      return `wrapper/${fault.kind}`;
  }
}

async function runScenario(plan: Scenario): Promise<Row> {
  const started = Date.now();
  const { seed, schema, fault } = plan;
  const shape = shapeOf(schema);
  const pop = population(seed, shape);
  const expected = expectedAfterMigration(pop, shape);
  const dir = scenarioDir(seed);
  const file = path.join(dir, DB_FILE);
  resetHarness(dir);
  const observed: Record<string, unknown> = {};
  const invariants: Record<string, boolean> = {};
  const inputs: Record<string, unknown> = {
    schema,
    fault: faultLabel(fault),
    faultPlan: fault,
    population: {
      shots: pop.shots.length,
      realShots: pop.shots.filter(s => s.source === 'real').length,
      sessions: pop.sessions.length,
      outbox: pop.outbox.length,
      captures: pop.captures.length,
      kv: Object.keys(pop.kv).length,
      malformedStrings: pop.malformedCount,
    },
  };
  releaseSlot.fn = null;
  try {
    seedFile(file, schema === 'v2-current' ? 'v1b-b2731c9' : schema, pop);
    if (schema === 'v2-current') preMigrate();

    switch (fault.family) {
      case 'none':
      case 'stmt-throw':
      case 'stmt-malformed':
      case 'open':
      case 'disk':
      case 'close':
        await runOpenPhaseScenario(
          plan,
          dir,
          file,
          expected,
          observed,
          invariants,
        );
        break;
      case 'async':
        await runAsyncScenario(plan, file, expected, observed, invariants);
        break;
      case 'wrapper':
        await runWrapperScenario(plan, file, expected, observed, invariants);
        break;
    }
  } catch (error) {
    observed['harnessError'] = errorText(error);
    invariants['harnessCompleted'] = false;
  } finally {
    try {
      releaseDiskHold();
    } catch (error) {
      observed['releaseError'] = errorText(error);
    }
    jest.useRealTimers();
    for (const handle of harness.handles) {
      if (handle.inner) {
        try {
          handle.inner.close();
        } catch {
          // already closed
        }
      }
    }
    cleanupDir(dir);
  }
  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  observed['fired'] = harness.firedCount;
  observed['firedAt'] = harness.firedAt.slice(0, 6);
  observed['opens'] = harness.opens;
  const row = {
    suite: SUITE,
    scenario: `${schema}/${faultLabel(fault)}`,
    seed,
    inputs,
    observed,
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - started,
  };
  return { ...row, classification: classify(row) };
}

function isInjected(error: unknown): boolean {
  return harness.lastInjected.some(i => i === error);
}

async function runOpenPhaseScenario(
  plan: Scenario,
  dir: string,
  file: string,
  expected: Expected,
  observed: Record<string, unknown>,
  invariants: Record<string, boolean>,
): Promise<void> {
  const { seed, fault } = plan;
  const rng = makePrng(seed ^ 0xd15c);
  const before = inspectFile(file);
  observed['beforeTables'] =
    'unreadable' in before ? before.unreadable : before.tables;

  // Anchor resolution against a fault-free probe run.
  if (fault.family === 'stmt-throw') {
    const probe = probeStatements(file, dir);
    resolvedStatementIndex = anchorIndex(
      fault.anchor,
      probe,
      fault.seededIndex,
    );
    observed['probeStatements'] = probe.length;
    observed['resolvedStatementIndex'] = resolvedStatementIndex;
    observed['resolvedStatement'] =
      resolvedStatementIndex >= 0
        ? probe[resolvedStatementIndex]?.slice(0, 60)
        : null;
  } else {
    resolvedStatementIndex = -1;
  }
  stmtHits = 0;
  pragmaHits = 0;
  asyncHits = 0;

  let migrationFaultForClose = false;
  if (
    fault.family === 'close' &&
    fault.withMigrationFault &&
    fault.when === 'migration-failure'
  ) {
    // Drive the migration into its failure path so the close runs there.
    const probe = probeStatements(file, dir);
    resolvedStatementIndex = anchorIndex('commit', probe, 0);
    migrationFaultForClose = true;
  }
  harness.fault = fault;
  harness.disarmed = false;
  harness.closeFault = fault.family === 'close' ? fault : null;
  harness.closeFaultArmed =
    fault.family === 'close' && fault.when === 'migration-failure';
  if (fault.family === 'disk') {
    releaseSlot.fn = armDisk(
      fault.kind,
      file,
      dir,
      fault.seededOffset,
      rng,
    ).release;
  }

  const getDb = loadGetDb();

  // ── attempt 1 (fault armed) ──
  let threw = false;
  let caught: unknown = undefined;
  let db: LocalDb | null = null;
  const opensBefore = harness.opens;
  try {
    if (migrationFaultForClose) {
      // Combine: statement fault at COMMIT (pre) AND a close fault (own slot).
      harness.fault = {
        family: 'stmt-throw',
        shape: 'ioerr',
        anchor: 'commit',
        phase: 'pre',
        mode: 'once',
        seededIndex: 0,
      };
      try {
        db = getDb();
      } finally {
        harness.fault = fault;
      }
    } else {
      db = getDb();
    }
  } catch (error) {
    threw = true;
    caught = error;
  }
  observed['attempt1'] = threw ? `threw: ${errorText(caught)}` : 'opened';
  observed['attempt1Opens'] = harness.opens - opensBefore;
  const fired = harness.firedCount > 0;
  observed['faultFired'] = fired;

  const expectFailure =
    fault.family === 'disk'
      ? null // real faults: outcome is whatever SQLite does; invariants are conditional
      : fired;

  if (threw) {
    // The error must be the injected one (never masked by ROLLBACK / close errors).
    if (fault.family === 'stmt-throw') {
      invariants['errorSurfacedUnmasked'] = isInjected(caught);
    } else if (fault.family === 'open') {
      // throw-*: the injected value itself. return-null/undefined/{}: db.ts
      // trips over the junk handle — a TypeError is the honest surface, as long
      // as the swallowed close() TypeError did not replace it.
      invariants['errorSurfacedUnmasked'] = fault.kind.startsWith('return-')
        ? isInjected(caught) ||
          /executeSync|Cannot read propert|is not a function|null|undefined/.test(
            errorText(caught),
          )
        : isInjected(caught);
    } else if (fault.family === 'stmt-malformed') {
      invariants['errorSurfacedUnmasked'] =
        isErrorLike(caught) &&
        !/ROLLBACK|cannot rollback/i.test(caught.message);
    } else if (fault.family === 'disk') {
      invariants['errorSurfacedUnmasked'] = errorMessage(caught).length > 0;
    } else if (fault.family === 'close') {
      // db.ts swallows the close error and rethrows the migration error.
      invariants['errorSurfacedUnmasked'] = migrationFaultForClose
        ? /injected:stmt#/.test(errorMessage(caught))
        : true;
      if (migrationFaultForClose) {
        invariants['closeFaultReached'] = harness.firedAt.some(w =>
          w.startsWith('close:'),
        );
      }
    }
    // Handle released (or at least attempted) — no leaked native handle.
    const created = harness.handles[0];
    const handleHasNoClose =
      fault.family === 'open' && fault.kind === 'return-no-close';
    if (created) {
      observed['nativeHandleLeaked'] = !created.nativeClosed;
      if (!handleHasNoClose) {
        invariants['handleReleasedOnFailure'] = created.closeCalls >= 1;
        if (fault.family !== 'close') {
          invariants['nativeHandleClosedOnFailure'] = created.nativeClosed;
        }
      }
    }
    // No half-applied migration on disk.
    const after = inspectFile(file);
    if ('unreadable' in after) {
      observed['afterFailureFile'] = after.unreadable;
      // A file that never existed (fresh schema, open faulted) is not a partial
      // commit; a previously readable file that is now unreadable is.
      if (fault.family !== 'disk')
        invariants['noPartialCommit'] = 'unreadable' in before;
    } else {
      observed['afterFailureTables'] = after.tables;
      const beforeShots = 'unreadable' in before ? null : before.realShotKeys;
      const shotsIntact =
        beforeShots === null ||
        after.realShotIdCount === null ||
        after.realShotIdCount === beforeShots.length ||
        // Full migration may already be on disk if the fault fired post-COMMIT.
        after.schemaCurrent;
      invariants['noPartialCommit'] =
        after.tempTables.length === 0 &&
        shotsIntact &&
        (!('unreadable' in before)
          ? before.tables.every(
              t => after.tables.includes(t) || after.schemaCurrent,
            )
          : true);
      observed['integrityAfterFailure'] = after.integrity;
    }
  } else if (expectFailure === true) {
    // The fault fired but open() did not throw: only acceptable when the
    // resulting state is fully correct (fault absorbed, not faked).
    observed['faultAbsorbed'] = true;
  } else if (fault.family === 'close' && fault.when === 'wrapper-close' && db) {
    // Attempt 1 succeeded by design; the fault is on the wrapper's close().
    harness.closeFaultArmed = true;
    let closeThrew = false;
    try {
      db.close();
    } catch (error) {
      closeThrew = true;
      observed['wrapperCloseError'] = errorText(error);
    }
    harness.closeFaultArmed = false;
    invariants['closeErrorSurfaced'] = closeThrew;
    const h = harness.handles[0];
    observed['nativeClosedAfterCloseFault'] = h ? h.nativeClosed : null;
    // The singleton must not keep a dead handle: a fresh getDb() must either
    // reuse a still-live native handle or reopen.
    const opensBeforeRetry = harness.opens;
    const retry = getDb();
    let retryUsable = true;
    try {
      await retry.execute('SELECT count(*) AS n FROM kv');
    } catch (error) {
      retryUsable = false;
      observed['retryAfterCloseFault'] = errorText(error);
    }
    observed['reopenedAfterCloseFault'] = harness.opens > opensBeforeRetry;
    invariants['noDeadHandleCachedAfterCloseFault'] = retryUsable;
    if (retryUsable) {
      const verified = await verifyRecovered(retry, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      retry.close();
    } else {
      // Recover the way an app restart would: fresh module instance.
      const fresh = loadGetDb()();
      const verified = await verifyRecovered(fresh, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      fresh.close();
    }
    return;
  }

  // ── clear the fault, attempt 2 ──
  harness.disarmed = true;
  harness.closeFaultArmed = false;
  const unrecoverable =
    fault.family === 'disk' && UNRECOVERABLE_DISK.has(fault.kind);
  const opensBeforeRetry = harness.opens;
  let retryThrew = false;
  let retryError: unknown;
  let recovered: LocalDb | null = null;
  if (threw || !db) {
    // Lock released / chmod restored / journal removed / disk space back.
    releaseDiskHold();
    try {
      recovered = getDb();
    } catch (error) {
      retryThrew = true;
      retryError = error;
    }
    observed['attempt2'] = retryThrew
      ? `threw: ${errorText(retryError)}`
      : 'opened';
    invariants['noDeadHandleCached'] = harness.opens > opensBeforeRetry;
    if (unrecoverable) {
      // Deterministic: same outcome class on retry; never a fake success.
      invariants['retryDeterministic'] = retryThrew === threw;
      if (!retryThrew && recovered) {
        const state = inspectFile(file);
        const integrity =
          'unreadable' in state ? state.unreadable : state.integrity;
        observed['integrityAfterCorruption'] = integrity;
        observed['openedDespiteCorruption'] = true;
        recovered.close();
      }
      return;
    }
    invariants['recoveredAfterFaultCleared'] = !retryThrew;
    if (retryThrew || !recovered) return;
  } else {
    recovered = db;
  }

  const verified = await verifyRecovered(recovered, expected, file);
  Object.assign(invariants, verified.invariants);
  Object.assign(observed, verified.observed);

  // Idempotent reopen.
  recovered.close();
  const statementsBefore = harness.statements.length;
  const again = getDb();
  const again2 = getDb();
  invariants['cachedHandleReused'] =
    again2 !== null &&
    harness.opens === opensBeforeRetry + (threw || !db ? 2 : 1);
  const tables = await readAll(
    again,
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  );
  invariants['reopenIdempotent'] =
    harness.statements.length > statementsBefore && tables.length > 0;
  const verifiedAgain = await verifyRecovered(again, expected, file);
  invariants['reopenPreservesRows'] = Object.values(
    verifiedAgain.invariants,
  ).every(Boolean);
  again.close();
}

/** Disk holds are released mid-scenario (before the retry) through this slot. */
const releaseSlot: { fn: (() => void) | null } = { fn: null };

function releaseDiskHold(): void {
  const fn = releaseSlot.fn;
  releaseSlot.fn = null;
  if (fn) fn();
}

async function runAsyncScenario(
  plan: Scenario,
  file: string,
  expected: Expected,
  observed: Record<string, unknown>,
  invariants: Record<string, boolean>,
): Promise<void> {
  const { fault } = plan;
  if (fault.family !== 'async') return;
  harness.disarmed = true;
  const getDb = loadGetDb();
  const db = getDb();
  jest.useFakeTimers({
    doNotFake: [
      'Date',
      'hrtime',
      'performance',
      'nextTick',
      'queueMicrotask',
      'setImmediate',
    ],
  });
  harness.fault = fault;
  harness.asyncArmed = true;
  asyncHits = 0;

  const sql = `SELECT count(*) AS n FROM local_shot WHERE source = 'real'`;
  const outcome: {
    settled: 'pending' | 'resolved' | 'rejected';
    value: unknown;
    reason: unknown;
  } = {
    settled: 'pending',
    value: undefined,
    reason: undefined,
  };
  let syncThrow: unknown = undefined;
  try {
    void db.execute(sql).then(
      v => {
        outcome.settled = 'resolved';
        outcome.value = v;
      },
      r => {
        outcome.settled = 'rejected';
        outcome.reason = r;
      },
    );
  } catch (error) {
    syncThrow = error;
  }
  await flushMicrotasks();
  observed['settledBeforeTimers'] = outcome.settled;
  jest.advanceTimersByTime(60_000);
  await flushMicrotasks();
  observed['settledAfter60s'] = outcome.settled;
  invariants['noSyncThrowFromAsyncWrapper'] = syncThrow === undefined;
  const { settled, value, reason } = outcome;

  switch (fault.kind) {
    case 'reject':
    case 'throw-sync':
      invariants['rejectionSurfaced'] =
        settled === 'rejected' && isInjected(reason);
      break;
    case 'undefined-result':
    case 'null-result':
      // `result.rows` on undefined/null → TypeError → rejection, never {rows: []}.
      invariants['noFakeSuccessOnMalformedResult'] = settled === 'rejected';
      observed['rejection'] = errorText(reason);
      break;
    case 'rows-null':
    case 'rows-undefined':
      // db.ts coerces a missing rows array to [] (op-sqlite types rows optional).
      invariants['coercedToEmptyRows'] =
        settled === 'resolved' &&
        Array.isArray((value as { rows: unknown }).rows) &&
        (value as { rows: unknown[] }).rows.length === 0;
      break;
    case 'rows-string':
      observed['rowsPassthrough'] =
        settled === 'resolved'
          ? typeof (value as { rows: unknown }).rows
          : settled;
      // Passes the driver's value through untouched — recorded, not asserted.
      break;
    case 'slow-5s':
      invariants['slowSettlesWithin60s'] = settled === 'resolved';
      break;
    case 'never-resolves':
      observed['pendingAfter60s'] = settled === 'pending';
      break;
  }

  // Recovery: clear the fault; the cached handle must still serve queries.
  harness.asyncArmed = false;
  jest.useRealTimers();
  let recoveredValue: Record<string, unknown>[] | null = null;
  try {
    recoveredValue = (await db.execute(sql)).rows;
  } catch (error) {
    observed['recoveryError'] = errorText(error);
  }
  invariants['handleUsableAfterFaultCleared'] =
    recoveredValue !== null &&
    Number(recoveredValue[0]?.['n']) === expected.shots.length;
  invariants['noReopenNeeded'] = harness.opens === 1;
  const verified = await verifyRecovered(db, expected, file);
  Object.assign(invariants, verified.invariants);
  Object.assign(observed, verified.observed);
  db.close();
}

async function runWrapperScenario(
  plan: Scenario,
  file: string,
  expected: Expected,
  observed: Record<string, unknown>,
  invariants: Record<string, boolean>,
): Promise<void> {
  const { fault } = plan;
  if (fault.family !== 'wrapper') return;
  harness.disarmed = true;
  const getDb = loadGetDb();
  const probeSql = `SELECT count(*) AS n FROM kv`;
  switch (fault.kind) {
    case 'stale-wrapper-after-close': {
      const h1 = getDb();
      h1.close();
      let staleRejected = false;
      try {
        await h1.execute(probeSql);
      } catch (error) {
        staleRejected = true;
        observed['staleError'] = errorText(error);
      }
      invariants['staleWrapperRejects'] = staleRejected;
      const h2 = getDb();
      invariants['reopenedAfterClose'] = harness.opens === 2;
      const verified = await verifyRecovered(h2, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      h2.close();
      return;
    }
    case 'double-close': {
      const h1 = getDb();
      h1.close();
      let secondCloseThrew = false;
      try {
        h1.close();
      } catch (error) {
        secondCloseThrew = true;
        observed['secondCloseError'] = errorText(error);
      }
      observed['secondCloseThrew'] = secondCloseThrew;
      const h2 = getDb();
      invariants['reopenedAfterDoubleClose'] = harness.opens === 2;
      let usable = true;
      try {
        await h2.execute(probeSql);
      } catch (error) {
        usable = false;
        observed['afterDoubleCloseError'] = errorText(error);
      }
      invariants['usableAfterDoubleClose'] = usable;
      const verified = await verifyRecovered(h2, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      h2.close();
      return;
    }
    case 'two-wrappers-one-closed': {
      const h1 = getDb();
      const h2 = getDb();
      invariants['singleOpenForTwoWrappers'] = harness.opens === 1;
      h1.close();
      let h2Rejected = false;
      try {
        await h2.execute(probeSql);
      } catch (error) {
        h2Rejected = true;
        observed['h2Error'] = errorText(error);
      }
      // Both wrappers share one native handle; the survivor must not fake success.
      invariants['siblingWrapperRejectsAfterClose'] = h2Rejected;
      const h3 = getDb();
      invariants['reopenedForNewWrapper'] = harness.opens === 2;
      const verified = await verifyRecovered(h3, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      h3.close();
      return;
    }
    case 'close-with-inflight-executes': {
      jest.useFakeTimers({
        doNotFake: [
          'Date',
          'hrtime',
          'performance',
          'nextTick',
          'queueMicrotask',
          'setImmediate',
        ],
      });
      harness.asyncDelayMs = 250;
      const h1 = getDb();
      const inflight: Promise<'ok' | 'rejected'>[] = [];
      for (let i = 0; i < 12; i += 1) {
        inflight.push(
          h1.execute(probeSql).then(
            () => 'ok' as const,
            () => 'rejected' as const,
          ),
        );
      }
      h1.close();
      let postCloseRejected = false;
      try {
        await h1.execute(probeSql);
      } catch {
        postCloseRejected = true;
      }
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();
      let settledCount = 0;
      const results: string[] = [];
      for (const p of inflight) {
        const r = await Promise.race([p, Promise.resolve('pending' as const)]);
        if (r !== 'pending') settledCount += 1;
        results.push(r);
      }
      harness.asyncDelayMs = 0;
      jest.useRealTimers();
      observed['inflightResults'] = results;
      invariants['allInflightSettledWithin60s'] =
        settledCount === inflight.length;
      invariants['postCloseExecuteRejects'] = postCloseRejected;
      const h2 = getDb();
      invariants['reopenedAfterClose'] = harness.opens === 2;
      const verified = await verifyRecovered(h2, expected, file);
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      h2.close();
      return;
    }
    case 'getdb-reuse-x50': {
      const handles: LocalDb[] = [];
      for (let i = 0; i < 50; i += 1) handles.push(getDb());
      const statementsAfterFirst = harness.statements.length;
      invariants['fiftyGetDbOneOpen'] = harness.opens === 1;
      const results = await Promise.all(handles.map(h => h.execute(probeSql)));
      invariants['allWrappersServeSameHandle'] = results.every(
        r => Number(r.rows[0]?.['n']) === expected.kv.length,
      );
      invariants['noRemigrationOnReuse'] =
        harness.statements.length === statementsAfterFirst + 50;
      const verified = await verifyRecovered(
        handles[0] as LocalDb,
        expected,
        file,
      );
      Object.assign(invariants, verified.invariants);
      Object.assign(observed, verified.observed);
      (handles[0] as LocalDb).close();
      return;
    }
  }
}

// ─── Fixed-factor suite: every injected fault at least once ──────────────────

function fixedFactorPlans(): Scenario[] {
  const plans: Scenario[] = [];
  let n = 0;
  const push = (schema: SchemaName, fault: FaultPlan): void => {
    // Seeds in the fixed range are stable identifiers, disjoint from the
    // seeded campaign (which uses seeds < 2^24).
    plans.push({ seed: 0x7f000000 + n, schema, fault });
    n += 1;
  };
  const schemasFor = (i: number): SchemaName =>
    SCHEMAS[i % SCHEMAS.length] as SchemaName;
  let i = 0;
  for (const shape of ERROR_SHAPES) {
    for (const anchor of [
      'first',
      'begin-immediate',
      'commit',
      'last',
    ] as const) {
      push(schemasFor(i), {
        family: 'stmt-throw',
        shape,
        anchor,
        phase: 'pre',
        mode: 'once',
        seededIndex: 0,
      });
      i += 1;
    }
    push(schemasFor(i), {
      family: 'stmt-throw',
      shape,
      anchor: 'commit',
      phase: 'post',
      mode: 'once',
      seededIndex: 0,
    });
    i += 1;
    push(schemasFor(i), {
      family: 'stmt-throw',
      shape,
      anchor: 'first',
      phase: 'pre',
      mode: 'persistent',
      seededIndex: 0,
    });
    i += 1;
  }
  for (const anchor of [
    'purge-outbox',
    'rebuild-insert',
    'drop-legacy',
    'add-column',
  ] as const) {
    push('v0-unscoped', {
      family: 'stmt-throw',
      shape: 'ioerr',
      anchor,
      phase: 'pre',
      mode: 'once',
      seededIndex: 0,
    });
    push('v1-52ba173', {
      family: 'stmt-throw',
      shape: 'full',
      anchor,
      phase: 'post',
      mode: 'once',
      seededIndex: 0,
    });
  }
  for (const shape of MALFORMED_SHAPES) {
    for (const pragmaIndex of [0, 1, 2, 4, 6]) {
      push('v1b-b2731c9', {
        family: 'stmt-malformed',
        shape,
        pragmaIndex,
        mode: 'once',
      });
    }
    push('v0-unscoped', {
      family: 'stmt-malformed',
      shape,
      pragmaIndex: 0,
      mode: 'persistent',
    });
    push('v2-current', {
      family: 'stmt-malformed',
      shape,
      pragmaIndex: 0,
      mode: 'persistent',
    });
  }
  for (const kind of OPEN_FAULTS) {
    push(schemasFor(i), { family: 'open', kind, mode: 'once' });
    i += 1;
    push('fresh', { family: 'open', kind, mode: 'persistent' });
  }
  for (const kind of CLOSE_FAULTS) {
    for (const when of CLOSE_WHEN) {
      push('v1-52ba173', {
        family: 'close',
        kind,
        when,
        withMigrationFault: true,
      });
      push('v2-current', {
        family: 'close',
        kind,
        when,
        withMigrationFault: false,
      });
    }
  }
  for (const kind of ASYNC_FAULTS) {
    for (const mode of FAULT_MODES) {
      push(schemasFor(i), { family: 'async', kind, mode });
      i += 1;
    }
  }
  for (const kind of DISK_FAULTS) {
    for (const schema of SCHEMAS) {
      push(schema, { family: 'disk', kind, seededOffset: 1234 });
    }
  }
  for (const kind of WRAPPER_SCENARIOS) {
    for (const schema of SCHEMAS) {
      push(schema, { family: 'wrapper', kind });
    }
  }
  for (const schema of SCHEMAS) push(schema, { family: 'none' });
  return plans;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function summarize(rows: Row[]): Record<string, unknown> {
  const byFamily: Record<
    string,
    { rows: number; failed: number; fired: number }
  > = {};
  const failedInvariants: Record<string, number> = {};
  for (const row of rows) {
    const family = String(row.inputs['fault']).split('/')[0] ?? 'none';
    const bucket = (byFamily[family] ??= { rows: 0, failed: 0, fired: 0 });
    bucket.rows += 1;
    if (!row.ok) bucket.failed += 1;
    if (Number(row.observed['fired']) > 0) bucket.fired += 1;
    for (const name of row.failed)
      failedInvariants[name] = (failedInvariants[name] ?? 0) + 1;
  }
  const faults = new Set(rows.map(r => String(r.inputs['fault'])));
  const classifications: Record<string, number> = {};
  for (const row of rows) {
    classifications[row.classification] =
      (classifications[row.classification] ?? 0) + 1;
  }
  return {
    suite: SUITE,
    rows: rows.length,
    ok: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok).length,
    classifications,
    failedSeeds: rows.filter(r => !r.ok).map(r => r.seed),
    unclassifiedSeeds: rows
      .filter(r => r.classification === 'BROKEN:unclassified')
      .map(r => r.seed),
    distinctFaults: faults.size,
    injectedRows: rows.filter(r => Number(r.observed['fired']) > 0).length,
    byFamily,
    failedInvariants,
    neverResolvesPassThrough: rows.filter(
      r => r.observed['pendingAfter60s'] === true,
    ).length,
    openedDespiteCorruption: rows.filter(
      r => r.observed['openedDespiteCorruption'] === true,
    ).length,
    node: nodeProcess.version,
    totalDurationMs: rows.reduce((a, r) => a + r.durationMs, 0),
  };
}

function matrixMarkdown(rows: Row[]): string {
  const lines = [
    '| seed | scenario | fired | classification | failed |',
    '|---|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.seed} | ${row.scenario} | ${row.observed['fired']} | ${row.classification} | ${row.failed.join(', ')} |`,
    );
  }
  return lines.join('\n') + '\n';
}

function describeFailure(row: Row): string {
  return `seed=${row.seed} ${row.scenario} failed=${row.failed.join(',')} observed=${JSON.stringify(row.observed).slice(0, 400)}`;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

if (sqlite === null) {
  describe('mod-db failure injection (re-exec under --experimental-sqlite)', () => {
    it(
      'runs the whole file under node --experimental-sqlite',
      () => {
        if (nodeProcess.env['STRESS_SQLITE_CHILD'] === '1') {
          throw new Error(
            'node:sqlite is unavailable even with --experimental-sqlite; Node >= 22.5 is required',
          );
        }
        const jestBin = resolveModule('jest/bin/jest');
        const result = childProcess.spawnSync(
          nodeProcess.execPath,
          [
            jestBin,
            '--ci',
            '--runInBand',
            '--silent',
            '--runTestsByPath',
            __filename,
          ],
          {
            cwd: path.resolve(__dirname, '../..'),
            env: {
              ...nodeProcess.env,
              STRESS_SQLITE_CHILD: '1',
              NODE_OPTIONS:
                `${nodeProcess.env['NODE_OPTIONS'] ?? ''} --experimental-sqlite`.trim(),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(
          -6000,
        );
        expect({ status: result.status, tail }).toEqual({ status: 0, tail });
      },
      20 * 60_000,
    );
  });
} else {
  describe('mod-db failure injection (db.ts open/migrate against real SQLite)', () => {
    const rows: Row[] = [];

    afterAll(() => {
      const rowsFile = writeArtifact(`${SUITE}.rows.json`, rows);
      const summary = summarize(rows);
      writeArtifact(`${SUITE}.summary.json`, summary);
      writeArtifact(`${SUITE}.matrix.md`, matrixMarkdown(rows));
      shimFs.writeFileSync(
        path.join(artifactDir(), `${SUITE}.paths.txt`),
        `${rowsFile}\n`,
      );
      void shimFs;
    });

    if (STRESS_SEEDS) {
      it(
        `replays seeds ${STRESS_SEEDS.join(',')} ×${STRESS_REPEAT}`,
        async () => {
          const perSeed: Record<
            string,
            { runs: number; failed: number; failedInvariants: string[] }
          > = {};
          for (const seed of STRESS_SEEDS) {
            const plan =
              seed >= 0x7f000000
                ? (fixedFactorPlans().find(p => p.seed === seed) ??
                  planFromSeed(seed))
                : seed >= PIN_SEED_BASE
                  ? (KNOWN_DEFECTS.find(d => d.pin.seed === seed)?.pin ??
                    planFromSeed(seed))
                  : planFromSeed(seed);
            const stat = (perSeed[String(seed)] = {
              runs: 0,
              failed: 0,
              failedInvariants: [] as string[],
            });
            for (let r = 0; r < STRESS_REPEAT; r += 1) {
              const row = await runScenario(plan);
              rows.push(row);
              stat.runs += 1;
              if (!row.ok) {
                stat.failed += 1;
                for (const f of row.failed)
                  if (!stat.failedInvariants.includes(f))
                    stat.failedInvariants.push(f);
              }
            }
          }
          writeArtifact(`${SUITE}.replay.json`, perSeed);
          // Replays report; they never mask the campaign verdict.
          expect(Object.keys(perSeed).length).toBe(STRESS_SEEDS.length);
        },
        20 * 60_000,
      );
      return;
    }

    describe('fixed-factor fault suite (every injected fault once)', () => {
      const plans = fixedFactorPlans();
      for (let start = 0; start < plans.length; start += CHUNK) {
        const chunk = plans.slice(start, start + CHUNK);
        it(
          `faults ${start}–${start + chunk.length - 1} hold every invariant`,
          async () => {
            const failures: string[] = [];
            for (const plan of chunk) {
              const row = await runScenario(plan);
              rows.push(row);
              if (row.classification === 'BROKEN:unclassified') {
                failures.push(describeFailure(row));
              }
            }
            expect(failures).toEqual([]);
          },
          10 * 60_000,
        );
      }
    });

    describe(`seeded campaign (${STRESS_ITER} iterations, STRESS_ITER to scale)`, () => {
      for (let start = 0; start < STRESS_ITER; start += CHUNK) {
        const end = Math.min(STRESS_ITER, start + CHUNK);
        it(
          `seeds ${start}–${end - 1} hold every invariant`,
          async () => {
            const failures: string[] = [];
            for (let seed = start; seed < end; seed += 1) {
              const row = await runScenario(planFromSeed(seed));
              rows.push(row);
              if (row.classification === 'BROKEN:unclassified') {
                failures.push(describeFailure(row));
              }
            }
            expect(failures).toEqual([]);
          },
          10 * 60_000,
        );
      }
    });

    describe('known BROKEN pins (test.failing: red once db.ts is fixed → delete the pin)', () => {
      for (const defect of KNOWN_DEFECTS) {
        let pinned: Row | null = null;
        it(
          `${defect.id} (seed=${defect.pin.seed}) reproduces deterministically`,
          async () => {
            pinned = await runScenario(defect.pin);
            rows.push(pinned);
            expect(pinned.classification).toBe(`BROKEN:${defect.id}`);
          },
          2 * 60_000,
        );
        it.failing(
          `${defect.id} (seed=${defect.pin.seed}) holds every invariant`,
          () => {
            if (!pinned) throw new Error('pin did not run');
            expect(pinned.failed).toEqual([]);
          },
        );
      }
    });

    it('injected at least 60 distinct faults across the campaign', () => {
      const faults = new Set(
        rows
          .filter(
            r =>
              Number(r.observed['fired']) > 0 ||
              String(r.inputs['fault']).startsWith('wrapper') ||
              String(r.inputs['fault']).startsWith('disk'),
          )
          .map(r => String(r.inputs['fault'])),
      );
      expect(faults.size).toBeGreaterThanOrEqual(60);
    });
  });
}
