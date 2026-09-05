/**
 * Fix round 9 — upgrade from a device that ran round-8 candidate A
 * (24fd777b): `outbox.refusals` and `local_session.rearms` exist, the
 * `quarantined` column does not, and the durable states that build left
 * behind are re-labelled ONCE by the new `LOCAL_MIGRATIONS` step:
 *
 *   - a quarantine recorded as attempts = refusals = 8 with the parser's
 *     message becomes `quarantined = 1, refusals = 0` (the server never saw
 *     the row) — status `quarantined`, never offered, never `exhausted`;
 *   - a shot of a set whose automatic re-arms were spent (`rearms` past the
 *     bound, no live create row) gets the durable paused verdict — status
 *     `paused`, offered 0 times by 50 drains, resumed by the next read of
 *     the set;
 *   - genuine refusals (`exhausted`, `orphaned`), healthy and retrying rows,
 *     and receipts are untouched.
 *
 * The step is idempotent across a close/reopen (a second run changes no
 * row). Real `node:sqlite`; the legacy file is planted through `seed()`
 * BEFORE the module opens it.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import {
  deriveUploadQueueStatus,
  type OutboxRowStatus,
} from '../../../src/data/offlineCapabilities';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_ORPHANED_VERDICT,
  SESSION_PAUSED_EXPLANATION,
  SESSION_PAUSED_VERDICT,
  drainOutbox,
  toSyncPayload,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const PAUSED_SET = 'f9c0f9c0-0000-4000-8000-00000000000a';
const ORPHANED_SET = 'f9c0f9c0-0000-4000-8000-00000000000b';
const S_QUARANTINE_NULL = 'legacy-null-mark';
const S_QUARANTINE_NO_PERMIT = shotId(0xf9c1);
const S_PAUSED = shotId(0xf9c2);
const S_EXHAUSTED = shotId(0xf9c3);
const S_ORPHANED = shotId(0xf9c4);
const S_RETRYING = shotId(0xf9c5);
const S_HEALTHY = shotId(0xf9c6);
const S_RECEIPTED = shotId(0xf9c7);
const S_NEW_READ = shotId(0xf9c8);

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

function sessionPayload(id: string): string {
  return JSON.stringify(setInput(id));
}

function shotPayload(id: string, sessionId: string | null): string {
  return JSON.stringify(
    toSyncPayload(realAnalysis({ id, sessionId }), PERMIT_ID),
  );
}

/** The schema 24fd777b wrote: refusals + rearms present, no `quarantined`. */
function seed24fd777bDevice(): void {
  const seed = (sql: string, params: unknown[] = []) =>
    mockSqlite.seed(sql, params);
  seed(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  seed(`CREATE TABLE local_shot (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, overall_score REAL,
     confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
     PRIMARY KEY (owner_key, id))`);
  seed(`CREATE TABLE local_session (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL,
     shot_type TEXT, focus_checkpoint TEXT, started_at TEXT NOT NULL,
     ended_at TEXT, completed INTEGER NOT NULL DEFAULT 0, summary TEXT,
     rearms INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (owner_key, id))`);
  seed(`CREATE TABLE local_capture (
     owner_key TEXT NOT NULL, id TEXT NOT NULL, uri TEXT NOT NULL,
     shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
     payload TEXT, declared_stroke TEXT, target_seed TEXT,
     training_consent TEXT NOT NULL DEFAULT 'not_asked',
     PRIMARY KEY (owner_key, id), UNIQUE (owner_key, uri))`);
  seed(`CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL,
     kind TEXT NOT NULL, payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT,
     refusals INTEGER NOT NULL DEFAULT 0)`);
  seed(`CREATE TABLE sync_receipt (
     owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id))`);
  const session = (id: string, rearms: number) =>
    seed(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, started_at, rearms)
       VALUES (?, ?, 'practice_set', 'forehand_drive', '2026-08-01T10:00:00.000Z', ?)`,
      [OWNER, id, rearms],
    );
  const shot = (id: string, set: string | null) =>
    seed(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score,
         confidence, result_kind, source, payload)
       VALUES (?, ?, ?, 'forehand_drive', '2026-08-01T10:00:00.000Z', 7.4, 0.9, 'scored', 'real', ?)`,
      [OWNER, id, set, JSON.stringify(realAnalysis({ id, sessionId: set }))],
    );
  const row = (
    kind: string,
    payload: string,
    attempts: number,
    refusals: number,
    lastError: string | null,
  ) =>
    seed(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, refusals, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, '2026-08-01T10:00:00.000Z', ?)`,
      [OWNER, kind, payload, attempts, refusals, lastError],
    );
  // 24fd777b quarantines: attempts = refusals = 8, parser message.
  row(
    'shot.sync',
    'null',
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_MAX_ATTEMPTS,
    'Error: outbox.payload_not_object: null',
  );
  row(
    'shot.sync',
    JSON.stringify({ id: S_QUARANTINE_NO_PERMIT, source: 'real' }),
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_MAX_ATTEMPTS,
    'Error: shot.sync_missing_analysis_permit: analysisPermitId is undefined',
  );
  // Paused set: rearms spent (bound + 1), no live create row, shot mid-budget.
  session(PAUSED_SET, SESSION_CREATE_REARM_BOUND + 1);
  shot(S_PAUSED, PAUSED_SET);
  row(
    'shot.sync',
    shotPayload(S_PAUSED, PAUSED_SET),
    2,
    2,
    `${SESSION_NOT_FOUND_REJECTION}: Session not found for this shot.`,
  );
  // Genuine exhaustion: 8 real refusals of a valid payload.
  shot(S_EXHAUSTED, null);
  row(
    'shot.sync',
    shotPayload(S_EXHAUSTED, null),
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_MAX_ATTEMPTS,
    'shot.invalid_payload: Shot shape is invalid.',
  );
  // Orphaned (parked) shot with its set's exhausted create still present.
  session(ORPHANED_SET, 0);
  shot(S_ORPHANED, ORPHANED_SET);
  row(
    'session.create',
    sessionPayload(ORPHANED_SET),
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_MAX_ATTEMPTS,
    'ApiError: Session shape is invalid.',
  );
  row(
    'shot.sync',
    shotPayload(S_ORPHANED, ORPHANED_SET),
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_MAX_ATTEMPTS,
    `${SESSION_ORPHANED_VERDICT}: Its practice set was refused (ApiError: Session shape is invalid.)`,
  );
  // Retrying after a transient failure (attempts charged, no refusal).
  shot(S_RETRYING, null);
  row(
    'shot.sync',
    shotPayload(S_RETRYING, null),
    3,
    0,
    'ApiError: 503 service unavailable',
  );
  // Healthy queued shot.
  shot(S_HEALTHY, null);
  row('shot.sync', shotPayload(S_HEALTHY, null), 0, 0, null);
  // Already-synced shot: receipt only.
  shot(S_RECEIPTED, null);
  seed(
    `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
    [OWNER, S_RECEIPTED],
  );
}

interface Row {
  id: number;
  kind: string;
  attempts: number;
  refusals: number;
  quarantined: number;
  lastError: string | null;
  shot: string | null;
}

async function outboxRows(db: LocalDb): Promise<Row[]> {
  const { rows } = await db.execute(
    `SELECT id, kind, attempts, refusals, quarantined, last_error,
            CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END AS shot
     FROM outbox WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => ({
    id: Number(r['id']),
    kind: String(r['kind']),
    attempts: Number(r['attempts']),
    refusals: Number(r['refusals']),
    quarantined: Number(r['quarantined']),
    lastError: r['last_error'] === null ? null : String(r['last_error']),
    shot: r['shot'] === null ? null : String(r['shot']),
  }));
}

function toStatusRows(rows: Row[]): OutboxRowStatus[] {
  return rows.map(r => ({
    kind: r.kind,
    attempts: r.attempts,
    lastError: r.lastError,
    quarantined: r.quarantined === 1,
  }));
}

function offersOf(t: { syncCalls: unknown[][] }, id: string): number {
  return t.syncCalls.filter(page =>
    page.some(s => String((s as { id: unknown }).id) === id),
  ).length;
}

const PAUSED_ERROR = `${SESSION_PAUSED_VERDICT}: ${SESSION_NOT_FOUND_REJECTION}: Session not found for this shot. ${SESSION_PAUSED_EXPLANATION}`;

describe('fix round 9 — upgrade from a 24fd777b device', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    seed24fd777bDevice();
    db = getDb();
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('M1 — the quarantined step re-labels exactly the legacy quarantines (refusals reset to 0) and pauses exactly the spent set’s shot; every other row is byte-identical; a second run (close/reopen) changes nothing', async () => {
    const first = await outboxRows(db);
    expect(
      first.map(r => [
        r.kind,
        r.attempts,
        r.refusals,
        r.quarantined,
        r.lastError,
      ]),
    ).toEqual([
      ['shot.sync', 8, 0, 1, 'Error: outbox.payload_not_object: null'],
      [
        'shot.sync',
        8,
        0,
        1,
        'Error: shot.sync_missing_analysis_permit: analysisPermitId is undefined',
      ],
      ['shot.sync', 2, 2, 0, PAUSED_ERROR],
      ['shot.sync', 8, 8, 0, 'shot.invalid_payload: Shot shape is invalid.'],
      ['session.create', 8, 8, 0, 'ApiError: Session shape is invalid.'],
      [
        'shot.sync',
        8,
        8,
        0,
        `${SESSION_ORPHANED_VERDICT}: Its practice set was refused (ApiError: Session shape is invalid.)`,
      ],
      ['shot.sync', 3, 0, 0, 'ApiError: 503 service unavailable'],
      ['shot.sync', 0, 0, 0, null],
    ]);
    const { rows: sets } = await db.execute(
      `SELECT id, rearms FROM local_session WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    expect(sets).toEqual([
      { id: PAUSED_SET, rearms: SESSION_CREATE_REARM_BOUND + 1 },
      { id: ORPHANED_SET, rearms: 0 },
    ]);
    expect(await hasShotSyncReceipt(db, S_RECEIPTED)).toBe(true);
    getDb().close();
    db = getDb();
    expect(await outboxRows(db)).toEqual(first);
    getDb().close();
    db = getDb();
    expect(await outboxRows(db)).toEqual(first);
  });

  it('M2 — status truth before any drain: quarantined rows report 0 refusals and their own state; the spent set’s shot is `paused`; exhausted/orphaned/queued keep their states; UploadQueueStatus buckets agree', async () => {
    expect(await getShotOutboxStatus(db, S_QUARANTINE_NO_PERMIT)).toEqual({
      state: 'quarantined',
      attempts: 0,
      lastError:
        'Error: shot.sync_missing_analysis_permit: analysisPermitId is undefined',
    });
    expect(await getShotOutboxStatus(db, S_PAUSED)).toEqual({
      state: 'paused',
      attempts: 2,
      lastError: PAUSED_ERROR,
    });
    expect(await getShotOutboxStatus(db, S_EXHAUSTED)).toMatchObject({
      state: 'exhausted',
      attempts: 8,
    });
    expect(await getShotOutboxStatus(db, S_ORPHANED)).toMatchObject({
      state: 'orphaned',
      attempts: 8,
    });
    expect(await getShotOutboxStatus(db, S_RETRYING)).toEqual({
      state: 'rejected',
      attempts: 3,
      lastError: 'ApiError: 503 service unavailable',
    });
    expect(await getShotOutboxStatus(db, S_HEALTHY)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expect(await getShotOutboxStatus(db, S_RECEIPTED)).toEqual({
      state: 'absent',
    });
    expect(await hasShotSyncReceipt(db, S_RECEIPTED)).toBe(true);
    // Buckets: 2 quarantined, 1 paused, 2 exhausted (create + shot); the
    // orphaned shot is parked (not counted); retrying + healthy pending.
    expect(deriveUploadQueueStatus(toStatusRows(await outboxRows(db)))).toEqual(
      {
        state: 'needs_attention',
        pending: 3,
        exhausted: 2,
        quarantined: 2,
        paused: 1,
      },
    );
  });

  it('M3 — 50 drains after the upgrade: retrying + healthy delivered in drain 1; the orphaned set (create refusals witnessed, re-arm budget unspent) is revived exactly once and delivered; quarantined, paused and exhausted rows are offered 0 times and keep their counters; the drain reports failed 0 and no quarantine (the legacy ones are already labelled)', async () => {
    const t = acceptAllTransport();
    const first = await drainOutbox(db, t);
    expect(first).toEqual({ synced: 4, failed: 0, remaining: 4 });
    for (let d = 0; d < 49; d += 1) await drainOutbox(db, t);
    expect(await hasShotSyncReceipt(db, S_RETRYING)).toBe(true);
    expect(await hasShotSyncReceipt(db, S_HEALTHY)).toBe(true);
    expect(await hasShotSyncReceipt(db, S_ORPHANED)).toBe(true);
    expect(t.sessions).toEqual([ORPHANED_SET]);
    expect(t.syncCalls).toHaveLength(1);
    expect(offersOf(t, S_ORPHANED)).toBe(1);
    for (const id of [
      S_QUARANTINE_NULL,
      S_QUARANTINE_NO_PERMIT,
      S_PAUSED,
      S_EXHAUSTED,
    ]) {
      expect(offersOf(t, id)).toBe(0);
    }
    const rows = await outboxRows(db);
    expect(rows.map(r => [r.shot ?? r.kind, r.attempts, r.refusals])).toEqual([
      ['shot.sync', 8, 0],
      [S_QUARANTINE_NO_PERMIT, 8, 0],
      [S_PAUSED, 2, 2],
      [S_EXHAUSTED, 8, 8],
    ]);
    const { rows: sets } = await db.execute(
      `SELECT id, rearms FROM local_session WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    expect(sets).toEqual([
      { id: PAUSED_SET, rearms: SESSION_CREATE_REARM_BOUND + 1 },
      { id: ORPHANED_SET, rearms: 1 },
    ]);
    expect(await getShotOutboxStatus(db, S_PAUSED)).toMatchObject({
      state: 'paused',
    });
  });

  it('M4 — a new read into the paused set resumes it: the set (already accepted by the server when it was paused) is not created again, both shots are offered once and delivered, the legacy paused shot keeps its counters', async () => {
    const t = acceptAllTransport();
    await saveAnalysis(
      db,
      realAnalysis({ id: S_NEW_READ, sessionId: PAUSED_SET }),
      PERMIT_ID,
      { session: setInput(PAUSED_SET) },
    );
    expect(await getShotOutboxStatus(db, S_PAUSED)).toEqual({
      state: 'rejected',
      attempts: 2,
      lastError: null,
    });
    await drainOutbox(db, t);
    await drainOutbox(db, t);
    expect(t.sessions).toEqual([]);
    expect(t.syncCalls).toHaveLength(1);
    expect(offersOf(t, S_PAUSED)).toBe(1);
    expect(offersOf(t, S_NEW_READ)).toBe(1);
    expect(await hasShotSyncReceipt(db, S_PAUSED)).toBe(true);
    expect(await hasShotSyncReceipt(db, S_NEW_READ)).toBe(true);
    expect(await getShotOutboxStatus(db, S_PAUSED)).toEqual({
      state: 'absent',
    });
    // The quarantined rows never re-entered the queue.
    const rows = await outboxRows(db);
    expect(rows.filter(r => r.quarantined === 1)).toHaveLength(2);
    expect(rows).toHaveLength(3);
  });
});
