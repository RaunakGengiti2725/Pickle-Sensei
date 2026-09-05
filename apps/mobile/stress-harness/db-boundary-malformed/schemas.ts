/**
 * Pre-migration database shapes the harness seeds before handing the file to
 * the production `getDb()`. Historical DDL mirrors what shipped builds created
 * (see __tests__/xc/lifecycle-persistence/sqliteMigrationMatrix.xc.test.ts);
 * `future` is the current schema plus columns/tables/user_version a newer
 * build could add, which a downgrade must leave untouched.
 */
export type SchemaId =
  | 'fresh'
  | 'v0'
  | 'v0b-owner-col'
  | 'v0c-capture-unscoped'
  | 'v1a-no-payload'
  | 'current'
  | 'future'
  | 'kv-only'
  | 'garbage';

export type TableName =
  | 'kv'
  | 'local_shot'
  | 'local_session'
  | 'local_capture'
  | 'outbox'
  | 'sync_receipt'
  | 'local_analysis_record'
  | 'local_future_v9';

export interface Shape {
  /** False for `fresh` (no file) and `garbage` (not a database). */
  hasTables: boolean;
  kvOnly: boolean;
  shotsOwner: boolean;
  sessionsOwner: boolean;
  hasCapture: boolean;
  /** False only for the defensive path where local_capture predates account scoping. */
  captureOwner: boolean;
  captureHasPayload: boolean;
  captureHasFutureCols: boolean;
  outboxOwner: boolean;
  hasReceipt: boolean;
  hasAnalysis: boolean;
  future: boolean;
}

export const SHAPES: Record<SchemaId, Shape> = {
  fresh: {
    hasTables: false,
    kvOnly: false,
    shotsOwner: false,
    sessionsOwner: false,
    hasCapture: false,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: false,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  garbage: {
    hasTables: false,
    kvOnly: false,
    shotsOwner: false,
    sessionsOwner: false,
    hasCapture: false,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: false,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  'kv-only': {
    hasTables: true,
    kvOnly: true,
    shotsOwner: false,
    sessionsOwner: false,
    hasCapture: false,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: false,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  v0: {
    hasTables: true,
    kvOnly: false,
    shotsOwner: false,
    sessionsOwner: false,
    hasCapture: false,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: false,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  'v0b-owner-col': {
    hasTables: true,
    kvOnly: false,
    shotsOwner: true,
    sessionsOwner: true,
    hasCapture: false,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: true,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  'v0c-capture-unscoped': {
    hasTables: true,
    kvOnly: false,
    shotsOwner: true,
    sessionsOwner: true,
    hasCapture: true,
    captureOwner: false,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: true,
    hasReceipt: false,
    hasAnalysis: false,
    future: false,
  },
  'v1a-no-payload': {
    hasTables: true,
    kvOnly: false,
    shotsOwner: true,
    sessionsOwner: true,
    hasCapture: true,
    captureOwner: true,
    captureHasPayload: false,
    captureHasFutureCols: false,
    outboxOwner: true,
    hasReceipt: true,
    hasAnalysis: false,
    future: false,
  },
  current: {
    hasTables: true,
    kvOnly: false,
    shotsOwner: true,
    sessionsOwner: true,
    hasCapture: true,
    captureOwner: true,
    captureHasPayload: true,
    captureHasFutureCols: true,
    outboxOwner: true,
    hasReceipt: true,
    hasAnalysis: true,
    future: false,
  },
  future: {
    hasTables: true,
    kvOnly: false,
    shotsOwner: true,
    sessionsOwner: true,
    hasCapture: true,
    captureOwner: true,
    captureHasPayload: true,
    captureHasFutureCols: true,
    outboxOwner: true,
    hasReceipt: true,
    hasAnalysis: true,
    future: true,
  },
};

const KV_DDL = `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

const SHOT_UNSCOPED_DDL = `CREATE TABLE local_shot (
  id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
  result_kind TEXT NOT NULL, source TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`;

const SHOT_OWNER_COL_DDL = `CREATE TABLE local_shot (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, session_id TEXT, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
  result_kind TEXT NOT NULL, source TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`;

const SHOT_SCOPED_DDL = `CREATE TABLE local_shot (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
  result_kind TEXT NOT NULL, source TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  PRIMARY KEY (owner_key, id))`;

const SESSION_UNSCOPED_DDL = `CREATE TABLE local_session (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT, focus_checkpoint TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0,
  summary TEXT)`;

const SESSION_OWNER_COL_DDL = `CREATE TABLE local_session (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, mode TEXT NOT NULL, shot_type TEXT,
  focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`;

const SESSION_SCOPED_DDL = `CREATE TABLE local_session (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL, shot_type TEXT,
  focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  completed INTEGER NOT NULL DEFAULT 0, summary TEXT,
  PRIMARY KEY (owner_key, id))`;

const CAPTURE_UNSCOPED_DDL = `CREATE TABLE local_capture (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`;

const CAPTURE_NO_PAYLOAD_DDL = `CREATE TABLE local_capture (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
  PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`;

const CAPTURE_CURRENT_DDL = `CREATE TABLE local_capture (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL, shot_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
  payload TEXT, declared_stroke TEXT, target_seed TEXT,
  training_consent TEXT NOT NULL DEFAULT 'not_asked',
  PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`;

const OUTBOX_UNSCOPED_DDL = `CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`;

const OUTBOX_SCOPED_DDL = `CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`;

const RECEIPT_DDL = `CREATE TABLE sync_receipt (
  owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, kind, entity_id))`;

const ANALYSIS_DDL = [
  `CREATE TABLE local_analysis_record (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, capture_id TEXT NOT NULL,
  created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
  scoring_model_version TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (owner_key, id))`,
  `CREATE INDEX idx_local_analysis_capture
  ON local_analysis_record (owner_key, capture_id, created_at DESC)`,
];

const CURRENT_INDEXES = [
  `CREATE INDEX idx_local_shot_owner_time ON local_shot (owner_key, captured_at DESC)`,
  `CREATE INDEX idx_local_capture_owner_time ON local_capture (owner_key, captured_at DESC)`,
  `CREATE INDEX idx_outbox_owner_created ON outbox (owner_key, created_at, id)`,
];

export const FUTURE_DDL = [
  `ALTER TABLE local_shot ADD COLUMN future_note TEXT`,
  `ALTER TABLE outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE local_session ADD COLUMN future_flags TEXT`,
  `CREATE TABLE local_future_v9 (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, blob_data BLOB, PRIMARY KEY (owner_key, id))`,
  `CREATE INDEX idx_future_note ON local_shot (owner_key, future_note)`,
  `PRAGMA user_version = 99`,
];

export const FUTURE_USER_VERSION = 99;

export function schemaDdl(schema: SchemaId): string[] {
  switch (schema) {
    case 'fresh':
    case 'garbage':
      return [];
    case 'kv-only':
      return [KV_DDL];
    case 'v0':
      return [
        KV_DDL,
        SHOT_UNSCOPED_DDL,
        `CREATE INDEX idx_local_shot_time ON local_shot (captured_at DESC)`,
        SESSION_UNSCOPED_DDL,
        OUTBOX_UNSCOPED_DDL,
      ];
    case 'v0b-owner-col':
      return [
        KV_DDL,
        SHOT_OWNER_COL_DDL,
        SESSION_OWNER_COL_DDL,
        OUTBOX_SCOPED_DDL,
      ];
    case 'v0c-capture-unscoped':
      return [
        KV_DDL,
        SHOT_OWNER_COL_DDL,
        SESSION_OWNER_COL_DDL,
        CAPTURE_UNSCOPED_DDL,
        OUTBOX_SCOPED_DDL,
      ];
    case 'v1a-no-payload':
      return [
        KV_DDL,
        SHOT_SCOPED_DDL,
        SESSION_SCOPED_DDL,
        CAPTURE_NO_PAYLOAD_DDL,
        OUTBOX_SCOPED_DDL,
        RECEIPT_DDL,
      ];
    case 'current':
      return [
        KV_DDL,
        SHOT_SCOPED_DDL,
        SESSION_SCOPED_DDL,
        CAPTURE_CURRENT_DDL,
        OUTBOX_SCOPED_DDL,
        RECEIPT_DDL,
        ...ANALYSIS_DDL,
        ...CURRENT_INDEXES,
      ];
    case 'future':
      return [...schemaDdl('current'), ...FUTURE_DDL];
  }
}

/** Column order used for seeding and dumping each table. */
export function tableColumns(table: TableName, shape: Shape): string[] {
  switch (table) {
    case 'kv':
      return ['key', 'value'];
    case 'local_shot':
      return [
        ...(shape.shotsOwner ? ['owner_key'] : []),
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
        ...(shape.future ? ['future_note'] : []),
      ];
    case 'local_session':
      return [
        ...(shape.sessionsOwner ? ['owner_key'] : []),
        'id',
        'mode',
        'shot_type',
        'focus_checkpoint',
        'started_at',
        'ended_at',
        'completed',
        'summary',
        ...(shape.future ? ['future_flags'] : []),
      ];
    case 'local_capture':
      return [
        ...(shape.captureOwner ? ['owner_key'] : []),
        'id',
        'uri',
        'shot_type',
        'captured_at',
        'duration_ms',
        'fps',
        'width',
        'height',
        'status',
        ...(shape.captureHasPayload ? ['payload'] : []),
        ...(shape.captureHasFutureCols
          ? ['declared_stroke', 'target_seed', 'training_consent']
          : []),
      ];
    case 'outbox':
      return [
        ...(shape.outboxOwner ? ['owner_key'] : []),
        'kind',
        'payload',
        'attempts',
        'created_at',
        'last_error',
        ...(shape.future ? ['priority'] : []),
      ];
    case 'sync_receipt':
      return ['owner_key', 'kind', 'entity_id', 'accepted_at'];
    case 'local_analysis_record':
      return [
        'owner_key',
        'id',
        'capture_id',
        'created_at',
        'engine_version',
        'scoring_model_version',
        'record',
      ];
    case 'local_future_v9':
      return ['owner_key', 'id', 'blob_data'];
  }
}

export function tablesFor(shape: Shape): TableName[] {
  if (!shape.hasTables) return [];
  if (shape.kvOnly) return ['kv'];
  const tables: TableName[] = ['kv', 'local_shot', 'local_session', 'outbox'];
  if (shape.hasCapture) tables.push('local_capture');
  if (shape.hasReceipt) tables.push('sync_receipt');
  if (shape.hasAnalysis) tables.push('local_analysis_record');
  if (shape.future) tables.push('local_future_v9');
  return tables;
}

/** The tables and account-scoped shape every successful open must produce. */
export const EXPECTED_TABLES: readonly TableName[] = [
  'kv',
  'local_shot',
  'local_session',
  'local_capture',
  'outbox',
  'sync_receipt',
  'local_analysis_record',
];

export const EXPECTED_INDEXES: readonly string[] = [
  'idx_local_shot_owner_time',
  'idx_local_capture_owner_time',
  'idx_outbox_owner_created',
  'idx_local_analysis_capture',
];

export const EXPECTED_CAPTURE_COLUMNS: readonly string[] = [
  'payload',
  'declared_stroke',
  'target_seed',
  'training_consent',
];
