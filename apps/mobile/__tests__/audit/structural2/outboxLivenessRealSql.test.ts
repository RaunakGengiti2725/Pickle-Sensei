/**
 * Structural audit (mobile-data-sync, pass 1) — `drainOutbox` +
 * `repository.ts` writes executed against REAL SQLite (schema created by the
 * production `getDb()` migrations).
 *
 * Run: `cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *       __tests__/audit/structural2/outboxLivenessRealSql.test.ts`
 */
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import type { LocalDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
} from '../../../src/data/sync';
import {
  AUDIT_OWNER_A,
  AUDIT_PERMIT_ID,
  auditUuid,
  recordingTransport,
  scoredAnalysis,
} from '../../../test-support/audit/fixtures';
import {
  openRealSqliteLocalDb,
  opSqliteHandleFor,
  type RealSqliteLocalDb,
} from '../../../test-support/audit/realSqliteLocalDb';

let mockRaw: DatabaseSync | null = null;
const mockOpen = jest.fn(() => {
  if (!mockRaw) throw new Error('test did not provide a database');
  return opSqliteHandleFor(mockRaw);
});
jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

function migratedDb(): RealSqliteLocalDb {
  mockRaw = new DatabaseSync(':memory:');
  const loaded: { getDb?: () => LocalDb } = {};
  jest.isolateModules(() => {
    loaded.getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!loaded.getDb) throw new Error('db module did not load');
  loaded.getDb();
  return openRealSqliteLocalDb(mockRaw);
}

const SESSION_ID = 'dddddddd-bbbb-4ccc-8ddd-000000000001';

function sessionNotFoundFor(shots: Array<Record<string, unknown>>) {
  return {
    acceptedIds: shots
      .filter(shot => shot['sessionId'] === null)
      .map(shot => String(shot['id'])),
    rejected: shots
      .filter(shot => shot['sessionId'] !== null)
      .map(shot => ({
        id: String(shot['id']),
        code: SESSION_NOT_FOUND_REJECTION,
        message: 'Session not found or not yours.',
      })),
  };
}

let db: RealSqliteLocalDb;

beforeEach(() => {
  setActiveDataOwner(AUDIT_OWNER_A);
  db = migratedDb();
});

afterEach(() => {
  db.close();
  mockRaw = null;
  setActiveDataOwner('signed-out');
});

describe('drainOutbox on real SQL — invariants that hold', () => {
  it('receipt insert + outbox delete commit together and a corrupt row fails alone', async () => {
    await saveAnalysis(
      db,
      scoredAnalysis({ id: auditUuid(1) }),
      AUDIT_PERMIT_ID,
    );
    db.query(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{"id":"broken"')`,
      [AUDIT_OWNER_A],
    );
    await saveAnalysis(
      db,
      scoredAnalysis({ id: auditUuid(2) }),
      AUDIT_PERMIT_ID,
    );
    const { transport, calls } = recordingTransport({
      syncShots: async shots => ({
        acceptedIds: shots.map(shot => String(shot['id'])),
        rejected: [],
      }),
    });

    const result = await drainOutbox(db, transport);

    expect(result).toEqual({ synced: 2, failed: 1, remaining: 1 });
    expect(calls).toHaveLength(1);
    expect(await hasShotSyncReceipt(db, auditUuid(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, auditUuid(2))).toBe(true);
    expect(db.query(`SELECT kind, attempts, last_error FROM outbox`)).toEqual([
      {
        kind: 'shot.sync',
        attempts: 1,
        last_error: expect.stringMatching(/JSON/),
      },
    ]);
    expect(db.query(`SELECT count(*) AS n FROM sync_receipt`)).toEqual([
      { n: 2 },
    ]);
  });

  it('getShotOutboxStatus resolves through json_extract for a healthy owner outbox', async () => {
    await saveAnalysis(
      db,
      scoredAnalysis({ id: auditUuid(7) }),
      AUDIT_PERMIT_ID,
    );
    expect(await getShotOutboxStatus(db, auditUuid(7))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expect(await getShotOutboxStatus(db, auditUuid(8))).toEqual({
      state: 'absent',
    });
  });

  it('getShotOutboxStatus throws (contained by the caller) once a malformed shot.sync payload exists for the owner', async () => {
    await saveAnalysis(
      db,
      scoredAnalysis({ id: auditUuid(7) }),
      AUDIT_PERMIT_ID,
    );
    db.query(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{"id":"broken"')`,
      [AUDIT_OWNER_A],
    );
    await expect(getShotOutboxStatus(db, auditUuid(7))).rejects.toThrow(
      /malformed JSON/,
    );
  });
});

describe('drainOutbox liveness (sync.ts:101-106, 139-143, 247-258)', () => {
  it('a shot whose session.create row is permanently exhausted must reach a terminal state instead of being re-sent forever as "queued"', async () => {
    await saveSession(db, {
      id: SESSION_ID,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    await saveAnalysis(
      db,
      scoredAnalysis({ id: auditUuid(1), sessionId: SESSION_ID }),
      AUDIT_PERMIT_ID,
    );
    const { transport, calls } = recordingTransport({
      createSession: async () => {
        throw new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );
      },
      syncShots: async shots => sessionNotFoundFor(shots),
    });

    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, transport);
    }
    expect(
      db.query(`SELECT attempts FROM outbox WHERE kind = 'session.create'`),
    ).toEqual([{ attempts: OUTBOX_MAX_ATTEMPTS }]);
    const sendsBefore = calls.filter(c => c.method === 'syncShots').length;

    const extraDrains = 12;
    for (let i = 0; i < extraDrains; i++) {
      await drainOutbox(db, transport);
    }
    const sendsAfter = calls.filter(c => c.method === 'syncShots').length;
    const status = await getShotOutboxStatus(db, auditUuid(1));

    expect({
      resentAfterSessionExhausted: sendsAfter - sendsBefore,
      status,
    }).toEqual({
      resentAfterSessionExhausted: 0,
      status: expect.objectContaining({
        state: expect.stringMatching(/^(rejected|exhausted)$/),
      }),
    });
  });

  it('50 rows stuck on a transient rejection must not starve a later valid row of every drain (LIMIT 50 before kind filtering)', async () => {
    for (let i = 1; i <= 50; i++) {
      await saveAnalysis(
        db,
        scoredAnalysis({ id: auditUuid(i), sessionId: SESSION_ID }),
        AUDIT_PERMIT_ID,
      );
    }
    // No session.create row exists for SESSION_ID (e.g. saveSession failed
    // after the score was saved — AnalyzeScreen swallows that error), so the
    // server keeps answering shot.session_not_found, which never burns an
    // attempt. The 51st row is an ordinary, valid, sessionless rating.
    const validId = auditUuid(51);
    await saveAnalysis(
      db,
      scoredAnalysis({ id: validId, sessionId: null }),
      AUDIT_PERMIT_ID,
    );
    const { transport, calls } = recordingTransport({
      syncShots: async shots => sessionNotFoundFor(shots),
    });

    const drains = 10;
    for (let i = 0; i < drains; i++) {
      await drainOutbox(db, transport);
    }

    const validRowWasSent = calls.some(
      call =>
        call.method === 'syncShots' &&
        (call.payload as Array<Record<string, unknown>>).some(
          shot => shot['id'] === validId,
        ),
    );
    expect({
      drains,
      validRowWasSent,
      validRowStatus: await getShotOutboxStatus(db, validId),
      stuckRowsStillQueued: db.query(
        `SELECT count(*) AS n FROM outbox WHERE attempts = 0`,
      ),
    }).toEqual({
      drains,
      validRowWasSent: true,
      validRowStatus: { state: 'absent' },
      stuckRowsStillQueued: [{ n: 50 }],
    });
  });
});
