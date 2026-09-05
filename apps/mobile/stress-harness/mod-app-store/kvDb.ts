import type { LocalDb } from '../../src/data/db';
import {
  loadNodeSqlite,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

/**
 * kv-only LocalDb doubles for the appStore stress campaign.
 *
 * Both understand exactly the statements data/repository.ts getKv/setKv
 * issue and record every write so a row can prove "no write happened" for a
 * rejected payload. `MemoryKvDb` is the fast default; `SqliteKvDb` runs the
 * same statements through a real SQLite engine (node:sqlite, in-memory) so
 * NUL bytes, lone surrogates and multi-hundred-KB values round-trip through
 * actual TEXT storage rather than a JS Map. (node:sqlite is a Linux proxy
 * for op-sqlite — not Apple device truth.)
 */

export interface KvWrite {
  key: string;
  value: string;
}

export interface StressKvDb extends LocalDb {
  readonly writes: KvWrite[];
  readonly statements: string[];
  seed(key: string, value: string): void;
  read(key: string): string | null;
  snapshot(): Record<string, string>;
  dispose(): void;
}

const SELECT_KV = 'SELECT value FROM kv WHERE key = ?';
const UPSERT_KV = 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)';
const DELETE_KV = 'DELETE FROM kv WHERE key = ?';

export class MemoryKvDb implements StressKvDb {
  readonly writes: KvWrite[] = [];
  readonly statements: string[] = [];
  private readonly table = new Map<string, string>();

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(sql);
    if (sql === SELECT_KV) {
      const value = this.table.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql === UPSERT_KV) {
      const key = String(params[0]);
      const value = String(params[1]);
      this.table.set(key, value);
      this.writes.push({ key, value });
      return { rows: [] };
    }
    if (sql === DELETE_KV) {
      this.table.delete(String(params[0]));
      this.writes.push({ key: String(params[0]), value: '' });
      return { rows: [] };
    }
    throw new Error(`stress harness: unexpected statement ${sql}`);
  }

  close(): void {}

  seed(key: string, value: string): void {
    this.table.set(key, value);
  }

  read(key: string): string | null {
    return this.table.get(key) ?? null;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.table);
  }

  dispose(): void {
    this.table.clear();
  }
}

export class SqliteKvDb implements StressKvDb {
  readonly writes: KvWrite[] = [];
  readonly statements: string[] = [];
  private readonly db: SqliteDatabaseSync;

  private constructor(db: SqliteDatabaseSync) {
    this.db = db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }

  static open(): SqliteKvDb | null {
    const sqlite = loadNodeSqlite();
    if (!sqlite) return null;
    return new SqliteKvDb(new sqlite.DatabaseSync(':memory:'));
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(sql);
    const bound = params.map(value =>
      value === null || value === undefined ? null : String(value),
    );
    if (sql === UPSERT_KV) {
      this.writes.push({ key: String(params[0]), value: String(params[1]) });
    } else if (sql === DELETE_KV) {
      this.writes.push({ key: String(params[0]), value: '' });
    }
    const rows = this.db.prepare(sql).all(...bound) as Record<
      string,
      unknown
    >[];
    return { rows };
  }

  close(): void {}

  seed(key: string, value: string): void {
    this.db.prepare(UPSERT_KV).run(key, value);
  }

  read(key: string): string | null {
    const row = this.db.prepare(SELECT_KV).get(key) as
      { value: unknown } | undefined;
    return row === undefined ? null : String(row.value);
  }

  snapshot(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv ORDER BY key')
      .all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map(row => [row.key, String(row.value)]));
  }

  dispose(): void {
    this.db.close();
  }
}
