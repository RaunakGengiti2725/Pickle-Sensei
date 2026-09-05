/**
 * Adversary round 7 — candidate B (`devin/fix6-mds-sqlite-b` @ 7bd9d7af),
 * ported to candidate A in fix round 8 (imports/helpers only; the
 * description below is of the candidate it was written against, and the
 * assertions pin the corrected semantics candidate A now implements).
 *
 * Claim attacked: (5) "exhausted session.create rows are re-armed with a
 * BOUNDED cadence when a new shot of the set is saved or a shot receives
 * shot.session_not_found; the last attempt parks instead of exhausting;
 * accepted session.create retires duplicates and unparks the set's shots",
 * and (6) truthful ResultScreen copy.
 *
 * B7-3: the shot pass re-queues a parked set from its local_session row when
 * the set is in none of this drain's session-pass sets. That set-membership
 * is only as complete as the session pass got: a transient failure on page 1
 * (`reachable = false`) stops paging, so a dead set whose exhausted
 * `session.create` row sits on page 2 is invisible, and the parked shot
 * re-arms it (a NEW live row beside the exhausted one) with neither a new
 * shot nor a `shot.session_not_found` verdict — the two triggers the claim
 * bounds the cadence by.
 *
 * B7-4: with a server that accepts `session.create` (idempotent upsert) but
 * answers `shot.session_not_found` for the set's shot, the drain re-queues
 * the set on every verdict, the accepted row retires and UNPARKS the shot
 * (attempts reset to 0), and the cycle never terminates: every drain costs
 * one createSession + one syncShots, forever. ResultScreen then reads
 * "refused N of 8 times" with N reset to 0 every ninth drain.
 *
 * Every test in this file FAILS on the unmodified candidate. Real
 * node:sqlite, real modules; fault injection only at the transport boundary
 * and via seeded outbox rows.
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
  finishSession,
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
const SET_A = 'a7a7a7a7-0000-4000-8000-000000000001';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
}

describe('B7-3 / B7-4: session.create re-arm cadence is not bounded (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('B7-3: a session pass cut short on page 1 lets a parked shot re-arm its dead set with no new shot and no session_not_found verdict', async () => {
    // Page 1 of the session pass: 50 finalize rows for other sessions whose
    // server answers 503 (transient → the pass stops after this page).
    for (let i = 0; i < 50; i += 1) await finishSession(db, `f${i}`, {});
    // Page 2: the dead set — session.create exhausted, its shot parked, the
    // local_session row still present.
    await db.execute(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, '2026-08-26T18:00:00.000Z')`,
      [OWNER, SET_A],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, 'ApiError: 409 session.id_conflict')`,
      [OWNER, JSON.stringify(setInput(SET_A)), OUTBOX_MAX_ATTEMPTS],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, 0, 'shot.session_orphaned: Session not found for this shot. Its practice set was refused for good.')`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(0x30), sessionId: SET_A }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );
    let createCalls = 0;
    const transport: SyncTransport = {
      async createSession() {
        createCalls += 1;
        throw new ApiError(409, 'session.id_conflict', 'conflict');
      },
      async finalizeSession() {
        throw new ApiError(503, 'unavailable', 'down');
      },
      async syncShots() {
        return { acceptedIds: [], rejected: [] };
      },
    };
    const before = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'session.create',
    );
    // Three drains while the finalize server stays down.
    for (let d = 0; d < 3; d += 1) await drainOutbox(db, transport);
    const after = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'session.create',
    );
    // Nothing re-armed the set: no new shot, no session_not_found verdict.
    expect({ after, createCalls }).toEqual({ after: before, createCalls: 0 });
  });

  it('B7-4: accept + session_not_found ping-pong — createSession/syncShots calls grow linearly with drains and the shot never settles', async () => {
    let creates = 0;
    let offers = 0;
    const transport: SyncTransport = {
      async createSession() {
        creates += 1;
      },
      async finalizeSession() {},
      async syncShots(shots) {
        offers += 1;
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: string }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
        };
      },
    };
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x40), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const attemptsTrace: number[] = [];
    for (let d = 0; d < 40; d += 1) {
      await drainOutbox(db, transport);
      const status = await getShotOutboxStatus(db, shotId(0x40));
      attemptsTrace.push(
        status.state === 'queued' ||
          status.state === 'rejected' ||
          status.state === 'exhausted' ||
          status.state === 'orphaned'
          ? status.attempts
          : -1,
      );
    }
    // Bounded: one set, one shot, budget OUTBOX_MAX_ATTEMPTS — the server can
    // be asked to create the set at most once per shot attempt, and the shot
    // attempt counter is monotone until it settles.
    const monotone = attemptsTrace.every(
      (a, i) => i === 0 || a >= attemptsTrace[i - 1]!,
    );
    const bound = OUTBOX_MAX_ATTEMPTS + 1;
    const observed = {
      creates,
      offers,
      monotone,
      trace: attemptsTrace.join(','),
    };
    expect(observed).toEqual({
      ...observed,
      creates: Math.min(creates, bound),
      offers: Math.min(offers, bound),
      monotone: true,
    });
  });

  it('B7-4b: after the cycle wraps, ResultScreen reads "refused N of 8 times" with N smaller than the refusals the server actually issued', async () => {
    let offers = 0;
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offers += 1;
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: string }).id),
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found for this shot.',
          })),
        };
      },
    };
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x41), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let d = 0; d < 13; d += 1) await drainOutbox(db, transport);
    const status = await getShotOutboxStatus(db, shotId(0x41));
    // `rejected` copy: "The server refused this read {attempts} of 8 times".
    // The server has refused it `offers` times; the two must agree (or the
    // row must have settled) for the copy to be truthful.
    expect(status.state === 'rejected' ? status.attempts : status.state).toBe(
      offers,
    );
  });
});
