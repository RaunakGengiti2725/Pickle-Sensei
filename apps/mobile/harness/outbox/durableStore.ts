import type { LocalDb } from '../../src/data/db';

/**
 * Backend-neutral view of the durable tables the outbox state machine touches.
 * Both harness backends (independent in-memory model, real SQLite through
 * node:sqlite) expose the same snapshot so invariants are checked identically
 * and the two can be diffed against each other.
 */

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

export interface LocalShotSnapshot {
  owner_key: string;
  id: string;
  session_id: string | null;
  result_kind: string;
  source: string;
  payload: string;
}

export interface LocalSessionSnapshot {
  owner_key: string;
  id: string;
  mode: string;
  shot_type: string | null;
  focus_checkpoint: string | null;
  started_at: string;
  completed: number;
  summary: string | null;
}

export interface DurableSnapshot {
  outbox: OutboxRowSnapshot[];
  receipts: ReceiptSnapshot[];
  shots: LocalShotSnapshot[];
  sessions: LocalSessionSnapshot[];
  kv: Array<{ key: string; value: string }>;
  /** sqlite_sequence value for outbox (or the model's equivalent). */
  outboxSequence: number;
}

export type HarnessBackend = 'memory' | 'sqlite';

export interface HarnessDb {
  backend: HarnessBackend;
  db: LocalDb;
  snapshot(): DurableSnapshot;
  /** Overwrite one outbox payload in place (disk-corruption model). */
  corruptOutboxPayload(id: number, payload: string): void;
  close(): void;
  /** Total execute() calls observed, for the per-sequence statement matrix. */
  statementCount(): number;
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Canonical ordering so snapshots from the two backends compare equal. */
export function canonicalSnapshot(s: DurableSnapshot): DurableSnapshot {
  const byKey = <T>(items: T[], key: (item: T) => string): T[] =>
    [...items].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return {
    outbox: [...s.outbox].sort((x, y) => x.id - y.id),
    receipts: byKey(s.receipts, r => `${r.owner_key}|${r.kind}|${r.entity_id}`),
    shots: byKey(s.shots, r => `${r.owner_key}|${r.id}`),
    sessions: byKey(s.sessions, r => `${r.owner_key}|${r.id}`),
    kv: byKey(s.kv, r => r.key),
    outboxSequence: s.outboxSequence,
  };
}
