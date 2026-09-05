/**
 * Two `LocalDb` backends for the outbox stress harness.
 *
 *   - `createModelOutboxDb()` — in-memory reference store. Implements exactly
 *     the SQL `drainOutbox()` issues (src/data/sync.ts) with SQLite's
 *     single-connection transaction semantics: `BEGIN IMMEDIATE` inside an
 *     open transaction throws, `COMMIT`/`ROLLBACK` without one throws,
 *     `ROLLBACK` restores the snapshot taken at `BEGIN` (including statements
 *     another interleaved drain slipped into the open transaction).
 *   - `createSqliteOutboxDb(sqlite)` — the REAL SQLite engine through
 *     `node:sqlite` (Node 22, `--experimental-sqlite` on 22.5–22.12), schema
 *     copied verbatim from src/data/db.ts LOCAL_MIGRATIONS for `outbox` and
 *     `sync_receipt`.
 *
 * Both record every statement, expose the durable state for the model
 * checker, take one-shot fault injections (the N-th matching statement throws
 * BEFORE executing, like a driver error), and yield to the microtask queue on
 * every statement so two concurrently awaited drains interleave
 * deterministically.
 *
 * Test-only harness; never imported by production code.
 */
import type { LocalDb } from '../../../src/data/db';
import type {
  SqlInputValue,
  SqliteDatabaseSync,
  NodeSqlite,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';

export interface OutboxRowState {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export interface ReceiptState {
  owner_key: string;
  kind: string;
  entity_id: string;
}

export interface StressDb {
  readonly name: 'model' | 'sqlite';
  db: LocalDb;
  /** Every statement executed (whitespace-normalised), in order. */
  statements: string[];
  rows(): OutboxRowState[];
  receipts(): ReceiptState[];
  /** Direct insert (what repository.ts / practiceSet.ts would have written). */
  insert(
    owner: string,
    kind: string,
    payload: string,
    attempts?: number,
  ): number;
  /** The next statement whose SQL contains `needle` throws `error` instead. */
  failNext(needle: string, error: Error): void;
  /** Faults armed but not yet consumed. */
  pendingFaults(): number;
  clearFaults(): void;
  inTransaction(): boolean;
  close(): void;
}

export const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, ' ').trim();

const yieldMicrotask = (): Promise<void> => Promise.resolve();

interface Fault {
  needle: string;
  error: Error;
}

function takeFault(pending: Fault[], sql: string): Error | null {
  const index = pending.findIndex(fault => sql.includes(fault.needle));
  if (index < 0) return null;
  const [fault] = pending.splice(index, 1);
  return fault ? fault.error : null;
}

export function createModelOutboxDb(): StressDb {
  let outbox: OutboxRowState[] = [];
  let receipts: ReceiptState[] = [];
  const statements: string[] = [];
  const pending: Fault[] = [];
  let nextId = 1;
  let snapshot: { outbox: OutboxRowState[]; receipts: ReceiptState[] } | null =
    null;
  let closed = false;

  const clone = () => ({
    outbox: outbox.map(row => ({ ...row })),
    receipts: receipts.map(receipt => ({ ...receipt })),
  });

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (closed) throw new Error('model db: closed');
      const normalized = normalizeSql(sql);
      statements.push(normalized);
      await yieldMicrotask();
      const fault = takeFault(pending, normalized);
      if (fault) throw fault;
      if (normalized === 'BEGIN IMMEDIATE') {
        if (snapshot) {
          throw new Error('cannot start a transaction within a transaction');
        }
        snapshot = clone();
        return { rows: [] };
      }
      if (normalized === 'COMMIT') {
        if (!snapshot)
          throw new Error('cannot commit - no transaction is active');
        snapshot = null;
        return { rows: [] };
      }
      if (normalized === 'ROLLBACK') {
        if (!snapshot) {
          throw new Error('cannot rollback - no transaction is active');
        }
        outbox = snapshot.outbox;
        receipts = snapshot.receipts;
        snapshot = null;
        return { rows: [] };
      }
      for (const value of params) {
        if (value === undefined) {
          throw new TypeError(
            'Provided value cannot be bound to SQLite parameter.',
          );
        }
      }
      if (normalized.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
        const owner = String(params[0]);
        const entity = String(params[1]);
        receipts = receipts.filter(
          receipt =>
            !(
              receipt.owner_key === owner &&
              receipt.kind === 'shot.sync' &&
              receipt.entity_id === entity
            ),
        );
        receipts.push({
          owner_key: owner,
          kind: 'shot.sync',
          entity_id: entity,
        });
        return { rows: [] };
      }
      if (
        normalized.startsWith('SELECT id, kind, payload, attempts FROM outbox')
      ) {
        const owner = String(params[0]);
        const max = Number(params[1]);
        return {
          rows: outbox
            .filter(row => row.owner_key === owner && row.attempts < max)
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(row => ({
              id: row.id,
              kind: row.kind,
              payload: row.payload,
              attempts: row.attempts,
            })),
        };
      }
      if (
        normalized.startsWith(
          'DELETE FROM outbox WHERE owner_key = ? AND id = ?',
        )
      ) {
        outbox = outbox.filter(
          row => !(row.owner_key === params[0] && row.id === params[1]),
        );
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE outbox SET')) {
        const bump = normalized.includes('attempts = attempts + 1');
        for (const row of outbox) {
          if (row.owner_key === params[1] && row.id === params[2]) {
            if (bump) row.attempts += 1;
            row.last_error = String(params[0]);
          }
        }
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT count(*) AS n FROM outbox')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`model db: unhandled sql ${normalized}`);
    },
    close() {
      closed = true;
    },
  };

  return {
    name: 'model',
    db,
    statements,
    rows: () => outbox.map(row => ({ ...row })).sort((a, b) => a.id - b.id),
    receipts: () => receipts.map(receipt => ({ ...receipt })),
    insert(owner, kind, payload, attempts = 0) {
      const id = nextId++;
      outbox.push({
        id,
        owner_key: owner,
        kind,
        payload,
        attempts,
        last_error: null,
      });
      return id;
    },
    failNext(needle, error) {
      pending.push({ needle, error });
    },
    pendingFaults: () => pending.length,
    clearFaults: () => {
      pending.length = 0;
    },
    inTransaction: () => snapshot !== null,
    close: () => db.close(),
  };
}

const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`;
const RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id)
   )`;

export function createSqliteOutboxDb(sqlite: NodeSqlite): StressDb {
  const inner: SqliteDatabaseSync = new sqlite.DatabaseSync(':memory:');
  inner.exec(OUTBOX_SCHEMA);
  inner.exec(RECEIPT_SCHEMA);
  inner.exec(
    'CREATE INDEX IF NOT EXISTS idx_outbox_owner_created ON outbox (owner_key, created_at, id)',
  );
  const statements: string[] = [];
  const pending: Fault[] = [];
  let depth = 0;

  const run = (sql: string, params: unknown[]) =>
    inner.prepare(sql).all(...(params as SqlInputValue[])) as Record<
      string,
      unknown
    >[];

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      const normalized = normalizeSql(sql);
      statements.push(normalized);
      await yieldMicrotask();
      const fault = takeFault(pending, normalized);
      if (fault) throw fault;
      const rows = run(sql, params);
      if (normalized === 'BEGIN IMMEDIATE') depth += 1;
      if (normalized === 'COMMIT' || normalized === 'ROLLBACK') depth -= 1;
      return { rows };
    },
    close() {
      inner.close();
    },
  };

  return {
    name: 'sqlite',
    db,
    statements,
    rows: () =>
      run(
        'SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id ASC',
        [],
      ).map(row => ({
        id: Number(row['id']),
        owner_key: String(row['owner_key']),
        kind: String(row['kind']),
        payload: String(row['payload']),
        attempts: Number(row['attempts']),
        last_error:
          row['last_error'] === null ? null : String(row['last_error']),
      })),
    receipts: () =>
      run(
        'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY rowid ASC',
        [],
      ).map(row => ({
        owner_key: String(row['owner_key']),
        kind: String(row['kind']),
        entity_id: String(row['entity_id']),
      })),
    insert(owner, kind, payload, attempts = 0) {
      run(
        'INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, ?, ?, ?)',
        [owner, kind, payload, attempts],
      );
      const [row] = run('SELECT last_insert_rowid() AS id', []);
      return Number(row?.['id']);
    },
    failNext(needle, error) {
      pending.push({ needle, error });
    },
    pendingFaults: () => pending.length,
    clearFaults: () => {
      pending.length = 0;
    },
    inTransaction: () => depth > 0,
    close: () => db.close(),
  };
}
