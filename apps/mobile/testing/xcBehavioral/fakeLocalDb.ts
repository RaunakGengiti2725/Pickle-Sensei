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
    shotType: string | null;
    focusCheckpoint: string | null;
    startedAt: string;
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

const PARKED_PREFIX = 'shot.session_orphaned:';

function payloadField(row: OutboxRow, field: string): unknown {
  try {
    return (JSON.parse(row.payload) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Mirrors the `kind` predicate of the pass that issued a page query. */
function pageAcceptsKind(sql: string, kind: string): boolean {
  if (sql.includes("kind = 'shot.sync'")) return kind === 'shot.sync';
  if (sql.includes("kind = 'evaluation.trial'")) {
    return kind === 'evaluation.trial';
  }
  if (sql.includes("kind NOT IN ('shot.sync', 'evaluation.trial')")) {
    return kind !== 'shot.sync' && kind !== 'evaluation.trial';
  }
  return true;
}

/** Mirrors the pass's budget predicate (exhausted opt-ins included). */
function pageAcceptsBudget(
  sql: string,
  row: OutboxRow,
  maxAttempts: number,
): boolean {
  if (row.attempts < maxAttempts) return true;
  if (sql.includes("OR kind = 'session.create'")) {
    return row.kind === 'session.create';
  }
  return false;
}

/** A live (budgeted) `session.create` row naming `sessionId`. */
function hasLiveSessionCreate(
  outbox: OutboxRow[],
  owner: string,
  sessionId: unknown,
  maxAttempts: number,
): boolean {
  return outbox.some(
    r =>
      r.owner_key === owner &&
      r.attempts < maxAttempts &&
      r.kind === 'session.create' &&
      payloadField(r, 'id') === sessionId,
  );
}

const MAX_ATTEMPTS_IN_SQL = /s\.attempts < (\d+)/;

/** Mirrors the shot pass's `AND NOT (… IN (SELECT … session.create …))`
 * predicate: a shot whose set still has a live session.create row is not
 * offered. */
function pageOffersRow(sql: string, row: OutboxRow, outbox: OutboxRow[]) {
  const live = MAX_ATTEMPTS_IN_SQL.exec(sql);
  if (!live || !sql.includes('AND NOT (')) return true;
  if (row.kind !== 'shot.sync') return true;
  const sessionId = payloadField(row, 'sessionId');
  if (typeof sessionId !== 'string') return true;
  return !hasLiveSessionCreate(
    outbox,
    row.owner_key,
    sessionId,
    Number(live[1]),
  );
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
        // Owner-fenced: written only while the outbox row still exists.
        if (
          sql.includes('WHERE EXISTS') &&
          !outbox.some(
            r => r.owner_key === String(params[2]) && r.id === params[3],
          )
        ) {
          return { rows: [] };
        }
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
        if (sql.includes('FROM local_session ls')) {
          // enqueueLiveSessionCreateFromLocal: the set's row, unless a live
          // session.create already names it.
          const s = sessions.find(
            row => row.owner === params[0] && row.id === params[1],
          );
          if (
            s &&
            !hasLiveSessionCreate(outbox, s.owner, s.id, Number(params[2]))
          ) {
            outbox.push({
              id: nextOutboxId++,
              owner_key: s.owner,
              kind: 'session.create',
              payload: JSON.stringify({
                id: s.id,
                mode: s.mode,
                shotType: s.shotType,
                focusCheckpoint: s.focusCheckpoint,
                startedAt: s.startedAt,
              }),
              attempts: 0,
              last_error: null,
            });
          }
          return { rows: [] };
        }
        const kindMatch = /(?:VALUES \(|SELECT )\?, '([a-z.]+)', \?/.exec(sql);
        const kind = kindMatch ? kindMatch[1]! : String(params[1]);
        const payload = String(
          kindMatch ? params[1] : params[params.length - 1],
        );
        if (
          kind === 'session.create' &&
          sql.includes('WHERE NOT EXISTS') &&
          hasLiveSessionCreate(
            outbox,
            String(params[0]),
            payloadField({ payload } as OutboxRow, 'id'),
            Number(params[3]),
          )
        ) {
          return { rows: [] };
        }
        outbox.push({
          id: nextOutboxId++,
          owner_key: String(params[0]),
          kind,
          payload,
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        const cursor = Number(params[2] ?? 0);
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                pageAcceptsBudget(sql, r, Number(params[1])) &&
                r.id > cursor &&
                pageAcceptsKind(sql, r.kind) &&
                pageOffersRow(sql, r, outbox),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('SELECT 1 FROM outbox')) {
        // hasLiveSessionCreate: a session.create for `$.id` with budget left.
        const hit = hasLiveSessionCreate(
          outbox,
          String(params[0]),
          params[2],
          Number(params[1]),
        );
        return { rows: hit ? [{ '1': 1 }] : [] };
      }
      if (sql.startsWith('SELECT ls.id AS id FROM local_session ls')) {
        // selectParkedSetsWithoutQueueEntry.
        const ids = sessions
          .filter(
            s =>
              s.owner === params[0] &&
              outbox.some(
                r =>
                  r.owner_key === s.owner &&
                  r.kind === 'shot.sync' &&
                  r.last_error !== null &&
                  r.last_error.startsWith(PARKED_PREFIX) &&
                  payloadField(r, 'sessionId') === s.id,
              ) &&
              !outbox.some(
                r =>
                  r.owner_key === s.owner &&
                  r.kind === 'session.create' &&
                  payloadField(r, 'id') === s.id,
              ),
          )
          .sort((a, b) =>
            a.startedAt === b.startedAt
              ? a.id.localeCompare(b.id)
              : a.startedAt.localeCompare(b.startedAt),
          );
        return { rows: ids.map(s => ({ id: s.id })) };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        if (sql.includes('attempts >= ?')) {
          // retireAcceptedSessionCreate: the accepted row plus the exhausted
          // session.create rows for a set the server now has.
          for (let i = outbox.length - 1; i >= 0; i -= 1) {
            const r = outbox[i]!;
            if (
              r.owner_key === params[0] &&
              (r.id === params[1] ||
                (r.attempts >= Number(params[2]) &&
                  r.kind === 'session.create' &&
                  payloadField(r, 'id') === params[3]))
            ) {
              outbox.splice(i, 1);
            }
          }
          return { rows: [] };
        }
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        if (sql.includes('SELECT max(id) FROM outbox')) {
          // rearmExhaustedSessionCreate: the newest exhausted session.create
          // for `$.id`, unless a live one exists.
          const max = Number(params[2]);
          if (hasLiveSessionCreate(outbox, String(params[0]), params[3], max)) {
            return { rows: [] };
          }
          const exhausted = outbox
            .filter(
              r =>
                r.owner_key === params[0] &&
                r.attempts >= max &&
                r.kind === 'session.create' &&
                payloadField(r, 'id') === params[3],
            )
            .sort((a, b) => b.id - a.id)[0];
          if (exhausted) {
            exhausted.attempts = 0;
            exhausted.last_error = null;
          }
          return { rows: [] };
        }
        if (sql.includes('SET attempts = 0, last_error = NULL')) {
          // releaseParkedShotsOfSession: parked shots of `$.sessionId`.
          for (const r of outbox) {
            if (
              r.owner_key === params[0] &&
              r.kind === 'shot.sync' &&
              r.last_error !== null &&
              r.last_error.startsWith(PARKED_PREFIX) &&
              payloadField(r, 'sessionId') === params[1]
            ) {
              r.attempts = 0;
              r.last_error = null;
            }
          }
          return { rows: [] };
        }
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT attempts, last_error FROM outbox')) {
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
          .map(r => ({ attempts: r.attempts, last_error: r.last_error }));
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
        const idx = sessions.findIndex(
          s => s.owner === params[0] && s.id === params[1],
        );
        if (idx >= 0) sessions.splice(idx, 1);
        sessions.push({
          owner: String(params[0]),
          id: String(params[1]),
          mode: String(params[2]),
          shotType: params[3] == null ? null : String(params[3]),
          focusCheckpoint: params[4] == null ? null : String(params[4]),
          startedAt: String(params[5]),
        });
        return { rows: [] };
      }
      if (
        sql.startsWith('SELECT mode, shot_type, focus_checkpoint, started_at')
      ) {
        const s = sessions.find(
          row => row.owner === params[0] && row.id === params[1],
        );
        return {
          rows: s
            ? [
                {
                  mode: s.mode,
                  shot_type: s.shotType,
                  focus_checkpoint: s.focusCheckpoint,
                  started_at: s.startedAt,
                },
              ]
            : [],
        };
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
