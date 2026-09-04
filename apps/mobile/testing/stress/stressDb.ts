/**
 * In-memory `LocalDb` for concurrency stress runs.
 *
 * Differences from testing/xcBehavioral/fakeLocalDb:
 *  - every `execute` first parks on the seeded scheduler, so statements from
 *    concurrent callers interleave in scheduler order;
 *  - the connection is modelled as ONE SQLite connection (what `getDb()` hands
 *    out in production) with two selectable transaction semantics:
 *      'sqlite'     — `BEGIN` while a transaction is open throws
 *                     "cannot start a transaction within a transaction";
 *                     `COMMIT`/`ROLLBACK` without one throws "no transaction
 *                     is active". Statements outside a transaction autocommit.
 *                     (SQLite's documented behaviour for raw BEGIN/COMMIT on a
 *                     shared connection — INFERRED for op-sqlite, not verified
 *                     on device.)
 *      'serialized' — `BEGIN` waits for the open transaction to end (what a
 *                     connection-level transaction mutex would provide).
 *  - tables carry primary keys so `INSERT OR REPLACE` vs `INSERT` duplicate
 *    semantics are real, and reads (kv, session lookups) return live rows.
 *  - seeded fault injection by statement needle with an occurrence count.
 */
import type { LocalDb } from '../../src/data/db';
import type { StressScheduler } from './scheduler';

export type TxMode = 'sqlite' | 'serialized';

export interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}
export interface ShotRow {
  owner: string;
  id: string;
  sessionId: string | null;
  resultKind: string;
  payload: string;
}
export interface SessionRow {
  owner: string;
  id: string;
  mode: string;
  startedAt: string;
}
export interface CaptureRow {
  owner: string;
  id: string;
  status: string;
}
export interface RecordRow {
  owner: string;
  id: string;
  captureId: string | null;
}

export interface StatementLog {
  seq: number;
  sql: string;
  params: unknown[];
  /** Transaction ordinal the statement executed inside, or 0 when autocommit. */
  tx: number;
  error: string | null;
}

interface Snapshot {
  kv: Map<string, string>;
  shots: Map<string, ShotRow>;
  sessions: Map<string, SessionRow>;
  captures: Map<string, CaptureRow>;
  records: Map<string, RecordRow>;
  outbox: OutboxRow[];
  receipts: Set<string>;
  nextOutboxId: number;
}

export interface StressDb {
  db: LocalDb;
  txMode: TxMode;
  statements: StatementLog[];
  /** Committed (or autocommitted) state — what survives a process kill. */
  kv: Map<string, string>;
  shots: Map<string, ShotRow>;
  sessions: Map<string, SessionRow>;
  captures: Map<string, CaptureRow>;
  records: Map<string, RecordRow>;
  outbox: OutboxRow[];
  receipts: Set<string>;
  openTransactions(): number;
  /** How many times a `BEGIN` collided with an open transaction. */
  beginCollisions: number;
  /** How many times a COMMIT/ROLLBACK ran with no transaction active. */
  strayTxEnds: number;
  /**
   * ROLLBACKs that landed right after a BEGIN collision — in the
   * `inTransaction` pattern that is the collider's catch-path rollback, which
   * discards the OTHER caller's open transaction.
   */
  rollbacksAfterBeginCollision: number;
  /** Fail the n-th statement (1-based) whose SQL contains `needle`. */
  failNth(needle: string, nth: number, error?: Error): void;
  seedCapture(owner: string, id: string): void;
  outboxByKind(kind: string): OutboxRow[];
  shotRows(): ShotRow[];
  sessionRows(): SessionRow[];
}

const key = (owner: string, id: string): string => `${owner}\u0000${id}`;

export function createStressDb(
  scheduler: StressScheduler,
  txMode: TxMode,
): StressDb {
  const statements: StatementLog[] = [];
  const kv = new Map<string, string>();
  const shots = new Map<string, ShotRow>();
  const sessions = new Map<string, SessionRow>();
  const captures = new Map<string, CaptureRow>();
  const records = new Map<string, RecordRow>();
  const outbox: OutboxRow[] = [];
  const receipts = new Set<string>();
  let nextOutboxId = 1;
  let snapshot: Snapshot | null = null;
  let txOpen = false;
  let txOrdinal = 0;
  let collisionPending = false;
  let seq = 0;
  const faults: Array<{ needle: string; remaining: number; error: Error }> = [];
  const needleCounts = new Map<string, number>();
  const txQueue: Array<() => void> = [];

  const state: StressDb = {
    db: null as unknown as LocalDb,
    txMode,
    statements,
    kv,
    shots,
    sessions,
    captures,
    records,
    outbox,
    receipts,
    openTransactions: () => (txOpen ? 1 : 0),
    beginCollisions: 0,
    strayTxEnds: 0,
    rollbacksAfterBeginCollision: 0,
    failNth(needle, nth, error) {
      faults.push({
        needle,
        remaining: nth,
        error: error ?? new Error(`SQLITE_FULL: injected at ${needle}`),
      });
    },
    seedCapture(owner, id) {
      captures.set(key(owner, id), { owner, id, status: 'captured' });
    },
    outboxByKind: kind => outbox.filter(r => r.kind === kind),
    shotRows: () => [...shots.values()],
    sessionRows: () => [...sessions.values()],
  };

  function takeSnapshot(): Snapshot {
    return {
      kv: new Map(kv),
      shots: new Map(shots),
      sessions: new Map(sessions),
      captures: new Map(captures),
      records: new Map(records),
      outbox: outbox.map(r => ({ ...r })),
      receipts: new Set(receipts),
      nextOutboxId,
    };
  }
  function restore(s: Snapshot): void {
    kv.clear();
    for (const [k, v] of s.kv) kv.set(k, v);
    shots.clear();
    for (const [k, v] of s.shots) shots.set(k, v);
    sessions.clear();
    for (const [k, v] of s.sessions) sessions.set(k, v);
    captures.clear();
    for (const [k, v] of s.captures) captures.set(k, v);
    records.clear();
    for (const [k, v] of s.records) records.set(k, v);
    outbox.length = 0;
    outbox.push(...s.outbox);
    receipts.clear();
    for (const r of s.receipts) receipts.add(r);
    nextOutboxId = s.nextOutboxId;
  }

  function applyFault(sql: string): void {
    for (const f of faults) {
      if (f.remaining > 0 && sql.includes(f.needle)) {
        const seen = (needleCounts.get(f.needle) ?? 0) + 1;
        needleCounts.set(f.needle, seen);
        if (seen === f.remaining) {
          f.remaining = 0;
          throw f.error;
        }
      }
    }
  }

  async function execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const shortLabel = normalized.split(' ').slice(0, 4).join(' ');
    await scheduler.yieldAt(`sql:${shortLabel}`);
    if (normalized === 'BEGIN IMMEDIATE' && txOpen && txMode === 'serialized') {
      // Wait for the current transaction to end, then re-contend.
      await new Promise<void>(resolve => txQueue.push(resolve));
      await scheduler.yieldAt('sql:BEGIN IMMEDIATE(retry)');
      if (txOpen) return execute(sql, params);
    }
    const entry: StatementLog = {
      seq: ++seq,
      sql: normalized,
      params,
      tx: txOpen ? txOrdinal : 0,
      error: null,
    };
    statements.push(entry);
    try {
      applyFault(normalized);
      const rows = run(normalized, params);
      return { rows };
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  function endTransaction(): void {
    txOpen = false;
    snapshot = null;
    const next = txQueue.shift();
    if (next) next();
  }

  function run(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (sql === 'BEGIN IMMEDIATE' || sql === 'BEGIN') {
      if (txOpen) {
        state.beginCollisions += 1;
        collisionPending = true;
        throw new Error(
          'SQLITE_ERROR: cannot start a transaction within a transaction',
        );
      }
      txOpen = true;
      txOrdinal += 1;
      snapshot = takeSnapshot();
      return [];
    }
    if (sql === 'COMMIT') {
      if (!txOpen) {
        state.strayTxEnds += 1;
        throw new Error(
          'SQLITE_ERROR: cannot commit - no transaction is active',
        );
      }
      endTransaction();
      return [];
    }
    if (sql === 'ROLLBACK') {
      if (!txOpen) {
        state.strayTxEnds += 1;
        throw new Error(
          'SQLITE_ERROR: cannot rollback - no transaction is active',
        );
      }
      if (collisionPending) {
        state.rollbacksAfterBeginCollision += 1;
        collisionPending = false;
      }
      if (snapshot) restore(snapshot);
      endTransaction();
      return [];
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      kv.set(String(params[0]), String(params[1]));
      return [];
    }
    if (sql.startsWith('SELECT value FROM kv')) {
      const value = kv.get(String(params[0]));
      return value === undefined ? [] : [{ value }];
    }
    if (sql.startsWith('INSERT OR REPLACE INTO local_shot')) {
      const owner = String(params[0]);
      const id = String(params[1]);
      shots.set(key(owner, id), {
        owner,
        id,
        sessionId: params[2] == null ? null : String(params[2]),
        resultKind: String(params[7]),
        payload: String(params[9]),
      });
      return [];
    }
    if (sql.startsWith('INSERT OR REPLACE INTO local_session')) {
      const owner = String(params[0]);
      const id = String(params[1]);
      sessions.set(key(owner, id), {
        owner,
        id,
        mode: String(params[2]),
        startedAt: String(params[5]),
      });
      return [];
    }
    if (sql.startsWith('INSERT INTO outbox')) {
      const kindMatch = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql);
      outbox.push({
        id: nextOutboxId++,
        owner_key: String(params[0]),
        kind: kindMatch ? kindMatch[1]! : String(params[1]),
        payload: String(params[params.length - 1]),
        attempts: 0,
        last_error: null,
      });
      return [];
    }
    if (sql.startsWith('INSERT INTO local_analysis_record')) {
      const owner = String(params[0]);
      const id = String(params[1]);
      if (records.has(key(owner, id))) {
        throw new Error(
          'SQLITE_CONSTRAINT: UNIQUE constraint failed: local_analysis_record.owner_key, local_analysis_record.id',
        );
      }
      records.set(key(owner, id), {
        owner,
        id,
        captureId: typeof params[2] === 'string' ? params[2] : null,
      });
      return [];
    }
    if (sql.startsWith('INSERT INTO local_capture')) {
      const owner = String(params[0]);
      const id = String(params[1]);
      if (captures.has(key(owner, id))) {
        throw new Error(
          'SQLITE_CONSTRAINT: UNIQUE constraint failed: local_capture.owner_key, local_capture.id',
        );
      }
      captures.set(key(owner, id), { owner, id, status: 'captured' });
      return [];
    }
    if (sql.startsWith('UPDATE local_capture SET status')) {
      const statusMatch = /status = '([a-z_]+)'/.exec(sql);
      const owner = String(params[params.length - 2]);
      const id = String(params[params.length - 1]);
      const row = captures.get(key(owner, id));
      if (row && statusMatch) row.status = statusMatch[1]!;
      return [];
    }
    if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
      receipts.add(key(String(params[0]), String(params[1])));
      return [];
    }
    if (sql.startsWith('SELECT 1 FROM sync_receipt')) {
      return receipts.has(key(String(params[0]), String(params[1])))
        ? [{ '1': 1 }]
        : [];
    }
    if (sql.startsWith('DELETE FROM outbox')) {
      const idx = outbox.findIndex(
        r => r.owner_key === params[0] && r.id === params[1],
      );
      if (idx >= 0) outbox.splice(idx, 1);
      return [];
    }
    if (sql.startsWith('SELECT count(*)')) {
      return [{ n: outbox.filter(r => r.owner_key === params[0]).length }];
    }
    // Anything else (telemetry, history reads) is logged and answered empty.
    return [];
  }

  state.db = {
    execute: (sql, params = []) => execute(sql, params as unknown[]),
    close() {},
  };
  return state;
}
