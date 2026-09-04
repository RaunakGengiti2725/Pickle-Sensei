/**
 * In-memory LocalDb sufficient for drainOutbox(): outbox rows, sync receipts
 * and the transaction statements. Mirrors the fake used by __tests__/sync.test.ts
 * but additionally records EVERY statement so a drain can be audited for the
 * exact receipt/delete sequence (duplicate-response idempotence).
 *
 * Test-only harness; never imported by production code.
 */
import type { LocalDb } from '../../src/data/db';

export interface FakeOutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export interface FakeOutboxDb {
  db: LocalDb;
  outbox: FakeOutboxRow[];
  receipts: Array<{ owner: string; kind: string; entityId: string }>;
  statements: string[];
  push(kind: string, payload: unknown, owner: string): number;
  snapshot(): Array<
    Pick<FakeOutboxRow, 'id' | 'kind' | 'attempts' | 'last_error'>
  >;
}

export function createFakeOutboxDb(): FakeOutboxDb {
  const outbox: FakeOutboxRow[] = [];
  const receipts: FakeOutboxDb['receipts'] = [];
  const statements: string[] = [];
  let nextId = 1;

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push({
          owner: String(params[0]),
          kind: 'shot.sync',
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (sql.trimStart().startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              row =>
                row.owner_key === String(params[0]) &&
                row.attempts < Number(params[1]),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(row => ({ ...row })),
        };
      }
      if (sql.trimStart().startsWith('DELETE FROM outbox')) {
        const index = outbox.findIndex(
          row => row.owner_key === params[0] && row.id === params[1],
        );
        if (index >= 0) outbox.splice(index, 1);
        return { rows: [] };
      }
      if (sql.trimStart().startsWith('UPDATE outbox')) {
        const row = outbox.find(
          candidate =>
            candidate.owner_key === params[1] && candidate.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.trimStart().startsWith('SELECT ls.id AS id FROM local_session')) {
        // No local_session rows exist in this fake: no parked set to re-queue.
        return { rows: [] };
      }
      if (sql.trimStart().startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`outboxFakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };

  return {
    db,
    outbox,
    receipts,
    statements,
    push(kind, payload, owner) {
      const id = nextId++;
      outbox.push({
        id,
        owner_key: owner,
        kind,
        payload: JSON.stringify(payload),
        attempts: 0,
        last_error: null,
      });
      return id;
    },
    snapshot: () =>
      outbox.map(row => ({
        id: row.id,
        kind: row.kind,
        attempts: row.attempts,
        last_error: row.last_error,
      })),
  };
}
