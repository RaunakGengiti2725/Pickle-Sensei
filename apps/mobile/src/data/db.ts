import { open, type DB } from '@op-engineering/op-sqlite';

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
     id TEXT PRIMARY KEY,
     session_id TEXT,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     overall_score REAL,
     confidence REAL NOT NULL,
     result_kind TEXT NOT NULL,
     source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_shot_time ON local_shot (captured_at DESC)`,
  `CREATE TABLE IF NOT EXISTS local_session (
     id TEXT PRIMARY KEY,
     mode TEXT NOT NULL,
     shot_type TEXT,
     focus_checkpoint TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0,
     summary TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`,
];

let instance: DB | null = null;

export function getDb(): LocalDb {
  if (!instance) {
    instance = open({ name: 'pickle-sensei.db' });
    for (const sql of LOCAL_MIGRATIONS) {
      instance.executeSync(sql);
    }
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

/** In-memory implementation for Jest — same interface, no native module. */
export function createMemoryDb(): LocalDb {
  const tables = new Map<string, Record<string, unknown>[]>();
  void tables;
  throw new Error(
    'createMemoryDb is replaced by repository-level fakes in tests.',
  );
}
