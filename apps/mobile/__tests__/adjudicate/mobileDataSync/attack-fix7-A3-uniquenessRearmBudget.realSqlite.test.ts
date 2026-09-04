/**
 * Adversary round 7 — candidate `devin/fix6-mds-sqlite-a` @ 9a00ceb1.
 * Claims 3/4/5: session.create uniqueness, SQL liveness, bounded re-arm,
 * budget boundary. Real `node:sqlite`, real modules; faults only at the
 * transport boundary (rows planted by SQL stand for pre-existing state).
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
  saveAnalysis,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_ORPHANED_VERDICT,
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
const SET_X = 'a5a5a5a5-0000-4000-8000-000000000001';
const SET_Y = 'a5a5a5a5-0000-4000-8000-000000000002';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}
type Sync = Awaited<ReturnType<SyncTransport['syncShots']>>;
const idsOf = (shots: unknown[]) =>
  shots.map(s => String((s as { id: string }).id));
const acceptAll = (shots: unknown[]): Sync => ({
  acceptedIds: idsOf(shots),
  rejected: [],
});
const rejectAll =
  (code: string, message = 'refused') =>
  (shots: unknown[]): Sync => ({
    acceptedIds: [],
    rejected: idsOf(shots).map(id => ({ id, code, message })),
  });

/** Scripted transport with call counters. */
function scripted(script: {
  createSession?: () => Promise<void>;
  finalizeSession?: () => Promise<void>;
  syncShots?: (shots: unknown[]) => Promise<Sync>;
}) {
  const calls = { createSession: 0, finalizeSession: 0, syncShots: 0 };
  const shotsOffered: string[] = [];
  const transport: SyncTransport = {
    async createSession() {
      calls.createSession += 1;
      await (script.createSession ?? (async () => {}))();
    },
    async finalizeSession() {
      calls.finalizeSession += 1;
      await (script.finalizeSession ?? (async () => {}))();
    },
    async syncShots(shots) {
      calls.syncShots += 1;
      shotsOffered.push(...idsOf(shots));
      return (script.syncShots ?? (async s => acceptAll(s)))(shots);
    },
  };
  return { transport, calls, shotsOffered };
}
const conflict409 = async () => {
  throw new ApiError(409, 'session.id_conflict', 'belongs to another user');
};
const down503 = async () => {
  throw new ApiError(503, 'server.unavailable', 'down');
};

async function wipe(db: LocalDb): Promise<void> {
  for (const table of ['local_shot', 'local_session', 'outbox', 'sync_receipt'])
    await db.execute(`DELETE FROM ${table}`);
}
async function saveShot(db: LocalDb, n: number, set: string) {
  await saveAnalysis(
    db,
    realAnalysis({ id: shotId(n), sessionId: set }),
    PERMIT_ID,
    { session: setInput(set) },
  );
}
async function sessionRows(db: LocalDb, set: string) {
  const { rows } = await db.execute(
    `SELECT id, attempts FROM outbox WHERE owner_key = ? AND kind = 'session.create'
       AND json_extract(payload, '$.id') = ? ORDER BY id`,
    [OWNER, set],
  );
  return rows.map(r => ({
    id: Number(r['id']),
    attempts: Number(r['attempts']),
  }));
}
async function shotRow(db: LocalDb, n: number) {
  const { rows } = await db.execute(
    `SELECT attempts, last_error FROM outbox WHERE owner_key = ? AND kind = 'shot.sync'
       AND json_extract(payload, '$.id') = ?`,
    [OWNER, shotId(n)],
  );
  const r = rows[0];
  return r
    ? {
        attempts: Number(r['attempts']),
        lastError: r['last_error'] as string | null,
      }
    : null;
}

describe('attack-fix7-A3 uniqueness / liveness / re-arm / budget (claims 3-5)', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    db = getDb();
  });
  beforeEach(async () => {
    await wipe(db);
  });

  it('A3.1 probe — 409 id_conflict + session_not_found forever with N new shots over time: rows, attempts and network calls are bounded (measure rearm_rows / rearm_calls)', async () => {
    const t = scripted({
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    const N = 10;
    let saved = 0;
    for (let drain = 0; drain < 60; drain += 1) {
      if (drain % 6 === 0 && saved < N) {
        saved += 1;
        await saveShot(db, saved, SET_X);
      }
      await drainOutbox(db, t.transport);
    }
    const sessions = await sessionRows(db, SET_X);
    const shots = await Promise.all(
      Array.from({ length: N }, (_, i) => shotRow(db, i + 1)),
    );
    const measured = {
      rearm_rows: sessions.length,
      rearm_calls: t.calls.createSession,
      syncShots_calls: t.calls.syncShots,
      shotAttempts: shots.map(s => s?.attempts),
      statuses: await Promise.all(
        Array.from({ length: N }, (_, i) =>
          getShotOutboxStatus(db, shotId(i + 1)).then(s => s.state),
        ),
      ),
    };
    // Bound: ONE session.create row (re-armed in place); OUTBOX_MAX_ATTEMPTS
    // create calls per re-arm occasion — a save only re-arms a row that is
    // exhausted at that moment (saves at drains 0,12,24,36,48 do; the ones
    // at 6,18,30,42,54 find the row live) → 5 × 8 = 40 create calls; one
    // syncShots per occasion (the not-yet-parked shot is offered once in
    // the drain that exhausts the row, then parked uncharged).
    expect(measured).toEqual({
      rearm_rows: 1,
      rearm_calls: OUTBOX_MAX_ATTEMPTS * 5,
      syncShots_calls: 5,
      shotAttempts: Array.from({ length: N }, () => 0),
      statuses: Array.from({ length: N }, () => 'orphaned'),
    });
    // The server would now accept the set — but an exhausted set is never
    // re-asked on its own (see A4.3): a drain does nothing…
    const idle = scripted({});
    expect(await drainOutbox(db, idle.transport)).toEqual({
      synced: 0,
      failed: 0,
      remaining: N + 1,
    });
    expect(idle.calls).toEqual({
      createSession: 0,
      finalizeSession: 0,
      syncShots: 0,
    });
    // …until a new shot of the set re-arms it: then one drain retires the
    // exhausted row, unparks every shot and delivers them all.
    await saveShot(db, N + 1, SET_X);
    const ok = scripted({});
    const r = await drainOutbox(db, ok.transport);
    expect(r).toEqual({ synced: 1 + N + 1, failed: 0, remaining: 0 });
    expect(ok.calls).toEqual({
      createSession: 1,
      finalizeSession: 0,
      syncShots: 1,
    });
    expect(ok.shotsOffered).toHaveLength(N + 1);
    for (let i = 1; i <= N + 1; i += 1) {
      expect(await hasShotSyncReceipt(db, shotId(i))).toBe(true);
    }
    expect(await sessionRows(db, SET_X)).toEqual([]);
  });

  it('A3.2 probe — two saves of the same NEW set in one tick, and two saves into an EXHAUSTED set in one tick, leave exactly one live session.create', async () => {
    await Promise.all([saveShot(db, 1, SET_X), saveShot(db, 2, SET_X)]);
    expect(await sessionRows(db, SET_X)).toHaveLength(1);
    const t = scripted({
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1)
      await drainOutbox(db, t.transport);
    expect(await sessionRows(db, SET_X)).toEqual([
      { id: expect.any(Number), attempts: OUTBOX_MAX_ATTEMPTS },
    ]);
    await Promise.all([saveShot(db, 3, SET_X), saveShot(db, 4, SET_X)]);
    const rows = await sessionRows(db, SET_X);
    expect(rows).toEqual([{ id: expect.any(Number), attempts: 0 }]);
  });

  it("A3.3 BREAK — session pass cut short by a transient failure before it reaches an EXHAUSTED set: that set's shot is offered, charged, and a NEW session.create row is inserted (deadSessions is a visited set)", async () => {
    // 51 session.finalize rows of other sets sit ahead of set X in id order
    // (one page + 1): the pass stops after page 1 fails transiently.
    for (let i = 0; i < 51; i += 1) {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.finalize', ?)`,
        [OWNER, JSON.stringify({ id: `f${i}`, summary: {} })],
      );
    }
    // Set X: refused 8 times (409) by earlier drains; its parked shot was
    // released by a later save (attempts 0, no marker) and the re-armed row
    // was refused again — the row is exhausted, the shot is not yet parked.
    await saveShot(db, 1, SET_X);
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = 'ApiError: belongs to another user'
       WHERE owner_key = ? AND kind = 'session.create'`,
      [OUTBOX_MAX_ATTEMPTS, OWNER],
    );
    const before = await sessionRows(db, SET_X);
    expect(before).toHaveLength(1);
    const t = scripted({
      finalizeSession: down503,
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    const r = await drainOutbox(db, t.transport);
    const after = await sessionRows(db, SET_X);
    const shot = await shotRow(db, 1);
    // Expected (claim 4): liveness is SQL — the exhausted set is recognised
    // without visiting its row; the shot is parked (uncharged), no
    // session.create is charged or duplicated, syncShots is not called.
    // OBSERVED: syncShots called once, shot attempts=1 with a
    // `shot.session_orphaned` verdict, and a SECOND session.create row for
    // set X (attempts 0) beside the exhausted one — the next drain spends 8
    // more 409s on it, and every recurrence adds a row.
    expect({
      finalizeCalls: t.calls.finalizeSession,
      syncShotsCalls: t.calls.syncShots,
      shotAttempts: shot?.attempts,
      sessionRows: after.length,
      failed: r.failed,
    }).toEqual({
      finalizeCalls: 50,
      syncShotsCalls: 0,
      shotAttempts: 0,
      sessionRows: 1,
      failed: 50,
    });
  });

  it('A3.4 probe — budget boundary at attempts 7: verdict → exhausted / parked / retryable, with and without a local session', async () => {
    const verdicts: Array<{
      name: string;
      script: Parameters<typeof scripted>[0];
      localSession: boolean;
      expectAttempts: number;
      expectState: string;
      expectSessionRows: number;
    }> = [
      {
        name: 'session_not_found, no local session',
        script: {
          syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
        },
        localSession: false,
        expectAttempts: 8,
        expectState: 'orphaned',
        expectSessionRows: 0,
      },
      {
        name: 'session_not_found, local session, no queue row',
        script: {
          syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
        },
        localSession: true,
        // Ported from the sibling candidate, which charged this refusal to
        // the shot (attempts 8). On this base the refusal is attributed to
        // the missing set, which is queued again (sessionRows 1) while the
        // shot parks uncharged at 7 — pinned unchanged by B0 P11 on
        // 7bd9d7af. The re-arm itself is bounded by the persisted
        // `sync_set_state.rearms` column (A3.6 / B2), not by this counter.
        expectAttempts: 7,
        expectState: 'orphaned',
        expectSessionRows: 1,
      },
      {
        name: '5xx whole request',
        script: { syncShots: down503 as never },
        localSession: true,
        expectAttempts: 7,
        expectState: 'rejected',
        expectSessionRows: 0,
      },
      {
        name: '429 whole request',
        script: {
          syncShots: (async () => {
            throw new ApiError(429, 'rate.limited', 'slow down');
          }) as never,
        },
        localSession: true,
        expectAttempts: 7,
        expectState: 'rejected',
        expectSessionRows: 0,
      },
      {
        name: '401 auth.required item rejection',
        script: { syncShots: async s => rejectAll('auth.required')(s) },
        localSession: true,
        expectAttempts: 7,
        expectState: 'rejected',
        expectSessionRows: 0,
      },
      {
        name: 'shot.write_failed item rejection',
        script: { syncShots: async s => rejectAll('shot.write_failed')(s) },
        localSession: true,
        expectAttempts: 7,
        expectState: 'rejected',
        expectSessionRows: 0,
      },
      {
        name: 'permanent 4xx item rejection',
        script: { syncShots: async s => rejectAll('shot.permit_invalid')(s) },
        localSession: true,
        expectAttempts: 8,
        expectState: 'exhausted',
        expectSessionRows: 0,
      },
      {
        name: 'permanent 400 whole request',
        script: {
          syncShots: (async () => {
            throw new ApiError(400, 'request.invalid', 'bad');
          }) as never,
        },
        localSession: true,
        expectAttempts: 8,
        expectState: 'exhausted',
        expectSessionRows: 0,
      },
    ];
    const observed: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const v of verdicts) {
      await wipe(db);
      // A shot of set X whose session.create was accepted earlier (no queue
      // row) and which has been refused permanently 7 times already.
      await saveShot(db, 1, SET_X);
      await db.execute(
        `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
        [OWNER],
      );
      if (!v.localSession) {
        await db.execute(`DELETE FROM local_session WHERE owner_key = ?`, [
          OWNER,
        ]);
      }
      await db.execute(
        `UPDATE outbox SET attempts = ? WHERE owner_key = ? AND kind = 'shot.sync'`,
        [OUTBOX_MAX_ATTEMPTS - 1, OWNER],
      );
      const t = scripted(v.script);
      await drainOutbox(db, t.transport);
      const row = await shotRow(db, 1);
      observed[v.name] = {
        attempts: row?.attempts,
        state: (await getShotOutboxStatus(db, shotId(1))).state,
        sessionRows: (await sessionRows(db, SET_X)).length,
        syncCalls: t.calls.syncShots,
      };
      expected[v.name] = {
        attempts: v.expectAttempts,
        state: v.expectState,
        sessionRows: v.expectSessionRows,
        syncCalls: 1,
      };
    }
    expect(observed).toEqual(expected);
  });

  it('A3.5 probe — re-arm after the LOCAL session row was deleted: a fresh save re-creates the set and queues one live session.create; acceptance retires the exhausted row', async () => {
    await saveShot(db, 1, SET_X);
    const refuse = scripted({
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1)
      await drainOutbox(db, refuse.transport);
    expect((await getShotOutboxStatus(db, shotId(1))).state).toBe('orphaned');
    await db.execute(
      `DELETE FROM local_session WHERE owner_key = ? AND id = ?`,
      [OWNER, SET_X],
    );
    await saveShot(db, 2, SET_X);
    const rows = await sessionRows(db, SET_X);
    expect(rows.filter(r => r.attempts < OUTBOX_MAX_ATTEMPTS)).toHaveLength(1);
    const ok = scripted({});
    const r = await drainOutbox(db, ok.transport);
    expect(r).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(await sessionRows(db, SET_X)).toEqual([]);
    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(true);
  });

  it('A3.6 probe — two LIVE session.create rows for one set written by pre-fix code: both offered, both retired, shots delivered once', async () => {
    await saveShot(db, 1, SET_X);
    const { rows } = await db.execute(
      `SELECT payload FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
      [OWNER],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)`,
      [OWNER, rows[0]!['payload']],
    );
    const ok = scripted({});
    const r = await drainOutbox(db, ok.transport);
    expect(ok.calls).toEqual({
      createSession: 2,
      finalizeSession: 0,
      syncShots: 1,
    });
    expect(r).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(ok.shotsOffered).toEqual([shotId(1)]);
  });

  it('A3.7 probe — a parked shot (dead set) is never offered nor charged across many drains; a shot of set Y is unaffected', async () => {
    await saveShot(db, 1, SET_X);
    const refuse = scripted({
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1)
      await drainOutbox(db, refuse.transport);
    const marker = await shotRow(db, 1);
    expect(marker?.lastError?.startsWith(`${SESSION_ORPHANED_VERDICT}:`)).toBe(
      true,
    );
    await saveShot(db, 2, SET_Y);
    const t = scripted({
      createSession: conflict409,
      syncShots: async s => rejectAll(SESSION_NOT_FOUND_REJECTION)(s),
    });
    for (let i = 0; i < 20; i += 1) await drainOutbox(db, t.transport);
    expect(t.calls.createSession).toBe(OUTBOX_MAX_ATTEMPTS);
    // Shot 2 is offered exactly once (in the drain that exhausts set Y),
    // then parked; shot 1 is never offered again.
    expect(t.shotsOffered).toEqual([shotId(2)]);
    expect(await shotRow(db, 1)).toEqual(marker);
    expect(await shotRow(db, 2)).toMatchObject({ attempts: 0 });
  });
});
