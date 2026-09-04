/**
 * Fix round 8 (candidate B) — pins for the corrected semantics the round-7
 * adversaries broke, against the REAL modules on real node:sqlite:
 *
 *  S1/S2  ≥200 seeded malformed payload shapes across every outbox kind are
 *         quarantined ONCE (attempts at the cap, truthful last_error), the
 *         drain completes, healthy rows sync, and the next drain reports
 *         nothing failed — so syncRuntime's backoff sees a healthy queue.
 *  R1     accept + `shot.session_not_found` ping-pong: exact call bound
 *         (SESSION_REARM_LIMIT + 1 createSession, SESSION_REARM_LIMIT
 *         syncShots for one read over 40 drains), monotone attempts equal to
 *         the refusals the server issued, truthful copy, and the ONE trigger
 *         that lifts the hold (a new read saved into the set) lifts it.
 *  L1     1,000-op seeded interleave: the lease's own waiter peak is bounded
 *         by the operations in flight (a drain awaiting the network holds no
 *         waiter slot) and nothing is left pending.
 *  F3     store failure after an accepted upload: the row keeps its attempt
 *         count, the page stops, the next drain replays the id (the server
 *         RPC is idempotent by shot id) and the receipt lands.
 *  M1     `sync_set_state` migration: fresh database, database upgraded from
 *         a version without the table, and re-open at the new version.
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
const SET_A = 'f8f8f8f8-0000-4000-8000-000000000001';
const SET_B = 'f8f8f8f8-0000-4000-8000-000000000002';
const SET_C = 'f8f8f8f8-0000-4000-8000-000000000003';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

/** mulberry32 — deterministic across platforms. */
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

function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)]!;
}

const OUTBOX_KINDS = ['shot.sync', 'session.create', 'evaluation.trial'];

/**
 * A malformed payload for `kind`: not JSON, JSON that is not an object,
 * an object without the id the kind needs, an id of the wrong type, or an
 * object whose other required fields are missing / mistyped.
 */
function malformedPayload(rnd: () => number, kind: string): string {
  const idField = kind === 'evaluation.trial' ? 'trialId' : 'id';
  const shape = Math.floor(rnd() * 9);
  const junk = () =>
    Array.from({ length: 1 + Math.floor(rnd() * 12) }, () =>
      String.fromCharCode(32 + Math.floor(rnd() * 95)),
    ).join('');
  switch (shape) {
    case 0:
      return junk();
    case 1:
      return `{${junk()}`;
    case 2:
      return 'null';
    case 3:
      return JSON.stringify(pick(rnd, [1, 'x', true, false, 0, -1.5]));
    case 4:
      return JSON.stringify(pick(rnd, [[], [1, 2], [null], [{}]]));
    case 5:
      return JSON.stringify({});
    case 6:
      return JSON.stringify({
        [idField]: pick(rnd, [null, 12, true, {}, [], '']),
      });
    case 7:
      // A well-typed shot id whose other request fields are missing or
      // mistyped (permit / checkpoints); for the other kinds a numeric id
      // beside otherwise plausible fields.
      return kind === 'shot.sync'
        ? JSON.stringify({
            id: shotId(0x7f000000 + Math.floor(rnd() * 0xffff)),
            analysisPermitId: pick(rnd, [undefined, null, 7]),
            checkpoints: pick(rnd, [undefined, null, 'none', 3]),
          })
        : JSON.stringify({
            [idField]: Math.floor(rnd() * 0xffffff),
            mode: 'practice_set',
            startedAt: '2026-08-26T18:00:00.000Z',
          });
    default:
      return kind === 'shot.sync'
        ? JSON.stringify({ id: junk(), sessionId: 5 })
        : JSON.stringify({ [idField]: [junk()], sessionId: 5 });
  }
}

interface PingPong extends SyncTransport {
  creates: number;
  offers: number;
}
/** Accepts every set, refuses every shot with `shot.session_not_found`. */
function acceptCreateRefuseShots(): PingPong {
  const t: PingPong = {
    creates: 0,
    offers: 0,
    async createSession() {
      t.creates += 1;
    },
    async finalizeSession() {},
    async syncShots(shots) {
      t.offers += 1;
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

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
  await db.execute(`DELETE FROM sync_set_state`);
}

describe('fix8 mobile-data-sync hardening (real SQLite)', () => {
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

  it('S1/S2 fuzz — 240 seeded malformed payloads across every kind are quarantined once; the drain completes, healthy rows sync, the next drain fails nothing', async () => {
    const rnd = seeded(0xf1c8);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8001), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8002), sessionId: null }),
      PERMIT_ID,
      {},
    );
    const SHAPES = 240;
    // Distinct (kind, payload) pairs: a duplicate roll is re-drawn so the
    // run really covers SHAPES different malformed rows.
    const inserted = new Set<string>();
    for (let i = 0; i < SHAPES; i += 1) {
      const kind = OUTBOX_KINDS[i % OUTBOX_KINDS.length]!;
      let payload = malformedPayload(rnd, kind);
      while (inserted.has(`${kind}\u0000${payload}`)) {
        payload = malformedPayload(rnd, kind);
      }
      inserted.add(`${kind}\u0000${payload}`);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`,
        [OWNER, kind, payload],
      );
    }
    expect(inserted.size).toBe(SHAPES);
    const transport = {
      ...acceptAllTransport(),
      async uploadEvaluationTrials(trials: unknown[]) {
        // Only well-formed trials reach the server; none exist here.
        expect(trials).toEqual([]);
        return { acceptedTrialIds: [], rejected: [] };
      },
    };

    // synced = the set's session.create + the two healthy reads.
    const first = await drainOutbox(db, transport);
    expect(first).toEqual({ synced: 3, failed: SHAPES, remaining: SHAPES });
    expect(await hasShotSyncReceipt(db, shotId(0x8001))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0x8002))).toBe(true);
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(SHAPES);
    for (const row of rows) {
      expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(row.last_error).toEqual(expect.any(String));
      expect(row.last_error).not.toBe('');
    }
    // Quarantined rows are invisible from now on: no re-read, no charge, no
    // `failed` for syncRuntime's backoff to react to.
    for (let d = 0; d < 3; d += 1) {
      expect(await drainOutbox(db, transport)).toEqual({
        synced: 0,
        failed: 0,
        remaining: SHAPES,
      });
    }
    expect(await outboxRows(db, OWNER)).toEqual(rows);
    // A healthy read saved afterwards syncs on the next drain.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8003), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    expect(await drainOutbox(db, transport)).toEqual({
      synced: 1,
      failed: 0,
      remaining: SHAPES,
    });
    expect(await hasShotSyncReceipt(db, shotId(0x8003))).toBe(true);
  });

  it('R1 — accept + session_not_found ping-pong: exactly SESSION_REARM_LIMIT + 1 createSession and SESSION_REARM_LIMIT syncShots over 40 drains; attempts monotone and equal to the refusals; a new read in the set is the one trigger that re-asks', async () => {
    const t = acceptCreateRefuseShots();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8101), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const trace: Array<{ attempts: number; state: string }> = [];
    for (let d = 0; d < 40; d += 1) {
      await drainOutbox(db, t);
      const status = await getShotOutboxStatus(db, shotId(0x8101));
      trace.push({
        attempts: 'attempts' in status ? status.attempts : -1,
        state: status.state,
      });
    }
    expect({ creates: t.creates, offers: t.offers }).toEqual({
      creates: SESSION_REARM_LIMIT + 1,
      offers: SESSION_REARM_LIMIT,
    });
    expect(
      trace.every((s, i) => i === 0 || s.attempts >= trace[i - 1]!.attempts),
    ).toBe(true);
    const last = trace[trace.length - 1]!;
    expect(last).toEqual({ attempts: t.offers, state: 'rejected' });
    const held = await getShotOutboxStatus(db, shotId(0x8101));
    expect(held.state === 'rejected' ? held.lastError : null).toContain(
      `queued again from this device ${SESSION_REARM_LIMIT} times and accepted`,
    );
    expect(held.state === 'rejected' ? held.lastError : null).toContain(
      'sent again when a new read is saved into the set',
    );
    // No queue rows other than the held shot: the set is not re-asked.
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
    ]);

    // The trigger the copy names: a new read saved into the set grants one
    // more round of SESSION_REARM_LIMIT re-arms — the held read is offered
    // again at once (the server has the set), then the set is re-asked, and
    // the same bound closes the round; the lifetime count is never reset.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8102), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const before = { creates: t.creates, offers: t.offers };
    for (let d = 0; d < 40; d += 1) {
      await drainOutbox(db, t);
      const status = await getShotOutboxStatus(db, shotId(0x8101));
      trace.push({
        attempts: 'attempts' in status ? status.attempts : -1,
        state: status.state,
      });
    }
    expect({ creates: t.creates, offers: t.offers }).toEqual({
      creates: before.creates + SESSION_REARM_LIMIT,
      offers: before.offers + SESSION_REARM_LIMIT,
    });
    expect(
      trace.every((s, i) => i === 0 || s.attempts >= trace[i - 1]!.attempts),
    ).toBe(true);
    expect(trace[trace.length - 1]).toEqual({
      attempts: t.offers,
      state: 'rejected',
    });
    // The second read's refusals came while its set was live again (the
    // first read's settle had just re-queued it), so they were attributed to
    // the missing set and never charged; it is held on the same reason.
    const second = await getShotOutboxStatus(db, shotId(0x8102));
    expect(second).toMatchObject({ state: 'queued', attempts: 0 });
    expect(second.state === 'queued' ? second.lastError : null).toContain(
      'sent again when a new read is saved into the set',
    );
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
      'shot.sync',
    ]);

    // The server finally learning the set: a new read renews the round and
    // every read of the set is delivered with its attempt count intact.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8103), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const accepting = acceptAllTransport();
    expect(await drainOutbox(db, accepting)).toEqual({
      synced: 3,
      failed: 0,
      remaining: 0,
    });
    for (const n of [0x8101, 0x8102, 0x8103]) {
      expect(await hasShotSyncReceipt(db, shotId(n))).toBe(true);
    }
  });

  it('R1 — a shot parked at the cap under an accepted-then-refusing server settles in ≤ SESSION_REARM_LIMIT re-arms with the true refusal count', async () => {
    const t = acceptCreateRefuseShots();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8201), sessionId: SET_C }),
      PERMIT_ID,
      { session: setInput(SET_C) },
    );
    // A pre-fix device state: the shot already parked at the cap with its set
    // refused OUTBOX_MAX_ATTEMPTS times and that row gone (retired).
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = ?
       WHERE owner_key = ? AND kind = 'shot.sync'`,
      [
        OUTBOX_MAX_ATTEMPTS,
        'shot.session_orphaned: Session not found for this shot. ' +
          'No practice set is known for this read on this device; ' +
          'it is paused until one is accepted.',
        OWNER,
      ],
    );
    await db.execute(
      `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
      [OWNER],
    );
    for (let d = 0; d < 20; d += 1) await drainOutbox(db, t);
    expect({ creates: t.creates, offers: t.offers }).toEqual({
      creates: SESSION_REARM_LIMIT,
      offers: SESSION_REARM_LIMIT,
    });
    const status = await getShotOutboxStatus(db, shotId(0x8201));
    expect(status).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS + 1,
    });
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'shot.sync',
    ]);
  });

  it('L1 — 1,000 seeded save/drain/purge/network interleavings: lease waiter peak ≤ operations in flight, nothing pending afterwards, no lost read', async () => {
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
    const saved = new Set<string>();
    const all: Promise<unknown>[] = [];
    resetLeaseWaiterPeak();
    for (let i = 0; i < 1000; i += 1) {
      const r = rnd();
      if (r < 0.6) {
        const id = shotId(0x8300 + i);
        const set = rnd() < 0.7 ? sets[i % sets.length]! : null;
        saved.add(id);
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
        all.push(track(drainOutbox(db, transport)));
      } else {
        saved.clear();
        all.push(track(purgeOwnerData(db, OWNER)));
      }
      if (rnd() < 0.2) {
        for (let k = 0; k < 3; k += 1) await Promise.resolve();
      }
    }
    await Promise.all(all);
    const waiters = leaseWaiters();
    expect(waiters.pending).toBe(0);
    expect(waiters.peak).toBeGreaterThan(0);
    expect(waiters.peak).toBeLessThanOrEqual(inFlightMax);
    flaky = false;
    for (let d = 0; d < 4; d += 1) await drainOutbox(db, transport);
    for (const id of saved) {
      expect(await hasShotSyncReceipt(db, id)).toBe(true);
    }
  });

  it('F3 — receipt store failure after an accepted upload: attempts untouched, page stops, next drain replays the id and the receipt lands', async () => {
    for (let i = 0; i < 3; i += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x8400 + i), sessionId: null }),
        PERMIT_ID,
        {},
      );
    }
    const transport = acceptAllTransport();
    let receiptWrites = 0;
    const failingSecondReceipt: LocalDb = {
      async execute(sql, params) {
        if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
          receiptWrites += 1;
          if (receiptWrites === 2) {
            throw new Error('SQLITE_FULL: database or disk is full');
          }
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    const first = await drainOutbox(failingSecondReceipt, transport);
    expect(first).toEqual({ synced: 1, failed: 1, remaining: 2 });
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => r.attempts)).toEqual([0, 0]);
    expect(rows[0]!.last_error).toContain('shot.receipt_not_saved');
    expect(rows[1]!.last_error).toBeNull();
    expect(await getShotOutboxStatus(db, shotId(0x8401))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    const second = await drainOutbox(db, transport);
    expect(second).toEqual({ synced: 2, failed: 0, remaining: 0 });
    const offered = transport.syncCalls.map(call =>
      call.map(s => String((s as { id: unknown }).id)).sort(),
    );
    expect(offered).toEqual([
      [shotId(0x8400), shotId(0x8401), shotId(0x8402)].sort(),
      [shotId(0x8401), shotId(0x8402)].sort(),
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect(await hasShotSyncReceipt(db, shotId(0x8400 + i))).toBe(true);
    }
  });

  it('M1 — sync_set_state: created on a fresh database, added to a database from a version without it, and idempotent on re-open at the new version', async () => {
    const tableExists = async (handle: LocalDb) =>
      (
        await handle.execute(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_set_state'`,
        )
      ).rows.length === 1;
    expect(await tableExists(db)).toBe(true);
    // Upgrade: a database written by every earlier version has no such table
    // and rows already in flight; the migration adds it without touching them.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x8501), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    await db.execute(`DROP TABLE sync_set_state`);
    expect(await tableExists(db)).toBe(false);
    getDb().close();
    db = getDb();
    expect(await tableExists(db)).toBe(true);
    expect((await outboxRows(db, OWNER)).map(r => r.kind)).toEqual([
      'session.create',
      'shot.sync',
    ]);
    // Re-arm bookkeeping works on the upgraded database and is owner scoped.
    const t = acceptCreateRefuseShots();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, t);
    const state = await db.execute(
      `SELECT owner_key, session_id, rearms FROM sync_set_state`,
    );
    expect(state.rows).toEqual([
      { owner_key: OWNER, session_id: SET_A, rearms: SESSION_REARM_LIMIT },
    ]);
    // Re-open at the new version: idempotent, state preserved.
    getDb().close();
    db = getDb();
    expect(
      (await db.execute(`SELECT rearms FROM sync_set_state`)).rows,
    ).toEqual([{ rearms: SESSION_REARM_LIMIT }]);
    // Purging the owner removes its set state with the rest of its data.
    await purgeOwnerData(db, OWNER);
    expect((await db.execute(`SELECT 1 FROM sync_set_state`)).rows).toEqual([]);
  });
});
