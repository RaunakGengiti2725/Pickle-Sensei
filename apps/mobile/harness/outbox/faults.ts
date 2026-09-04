import type { LocalDb } from '../../src/data/db';
import { normalizeSql } from './durableStore';

/**
 * Single-shot storage fault injection: the Nth statement matching a pattern
 * throws a SQLite-style error BEFORE reaching the backend, exactly as a
 * driver failure would surface to repository.ts / sync.ts. The transaction
 * state of the underlying store is untouched, so the production ROLLBACK
 * path is what decides what survives.
 */

export type FaultTarget =
  | 'begin'
  | 'commit'
  | 'insert_receipt'
  | 'delete_outbox'
  | 'update_outbox'
  | 'insert_outbox'
  | 'insert_local_shot'
  | 'insert_local_session'
  | 'select_outbox';

export interface FaultPlan {
  target: FaultTarget;
  /** 1-based occurrence of the matching statement that fails. */
  nth: number;
  message: string;
}

export const FAULT_MESSAGES = [
  'disk I/O error',
  'database is locked',
  'database or disk is full',
  'attempt to write a readonly database',
] as const;

function matches(target: FaultTarget, sql: string): boolean {
  switch (target) {
    case 'begin':
      return sql === 'BEGIN IMMEDIATE';
    case 'commit':
      return sql === 'COMMIT';
    case 'insert_receipt':
      return sql.startsWith('INSERT OR REPLACE INTO sync_receipt');
    case 'delete_outbox':
      return sql.startsWith(
        'DELETE FROM outbox WHERE owner_key = ? AND id = ?',
      );
    case 'update_outbox':
      return sql.startsWith('UPDATE outbox SET');
    case 'insert_outbox':
      return sql.startsWith('INSERT INTO outbox');
    case 'insert_local_shot':
      return sql.startsWith('INSERT OR REPLACE INTO local_shot');
    case 'insert_local_session':
      return sql.startsWith('INSERT OR REPLACE INTO local_session');
    case 'select_outbox':
      return sql.startsWith('SELECT id, kind, payload, attempts FROM outbox');
    default:
      return false;
  }
}

export interface FaultInjector {
  db: LocalDb;
  arm(plan: FaultPlan): void;
  /** The plan fired (or null if it was never reached). */
  fired(): FaultPlan | null;
  clear(): void;
}

export function withFaults(inner: LocalDb): FaultInjector {
  let plan: FaultPlan | null = null;
  let seen = 0;
  let fired: FaultPlan | null = null;
  const db: LocalDb = {
    async execute(sql, params) {
      if (plan) {
        if (matches(plan.target, normalizeSql(sql))) {
          seen += 1;
          if (seen === plan.nth) {
            fired = plan;
            plan = null;
            throw new Error(fired.message);
          }
        }
      }
      return inner.execute(sql, params);
    },
    close: () => inner.close(),
  };
  return {
    db,
    arm(next) {
      plan = next;
      seen = 0;
      fired = null;
    },
    fired: () => fired,
    clear() {
      plan = null;
      seen = 0;
      fired = null;
    },
  };
}
