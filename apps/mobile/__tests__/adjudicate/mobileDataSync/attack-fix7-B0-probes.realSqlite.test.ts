/**
 * Adversary round 7 — probes against `devin/fix6-mds-sqlite-b` @ 7bd9d7af
 * (real node:sqlite, real transaction/sync/repository/accountScope modules).
 * Each `it` states the candidate's claim as the expectation. Every probe in
 * this file PASSES on the candidate: they are the attacks that did not break
 * it (lease leaks, deadlocks, fairness, purge/owner fences, budget matrix,
 * ordering, coalescing, migration idempotence, 1,000-op interleaving). The
 * breaks live in attack-fix7-B1-* and attack-fix7-B2-*.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  GUEST_DATA_OWNER,
  canonicalDataOwner,
  ownerPurgeGeneration,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  saveSession,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import { runInTransaction } from '../../../src/data/transaction';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner('22222222-2222-4333-8444-555555555555');
const SET_A = 'a7a7a7a7-0000-4000-8000-000000000001';
const SET_B = 'a7a7a7a7-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}
async function settleMicrotasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}
/** Resolves 'hung' if `p` has not settled after `ms` of real time. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hung = new Promise<'hung'>(res => {
    timer = setTimeout(() => res('hung'), ms);
  });
  return Promise.race([p, hung]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface Emulator extends SyncTransport {
  created: string[];
  offered: string[][];
  createError: ((id: string) => Error | null) | null;
  finalizeError: (() => Error | null) | null;
  known: Set<string>;
}
function serverEmulator(): Emulator {
  const known = new Set<string>();
  const created: string[] = [];
  const offered: string[][] = [];
  const emulator: Emulator = {
    known,
    created,
    offered,
    createError: null,
    finalizeError: null,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
      const err = emulator.createError?.(id) ?? null;
      if (err) throw err;
      known.add(id);
    },
    async finalizeSession() {
      const err = emulator.finalizeError?.() ?? null;
      if (err) throw err;
    },
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
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
      offered.push(ids);
      return { acceptedIds, rejected };
    },
  };
  return emulator;
}

function faultOnce(db: LocalDb, pattern: RegExp, error: () => Error): LocalDb {
  let tripped = false;
  return {
    async execute(sql, params) {
      if (!tripped && pattern.test(sql)) {
        tripped = true;
        throw error();
      }
      return db.execute(sql, params);
    },
    close: () => db.close(),
  };
}

async function clearAll(db: LocalDb): Promise<void> {
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
}

describe('attack round 7 probes (real SQLite)', () => {
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

  it('P1: a corrupt exhausted session.create row does not stop a healthy shot from syncing (its per-drain cost is B7-1)', async () => {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, ?)`,
      [OWNER, '{not json', OUTBOX_MAX_ATTEMPTS, 'SyntaxError: old build'],
    );
    await saveAnalysis(db, realAnalysis({ id: shotId(1) }), PERMIT_ID);
    const t = acceptAllTransport();
    const r1 = await drainOutbox(db, t);
    expect({ r1, receipt: await hasShotSyncReceipt(db, shotId(1)) }).toEqual({
      r1: { synced: 1, failed: 1, remaining: 1 },
      receipt: true,
    });
  });

  it('P2: a corrupt shot.sync payload and a corrupt session.create payload never break saveAnalysis, retire, or hasLiveSessionCreate (json_valid guard)', async () => {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', '{not json', 0, NULL)`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'shot.sync', '{not json', 0, 'shot.session_orphaned: x')`,
      [OWNER],
    );
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(2), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const server = serverEmulator();
    const r = await drainOutbox(db, server);
    expect({ r, receipt: await hasShotSyncReceipt(db, shotId(2)) }).toEqual({
      r: { synced: 2, failed: 2, remaining: 2 },
      receipt: true,
    });
  });

  it('P3: purge racing between page read and network — the accept is fenced; nothing is written for the purged bucket (the upload itself still goes out)', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(3) }), PERMIT_ID);
    const t = acceptAllTransport();
    const drain = drainOutbox(db, t);
    const purge = purgeOwnerData(db, OWNER);
    const r = await drain;
    await purge;
    const receipts = await db.execute(`SELECT count(*) AS n FROM sync_receipt`);
    expect({
      r,
      calls: t.syncCalls.length,
      gen: ownerPurgeGeneration(OWNER),
      receipts: receipts.rows[0]!['n'],
    }).toEqual({
      r: { synced: 0, failed: 0, remaining: 0 },
      calls: 1,
      gen: 1,
      receipts: 0,
    });
  });

  describe('P4: lease leak hunt — a fault on any drain statement group never hangs the next save', () => {
    const patterns: Array<[string, RegExp]> = [
      [
        'page SELECT',
        /SELECT id, kind, payload, attempts, last_error FROM outbox/,
      ],
      ['receipt INSERT', /INSERT OR REPLACE INTO sync_receipt/],
      ['row DELETE', /DELETE FROM outbox WHERE owner_key = \? AND id = \?/],
      [
        'failure UPDATE',
        /UPDATE outbox SET (attempts = attempts \+ 1, )?last_error = \?/,
      ],
      ['BEGIN', /^BEGIN IMMEDIATE$/],
      ['COMMIT', /^COMMIT$/],
      ['remaining count', /SELECT count\(\*\) AS n FROM outbox/],
      [
        'retire DELETE',
        /DELETE FROM outbox\s+WHERE owner_key = \?\s+AND \(id = \?/,
      ],
    ];
    for (const [name, pattern] of patterns) {
      it(`fault on ${name}`, async () => {
        await saveAnalysis(
          db,
          realAnalysis({ id: shotId(0x40), sessionId: SET_A }),
          PERMIT_ID,
          { session: setInput(SET_A) },
        );
        await saveAnalysis(db, realAnalysis({ id: shotId(0x41) }), PERMIT_ID);
        const t: SyncTransport = {
          async createSession() {},
          async finalizeSession() {},
          async syncShots(shots) {
            return {
              acceptedIds: [String((shots[0] as { id: string }).id)],
              rejected: shots.slice(1).map(s => ({
                id: String((s as { id: string }).id),
                code: 'shot.invalid',
                message: 'verdict',
              })),
            };
          },
        };
        const faulty = faultOnce(
          db,
          pattern,
          () => new Error('[op-sqlite] SQLITE_FULL: database or disk is full'),
        );
        const drainOutcome = await withTimeout(
          drainOutbox(faulty, t).then(
            () => 'resolved' as const,
            () => 'rejected' as const,
          ),
          2000,
        );
        const save = await withTimeout(
          saveAnalysis(db, realAnalysis({ id: shotId(0x42) }), PERMIT_ID).then(
            () => 'saved' as const,
          ),
          2000,
        );
        const txn = await withTimeout(
          runInTransaction(db, async () => 'ok' as const),
          2000,
        );
        expect({ drainOutcome, save, txn }).toEqual({
          drainOutcome: expect.stringMatching(/resolved|rejected/),
          save: 'saved',
          txn: 'ok',
        });
      });
    }
  });

  it('P5: saveAnalysis while a drain awaits the network completes without waiting for the server', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(0x50) }), PERMIT_ID);
    const gate = deferred<void>();
    const seen = deferred<void>();
    const t: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        seen.resolve();
        await gate.promise;
        return {
          acceptedIds: shots.map(s => String((s as { id: string }).id)),
          rejected: [],
        };
      },
    };
    const drain = drainOutbox(db, t);
    await seen.promise;
    const save = await withTimeout(
      saveAnalysis(db, realAnalysis({ id: shotId(0x51) }), PERMIT_ID).then(
        () => 'saved' as const,
      ),
      1000,
    );
    gate.resolve();
    await drain;
    expect(save).toBe('saved');
  });

  it('P6: re-arm bound — server refuses the set forever; N new shots cost at most N*MAX createSession calls and no row growth beyond N shots + 1 session row', async () => {
    const server = serverEmulator();
    server.createError = () =>
      new ApiError(409, 'session.id_conflict', 'conflict');
    const N = 5;
    let createCalls = 0;
    let offerCalls = 0;
    for (let n = 0; n < N; n += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x600 + n), sessionId: SET_A }),
        PERMIT_ID,
        { session: setInput(SET_A) },
      );
      for (let d = 0; d < 12; d += 1) await drainOutbox(db, server);
    }
    createCalls = server.created.length;
    offerCalls = server.offered.length;
    const rows = await outboxRows(db, OWNER);
    const sessionRows = rows.filter(r => r.kind === 'session.create');
    console.log('P6 bounds', {
      createCalls,
      offerCalls,
      rows: rows.length,
      sessionRows,
    });
    expect(createCalls).toBeLessThanOrEqual(N * OUTBOX_MAX_ATTEMPTS);
    expect(sessionRows).toHaveLength(1);
    expect(rows).toHaveLength(N + 1);
    // Server now accepts the set: one more shot → everything lands.
    server.createError = null;
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x600 + N), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let d = 0; d < 3; d += 1) await drainOutbox(db, server);
    const after = await outboxRows(db, OWNER);
    expect(after).toEqual([]);
    for (let n = 0; n <= N; n += 1) {
      expect(await hasShotSyncReceipt(db, shotId(0x600 + n))).toBe(true);
    }
  });

  it('P7: fairness — a saveAnalysis queued behind a burst of drains commits before the burst finishes', async () => {
    for (let i = 0; i < 20; i += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0x700 + i) }),
        PERMIT_ID,
      );
    }
    const server = serverEmulator();
    let drainsDone = 0;
    const drains = Array.from({ length: 50 }, () =>
      drainOutbox(db, server).then(() => {
        drainsDone += 1;
      }),
    );
    let drainsDoneAtSave = -1;
    const save = saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x7ff) }),
      PERMIT_ID,
    ).then(() => {
      drainsDoneAtSave = drainsDone;
    });
    await withTimeout(Promise.all([...drains, save]), 5000);
    console.log(
      'P7 fairness: drains completed before the save committed =',
      drainsDoneAtSave,
    );
    expect(drainsDoneAtSave).toBeGreaterThanOrEqual(0);
    expect(drainsDoneAtSave).toBeLessThan(50);
  });

  it('P8: owner A drain awaiting network while owner B becomes active and drains — no cross-owner rows', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(0x80) }), PERMIT_ID);
    const gate = deferred<void>();
    const seen = deferred<void>();
    const tA: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        seen.resolve();
        await gate.promise;
        return {
          acceptedIds: shots.map(s => String((s as { id: string }).id)),
          rejected: [],
        };
      },
    };
    const drainA = drainOutbox(db, tA);
    await seen.promise;
    setActiveDataOwner(OWNER_B);
    await saveAnalysis(db, realAnalysis({ id: shotId(0x81) }), PERMIT_ID);
    const tB = acceptAllTransport();
    const rB = await drainOutbox(db, tB);
    gate.resolve();
    const rA = await drainA;
    const receipts = await db.execute(
      `SELECT owner_key, entity_id FROM sync_receipt ORDER BY entity_id`,
    );
    expect({ rA, rB, receipts: receipts.rows }).toEqual({
      rA: { synced: 1, failed: 0, remaining: 0 },
      rB: { synced: 1, failed: 0, remaining: 0 },
      receipts: [
        { owner_key: OWNER, entity_id: shotId(0x80) },
        { owner_key: OWNER_B, entity_id: shotId(0x81) },
      ],
    });
  });

  it('P9: purge then immediate re-sign-in of the same owner — stale drain accept writes nothing for the new incarnation', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(0x90) }), PERMIT_ID);
    const gate = deferred<void>();
    const seen = deferred<void>();
    const stale: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        seen.resolve();
        await gate.promise;
        return {
          acceptedIds: shots.map(s => String((s as { id: string }).id)),
          rejected: [],
        };
      },
    };
    const staleDrain = drainOutbox(db, stale);
    await seen.promise;
    await purgeOwnerData(db, OWNER);
    // Same owner signs back in and captures a new read; ids are fresh UUIDs
    // but the outbox rowid restarts only if AUTOINCREMENT is absent.
    await saveAnalysis(db, realAnalysis({ id: shotId(0x91) }), PERMIT_ID);
    const fresh = acceptAllTransport();
    const freshDrain = drainOutbox(db, fresh);
    gate.resolve();
    const rStale = await staleDrain;
    const rFresh = await freshDrain;
    const receipts = await db.execute(
      `SELECT owner_key, entity_id FROM sync_receipt ORDER BY entity_id`,
    );
    // rStale.remaining = 1 is the fresh incarnation's still-queued row: the
    // stale drain's final count is a read, not a write, and the fresh drain
    // is chained behind it.
    expect({ rStale, rFresh, receipts: receipts.rows }).toEqual({
      rStale: { synced: 0, failed: 0, remaining: 1 },
      rFresh: { synced: 1, failed: 0, remaining: 0 },
      receipts: [{ owner_key: OWNER, entity_id: shotId(0x91) }],
    });
  });

  it('P10: receipt for a shot whose outbox row was deleted mid-flight is not written', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(0xa0) }), PERMIT_ID);
    const gate = deferred<void>();
    const seen = deferred<void>();
    const t: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        seen.resolve();
        await gate.promise;
        return {
          acceptedIds: shots.map(s => String((s as { id: string }).id)),
          rejected: [],
        };
      },
    };
    const drain = drainOutbox(db, t);
    await seen.promise;
    await db.execute(`DELETE FROM outbox WHERE owner_key = ?`, [OWNER]);
    gate.resolve();
    const r = await drain;
    expect({ r, receipt: await hasShotSyncReceipt(db, shotId(0xa0)) }).toEqual({
      r: { synced: 1, failed: 0, remaining: 0 },
      receipt: false,
    });
  });

  describe('P11: budget boundary at attempts = MAX-1', () => {
    const cases: Array<{
      name: string;
      withSession: boolean;
      reject?: { code: string };
      throwErr?: () => Error;
      expectState: 'orphaned' | 'exhausted' | 'rejected';
      expectAttempts: number;
    }> = [
      {
        name: 'session_not_found + local session',
        withSession: true,
        reject: { code: SESSION_NOT_FOUND_REJECTION },
        expectState: 'orphaned',
        expectAttempts: 7,
      },
      {
        name: 'session_not_found, no local session',
        withSession: false,
        reject: { code: SESSION_NOT_FOUND_REJECTION },
        expectState: 'orphaned',
        expectAttempts: 8,
      },
      {
        name: '5xx',
        withSession: false,
        throwErr: () => new ApiError(503, 'x', 'x'),
        expectState: 'rejected',
        expectAttempts: 7,
      },
      {
        name: '429',
        withSession: false,
        throwErr: () => new ApiError(429, 'x', 'x'),
        expectState: 'rejected',
        expectAttempts: 7,
      },
      {
        name: '401',
        withSession: false,
        throwErr: () => new ApiError(401, 'x', 'x'),
        expectState: 'rejected',
        expectAttempts: 7,
      },
      {
        name: 'auth.required',
        withSession: false,
        reject: { code: 'auth.required' },
        expectState: 'rejected',
        expectAttempts: 7,
      },
      {
        name: 'shot.write_failed',
        withSession: false,
        reject: { code: 'shot.write_failed' },
        expectState: 'rejected',
        expectAttempts: 7,
      },
      {
        name: 'permanent 4xx',
        withSession: false,
        throwErr: () => new ApiError(422, 'x', 'x'),
        expectState: 'exhausted',
        expectAttempts: 8,
      },
      {
        name: 'contract verdict',
        withSession: false,
        reject: { code: 'shot.invalid' },
        expectState: 'exhausted',
        expectAttempts: 8,
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const id = shotId(0xb00);
        await db.execute(
          `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
           VALUES (?, ?, ?, 'forehand_drive', 'x', 7, 0.9, 'scored', 'real', '{}')`,
          [OWNER, id, SET_A],
        );
        if (c.withSession) {
          await db.execute(
            `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
             VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, 'x')`,
            [OWNER, SET_A],
          );
        }
        await db.execute(
          `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
           VALUES (?, 'shot.sync', ?, ?, 'earlier')`,
          [
            OWNER,
            JSON.stringify({
              ...realAnalysis({ id, sessionId: SET_A }),
              analysisPermitId: PERMIT_ID,
            }),
            OUTBOX_MAX_ATTEMPTS - 1,
          ],
        );
        const t: SyncTransport = {
          async createSession() {},
          async finalizeSession() {},
          async syncShots(shots) {
            if (c.throwErr) throw c.throwErr();
            return {
              acceptedIds: [],
              rejected: shots.map(s => ({
                id: String((s as { id: string }).id),
                code: c.reject!.code,
                message: 'm',
              })),
            };
          },
        };
        await drainOutbox(db, t);
        const status = await getShotOutboxStatus(db, id);
        expect(status.state).toBe(c.expectState);
        expect((status as { attempts: number }).attempts).toBe(
          c.expectAttempts,
        );
      });
    }
  });

  it('P12: 1000 interleaved save/drain/purge operations with a seeded scheduler — no hang, no lost row, at most one live session.create per set', async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const server = serverEmulator();
    const sets = [SET_A, SET_B, 'a7a7a7a7-0000-4000-8000-000000000003'];
    const saved = new Set<string>();
    let purges = 0;
    let inFlight = 0;
    let leaseWaitersMax = 0;
    const track = <T>(p: Promise<T>): Promise<T> => {
      inFlight += 1;
      leaseWaitersMax = Math.max(leaseWaitersMax, inFlight);
      return p.finally(() => {
        inFlight -= 1;
      });
    };
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const r = rand();
      if (r < 0.6) {
        const id = shotId(0x10000 + i);
        const set = rand() < 0.7 ? sets[i % sets.length]! : null;
        saved.add(id);
        pending.push(
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
        server.createError =
          rand() < 0.3 ? () => new ApiError(503, 'x', 'x') : null;
        pending.push(track(drainOutbox(db, server)));
      } else {
        purges += 1;
        saved.clear();
        pending.push(track(purgeOwnerData(db, OWNER)));
      }
      if (rand() < 0.2) await settleMicrotasks(3);
    }
    const settled = await withTimeout(Promise.all(pending), 60_000);
    expect(settled).not.toBe('hung');
    server.createError = null;
    for (let d = 0; d < 4; d += 1) await drainOutbox(db, server);
    const rows = await outboxRows(db, OWNER);
    const liveSessionRows = await db.execute(
      `SELECT json_extract(payload,'$.id') AS sid, count(*) AS n FROM outbox
       WHERE owner_key = ? AND kind='session.create' AND attempts < ?
       GROUP BY sid HAVING n > 1`,
      [OWNER, OUTBOX_MAX_ATTEMPTS],
    );
    let lost = 0;
    for (const id of saved) {
      if (!(await hasShotSyncReceipt(db, id))) lost += 1;
    }
    console.log('P12', {
      purges,
      saved: saved.size,
      rows: rows.length,
      lost,
      lease_waiters_max: leaseWaitersMax,
    });
    expect(liveSessionRows.rows).toEqual([]);
    expect(lost).toBe(0);
  });

  it('P13: a shot of a set whose session.create is accepted in this drain is offered in the same drain', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xd0), sessionId: SET_B }),
      PERMIT_ID,
      { session: setInput(SET_B) },
    );
    const server = serverEmulator();
    const r = await drainOutbox(db, server);
    expect({ r, created: server.created, offered: server.offered }).toEqual({
      r: { synced: 2, failed: 0, remaining: 0 },
      created: [SET_B],
      offered: [[shotId(0xd0)]],
    });
  });

  it('P14: saveSession + saveAnalysis re-arm in the same tick leaves exactly one live session.create', async () => {
    await db.execute(
      `INSERT INTO local_session (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, 'practice_set', 'forehand_drive', NULL, 'x')`,
      [OWNER, SET_A],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error)
       VALUES (?, 'session.create', ?, ?, 'dead')`,
      [OWNER, JSON.stringify(setInput(SET_A)), OUTBOX_MAX_ATTEMPTS],
    );
    await Promise.all([
      saveSession(db, setInput(SET_A)),
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xe0), sessionId: SET_A }),
        PERMIT_ID,
        { session: setInput(SET_A) },
      ),
    ]);
    const rows = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'session.create',
    );
    expect(rows.filter(r => r.attempts < OUTBOX_MAX_ATTEMPTS)).toHaveLength(1);
  });

  it('P15: two concurrent drains for the same owner coalesce — the second offers nothing', async () => {
    await saveAnalysis(db, realAnalysis({ id: shotId(0xf0) }), PERMIT_ID);
    const t1 = acceptAllTransport();
    const t2 = acceptAllTransport();
    const [r1, r2] = await Promise.all([
      drainOutbox(db, t1),
      drainOutbox(db, t2),
    ]);
    expect({
      r1,
      r2,
      c1: t1.syncCalls.length,
      c2: t2.syncCalls.length,
    }).toEqual({
      r1: { synced: 1, failed: 0, remaining: 0 },
      r2: { synced: 0, failed: 0, remaining: 0 },
      c1: 1,
      c2: 0,
    });
  });

  it('P16: LOCAL_MIGRATIONS + account-scoped schema are idempotent on a database already at the new version', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xf1), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    getDb().close();
    db = getDb();
    const rows = await outboxRows(db, OWNER);
    const sessions = await db.execute(
      `SELECT id FROM local_session WHERE owner_key = ?`,
      [OWNER],
    );
    expect({
      kinds: rows.map(r => r.kind),
      sessions: sessions.rows,
    }).toEqual({
      kinds: ['session.create', 'shot.sync'],
      sessions: [{ id: SET_A }],
    });
  });

  it('P17: legacy guest-bucket rows (owner_key is NOT NULL; pre-account rows were assigned the guest bucket), evaluation.trial rows and an unknown kind are isolated from the signed-in drain', async () => {
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'shot.sync', ?, 0)`,
      [
        GUEST_DATA_OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(0xf2) }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'evaluation.trial', '{}', 0)`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts) VALUES (?, 'bogus.kind', '{}', 0)`,
      [OWNER],
    );
    const t = acceptAllTransport();
    const results = [];
    for (let i = 0; i < 9; i += 1) results.push(await drainOutbox(db, t));
    const all = await db.execute(
      `SELECT owner_key, kind, attempts FROM outbox ORDER BY id`,
    );
    expect({
      calls: t.syncCalls.length,
      failedTail: results.slice(-1)[0]!.failed,
      all: all.rows,
    }).toEqual({
      calls: 0,
      failedTail: 0,
      all: [
        { owner_key: GUEST_DATA_OWNER, kind: 'shot.sync', attempts: 0 },
        { owner_key: OWNER, kind: 'evaluation.trial', attempts: 0 },
        { owner_key: OWNER, kind: 'bogus.kind', attempts: OUTBOX_MAX_ATTEMPTS },
      ],
    });
  });
});
