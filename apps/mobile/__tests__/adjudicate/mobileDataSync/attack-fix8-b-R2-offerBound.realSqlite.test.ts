/**
 * ADVERSARY fix round 8 / candidate B (d1c42d78) — claim 4 bounds.
 *
 * Stated: "any shot ≤8 offers lifetime; unpark keeps attempts monotone" and
 * (sync.ts) the attempt count "equal[s] the refusals the server issued".
 *
 * `settleSessionNotFound` case 3 with `attemptsAfter >= OUTBOX_MAX_ATTEMPTS`
 * parks the shot UNCHARGED and re-arms the set. The next drain's accepted
 * session.create releases it for "one more offer" — which is refused again,
 * parked uncharged again, and re-armed again. Each re-arm buys the shot a
 * further network offer that is never counted, and `saveAnalysis` of a new
 * read into the set resets the re-arm budget, so the shot's lifetime offers
 * grow by one per re-arm forever while `attempts` stays pinned at the cap.
 *
 * Real modules, real node:sqlite, server behaviour = accept every set,
 * refuse every shot `shot.session_not_found` (the pathology the claim is
 * about).
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
  getShotOutboxStatus,
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_REARM_LIMIT,
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
const SET = 'a8a8a8a8-0000-4000-8000-0000000000b2';

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
  await db.execute(`DELETE FROM sync_set_state`);
}

function acceptCreateRefuseShots(): SyncTransport & {
  creates: number;
  offers: string[];
} {
  const t = {
    creates: 0,
    offers: [] as string[],
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots: unknown[]) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      t.offers.push(...ids);
      return {
        acceptedIds: [],
        rejected: ids.map(id => ({
          id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
  return t;
}

describe('attack-fix8-b R2 — lifetime offers of one shot exceed OUTBOX_MAX_ATTEMPTS; attempts stop counting refusals (claim 4)', () => {
  let db: LocalDb;
  let server: ReturnType<typeof acceptCreateRefuseShots>;
  const parked = shotId(0xb501);

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
    server = acceptCreateRefuseShots();
    // A read saved into SET before the set existed on this device (no
    // local_session row): case 4 charges each refusal until the cap parks it.
    await saveAnalysis(
      db,
      realAnalysis({ id: parked, sessionId: SET }),
      PERMIT_ID,
      {},
    );
    for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) {
      await drainOutbox(db, server);
    }
    expect(server.offers.filter(id => id === parked)).toHaveLength(
      OUTBOX_MAX_ATTEMPTS,
    );
    expect(await getShotOutboxStatus(db, parked)).toMatchObject({
      state: 'orphaned',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('R2.1 BREAK — ONE new read saved into the set: the capped shot is offered 3 more times (11 lifetime) while attempts report 9', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xb502), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, server);

    const offersOfParked = server.offers.filter(id => id === parked).length;
    const status = await getShotOutboxStatus(db, parked);
    if (status.state === 'absent') throw new Error('parked row vanished');
    // EXPECTED (claim 4): "any shot ≤8 offers lifetime" and attempts equal
    // to the refusals the server issued.
    // OBSERVED: 8 + (SESSION_REARM_LIMIT + 1) = 11 offers; attempts 9.
    expect({ offersOfParked, attempts: status.attempts }).toEqual({
      offersOfParked: OUTBOX_MAX_ATTEMPTS,
      attempts: offersOfParked,
    });
  });

  it('R2.2 BREAK — a new read saved after every drain: lifetime offers of the capped shot grow without bound while attempts stay at 8', async () => {
    const NEW_READS = 20;
    for (let n = 0; n < NEW_READS; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xb600 + n), sessionId: SET }),
        PERMIT_ID,
        { session: setInput(SET) },
      );
      await drainOutbox(db, server);
    }
    const offersOfParked = server.offers.filter(id => id === parked).length;
    const status = await getShotOutboxStatus(db, parked);
    if (status.state === 'absent') throw new Error('parked row vanished');
    const states = await db.execute(
      `SELECT rearms FROM sync_set_state WHERE owner_key = ? AND session_id = ?`,
      [OWNER, SET],
    );
    // EXPECTED: ≤ OUTBOX_MAX_ATTEMPTS offers over the shot's lifetime.
    // OBSERVED: 8 + NEW_READS offers (one uncharged offer per re-arm; the
    // reset after each new read keeps rearms < SESSION_REARM_LIMIT so the
    // charging branch is never reached); attempts pinned at 8.
    const observed = {
      offersOfParked,
      attempts: status.attempts,
      state: status.state,
      rearms: states.rows[0]?.['rearms'],
    };
    console.log('attack-fix8-b R2.2 observed', observed);
    expect(observed.offersOfParked).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
  });

  it('R2.3 BREAK — the exhausted row promises "it is sent again when a new read is saved into the set" but no new read ever re-offers it', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xb701), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    for (let d = 0; d < SESSION_REARM_LIMIT + 2; d += 1) {
      await drainOutbox(db, server);
    }
    const exhausted = await getShotOutboxStatus(db, parked);
    expect(exhausted).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS + 1,
      lastError: expect.stringContaining(
        'it is sent again when a new read is saved into the set',
      ),
    });
    // ResultScreen renders this row as "Sync was refused 9 times and this
    // read will not be sent again (last response: … it is sent again when a
    // new read is saved into the set.)" — self-contradictory. Take the copy
    // at its word: save new reads into the set and drain.
    const before = server.offers.filter(id => id === parked).length;
    for (let n = 0; n < 3; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xb710 + n), sessionId: SET }),
        PERMIT_ID,
        { session: setInput(SET) },
      );
      for (let d = 0; d < 3; d += 1) await drainOutbox(db, server);
    }
    const after = server.offers.filter(id => id === parked).length;
    const rows = await outboxRows(db, OWNER);
    const row = rows.find(
      r => r.kind === 'shot.sync' && r.attempts === OUTBOX_MAX_ATTEMPTS + 1,
    );
    // EXPECTED (claim 7, truthful copy): either the row is re-offered after a
    // new read is saved, or its last_error does not say it will be.
    // OBSERVED: never re-offered (attempts 9 is invisible to SHOT_PASS) and
    // the stored reason still promises the resend.
    const observed = {
      reofferedAfterNewReads: after - before,
      attempts: row?.attempts,
      promisesResend: Boolean(
        row?.last_error?.includes(
          'it is sent again when a new read is saved into the set',
        ),
      ),
    };
    console.log('attack-fix8-b R2.3 observed', observed);
    const copyLiesAboutResend =
      observed.promisesResend && observed.reofferedAfterNewReads === 0;
    expect(copyLiesAboutResend).toBe(false);
  });
});
