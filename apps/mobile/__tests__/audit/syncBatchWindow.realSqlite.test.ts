/**
 * Structural audit (mobile-data-sync, pass 1) — repository writes + outbox
 * drain executed against a REAL SQLite connection, so the actual
 * `ORDER BY id ASC LIMIT 50` window (sync.ts:139-143), the receipt
 * transaction (sync.ts:224-243) and the json_extract status reader
 * (repository.ts:859-865) run for real.
 *
 * Suspected defect under test (sync.ts:139-143 + 101-106 + 247-256):
 * rows that fail with a TRANSIENT verdict never burn attempts, so they never
 * leave the fixed 50-row window. A shot whose practice-set session.create was
 * PERMANENTLY rejected (exhausted after 8 drains) is rejected with
 * `shot.session_not_found` — transient — on every drain, forever. Once 50 such
 * rows exist, every newer row (a brand-new valid set) is starved: nothing
 * else is ever selected, no attempt is ever burned, nothing is ever exhausted.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import { ApiError } from '../../src/data/api';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  saveSession,
  setKv,
} from '../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../audit-support/realSqlite';

const mockState: { handle: RealSqliteHandle | null } = { handle: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockState.handle) throw new Error('audit harness: no handle');
    return mockState.handle;
  },
}));

/** Runs the production launch migrations over the real handle and returns
 * the app-facing LocalDb (a fresh module instance per call). */
function migratedLocalDb(handle: RealSqliteHandle): LocalDb {
  mockState.handle = handle;
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../../src/data/db')>('../../src/data/db')
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const owner = canonicalDataOwner(OWNER_ID);

function uuid(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysis(id: string, sessionId: string | null): ShotAnalysis {
  return {
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
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A server whose session endpoint permanently rejects `brokenSession` and
 * accepts everything else; shots are accepted only when their session was
 * created (mirrors apply_synced_shot's "shot.session_not_found"). */
function serverLikeTransport(brokenSession: string) {
  const knownSessions = new Set<string>();
  const calls = { createSession: 0, syncShots: 0, shotsOffered: 0 };
  const transport: SyncTransport = {
    async createSession(session) {
      calls.createSession += 1;
      const id = String((session as Record<string, unknown>)['id']);
      if (id === brokenSession) {
        throw new ApiError(400, 'validation.session', 'Invalid session.');
      }
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      calls.syncShots += 1;
      calls.shotsOffered += shots.length;
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const raw of shots) {
        const shot = raw as Record<string, unknown>;
        const sessionId = shot['sessionId'];
        if (sessionId === null || knownSessions.has(String(sessionId))) {
          acceptedIds.push(String(shot['id']));
        } else {
          rejected.push({
            id: String(shot['id']),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found or not yours.',
          });
        }
      }
      return { acceptedIds, rejected };
    },
  };
  return { transport, calls };
}

describe('outbox drain over a real SQLite database', () => {
  let handle: RealSqliteHandle;
  let db: LocalDb;

  beforeEach(() => {
    handle = openRealSqlite();
    db = migratedLocalDb(handle);
    setActiveDataOwner(owner);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    handle.close();
  });

  it('VERIFIED: saveAnalysis writes local_shot + shot.sync atomically; local-only results never enter the outbox', async () => {
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    await saveLocalOnlyAnalysis(db, {
      ...analysis(uuid(2), null),
      resultKind: 'low_confidence',
      overallScore: null,
    });
    expect(
      handle.executeSync(`SELECT id, result_kind FROM local_shot ORDER BY id`)
        .rows,
    ).toEqual([
      { id: uuid(1), result_kind: 'scored' },
      { id: uuid(2), result_kind: 'low_confidence' },
    ]);
    const outbox = handle.executeSync(
      `SELECT kind, json_extract(payload, '$.id') AS shot_id, json_extract(payload, '$.analysisPermitId') AS permit FROM outbox`,
    ).rows;
    expect(outbox).toEqual([
      { kind: 'shot.sync', shot_id: uuid(1), permit: PERMIT },
    ]);
    // No transaction left open by inTransaction.
    expect(() => handle.executeSync('BEGIN IMMEDIATE')).not.toThrow();
    handle.executeSync('ROLLBACK');
  });

  it('VERIFIED: an accepted shot gets its receipt and loses its outbox row in one committed transaction', async () => {
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    const { transport } = serverLikeTransport('none');
    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    const receiptAt = handle.log.findIndex(sql =>
      sql.includes('INSERT OR REPLACE INTO sync_receipt'),
    );
    expect(handle.log[receiptAt - 1]).toBe('BEGIN IMMEDIATE');
    expect(handle.log[receiptAt + 1]).toContain('DELETE FROM outbox');
    expect(handle.log[receiptAt + 2]).toBe('COMMIT');
    expect(await hasShotSyncReceipt(db, uuid(1))).toBe(true);
    expect(await getShotOutboxStatus(db, uuid(1))).toEqual({ state: 'absent' });
  });

  it('VERIFIED: a session.create that fails with an ordinary 4xx burns exactly one attempt per drain and is excluded after 8', async () => {
    const broken = uuid(900);
    await saveAnalysis(db, analysis(uuid(1), broken), PERMIT);
    await saveSession(db, {
      id: broken,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    const { transport, calls } = serverLikeTransport(broken);
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, transport);
      expect(
        handle.executeSync(
          `SELECT attempts FROM outbox WHERE kind = 'session.create'`,
        ).rows,
      ).toEqual([{ attempts: i }]);
    }
    const before = calls.createSession;
    await drainOutbox(db, transport);
    expect(calls.createSession).toBe(before);
  });

  it('FINDING sync.ts:139-143 — shots orphaned by an exhausted session.create stay "queued" forever and, at 50, starve every newer row', async () => {
    const broken = uuid(900);
    // One practice set: first shot, then its session.create (practiceSet.ts
    // commitPracticeSet order), then 49 more reps in the same set.
    await saveAnalysis(db, analysis(uuid(1), broken), PERMIT);
    await saveSession(db, {
      id: broken,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    for (let n = 2; n <= 50; n += 1) {
      await saveAnalysis(db, analysis(uuid(n), broken), PERMIT);
    }
    const { transport, calls } = serverLikeTransport(broken);
    // Eight drains exhaust the session.create row (ordinary 4xx budget).
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, transport);
    }
    expect(
      handle.executeSync(
        `SELECT attempts FROM outbox WHERE kind = 'session.create'`,
      ).rows,
    ).toEqual([{ attempts: OUTBOX_MAX_ATTEMPTS }]);

    // Later, a brand-new valid set: its shot and its session.create.
    const fresh = uuid(901);
    await saveAnalysis(db, analysis(uuid(51), fresh), PERMIT);
    await saveSession(db, {
      id: fresh,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-27T18:00:00.000Z',
    });
    const createsBefore = calls.createSession;
    for (let i = 0; i < 20; i += 1) {
      await drainOutbox(db, transport);
    }

    // Evidence of the orphan behaviour: 50 rows at attempts=0 with a
    // transient verdict, reported to the UI as still "queued".
    const orphan = await getShotOutboxStatus(db, uuid(1));
    expect(orphan).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: expect.stringContaining(SESSION_NOT_FOUND_REJECTION),
    });

    // Expected contract: the new, valid set reaches the server.
    expect(calls.createSession).toBeGreaterThan(createsBefore);
    expect(await hasShotSyncReceipt(db, uuid(51))).toBe(true);
    expect(await getShotOutboxStatus(db, uuid(51))).toEqual({
      state: 'absent',
    });
  });

  it('FINDING repository.ts:859-865 — one non-JSON shot.sync row makes getShotOutboxStatus throw for every OTHER shot', async () => {
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    handle.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'not json')`,
      [owner],
    );
    // The healthy shot's status is what ResultScreen loads (line 282).
    let error: unknown = null;
    let status: unknown = null;
    try {
      status = await getShotOutboxStatus(db, uuid(1));
    } catch (caught) {
      error = caught;
    }
    if (error) {
      expect(String((error as Error).message)).toMatch(/malformed JSON/i);
    }
    expect(error).toBeNull();
    expect(status).toEqual({ state: 'queued', attempts: 0, lastError: null });
  });

  it('VERIFIED: purgeOwnerData removes exactly one owner across all 6 tables + 5 kv namespaces and commits', async () => {
    const other = canonicalDataOwner('22222222-2222-4222-8222-222222222222');
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    await drainOutbox(db, serverLikeTransport('none').transport); // receipt row
    await saveAnalysis(db, analysis(uuid(2), uuid(900)), PERMIT);
    await saveSession(db, {
      id: uuid(900),
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    for (const ns of OWNER_SCOPED_KV_NAMESPACES) {
      await setKv(db, `${ns}:${owner}`, '{"mine":true}');
      await setKv(db, `${ns}:${other}`, '{"theirs":true}');
    }
    await setKv(db, 'onboarding.pending-profile', '{"device":true}');
    handle.executeSync(
      `INSERT INTO local_shot (owner_key, id, shot_type, captured_at, confidence, result_kind, source, payload)
       VALUES (?, ?, 'forehand_drive', '2026-08-26T18:00:00.000Z', 0.9, 'scored', 'real', '{}')`,
      [other, uuid(3)],
    );
    handle.executeSync(
      `INSERT INTO local_capture (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status)
       VALUES (?, ?, 'file:///a.mov', 'forehand_drive', '2026-08-26T18:00:00.000Z', 2000, 30, 1080, 1920, 'analyzed')`,
      [owner, uuid(4)],
    );
    handle.executeSync(
      `INSERT INTO local_analysis_record (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, '2026-08-26T18:00:00.000Z', 'e1', 'sm-v1', '{}')`,
      [owner, uuid(5), uuid(4)],
    );

    await purgeOwnerData(db, owner);

    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
    ]) {
      expect(
        handle.executeSync(
          `SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`,
          [owner],
        ).rows,
      ).toEqual([{ n: 0 }]);
    }
    expect(
      handle
        .executeSync(`SELECT key FROM kv ORDER BY key`)
        .rows.map(r => String(r['key'])),
    ).toEqual(
      [
        'onboarding.pending-profile',
        ...OWNER_SCOPED_KV_NAMESPACES.map(ns => `${ns}:${other}`),
      ].sort(),
    );
    expect(handle.executeSync(`SELECT id FROM local_shot`).rows).toEqual([
      { id: uuid(3) },
    ]);
    expect(() => handle.executeSync('BEGIN IMMEDIATE')).not.toThrow();
    handle.executeSync('ROLLBACK');
  });

  it('VERIFIED: the drain quarantines a non-JSON shot.sync row alone (permanent, one attempt) while healthy rows sync', async () => {
    handle.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', 'not json')`,
      [owner],
    );
    await saveAnalysis(db, analysis(uuid(1), null), PERMIT);
    const { transport } = serverLikeTransport('none');
    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 1, failed: 1, remaining: 1 });
    expect(
      handle.executeSync(
        `SELECT attempts, last_error FROM outbox WHERE payload = 'not json'`,
      ).rows,
    ).toEqual([{ attempts: 1, last_error: expect.stringContaining('JSON') }]);
    expect(await hasShotSyncReceipt(db, uuid(1))).toBe(true);
  });
});
