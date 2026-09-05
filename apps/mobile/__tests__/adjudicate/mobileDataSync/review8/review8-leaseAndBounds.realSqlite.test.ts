/**
 * Round-8 independent review scratch probes — candidate A @ 24fd777b.
 * Real node:sqlite; faults injected only at the DB / transport boundary.
 * Numbers printed via `console.info` are the reviewer's evidence.
 */
import type { LocalDb } from '../../../../src/data/db';
import { createRealOpSqliteModule } from '../../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../../src/data/accountScope';
import { getDb } from '../../../../src/data/db';
import {
  getShotOutboxStatus,
  purgeOwnerData,
  saveAnalysis,
  type SessionInput,
} from '../../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_CREATE_REARM_BOUND,
  drainOutbox,
  type SyncTransport,
} from '../../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner('22222222-2222-4333-8444-555555555555');
const SET = (n: number) =>
  `b7b7b7b7-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

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
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}
function track<T>(promise: Promise<T>) {
  let done = false;
  const wrapped = promise.then(
    v => {
      done = true;
      return v;
    },
    e => {
      done = true;
      throw e;
    },
  );
  return { settled: () => done, promise: wrapped };
}
type Sync = Awaited<ReturnType<SyncTransport['syncShots']>>;
function manualTransport() {
  const sessionCalls: Deferred<void>[] = [];
  const shotCalls: Array<{ shots: unknown[]; d: Deferred<Sync> }> = [];
  const transport: SyncTransport = {
    async createSession() {
      const d = deferred<void>();
      sessionCalls.push(d);
      return d.promise;
    },
    async finalizeSession() {
      const d = deferred<void>();
      sessionCalls.push(d);
      return d.promise;
    },
    async syncShots(shots) {
      const d = deferred<Sync>();
      shotCalls.push({ shots, d });
      return d.promise;
    },
  };
  return { transport, sessionCalls, shotCalls };
}
const acceptAll = (shots: unknown[]): Sync => ({
  acceptedIds: shots.map(s => String((s as { id: string }).id)),
  rejected: [],
});
function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
async function wipe(db: LocalDb): Promise<void> {
  for (const table of [
    'local_shot',
    'local_session',
    'outbox',
    'sync_receipt',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
}

describe('review8 candidate A — lease + bounds probes', () => {
  let db: LocalDb;
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    db = getDb();
  });
  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    await wipe(db);
  });

  it('R3a: saveAnalysis started while the drain awaits a never-answering server commits (wall-clock ms recorded)', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await saveAnalysis(
        db,
        realAnalysis({ id: shotId(i), sessionId: SET(i) }),
        PERMIT_ID,
        { session: setInput(SET(i)) },
      );
    }
    const { transport, sessionCalls } = manualTransport();
    const drain = track(drainOutbox(db, transport));
    await ticks(200);
    expect(sessionCalls.length).toBe(1);
    const t0 = performance.now();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(99), sessionId: SET(9) }),
      PERMIT_ID,
      { session: setInput(SET(9)) },
    );
    const ms = performance.now() - t0;
    console.info(`R3a saveAnalysis mid-drain latency: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(200);
    expect(drain.settled()).toBe(false);
    const { rows } = await db.execute(
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
      [OWNER],
    );
    expect(Number(rows[0]!['n'])).toBe(8);
    // Let the drain finish (drains of one owner are chained by drainOutbox).
    for (let i = 0; i < 10 && !drain.settled(); i += 1) {
      for (const c of sessionCalls) c.reject(new Error('network down'));
      await ticks(200);
    }
    await drain.promise;
  });

  it('R3b: a connection that dies (every statement throws "database is closed") mid-drain leaks no lease; the drain returns; a later save on a healthy handle commits at once', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    let dead = false;
    const dying: LocalDb = {
      execute: async (sql, params) => {
        if (dead) throw new Error('SQLITE_MISUSE: database is closed');
        return db.execute(sql, params);
      },
      close: () => {},
    };
    const { transport, sessionCalls } = manualTransport();
    const drain = track(drainOutbox(dying, transport));
    await ticks(200);
    expect(sessionCalls.length).toBe(1);
    dead = true;
    sessionCalls[0]!.resolve();
    let threw = false;
    try {
      await Promise.race([
        drain.promise,
        ticks(2000).then(() => {
          throw new Error('REVIEW: drain did not settle');
        }),
      ]);
    } catch (error) {
      threw = true;
      console.info(`R3b drain error: ${String(error)}`);
    }
    console.info(`R3b drain on dead connection threw=${threw}`);
    const next = track(
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(2), sessionId: SET(2) }),
        PERMIT_ID,
        { session: setInput(SET(2)) },
      ),
    );
    await ticks(50);
    expect(next.settled()).toBe(true);
    await next.promise;
  });

  it('R3e: 1000 seeded ops (save / drain / purge / owner switch) — no hang, no lost row, max outstanding lease requests recorded', async () => {
    const random = seededRandom(0x5eed8);
    let outstanding = 0;
    let maxOutstanding = 0;
    const pending: Promise<unknown>[] = [];
    const transports: ReturnType<typeof manualTransport>[] = [];
    const wrap = <T>(p: Promise<T>) => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      const done = p.then(
        () => {
          outstanding -= 1;
        },
        () => {
          outstanding -= 1;
        },
      );
      pending.push(done);
    };
    let saves = 0;
    const answer = () => {
      for (const t of transports) {
        for (const c of t.sessionCalls) c.resolve();
        for (const c of t.shotCalls) c.d.resolve(acceptAll(c.shots));
      }
    };
    for (let op = 0; op < 1000; op += 1) {
      const r = random();
      const owner = r < 0.15 ? OWNER_B : OWNER;
      setActiveDataOwner(owner);
      if (r < 0.7) {
        saves += 1;
        const set = SET(1 + Math.floor(random() * 6));
        wrap(
          saveAnalysis(
            db,
            realAnalysis({ id: shotId(0x10000 + op), sessionId: set }),
            PERMIT_ID,
            { session: setInput(set) },
          ),
        );
      } else if (r < 0.95) {
        const delay = 1 + Math.floor(random() * 30);
        const slow: SyncTransport = {
          async createSession() {
            await ticks(delay);
          },
          async finalizeSession() {
            await ticks(delay);
          },
          async syncShots(shots) {
            await ticks(delay);
            return acceptAll(shots);
          },
        };
        transports.push(manualTransport());
        wrap(drainOutbox(db, slow));
      } else {
        wrap(purgeOwnerData(db, owner));
      }
      if (random() < 0.3) await ticks(1 + Math.floor(random() * 20));
      if (random() < 0.2) answer();
    }
    let rounds = 0;
    while (outstanding > 0 && rounds < 20000) {
      answer();
      await ticks(50);
      rounds += 1;
    }
    console.info(`R3e settle rounds=${rounds}`);
    await Promise.all(pending);
    console.info(
      `R3e ops=1000 saves=${saves} drains=${transports.length} maxOutstandingLeaseRequests=${maxOutstanding}`,
    );
    expect(outstanding).toBe(0);
    // Invariant: at most one live session.create per (owner,set).
    const { rows } = await db.execute(
      `SELECT owner_key, json_extract(payload,'$.id') AS sid, count(*) AS n
       FROM outbox WHERE kind='session.create' AND attempts < ? AND json_valid(payload)
       GROUP BY owner_key, sid HAVING n > 1`,
      [OUTBOX_MAX_ATTEMPTS],
    );
    expect(rows).toEqual([]);
    expect(maxOutstanding).toBeLessThanOrEqual(1000);
  }, 120000);

  it('R4: server answering shot.session_not_found forever (create accepted) — creates/syncs/rows/rearms bounded; new read grants exactly one more cycle', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    let creates = 0;
    let syncs = 0;
    const transport: SyncTransport = {
      async createSession() {
        creates += 1;
      },
      async finalizeSession() {},
      async syncShots(shots) {
        syncs += 1;
        return {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: String((s as { id: string }).id),
            code: 'shot.session_not_found',
            message: 'no such session',
          })),
        };
      },
    };
    for (let i = 0; i < 40; i += 1) await drainOutbox(db, transport);
    const rows = await db.execute(
      `SELECT kind, attempts, refusals, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    const rearms = await db.execute(
      `SELECT rearms FROM local_session WHERE owner_key = ? AND id = ?`,
      [OWNER, SET(1)],
    );
    const status = await getShotOutboxStatus(db, shotId(1));
    console.info(
      `R4 after 40 drains: creates=${creates} syncs=${syncs} rows=${JSON.stringify(rows.rows)} rearms=${JSON.stringify(rearms.rows)} status=${JSON.stringify(status)}`,
    );
    expect(creates).toBe(1 + SESSION_CREATE_REARM_BOUND);
    expect(syncs).toBeLessThanOrEqual(1 + SESSION_CREATE_REARM_BOUND);
    expect(rows.rows.length).toBe(1);
    // Paused marker = BOUND + 1 (documented in sync.ts); actual re-arms = creates - 1.
    expect(Number(rearms.rows[0]!['rearms'])).toBe(
      SESSION_CREATE_REARM_BOUND + 1,
    );
    // A genuinely new read into the set: one more cycle only.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(2), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    const c0 = creates;
    const s0 = syncs;
    for (let i = 0; i < 40; i += 1) await drainOutbox(db, transport);
    const status2 = await getShotOutboxStatus(db, shotId(1));
    const status3 = await getShotOutboxStatus(db, shotId(2));
    console.info(
      `R4 after new read + 40 drains: +creates=${creates - c0} +syncs=${syncs - s0} status1=${JSON.stringify(status2)} status2=${JSON.stringify(status3)}`,
    );
    expect(creates - c0).toBeLessThanOrEqual(1 + SESSION_CREATE_REARM_BOUND);
    expect(syncs - s0).toBeLessThanOrEqual(1 + SESSION_CREATE_REARM_BOUND);
    const count = await db.execute(
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ?`,
      [OWNER],
    );
    expect(Number(count.rows[0]!['n'])).toBe(2);
  });

  it('R4: quarantined / legacy-exhausted / paused rows — status and copy inputs recorded', async () => {
    // (1) shot row with valid JSON but no permit: quarantined once.
    const shot = realAnalysis({ id: shotId(7), sessionId: null });
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [OWNER, JSON.stringify(shot)],
    );
    // (2) legacy exhausted row (attempts=8, old last_error, refusals column default 0).
    const legacy = realAnalysis({ id: shotId(8), sessionId: null });
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error) VALUES (?, 'shot.sync', ?, 8, 'shot.permit_invalid: old build')`,
      [OWNER, JSON.stringify({ ...legacy, analysisPermitId: PERMIT_ID })],
    );
    // (3) legacy parked marker from d29b95f5 wording.
    const parked = realAnalysis({ id: shotId(9), sessionId: SET(3) });
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, attempts, last_error) VALUES (?, 'shot.sync', ?, 8, 'shot.session_orphaned: practice set was refused')`,
      [OWNER, JSON.stringify({ ...parked, analysisPermitId: PERMIT_ID })],
    );
    let syncs = 0;
    const offered: string[][] = [];
    const transport: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        syncs += 1;
        offered.push(shots.map(s => String((s as { id: string }).id)));
        return acceptAll(shots);
      },
    };
    const results = [];
    for (let i = 0; i < 3; i += 1)
      results.push(await drainOutbox(db, transport));
    const rows = await db.execute(
      `SELECT json_extract(payload,'$.id') AS sid, attempts, refusals, last_error FROM outbox WHERE owner_key = ? ORDER BY id`,
      [OWNER],
    );
    const s7 = await getShotOutboxStatus(db, shotId(7));
    const s8 = await getShotOutboxStatus(db, shotId(8));
    const s9 = await getShotOutboxStatus(db, shotId(9));
    console.info(
      `R4 quarantine/legacy: results=${JSON.stringify(results)} syncs=${syncs} offered=${JSON.stringify(offered)} rows=${JSON.stringify(rows.rows)} s7=${JSON.stringify(s7)} s8=${JSON.stringify(s8)} s9=${JSON.stringify(s9)}`,
    );
    expect(results.map(r => r.failed)).toEqual([1, 0, 0]);
    expect(syncs).toBe(0);
  });

  it('R4: LOCAL_MIGRATIONS + ensureAccountScopedSchema idempotent on re-open at the new version', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: SET(1) }),
      PERMIT_ID,
      { session: setInput(SET(1)) },
    );
    await db.execute(`UPDATE local_session SET rearms = 2`);
    await db.execute(`UPDATE outbox SET refusals = 5`);
    db.close();
    const reopened = getDb();
    const s = await reopened.execute(`SELECT rearms FROM local_session`);
    const o = await reopened.execute(`SELECT refusals FROM outbox`);
    expect(s.rows.map(r => Number(r['rearms']))).toEqual([2]);
    expect(o.rows.map(r => Number(r['refusals']))).toEqual([5, 5]);
    db = reopened;
  });
});
