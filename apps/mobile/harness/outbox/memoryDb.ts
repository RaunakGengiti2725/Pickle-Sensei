import type { LocalDb } from '../../src/data/db';
import {
  normalizeSql,
  type DurableSnapshot,
  type HarnessDb,
  type LocalSessionSnapshot,
  type LocalShotSnapshot,
  type OutboxRowSnapshot,
  type ReceiptSnapshot,
} from './durableStore';

/**
 * Independent in-memory model of the SQLite statements issued by
 * src/data/repository.ts, src/data/sync.ts and src/evaluation/trialCapture.ts.
 *
 * Deliberately NOT shared with any existing test fake: it models AUTOINCREMENT
 * (ids never reused after delete), INSERT OR REPLACE primary-key semantics,
 * json_extract on the shot payload, and real BEGIN/COMMIT/ROLLBACK by
 * snapshotting the whole store at BEGIN and restoring it on ROLLBACK. Any
 * statement it does not recognise throws, so a new production query cannot
 * silently pass as a no-op.
 */

interface Tables {
  outbox: OutboxRowSnapshot[];
  receipts: ReceiptSnapshot[];
  shots: LocalShotSnapshot[];
  sessions: LocalSessionSnapshot[];
  kv: Array<{ key: string; value: string }>;
  sequence: number;
}

function cloneTables(t: Tables): Tables {
  return {
    outbox: t.outbox.map(r => ({ ...r })),
    receipts: t.receipts.map(r => ({ ...r })),
    shots: t.shots.map(r => ({ ...r })),
    sessions: t.sessions.map(r => ({ ...r })),
    kv: t.kv.map(r => ({ ...r })),
    sequence: t.sequence,
  };
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new Error(`memoryDb: expected text parameter, got ${typeof value}`);
}

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return str(value);
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(+value)) {
    return Number(value);
  }
  throw new Error(`memoryDb: expected numeric parameter, got ${String(value)}`);
}

function jsonExtractId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' ? id : id == null ? null : String(id);
  } catch (error) {
    throw new Error(`malformed JSON: ${String(error)}`);
  }
}

export function createMemoryDb(): HarnessDb {
  let tables: Tables = {
    outbox: [],
    receipts: [],
    shots: [],
    sessions: [],
    kv: [],
    sequence: 0,
  };
  let savepoint: Tables | null = null;
  let statements = 0;

  const execute: LocalDb['execute'] = async (rawSql, params = []) => {
    statements += 1;
    const sql = normalizeSql(rawSql);

    if (sql === 'BEGIN IMMEDIATE') {
      if (savepoint)
        throw new Error('cannot start a transaction within a transaction');
      savepoint = cloneTables(tables);
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      if (!savepoint)
        throw new Error('cannot commit - no transaction is active');
      savepoint = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (!savepoint)
        throw new Error('cannot rollback - no transaction is active');
      tables = savepoint;
      savepoint = null;
      return { rows: [] };
    }

    if (
      sql.startsWith('INSERT INTO outbox (owner_key, kind, payload) VALUES (?,')
    ) {
      const kindMatch = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql);
      if (!kindMatch || kindMatch[1] === undefined) {
        throw new Error(`memoryDb: unparseable outbox insert ${sql}`);
      }
      tables.sequence += 1;
      tables.outbox.push({
        id: tables.sequence,
        owner_key: str(params[0]),
        kind: kindMatch[1],
        payload: str(params[1]),
        attempts: 0,
        last_error: null,
      });
      return { rows: [] };
    }

    if (sql.startsWith('INSERT OR REPLACE INTO local_shot')) {
      const row: LocalShotSnapshot = {
        owner_key: str(params[0]),
        id: str(params[1]),
        session_id: nullableStr(params[2]),
        result_kind: str(params[7]),
        source: str(params[8]),
        payload: str(params[9]),
      };
      tables.shots = tables.shots.filter(
        s => !(s.owner_key === row.owner_key && s.id === row.id),
      );
      tables.shots.push(row);
      return { rows: [] };
    }

    if (sql.startsWith('INSERT OR REPLACE INTO local_session')) {
      const row: LocalSessionSnapshot = {
        owner_key: str(params[0]),
        id: str(params[1]),
        mode: str(params[2]),
        shot_type: nullableStr(params[3]),
        focus_checkpoint: nullableStr(params[4]),
        started_at: str(params[5]),
        completed: 0,
        summary: null,
      };
      tables.sessions = tables.sessions.filter(
        s => !(s.owner_key === row.owner_key && s.id === row.id),
      );
      tables.sessions.push(row);
      return { rows: [] };
    }

    if (sql.startsWith('UPDATE local_session SET ended_at =')) {
      const summary = str(params[0]);
      const owner = str(params[1]);
      const id = str(params[2]);
      for (const s of tables.sessions) {
        if (s.owner_key === owner && s.id === id) {
          s.completed = 1;
          s.summary = summary;
        }
      }
      return { rows: [] };
    }

    if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
      const receipt: ReceiptSnapshot = {
        owner_key: str(params[0]),
        kind: 'shot.sync',
        entity_id: str(params[1]),
      };
      tables.receipts = tables.receipts.filter(
        r =>
          !(
            r.owner_key === receipt.owner_key &&
            r.kind === receipt.kind &&
            r.entity_id === receipt.entity_id
          ),
      );
      tables.receipts.push(receipt);
      return { rows: [] };
    }

    if (
      sql.startsWith(
        'SELECT id, kind, payload, attempts FROM outbox WHERE owner_key = ? AND attempts < ? ORDER BY id ASC LIMIT 50',
      )
    ) {
      const owner = str(params[0]);
      const cap = num(params[1]);
      const rows = tables.outbox
        .filter(r => r.owner_key === owner && r.attempts < cap)
        .sort((x, y) => x.id - y.id)
        .slice(0, 50)
        .map(r => ({
          id: r.id,
          kind: r.kind,
          payload: r.payload,
          attempts: r.attempts,
        }));
      return { rows };
    }

    if (
      sql.startsWith(
        "SELECT id, attempts, payload FROM outbox WHERE owner_key = ? AND kind = 'session.create' ORDER BY id ASC",
      )
    ) {
      const owner = str(params[0]);
      const rows = tables.outbox
        .filter(r => r.owner_key === owner && r.kind === 'session.create')
        .sort((x, y) => x.id - y.id)
        .map(r => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
      return { rows };
    }

    if (
      sql.startsWith(
        'SELECT id, mode, shot_type, focus_checkpoint, started_at FROM local_session WHERE owner_key = ? AND id = ?',
      )
    ) {
      const owner = str(params[0]);
      const id = str(params[1]);
      const rows = tables.sessions
        .filter(s => s.owner_key === owner && s.id === id)
        .map(s => ({
          id: s.id,
          mode: s.mode,
          shot_type: s.shot_type,
          focus_checkpoint: s.focus_checkpoint,
          started_at: s.started_at,
        }));
      return { rows };
    }

    if (
      sql.startsWith(
        'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE owner_key = ? AND id = ?',
      )
    ) {
      const owner = str(params[1]);
      const id = num(params[2]);
      for (const r of tables.outbox) {
        if (r.owner_key === owner && r.id === id) {
          r.attempts += 1;
          r.last_error = str(params[0]);
        }
      }
      return { rows: [] };
    }

    if (
      sql.startsWith(
        'UPDATE outbox SET last_error = ? WHERE owner_key = ? AND id = ?',
      )
    ) {
      const owner = str(params[1]);
      const id = num(params[2]);
      for (const r of tables.outbox) {
        if (r.owner_key === owner && r.id === id) r.last_error = str(params[0]);
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM outbox WHERE owner_key = ? AND id = ?') {
      const owner = str(params[0]);
      const id = num(params[1]);
      tables.outbox = tables.outbox.filter(
        r => !(r.owner_key === owner && r.id === id),
      );
      return { rows: [] };
    }

    if (sql === 'SELECT count(*) AS n FROM outbox WHERE owner_key = ?') {
      const owner = str(params[0]);
      return {
        rows: [{ n: tables.outbox.filter(r => r.owner_key === owner).length }],
      };
    }

    if (
      sql.startsWith(
        "SELECT attempts, last_error FROM outbox WHERE owner_key = ? AND kind = 'shot.sync' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1",
      )
    ) {
      const owner = str(params[0]);
      const shotId = str(params[1]);
      const matches = tables.outbox
        .filter(r => r.owner_key === owner && r.kind === 'shot.sync')
        .filter(r => jsonExtractId(r.payload) === shotId)
        .sort((x, y) => y.id - x.id);
      const top = matches[0];
      return {
        rows: top
          ? [{ attempts: top.attempts, last_error: top.last_error }]
          : [],
      };
    }

    if (
      sql.startsWith(
        "SELECT 1 FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync' AND entity_id = ? LIMIT 1",
      )
    ) {
      const owner = str(params[0]);
      const entity = str(params[1]);
      const hit = tables.receipts.some(
        r =>
          r.owner_key === owner &&
          r.kind === 'shot.sync' &&
          r.entity_id === entity,
      );
      return { rows: hit ? [{ '1': 1 }] : [] };
    }

    const purge =
      /^DELETE FROM (local_shot|local_session|local_capture|local_analysis_record|outbox|sync_receipt) WHERE owner_key = \?$/.exec(
        sql,
      );
    if (purge) {
      const owner = str(params[0]);
      switch (purge[1]) {
        case 'local_shot':
          tables.shots = tables.shots.filter(r => r.owner_key !== owner);
          break;
        case 'local_session':
          tables.sessions = tables.sessions.filter(r => r.owner_key !== owner);
          break;
        case 'outbox':
          tables.outbox = tables.outbox.filter(r => r.owner_key !== owner);
          break;
        case 'sync_receipt':
          tables.receipts = tables.receipts.filter(r => r.owner_key !== owner);
          break;
        default:
          break;
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM kv WHERE key = ?') {
      const key = str(params[0]);
      tables.kv = tables.kv.filter(r => r.key !== key);
      return { rows: [] };
    }
    if (sql === 'SELECT value FROM kv WHERE key = ?') {
      const key = str(params[0]);
      const hit = tables.kv.find(r => r.key === key);
      return { rows: hit ? [{ value: hit.value }] : [] };
    }
    if (sql === 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)') {
      const key = str(params[0]);
      tables.kv = tables.kv.filter(r => r.key !== key);
      tables.kv.push({ key, value: str(params[1]) });
      return { rows: [] };
    }

    throw new Error(`memoryDb: unhandled sql ${sql}`);
  };

  return {
    backend: 'memory',
    db: { execute, close() {} },
    snapshot(): DurableSnapshot {
      const t = cloneTables(tables);
      return {
        outbox: t.outbox,
        receipts: t.receipts,
        shots: t.shots,
        sessions: t.sessions,
        kv: t.kv,
        outboxSequence: t.sequence,
      };
    },
    corruptOutboxPayload(id, payload) {
      for (const r of tables.outbox) if (r.id === id) r.payload = payload;
    },
    close() {},
    statementCount: () => statements,
  };
}
