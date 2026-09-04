/**
 * Review round 7 (candidate A, 9a00ceb1) — recoverability probes on real
 * node:sqlite. These MEASURE the design; expectations are the observed
 * behaviour, written down so the reviewer can quote exact bounds.
 *
 *  R4a a server that accepts session.create but answers
 *      shot.session_not_found for its shots FOREVER: rows never grow, each
 *      drain does O(1) network work per set, but the cycle
 *      (park → re-queue → create → offer → not_found) never terminates.
 *  R4b a server that refuses session.create forever (permanent): one budget
 *      of 8 per occasion; without a new shot nothing is asked again.
 *  R4c legacy rows from the pre-fix build (attempts=8, old last_error
 *      strings) — how they surface and whether a drain touches them.
 *  R4d re-arm / unpark are owner-isolated.
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
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OTHER = canonicalDataOwner('22222222-2222-4333-8444-555555555555');
const SET_A = 'a5a5a5a5-0000-4000-8000-0000000000a1';
const SET_B = 'a5a5a5a5-0000-4000-8000-0000000000b2';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface Emulator extends SyncTransport {
  created: string[];
  offered: string[][];
  createError: (() => Error) | null;
  /** When true the server never knows any session (answers not_found). */
  amnesia: boolean;
}

function serverEmulator(): Emulator {
  const known = new Set<string>();
  const created: string[] = [];
  const offered: string[][] = [];
  const emulator: Emulator = {
    created,
    offered,
    createError: null,
    amnesia: false,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
      if (emulator.createError) throw emulator.createError();
      known.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
        if (
          shot.sessionId &&
          (emulator.amnesia || !known.has(shot.sessionId))
        ) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          });
        } else {
          acceptedIds.push(shot.id);
        }
      }
      offered.push(ids);
      return { acceptedIds, rejected };
    },
  };
  return emulator;
}

describe('review7 / recoverability bounds (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('R4a: server accepts the set but answers session_not_found forever — rows stay constant, work per drain is O(1) per set, but the cycle never terminates', async () => {
    const server = serverEmulator();
    server.amnesia = true;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xa1), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const rowCounts: number[] = [];
    const createdPerDrain: number[] = [];
    const offeredPerDrain: number[] = [];
    const states: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const c0 = server.created.length;
      const o0 = server.offered.length;
      await drainOutbox(db, server);
      createdPerDrain.push(server.created.length - c0);
      offeredPerDrain.push(server.offered.length - o0);
      rowCounts.push((await outboxRows(db, OWNER)).length);
      const s = await getShotOutboxStatus(db, shotId(0xa1));
      states.push(s.state === 'absent' ? 'absent' : `${s.state}@${s.attempts}`);
    }
    // Row growth: bounded (≤ 2 rows: the shot and at most one session.create).
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(2);
    // Work per drain: at most one createSession and one syncShots for the set.
    expect(Math.max(...createdPerDrain)).toBeLessThanOrEqual(1);
    expect(Math.max(...offeredPerDrain)).toBeLessThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(
      `review7 R4a: created=${server.created.length} offered=${server.offered.length} over 40 drains; states=${states.join(',')}`,
    );
    // The cycle does NOT terminate: after 40 drains the server is still
    // being asked (this is the measured behaviour; see the review report).
    expect(server.created.length).toBeGreaterThan(8);
    expect(server.offered.length).toBeGreaterThan(OUTBOX_MAX_ATTEMPTS);
  });

  it('R4b: server refuses session.create permanently — exactly 8 createSession calls per occasion, then silence until a new shot joins the set', async () => {
    const server = serverEmulator();
    server.createError = () =>
      new ApiError(409, 'session.id_conflict', 'Session id belongs to another account.');
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xb1), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let i = 0; i < 30; i += 1) await drainOutbox(db, server);
    expect(server.created).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    // The shot was offered exactly once (the drain that exhausted the set
    // parked it) and is parked, not exhausted.
    expect(server.offered).toHaveLength(1);
    expect(await getShotOutboxStatus(db, shotId(0xb1))).toMatchObject({
      state: 'orphaned',
      attempts: 0,
    });
    expect(await outboxRows(db, OWNER)).toHaveLength(2);

    // Occasion: a new shot joins the set → one more budget of 8.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xb2), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let i = 0; i < 30; i += 1) await drainOutbox(db, server);
    expect(server.created).toHaveLength(2 * OUTBOX_MAX_ATTEMPTS);
    expect(await outboxRows(db, OWNER)).toHaveLength(3);
    expect(server.offered.length).toBeLessThanOrEqual(2);
  });

  it('R4c: legacy pre-fix rows (attempts=8, old last_error) — a shot.sync row is shown as exhausted and never offered; a session.create row marks its set dead (parks later shots) and is revived by a new shot', async () => {
    const server = serverEmulator();
    const legacyShot = shotId(0xc1);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, 8, 'shot.session_not_found: Session not found for this shot.')`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: legacyShot, sessionId: SET_B }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );
    await db.execute(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, '2026-08-26T18:00:00.000Z')`,
      [OWNER, SET_B],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, 8, 'ApiError 500 server_error')`,
      [OWNER, JSON.stringify(setInput(SET_B))],
    );
    await drainOutbox(db, server);
    expect(server.created).toHaveLength(0);
    expect(server.offered).toHaveLength(0);
    expect(await getShotOutboxStatus(db, legacyShot)).toMatchObject({
      state: 'exhausted',
      attempts: 8,
    });

    // A new shot of the same set re-arms the legacy exhausted session.create.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xc2), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    await drainOutbox(db, server);
    expect(server.created).toEqual([SET_B]);
    // The new shot is delivered; the legacy exhausted shot stays exhausted
    // (never revived — it is not parked under the orphaned verdict).
    expect(server.offered.flat()).toEqual([shotId(0xc2)]);
    expect(await getShotOutboxStatus(db, legacyShot)).toMatchObject({
      state: 'exhausted',
    });
  });

  it('R4d: re-arm and unpark are owner-isolated', async () => {
    const server = serverEmulator();
    server.createError = () =>
      new ApiError(409, 'session.id_conflict', 'conflict');
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xd1), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let i = 0; i < 10; i += 1) await drainOutbox(db, server);
    expect(server.created).toHaveLength(OUTBOX_MAX_ATTEMPTS);

    // OTHER owner saves a shot for a set with the same id: it must not re-arm
    // OWNER's exhausted row nor release OWNER's parked shot.
    setActiveDataOwner(OTHER);
    server.createError = null;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xd2), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    await drainOutbox(db, server);
    expect(await outboxRows(db, OTHER)).toHaveLength(0);
    const ownerRows = await outboxRows(db, OWNER);
    expect(ownerRows).toHaveLength(2);
    expect(ownerRows.find(r => r.kind === 'session.create')?.attempts).toBe(8);
    setActiveDataOwner(OWNER);
    expect(await getShotOutboxStatus(db, shotId(0xd1))).toMatchObject({
      state: 'orphaned',
    });
  });
});
