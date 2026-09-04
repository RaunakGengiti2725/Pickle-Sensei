/**
 * Adversarial probe of the 2db45730 drain-window fix, run against a REAL
 * SQLite engine (node:sqlite) instead of a hand-written fake: the outbox
 * table is created with the pre-fix schema, upgraded with the same
 * `ALTER TABLE outbox ADD COLUMN last_attempt_at TEXT` that
 * ensureAccountScopedSchema() issues, and drainOutbox() runs its own SQL
 * (strftime stamps, `IS NOT NULL` ordering, LIMIT) unmodified.
 *
 * Requires node:sqlite (Node >= 22.13 unflagged; on 22.5–22.12 run jest with
 * NODE_OPTIONS=--experimental-sqlite). Missing support fails loudly — never
 * a silent skip.
 */
import type { LocalDb } from '../../src/data/db';
import { ApiError } from '../../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
} from '../../src/data/sync';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
// The RN tsconfig types only jest, so node:sqlite is loaded the way the other
// Node-only suites load fs/path (typed require).
declare const require: (id: string) => unknown;
declare const process: { version: string };
function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    return require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(
      `node:sqlite is unavailable on ${process.version}: run jest with ` +
        `NODE_OPTIONS=--experimental-sqlite (Node 22.5–22.12) or use Node ` +
        `>= 22.13 — ${String(error)}`,
    );
  }
}
const { DatabaseSync } = loadSqlite();

const PRE_FIX_OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`;

interface OutboxRow {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
}

function realSqliteDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(PRE_FIX_OUTBOX_SCHEMA);
  raw.exec(`CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     PRIMARY KEY (owner_key, kind, entity_id)
   )`);
  // Legacy database upgrade path (db.ts ensureAccountScopedSchema).
  raw.exec('ALTER TABLE outbox ADD COLUMN last_attempt_at TEXT');
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_owner_created
     ON outbox (owner_key, created_at, id)`);

  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      const trimmed = sql.trim();
      if (/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed)) {
        const rows = raw.prepare(trimmed).all(...params) as Record<
          string,
          unknown
        >[];
        return { rows };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed)) {
        raw.exec(trimmed);
        return { rows: [] };
      }
      raw.prepare(trimmed).run(...params);
      return { rows: [] };
    },
    close() {
      raw.close();
    },
  };
  const push = (kind: string, payload: unknown): number => {
    const result = raw
      .prepare(`INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`)
      .run(GUEST_DATA_OWNER, kind, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  };
  const rows = (): OutboxRow[] =>
    raw
      .prepare(
        `SELECT id, kind, payload, attempts, last_error, last_attempt_at
         FROM outbox ORDER BY id`,
      )
      .all() as OutboxRow[];
  const stamp = (id: number, iso: string) =>
    raw
      .prepare(`UPDATE outbox SET last_attempt_at = ? WHERE id = ?`)
      .run(iso, id);
  return { db, push, rows, stamp, raw };
}

const shot = (id: string, sessionId: string | null) => ({
  id,
  sessionId,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'm',
    poseModelVersion: 'p',
    paddleModelVersion: 'pd',
    strokeDetectorVersion: 's',
    phaseModelVersion: 'ph',
    scoringModelVersion: 'sm',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
});

const uuid = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;

const orphanSession = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function transportAccepting(healthyIds: ReadonlySet<string>) {
  const sent: string[][] = [];
  const transport = {
    syncShots: async (shots: unknown[]) => {
      const ids = shots.map(s => (s as { id: string }).id);
      sent.push(ids);
      return {
        acceptedIds: ids.filter(id => healthyIds.has(id)),
        rejected: ids
          .filter(id => !healthyIds.has(id))
          .map(id => ({
            id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          })),
      };
    },
    createSession: async () => {},
    finalizeSession: async () => {},
  };
  return { sent, transport };
}

describe('attack: drainOutbox window on a real SQLite engine', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('stamps last_attempt_at in a lexicographically sortable UTC format on transient AND permanent failures', async () => {
    const { db, push, rows } = realSqliteDb();
    push('shot.sync', shot(uuid(1), orphanSession));
    push('session.create', { id: 'not-a-session' });
    const transport = {
      ...transportAccepting(new Set()).transport,
      createSession: async () => {
        throw new ApiError(400, 'validation.session', 'bad');
      },
    };
    await drainOutbox(db, transport);
    const [shotRow, sessionRow] = rows();
    expect(shotRow?.attempts).toBe(0);
    expect(sessionRow?.attempts).toBe(1);
    for (const r of [shotRow, sessionRow]) {
      expect(r?.last_attempt_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
    db.close();
  });

  it('original repro on real SQLite: 50 transiently-rejected head rows do not starve a newer healthy shot (≤2 drains)', async () => {
    const { db, push, rows } = realSqliteDb();
    for (let i = 0; i < 50; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));
    const { sent, transport } = transportAccepting(new Set([healthyId]));
    let drainsUntilHealthy = 0;
    for (let drain = 1; drain <= 20; drain++) {
      await drainOutbox(db, transport);
      if (drainsUntilHealthy === 0 && sent.some(b => b.includes(healthyId)))
        drainsUntilHealthy = drain;
    }
    expect(drainsUntilHealthy).toBeGreaterThan(0);
    expect(drainsUntilHealthy).toBeLessThanOrEqual(2);
    expect(rows().some(r => r.payload.includes(healthyId))).toBe(false);
    expect(rows().every(r => r.attempts === 0)).toBe(true);
    db.close();
  });

  it('same-millisecond stamps (real strftime ties) still rotate: 120 stuck rows + 1 once-failed healthy row → healthy offered within ceil(121/50)+1 drains', async () => {
    const { db, push, rows } = realSqliteDb();
    for (let i = 0; i < 120; i++)
      push('shot.sync', shot(uuid(i), orphanSession));
    const healthyId = uuid(999);
    push('shot.sync', shot(healthyId, null));
    // One offline drain first: everything the window reaches fails as a whole
    // batch, so the healthy row is stamped too and loses its never-attempted
    // priority.
    const offline = {
      ...transportAccepting(new Set()).transport,
      syncShots: async () => {
        throw new TypeError('Network request failed');
      },
    };
    await drainOutbox(db, offline); // never-attempted: healthy + 49 stuck
    await drainOutbox(db, offline); // 50 more stuck
    await drainOutbox(db, offline); // last 21 stuck + 29 restamped
    expect(rows().every(r => r.last_attempt_at !== null)).toBe(true);
    const { sent, transport } = transportAccepting(new Set([healthyId]));
    let drainsUntilHealthy = 0;
    for (let drain = 1; drain <= 10; drain++) {
      await drainOutbox(db, transport);
      if (drainsUntilHealthy === 0 && sent.some(b => b.includes(healthyId)))
        drainsUntilHealthy = drain;
    }
    expect(drainsUntilHealthy).toBeGreaterThan(0);
    expect(drainsUntilHealthy).toBeLessThanOrEqual(Math.ceil(121 / 50) + 1);
    db.close();
  });

  it('legacy rows (NULL last_attempt_at after the column upgrade) drain oldest-id first exactly like before', async () => {
    const { db, push, rows } = realSqliteDb();
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(uuid(i));
      push('shot.sync', shot(uuid(i), null));
    }
    const { sent, transport } = transportAccepting(new Set(ids));
    await drainOutbox(db, transport);
    expect(sent[0]).toEqual(ids.slice(0, 50));
    await drainOutbox(db, transport);
    expect(sent[1]).toEqual(ids.slice(50));
    expect(rows()).toHaveLength(0);
    db.close();
  });

  it('permanent failures still exhaust OUTBOX_MAX_ATTEMPTS and leave the window', async () => {
    const { db, push, rows } = realSqliteDb();
    push('session.create', { id: 'bad' });
    const transport = {
      ...transportAccepting(new Set()).transport,
      createSession: async () => {
        throw new ApiError(422, 'validation.session', 'bad');
      },
    };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 3; i++)
      await drainOutbox(db, transport);
    expect(rows()[0]?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    db.close();
  });

  /**
   * REGRESSION vs 4d812e1a. The strict id-ascending head guaranteed that a
   * practice set's session.create row (queued first) was processed before
   * its session.finalize row (queued when the set ended) in the same drain.
   * Under the recency ordering a never-attempted finalize row jumps AHEAD of
   * a create row that already failed once transiently (the device was
   * offline), and the session loop processes window rows in window order —
   * so the finalize is sent before the session exists. The server answers
   * 404 session.not_found (a PERMANENT failure, isPermanentSyncFailure), the
   * finalize row burns one of its OUTBOX_MAX_ATTEMPTS and stays in the queue
   * for another drain, although the server accepted everything it was
   * offered. On 4d812e1a the same drain empties the outbox with zero
   * permanent failures.
   */
  it('a session.finalize row is never sent before its own session.create row', async () => {
    const { db, push, rows } = realSqliteDb();
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    push('session.create', {
      id: sessionId,
      mode: 'practice_set',
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    const shotId = uuid(1);
    push('shot.sync', shot(shotId, sessionId));

    // Drain 1: device offline — every row fails transiently and is stamped.
    const offline = {
      syncShots: async () => {
        throw new TypeError('Network request failed');
      },
      createSession: async () => {
        throw new TypeError('Network request failed');
      },
      finalizeSession: async () => {
        throw new TypeError('Network request failed');
      },
    };
    await drainOutbox(db, offline);

    // The player ends the practice set while still offline.
    const finalizeRowId = push('session.finalize', { id: sessionId });

    // Back online against a fully healthy server (mirrors the edge fn:
    // finalize of a session it has never seen → 404 session.not_found).
    const serverSessions = new Set<string>();
    const calls: string[] = [];
    const healthy = {
      syncShots: async (shots: unknown[]) => {
        const ids = shots.map(s => (s as { id: string }).id);
        calls.push('shots');
        return {
          acceptedIds: ids.filter(() => serverSessions.has(sessionId)),
          rejected: ids
            .filter(() => !serverSessions.has(sessionId))
            .map(id => ({
              id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found or not yours.',
            })),
        };
      },
      createSession: async (payload: Record<string, unknown>) => {
        calls.push('create');
        serverSessions.add(String(payload['id']));
      },
      finalizeSession: async (id: string) => {
        calls.push('finalize');
        if (!serverSessions.has(id))
          throw new ApiError(404, 'session.not_found', 'Session not found.');
      },
    };
    const result = await drainOutbox(db, healthy);

    // Expected (4d812e1a): create → finalize → shots, everything accepted,
    // outbox empty, no permanent attempt consumed.
    expect(calls).toEqual(['create', 'finalize', 'shots']);
    expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(rows().find(r => r.id === finalizeRowId)?.attempts ?? 0).toBe(0);
    db.close();
  });
});
