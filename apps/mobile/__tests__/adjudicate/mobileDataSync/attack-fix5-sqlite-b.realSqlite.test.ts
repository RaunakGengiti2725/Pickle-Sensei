/**
 * Adversary round 5 — candidate `devin/fix4-mds-sqlite-b` @ d29b95f5.
 *
 * Every test here FAILS on the unmodified candidate; each documents one
 * observed-vs-expected break against the candidate's own claims, on real
 * `node:sqlite` through the real module wiring (fault injection only at the
 * DB boundary / the transport boundary).
 *
 *  B1. "One serialized SQLite transaction" is only serialized against OTHER
 *      runInTransaction callers. The drain's per-row bookkeeping
 *      (`recordRowFailure` UPDATE) runs outside runInTransaction, so when it
 *      lands while a saveAnalysis transaction is open on the same connection
 *      it joins that transaction — and is rolled back with it when the save
 *      fails. The drain reports `failed: 1`; the durable row still says
 *      attempts=0 / never rejected.
 *  B2. Account deletion mid-drain: `purgeOwnerData` (transactional) empties
 *      the owner bucket, then the in-flight drain's accept path writes a
 *      `sync_receipt` row for the purged owner back into the database
 *      (INSERT OR REPLACE on a bucket that no longer exists).
 *  C5. Liveness of the "paused, not terminal" claim: once a set's
 *      `session.create` row spends OUTBOX_MAX_ATTEMPTS, the set is dead on
 *      this device forever. The exhausted row is never re-offered, no code
 *      path enqueues a fresh one (saveAnalysis skips because local_session
 *      exists; commitPracticeSet only calls saveSession for a non-resumed
 *      plan), and every LATER shot of the set gets exactly one doomed offer
 *      (the server cannot know the set) and is then parked at attempt 0 —
 *      while ResultScreen tells the user "Sync is paused until the set is
 *      accepted, then this read is sent again automatically." Even after the
 *      server would accept the set, nothing ever asks it again.
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
const SET_A = 'a5a5a5a5-0000-4000-8000-000000000001';

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

interface OwnerCounts {
  sessions: number;
  shots: number;
  outbox: number;
  receipts: number;
}

async function ownerCounts(db: LocalDb, owner: string): Promise<OwnerCounts> {
  const count = async (table: string): Promise<number> => {
    const { rows } = await db.execute(
      `SELECT COUNT(*) AS n FROM ${table} WHERE owner_key = ?`,
      [owner],
    );
    return Number(rows[0]!['n']);
  };
  return {
    sessions: await count('local_session'),
    shots: await count('local_shot'),
    outbox: await count('outbox'),
    receipts: await count('sync_receipt'),
  };
}

/**
 * The live LocalDb with ONE statement intercepted at the driver boundary:
 * the first statement matching `pattern` waits for `gate` (holding the
 * surrounding transaction open) and then fails like a full disk. Everything
 * else is executed by the real driver on the real connection.
 */
function diskFullAt(
  db: LocalDb,
  pattern: RegExp,
  gate: Promise<void>,
): LocalDb {
  let tripped = false;
  return {
    async execute(sql, params) {
      if (!tripped && pattern.test(sql)) {
        tripped = true;
        await gate;
        throw new Error('[op-sqlite] SQLITE_FULL: database or disk is full');
      }
      return db.execute(sql, params);
    },
    close: () => db.close(),
  };
}

interface Emulator extends SyncTransport {
  created: string[];
  offered: string[][];
  createError: (() => Error) | null;
}

/** Mirrors supabase/functions/api: createSession is an idempotent upsert
 * (or fails with `createError`); apply_synced_shot answers
 * `shot.session_not_found` until the owner's session row exists. */
function serverEmulator(): Emulator {
  const knownSessions = new Set<string>();
  const created: string[] = [];
  const offered: string[][] = [];
  const emulator: Emulator = {
    created,
    offered,
    createError: null,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      created.push(id);
      if (emulator.createError) throw emulator.createError();
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      const ids: string[] = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
        ids.push(shot.id);
        if (shot.sessionId && !knownSessions.has(shot.sessionId)) {
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

describe('attack round 5 / fix4-mds-sqlite-b (real SQLite)', () => {
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

  it('B1: a drain rejection recorded while a saveAnalysis transaction is open is rolled back with that transaction (drain says failed=1, row says attempts=0)', async () => {
    const rejectedShot = shotId(0x830);
    await saveAnalysis(
      db,
      realAnalysis({ id: rejectedShot, sessionId: null }),
      PERMIT_ID,
    );

    // Transport answers only when the test says so, so the drain is parked
    // on the network while a capture is being saved on the same connection.
    const serverAnswers = deferred<void>();
    const offerSeen = deferred<void>();
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots() {
        offerSeen.resolve();
        await serverAnswers.promise;
        return {
          acceptedIds: [],
          rejected: [
            {
              id: rejectedShot,
              code: 'shot.invalid',
              message: 'contract verdict',
            },
          ],
        };
      },
    };
    const drain = drainOutbox(db, transport);
    await offerSeen.promise;

    // A capture save that will fail on its last INSERT: local_session,
    // session.create and local_shot are already written inside the open
    // BEGIN IMMEDIATE when the drain's verdict lands.
    const releaseSave = deferred<void>();
    const save = saveAnalysis(
      diskFullAt(
        db,
        /INSERT INTO outbox[\s\S]*'shot\.sync'/,
        releaseSave.promise,
      ),
      realAnalysis({ id: shotId(0x831), sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    await settleMicrotasks(20);

    serverAnswers.resolve();
    // Plumbing only: the lease is released during the drain's network wait,
    // so the save now holds the connection (its BEGIN IMMEDIATE is open,
    // parked on the injected fault) and the drain's verdict queues behind
    // it. Let the save fail before awaiting the drain; the assertions below
    // are unchanged — the verdict lands in its own transaction, after the
    // save's rollback, and is durable.
    await settleMicrotasks(20);
    releaseSave.resolve();
    await expect(save).rejects.toThrow(/SQLITE_FULL/);
    const result = await drain;
    expect(result.failed).toBe(1);

    // Expected: the verdict the drain just recorded is durable.
    // Observed on the candidate: { state: 'queued', attempts: 0, lastError: null }.
    expect(await getShotOutboxStatus(db, rejectedShot)).toEqual({
      state: 'rejected',
      attempts: 1,
      lastError: expect.stringContaining('shot.invalid'),
    });
    // The failed save itself left nothing behind (claim 1 holds for its own rows).
    expect(await ownerCounts(db, OWNER)).toEqual({
      sessions: 0,
      shots: 1,
      outbox: 1,
      receipts: 0,
    });
  });

  it('B2: purgeOwnerData during an in-flight drain — the accepted shot writes a sync_receipt for the purged owner back into the database', async () => {
    const shot = shotId(0x840);
    await saveAnalysis(
      db,
      realAnalysis({ id: shot, sessionId: null }),
      PERMIT_ID,
    );
    const serverAnswers = deferred<void>();
    const offerSeen = deferred<void>();
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offerSeen.resolve();
        await serverAnswers.promise;
        return {
          acceptedIds: shots.map(entry => (entry as { id: string }).id),
          rejected: [],
        };
      },
    };
    const drain = drainOutbox(db, transport);
    await offerSeen.promise;

    // completeAccountDeletion: the account is gone server-side, the local
    // bucket is purged while the drain still awaits the server.
    await purgeOwnerData(db, OWNER);
    expect(await ownerCounts(db, OWNER)).toEqual({
      sessions: 0,
      shots: 0,
      outbox: 0,
      receipts: 0,
    });

    serverAnswers.resolve();
    await drain;

    // Expected: nothing of the deleted owner survives on the device.
    // Observed on the candidate: receipts: 1 (owner_key = purged owner).
    expect(await ownerCounts(db, OWNER)).toEqual({
      sessions: 0,
      shots: 0,
      outbox: 0,
      receipts: 0,
    });
  });

  it('C5: a set whose session.create spent its budget is asked for again (once, bounded) when a new shot joins it; every parked read of the set is delivered once the server accepts the set', async () => {
    const emulator = serverEmulator();
    emulator.createError = () =>
      new ApiError(409, 'session.id_conflict', 'conflict');
    const firstShot = shotId(0x854);
    await saveAnalysis(
      db,
      realAnalysis({ id: firstShot, sessionId: SET_A }),
      PERMIT_ID,
      { session: setInput(SET_A) },
    );
    for (let i = 0; i <= OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, emulator);
    }
    // Re-pinned (O1): the drain after the one that exhausts the set no
    // longer leaves its parked read waiting for a new shot that may never
    // come — it revives the exhausted session.create for ONE more offer
    // (bounded by SESSION_CREATE_REARM_BOUND per set, in
    // `local_session.rearms`), so the ninth drain makes a ninth create call.
    expect(emulator.created).toHaveLength(OUTBOX_MAX_ATTEMPTS + 1);
    expect((await getShotOutboxStatus(db, firstShot)).state).toBe('orphaned');

    // The server recovers (e.g. a 4xx from a since-fixed deploy, or a 403
    // during a permission hiccup); it would accept the set now.
    emulator.createError = null;
    const createdBefore = emulator.created.length;
    const offeredBefore = emulator.offered.length;

    // The set stays live on the device: five more scored shots land in it
    // (each through the atomic saveAnalysis path), each followed by a drain,
    // then a long stretch of idle drains.
    const laterShots = [0x855, 0x856, 0x857, 0x858, 0x859].map(n => shotId(n));
    for (const id of laterShots) {
      await saveAnalysis(
        db,
        realAnalysis({ id, sessionId: SET_A }),
        PERMIT_ID,
        {
          session: setInput(SET_A),
        },
      );
      await drainOutbox(db, emulator);
    }
    for (let i = 0; i < 20; i += 1) await drainOutbox(db, emulator);

    const rows = await outboxRows(db, OWNER);
    const sessionCreates = rows.filter(r => r.kind === 'session.create');
    const states = await Promise.all(
      laterShots.map(id => getShotOutboxStatus(db, id)),
    );

    // Observed on the unfixed candidate: 0 new createSession calls, one
    // doomed offer per new shot (session_not_found -> parked at attempt 0),
    // 1 exhausted session.create row (attempts=8) pinned forever, all six
    // shots 'orphaned' ("paused until the set is accepted") — a permanence
    // the Result screen's copy denied.
    //
    // Expected by the candidate's own contract ("re-offered when the set's
    // session.create is accepted"; ResultScreen: "this read is sent again
    // automatically"): the first new shot joining the set re-arms its
    // exhausted session.create, the next drain creates the set, releases the
    // parked read and delivers both; every later shot syncs directly. The
    // re-ask is bounded: ONE createSession for the whole episode, nothing
    // further during the idle drains.
    expect(emulator.created.length).toBe(createdBefore + 1);
    expect(emulator.created.slice(createdBefore)).toEqual([SET_A]);
    expect(emulator.offered.length).toBe(offeredBefore + laterShots.length);
    expect(states.map(s => s.state)).toEqual(laterShots.map(() => 'absent'));
    expect(await getShotOutboxStatus(db, firstShot)).toEqual({
      state: 'absent',
    });
    for (const id of [firstShot, ...laterShots]) {
      expect(await hasShotSyncReceipt(db, id)).toBe(true);
    }
    expect(sessionCreates).toEqual([]);
    expect(rows).toEqual([]);
  });
});
