/**
 * Adjudication helper: a real SQLite engine (node:sqlite) behind the
 * production `LocalDb` interface, with the production local schema for the
 * tables the sync/repository code touches. `execute` is genuinely async (one
 * macrotask hop per statement) so two callers can interleave on the single
 * connection exactly as they can on the op-sqlite connection in the app.
 *
 * Requires Node >= 22.13 or NODE_OPTIONS=--experimental-sqlite; fails loudly
 * otherwise (never a silent skip).
 */
import type { LocalDb } from '../../../src/data/db';

declare const require: (id: string) => unknown;

interface StatementSyncLike {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  exec(sql: string): void;
  close(): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
     result_kind TEXT NOT NULL, source TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL, PRIMARY KEY (owner_key, id))`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, kind TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id))`,
];

export interface SqlTrace {
  sql: string;
  outcome: 'ok' | 'error';
  error?: string;
}

export interface NodeSqliteLocalDb {
  db: LocalDb;
  trace: SqlTrace[];
  /** Invoked before a statement runs; may await to interleave other work. */
  beforeStatement: ((sql: string) => Promise<void> | void) | null;
  all(sql: string, params?: unknown[]): Record<string, unknown>[];
}

export function openNodeSqliteLocalDb(): NodeSqliteLocalDb {
  const mod = require('node:sqlite') as {
    DatabaseSync: new (p: string) => DatabaseSyncLike;
  };
  const raw = new mod.DatabaseSync(':memory:');
  for (const statement of SCHEMA) raw.exec(statement);
  const state: NodeSqliteLocalDb = {
    trace: [],
    beforeStatement: null,
    all: (sql, params = []) =>
      raw.prepare(sql).all(...(params as unknown[])) as Record<
        string,
        unknown
      >[],
    db: {
      async execute(sql, params = []) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (state.beforeStatement) await state.beforeStatement(sql);
        try {
          const trimmed = sql.trim().toUpperCase();
          if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
            const rows = raw
              .prepare(sql)
              .all(...(params as unknown[])) as Record<string, unknown>[];
            state.trace.push({ sql, outcome: 'ok' });
            return { rows };
          }
          raw.prepare(sql).run(...(params as unknown[]));
          state.trace.push({ sql, outcome: 'ok' });
          return { rows: [] };
        } catch (error) {
          state.trace.push({ sql, outcome: 'error', error: String(error) });
          throw error;
        }
      },
      close() {
        raw.close();
      },
    },
  };
  return state;
}
