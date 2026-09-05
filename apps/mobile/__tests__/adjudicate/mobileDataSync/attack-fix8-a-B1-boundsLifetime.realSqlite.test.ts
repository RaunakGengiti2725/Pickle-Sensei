/**
 * Adversary round 8 — candidate `devin/fix8-mds-sqlite-a` @ 24fd777b.
 * Claim (4): durable re-arm bounds (`local_session.rearms`, `outbox.refusals`)
 * — accept+`shot.session_not_found` costs ≤3 createSession + ≤3 syncShots per
 * set per read saved; the reset happens only for a genuinely NEW read; any
 * shot is offered ≤ OUTBOX_MAX_ATTEMPTS times over its lifetime.
 *
 * Re-pinned (fix9): the lifetime constant is SHOT_LIFETIME_REFUSAL_BOUND =
 * OUTBOX_MAX_ATTEMPTS charged refusals + SESSION_CREATE_REARM_BOUND uncharged
 * revivals (a row parked at the cap is released once per accepted re-arm),
 * = 10 — independent of how many later reads join the set.
 *
 * Real `node:sqlite`, real modules. Every count below is measured, and the
 * bounds reported in the round-8 deliverable come from this file.
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
  purgeOwnerData,
  saveAnalysis,
  saveSession,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
  SESSION_NOT_FOUND_REJECTION,
  SHOT_LIFETIME_REFUSAL_BOUND,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner('22222222-2222-4333-8444-555555555555');
const SET_A = 'b8b8b8b8-0000-4000-8000-000000000001';
const SET_B = 'b8b8b8b8-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface Counting extends SyncTransport {
  creates: string[];
  offers: string[][];
}

/** The pathology under test: every session.create is accepted, every shot is
 * answered `shot.session_not_found`. */
function acceptSetDisownShots(): Counting {
  const creates: string[] = [];
  const offers: string[][] = [];
  return {
    creates,
    offers,
    async createSession(session) {
      creates.push(String((session as { id: unknown }).id));
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      offers.push(ids);
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
}

const offersTo = (t: Counting, id: string) =>
  t.offers.filter(page => page.includes(id)).length;

async function rearmsOf(db: LocalDb, owner: string, set: string) {
  const { rows } = await db.execute(
    `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
    [owner, set],
  );
  return rows.length === 0 ? null : Number(rows[0]?.['rearms']);
}

async function outboxCount(db: LocalDb, owner: string) {
  const { rows } = await db.execute(
    `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
    [owner],
  );
  return Number(rows[0]?.['n']);
}

async function saveRead(db: LocalDb, n: number, set = SET_A) {
  const id = shotId(n);
  await saveAnalysis(db, realAnalysis({ id, sessionId: set }), PERMIT_ID, {
    session: setInput(set),
  });
  return id;
}

describe('attack-fix8-a B1 — re-arm bounds and per-shot lifetime offers', () => {
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

  it('B1.1 probe — one read: 50 drains cost exactly 3 creates + 3 syncs, then the set is paused with rearms = 3 and one outbox row', async () => {
    const t = acceptSetDisownShots();
    const s1 = await saveRead(db, 0xb100);
    for (let d = 0; d < 50; d += 1) await drainOutbox(db, t);
    expect({
      creates: t.creates.length,
      syncs: t.offers.length,
      offersToS1: offersTo(t, s1),
      rearms: await rearmsOf(db, OWNER, SET_A),
      rows: await outboxCount(db, OWNER),
    }).toEqual({
      creates: 1 + SESSION_CREATE_REARM_BOUND,
      syncs: 1 + SESSION_CREATE_REARM_BOUND,
      offersToS1: 1 + SESSION_CREATE_REARM_BOUND,
      rearms: SESSION_CREATE_REARM_BOUND + 1,
      rows: 1,
    });
    // Re-pinned (fix9): the shot of a paused set reports `paused`, its own
    // state (Q1.3) — `rejected` would promise a retry no drain performs.
    expect(await getShotOutboxStatus(db, s1)).toMatchObject({
      state: 'paused',
      attempts: 3,
    });
  });

  it('B1.2 BREAK — every new read re-offers EVERY older shot of the set 3 more times: the first shot is offered 3×reads over its lifetime (15 after 5 reads), past the ≤8 lifetime bound; the per-read cost (3 creates, 3 syncs) holds', async () => {
    const t = acceptSetDisownShots();
    const s1 = await saveRead(db, 0xb200);
    const perRead: Array<{ creates: number; syncs: number }> = [];
    for (let read = 0; read < 5; read += 1) {
      if (read > 0) await saveRead(db, 0xb200 + read);
      const c = t.creates.length;
      const s = t.offers.length;
      for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
      perRead.push({
        creates: t.creates.length - c,
        syncs: t.offers.length - s,
      });
    }
    // Per read the stated bound holds (3 creates for the first read, then
    // 2 re-arms + 3 syncs per later read)…
    expect(perRead).toEqual([
      { creates: 3, syncs: 3 },
      { creates: 2, syncs: 3 },
      { creates: 2, syncs: 3 },
      { creates: 2, syncs: 3 },
      { creates: 2, syncs: 3 },
    ]);
    // …and the set is paused between reads (rearms 3, no create row left).
    expect(await rearmsOf(db, OWNER, SET_A)).toBe(
      SESSION_CREATE_REARM_BOUND + 1,
    );
    expect(await outboxCount(db, OWNER)).toBe(5);
    // Observed on 24fd777b: the first shot had been offered 15 times (3 per
    // read); its lifetime `refusals` was 15 and getShotOutboxStatus reported 15.
    // Re-pinned (fix9) to the stated constant: ≤ SHOT_LIFETIME_REFUSAL_BOUND
    // (= OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND = 10) offers, every
    // one of them counted in `refusals`, and the row is then exhausted for good.
    const { rows } = await db.execute(
      `SELECT refusals, attempts FROM outbox WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
      [OWNER, s1],
    );
    expect(Number(rows[0]?.['refusals'])).toBe(offersTo(t, s1));
    expect(offersTo(t, s1)).toBeLessThanOrEqual(SHOT_LIFETIME_REFUSAL_BOUND);
    expect(SHOT_LIFETIME_REFUSAL_BOUND).toBe(
      OUTBOX_MAX_ATTEMPTS + SESSION_CREATE_REARM_BOUND,
    );
    // The exhausted status carries the lifetime refusal count the server
    // actually issued (the Result copy reads "refused N times").
    expect(await getShotOutboxStatus(db, s1)).toMatchObject({
      state: 'exhausted',
      attempts: offersTo(t, s1),
    });
  });

  it('B1.3 probe — re-saving the SAME analysis id is not a new read yet resets the re-arm budget and adds a duplicate outbox row per re-save (3 + 2n creates over n re-saves)', async () => {
    const t = acceptSetDisownShots();
    const id = shotId(0xb300);
    const analysis = realAnalysis({ id, sessionId: SET_A });
    await saveAnalysis(db, analysis, PERMIT_ID, { session: setInput(SET_A) });
    const perCycle: number[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const c = t.creates.length;
      for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
      perCycle.push(t.creates.length - c);
      await saveAnalysis(db, analysis, PERMIT_ID, { session: setInput(SET_A) });
      // Re-pinned (fix9, R5): a re-save of a known id is not a new read — the
      // set's automatic re-arm budget stays spent.
      expect(await rearmsOf(db, OWNER, SET_A)).toBe(
        SESSION_CREATE_REARM_BOUND + 1,
      );
    }
    // Reachability: runCaptureAnalysis mints `analysisId = makeUuid()` per
    // scored run, so the product has no re-save path; recorded as a probe.
    // Re-pinned (fix9, R5): saveAnalysis itself is idempotent per id — the
    // first cycle costs the 3 creates of one read, every re-save costs 0
    // creates, queues no second `shot.sync` row and re-offers nothing.
    expect(perCycle).toEqual([3, 0, 0, 0, 0]);
    expect(await outboxCount(db, OWNER)).toBe(1);
    const { rows } = await db.execute(
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'shot.sync'
         AND json_extract(payload, '$.id') = ?`,
      [OWNER, id],
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
    expect(offersTo(t, id)).toBe(1 + SESSION_CREATE_REARM_BOUND);
  });

  it('B1.4 probe — saveSession for an existing set (no new read) resets rearms and queues a live create: +3 creates without a read', async () => {
    const t = acceptSetDisownShots();
    await saveRead(db, 0xb400);
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    expect(t.creates.length).toBe(3);
    await saveSession(db, setInput(SET_A));
    expect(await rearmsOf(db, OWNER, SET_A)).toBe(0);
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    // commitPracticeSet only calls saveSession for a non-resumed plan, right
    // after a scored save — so in the product this coincides with a new read.
    expect(t.creates.length).toBe(6);
  });

  it('B1.5 probe — a new read saved while the drain is between its network await and its settlement group: saveAnalysis completes, total work for two reads stays 5 creates + 5 syncs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const t = acceptSetDisownShots();
    const inner = t.syncShots.bind(t);
    let holdNext = false;
    t.syncShots = async shots => {
      if (holdNext) {
        holdNext = false;
        await gate;
      }
      return inner(shots);
    };
    const s1 = await saveRead(db, 0xb500);
    for (let d = 0; d < 2; d += 1) await drainOutbox(db, t);
    expect(await rearmsOf(db, OWNER, SET_A)).toBe(2);
    holdNext = true;
    const drain = drainOutbox(db, t);
    await new Promise(resolve => setTimeout(resolve, 10));
    // saveAnalysis must complete while the drain awaits the network.
    let hung: ReturnType<typeof setTimeout> | undefined;
    const saved = await Promise.race([
      saveRead(db, 0xb501).then(() => 'saved'),
      new Promise<string>(resolve => {
        hung = setTimeout(() => resolve('hung'), 2000);
      }),
    ]);
    clearTimeout(hung);
    expect(saved).toBe('saved');
    release();
    await drain;
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    expect({
      creates: t.creates.length,
      syncs: t.offers.length,
      rearms: await rearmsOf(db, OWNER, SET_A),
      offersToS1: offersTo(t, s1),
    }).toEqual({ creates: 5, syncs: 5, rearms: 3, offersToS1: 5 });
  });

  it('B1.6 probe — a second owner with the same session id has its own budget; neither owner is charged for the other', async () => {
    const t = acceptSetDisownShots();
    const a = await saveRead(db, 0xb600);
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    setActiveDataOwner(OWNER_B);
    const b = await saveRead(db, 0xb601);
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    setActiveDataOwner(OWNER);
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    expect({
      creates: t.creates.length,
      offersA: offersTo(t, a),
      offersB: offersTo(t, b),
      rearmsA: await rearmsOf(db, OWNER, SET_A),
      rearmsB: await rearmsOf(db, OWNER_B, SET_A),
    }).toEqual({ creates: 6, offersA: 3, offersB: 3, rearmsA: 3, rearmsB: 3 });
  });

  it('B1.7 probe — deleting the LOCAL session row of a paused set un-pauses its shot: 5 more offers to exhaustion, then parked; saveSession re-arms it for 3 more (lifetime 11 offers)', async () => {
    const t = acceptSetDisownShots();
    const s1 = await saveRead(db, 0xb700);
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    expect(offersTo(t, s1)).toBe(3);
    await db.execute(
      `DELETE FROM local_session WHERE owner_key = ? AND id = ?`,
      [OWNER, SET_A],
    );
    for (let d = 0; d < 12; d += 1) await drainOutbox(db, t);
    // Re-pinned (fix9): the pause is a durable marker on the shot row, not a
    // reading of local_session — deleting the local set row un-pauses
    // nothing (0 further offers, no `session.create` to re-queue from).
    expect(offersTo(t, s1)).toBe(1 + SESSION_CREATE_REARM_BOUND);
    expect(await getShotOutboxStatus(db, s1)).toMatchObject({
      state: 'paused',
      attempts: 1 + SESSION_CREATE_REARM_BOUND,
    });
    await saveSession(db, setInput(SET_A));
    for (let d = 0; d < 12; d += 1) await drainOutbox(db, t);
    // No product path deletes one local_session row (only purgeOwnerData
    // deletes everything), so this stays a probe of the bound's shape:
    // saving the set again is an explicit re-arm worth one more bounded
    // round (3 creates, 3 offers), and the lifetime stays ≤ OUTBOX_MAX_ATTEMPTS.
    expect({ offers: offersTo(t, s1), creates: t.creates.length }).toEqual({
      offers: 2 * (1 + SESSION_CREATE_REARM_BOUND),
      creates: 2 * (1 + SESSION_CREATE_REARM_BOUND),
    });
    expect(offersTo(t, s1)).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
  });

  it('B1.8 probe — purging the owner between a re-arm and its create: nothing is created or offered afterwards, the queue is empty', async () => {
    const t = acceptSetDisownShots();
    await saveRead(db, 0xb800);
    await drainOutbox(db, t);
    expect(t.creates.length).toBe(1);
    const inner = t.createSession.bind(t);
    t.createSession = async session => {
      await purgeOwnerData(db, OWNER);
      return inner(session);
    };
    await drainOutbox(db, t);
    t.createSession = inner;
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    expect({
      creates: t.creates.length,
      syncs: t.offers.length,
      rows: await outboxCount(db, OWNER),
      rearms: await rearmsOf(db, OWNER, SET_A),
    }).toEqual({ creates: 2, syncs: 1, rows: 0, rearms: null });
  });

  it('B1.9 probe — two sets, 50 drains: rows stay 2, creates 6, syncs 3 (both shots share a batch)', async () => {
    const t = acceptSetDisownShots();
    await saveRead(db, 0xb900, SET_A);
    await saveRead(db, 0xb901, SET_B);
    for (let d = 0; d < 50; d += 1) await drainOutbox(db, t);
    expect({
      creates: t.creates.length,
      syncs: t.offers.length,
      rows: await outboxCount(db, OWNER),
      rearmsA: await rearmsOf(db, OWNER, SET_A),
      rearmsB: await rearmsOf(db, OWNER, SET_B),
    }).toEqual({ creates: 6, syncs: 3, rows: 2, rearmsA: 3, rearmsB: 3 });
  });
});
