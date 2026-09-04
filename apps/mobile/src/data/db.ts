import { open, type DB } from '@op-engineering/op-sqlite';
import { GUEST_DATA_OWNER } from './accountScope';

/**
 * Durable local store (directive §32): SQLite for structured state, with a
 * versioned local schema. Video files live in the native filesystem; only
 * metadata/structured results live here.
 */

export interface LocalDb {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

const LOCAL_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     session_id TEXT,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     overall_score REAL,
     confidence REAL NOT NULL,
     result_kind TEXT NOT NULL,
     source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL,
     PRIMARY KEY (owner_key, id)
   )`,
  `CREATE TABLE IF NOT EXISTS local_session (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     mode TEXT NOT NULL,
     shot_type TEXT,
     focus_checkpoint TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0,
     summary TEXT,
     PRIMARY KEY (owner_key, id)
   )`,
  `CREATE TABLE IF NOT EXISTS local_capture (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     uri TEXT NOT NULL,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
     payload TEXT,
     PRIMARY KEY (owner_key, id),
     UNIQUE (owner_key, uri)
   )`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id)
   )`,
  // Immutable, versioned analysis records: a capture accumulates one row per
  // (engine, model set) that ever processed it. Reprocessing appends; nothing
  // here is ever updated or destroyed by a newer model.
  `CREATE TABLE IF NOT EXISTS local_analysis_record (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     capture_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     engine_version TEXT NOT NULL,
     scoring_model_version TEXT NOT NULL,
     record TEXT NOT NULL,
     PRIMARY KEY (owner_key, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_analysis_capture
     ON local_analysis_record (owner_key, capture_id, created_at DESC)`,
  // Fixture reads existed in early development builds. They are removed once,
  // before any product query runs, so old simulator/device data cannot leak
  // into history, scores, trends, session summaries, or sync. A payload that
  // is not JSON is not a fixture read: it is left for the sync layer's
  // row-level failure handling instead of aborting every open with
  // "malformed JSON" (json_extract raises on invalid input).
  `DELETE FROM outbox
   WHERE kind = 'shot.sync'
     AND json_valid(payload)
     AND json_extract(payload, '$.source') <> 'real'`,
  `DELETE FROM local_shot WHERE source <> 'real'`,
  `DELETE FROM local_session
   WHERE id NOT IN (SELECT DISTINCT session_id FROM local_shot WHERE session_id IS NOT NULL)
     AND (completed = 0 OR summary LIKE '%fixture%')`,
];

function tableInfo(db: DB, table: string): Record<string, unknown>[] {
  return (db.executeSync(`PRAGMA table_info(${table})`).rows ?? []) as Record<
    string,
    unknown
  >[];
}

function hasAccountPrimaryKey(db: DB, table: string): boolean {
  const primary = tableInfo(db, table)
    .filter(row => Number(row['pk']) > 0)
    .sort((a, b) => Number(a['pk']) - Number(b['pk']))
    .map(row => String(row['name']));
  return primary[0] === 'owner_key' && primary[1] === 'id';
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return tableInfo(db, table).some(row => row['name'] === column);
}

/** Assigns every legacy row to the isolated guest bucket; it is never claimed
 * by the next signed-in account. */
function ensureAccountScopedSchema(db: DB): void {
  const quoteGuest = `'${GUEST_DATA_OWNER}'`;
  db.executeSync('BEGIN IMMEDIATE');
  try {
    if (!hasAccountPrimaryKey(db, 'local_shot')) {
      const owner = hasColumn(db, 'local_shot', 'owner_key')
        ? 'owner_key'
        : quoteGuest;
      db.executeSync('DROP TABLE IF EXISTS local_shot_account_v2');
      db.executeSync(`CREATE TABLE local_shot_account_v2 (
        owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
        shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, overall_score REAL,
        confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
        PRIMARY KEY (owner_key, id))`);
      db.executeSync(`INSERT OR IGNORE INTO local_shot_account_v2
        (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
        SELECT ${owner},id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload
        FROM local_shot`);
      db.executeSync('DROP TABLE local_shot');
      db.executeSync('ALTER TABLE local_shot_account_v2 RENAME TO local_shot');
    }

    if (!hasAccountPrimaryKey(db, 'local_session')) {
      const owner = hasColumn(db, 'local_session', 'owner_key')
        ? 'owner_key'
        : quoteGuest;
      db.executeSync('DROP TABLE IF EXISTS local_session_account_v2');
      db.executeSync(`CREATE TABLE local_session_account_v2 (
        owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL,
        shot_type TEXT, focus_checkpoint TEXT, started_at TEXT NOT NULL,
        ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0, summary TEXT,
        PRIMARY KEY (owner_key, id))`);
      db.executeSync(`INSERT OR IGNORE INTO local_session_account_v2
        (owner_key,id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
        SELECT ${owner},id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary
        FROM local_session`);
      db.executeSync('DROP TABLE local_session');
      db.executeSync(
        'ALTER TABLE local_session_account_v2 RENAME TO local_session',
      );
    }

    if (!hasAccountPrimaryKey(db, 'local_capture')) {
      const owner = hasColumn(db, 'local_capture', 'owner_key')
        ? 'owner_key'
        : quoteGuest;
      const payload = hasColumn(db, 'local_capture', 'payload')
        ? 'payload'
        : 'NULL';
      db.executeSync('DROP TABLE IF EXISTS local_capture_account_v2');
      db.executeSync(`CREATE TABLE local_capture_account_v2 (
        owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL,
        shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        fps REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
        payload TEXT,
        PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`);
      db.executeSync(`INSERT OR IGNORE INTO local_capture_account_v2
        (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload)
        SELECT ${owner},id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,${payload}
        FROM local_capture`);
      db.executeSync('DROP TABLE local_capture');
      db.executeSync(
        'ALTER TABLE local_capture_account_v2 RENAME TO local_capture',
      );
    }

    // Legacy account-scoped databases predate durable native capture evidence.
    // The column stays nullable so those rows can be labeled as legacy rather
    // than receiving reconstructed or inferred values.
    if (!hasColumn(db, 'local_capture', 'payload')) {
      db.executeSync('ALTER TABLE local_capture ADD COLUMN payload TEXT');
    }

    // Declared stroke is the user's statement of intent, stored separately
    // from any model prediction (which lives in the clip payload's
    // recognition). NULL means the user declined to declare.
    if (!hasColumn(db, 'local_capture', 'declared_stroke')) {
      db.executeSync(
        'ALTER TABLE local_capture ADD COLUMN declared_stroke TEXT',
      );
    }
    // Target selection ("tap yourself") is user input naming WHICH person
    // on court is the user. It lives on the capture row so an imported
    // clip's tap survives restarts; NULL means no tap was recorded.
    if (!hasColumn(db, 'local_capture', 'target_seed')) {
      db.executeSync('ALTER TABLE local_capture ADD COLUMN target_seed TEXT');
    }
    // Consent for ML training use is explicit and off by default; product
    // telemetry never flows through this flag.
    if (!hasColumn(db, 'local_capture', 'training_consent')) {
      db.executeSync(
        "ALTER TABLE local_capture ADD COLUMN training_consent TEXT NOT NULL DEFAULT 'not_asked'",
      );
    }

    if (!hasColumn(db, 'outbox', 'owner_key')) {
      db.executeSync(
        `ALTER TABLE outbox ADD COLUMN owner_key TEXT NOT NULL DEFAULT '${GUEST_DATA_OWNER}'`,
      );
    }
    db.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_local_shot_owner_time ON local_shot (owner_key, captured_at DESC)',
    );
    db.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_local_capture_owner_time ON local_capture (owner_key, captured_at DESC)',
    );
    db.executeSync(
      'CREATE INDEX IF NOT EXISTS idx_outbox_owner_created ON outbox (owner_key, created_at, id)',
    );
    db.executeSync(`CREATE TABLE IF NOT EXISTS sync_receipt (
      owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_key, kind, entity_id))`);
    db.executeSync('COMMIT');
  } catch (error) {
    try {
      db.executeSync('ROLLBACK');
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

let instance: DB | null = null;

function openMigrated(): DB {
  const db = open({ name: 'pickle-sensei.db' });
  try {
    for (const sql of LOCAL_MIGRATIONS) {
      db.executeSync(sql);
    }
    ensureAccountScopedSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
  return db;
}

export function getDb(): LocalDb {
  if (!instance) {
    instance = openMigrated();
  }
  const db = instance;
  return {
    async execute(sql, params = []) {
      const result = await db.execute(sql, params as never[]);
      return { rows: (result.rows ?? []) as Record<string, unknown>[] };
    },
    close() {
      db.close();
      instance = null;
    },
  };
}
