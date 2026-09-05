/**
 * Real-SQLite `LocalDb` for the outbox stress campaigns.
 *
 * The fake databases used by the unit suites hand-roll each SQL statement, so
 * they cannot tell whether a rollback actually undid a receipt insert, whether
 * `LIMIT 50` / `attempts < ?` are honoured, or whether a NUL byte survives a
 * TEXT column. Here the production DDL for `outbox` + `sync_receipt` (copied
 * verbatim from src/data/db.ts) is loaded into an in-memory `node:sqlite`
 * database and every statement `drainOutbox` issues runs for real.
 *
 * Fault injection: `failOn(pattern, nth)` makes the nth statement whose SQL
 * matches `pattern` throw (a stand-in for SQLITE_FULL / IOERR mid-transaction),
 * which is how the rollback family exercises `BEGIN IMMEDIATE … ROLLBACK`.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  loadNodeSqlite,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';

const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
)`;

const RECEIPT_DDL = `CREATE TABLE IF NOT EXISTS sync_receipt (
  owner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, kind, entity_id)
)`;

export interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export interface ReceiptRow {
  owner_key: string;
  kind: string;
  entity_id: string;
}

export interface InjectedFault {
  pattern: RegExp;
  /** 1-based ordinal of the matching statement that should fail. */
  nth: number;
  message: string;
}

export interface SqliteOutboxDb {
  db: LocalDb;
  /** Every SQL statement executed, in order (for LIMIT / txn assertions). */
  statements: string[];
  insert(row: {
    owner: string;
    kind: string;
    payload: string;
    attempts?: number;
    lastError?: string | null;
  }): number;
  rows(): OutboxRow[];
  /** The payload text as persisted (may differ from the bound string). */
  storedPayload(id: number): string;
  /** The kind text as persisted (may differ from the bound string). */
  storedKind(id: number): string;
  receipts(): ReceiptRow[];
  /** Arm a one-shot fault; cleared automatically once it fires. */
  failOn(fault: InjectedFault): void;
  /** True while a transaction opened by the code under test is still open. */
  inTransaction(): boolean;
  close(): void;
}

export class SqliteFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteFaultError';
  }
}

function toSqlParam(value: unknown): SqlInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

export function createSqliteOutboxDb(): SqliteOutboxDb {
  const sqlite = loadNodeSqlite();
  if (!sqlite) {
    throw new Error(
      'node:sqlite unavailable — run under Node >= 22.13 (or --experimental-sqlite)',
    );
  }
  const inner: SqliteDatabaseSync = new sqlite.DatabaseSync(':memory:');
  inner.exec(OUTBOX_DDL);
  inner.exec(RECEIPT_DDL);
  const statements: string[] = [];
  let fault: InjectedFault | null = null;
  let faultSeen = 0;

  const run = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    statements.push(sql);
    if (fault && fault.pattern.test(sql)) {
      faultSeen += 1;
      if (faultSeen === fault.nth) {
        const message = fault.message;
        fault = null;
        faultSeen = 0;
        throw new SqliteFaultError(message);
      }
    }
    const stmt = inner.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      return stmt.all(...params.map(toSqlParam)) as Record<string, unknown>[];
    }
    stmt.run(...params.map(toSqlParam));
    return [];
  };

  const db: LocalDb = {
    execute: async (sql, params = []) => ({ rows: run(sql, params) }),
    close: () => inner.close(),
  };

  return {
    db,
    statements,
    insert({ owner, kind, payload, attempts = 0, lastError = null }) {
      inner
        .prepare(
          `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(owner, kind, payload, attempts, lastError);
      const row = inner.prepare('SELECT last_insert_rowid() AS id').get() as {
        id: number;
      };
      return Number(row.id);
    },
    storedPayload(id) {
      // What the drain will actually read: node:sqlite binds TEXT as a
      // C string, so a payload with an embedded NUL is stored truncated.
      const row = inner
        .prepare('SELECT payload FROM outbox WHERE id = ?')
        .get(id) as { payload: string } | undefined;
      if (!row) throw new Error(`outbox row ${id} not found`);
      return String(row.payload);
    },
    storedKind(id) {
      const row = inner
        .prepare('SELECT kind FROM outbox WHERE id = ?')
        .get(id) as { kind: string } | undefined;
      if (!row) throw new Error(`outbox row ${id} not found`);
      return String(row.kind);
    },
    rows() {
      return inner
        .prepare(
          'SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id ASC',
        )
        .all() as OutboxRow[];
    },
    receipts() {
      return inner
        .prepare(
          'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY owner_key, kind, entity_id',
        )
        .all() as ReceiptRow[];
    },
    failOn(next) {
      fault = next;
      faultSeen = 0;
    },
    inTransaction() {
      // node:sqlite exposes `isTransaction` on newer versions; fall back to a
      // probe that is harmless when no transaction is open.
      const probe = inner as unknown as { isTransaction?: boolean };
      if (typeof probe.isTransaction === 'boolean') return probe.isTransaction;
      try {
        inner.exec('BEGIN');
        inner.exec('ROLLBACK');
        return false;
      } catch {
        return true;
      }
    },
    close() {
      inner.close();
    },
  };
}
