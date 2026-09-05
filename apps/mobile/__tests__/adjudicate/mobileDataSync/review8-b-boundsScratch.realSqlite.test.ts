/**
 * Review round 8 (candidate B, d1c42d78) — independent reviewer scratch probes
 * on real node:sqlite for R3(e,f) and R4 (bounds / row growth / unpark).
 * NOT part of the candidate; lives on devin/review8-sqlite-b-scratch only.
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
  hasShotSyncReceipt,
  purgeOwnerData,
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
  leaseWaiters,
  resetLeaseWaiterPeak,
} from '../../../src/data/transaction';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SET_A = 'b8b8b8b8-0000-4000-8000-000000000001';
const SET_B = 'b8b8b8b8-0000-4000-8000-000000000002';
const SET_C = 'b8b8b8b8-0000-4000-8000-000000000003';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
  await db.execute(`DELETE FROM sync_set_state`);
}

interface PingPong extends SyncTransport {
  creates: number;
  offers: number;
  offeredIds: string[];
}
function acceptCreateRefuseShots(): PingPong {
  const t: PingPong = {
    creates: 0,
    offers: 0,
    offeredIds: [],
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots) {
      t.offers += 1;
      for (const s of shots)
        t.offeredIds.push(String((s as { id: string }).id));
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
  return t;
}

describe('review8 candidate B — bounds scratch (real SQLite)', () => {
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

  it('R3e — 1000-op seeded interleave (same seed as fix8 L1): record lease_waiters_max', async () => {
    const rnd = seeded(0x1ea5e);
    let pending = 0;
    let inFlightMax = 0;
    const track = <T>(p: Promise<T>): Promise<T> => {
      pending += 1;
      inFlightMax = Math.max(inFlightMax, pending);
      return p.finally(() => {
        pending -= 1;
      });
    };
    const known = new Set<string>();
    let flaky = false;
    const transport: SyncTransport = {
      async createSession(session) {
        if (flaky && rnd() < 0.3) {
          throw new ApiError(503, 'server.unavailable', 'x');
        }
        known.add(String((session as { id: unknown }).id));
      },
      async finalizeSession() {},
      async syncShots(shots) {
        await Promise.resolve();
        const acceptedIds: string[] = [];
        const rejected: Array<{ id: string; code: string; message: string }> =
          [];
        for (const raw of shots) {
          const shot = raw as { id: string; sessionId: string | null };
          if (shot.sessionId && !known.has(shot.sessionId)) {
            rejected.push({
              id: shot.id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found for this shot.',
            });
          } else {
            acceptedIds.push(shot.id);
          }
        }
        return { acceptedIds, rejected };
      },
    };
    const sets = [SET_A, SET_B, SET_C];
    const all: Promise<unknown>[] = [];
    let saves = 0;
    let drains = 0;
    let purges = 0;
    resetLeaseWaiterPeak();
    let peakSampled = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = rnd();
      if (r < 0.6) {
        const id = shotId(0x9300 + i);
        const set = rnd() < 0.7 ? sets[i % sets.length]! : null;
        saves += 1;
        all.push(
          track(
            saveAnalysis(
              db,
              realAnalysis({ id, sessionId: set }),
              PERMIT_ID,
              set ? { session: setInput(set) } : {},
            ),
          ),
        );
      } else if (r < 0.97) {
        flaky = rnd() < 0.3;
        drains += 1;
        all.push(track(drainOutbox(db, transport)));
      } else {
        purges += 1;
        all.push(track(purgeOwnerData(db, OWNER)));
      }
      peakSampled = Math.max(peakSampled, leaseWaiters().pending);
      if (rnd() < 0.2) {
        for (let k = 0; k < 3; k += 1) await Promise.resolve();
      }
    }
    await Promise.all(all);
    const waiters = leaseWaiters();
    console.log(
      `R3e lease_waiters_max=${waiters.peak} sampledPeak=${peakSampled} inFlightMax=${inFlightMax} ops={saves:${saves},drains:${drains},purges:${purges}}`,
    );
    expect(waiters.pending).toBe(0);
    expect(waiters.peak).toBeLessThanOrEqual(inFlightMax);
    // Bounded by the number of concurrently issued operations, and never
    // by the number of drains × rows (a drain never holds a slot while on the
    // network).
    expect(waiters.peak).toBeLessThanOrEqual(1000);
  });

  it('R3f — a repository transaction that rolls back is never observed by a concurrent drain; drain writes never join it', async () => {
    // Seed one healthy row so the drain has work.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9401), sessionId: null }),
      PERMIT_ID,
      {},
    );
    // A save whose local_shot INSERT fails after its outbox INSERT succeeded:
    // the transaction rolls back; the outbox row must never be seen.
    const failingDb: LocalDb = {
      async execute(sql, params) {
        if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
          // Give a concurrent drain the chance to interleave here.
          for (let k = 0; k < 20; k += 1) await Promise.resolve();
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    const t = acceptAllTransport();
    const save = saveAnalysis(
      failingDb,
      realAnalysis({ id: shotId(0x9402), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const drain = drainOutbox(db, t);
    await expect(save).rejects.toThrow('SQLITE_FULL');
    const result = await drain;
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    const offered = t.syncCalls
      .flat()
      .map(s => String((s as { id: unknown }).id));
    expect(offered).toEqual([shotId(0x9401)]);
    expect(t.sessions).toEqual([]);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(
      (
        await db.execute(`SELECT id FROM local_session WHERE owner_key = ?`, [
          OWNER,
        ])
      ).rows,
    ).toEqual([]);
    expect(leaseWaiters().pending).toBe(0);
  });

  it('R4a — perpetual accept+session_not_found: 200 drains, bounded calls, bounded rows (outbox + sync_set_state), attempts monotone, unpark never resets attempts', async () => {
    const t = acceptCreateRefuseShots();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9501), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    let prevAttempts = 0;
    for (let d = 0; d < 200; d += 1) {
      await drainOutbox(db, t);
      const s = await getShotOutboxStatus(db, shotId(0x9501));
      const attempts = 'attempts' in s ? s.attempts : -1;
      expect(attempts).toBeGreaterThanOrEqual(prevAttempts);
      prevAttempts = attempts;
    }
    const rows = await outboxRows(db, OWNER);
    const setState = await db.execute(`SELECT * FROM sync_set_state`);
    console.log(
      `R4a creates=${t.creates} offers=${t.offers} outboxRows=${rows.length} setStateRows=${setState.rows.length} attempts=${prevAttempts}`,
    );
    expect({ creates: t.creates, offers: t.offers }).toEqual({
      creates: SESSION_REARM_LIMIT + 1,
      offers: SESSION_REARM_LIMIT,
    });
    expect(rows).toHaveLength(1);
    expect(setState.rows).toEqual([
      { owner_key: OWNER, session_id: SET_B, rearms: SESSION_REARM_LIMIT },
    ]);
    expect(prevAttempts).toBe(t.offers);

    // Abuse probe: 5 new reads saved into the same set → each grants ONE more
    // round of SESSION_REARM_LIMIT; total calls grow linearly in real reads,
    // never in drains.
    for (let n = 0; n < 5; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x9510 + n), sessionId: SET_B }),
        PERMIT_ID,
        { session: setInput(SET_B) },
      );
      for (let d = 0; d < 30; d += 1) await drainOutbox(db, t);
    }
    const shot1 = await getShotOutboxStatus(db, shotId(0x9501));
    const shot1Offers = t.offeredIds.filter(id => id === shotId(0x9501)).length;
    console.log(
      `R4a after 5 new reads: creates=${t.creates} offers=${t.offers} outbox=${(await outboxRows(db, OWNER)).length} shot1=${JSON.stringify(shot1)} shot1Offers=${shot1Offers}`,
    );
    // The lifetime attempt count of the first read is monotone and equals the
    // refusals the server actually issued for it while it was charged.
    expect('attempts' in shot1 ? shot1.attempts : -1).toBeGreaterThanOrEqual(
      SESSION_REARM_LIMIT,
    );
    expect(t.creates).toBeLessThanOrEqual(
      SESSION_REARM_LIMIT + 1 + 5 * (SESSION_REARM_LIMIT + 1),
    );
    expect(t.offers).toBeLessThanOrEqual(
      SESSION_REARM_LIMIT + 5 * (SESSION_REARM_LIMIT + 1),
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual(
      Array(6).fill('shot.sync'),
    );
    expect(
      (await db.execute(`SELECT count(*) AS n FROM sync_set_state`)).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('R4b — a shot never gets more than OUTBOX_MAX_ATTEMPTS offers in its lifetime under a server that refuses every shot for a non-session reason', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9601), sessionId: SET_C }),
      PERMIT_ID,
      { session: setInput(SET_C) },
    );
    let offers = 0;
    const t: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offers += shots.length;
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: string }).id),
            code: 'shot.invalid',
            message: 'nope',
          })),
        };
      },
    };
    for (let d = 0; d < 50; d += 1) await drainOutbox(db, t);
    expect(offers).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(await getShotOutboxStatus(db, shotId(0x9601))).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    // New reads into the set do not revive an exhausted (non-parked) shot.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9602), sessionId: SET_C }),
      PERMIT_ID,
      { session: setInput(SET_C) },
    );
    for (let d = 0; d < 10; d += 1) await drainOutbox(db, t);
    expect(offers).toBe(2 * OUTBOX_MAX_ATTEMPTS);
    expect(await getShotOutboxStatus(db, shotId(0x9601))).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
  });

  it('R4c — pre-fix rows: attempts=8 old-string exhausted, parked marker from round-6, malformed JSON, null payload, NULL owner_key — handled deliberately, healthy rows unaffected', async () => {
    // Legacy exhausted shot with an old-style last_error.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, 8, 'ApiError: 422 shot.invalid')`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(0x9701), sessionId: null }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );
    // Round-6 parked marker at the cap for a set with no local_session.
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', ?, 8, 'shot.session_orphaned: Session not found for this shot. No practice set is known for this read on this device; it is paused until one is accepted.')`,
      [
        OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(0x9702), sessionId: SET_A }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{broken')`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', 'null')`,
      [OWNER],
    );
    // NULL owner_key row (schema permitting) — must never be drained under
    // this owner nor break the drain.
    let nullOwnerInserted = true;
    try {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (NULL, 'shot.sync', '{}')`,
      );
    } catch {
      nullOwnerInserted = false;
    }
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9703), sessionId: null }),
      PERMIT_ID,
      {},
    );
    const t = acceptAllTransport();
    const r1 = await drainOutbox(db, t);
    console.log(
      `R4c nullOwnerInserted=${nullOwnerInserted} r1=${JSON.stringify(r1)}`,
    );
    expect(r1.synced).toBe(1);
    expect(r1.failed).toBe(2); // the two malformed rows, quarantined once
    expect(await hasShotSyncReceipt(db, shotId(0x9703))).toBe(true);
    expect(
      t.syncCalls.flat().map(s => String((s as { id: unknown }).id)),
    ).toEqual([shotId(0x9703)]);
    expect(await getShotOutboxStatus(db, shotId(0x9701))).toMatchObject({
      state: 'exhausted',
      attempts: 8,
    });
    expect(await getShotOutboxStatus(db, shotId(0x9702))).toMatchObject({
      state: 'orphaned',
      attempts: 8,
    });
    const r2 = await drainOutbox(db, t);
    expect(r2).toMatchObject({ synced: 0, failed: 0 });
    // The parked legacy shot is delivered when a new read joins its set.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x9704), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    const r3 = await drainOutbox(db, t);
    expect(r3).toMatchObject({ synced: 3, failed: 0 });
    expect(await hasShotSyncReceipt(db, shotId(0x9702))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x9704))).toBe(true);
    expect(leaseWaiters().pending).toBe(0);
  });
});
