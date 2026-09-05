/**
 * mod-db STRESS — lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the PUBLIC surface of src/data/db.ts
 * (`getDb()` → `LocalDb.execute` / `LocalDb.close`), driven against a REAL
 * SQLite file through node:sqlite (Node 22) behind the same
 * `@op-engineering/op-sqlite` mock seam the existing db tests use. Every
 * sequence is a pure function of its seed: the start state (fresh file /
 * populated current schema / populated legacy pre-owner schema), the action
 * list (length 5–60) and every payload are drawn from one mulberry32 stream,
 * so any row of the emitted JSON table replays from its seed alone.
 *
 * Actions (legal and near-legal, see `generatePlan`):
 *   open / open.burst / write.* (the product pattern `getDb().execute(sql)`)
 *   txn.begin / txn.commit / txn.rollback / close / crash
 *   stale.execute / stale.close (handles kept across a close)
 *   open with injected faults: SQLITE_CANTOPEN at open(), SQLITE_IOERR at the
 *     k-th migration statement, SQLITE_FULL on the next execute
 *   second module instance ("B") opening the SAME file while "A" is live
 *   external connection holding BEGIN IMMEDIATE across an open (SQLITE_BUSY)
 *   external injection of malformed rows (torn JSON, non-JSON, fixture rows)
 *   disk: read-only file, garbage file ("file is not a database"), repair
 *
 * Model-checked invariants (after EVERY step; the model is the documented
 * contract of db.ts — file:line refer to src/data/db.ts):
 *   I1  singleton reuse: getDb() with a cached instance never opens again (275–278)
 *   I2  failed open is never cached and its handle is closed exactly once (257–273)
 *   I3  open-time purge semantics (98–105): fixture/non-real shot.sync outbox
 *       rows with VALID JSON are removed, invalid-JSON payloads are kept,
 *       non-real local_shot rows removed, orphan incomplete/fixture sessions removed
 *   I4  legacy (pre-owner) rows land in the guest bucket, once (129–253)
 *   I5  committed real data survives reopen / crash / failed open / BUSY / read-only
 *   I6  a failed migration statement never leaves partial owner-scoping
 *       (ensureAccountScopedSchema is one transaction, 131/244/247)
 *   I7  uncommitted work is rolled back by close() and by a crash
 *   I8  stale handles (from before a close) cannot mutate the store or the singleton
 *   I9  every injected/environmental failure surfaces as a thrown error (never swallowed)
 *   I10 native handle count == number of live module instances (no leaks)
 *   I11 PRAGMA integrity_check == ok after every step
 *   I12 determinism: same seed twice → identical trace hash
 *
 * Scale knobs (env): STRESS_ITER (sequences, default 120), STRESS_SEED_BASE
 * (first seed, default 1), STRESS_DETERMINISM (seeds replayed twice, default
 * 20), STRESS_ARTIFACT_DIR (default <repo>/artifacts/stress/mod-db-randomized-seeded).
 * STRESS_REPLAY_SEED=<n> runs that single seed and dumps its full trace.
 */
import type { LocalDb } from '../../src/data/db';
import {
  childProcess,
  fs,
  loadNodeSqlite,
  nodeProcess,
  os,
  path,
  resolveModule,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  makePrng,
  pick,
  RAW_STRING_VARIANTS,
  type RawVariantName,
} from '../../xc-harness/lifecycle-persistence/seeds';

declare const __filename: string;
declare const __dirname: string;

const sqlite = loadNodeSqlite();

// ---------------------------------------------------------------------------
// op-sqlite mock seam: routes the production module's open() to a real
// node:sqlite connection on the current world's file, with fault injection.
// ---------------------------------------------------------------------------

interface FaultState {
  /** open() itself throws (SQLITE_CANTOPEN / unable to open database file). */
  openError: string | null;
  /** The k-th executeSync() since open() throws WITHOUT running (SQLITE_IOERR). */
  failStatementAt: number | null;
  /** The next async execute() throws WITHOUT running (SQLITE_FULL). */
  failNextExecute: string | null;
}

interface World {
  dir: string;
  file: string;
  openInner: () => SqliteDatabaseSync;
  inner: Map<number, SqliteDatabaseSync>;
  nextInner: number;
  opens: number;
  closes: number;
  stmtSinceOpen: number;
  faults: FaultState;
}

const mockWorld: { current: World | null } = { current: null };

function mockInjectedError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = 'ERR_SQLITE_ERROR';
  return error;
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const world = mockWorld.current;
    if (!world) throw new Error('stress world not initialised');
    if (world.faults.openError !== null) {
      const message = world.faults.openError;
      world.faults.openError = null;
      throw mockInjectedError(message);
    }
    const inner = world.openInner();
    const id = world.nextInner++;
    world.inner.set(id, inner);
    world.opens += 1;
    world.stmtSinceOpen = 0;
    const run = (sql: string, params: SqlInputValue[]) => ({
      rows: inner.prepare(sql).all(...params) as Record<string, unknown>[],
    });
    return {
      executeSync: (sql: string) => {
        const index = world.stmtSinceOpen++;
        if (world.faults.failStatementAt === index) {
          world.faults.failStatementAt = null;
          throw mockInjectedError(
            `disk I/O error (injected SQLITE_IOERR at migration statement ${index})`,
          );
        }
        return run(sql, []);
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (world.faults.failNextExecute !== null) {
          const message = world.faults.failNextExecute;
          world.faults.failNextExecute = null;
          throw mockInjectedError(message);
        }
        return run(sql, params as SqlInputValue[]);
      },
      close: () => {
        world.closes += 1;
        inner.close();
        world.inner.delete(id);
      },
    };
  },
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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Cell = string | number | null;
type Row = Record<string, Cell>;
type TableName =
  | 'kv'
  | 'local_shot'
  | 'local_session'
  | 'local_capture'
  | 'outbox'
  | 'sync_receipt'
  | 'local_analysis_record';

interface Tables {
  kv: Row[];
  local_shot: Row[];
  local_session: Row[];
  local_capture: Row[];
  outbox: Row[];
  sync_receipt: Row[];
  local_analysis_record: Row[];
  outboxSeq: number;
}

/**
 * 'base' = a fresh file whose LOCAL_MIGRATIONS ran (partially or fully) but
 * whose ensureAccountScopedSchema() transaction never committed: some or all
 * base tables exist, none carry the ALTER'd columns/indexes, and no data.
 */
type Schema = 'none' | 'base' | 'legacy' | 'current' | 'garbage';
type ConnId = 'A' | 'B';
const CONN_IDS: readonly ConnId[] = ['A', 'B'];
const GUEST = 'device-guest';

interface Model {
  schema: Schema;
  /** Leading LOCAL_MIGRATIONS statements (db.ts:18-106) already persisted;
   * every later CREATE/INDEX/DELETE is the first statement needing a write lock. */
  baseDone: number;
  committed: Tables;
  pending: Tables | null;
  txnConn: ConnId | null;
  externalLock: boolean;
  readonly: boolean;
  live: Record<ConnId, boolean>;
}

const COLUMNS: Record<TableName, readonly string[]> = {
  kv: ['key', 'value'],
  local_shot: [
    'owner_key',
    'id',
    'session_id',
    'shot_type',
    'captured_at',
    'overall_score',
    'confidence',
    'result_kind',
    'source',
    'favorite',
    'payload',
  ],
  local_session: [
    'owner_key',
    'id',
    'mode',
    'shot_type',
    'focus_checkpoint',
    'started_at',
    'ended_at',
    'completed',
    'summary',
  ],
  local_capture: [
    'owner_key',
    'id',
    'uri',
    'shot_type',
    'captured_at',
    'duration_ms',
    'fps',
    'width',
    'height',
    'status',
    'payload',
    'declared_stroke',
    'target_seed',
    'training_consent',
  ],
  outbox: ['id', 'owner_key', 'kind', 'payload', 'attempts', 'last_error'],
  sync_receipt: ['owner_key', 'kind', 'entity_id'],
  local_analysis_record: [
    'owner_key',
    'id',
    'capture_id',
    'created_at',
    'engine_version',
    'scoring_model_version',
    'record',
  ],
};

/** Columns present in the pre-owner legacy schema (owner columns and the
 * later capture columns do not exist yet; sync_receipt/analysis_record absent). */
const LEGACY_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  kv: COLUMNS.kv,
  local_shot: COLUMNS.local_shot.filter(c => c !== 'owner_key'),
  local_session: COLUMNS.local_session.filter(c => c !== 'owner_key'),
  local_capture: COLUMNS.local_capture.filter(
    c =>
      ![
        'owner_key',
        'payload',
        'declared_stroke',
        'target_seed',
        'training_consent',
      ].includes(c),
  ),
  outbox: COLUMNS.outbox.filter(c => c !== 'owner_key'),
};

const TABLE_NAMES = Object.keys(COLUMNS) as TableName[];

function emptyTables(): Tables {
  return {
    kv: [],
    local_shot: [],
    local_session: [],
    local_capture: [],
    outbox: [],
    sync_receipt: [],
    local_analysis_record: [],
    outboxSeq: 0,
  };
}

function cloneTables(tables: Tables): Tables {
  return JSON.parse(JSON.stringify(tables)) as Tables;
}

function rowKey(row: Row, keys: readonly string[]): string {
  return JSON.stringify(keys.map(k => row[k] ?? null));
}

function upsert(rows: Row[], keys: readonly string[], row: Row): void {
  const key = rowKey(row, keys);
  const index = rows.findIndex(r => rowKey(r, keys) === key);
  if (index >= 0) rows.splice(index, 1);
  rows.push(row);
}

function parseJsonOrNull(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/** JS mirror of db.ts:98–101 (`json_valid` + `json_extract('$.source') <> 'real'`). */
function outboxRowPurged(row: Row): boolean {
  if (row['kind'] !== 'shot.sync') return false;
  const payload = String(row['payload']);
  const parsed = parseJsonOrNull(payload);
  if (!parsed.ok) return false;
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'source')) return false;
  const source = (value as Record<string, unknown>)['source'];
  if (source === null || source === undefined) return false;
  return source !== 'real';
}

/** Mirrors LOCAL_MIGRATIONS[8..10] (db.ts:98–105). `through` = index of the
 * first statement NOT executed (Infinity = all ran). */
function applyPurges(tables: Tables, through: number): void {
  if (through > 8) {
    tables.outbox = tables.outbox.filter(row => !outboxRowPurged(row));
  }
  if (through > 9) {
    tables.local_shot = tables.local_shot.filter(
      row => row['source'] === 'real',
    );
  }
  if (through > 10) {
    const referenced = new Set(
      tables.local_shot
        .map(row => row['session_id'])
        .filter((id): id is string => typeof id === 'string'),
    );
    tables.local_session = tables.local_session.filter(row => {
      if (referenced.has(String(row['id']))) return true;
      const summary = row['summary'];
      const fixture =
        typeof summary === 'string' &&
        summary.toLowerCase().includes('fixture');
      return !(row['completed'] === 0 || fixture);
    });
  }
}

/** Statements in db.ts LOCAL_MIGRATIONS (7 CREATE TABLE, 1 CREATE INDEX, 3 DELETE). */
const LOCAL_MIGRATION_COUNT = 11;

/** Index of the first migration statement that needs a write lock: the first
 * CREATE TABLE/INDEX IF NOT EXISTS whose object is missing (already-existing
 * ones are no-ops), otherwise the first DELETE (db.ts:98). */
function firstWriteStatement(model: Model): number {
  return Math.min(model.baseDone, 8);
}

/** LOCAL_MIGRATIONS statements a fixture already satisfies: legacy fixtures
 * lack sync_receipt (statement 5) onwards, current fixtures lack the
 * idx_local_analysis_capture index (statement 7). */
function fixtureBaseDone(start: StartState): number {
  return start === 'fresh' ? 0 : start === 'legacy' ? 5 : 7;
}

// ---------------------------------------------------------------------------
// Plans (pure function of the seed)
// ---------------------------------------------------------------------------

type StartState = 'fresh' | 'current' | 'legacy';

type Action =
  | { kind: 'open'; conn: ConnId; fault: OpenFault | null }
  | { kind: 'open.burst'; conn: ConnId }
  | { kind: 'write'; conn: ConnId; write: WriteOp; full: boolean }
  | { kind: 'txn.begin'; conn: ConnId }
  | { kind: 'txn.commit'; conn: ConnId }
  | { kind: 'txn.rollback'; conn: ConnId }
  | { kind: 'close'; conn: ConnId }
  | { kind: 'stale.execute'; conn: ConnId; write: WriteOp }
  | { kind: 'stale.close'; conn: ConnId }
  | { kind: 'crash' }
  | { kind: 'ext.lock' }
  | { kind: 'ext.unlock' }
  | { kind: 'ext.inject'; rows: InjectRow[] }
  | { kind: 'disk.readonly' }
  | { kind: 'disk.readwrite' }
  | { kind: 'disk.garbage' }
  | { kind: 'disk.repair' };

type OpenFault = { type: 'cantopen' } | { type: 'ioerr'; statement: number };

type WriteOp =
  | { table: 'kv'; row: Row }
  | { table: 'local_shot'; row: Row }
  | { table: 'local_session'; row: Row }
  | { table: 'local_capture'; row: Row; replace: boolean }
  | { table: 'outbox'; row: Row }
  | { table: 'sync_receipt'; row: Row }
  | { table: 'local_analysis_record'; row: Row }
  | { table: 'delete.shot'; owner: string; id: string }
  | { table: 'delete.owner'; owner: string };

interface InjectRow {
  table: 'outbox' | 'local_shot' | 'local_session' | 'kv';
  row: Row;
}

interface Plan {
  seed: number;
  start: StartState;
  actions: Action[];
}

const OWNERS = [
  GUEST,
  '7fc2c743-028f-4ec6-942c-a84508f3be38',
  '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01',
] as const;
const SHOT_IDS = Array.from({ length: 10 }, (_, i) => `shot-${i}`);
const SESSION_IDS = Array.from({ length: 6 }, (_, i) => `sess-${i}`);
const CAPTURE_IDS = Array.from({ length: 6 }, (_, i) => `cap-${i}`);
const KV_KEYS = [
  'practice.set:device-guest',
  'profile:7fc2c743-028f-4ec6-942c-a84508f3be38',
  'walkthrough.seen',
  'review.prompt',
  'week.chart',
];
const SHOT_TYPES = ['dink', 'drive', 'serve', 'third_shot_drop'];
const SHOT_SOURCES = [
  'real',
  'real',
  'real',
  'real',
  'real',
  'real',
  'fixture',
  'demo',
  'REAL',
  '',
];
const OUTBOX_KINDS = [
  'shot.sync',
  'shot.sync',
  'session.create',
  'permit.release',
];
const OUTBOX_PAYLOADS = [
  '{"source":"real","shotId":"shot-1"}',
  '{"source":"real","nested":{"source":"fixture"}}',
  '{"source":"fixture","shotId":"fx-1"}',
  '{"source":"demo"}',
  '{"source":"REAL"}',
  '{"source":5}',
  '{"source":true}',
  '{"source":{"a":1}}',
  '{"source":null}',
  '{"shotId":"no-source"}',
  '{"source":"re\\u0061l"}',
  '  {"source":"fixture"}  ',
  '{"source":"fixture",}',
  '{"source":"real"',
  'not json at all',
  '',
  'null',
  '[1,2,3]',
  '"real"',
  '\u{1F3D3}\uFFFD\u202E{"source":"fixture"}',
  "'; DROP TABLE local_shot; --",
];
const SESSION_SUMMARIES: (string | null)[] = [
  null,
  '{"shots":3}',
  '{"kind":"fixture"}',
  'FIXTURE run',
  '{"note":"prefixture"}',
  'not json',
];
const RAW_VALUE_NAMES: RawVariantName[] = [
  'empty',
  'whitespace',
  'not-json',
  'truncated-json',
  'json-null',
  'json-true',
  'json-number',
  'json-string',
  'json-array',
  'json-empty-object',
  'json-nested-garbage',
  'unicode-noise',
  'deep-nesting',
  'html-injection',
  'sql-injection',
];

type Rng = () => number;

function rawValue(rng: Rng): string {
  const name = pick(rng, RAW_VALUE_NAMES);
  const value = RAW_STRING_VARIANTS[name];
  return value === null ? '{"version":1}' : value;
}

function isoAt(step: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, step)).toISOString();
}

function shotRow(rng: Rng, step: number): Row {
  return {
    owner_key: pick(rng, OWNERS),
    id: pick(rng, SHOT_IDS),
    session_id: rng() < 0.5 ? pick(rng, SESSION_IDS) : null,
    shot_type: pick(rng, SHOT_TYPES),
    captured_at: isoAt(step),
    overall_score: rng() < 0.2 ? null : Math.round(rng() * 100),
    confidence: Math.round(rng() * 100) / 100,
    result_kind: rng() < 0.8 ? 'scored' : 'abstained',
    source: pick(rng, SHOT_SOURCES),
    favorite: rng() < 0.2 ? 1 : 0,
    payload: rng() < 0.7 ? '{"version":2,"checkpoints":[]}' : rawValue(rng),
  };
}

function sessionRow(rng: Rng, step: number): Row {
  return {
    owner_key: pick(rng, OWNERS),
    id: pick(rng, SESSION_IDS),
    mode: 'practice_set',
    shot_type: rng() < 0.7 ? pick(rng, SHOT_TYPES) : null,
    focus_checkpoint: null,
    started_at: isoAt(step),
    ended_at: rng() < 0.3 ? isoAt(step + 1) : null,
    completed: rng() < 0.4 ? 1 : 0,
    summary: pick(rng, SESSION_SUMMARIES),
  };
}

function captureRow(rng: Rng, step: number): Row {
  const id = pick(rng, CAPTURE_IDS);
  return {
    owner_key: pick(rng, OWNERS),
    id,
    uri:
      rng() < 0.7
        ? `file:///captures/${id}.mov`
        : `file:///captures/${pick(rng, CAPTURE_IDS)}.mov`,
    shot_type: pick(rng, SHOT_TYPES),
    captured_at: isoAt(step),
    duration_ms: 1000 + Math.floor(rng() * 5000),
    fps: 60,
    width: 1080,
    height: 1920,
    status:
      rng() < 0.9 ? (rng() < 0.5 ? 'awaiting_model' : 'analyzed') : 'bogus',
    payload: rng() < 0.5 ? null : rawValue(rng),
    declared_stroke: rng() < 0.5 ? null : pick(rng, SHOT_TYPES),
    target_seed: null,
    training_consent: 'not_asked',
  };
}

function outboxRow(rng: Rng): Row {
  return {
    owner_key: pick(rng, OWNERS),
    kind: pick(rng, OUTBOX_KINDS),
    payload: pick(rng, OUTBOX_PAYLOADS),
    attempts: 0,
    last_error: null,
  };
}

function kvRow(rng: Rng): Row {
  return { key: pick(rng, KV_KEYS), value: rawValue(rng) };
}

function receiptRow(rng: Rng): Row {
  return {
    owner_key: pick(rng, OWNERS),
    kind: 'shot.sync',
    entity_id: pick(rng, SHOT_IDS),
  };
}

function recordRow(rng: Rng, step: number): Row {
  return {
    owner_key: pick(rng, OWNERS),
    id: `rec-${Math.floor(rng() * 8)}`,
    capture_id: pick(rng, CAPTURE_IDS),
    created_at: isoAt(step),
    engine_version: 'engine-1',
    scoring_model_version: 'model-1',
    record: rng() < 0.7 ? '{"version":1}' : rawValue(rng),
  };
}

function writeOp(rng: Rng, step: number): WriteOp {
  const roll = rng();
  if (roll < 0.25) return { table: 'local_shot', row: shotRow(rng, step) };
  if (roll < 0.4) return { table: 'outbox', row: outboxRow(rng) };
  if (roll < 0.52)
    return { table: 'local_session', row: sessionRow(rng, step) };
  if (roll < 0.64) return { table: 'kv', row: kvRow(rng) };
  if (roll < 0.76) {
    return {
      table: 'local_capture',
      row: captureRow(rng, step),
      replace: rng() < 0.5,
    };
  }
  if (roll < 0.82) return { table: 'sync_receipt', row: receiptRow(rng) };
  if (roll < 0.88)
    return { table: 'local_analysis_record', row: recordRow(rng, step) };
  if (roll < 0.95) {
    return {
      table: 'delete.shot',
      owner: pick(rng, OWNERS),
      id: pick(rng, SHOT_IDS),
    };
  }
  return { table: 'delete.owner', owner: pick(rng, OWNERS) };
}

function injectRows(rng: Rng, step: number): InjectRow[] {
  const count = 1 + Math.floor(rng() * 3);
  const rows: InjectRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    if (roll < 0.5) rows.push({ table: 'outbox', row: outboxRow(rng) });
    else if (roll < 0.75)
      rows.push({ table: 'local_shot', row: shotRow(rng, step) });
    else if (roll < 0.9)
      rows.push({ table: 'local_session', row: sessionRow(rng, step) });
    else rows.push({ table: 'kv', row: kvRow(rng) });
  }
  return rows;
}

function pickConn(rng: Rng): ConnId {
  return rng() < 0.8 ? 'A' : 'B';
}

export function generatePlan(seed: number): Plan {
  const rng = makePrng(seed);
  const startRoll = rng();
  const start: StartState =
    startRoll < 0.35 ? 'fresh' : startRoll < 0.75 ? 'current' : 'legacy';
  const length = 5 + Math.floor(rng() * 56);
  const actions: Action[] = [];
  for (let step = 0; step < length; step += 1) {
    const roll = rng();
    if (roll < 0.1) {
      const faultRoll = rng();
      const fault: OpenFault | null =
        faultRoll < 0.55
          ? null
          : faultRoll < 0.7
            ? { type: 'cantopen' }
            : { type: 'ioerr', statement: Math.floor(rng() * 34) };
      actions.push({ kind: 'open', conn: pickConn(rng), fault });
    } else if (roll < 0.13) {
      actions.push({ kind: 'open.burst', conn: pickConn(rng) });
    } else if (roll < 0.5) {
      actions.push({
        kind: 'write',
        conn: pickConn(rng),
        write: writeOp(rng, step),
        full: rng() < 0.08,
      });
    } else if (roll < 0.56) {
      actions.push({ kind: 'txn.begin', conn: pickConn(rng) });
    } else if (roll < 0.6) {
      actions.push({ kind: 'txn.commit', conn: pickConn(rng) });
    } else if (roll < 0.63) {
      actions.push({ kind: 'txn.rollback', conn: pickConn(rng) });
    } else if (roll < 0.7) {
      actions.push({ kind: 'close', conn: pickConn(rng) });
    } else if (roll < 0.74) {
      actions.push({
        kind: 'stale.execute',
        conn: pickConn(rng),
        write: writeOp(rng, step),
      });
    } else if (roll < 0.77) {
      actions.push({ kind: 'stale.close', conn: pickConn(rng) });
    } else if (roll < 0.81) {
      actions.push({ kind: 'crash' });
    } else if (roll < 0.85) {
      actions.push({ kind: 'ext.lock' });
    } else if (roll < 0.89) {
      actions.push({ kind: 'ext.unlock' });
    } else if (roll < 0.94) {
      actions.push({ kind: 'ext.inject', rows: injectRows(rng, step) });
    } else if (roll < 0.96) {
      actions.push({ kind: 'disk.readonly' });
    } else if (roll < 0.98) {
      actions.push({ kind: 'disk.readwrite' });
    } else if (roll < 0.99) {
      actions.push({ kind: 'disk.garbage' });
    } else {
      actions.push({ kind: 'disk.repair' });
    }
  }
  return { seed, start, actions };
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'open':
      return `open[${action.conn}]${action.fault ? `!${action.fault.type}${action.fault.type === 'ioerr' ? `@${action.fault.statement}` : ''}` : ''}`;
    case 'write':
      return `write[${action.conn}]${action.full ? '!full' : ''}:${action.write.table}`;
    case 'stale.execute':
      return `stale.execute[${action.conn}]:${action.write.table}`;
    case 'ext.inject':
      return `ext.inject:${action.rows.map(r => r.table).join('+')}`;
    default:
      return 'conn' in action ? `${action.kind}[${action.conn}]` : action.kind;
  }
}

// ---------------------------------------------------------------------------
// Start-state population (raw node:sqlite; deterministic from the seed)
// ---------------------------------------------------------------------------

const LEGACY_SCHEMA = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE local_shot (id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
     result_kind TEXT NOT NULL, source TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL)`,
  `CREATE TABLE local_session (id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT,
     focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`,
  `CREATE TABLE local_capture (id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`,
  `CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
];

const CURRENT_SCHEMA = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE local_shot (owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, overall_score REAL,
     confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE local_session (owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL,
     shot_type TEXT, focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0, summary TEXT, PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE local_capture (owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')), payload TEXT,
     declared_stroke TEXT, target_seed TEXT, training_consent TEXT NOT NULL DEFAULT 'not_asked',
     PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`,
  `CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
     kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
  `CREATE TABLE sync_receipt (owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_key, kind, entity_id))`,
  `CREATE TABLE local_analysis_record (owner_key TEXT NOT NULL, id TEXT NOT NULL,
     capture_id TEXT NOT NULL, created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
     scoring_model_version TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (owner_key, id))`,
];

function insertRaw(
  db: SqliteDatabaseSync,
  table: string,
  row: Row,
  columns: readonly string[],
  verb = 'INSERT OR REPLACE',
): void {
  const values = columns.map(c => row[c] ?? null);
  db.prepare(
    `${verb} INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).all(...values);
}

/** Seeds the start state on disk AND in the model (same rows). Legacy rows
 * carry owner_key = guest in the model — that is what the migration must produce. */
function populateStart(
  seed: number,
  start: StartState,
  file: string,
  openRaw: (file: string) => SqliteDatabaseSync,
): { schema: Schema; tables: Tables } {
  const tables = emptyTables();
  if (start === 'fresh') return { schema: 'none', tables };
  const rng = makePrng(seed ^ 0x9e3779b9);
  const db = openRaw(file);
  for (const sql of start === 'legacy' ? LEGACY_SCHEMA : CURRENT_SCHEMA) {
    db.exec(sql);
  }
  const columnsFor = (table: TableName): readonly string[] =>
    start === 'legacy' ? (LEGACY_COLUMNS[table] ?? []) : COLUMNS[table];
  const count = 4 + Math.floor(rng() * 12);
  for (let i = 0; i < count; i += 1) {
    const shot = shotRow(rng, 1000 + i);
    if (start === 'legacy') shot['owner_key'] = GUEST;
    upsert(tables.local_shot, ['owner_key', 'id'], shot);
    insertRaw(db, 'local_shot', shot, columnsFor('local_shot'));
  }
  const sessions = 2 + Math.floor(rng() * 5);
  for (let i = 0; i < sessions; i += 1) {
    const session = sessionRow(rng, 2000 + i);
    if (start === 'legacy') session['owner_key'] = GUEST;
    upsert(tables.local_session, ['owner_key', 'id'], session);
    insertRaw(db, 'local_session', session, columnsFor('local_session'));
  }
  const outboxRows = 3 + Math.floor(rng() * 8);
  for (let i = 0; i < outboxRows; i += 1) {
    const row = outboxRow(rng);
    if (start === 'legacy') row['owner_key'] = GUEST;
    tables.outboxSeq += 1;
    row['id'] = tables.outboxSeq;
    tables.outbox.push(row);
    insertRaw(
      db,
      'outbox',
      row,
      columnsFor('outbox').filter(c => c !== 'id'),
      'INSERT',
    );
  }
  const kvRows = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < kvRows; i += 1) {
    const row = kvRow(rng);
    upsert(tables.kv, ['key'], row);
    insertRaw(db, 'kv', row, COLUMNS.kv);
  }
  const captures = Math.floor(rng() * 4);
  for (let i = 0; i < captures; i += 1) {
    const row = captureRow(rng, 3000 + i);
    row['status'] = 'analyzed';
    row['uri'] = `file:///captures/start-${i}.mov`;
    row['id'] = `start-cap-${i}`;
    if (start === 'legacy') {
      row['owner_key'] = GUEST;
      row['payload'] = null;
      row['declared_stroke'] = null;
      row['target_seed'] = null;
      row['training_consent'] = 'not_asked';
    }
    upsert(tables.local_capture, ['owner_key', 'id'], row);
    insertRaw(db, 'local_capture', row, columnsFor('local_capture'));
  }
  db.close();
  return { schema: start === 'legacy' ? 'legacy' : 'current', tables };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Handle {
  db: LocalDb;
  gen: number;
}

interface Conn {
  id: ConnId;
  getDb: () => LocalDb;
  handles: Handle[];
  gen: number;
}

interface StepTrace {
  step: number;
  action: string;
  outcome: string;
  violations: string[];
  state: string;
}

export interface SequenceResult {
  seed: number;
  start: StartState;
  length: number;
  executedSteps: number;
  ok: boolean;
  violations: string[];
  traceHash: string;
  actions: string[];
  trace?: StepTrace[];
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ErrorClass =
  | 'locked'
  | 'readonly'
  | 'ioerr'
  | 'cantopen'
  | 'notadb'
  | 'full'
  | 'closed'
  | 'constraint'
  | 'txn-nested'
  | 'txn-none';

const ERROR_PATTERNS: Record<ErrorClass, RegExp> = {
  locked: /database is locked/,
  readonly: /attempt to write a readonly database/,
  ioerr: /injected SQLITE_IOERR/,
  cantopen: /unable to open database file/,
  notadb: /file is not a database/,
  full: /injected SQLITE_FULL/,
  closed: /database is not open/,
  constraint: /constraint failed/,
  'txn-nested': /cannot start a transaction within a transaction/,
  'txn-none': /no transaction is active/,
};

function classify(message: string): ErrorClass | 'other' {
  for (const [name, pattern] of Object.entries(ERROR_PATTERNS)) {
    if (pattern.test(message)) return name as ErrorClass;
  }
  return 'other';
}

class Sequence {
  readonly plan: Plan;
  readonly world: World;
  readonly model: Model;
  readonly conns: Record<ConnId, Conn>;
  readonly trace: StepTrace[] = [];
  external: SqliteDatabaseSync | null = null;
  private readonly openRaw: (file: string) => SqliteDatabaseSync;

  constructor(plan: Plan, dir: string) {
    if (sqlite === null) throw new Error('node:sqlite unavailable');
    const { DatabaseSync } = sqlite;
    this.plan = plan;
    this.openRaw = (file: string) => new DatabaseSync(file);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pickle-sensei.db');
    this.world = {
      dir,
      file,
      openInner: () => this.openRaw(file),
      inner: new Map(),
      nextInner: 1,
      opens: 0,
      closes: 0,
      stmtSinceOpen: 0,
      faults: { openError: null, failStatementAt: null, failNextExecute: null },
    };
    const seeded = populateStart(plan.seed, plan.start, file, this.openRaw);
    this.model = {
      schema: seeded.schema,
      baseDone: fixtureBaseDone(plan.start),
      committed: seeded.tables,
      pending: null,
      txnConn: null,
      externalLock: false,
      readonly: false,
      live: { A: false, B: false },
    };
    mockWorld.current = this.world;
    this.conns = {
      A: { id: 'A', getDb: loadGetDb(), handles: [], gen: 0 },
      B: { id: 'B', getDb: loadGetDb(), handles: [], gen: 0 },
    };
  }

  dispose(): void {
    for (const inner of this.world.inner.values()) {
      try {
        inner.close();
      } catch {
        // already closed
      }
    }
    this.world.inner.clear();
    if (this.external) {
      try {
        this.external.close();
      } catch {
        // already closed
      }
      this.external = null;
    }
    if (mockWorld.current === this.world) mockWorld.current = null;
    try {
      if (fs.existsSync(this.world.dir)) fs.chmodSync(this.world.dir, 0o755);
      if (fs.existsSync(this.world.file)) fs.chmodSync(this.world.file, 0o644);
    } catch {
      // best effort
    }
    fs.rmSync(this.world.dir, { recursive: true, force: true });
  }

  // ----- model helpers -----

  private lockHolder(): ConnId | 'external' | null {
    if (this.model.txnConn) return this.model.txnConn;
    if (this.model.externalLock) return 'external';
    return null;
  }

  private visibleTables(conn: ConnId): Tables {
    return this.model.txnConn === conn && this.model.pending
      ? this.model.pending
      : this.model.committed;
  }

  private newestLiveHandle(conn: Conn): Handle | null {
    const handle = conn.handles[conn.handles.length - 1];
    return handle && handle.gen === conn.gen && this.model.live[conn.id]
      ? handle
      : null;
  }

  private staleHandle(conn: Conn): Handle | null {
    for (let i = conn.handles.length - 1; i >= 0; i -= 1) {
      const handle = conn.handles[i];
      if (handle && handle.gen !== conn.gen) return handle;
    }
    return null;
  }

  private dropLive(conn: ConnId): void {
    if (this.model.txnConn === conn) {
      this.model.txnConn = null;
      this.model.pending = null;
    }
    this.model.live[conn] = false;
    this.conns[conn].gen += 1;
  }

  /** The successful-open transform of the model (LOCAL_MIGRATIONS + ensureAccountScopedSchema). */
  private applySuccessfulOpen(): void {
    applyPurges(this.model.committed, Infinity);
    this.model.schema = 'current';
    this.model.baseDone = LOCAL_MIGRATION_COUNT;
  }

  /**
   * Runs getDb() for `conn` (the product's per-operation pattern) and checks
   * the open contract. Returns the handle or null when the open failed.
   */
  private async acquire(
    conn: Conn,
    fault: OpenFault | null,
    violations: string[],
  ): Promise<{ handle: LocalDb | null; outcome: string }> {
    const wasLive = this.model.live[conn.id];
    const opensBefore = this.world.opens;
    const closesBefore = this.world.closes;
    const innerBefore = this.world.inner.size;

    if (fault?.type === 'cantopen') {
      this.world.faults.openError =
        'unable to open database file (injected SQLITE_CANTOPEN)';
    } else if (fault?.type === 'ioerr') {
      this.world.faults.failStatementAt = fault.statement;
    }

    let expected = wasLive
      ? { errors: [] as ErrorClass[], failAt: Infinity }
      : this.expectedOpenFailure(fault);

    let handle: LocalDb | null = null;
    let thrown: string | null = null;
    try {
      handle = conn.getDb();
    } catch (error) {
      thrown = errorMessage(error);
    }
    // A fault index beyond the statements this open actually runs (25 on a
    // current schema, more on a legacy one) is never reached: the open must
    // then behave exactly as if no fault had been armed.
    const faultUnreached =
      fault?.type === 'ioerr' && this.world.faults.failStatementAt !== null;
    this.world.faults.openError = null;
    this.world.faults.failStatementAt = null;
    if (faultUnreached && !wasLive && expected.errors[0] === 'ioerr') {
      expected = this.expectedOpenFailure(null);
    }

    const opened = this.world.opens - opensBefore;
    const closed = this.world.closes - closesBefore;

    if (wasLive) {
      // I1: cached instance reused, nothing opened or closed.
      if (thrown !== null)
        violations.push(`I1 getDb() threw with a live instance: ${thrown}`);
      if (opened !== 0 || closed !== 0) {
        violations.push(
          `I1 getDb() re-opened (opens+${opened} closes+${closed}) with a live instance`,
        );
      }
      if (handle) conn.handles.push({ db: handle, gen: conn.gen });
      return {
        handle,
        outcome: thrown ? `error:${classify(thrown)}` : 'reused',
      };
    }

    if (expected.errors.length === 0) {
      if (thrown !== null) {
        violations.push(`I9/I5 open expected to succeed but threw: ${thrown}`);
        // Keep the model honest about what the failed attempt did on disk.
        this.noteFailedOpen(Infinity);
        return { handle: null, outcome: `error:${classify(thrown)}` };
      }
      if (opened !== 1)
        violations.push(`I1 fresh open should open once, opened ${opened}`);
      if (closed !== 0) violations.push(`I2 successful open closed a handle`);
      if (this.world.inner.size !== innerBefore + 1) {
        violations.push(
          `I10 successful open left ${this.world.inner.size} handles (expected ${innerBefore + 1})`,
        );
      }
      this.applySuccessfulOpen();
      this.model.live[conn.id] = true;
      if (handle) conn.handles.push({ db: handle, gen: conn.gen });
      return { handle, outcome: 'opened' };
    }

    // Expected failure path.
    if (thrown === null) {
      violations.push(
        `I9 open expected to fail (${expected.errors.join('|')}) but succeeded`,
      );
      this.applySuccessfulOpen();
      this.model.live[conn.id] = true;
      if (handle) conn.handles.push({ db: handle, gen: conn.gen });
      return { handle, outcome: 'opened-unexpectedly' };
    }
    const cls = classify(thrown);
    if (cls === 'other' || !expected.errors.includes(cls)) {
      violations.push(
        `I9 open failed with ${cls} (${thrown}), expected ${expected.errors.join('|')}`,
      );
    }
    if (expected.errors[0] === 'cantopen') {
      if (opened !== 0 || closed !== 0) {
        violations.push(`I2 open() threw yet opens+${opened} closes+${closed}`);
      }
    } else {
      if (opened !== 1)
        violations.push(`I2 failed open opened ${opened} handles`);
      if (closed !== 1)
        violations.push(
          `I2 failed open closed ${closed} handles (expected exactly 1)`,
        );
    }
    if (this.world.inner.size !== innerBefore) {
      violations.push(
        `I10 failed open leaked a native handle (${this.world.inner.size} vs ${innerBefore})`,
      );
    }
    this.noteFailedOpen(expected.failAt);
    return { handle: null, outcome: `error:${cls}` };
  }

  /**
   * Expected outcome of a fresh open: the first statement that cannot run
   * decides the error. An injected IOERR is checked before the statement
   * executes, so it wins ties with an environmental failure at the same index.
   */
  private expectedOpenFailure(fault: OpenFault | null): {
    errors: ErrorClass[];
    failAt: number;
  } {
    if (fault?.type === 'cantopen') return { errors: ['cantopen'], failAt: -1 };
    const holder = this.lockHolder();
    const garbage = this.model.schema === 'garbage';
    const environmental: ErrorClass[] = garbage
      ? ['notadb']
      : [
          ...(holder !== null ? (['locked'] as ErrorClass[]) : []),
          ...(this.model.readonly ? (['readonly'] as ErrorClass[]) : []),
        ];
    const blockAt =
      environmental.length > 0
        ? garbage
          ? 0
          : firstWriteStatement(this.model)
        : Infinity;
    const faultAt = fault?.type === 'ioerr' ? fault.statement : Infinity;
    if (faultAt <= blockAt && faultAt !== Infinity) {
      return { errors: ['ioerr'], failAt: faultAt };
    }
    if (blockAt !== Infinity) return { errors: environmental, failAt: blockAt };
    return { errors: [], failAt: Infinity };
  }

  /** Autocommit statements before `failAt` ran; the owner-scoping txn did not. */
  private noteFailedOpen(failAt: number): void {
    if (this.model.schema === 'garbage') return;
    if (failAt <= 0) return;
    applyPurges(this.model.committed, failAt);
    this.model.baseDone = Math.max(
      this.model.baseDone,
      Math.min(failAt, LOCAL_MIGRATION_COUNT),
    );
    if (this.model.schema === 'none') this.model.schema = 'base';
  }

  // ----- write model -----

  private writeSql(op: WriteOp): { sql: string; params: SqlInputValue[] }[] {
    const insert = (
      table: string,
      row: Row,
      columns: readonly string[],
      verb: string,
    ) => ({
      sql: `${verb} INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      params: columns.map(c => (row[c] ?? null) as SqlInputValue),
    });
    switch (op.table) {
      case 'kv':
        return [insert('kv', op.row, COLUMNS.kv, 'INSERT OR REPLACE')];
      case 'local_shot':
        return [
          insert('local_shot', op.row, COLUMNS.local_shot, 'INSERT OR REPLACE'),
        ];
      case 'local_session':
        return [
          insert(
            'local_session',
            op.row,
            COLUMNS.local_session,
            'INSERT OR REPLACE',
          ),
        ];
      case 'local_capture':
        return [
          insert(
            'local_capture',
            op.row,
            COLUMNS.local_capture,
            op.replace ? 'INSERT OR REPLACE' : 'INSERT',
          ),
        ];
      case 'outbox':
        return [
          insert(
            'outbox',
            op.row,
            COLUMNS.outbox.filter(c => c !== 'id'),
            'INSERT',
          ),
        ];
      case 'sync_receipt':
        return [
          insert(
            'sync_receipt',
            op.row,
            COLUMNS.sync_receipt,
            'INSERT OR REPLACE',
          ),
        ];
      case 'local_analysis_record':
        return [
          insert(
            'local_analysis_record',
            op.row,
            COLUMNS.local_analysis_record,
            'INSERT OR REPLACE',
          ),
        ];
      case 'delete.shot':
        return [
          {
            sql: 'DELETE FROM local_shot WHERE owner_key = ? AND id = ?',
            params: [op.owner, op.id],
          },
        ];
      case 'delete.owner':
        return [
          {
            sql: 'DELETE FROM local_shot WHERE owner_key = ?',
            params: [op.owner],
          },
          {
            sql: 'DELETE FROM local_session WHERE owner_key = ?',
            params: [op.owner],
          },
          {
            sql: 'DELETE FROM local_capture WHERE owner_key = ?',
            params: [op.owner],
          },
          {
            sql: 'DELETE FROM local_analysis_record WHERE owner_key = ?',
            params: [op.owner],
          },
          { sql: 'DELETE FROM outbox WHERE owner_key = ?', params: [op.owner] },
          {
            sql: 'DELETE FROM sync_receipt WHERE owner_key = ?',
            params: [op.owner],
          },
        ];
    }
  }

  /** Applies one write to `tables`; returns the constraint error class it must raise, if any. */
  private applyWrite(tables: Tables, op: WriteOp): ErrorClass | null {
    switch (op.table) {
      case 'kv':
        upsert(tables.kv, ['key'], op.row);
        return null;
      case 'local_shot':
        upsert(tables.local_shot, ['owner_key', 'id'], op.row);
        return null;
      case 'local_session':
        upsert(tables.local_session, ['owner_key', 'id'], op.row);
        return null;
      case 'local_capture': {
        if (
          op.row['status'] !== 'awaiting_model' &&
          op.row['status'] !== 'analyzed'
        ) {
          return 'constraint';
        }
        const pkKey = rowKey(op.row, ['owner_key', 'id']);
        const uriKey = rowKey(op.row, ['owner_key', 'uri']);
        const conflicts = tables.local_capture.filter(
          r =>
            rowKey(r, ['owner_key', 'id']) === pkKey ||
            rowKey(r, ['owner_key', 'uri']) === uriKey,
        );
        if (conflicts.length > 0 && !op.replace) return 'constraint';
        tables.local_capture = tables.local_capture.filter(
          r => !conflicts.includes(r),
        );
        tables.local_capture.push(op.row);
        return null;
      }
      case 'outbox':
        tables.outboxSeq += 1;
        tables.outbox.push({ ...op.row, id: tables.outboxSeq });
        return null;
      case 'sync_receipt':
        upsert(tables.sync_receipt, ['owner_key', 'kind', 'entity_id'], op.row);
        return null;
      case 'local_analysis_record':
        upsert(tables.local_analysis_record, ['owner_key', 'id'], op.row);
        return null;
      case 'delete.shot':
        tables.local_shot = tables.local_shot.filter(
          r => !(r['owner_key'] === op.owner && r['id'] === op.id),
        );
        return null;
      case 'delete.owner':
        for (const table of TABLE_NAMES) {
          if (table === 'kv') continue;
          tables[table] = tables[table].filter(
            r => r['owner_key'] !== op.owner,
          );
        }
        return null;
    }
  }

  private async execute(
    handle: LocalDb,
    sql: string,
    params: SqlInputValue[],
  ): Promise<
    { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }
  > {
    try {
      const result = await handle.execute(sql, params);
      return { ok: true, rows: result.rows };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private async runWrite(
    handle: LocalDb,
    conn: ConnId,
    op: WriteOp,
    full: boolean,
    violations: string[],
  ): Promise<string> {
    const statements = this.writeSql(op);
    const holder = this.lockHolder();
    const blockedByOther = holder !== null && holder !== conn;
    const target = this.visibleTables(conn);
    // delete.owner is a multi-statement write; run it the way repository.ts
    // does (BEGIN IMMEDIATE … COMMIT) unless a transaction is already open.
    const wrap = op.table === 'delete.owner' && this.model.txnConn !== conn;
    if (full) {
      this.world.faults.failNextExecute =
        'database or disk is full (injected SQLITE_FULL)';
    }
    if (wrap) {
      const begin = await this.execute(handle, 'BEGIN IMMEDIATE', []);
      if (!begin.ok) {
        this.world.faults.failNextExecute = null;
        const cls = classify(begin.error);
        const expected = full ? 'full' : blockedByOther ? 'locked' : null;
        if (expected === null)
          violations.push(
            `I9 BEGIN IMMEDIATE failed unexpectedly: ${begin.error}`,
          );
        else if (cls !== expected)
          violations.push(
            `I9 BEGIN IMMEDIATE failed with ${cls}, expected ${expected}`,
          );
        return `error:${cls}`;
      }
      if (blockedByOther)
        violations.push(
          'I5 BEGIN IMMEDIATE succeeded while another connection holds the write lock',
        );
      if (full) violations.push('I9 injected SQLITE_FULL was swallowed');
    }
    const scratch = cloneTables(target);
    let outcome = 'ok';
    let failed = false;
    for (const statement of statements) {
      const result = await this.execute(
        handle,
        statement.sql,
        statement.params,
      );
      if (!result.ok) {
        failed = true;
        const cls = classify(result.error);
        if (full && !wrap) {
          if (cls !== 'full')
            violations.push(
              `I9 injected SQLITE_FULL surfaced as ${cls}: ${result.error}`,
            );
        } else if (blockedByOther && !wrap) {
          if (cls !== 'locked')
            violations.push(
              `I9 write under foreign lock failed with ${cls}, expected locked`,
            );
        } else {
          const expectedConstraint = this.applyWrite(cloneTables(target), op);
          if (expectedConstraint !== cls) {
            violations.push(
              `I9 write ${op.table} failed with ${cls} (${result.error}), expected ${expectedConstraint ?? 'success'}`,
            );
          }
        }
        outcome = `error:${cls}`;
        break;
      }
      if (full && !wrap) {
        violations.push('I9 injected SQLITE_FULL was swallowed');
        this.world.faults.failNextExecute = null;
      }
      if (blockedByOther && !wrap) {
        violations.push(
          'I5 write succeeded while another connection holds the write lock',
        );
      }
    }
    this.world.faults.failNextExecute = null;
    if (!failed) {
      const expectedConstraint = this.applyWrite(scratch, op);
      if (expectedConstraint !== null) {
        violations.push(
          `I9 write ${op.table} succeeded but should have raised ${expectedConstraint}`,
        );
      }
      if (!blockedByOther && !full) Object.assign(target, scratch);
    }
    if (wrap) {
      const end = await this.execute(
        handle,
        failed ? 'ROLLBACK' : 'COMMIT',
        [],
      );
      if (!end.ok)
        violations.push(
          `I9 ${failed ? 'ROLLBACK' : 'COMMIT'} failed: ${end.error}`,
        );
    }
    return outcome;
  }

  // ----- actions -----

  private async step(action: Action, violations: string[]): Promise<string> {
    switch (action.kind) {
      case 'open': {
        const result = await this.acquire(
          this.conns[action.conn],
          action.fault,
          violations,
        );
        return result.outcome;
      }
      case 'open.burst': {
        const conn = this.conns[action.conn];
        const first = await this.acquire(conn, null, violations);
        if (!first.handle) return first.outcome;
        const opensBefore = this.world.opens;
        const handles: LocalDb[] = [];
        for (let i = 0; i < 8; i += 1) handles.push(conn.getDb());
        if (this.world.opens !== opensBefore)
          violations.push('I1 burst getDb() re-opened the database');
        const reads = await Promise.all(
          handles.map(h => this.execute(h, 'SELECT count(*) AS n FROM kv', [])),
        );
        const failed = reads.filter(r => !r.ok);
        if (failed.length > 0)
          violations.push(`I1 burst reads failed: ${failed.length}/8`);
        conn.handles.push({
          db: handles[handles.length - 1] as LocalDb,
          gen: conn.gen,
        });
        return `burst:${first.outcome}`;
      }
      case 'write': {
        const conn = this.conns[action.conn];
        const acquired = await this.acquire(conn, null, violations);
        if (!acquired.handle) return `open-failed:${acquired.outcome}`;
        return this.runWrite(
          acquired.handle,
          action.conn,
          action.write,
          action.full,
          violations,
        );
      }
      case 'txn.begin': {
        const conn = this.conns[action.conn];
        const acquired = await this.acquire(conn, null, violations);
        if (!acquired.handle) return `open-failed:${acquired.outcome}`;
        const holder = this.lockHolder();
        const result = await this.execute(
          acquired.handle,
          'BEGIN IMMEDIATE',
          [],
        );
        if (holder === action.conn) {
          if (result.ok) violations.push('I9 nested BEGIN IMMEDIATE succeeded');
          else if (classify(result.error) !== 'txn-nested')
            violations.push(`I9 nested BEGIN failed with ${result.error}`);
          return result.ok ? 'ok' : `error:${classify(result.error)}`;
        }
        if (holder !== null) {
          if (result.ok)
            violations.push(
              'I5 BEGIN IMMEDIATE succeeded under a foreign write lock',
            );
          else if (classify(result.error) !== 'locked')
            violations.push(
              `I9 BEGIN under foreign lock failed with ${result.error}`,
            );
          return result.ok ? 'ok' : `error:${classify(result.error)}`;
        }
        if (!result.ok) {
          violations.push(
            `I9 BEGIN IMMEDIATE failed unexpectedly: ${result.error}`,
          );
          return `error:${classify(result.error)}`;
        }
        this.model.txnConn = action.conn;
        this.model.pending = cloneTables(this.model.committed);
        return 'ok';
      }
      case 'txn.commit':
      case 'txn.rollback': {
        const conn = this.conns[action.conn];
        const acquired = await this.acquire(conn, null, violations);
        if (!acquired.handle) return `open-failed:${acquired.outcome}`;
        const sql = action.kind === 'txn.commit' ? 'COMMIT' : 'ROLLBACK';
        const result = await this.execute(acquired.handle, sql, []);
        if (this.model.txnConn !== action.conn) {
          if (result.ok)
            violations.push(`I9 ${sql} without a transaction succeeded`);
          else if (classify(result.error) !== 'txn-none')
            violations.push(
              `I9 ${sql} without txn failed with ${result.error}`,
            );
          return result.ok ? 'ok' : `error:${classify(result.error)}`;
        }
        if (!result.ok) {
          violations.push(`I9 ${sql} failed: ${result.error}`);
          return `error:${classify(result.error)}`;
        }
        if (action.kind === 'txn.commit' && this.model.pending) {
          this.model.committed = this.model.pending;
        }
        this.model.pending = null;
        this.model.txnConn = null;
        return 'ok';
      }
      case 'close': {
        const conn = this.conns[action.conn];
        const handle = this.newestLiveHandle(conn);
        if (!handle) return 'noop:not-live';
        const closesBefore = this.world.closes;
        try {
          handle.db.close();
        } catch (error) {
          violations.push(
            `I9 close() on a live handle threw: ${errorMessage(error)}`,
          );
          return 'error:other';
        }
        if (this.world.closes !== closesBefore + 1)
          violations.push('I10 close() did not close the native handle');
        this.dropLive(action.conn);
        return 'ok';
      }
      case 'stale.execute': {
        const conn = this.conns[action.conn];
        const stale = this.staleHandle(conn);
        if (!stale) return 'noop:no-stale-handle';
        const statements = this.writeSql(action.write);
        const first = statements[0];
        if (!first) return 'noop';
        const result = await this.execute(stale.db, first.sql, first.params);
        if (result.ok)
          violations.push('I8 a stale handle executed a write after close()');
        else if (classify(result.error) !== 'closed')
          violations.push(`I8 stale execute failed with ${result.error}`);
        return result.ok ? 'ok' : `error:${classify(result.error)}`;
      }
      case 'stale.close': {
        const conn = this.conns[action.conn];
        const stale = this.staleHandle(conn);
        if (!stale) return 'noop:no-stale-handle';
        const opensBefore = this.world.opens;
        let threw: string | null = null;
        try {
          stale.db.close();
        } catch (error) {
          threw = errorMessage(error);
        }
        // node:sqlite refuses to close twice, so db.ts:286 throws BEFORE
        // db.ts:287 can null the shared singleton. A driver whose close() is
        // idempotent would instead drop a live instance here (see report).
        if (threw === null) violations.push('I8 stale close() did not throw');
        if (this.world.opens !== opensBefore)
          violations.push('I8 stale close() opened a database');
        // The singleton must be untouched: acquire() asserts that getDb()
        // opens only when the model says nothing is live.
        const probe = await this.acquire(conn, null, violations);
        return `${threw ? `error:${classify(threw)}` : 'ok'};probe=${probe.outcome}`;
      }
      case 'crash': {
        for (const inner of this.world.inner.values()) inner.close();
        this.world.inner.clear();
        if (this.external) {
          this.external.close();
          this.external = null;
        }
        this.model.externalLock = false;
        for (const id of CONN_IDS) {
          this.dropLive(id);
          this.conns[id] = { id, getDb: loadGetDb(), handles: [], gen: 0 };
        }
        return 'ok';
      }
      case 'ext.lock': {
        if (this.external) return 'noop:already-locked';
        if (this.model.schema === 'garbage') return 'noop:garbage';
        if (this.model.readonly) return 'noop:readonly';
        const holder = this.lockHolder();
        const raw = this.openRaw(this.world.file);
        try {
          raw.exec('BEGIN IMMEDIATE');
        } catch (error) {
          raw.close();
          const message = errorMessage(error);
          if (holder === null)
            violations.push(
              `I5 external BEGIN IMMEDIATE failed with no lock holder: ${message}`,
            );
          else if (classify(message) !== 'locked')
            violations.push(`external lock failed with ${message}`);
          return `error:${classify(message)}`;
        }
        if (holder !== null) {
          raw.close();
          violations.push(
            'I5 external connection took the write lock while a module transaction is open',
          );
          return 'ok-unexpected';
        }
        this.external = raw;
        this.model.externalLock = true;
        return 'ok';
      }
      case 'ext.unlock': {
        if (!this.external) return 'noop:not-locked';
        this.external.exec('ROLLBACK');
        this.external.close();
        this.external = null;
        this.model.externalLock = false;
        return 'ok';
      }
      case 'ext.inject': {
        if (this.model.schema !== 'current')
          return `noop:schema-${this.model.schema}`;
        if (this.lockHolder() !== null) return 'noop:locked';
        if (this.model.readonly) return 'noop:readonly';
        const raw = this.openRaw(this.world.file);
        try {
          for (const item of action.rows) {
            if (item.table === 'outbox') {
              this.model.committed.outboxSeq += 1;
              this.model.committed.outbox.push({
                ...item.row,
                id: this.model.committed.outboxSeq,
              });
              insertRaw(
                raw,
                'outbox',
                item.row,
                COLUMNS.outbox.filter(c => c !== 'id'),
                'INSERT',
              );
            } else if (item.table === 'kv') {
              upsert(this.model.committed.kv, ['key'], item.row);
              insertRaw(raw, 'kv', item.row, COLUMNS.kv);
            } else {
              upsert(
                this.model.committed[item.table],
                ['owner_key', 'id'],
                item.row,
              );
              insertRaw(raw, item.table, item.row, COLUMNS[item.table]);
            }
          }
        } catch (error) {
          violations.push(`external inject failed: ${errorMessage(error)}`);
        } finally {
          raw.close();
        }
        return 'ok';
      }
      case 'disk.readonly': {
        if (!fs.existsSync(this.world.file)) return 'noop:no-file';
        fs.chmodSync(this.world.file, 0o444);
        this.model.readonly = true;
        return 'ok';
      }
      case 'disk.readwrite': {
        if (!fs.existsSync(this.world.file)) return 'noop:no-file';
        fs.chmodSync(this.world.file, 0o644);
        this.model.readonly = false;
        return 'ok';
      }
      case 'disk.garbage': {
        if (this.world.inner.size > 0 || this.external)
          return 'noop:handles-open';
        if (this.model.readonly) return 'noop:readonly';
        fs.writeFileSync(this.world.file, new Uint8Array(4096).fill(0x07));
        this.model.schema = 'garbage';
        this.model.committed = emptyTables();
        this.model.pending = null;
        this.model.txnConn = null;
        return 'ok';
      }
      case 'disk.repair': {
        if (this.model.schema !== 'garbage') return 'noop:not-garbage';
        if (this.world.inner.size > 0 || this.external)
          return 'noop:handles-open';
        fs.rmSync(this.world.file, { force: true });
        this.model.schema = 'none';
        this.model.baseDone = 0;
        this.model.readonly = false;
        this.model.committed = emptyTables();
        return 'ok';
      }
    }
  }

  // ----- invariants -----

  private readTable(
    read: (sql: string) => Row[],
    table: TableName,
    columns: readonly string[],
  ): Row[] {
    return read(`SELECT ${columns.join(',')} FROM ${table}`).map(row => {
      const out: Row = {};
      for (const column of columns) out[column] = (row[column] ?? null) as Cell;
      return out;
    });
  }

  private canonical(rows: Row[], columns: readonly string[]): string {
    return rows
      .map(row => JSON.stringify(columns.map(c => row[c] ?? null)))
      .sort()
      .join('\n');
  }

  private compareTables(
    read: (sql: string) => Row[],
    expected: Tables,
    label: string,
    violations: string[],
  ): void {
    const legacy = this.model.schema === 'legacy';
    for (const table of TABLE_NAMES) {
      const columns = legacy ? LEGACY_COLUMNS[table] : COLUMNS[table];
      if (!columns) continue;
      let actual: Row[];
      try {
        actual = this.readTable(read, table, columns);
      } catch (error) {
        violations.push(
          `I5 ${label} cannot read ${table}: ${errorMessage(error)}`,
        );
        continue;
      }
      const want = this.canonical(expected[table], columns);
      const got = this.canonical(actual, columns);
      if (want !== got) {
        violations.push(
          `I3/I5 ${label} ${table} mismatch\n  expected(${expected[table].length}): ${want.slice(0, 600)}\n  actual(${actual.length}): ${got.slice(0, 600)}`,
        );
      }
    }
    if (!legacy) {
      const seq = read(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`);
      const actualSeq = seq.length > 0 ? Number(seq[0]?.['seq']) : 0;
      if (actualSeq !== expected.outboxSeq) {
        violations.push(
          `I5 ${label} outbox AUTOINCREMENT seq ${actualSeq} != model ${expected.outboxSeq}`,
        );
      }
    }
  }

  private checkSchema(
    read: (sql: string) => Row[],
    violations: string[],
  ): void {
    for (const table of TABLE_NAMES) {
      const info = read(`PRAGMA table_info(${table})`);
      const names = info.map(r => String(r['name']));
      for (const column of COLUMNS[table]) {
        if (!names.includes(column))
          violations.push(`I4 schema: ${table}.${column} missing after open`);
      }
      if (table !== 'kv' && table !== 'outbox') {
        const pk = info
          .filter(r => Number(r['pk']) > 0)
          .sort((a, b) => Number(a['pk']) - Number(b['pk']))
          .map(r => String(r['name']));
        const expectedPk =
          table === 'sync_receipt'
            ? ['owner_key', 'kind', 'entity_id']
            : ['owner_key', 'id'];
        if (JSON.stringify(pk) !== JSON.stringify(expectedPk)) {
          violations.push(
            `I4 schema: ${table} primary key ${JSON.stringify(pk)} != ${JSON.stringify(expectedPk)}`,
          );
        }
      }
    }
    const indexes = read(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    ).map(r => String(r['name']));
    for (const index of [
      'idx_local_shot_owner_time',
      'idx_local_capture_owner_time',
      'idx_outbox_owner_created',
      'idx_local_analysis_capture',
    ]) {
      if (!indexes.includes(index))
        violations.push(`I4 schema: index ${index} missing`);
    }
  }

  private async checkInvariants(violations: string[]): Promise<string> {
    const liveCount = CONN_IDS.filter(id => this.model.live[id]).length;
    if (this.world.inner.size !== liveCount) {
      violations.push(
        `I10 native handles ${this.world.inner.size} != live module instances ${liveCount}`,
      );
    }
    if (this.model.schema === 'garbage' || this.model.schema === 'none') {
      return `${this.model.schema}`;
    }
    if (!fs.existsSync(this.world.file)) return 'no-file';
    if (this.model.schema === 'base') {
      // No data can exist yet (only ext.inject writes bypass getDb(), and it
      // requires a current schema); assert the file is still a sound database.
      const raw = this.openRaw(this.world.file);
      try {
        const check = raw.prepare('PRAGMA integrity_check').all() as {
          integrity_check: string;
        }[];
        if (check[0]?.integrity_check !== 'ok') {
          violations.push(
            `I11 integrity_check on base schema: ${JSON.stringify(check)}`,
          );
        }
      } finally {
        raw.close();
      }
      return `base:${this.model.baseDone}`;
    }

    // Committed view through an independent connection.
    const raw = this.openRaw(this.world.file);
    let stateDigest = '';
    try {
      const read = (sql: string) => raw.prepare(sql).all() as Row[];
      const integrity = read('PRAGMA integrity_check');
      const verdict = integrity
        .map(r => String(r['integrity_check']))
        .join(';');
      if (verdict !== 'ok') violations.push(`I11 integrity_check: ${verdict}`);
      this.compareTables(
        read,
        this.model.committed,
        'committed-view',
        violations,
      );
      if (this.model.schema === 'current' && liveCount > 0)
        this.checkSchema(read, violations);
      stateDigest = fnv1a(
        TABLE_NAMES.map(t =>
          this.canonical(this.model.committed[t], COLUMNS[t]),
        ).join('|'),
      );
    } finally {
      raw.close();
    }

    // Each live module instance sees its own transaction (or the committed state).
    for (const id of CONN_IDS) {
      const handle = this.newestLiveHandle(this.conns[id]);
      if (!handle) continue;
      const rowsBySql = new Map<string, Row[]>();
      const sqls: string[] = [];
      const legacy = this.model.schema === 'legacy';
      for (const table of TABLE_NAMES) {
        const columns = legacy ? LEGACY_COLUMNS[table] : COLUMNS[table];
        if (columns) sqls.push(`SELECT ${columns.join(',')} FROM ${table}`);
      }
      if (!legacy)
        sqls.push(`SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`);
      for (const sql of sqls) {
        const result = await this.execute(handle.db, sql, []);
        if (!result.ok) {
          violations.push(`I5 live[${id}] read failed: ${result.error}`);
          rowsBySql.set(sql, []);
        } else {
          rowsBySql.set(sql, result.rows as Row[]);
        }
      }
      this.compareTables(
        sql => rowsBySql.get(sql) ?? [],
        this.visibleTables(id),
        `live[${id}]${this.model.txnConn === id ? '(txn)' : ''}`,
        violations,
      );
    }
    return `${this.model.schema}:${stateDigest}:txn=${this.model.txnConn ?? '-'}:live=${CONN_IDS.filter(id => this.model.live[id]).join('')}:ro=${this.model.readonly ? 1 : 0}:ext=${this.model.externalLock ? 1 : 0}`;
  }

  async run(): Promise<SequenceResult> {
    const violations: string[] = [];
    let executed = 0;
    for (const [index, action] of this.plan.actions.entries()) {
      const stepViolations: string[] = [];
      let outcome: string;
      try {
        outcome = await this.step(action, stepViolations);
      } catch (error) {
        outcome = 'harness-error';
        stepViolations.push(`harness threw: ${errorMessage(error)}`);
      }
      let state = '';
      try {
        state = await this.checkInvariants(stepViolations);
      } catch (error) {
        stepViolations.push(`invariant check threw: ${errorMessage(error)}`);
      }
      executed += 1;
      this.trace.push({
        step: index,
        action: describeAction(action),
        outcome,
        violations: stepViolations,
        state,
      });
      for (const v of stepViolations)
        violations.push(
          `step ${index} ${describeAction(action)} → ${outcome}: ${v}`,
        );
      if (stepViolations.length > 0) break;
    }
    const traceText = this.trace
      .map(
        t =>
          `${t.step}|${t.action}|${t.outcome}|${t.state}|${t.violations.length}`,
      )
      .join('\n');
    return {
      seed: this.plan.seed,
      start: this.plan.start,
      length: this.plan.actions.length,
      executedSteps: executed,
      ok: violations.length === 0,
      violations,
      traceHash: fnv1a(traceText),
      actions: this.plan.actions.map(describeAction),
    };
  }
}

const RUN_ROOT = path.join(
  os.tmpdir(),
  `mod-db-stress-${Date.now().toString(36)}`,
);

export async function runPlan(
  plan: Plan,
  tag = 'seq',
): Promise<SequenceResult> {
  const dir = path.join(RUN_ROOT, `${tag}-${plan.seed}`);
  const sequence = new Sequence(plan, dir);
  try {
    const result = await sequence.run();
    return { ...result, trace: sequence.trace };
  } finally {
    sequence.dispose();
  }
}

export async function runSeed(
  seed: number,
  tag = 'seq',
): Promise<SequenceResult> {
  return runPlan(generatePlan(seed), tag);
}

/** Greedy one-at-a-time action removal while the sequence still fails. */
export async function minimize(
  seed: number,
  budget = 160,
): Promise<{
  actions: Action[];
  described: string[];
  violations: string[];
  runs: number;
}> {
  const plan = generatePlan(seed);
  let actions = plan.actions.slice();
  let last = await runPlan({ ...plan, actions }, 'min');
  let runs = 1;
  let progress = true;
  while (progress && runs < budget) {
    progress = false;
    for (let i = actions.length - 1; i >= 0 && runs < budget; i -= 1) {
      const candidate = actions.slice(0, i).concat(actions.slice(i + 1));
      if (candidate.length === 0) continue;
      const result = await runPlan({ ...plan, actions: candidate }, 'min');
      runs += 1;
      if (!result.ok) {
        actions = candidate;
        last = result;
        progress = true;
      }
    }
  }
  return {
    actions,
    described: actions.map(describeAction),
    violations: last.violations,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/mod-db-randomized-seeded',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

const STRESS_ITER = envInt('STRESS_ITER', 120);
const STRESS_SEED_BASE = envInt('STRESS_SEED_BASE', 1);
const STRESS_DETERMINISM = envInt('STRESS_DETERMINISM', 20);
const STRESS_REPLAY_SEED = nodeProcess.env['STRESS_REPLAY_SEED'];

if (sqlite === null) {
  describe('mod-db randomized-seeded stress (re-exec under --experimental-sqlite)', () => {
    it(
      'runs the whole file under node --experimental-sqlite',
      () => {
        if (nodeProcess.env['STRESS_SQLITE_CHILD'] === '1') {
          throw new Error(
            'node:sqlite is unavailable even with --experimental-sqlite; Node >= 22.13 is required (apps/mobile engines)',
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
      30 * 60_000,
    );
  });
} else {
  afterAll(() => {
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  });

  describe('mod-db curated fault scenarios (replayable action lists)', () => {
    const scripted = async (
      start: StartState,
      actions: Action[],
      seed: number,
    ) => {
      const result = await runPlan({ seed, start, actions }, 'curated');
      expect(result.violations).toEqual([]);
      return result;
    };

    it('SQLITE_BUSY: an external writer across open() fails cleanly, releases, reopens with data intact', async () => {
      await scripted(
        'current',
        [
          { kind: 'ext.lock' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'open', conn: 'B', fault: null },
          { kind: 'ext.unlock' },
          { kind: 'open', conn: 'A', fault: null },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v' } },
            full: false,
          },
          { kind: 'ext.lock' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v2' } },
            full: false,
          },
          { kind: 'ext.unlock' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v3' } },
            full: false,
          },
        ],
        101,
      );
    });

    it('SQLITE_IOERR at every migration statement of a populated legacy database', async () => {
      for (let statement = 0; statement < 34; statement += 1) {
        await scripted(
          'legacy',
          [
            { kind: 'open', conn: 'A', fault: { type: 'ioerr', statement } },
            { kind: 'open', conn: 'A', fault: null },
            { kind: 'close', conn: 'A' },
            { kind: 'open', conn: 'B', fault: null },
          ],
          200 + statement,
        );
      }
    });

    it('SQLITE_IOERR at every migration statement of a populated current database', async () => {
      for (let statement = 0; statement < 26; statement += 1) {
        await scripted(
          'current',
          [
            { kind: 'open', conn: 'A', fault: { type: 'ioerr', statement } },
            { kind: 'open', conn: 'A', fault: null },
          ],
          300 + statement,
        );
      }
    });

    it('read-only file: open fails without data loss, recovers once writable', async () => {
      await scripted(
        'current',
        [
          { kind: 'disk.readonly' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'disk.readwrite' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'disk.readonly' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v' } },
            full: false,
          },
          { kind: 'close', conn: 'A' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'disk.readwrite' },
          { kind: 'open', conn: 'A', fault: null },
        ],
        401,
      );
    });

    it('garbage file: "file is not a database" surfaces, handle closed, repair reopens fresh', async () => {
      await scripted(
        'fresh',
        [
          { kind: 'disk.garbage' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'open', conn: 'A', fault: { type: 'ioerr', statement: 0 } },
          { kind: 'disk.repair' },
          { kind: 'open', conn: 'A', fault: null },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v' } },
            full: false,
          },
        ],
        501,
      );
    });

    it('SQLITE_CANTOPEN at open(): nothing cached, nothing leaked, next open works', async () => {
      await scripted(
        'fresh',
        [
          { kind: 'open', conn: 'A', fault: { type: 'cantopen' } },
          { kind: 'open', conn: 'A', fault: { type: 'cantopen' } },
          { kind: 'open', conn: 'A', fault: null },
        ],
        601,
      );
    });

    it('second module instance vs an open transaction: BUSY, then both see one store', async () => {
      await scripted(
        'current',
        [
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'txn.begin', conn: 'A' },
          {
            kind: 'write',
            conn: 'A',
            write: {
              table: 'outbox',
              row: {
                owner_key: GUEST,
                kind: 'shot.sync',
                payload: '{"source":"real"}',
                attempts: 0,
                last_error: null,
              },
            },
            full: false,
          },
          { kind: 'open', conn: 'B', fault: null },
          { kind: 'txn.commit', conn: 'A' },
          { kind: 'open', conn: 'B', fault: null },
          {
            kind: 'write',
            conn: 'B',
            write: { table: 'kv', row: { key: 'b', value: 'B' } },
            full: false,
          },
          { kind: 'txn.begin', conn: 'B' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'a', value: 'A' } },
            full: false,
          },
          { kind: 'txn.rollback', conn: 'B' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'a', value: 'A' } },
            full: false,
          },
          { kind: 'close', conn: 'B' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'a', value: 'A2' } },
            full: false,
          },
        ],
        701,
      );
    });

    it('crash mid-transaction: uncommitted rows vanish, committed rows and stale handles behave', async () => {
      await scripted(
        'legacy',
        [
          { kind: 'open', conn: 'A', fault: null },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'kept', value: '1' } },
            full: false,
          },
          { kind: 'txn.begin', conn: 'A' },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'lost', value: '1' } },
            full: false,
          },
          { kind: 'crash' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'close', conn: 'A' },
          {
            kind: 'stale.execute',
            conn: 'A',
            write: { table: 'kv', row: { key: 'x', value: 'y' } },
          },
          { kind: 'stale.close', conn: 'A' },
          { kind: 'open', conn: 'A', fault: null },
          { kind: 'stale.close', conn: 'A' },
        ],
        801,
      );
    });

    it('SQLITE_FULL on a write surfaces and leaves the store unchanged', async () => {
      await scripted(
        'current',
        [
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v' } },
            full: true,
          },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'delete.owner', owner: GUEST },
            full: true,
          },
          {
            kind: 'write',
            conn: 'A',
            write: { table: 'kv', row: { key: 'k', value: 'v' } },
            full: false,
          },
        ],
        901,
      );
    });
  });

  describe('mod-db seeded randomized long-run', () => {
    const seeds = STRESS_REPLAY_SEED
      ? [Number.parseInt(STRESS_REPLAY_SEED, 10)]
      : Array.from({ length: STRESS_ITER }, (_, i) => STRESS_SEED_BASE + i);

    it(
      `campaign: ${seeds.length} seeded sequences (length 5–60) hold every invariant after every step`,
      async () => {
        const rows: SequenceResult[] = [];
        const outcomeHistogram: Record<string, number> = {};
        const startedAt = Date.now();
        for (const seed of seeds) {
          const result = await runSeed(seed);
          const { trace, ...row } = result;
          rows.push(row);
          for (const t of trace ?? []) {
            const key = `${t.action.replace(/\[.\]/, '').split(':')[0]} → ${t.outcome.split(';')[0]}`;
            outcomeHistogram[key] = (outcomeHistogram[key] ?? 0) + 1;
          }
          if (!result.ok || STRESS_REPLAY_SEED) {
            writeArtifact(`trace-seed-${seed}.json`, { ...row, trace });
          }
        }
        const failing = rows.filter(r => !r.ok);
        const minimized: Record<string, unknown>[] = [];
        for (const failure of failing.slice(0, 25)) {
          const min = await minimize(failure.seed);
          const reruns: boolean[] = [];
          for (let i = 0; i < 10; i += 1)
            reruns.push((await runSeed(failure.seed, `flake${i}`)).ok);
          minimized.push({
            seed: failure.seed,
            start: failure.start,
            originalLength: failure.length,
            minimizedLength: min.actions.length,
            minimizedActions: min.described,
            minimizedPlan: min.actions,
            violations: min.violations,
            minimizerRuns: min.runs,
            rerunFailures: reruns.filter(ok => !ok).length,
            rerunTotal: reruns.length,
          });
        }
        const lengths = rows.map(r => r.length);
        const summary = {
          suite: 'mod-db randomized-seeded',
          node: nodeProcess.version,
          seedBase: STRESS_SEED_BASE,
          sequences: rows.length,
          executedSteps: rows.reduce((n, r) => n + r.executedSteps, 0),
          plannedSteps: rows.reduce((n, r) => n + r.length, 0),
          minLength: Math.min(...lengths),
          maxLength: Math.max(...lengths),
          starts: {
            fresh: rows.filter(r => r.start === 'fresh').length,
            current: rows.filter(r => r.start === 'current').length,
            legacy: rows.filter(r => r.start === 'legacy').length,
          },
          actionHistogram: rows
            .flatMap(r =>
              r.actions.map(a => a.replace(/\[.\]/, '').split(':')[0] ?? a),
            )
            .reduce<Record<string, number>>((acc, a) => {
              acc[a] = (acc[a] ?? 0) + 1;
              return acc;
            }, {}),
          outcomeHistogram: Object.fromEntries(
            Object.entries(outcomeHistogram).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
          failing: failing.map(r => r.seed),
          durationMs: Date.now() - startedAt,
        };
        writeArtifact(`results-${STRESS_SEED_BASE}-${rows.length}.json`, {
          summary,
          minimized,
          rows: rows.map(r => ({
            seed: r.seed,
            start: r.start,
            length: r.length,
            executedSteps: r.executedSteps,
            ok: r.ok,
            traceHash: r.traceHash,
            violations: r.violations,
          })),
        });
        expect(lengths.every(n => n >= 5 && n <= 60)).toBe(true);
        expect(
          failing.map(r => ({ seed: r.seed, violations: r.violations })),
        ).toEqual([]);
      },
      60 * 60_000,
    );

    it(
      `determinism: ${Math.min(STRESS_DETERMINISM, seeds.length)} seeds replayed twice produce identical traces`,
      async () => {
        const sample = seeds.slice(0, STRESS_DETERMINISM);
        const mismatches: { seed: number; first: string; second: string }[] =
          [];
        for (const seed of sample) {
          const first = await runSeed(seed, 'det1');
          const second = await runSeed(seed, 'det2');
          if (first.traceHash !== second.traceHash) {
            mismatches.push({
              seed,
              first: first.traceHash,
              second: second.traceHash,
            });
            writeArtifact(`determinism-seed-${seed}.json`, { first, second });
          }
        }
        writeArtifact(`determinism-${STRESS_SEED_BASE}-${sample.length}.json`, {
          sample,
          mismatches,
        });
        expect(mismatches).toEqual([]);
      },
      30 * 60_000,
    );
  });
}
