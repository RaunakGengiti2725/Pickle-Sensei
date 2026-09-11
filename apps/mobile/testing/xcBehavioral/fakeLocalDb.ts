/**
 * In-memory LocalDb for the behavioral matrix. It models exactly the SQL the
 * mobile data layer issues on the analysis / practice-set / outbox paths
 * (repository.ts, practiceSet.ts, sync.ts) so the harness can observe the
 * durable state a real device would be left with — rows in `outbox`,
 * `sync_receipt`, `local_shot`, `local_session`, `kv` — after any
 * interleaving. Every statement is also recorded verbatim, and a fault
 * injector can fail the N-th matching statement to simulate a crash between
 * two writes (kill/relaunch).
 */
import type { LocalDb } from '../../src/data/db';

export interface RecordedStatement {
  sql: string;
  params: unknown[];
}

export interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  last_attempt_order: number;
  repair_reason: string | null;
}

export interface FakeLocalDb {
  db: LocalDb;
  statements: RecordedStatement[];
  outbox: OutboxRow[];
  receipts: Array<{ owner: string; kind: string; entityId: string }>;
  kv: Map<string, string>;
  shots: Array<{ owner: string; id: string; sessionId: string | null }>;
  sessions: Array<{
    owner: string;
    id: string;
    mode: string;
    startedAt?: string;
  }>;
  captures: Array<{ owner: string; id: string }>;
  analysisRecords: Array<{ owner: string; id: string }>;
  /** Fail the next statement whose SQL contains `needle` (once). */
  failNext(needle: string, error?: Error): void;
  /** Number of statements executed inside an open transaction that have not
   * been committed — non-zero after the run means an orphaned BEGIN. */
  openTransactions(): number;
  push(kind: string, payload: unknown, owner: string): number;
  reset(): void;
}

export function createFakeLocalDb(): FakeLocalDb {
  const statements: RecordedStatement[] = [];
  const outbox: OutboxRow[] = [];
  const receipts: FakeLocalDb['receipts'] = [];
  const kv = new Map<string, string>();
  const shots: FakeLocalDb['shots'] = [];
  const sessions: FakeLocalDb['sessions'] = [];
  const captures: FakeLocalDb['captures'] = [];
  const analysisRecords: FakeLocalDb['analysisRecords'] = [];
  const pendingFaults: Array<{ needle: string; error: Error }> = [];
  let nextOutboxId = 1;
  let depth = 0;
  // BEGIN snapshots the durable tables so ROLLBACK really undoes the writes
  // issued inside the transaction (a killed process never sees them).
  let snapshot: {
    outbox: OutboxRow[];
    receipts: FakeLocalDb['receipts'];
    kv: Map<string, string>;
    shots: FakeLocalDb['shots'];
    sessions: FakeLocalDb['sessions'];
  } | null = null;
  const restore = <T>(target: T[], source: T[]) => {
    target.length = 0;
    target.push(...source);
  };

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      statements.push({ sql, params });
      const faultIndex = pendingFaults.findIndex(f => sql.includes(f.needle));
      if (faultIndex >= 0) {
        const [fault] = pendingFaults.splice(faultIndex, 1);
        throw fault!.error;
      }
      if (sql === 'BEGIN IMMEDIATE') {
        depth += 1;
        if (depth === 1) {
          snapshot = {
            outbox: outbox.map(row => ({ ...row })),
            receipts: receipts.map(r => ({ ...r })),
            kv: new Map(kv),
            shots: shots.map(s => ({ ...s })),
            sessions: sessions.map(s => ({ ...s })),
          };
        }
        return { rows: [] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        depth = Math.max(0, depth - 1);
        if (sql === 'ROLLBACK' && depth === 0 && snapshot) {
          restore(outbox, snapshot.outbox);
          restore(receipts, snapshot.receipts);
          kv.clear();
          for (const [k, v] of snapshot.kv) kv.set(k, v);
          restore(shots, snapshot.shots);
          restore(sessions, snapshot.sessions);
        }
        if (depth === 0) snapshot = null;
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
      if (sql.includes('SELECT 1 FROM sync_receipt')) {
        const hit = receipts.some(
          r => r.owner === params[0] && r.entityId === params[1],
        );
        return { rows: hit ? [{ '1': 1 }] : [] };
      }
      if (sql.includes('INSERT INTO outbox')) {
        const kindMatch = /VALUES \(\?, '([a-z.]+)', \?\)/.exec(sql);
        outbox.push({
          id: nextOutboxId++,
          owner_key: String(params[0]),
          kind: kindMatch ? kindMatch[1]! : String(params[1]),
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
          last_attempt_order: 0,
          repair_reason: null,
        });
        return { rows: [] };
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
      if (sql.startsWith('SELECT id, started_at FROM local_session')) {
        return {
          rows: sessions
            .filter(row => row.owner === params[0] && row.id === params[1])
            .slice(0, 1)
            .map(row => ({ id: row.id, started_at: row.startedAt })),
        };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        if (sql.includes("kind = 'session.create'")) {
          return {
            rows: outbox
              .filter(row => {
                if (
                  row.owner_key !== params[0] ||
                  row.kind !== 'session.create'
                )
                  return false;
                try {
                  return (
                    (JSON.parse(row.payload) as { id?: unknown } | null)?.id ===
                    params[1]
                  );
                } catch {
                  return false;
                }
              })
              .sort((a, b) => a.id - b.id)
              .slice(0, 1)
              .map(row => ({ ...row })),
          };
        }
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]) &&
                r.repair_reason === null,
            )
            .sort(
              (a, b) =>
                a.last_attempt_order - b.last_attempt_order || a.id - b.id,
            )
            .slice(0, 50)
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const repair = sql.includes('SET repair_reason = ?, last_error = ?');
        const row = outbox.find(
          r =>
            r.owner_key === params[repair ? 2 : 1] &&
            r.id === params[repair ? 3 : 2],
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
          else throw new Error(`fakeLocalDb: unknown outbox update ${sql}`);
        }
        return { rows: [] };
      }
      if (
        sql.includes('SELECT attempts, last_error, repair_reason FROM outbox')
      ) {
        const rows = outbox
          .filter(r => {
            if (r.owner_key !== params[0] || r.kind !== 'shot.sync') {
              return false;
            }
            try {
              return (
                (JSON.parse(r.payload) as { id?: unknown }).id === params[1]
              );
            } catch {
              return false;
            }
          })
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map(r => ({
            attempts: r.attempts,
            last_error: r.last_error,
            repair_reason: r.repair_reason,
          }));
        return { rows };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.includes('INSERT OR REPLACE INTO kv')) {
        kv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
        shots.push({
          owner: String(params[0]),
          id: String(params[1]),
          sessionId: params[2] == null ? null : String(params[2]),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO local_session')) {
        sessions.push({
          owner: String(params[0]),
          id: String(params[1]),
          mode: String(params[2]),
          startedAt: String(params[3]),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO local_capture')) {
        captures.push({ owner: String(params[0]), id: String(params[1]) });
        return { rows: [] };
      }
      if (sql.includes('local_analysis_record')) {
        if (sql.includes('INSERT')) {
          analysisRecords.push({
            owner: String(params[0]),
            id: String(params[1]),
          });
        }
        return { rows: [] };
      }
      // Everything else (capture updates, telemetry, history reads) is
      // recorded and answered empty.
      return { rows: [] };
    },
    close() {},
  };

  return {
    db,
    statements,
    outbox,
    receipts,
    kv,
    shots,
    sessions,
    captures,
    analysisRecords,
    failNext(needle, error = new Error(`injected failure: ${needle}`)) {
      pendingFaults.push({ needle, error });
    },
    openTransactions: () => depth,
    push(kind, payload, owner) {
      const id = nextOutboxId++;
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
    },
    reset() {
      statements.length = 0;
      outbox.length = 0;
      receipts.length = 0;
      kv.clear();
      shots.length = 0;
      sessions.length = 0;
      captures.length = 0;
      analysisRecords.length = 0;
      pendingFaults.length = 0;
      depth = 0;
      snapshot = null;
    },
  };
}
