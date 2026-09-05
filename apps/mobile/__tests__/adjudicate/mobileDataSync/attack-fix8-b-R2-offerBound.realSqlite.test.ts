/**
 * PORT of round-8 candidate B's adversary R2 (cb1fe96a) to candidate A's
 * durable columns (`local_session.rearms`, `outbox.refusals`).
 *
 * B pinned "any shot ≤ OUTBOX_MAX_ATTEMPTS offers lifetime". On this base a
 * shot parked at the attempt cap is RELEASED with a fresh attempt budget when
 * its set is accepted (C1.3 — a legacy parked read must still deliver), so
 * the lifetime bound is necessarily larger than the per-cycle budget. The
 * invariant ported here is the one that matters: a shot's lifetime SERVER
 * REFUSALS — and with them the offers a refusing server sees — are bounded by
 * a constant that does not depend on how many later reads are saved into the
 * set. The constant this port pins:
 *
 *   SHOT_LIFETIME_REFUSAL_BOUND = OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND
 *                               = 8 + 2 = 10
 *
 * (eight charged refusals, plus at most one uncharged-budget revival per
 * automatic re-arm of the set). The reported `attempts` must equal the
 * refusals the server actually issued, and a lifetime-exhausted row's copy
 * must not promise a resend the code does not perform.
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
  SESSION_CREATE_REARM_BOUND,
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
const SET = 'a8a8a8a8-0000-4000-8000-0000000000b2';
/** The lifetime bound this port pins (see the file comment). */
const LIFETIME = OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND;

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

function acceptCreateRefuseShots(): SyncTransport & {
  creates: number;
  offers: string[];
  syncs: number;
} {
  const t = {
    creates: 0,
    syncs: 0,
    offers: [] as string[],
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots: unknown[]) {
      t.syncs += 1;
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

async function refusalsOf(db: LocalDb, id: string): Promise<number> {
  const { rows } = await db.execute(
    `SELECT refusals FROM outbox
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
    [OWNER, id],
  );
  return Number(rows[0]?.['refusals'] ?? -1);
}

describe('attack-fix8-b R2 (ported) — lifetime offers/refusals of one shot are bounded by a constant', () => {
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

  it('R2.1 — ONE new read saved into the set: the capped shot is offered at most LIFETIME times in total and the reported count equals the refusals the server issued', async () => {
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
    expect(offersOfParked).toBeLessThanOrEqual(LIFETIME);
    expect({
      attempts: status.attempts,
      refusals: await refusalsOf(db, parked),
    }).toEqual({ attempts: offersOfParked, refusals: offersOfParked });
  });

  it("R2.2 — a new read saved after every drain, 20 times: the FIRST shot's offer count stops growing at LIFETIME while every new read gets its own budget", async () => {
    const NEW_READS = 20;
    const offersAfterRead: number[] = [];
    for (let n = 0; n < NEW_READS; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xb600 + n), sessionId: SET }),
        PERMIT_ID,
        { session: setInput(SET) },
      );
      await drainOutbox(db, server);
      offersAfterRead.push(server.offers.filter(id => id === parked).length);
    }
    const offersOfParked = offersAfterRead[NEW_READS - 1]!;
    const status = await getShotOutboxStatus(db, parked);
    if (status.state === 'absent') throw new Error('parked row vanished');
    const rearms = await db.execute(
      `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
      [OWNER, SET],
    );
    const observed = {
      offersOfParked,
      attempts: status.attempts,
      state: status.state,
      rearms: rearms.rows[0]?.['rearms'],
      offersAfterRead,
    };
    console.log('attack-fix8-b R2.2 (ported) observed', observed);
    expect(observed.offersOfParked).toBeLessThanOrEqual(LIFETIME);
    // The first shot's count is flat over the second half of the reads: no
    // later read revives a shot that reached its cap.
    expect(offersAfterRead[NEW_READS - 1]).toBe(offersAfterRead[9]);
    expect(await refusalsOf(db, parked)).toBe(offersOfParked);
    // Every one of the 20 new reads was offered (its own budget).
    for (let n = 0; n < NEW_READS; n += 1) {
      expect(server.offers).toContain(shotId(0xb600 + n));
    }
    // And the set's own creates are bounded per read.
    expect(server.creates).toBeLessThanOrEqual(
      NEW_READS * (1 + SESSION_CREATE_REARM_BOUND),
    );
  });

  it('R2.3 — a lifetime-exhausted row does not promise "it is sent again when a new read is saved" unless a new read re-offers it', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xb701), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    for (let d = 0; d < SESSION_CREATE_REARM_BOUND + 2; d += 1) {
      await drainOutbox(db, server);
    }
    const exhausted = await getShotOutboxStatus(db, parked);
    expect(exhausted).toMatchObject({
      state: 'exhausted',
      attempts: LIFETIME,
    });
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
      r => r.kind === 'shot.sync' && r.attempts >= OUTBOX_MAX_ATTEMPTS,
    );
    const observed = {
      reofferedAfterNewReads: after - before,
      attempts: row?.attempts,
      promisesResend:
        /sent again|will be retried|until a new read|until the set is accepted|until one is accepted/i.test(
          row?.last_error ?? '',
        ),
    };
    console.log('attack-fix8-b R2.3 (ported) observed', observed);
    const copyLiesAboutResend =
      observed.promisesResend && observed.reofferedAfterNewReads === 0;
    expect(copyLiesAboutResend).toBe(false);
    // Lifetime-exhausted: never offered again, whatever joins the set.
    expect(observed.reofferedAfterNewReads).toBe(0);
    expect(before).toBeLessThanOrEqual(LIFETIME);
  });
});
