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
  last_attempt_order: number;
  repair_reason: string | null;
}

export interface FakeOutboxDb {
  db: LocalDb;
  outbox: FakeOutboxRow[];
  receipts: Array<{ owner: string; kind: string; entityId: string }>;
  statements: string[];
  push(kind: string, payload: unknown, owner: string): number;
  sessions: Array<{ owner: string; id: string; startedAt: string }>;
  failNext(needle: string, error?: Error): void;
  snapshot(): Array<
    Pick<FakeOutboxRow, 'id' | 'kind' | 'attempts' | 'last_error'>
  >;
}

export function createFakeOutboxDb(): FakeOutboxDb {
  const outbox: FakeOutboxRow[] = [];
  const receipts: FakeOutboxDb['receipts'] = [];
  const statements: string[] = [];
  let nextId = 1;
  const sessions: FakeOutboxDb['sessions'] = [];
  let snapshot: {
    outbox: FakeOutboxRow[];
    receipts: FakeOutboxDb['receipts'];
    nextId: number;
  } | null = null;
  let fault: { needle: string; error: Error } | null = null;
  const restore = <T>(target: T[], source: T[]) =>
    target.splice(0, target.length, ...source);
  const payloadId = (payload: string): unknown => {
    try {
      const value: unknown = JSON.parse(payload);
      return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : undefined;
    } catch {
      return undefined;
    }
  };
  const push = (kind: string, payload: unknown, owner: string) => {
    const id = nextId++;
    outbox.push({
      id,
      owner_key: owner,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
      last_attempt_order: 0,
      repair_reason: null,
    });
    return id;
  };

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (fault && sql.includes(fault.needle)) {
        const error = fault.error;
        fault = null;
        throw error;
      }
      if (sql === 'BEGIN IMMEDIATE') {
        if (snapshot) throw new Error('outboxFakeDb: nested transaction');
        snapshot = {
          outbox: outbox.map(row => ({ ...row })),
          receipts: receipts.map(row => ({ ...row })),
          nextId,
        };
        return { rows: [] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (!snapshot) throw new Error('outboxFakeDb: transaction is not open');
        if (sql === 'ROLLBACK') {
          restore(outbox, snapshot.outbox);
          restore(receipts, snapshot.receipts);
          nextId = snapshot.nextId;
        }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        const existing = receipts.findIndex(
          row => row.owner === params[0] && row.entityId === params[1],
        );
        if (existing >= 0) receipts.splice(existing, 1);
        receipts.push({
          owner: String(params[0]),
          kind: 'shot.sync',
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO outbox')) {
        const literalKind = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql)?.[1];
        const id = push(
          literalKind ?? String(params[1]),
          null,
          String(params[0]),
        );
        outbox.find(row => row.id === id)!.payload = String(
          params[params.length - 1],
        );
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM sync_receipt')) {
        return {
          rows: receipts.some(
            row => row.owner === params[0] && row.entityId === params[1],
          )
            ? [{ '1': 1 }]
            : [],
        };
      }
      if (sql.startsWith('SELECT payload FROM outbox')) {
        const key = sql.includes("'$.trialId'") ? 'trialId' : 'id';
        return {
          rows: outbox
            .filter(row => {
              if (row.owner_key !== params[0] || row.kind !== params[1])
                return false;
              try {
                const value: unknown = JSON.parse(row.payload);
                return (
                  typeof value === 'object' &&
                  value !== null &&
                  !Array.isArray(value) &&
                  (value as Record<string, unknown>)[key] === params[2]
                );
              } catch {
                return false;
              }
            })
            .slice(0, 51)
            .map(row => ({ payload: row.payload })),
        };
      }
      if (sql.startsWith('SELECT COALESCE(MAX(last_attempt_order)')) {
        return {
          rows: [
            {
              ordinal:
                Math.max(
                  0,
                  ...outbox
                    .filter(row => row.owner_key === params[0])
                    .map(row => row.last_attempt_order),
                ) + 1,
            },
          ],
        };
      }
      if (sql.trimStart().startsWith('SELECT id, kind, payload')) {
        if (sql.includes("kind = 'session.create'")) {
          return {
            rows: outbox
              .filter(
                row =>
                  row.owner_key === params[0] &&
                  row.kind === 'session.create' &&
                  payloadId(row.payload) === params[1],
              )
              .sort((a, b) => a.id - b.id)
              .slice(0, 1)
              .map(row => ({ ...row })),
          };
        }
        if (!sql.includes('ORDER BY last_attempt_order ASC, id ASC LIMIT 50'))
          throw new Error(`outboxFakeDb: unknown drain ordering ${sql}`);
        return {
          rows: outbox
            .filter(
              row =>
                row.owner_key === params[0] &&
                row.attempts < Number(params[1]) &&
                row.repair_reason === null,
            )
            .sort(
              (a, b) =>
                a.last_attempt_order - b.last_attempt_order || a.id - b.id,
            )
            .slice(0, 50)
            .map(row => ({ ...row })),
        };
      }
      if (sql.startsWith('SELECT id, started_at FROM local_session')) {
        return {
          rows: sessions
            .filter(row => row.owner === params[0] && row.id === params[1])
            .slice(0, 1)
            .map(row => ({ id: row.id, started_at: row.startedAt })),
        };
      }
      // These outbox-only fixtures contain no journal work; local results are
      // tested through the real SQLite integration suite.
      if (
        sql.startsWith('SELECT * FROM analysis_run_journal') ||
        sql.startsWith('SELECT * FROM analysis_execution_attempts') ||
        sql.startsWith('SELECT * FROM offline_receipt') ||
        sql.includes('INSERT OR REPLACE INTO local_shot')
      )
        return { rows: [] };
      if (sql.trimStart().startsWith('DELETE FROM outbox')) {
        const index = outbox.findIndex(
          row => row.owner_key === params[0] && row.id === params[1],
        );
        if (index >= 0) outbox.splice(index, 1);
        return { rows: [] };
      }
      if (sql.trimStart().startsWith('UPDATE outbox')) {
        const repair = sql.includes('SET repair_reason = ?, last_error = ?');
        const row = outbox.find(
          candidate =>
            candidate.owner_key === params[repair ? 2 : 1] &&
            candidate.id === params[repair ? 3 : 2],
        );
        if (row) {
          if (repair) {
            row.repair_reason = String(params[0]);
            row.last_error = String(params[1]);
          } else if (sql.includes('SET last_attempt_order = ?'))
            row.last_attempt_order = Number(params[0]);
          else if (
            sql.includes('SET attempts = attempts + 1, last_error = ?')
          ) {
            row.attempts += 1;
            row.last_error = String(params[0]);
          } else if (sql.includes('SET last_error = ?'))
            row.last_error = String(params[0]);
          else throw new Error(`outboxFakeDb: unknown update ${sql}`);
        }
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
    sessions,
    push,
    failNext(needle, error = new Error(`injected failure: ${needle}`)) {
      fault = { needle, error };
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
