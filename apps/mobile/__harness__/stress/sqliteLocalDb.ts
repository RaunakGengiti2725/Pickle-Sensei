/**
 * Real-SQLite `LocalDb` for the outbox stress campaigns.
 *
 * `node:sqlite` (in-memory, WAL-less) executes the exact statements
 * `drainOutbox()` issues, so transaction semantics (BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK, "cannot start a transaction within a transaction", PRIMARY KEY
 * upserts) are the engine's, not a fake's. The async `execute` yields to the
 * event loop before every statement — the same shape as op-sqlite's promise
 * API — so two concurrent drains interleave statement by statement, and a
 * seeded scheduler decides the interleaving.
 *
 * Faults are injected per statement CLASS (see `classifyStatement`) and
 * per occurrence (`nth`, 1-based, counted per class within one db):
 *   throw          reject before running the statement
 *   throw_after    run the statement, then reject (a driver that did the work
 *                  but reported an error — e.g. a JSI bridge timeout)
 *   busy_once      reject with SQLITE_BUSY once, then behave (the fault is
 *                  consumed)
 *   malformed_rows run the statement, then corrupt the returned rows
 *                  (missing / mistyped columns)
 *   slow           run the statement after a short real delay
 *   hang           never settle (the drain must be raced with a deadline)
 */
import type { LocalDb } from '../../src/data/db';
import {
  loadNodeSqlite,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const setImmediate: (callback: () => void) => unknown;
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** The two tables `drainOutbox()` touches, copied verbatim from
 * `src/data/db.ts` LOCAL_MIGRATIONS (the production DDL). */
export const OUTBOX_DDL = [
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
];

export type StatementClass =
  | 'select_batch'
  | 'update_row'
  | 'delete_row'
  | 'begin'
  | 'insert_receipt'
  | 'commit'
  | 'rollback'
  | 'count_remaining'
  | 'other';

export const STATEMENT_CLASSES: readonly StatementClass[] = [
  'select_batch',
  'update_row',
  'delete_row',
  'begin',
  'insert_receipt',
  'commit',
  'rollback',
  'count_remaining',
];

export function classifyStatement(sql: string): StatementClass {
  const text = sql.trim().replace(/\s+/g, ' ').toUpperCase();
  if (text.startsWith('SELECT ID, KIND, PAYLOAD, ATTEMPTS FROM OUTBOX'))
    return 'select_batch';
  if (text.startsWith('SELECT COUNT(*) AS N FROM OUTBOX'))
    return 'count_remaining';
  if (text.startsWith('UPDATE OUTBOX SET')) return 'update_row';
  if (text.startsWith('DELETE FROM OUTBOX')) return 'delete_row';
  if (text.startsWith('BEGIN')) return 'begin';
  if (text.startsWith('INSERT OR REPLACE INTO SYNC_RECEIPT'))
    return 'insert_receipt';
  if (text.startsWith('COMMIT')) return 'commit';
  if (text.startsWith('ROLLBACK')) return 'rollback';
  return 'other';
}

export type DbFaultMode =
  'throw' | 'throw_after' | 'busy_once' | 'malformed_rows' | 'slow' | 'hang';

export const DB_FAULT_MODES: readonly DbFaultMode[] = [
  'throw',
  'throw_after',
  'busy_once',
  'malformed_rows',
  'slow',
];

export interface DbFault {
  statement: StatementClass;
  mode: DbFaultMode;
  /** 1-based occurrence of the statement class that trips the fault. */
  nth: number;
}

export type YieldMode = 'none' | 'micro' | 'macro' | 'mixed';

export interface SqliteStressDbOptions {
  /** Seeded source for scheduling decisions (mixed yields, slow delays). */
  rng?: () => number;
  yieldMode?: YieldMode;
  faults?: DbFault[];
  /** Fires when a `hang` fault swallows a statement (the drain cannot progress). */
  onHang?: () => void;
}

export interface OutboxRowSnapshot {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export interface ReceiptSnapshot {
  owner_key: string;
  kind: string;
  entity_id: string;
}

export class SqliteFaultError extends Error {
  constructor(
    readonly statement: StatementClass,
    readonly mode: DbFaultMode,
    readonly nth: number,
  ) {
    super(`injected sqlite fault: ${mode} on ${statement} #${nth}`);
    this.name = 'SqliteFaultError';
  }
}

export class SqliteBusyError extends Error {
  constructor(readonly statement: StatementClass) {
    super('database is locked');
    this.name = 'SqliteBusyError';
  }
}

export class SqliteStressDb implements LocalDb {
  readonly statements: Array<{ sql: string; class: StatementClass }> = [];
  readonly firedFaults: DbFault[] = [];
  private readonly inner: SqliteDatabaseSync;
  private readonly counts = new Map<StatementClass, number>();
  private readonly consumed = new Set<DbFault>();
  private readonly rng: () => number;
  private readonly yieldMode: YieldMode;
  private readonly faults: DbFault[];
  private readonly onHang: (() => void) | undefined;
  private closed = false;

  constructor(options: SqliteStressDbOptions = {}) {
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      throw new Error(
        'node:sqlite is unavailable on this Node — the outbox stress suite needs Node >= 22.13 (apps/mobile engines).',
      );
    }
    this.inner = new sqlite.DatabaseSync(':memory:');
    for (const ddl of OUTBOX_DDL) this.inner.exec(ddl);
    this.rng = options.rng ?? (() => 0.5);
    this.yieldMode = options.yieldMode ?? 'micro';
    this.faults = [...(options.faults ?? [])];
    this.onHang = options.onHang;
  }

  /** Errors SQLite itself raised (not injected), as `<class>: <message>`. */
  readonly engineErrors: string[] = [];

  /** Statements issued so far, in order, as their class names. */
  classes(): StatementClass[] {
    return this.statements.map(statement => statement.class);
  }

  /** Drops every pending fault (the "storage recovered" phase). */
  clearFaults(): void {
    this.faults.length = 0;
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    await this.yield();
    const statementClass = classifyStatement(sql);
    const nth = (this.counts.get(statementClass) ?? 0) + 1;
    this.counts.set(statementClass, nth);
    this.statements.push({ sql, class: statementClass });
    const fault = this.faults.find(
      candidate =>
        candidate.statement === statementClass &&
        candidate.nth === nth &&
        !this.consumed.has(candidate),
    );
    if (!fault) return this.run(sql, params);
    this.firedFaults.push(fault);
    switch (fault.mode) {
      case 'throw':
        throw new SqliteFaultError(statementClass, fault.mode, nth);
      case 'busy_once':
        this.consumed.add(fault);
        throw new SqliteBusyError(statementClass);
      case 'hang':
        this.onHang?.();
        return new Promise(() => {});
      case 'slow': {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 1 + Math.floor(this.rng() * 8));
        });
        return this.run(sql, params);
      }
      case 'throw_after': {
        this.run(sql, params);
        throw new SqliteFaultError(statementClass, fault.mode, nth);
      }
      case 'malformed_rows': {
        const { rows } = this.run(sql, params);
        return { rows: rows.map(row => corruptRow(row, this.rng)) };
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.close();
  }

  // ── inspection (synchronous, bypasses faults and the statement log) ──────

  isInTransaction(): boolean {
    // `BEGIN` fails iff a transaction is already open; probe and undo.
    try {
      this.inner.exec('BEGIN');
    } catch {
      return true;
    }
    this.inner.exec('ROLLBACK');
    return false;
  }

  /**
   * Rolls back an open transaction the way a process death would: whatever
   * the parked drain wrote inside BEGIN never becomes durable. Returns
   * whether a transaction was open.
   */
  abortOpenTransaction(): boolean {
    if (!this.isInTransaction()) return false;
    this.inner.exec('ROLLBACK');
    return true;
  }

  integrityCheck(): string {
    const row = this.inner.prepare('PRAGMA integrity_check').get() as Record<
      string,
      unknown
    >;
    return String(row['integrity_check']);
  }

  outboxRows(): OutboxRowSnapshot[] {
    return this.inner
      .prepare(
        'SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id ASC',
      )
      .all() as OutboxRowSnapshot[];
  }

  receipts(): ReceiptSnapshot[] {
    return this.inner
      .prepare(
        'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY owner_key, kind, entity_id',
      )
      .all() as ReceiptSnapshot[];
  }

  /** Direct insert used by the queue builders (never routed through faults). */
  insertOutboxRow(row: {
    owner: string;
    kind: string;
    payload: string;
    attempts?: number;
  }): number {
    this.inner
      .prepare(
        'INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, ?, ?, ?)',
      )
      .run(row.owner, row.kind, row.payload, row.attempts ?? 0);
    const last = this.inner
      .prepare('SELECT last_insert_rowid() AS id')
      .get() as { id: number | bigint };
    return Number(last.id);
  }

  private run(
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[] } {
    try {
      const rows = this.inner
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      return { rows: rows.map(normalizeRow) };
    } catch (error) {
      this.engineErrors.push(
        `${classifyStatement(sql)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private yield(): Promise<void> {
    switch (this.yieldMode) {
      case 'none':
        return Promise.resolve();
      case 'micro':
        return Promise.resolve();
      case 'macro':
        return new Promise(resolve => setImmediate(resolve));
      case 'mixed': {
        // Only microtask / setImmediate yields: their relative order is
        // deterministic, so a seed replays identically. (setTimeout(0) vs
        // setImmediate ordering is not — it made replays flaky.)
        const roll = this.rng();
        if (roll < 0.34) return Promise.resolve();
        if (roll < 0.67) return new Promise(resolve => setImmediate(resolve));
        return new Promise(resolve => {
          setImmediate(() => setImmediate(resolve));
        });
      }
    }
  }
}

/** node:sqlite returns INTEGER as number (or bigint for large values); op-sqlite
 * returns number — normalise so `drainOutbox()` sees op-sqlite's shape. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

const CORRUPTIONS = [
  'drop_kind',
  'drop_payload',
  'null_id',
  'string_attempts',
  'object_payload',
  'empty_row',
] as const;

function corruptRow(
  row: Record<string, unknown>,
  rng: () => number,
): Record<string, unknown> {
  const pick = CORRUPTIONS[Math.floor(rng() * CORRUPTIONS.length)];
  const out = { ...row };
  switch (pick) {
    case 'drop_kind':
      delete out['kind'];
      break;
    case 'drop_payload':
      delete out['payload'];
      break;
    case 'null_id':
      out['id'] = null;
      break;
    case 'string_attempts':
      out['attempts'] = 'three';
      break;
    case 'object_payload':
      out['payload'] = { nested: true };
      break;
    case 'empty_row':
      return {};
    case undefined:
      break;
  }
  return out;
}
