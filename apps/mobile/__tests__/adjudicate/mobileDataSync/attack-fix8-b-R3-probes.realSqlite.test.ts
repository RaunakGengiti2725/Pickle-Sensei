/**
 * ADVERSARY fix round 8 / candidate B (d1c42d78) — probes over claims 1, 2,
 * 3, 5 and the stated bounds. Each `it` asserts the candidate's claim; a
 * failing probe is an observed break, a passing probe is a measured bound.
 * Real modules, real node:sqlite.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

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
  hasShotSyncReceipt,
  purgeOwnerData,
  saveAnalysis,
  setKv,
  type SessionInput,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  leaseWaiters,
  resetLeaseWaiterPeak,
  runInTransaction,
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
const OTHER = canonicalDataOwner('99999999-2222-4333-8444-555555555555');
const SET = 'a8a8a8a8-0000-4000-8000-0000000000b3';

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
  for (const table of [
    'outbox',
    'local_shot',
    'local_session',
    'sync_receipt',
    'sync_set_state',
    'kv',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
}

async function insertOutbox(
  db: LocalDb,
  owner: string | null,
  kind: string,
  payload: string,
  attempts = 0,
  lastError: string | null = null,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload, created_at, attempts, last_error)
     VALUES (?, ?, ?, datetime('now'), ?, ?)`,
    [owner, kind, payload, attempts, lastError],
  );
}

function ids(shots: unknown[]): string[] {
  return shots.map(s => String((s as { id: unknown }).id));
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
      const offered = ids(shots);
      t.offers.push(...offered);
      return {
        acceptedIds: [],
        rejected: offered.map(id => ({
          id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found for this shot.',
        })),
      };
    },
  };
  return t;
}

describe('attack-fix8-b R3 — probes (claims 1/2/3/5 + measured bounds)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await clearAll(db);
    resetLeaseWaiterPeak();
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      // already closed by a probe
    }
    mockSqlite.reset();
  });

  it('P1 — bounds over 50 drains (accept set / refuse shots not_found, a genuinely new read every 10 drains)', async () => {
    const server = acceptCreateRefuseShots();
    const perRead: Array<{ creates: number; syncs: number }> = [];
    let syncCalls = 0;
    const counting: SyncTransport = {
      ...server,
      async syncShots(shots) {
        syncCalls += 1;
        return server.syncShots(shots);
      },
    };
    for (let d = 0; d < 50; d += 1) {
      if (d % 10 === 0) {
        const c0 = server.creates;
        const s0 = syncCalls;
        await saveAnalysis(
          db,
          realAnalysis({ id: shotId(0xc000 + d), sessionId: SET }),
          PERMIT_ID,
          { session: setInput(SET) },
        );
        perRead.push({ creates: -c0, syncs: -s0 });
      }
      await drainOutbox(db, counting);
      if (d % 10 === 9) {
        const last = perRead[perRead.length - 1]!;
        last.creates += server.creates;
        last.syncs += syncCalls;
      }
    }
    const rows = await outboxRows(db, OWNER);
    const state = await db.execute(
      `SELECT rearms FROM sync_set_state WHERE owner_key = ? AND session_id = ?`,
      [OWNER, SET],
    );
    const offersPerShot = new Map<string, number>();
    for (const id of server.offers) {
      offersPerShot.set(id, (offersPerShot.get(id) ?? 0) + 1);
    }
    const bounds = {
      rearms_per_set: Number(state.rows[0]?.['rearms'] ?? 0),
      creates_per_read: Math.max(...perRead.map(r => r.creates)),
      syncs_per_read: Math.max(...perRead.map(r => r.syncs)),
      offers_per_shot: Math.max(...offersPerShot.values()),
      outbox_rows_after_50_drains: rows.length,
      attempts: rows.map(r => r.attempts),
      lease_waiters_max: leaseWaiters().peak,
    };
    console.log('attack-fix8-b P1 bounds', JSON.stringify(bounds));
    expect(bounds.rearms_per_set).toBeLessThanOrEqual(2);
    expect(bounds.creates_per_read).toBeLessThanOrEqual(3);
    expect(bounds.syncs_per_read).toBeLessThanOrEqual(3);
    expect(bounds.offers_per_shot).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
    expect(rows.every(r => r.attempts <= OUTBOX_MAX_ATTEMPTS)).toBe(true);
    expect(leaseWaiters().pending).toBe(0);
  });

  it('P2 — 300 malformed shapes + 1 healthy row: drain never rejects, healthy row synced first drain, every malformed row quarantined ONCE with bounded last_error', async () => {
    const big = 'x'.repeat(1_000_000);
    const shapes: Array<[string, string]> = [
      ['shot.sync', 'null'],
      ['shot.sync', '[]'],
      ['shot.sync', '"str"'],
      ['shot.sync', '42'],
      ['shot.sync', '{'],
      ['shot.sync', big],
      ['shot.sync', `"${big}"`],
      ['shot.sync', JSON.stringify({ id: { nested: true } })],
      ['shot.sync', JSON.stringify({ id: 12 })],
      ['shot.sync', JSON.stringify({ id: 'a\u0000b', analysisPermitId: 'p' })],
      ['shot.sync', JSON.stringify({ id: big, analysisPermitId: 'p' })],
      ['shot.sync', JSON.stringify({ id: 's', analysisPermitId: '   ' })],
      ['shot.sync', JSON.stringify({ id: 's', analysisPermitId: 'p' })],
      [
        'shot.sync',
        JSON.stringify({ id: 's', analysisPermitId: 'p', checkpoints: [null] }),
      ],
      [
        'shot.sync',
        JSON.stringify({
          id: 's',
          analysisPermitId: 'p',
          checkpoints: 'nope',
          sessionId: 7,
        }),
      ],
      ['shot.sync', `{"__proto__":{"id":"x"},"constructor":{"prototype":{}}}`],
      ['session.create', 'null'],
      ['session.create', '{"id":null}'],
      ['session.create', '{"id":""}'],
      ['session.create', JSON.stringify({ id: ['x'] })],
      ['session.create', `{"__proto__":{"id":"x"}}`],
      ['session.finalize', '[1,2,3]'],
      ['bogus.kind', '{"id":"x"}'],
      ['evaluation.trial', '{'],
    ];
    const rowsPlanted: Array<[string, string]> = [];
    while (rowsPlanted.length < 300) {
      for (const shape of shapes) {
        if (rowsPlanted.length >= 300) break;
        rowsPlanted.push(shape);
      }
    }
    for (const [kind, payload] of rowsPlanted) {
      await insertOutbox(db, OWNER, kind, payload);
    }
    // NULL owner_key cannot exist under the current schema (NOT NULL DEFAULT
    // guest); the legacy-owner bucket is exercised instead.
    await insertOutbox(db, 'device-guest', 'shot.sync', 'null');
    await insertOutbox(db, 'device-guest', 'session.create', '{"id":"n"}');
    const healthy = shotId(0xc100);
    await saveAnalysis(db, realAnalysis({ id: healthy }), PERMIT_ID, {});

    const transport = acceptAllTransport();
    const first = await drainOutbox(db, transport);
    expect(ids(transport.syncCalls.flat())).toEqual([healthy]);
    expect(await hasShotSyncReceipt(db, healthy)).toBe(true);
    const after1 = await outboxRows(db, OWNER);
    const evaluationTrialRows = rowsPlanted.filter(
      ([k]) => k === 'evaluation.trial',
    ).length;
    const quarantined = after1.filter(r => r.attempts >= OUTBOX_MAX_ATTEMPTS);
    // evaluation.trial rows are not selected without uploadEvaluationTrials.
    expect(quarantined).toHaveLength(300 - evaluationTrialRows);
    const maxErr = Math.max(...after1.map(r => (r.last_error ?? '').length));
    console.log('attack-fix8-b P2', {
      failed: first.failed,
      synced: first.synced,
      maxLastErrorLength: maxErr,
    });
    expect(maxErr).toBeLessThan(600);
    for (const r of quarantined) expect(r.last_error).toBeTruthy();

    // Quarantined once: three more drains change nothing and sync nothing.
    const before = after1.map(r => `${r.id}:${r.attempts}:${r.last_error}`);
    for (let d = 0; d < 3; d += 1) await drainOutbox(db, transport);
    const after4 = await outboxRows(db, OWNER);
    expect(after4.map(r => `${r.id}:${r.attempts}:${r.last_error}`)).toEqual(
      before,
    );
    expect(transport.syncCalls).toHaveLength(1);
  });

  it('P3 — 10,000 quarantined rows ahead of one healthy row do not starve it, and the malformed rows never come back', async () => {
    for (let i = 0; i < 10_000; i += 1) {
      await insertOutbox(db, OWNER, 'shot.sync', i % 2 ? 'null' : '{"id":5}');
    }
    const healthy = shotId(0xc200);
    await saveAnalysis(db, realAnalysis({ id: healthy }), PERMIT_ID, {});
    const transport = acceptAllTransport();
    const t0 = Date.now();
    await drainOutbox(db, transport);
    const ms = Date.now() - t0;
    console.log('attack-fix8-b P3 first drain ms', ms);
    expect(await hasShotSyncReceipt(db, healthy)).toBe(true);
    const t1 = Date.now();
    await drainOutbox(db, transport);
    console.log('attack-fix8-b P3 second drain ms', Date.now() - t1);
    expect(transport.syncCalls).toHaveLength(1);
    const { rows } = await db.execute(
      `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND attempts < ?`,
      [OWNER, OUTBOX_MAX_ATTEMPTS],
    );
    expect(Number(rows[0]!['n'])).toBe(0);
  });

  it('P4 — liveness: a quarantined session.create beside healthy shots of the set self-heals through the local set (≤3 creates, ≤2 offers, then accepted)', async () => {
    await insertOutbox(db, OWNER, 'session.create', 'null');
    const shot = shotId(0xc300);
    await saveAnalysis(
      db,
      realAnalysis({ id: shot, sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    // Corrupt the set's own create row after the save (the malformed row is
    // now the only session.create with that id... it has none).
    await db.execute(
      `UPDATE outbox SET payload = '{"id":' WHERE owner_key = ? AND kind = 'session.create' AND json_valid(payload)`,
      [OWNER],
    );
    const t = acceptCreateRefuseShots();
    await drainOutbox(db, t); // shot refused not_found → re-arm from local set
    const accepting = acceptAllTransport();
    await drainOutbox(db, accepting);
    expect(await hasShotSyncReceipt(db, shot)).toBe(true);
    console.log('attack-fix8-b P4', {
      creates: t.creates + accepting.sessions.length,
      offers: t.offers.length + accepting.syncCalls.length,
    });
    expect(t.creates + accepting.sessions.length).toBeLessThanOrEqual(3);
    const quarantinedCreates = (await outboxRows(db, OWNER)).filter(
      r => r.kind === 'session.create',
    );
    // Both malformed session.create rows stay quarantined; never revived.
    expect(quarantinedCreates.map(r => r.attempts)).toEqual([
      OUTBOX_MAX_ATTEMPTS,
      OUTBOX_MAX_ATTEMPTS,
    ]);
  });

  it('P5 — cross-owner: a session.create of owner A and shots of owner B under the same set id never share liveness/re-arm state', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xc400), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    setActiveDataOwner(OTHER);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xc401), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    const t = acceptCreateRefuseShots();
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    setActiveDataOwner(OWNER);
    for (let d = 0; d < 6; d += 1) await drainOutbox(db, t);
    const states = await db.execute(
      `SELECT owner_key, rearms FROM sync_set_state WHERE session_id = ? ORDER BY owner_key`,
      [SET],
    );
    expect(states.rows).toHaveLength(2);
    for (const r of states.rows) expect(Number(r['rearms'])).toBe(2);
    expect(t.creates).toBe(6);
    expect(t.offers).toHaveLength(4);
  });

  it('P6 — lease: SQLITE_FULL (tiny max_page_count) from leased kv writes leaks no lease turn; saveAnalysis/drain/receipt still complete (the retired row frees pages) and nothing is charged', async () => {
    const shot = shotId(0xc500);
    await saveAnalysis(db, realAnalysis({ id: shot }), PERMIT_ID, {});
    await db.execute('VACUUM');
    await db.execute('PRAGMA max_page_count = 1');
    try {
      // Fill the last free pages through the leased kv writer until the
      // store is exactly full.
      let fullErrors = 0;
      for (const size of [3_000, 300, 30, 3]) {
        let full = false;
        for (let i = 0; i < 10_000 && !full; i += 1) {
          await setKv(db, `fill${size}-${i}`, 'z'.repeat(size)).catch(e => {
            full = true;
            fullErrors += 1;
            expect(String(e)).toMatch(/full/i);
          });
        }
      }
      expect(fullErrors).toBeGreaterThan(0);
      const saveUnderFull = await saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xc501) }),
        PERMIT_ID,
        {},
      ).then(
        () => 'saved',
        e => `rejected: ${String(e)}`,
      );
      console.log(
        'attack-fix8-b P6 saveAnalysis under SQLITE_FULL',
        saveUnderFull,
      );
      const accepting = acceptAllTransport();
      const outcome = await drainOutbox(db, accepting).then(
        r => ({ ok: true as const, r }),
        e => ({ ok: false as const, e: String(e) }),
      );
      console.log('attack-fix8-b P6 drain under SQLITE_FULL', outcome);
      const rows = await outboxRows(db, OWNER);
      console.log('attack-fix8-b P6 rows after', rows);
      // Whether or not the receipt landed, nothing is charged and no turn is
      // leaked; if the receipt failed the row must still be offered.
      expect(rows.every(r => r.attempts === 0)).toBe(true);
      expect(leaseWaiters().pending).toBe(0);
      if (!(await hasShotSyncReceipt(db, shot))) {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.last_error).toMatch(/receipt_not_saved|full/);
      }
    } finally {
      await db.execute('PRAGMA max_page_count = 1073741823');
    }
    await db.execute(`DELETE FROM kv WHERE key LIKE 'fill%'`);
    const accepting = acceptAllTransport();
    await drainOutbox(db, accepting);
    expect(await hasShotSyncReceipt(db, shot)).toBe(true);
    await expect(setKv(db, 'after-full', 'ok')).resolves.toBeUndefined();
  });

  it('P7 — lease: a second connection holding BEGIN IMMEDIATE makes every statement group fail with SQLITE_BUSY; the drain rejects, nothing is charged, the lease recovers', async () => {
    const shot = shotId(0xc600);
    await saveAnalysis(db, realAnalysis({ id: shot }), PERMIT_ID, {});
    // Find the backing file through the module (the harness keeps it private):
    const file = (await db.execute(`PRAGMA database_list`)).rows.map(r =>
      String(r['file']),
    )[0]!;
    expect(fs.existsSync(file)).toBe(true);
    const locker = new DatabaseSync(file);
    locker.exec('BEGIN IMMEDIATE');
    locker.exec(`INSERT INTO kv (key, value) VALUES ('lock', '1')`);
    const accepting = acceptAllTransport();
    const outcome = await drainOutbox(db, accepting).then(
      r => ({ ok: true as const, r }),
      e => ({ ok: false as const, e: String(e) }),
    );
    console.log('attack-fix8-b P7 drain under SQLITE_BUSY', outcome);
    const busySave = await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xc601) }),
      PERMIT_ID,
      {},
    ).then(
      () => 'saved',
      e => `rejected: ${String(e).slice(0, 60)}`,
    );
    console.log('attack-fix8-b P7 saveAnalysis under SQLITE_BUSY', busySave);
    locker.exec('ROLLBACK');
    locker.close();
    expect(leaseWaiters().pending).toBe(0);
    const rows = await outboxRows(db, OWNER);
    expect(rows.every(r => r.attempts === 0)).toBe(true);
    await drainOutbox(db, accepting);
    expect(await hasShotSyncReceipt(db, shot)).toBe(true);
  });

  it('P8 — lease: transport throws synchronously (before any await) on createSession and syncShots — caught, uncharged, no leak', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xc700), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );
    const throwing: SyncTransport = {
      createSession() {
        throw new TypeError('sync throw before await');
      },
      finalizeSession: async () => {},
      syncShots() {
        throw new TypeError('sync throw before await');
      },
    };
    const result = await drainOutbox(db, throwing);
    const rows = await outboxRows(db, OWNER);
    console.log('attack-fix8-b P8', { result, rows });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(rows.map(r => r.attempts)).toEqual([0, 0]);
    expect(leaseWaiters().pending).toBe(0);
  });

  it('P9 — lease fairness: 1,000 interleaved saveAnalysis / drain / kv / purge calls — no hang, no lost row, waiter peak bounded', async () => {
    const accepting = acceptAllTransport();
    const work: Promise<unknown>[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let saved = 0;
    let purges = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const r = rnd();
      if (r < 0.5) {
        saved += 1;
        work.push(
          saveAnalysis(
            db,
            realAnalysis({ id: shotId(0xd000 + i) }),
            PERMIT_ID,
            {},
          ),
        );
      } else if (r < 0.8) {
        work.push(drainOutbox(db, accepting));
      } else if (r < 0.97) {
        work.push(setKv(db, `k${i}`, `${i}`));
      } else {
        purges += 1;
        work.push(purgeOwnerData(db, OTHER));
      }
    }
    await Promise.all(work);
    await drainOutbox(db, accepting);
    const left = await outboxRows(db, OWNER);
    const { rows } = await db.execute(
      `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    console.log('attack-fix8-b P9', {
      saved,
      purges,
      receipts: Number(rows[0]!['n']),
      left: left.length,
      peakWaiters: leaseWaiters().peak,
    });
    expect(left).toHaveLength(0);
    expect(Number(rows[0]!['n'])).toBe(saved);
    expect(leaseWaiters().pending).toBe(0);
  });

  it('P10 — runInTransaction while a drain is parked on a pending-forever transport: saveAnalysis completes; the lease is free', async () => {
    let release: () => void = () => {};
    const pending: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      syncShots: () =>
        new Promise(resolve => {
          release = () => resolve({ acceptedIds: [], rejected: [] });
        }),
    };
    await saveAnalysis(db, realAnalysis({ id: shotId(0xc800) }), PERMIT_ID, {});
    const drain = drainOutbox(db, pending);
    await new Promise(r => setTimeout(r, 5));
    const saveRace = await Promise.race([
      saveAnalysis(
        db,
        realAnalysis({ id: shotId(0xc801) }),
        PERMIT_ID,
        {},
      ).then(() => 'saved'),
      new Promise(r => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(saveRace).toBe('saved');
    expect(leaseWaiters().pending).toBe(0);
    await runInTransaction(db, async () => {
      await db.execute(`INSERT INTO kv (key, value) VALUES ('x', 'y')`);
    });
    release();
    await drain;
  });

  it('P11 — quarantine guard gap probe: a JSON payload nested 1000 deep passes JSON.parse; does SQLite json_valid throw on it and break status reads / reopen? (measured: no)', async () => {
    const deep = `{"id":"${shotId(0xc900)}","analysisPermitId":"p","source":"real","checkpoints":[],"x":${'['.repeat(1000)}${']'.repeat(1000)}}`;
    expect(() => JSON.parse(deep)).not.toThrow();
    await insertOutbox(db, OWNER, 'shot.sync', deep);
    const other = shotId(0xc901);
    await saveAnalysis(db, realAnalysis({ id: other }), PERMIT_ID, {});
    // Every SQL path that guards with json_valid(payload) throws for the
    // whole owner, not just for the row:
    const status = await getShotOutboxStatus(db, other).then(
      s => s.state,
      e => `throws: ${String(e).slice(0, 80)}`,
    );
    console.log('attack-fix8-b P11 getShotOutboxStatus(other)', status);
    // LOCAL_MIGRATIONS run on every open and include
    // `DELETE FROM outbox WHERE kind='shot.sync' AND json_valid(payload) AND …`
    getDb().close();
    const reopen = (() => {
      try {
        getDb();
        return 'opened';
      } catch (e) {
        return `throws: ${String(e).slice(0, 80)}`;
      }
    })();
    console.log('attack-fix8-b P11 reopen', reopen);
    // Restore a usable handle for the remaining assertions/afterAll.
    if (reopen !== 'opened') {
      mockSqlite.seed(`DELETE FROM outbox WHERE payload = ?`, [deep]);
      db = getDb();
    }
    expect({ status, reopen }).toEqual({ status: 'queued', reopen: 'opened' });
  });

  it('P12 — claim 5: the connection is closed between transport accept and the receipt store; the row stays uncharged and is re-offered after reopen (server idempotency carries the duplicate)', async () => {
    const shot = shotId(0xca00);
    await saveAnalysis(db, realAnalysis({ id: shot }), PERMIT_ID, {});
    const offers: string[] = [];
    const closing: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offers.push(...ids(shots));
        getDb().close();
        return { acceptedIds: ids(shots), rejected: [] };
      },
    };
    const outcome = await drainOutbox(db, closing).then(
      r => ({ ok: true as const, r }),
      e => ({ ok: false as const, e: String(e).slice(0, 100) }),
    );
    db = getDb();
    const rows = await outboxRows(db, OWNER);
    console.log('attack-fix8-b P12', { outcome, rows, offers });
    expect(leaseWaiters().pending).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(0);
    expect(await hasShotSyncReceipt(db, shot)).toBe(false);
    await drainOutbox(db, acceptAllTransport());
    expect(await hasShotSyncReceipt(db, shot)).toBe(true);
    expect(offers).toEqual([shot]);
  });
});
