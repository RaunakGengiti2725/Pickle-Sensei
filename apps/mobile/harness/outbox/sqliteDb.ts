import type { LocalDb } from '../../src/data/db';
import { builtinModule, fs, harnessDir, path } from './nodeEnv';
import type {
  DurableSnapshot,
  HarnessDb,
  LocalSessionSnapshot,
  LocalShotSnapshot,
  OutboxRowSnapshot,
  ReceiptSnapshot,
} from './durableStore';

/**
 * Real SQLite backend (Node's built-in `node:sqlite`, available under
 * `NODE_OPTIONS=--experimental-sqlite` on Node 22.12). The schema is the
 * production one: the CREATE statements are lifted verbatim from
 * src/data/db.ts LOCAL_MIGRATIONS at run time, so AUTOINCREMENT, primary keys
 * and json_extract behave exactly as on device (op-sqlite is SQLite too).
 */

type SqlInputValue = null | number | bigint | string;

interface SqliteStatement {
  all(...params: SqlInputValue[]): unknown[];
  run(...params: SqlInputValue[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (location: string) => SqliteDatabase };

const DB_SOURCE = path.join(harnessDir, '..', '..', 'src', 'data', 'db.ts');

export function loadSqliteModule(): SqliteModule | null {
  const loaded = builtinModule('node:sqlite');
  if (!loaded || typeof loaded !== 'object') return null;
  if (!('DatabaseSync' in loaded)) return null;
  return loaded as SqliteModule;
}

export function isSqliteAvailable(): boolean {
  return loadSqliteModule() !== null;
}

/** CREATE TABLE / CREATE INDEX statements exactly as db.ts declares them. */
export function productionSchemaStatements(): string[] {
  const source = fs.readFileSync(DB_SOURCE, 'utf8');
  const start = source.indexOf('const LOCAL_MIGRATIONS');
  const end = source.indexOf('];', start);
  if (start < 0 || end < 0) {
    throw new Error('sqliteDb: LOCAL_MIGRATIONS not found in src/data/db.ts');
  }
  const block = source.slice(start, end);
  const statements: string[] = [];
  const literal = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(block)) !== null) {
    const text = match[1];
    if (text === undefined) continue;
    if (/^\s*CREATE (TABLE|INDEX)/.test(text)) statements.push(text);
  }
  if (statements.length < 6) {
    throw new Error(
      `sqliteDb: expected the production schema, found ${statements.length} statements`,
    );
  }
  return statements;
}

function toSqlValue(value: unknown): SqlInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`sqliteDb: unsupported parameter type ${typeof value}`);
}

export function createSqliteDb(): HarnessDb {
  const mod = loadSqliteModule();
  if (!mod) {
    throw new Error(
      'node:sqlite unavailable — run with NODE_OPTIONS=--experimental-sqlite',
    );
  }
  const sqlite = new mod.DatabaseSync(':memory:');
  for (const statement of productionSchemaStatements()) sqlite.exec(statement);
  let statements = 0;

  const execute: LocalDb['execute'] = async (sql, params = []) => {
    statements += 1;
    const trimmed = sql.trim();
    const values = params.map(toSqlValue);
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(trimmed)) {
      sqlite.exec(trimmed);
      return { rows: [] };
    }
    const statement = sqlite.prepare(trimmed);
    if (/^SELECT/i.test(trimmed)) {
      const rows = statement.all(...values) as Record<string, unknown>[];
      return { rows };
    }
    statement.run(...values);
    return { rows: [] };
  };

  const all = <T>(sql: string): T[] => sqlite.prepare(sql).all() as T[];

  return {
    backend: 'sqlite',
    db: { execute, close: () => sqlite.close() },
    snapshot(): DurableSnapshot {
      const seq = all<{ seq: number }>(
        `SELECT seq FROM sqlite_sequence WHERE name = 'outbox'`,
      );
      return {
        outbox: all<OutboxRowSnapshot>(
          `SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id`,
        ),
        receipts: all<ReceiptSnapshot>(
          `SELECT owner_key, kind, entity_id FROM sync_receipt`,
        ),
        shots: all<LocalShotSnapshot>(
          `SELECT owner_key, id, session_id, result_kind, source, payload FROM local_shot`,
        ),
        sessions: all<LocalSessionSnapshot>(
          `SELECT owner_key, id, mode, shot_type, focus_checkpoint, started_at, completed, summary FROM local_session`,
        ),
        kv: all<{ key: string; value: string }>(`SELECT key, value FROM kv`),
        outboxSequence: seq[0]?.seq ?? 0,
      };
    },
    corruptOutboxPayload(id, payload) {
      sqlite
        .prepare(`UPDATE outbox SET payload = ? WHERE id = ?`)
        .run(payload, id);
    },
    close: () => sqlite.close(),
    statementCount: () => statements,
  };
}
