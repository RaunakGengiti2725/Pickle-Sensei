/**
 * Adversary round 8 — candidate `devin/fix8-mds-sqlite-a` @ 24fd777b.
 * Claims (4), (6), (7) plus upgrade compatibility: a device database written
 * by the previous builds (d29b95f5: exhausted `shot.session_not_found` rows
 * at attempts=8; 9a00ceb1: parked `shot.session_orphaned:` verdicts) with no
 * `outbox.refusals` / `local_session.rearms` columns is migrated by the new
 * `LOCAL_MIGRATIONS` + `ensureAccountScopedSchema` (twice), drained, and the
 * status/copy for every legacy state is compared with the SQL truth.
 *
 * Real `node:sqlite`; the legacy file is planted through `seed()` BEFORE the
 * first `getDb()` opens it, exactly as a previous build would have left it.
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
const LEGACY_EXHAUSTED_SET = 'c1c1c1c1-0000-4000-8000-00000000000a';
const LEGACY_PARKED_SET = 'c1c1c1c1-0000-4000-8000-00000000000b';
const HEALTHY_SET = 'c1c1c1c1-0000-4000-8000-00000000000c';
const S_EXHAUSTED = shotId(0xc101);
const S_PARKED = shotId(0xc102);
const S_HEALTHY = shotId(0xc103);
const S_MALFORMED_ROW_MARK = 'legacy-malformed';

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
  return JSON.stringify({
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  });
}

/** The schema every build before this candidate wrote (no refusals/rearms). */
function seedLegacyDevice(): void {
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
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`);
  seed(`CREATE TABLE sync_receipt (
     owner_key TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id))`);
  for (const [set, shot] of [
    [LEGACY_EXHAUSTED_SET, S_EXHAUSTED],
    [LEGACY_PARKED_SET, S_PARKED],
    [null, S_HEALTHY],
  ] as Array<[string | null, string]>) {
    if (set !== null) {
      seed(
        `INSERT INTO local_session (owner_key, id, mode, shot_type, started_at)
         VALUES (?, ?, 'practice_set', 'forehand_drive', '2026-08-01T10:00:00.000Z')`,
        [OWNER, set],
      );
    }
    seed(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score,
         confidence, result_kind, source, payload)
       VALUES (?, ?, ?, 'forehand_drive', '2026-08-01T10:00:00.000Z', 7.4, 0.9, 'scored', 'real', ?)`,
      [
        OWNER,
        shot,
        set,
        JSON.stringify(realAnalysis({ id: shot, sessionId: set })),
      ],
    );
  }
  const row = (
    kind: string,
    payload: string,
    attempts: number,
    lastError: string | null,
  ) =>
    seed(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, created_at, last_error)
       VALUES (?, ?, ?, ?, '2026-08-01T10:00:00.000Z', ?)`,
      [OWNER, kind, payload, attempts, lastError],
    );
  // d29b95f5 left this set fully exhausted: create refused 8×, shot refused
  // 8× with the server's not_found string.
  row(
    'session.create',
    sessionPayload(LEGACY_EXHAUSTED_SET),
    OUTBOX_MAX_ATTEMPTS,
    'ApiError: Session shape is invalid.',
  );
  row(
    'shot.sync',
    JSON.stringify(
      toSyncPayload(
        realAnalysis({ id: S_EXHAUSTED, sessionId: LEGACY_EXHAUSTED_SET }),
        PERMIT_ID,
      ),
    ),
    OUTBOX_MAX_ATTEMPTS,
    'Error: shot.session_not_found',
  );
  // 9a00ceb1 parked this shot under its orphaned verdict (attempts 8), with
  // the set's exhausted create still present.
  row(
    'session.create',
    sessionPayload(LEGACY_PARKED_SET),
    OUTBOX_MAX_ATTEMPTS,
    'ApiError: Session shape is invalid.',
  );
  row(
    'shot.sync',
    JSON.stringify(
      toSyncPayload(
        realAnalysis({ id: S_PARKED, sessionId: LEGACY_PARKED_SET }),
        PERMIT_ID,
      ),
    ),
    OUTBOX_MAX_ATTEMPTS,
    'shot.session_orphaned: Its practice set was refused (ApiError: Session shape is invalid.)',
  );
  // Malformed rows a previous build never quarantined.
  row('shot.sync', 'null', 0, null);
  row('shot.sync', `{"id":"${S_MALFORMED_ROW_MARK}"`, 3, 'SyntaxError: bad');
  row('shot.sync', JSON.stringify({ id: 7, source: 'real' }), 0, null);
  // A healthy queued shot without a set.
  row(
    'shot.sync',
    JSON.stringify(toSyncPayload(realAnalysis({ id: S_HEALTHY }), PERMIT_ID)),
    0,
    null,
  );
}

async function statusRows(db: LocalDb): Promise<OutboxRowStatus[]> {
  const { rows } = await db.execute(
    `SELECT kind, attempts, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
    [OWNER],
  );
  return rows.map(r => ({
    kind: String(r['kind']),
    attempts: Number(r['attempts']),
    lastError: r['last_error'] === null ? null : String(r['last_error']),
  }));
}

function offersOf(t: { syncCalls: unknown[][] }, id: string): number {
  return t.syncCalls.filter(page =>
    page.some(s => String((s as { id: unknown }).id) === id),
  ).length;
}

describe('attack-fix8-a C1 — upgrade from the pre-fix schema, status truth', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    seedLegacyDevice();
    db = getDb();
  });
  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('C1.1 probe — the migration adds refusals/rearms with 0, keeps every legacy row, and is idempotent across a close/reopen', async () => {
    const { rows: before } = await db.execute(
      `SELECT id, kind, attempts, refusals, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    expect(before.map(r => [r['kind'], r['attempts'], r['refusals']])).toEqual([
      ['session.create', 8, 0],
      ['shot.sync', 8, 0],
      ['session.create', 8, 0],
      ['shot.sync', 8, 0],
      ['shot.sync', 0, 0],
      ['shot.sync', 3, 0],
      ['shot.sync', 0, 0],
      ['shot.sync', 0, 0],
    ]);
    const { rows: sets } = await db.execute(
      `SELECT id, rearms FROM local_session WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    expect(sets).toEqual([
      { id: LEGACY_EXHAUSTED_SET, rearms: 0 },
      { id: LEGACY_PARKED_SET, rearms: 0 },
    ]);
    getDb().close();
    db = getDb();
    const { rows: after } = await db.execute(
      `SELECT id, kind, attempts, refusals, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    expect(after).toEqual(before);
  });

  it('C1.2 probe — status for each legacy state before any drain (exhausted create rows count as `exhausted`; the parked shot is `orphaned`, the healthy one `queued`)', async () => {
    const queue = deriveUploadQueueStatus(await statusRows(db));
    const exhaustedShot = await getShotOutboxStatus(db, S_EXHAUSTED);
    const parkedShot = await getShotOutboxStatus(db, S_PARKED);
    const healthy = await getShotOutboxStatus(db, S_HEALTHY);
    expect(parkedShot).toMatchObject({ state: 'orphaned', attempts: 8 });
    expect(healthy).toEqual({ state: 'queued', attempts: 0, lastError: null });
    expect(exhaustedShot).toMatchObject({ state: 'exhausted', attempts: 8 });
    // The two legacy exhausted `session.create` rows and the legacy
    // exhausted shot.
    expect(queue).toEqual({
      state: 'needs_attention',
      pending: 5,
      exhausted: 3,
    });
  });

  it('C1.3 probe — first drains after the upgrade: no throw, malformed legacy rows quarantined once, healthy shot delivered; legacy exhausted sets (refusals=0) are NOT auto-revived — a new read into the set is the only trigger, and it releases the parked shot but not the legacy exhausted one', async () => {
    const t = acceptAllTransport();
    t.syncShots = async shots => {
      t.syncCalls.push(shots);
      const known = shots.filter(s => {
        const sid = (s as { sessionId: unknown }).sessionId;
        return sid === null || t.sessions.includes(String(sid));
      });
      return {
        acceptedIds: known.map(s => String((s as { id: unknown }).id)),
        rejected: shots
          .filter(s => !known.includes(s))
          .map(s => ({
            id: String((s as { id: unknown }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
      };
    };
    const results = [];
    for (let d = 0; d < 6; d += 1) results.push(await drainOutbox(db, t));
    expect(results[0]).toEqual({ synced: 1, failed: 3, remaining: 7 });
    expect(results.slice(1)).toEqual(
      Array(5).fill({ synced: 0, failed: 0, remaining: 7 }),
    );
    expect(
      await Promise.all(
        [S_HEALTHY, S_EXHAUSTED, S_PARKED].map(id =>
          hasShotSyncReceipt(db, id),
        ),
      ),
    ).toEqual([true, false, false]);
    expect(t.sessions).toEqual([]);
    const afterUpgrade = await statusRows(db);
    expect(afterUpgrade.map(r => r.attempts)).toEqual([8, 8, 8, 8, 8, 8, 8]);
    expect(afterUpgrade.slice(4).map(r => r.lastError)).toEqual([
      'Error: outbox.payload_not_object: null',
      "SyntaxError: Expected ',' or '}' after property value in JSON at position 24 (line 1 column 25)",
      'Error: shot.sync_missing_id: id is a number',
    ]);
    expect(deriveUploadQueueStatus(afterUpgrade)).toEqual({
      state: 'needs_attention',
      pending: 1,
      exhausted: 6,
    });

    // The one legacy trigger: a new read joins each set.
    const newParked = shotId(0xc131);
    const newExhausted = shotId(0xc132);
    await saveAnalysis(
      db,
      realAnalysis({ id: newParked, sessionId: LEGACY_PARKED_SET }),
      PERMIT_ID,
      { session: setInput(LEGACY_PARKED_SET) },
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: newExhausted, sessionId: LEGACY_EXHAUSTED_SET }),
      PERMIT_ID,
      { session: setInput(LEGACY_EXHAUSTED_SET) },
    );
    for (let d = 0; d < 4; d += 1) await drainOutbox(db, t);
    expect([...t.sessions].sort()).toEqual([
      LEGACY_EXHAUSTED_SET,
      LEGACY_PARKED_SET,
    ]);
    expect(
      await Promise.all(
        [S_PARKED, newParked, newExhausted, S_EXHAUSTED].map(id =>
          hasShotSyncReceipt(db, id),
        ),
      ),
    ).toEqual([true, true, true, false]);
    // The legacy `shot.session_not_found` row exhausted by d29b95f5 carries no
    // orphaned verdict, so the accepted set does not release it: it stays
    // exhausted for good although its set now exists on the server.
    expect(offersOf(t, S_EXHAUSTED)).toBe(0);
    expect(await getShotOutboxStatus(db, S_EXHAUSTED)).toMatchObject({
      state: 'exhausted',
      attempts: 8,
      lastError: 'Error: shot.session_not_found',
    });
  });

  it('C1.4 BREAK — a paused set (rearms > bound, no create row) is reported `queued`/pending by UploadQueueStatus and `rejected` by getShotOutboxStatus, but 50 drains never offer it again', async () => {
    await db.execute(`DELETE FROM outbox WHERE owner_key = ?`, [OWNER]);
    const id = shotId(0xc140);
    await saveAnalysis(
      db,
      realAnalysis({ id, sessionId: HEALTHY_SET }),
      PERMIT_ID,
      {
        session: setInput(HEALTHY_SET),
      },
    );
    const t = acceptAllTransport();
    t.syncShots = async shots => {
      t.syncCalls.push(shots);
      return {
        acceptedIds: [],
        rejected: shots.map(s => ({
          id: String((s as { id: unknown }).id),
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    };
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    const { rows } = await db.execute(
      `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
      [OWNER, HEALTHY_SET],
    );
    expect(Number(rows[0]?.['rearms'])).toBe(SESSION_CREATE_REARM_BOUND + 1);
    const before = offersOf(t, id);
    for (let d = 0; d < 50; d += 1) await drainOutbox(db, t);
    expect(offersOf(t, id) - before).toBe(0);
    const queue = deriveUploadQueueStatus(await statusRows(db));
    const shot = await getShotOutboxStatus(db, id);
    // Observed: queue { state: 'queued', pending: 1 } ("will retry") and shot
    // { state: 'rejected', attempts: 3 } while nothing will retry it without
    // a new read joining the set. Expected: a status that does not promise a
    // retry (the row is neither queued nor exhausted — it is paused).
    expect({ queue, shot: shot.state }).not.toEqual({
      queue: { state: 'queued', pending: 1 },
      shot: 'rejected',
    });
  });
});
