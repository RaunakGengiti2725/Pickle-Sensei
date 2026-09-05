/**
 * Adversarial round 3 (attack branch) — probes against the candidate
 * `devin/fix2-mds-c2-c1-c3-sqlite-txn` merged onto 3bd08da5, on the real
 * SQLite adapter. These pin the attacks that did NOT break the candidate so
 * the coordinator can see what was exercised:
 *
 *  - 10,000-row outbox (200 practice sets × 50 shots interleaved with their
 *    session rows) drains completely in one pass, every shot offered exactly
 *    once, no row left behind, no transaction left open;
 *  - a kill between the two halves of a receipt (receipt INSERT committed in
 *    memory, DELETE fails) rolls the receipt back atomically and the next
 *    drain replays the shot;
 *  - a receipt transaction landing while a repository write transaction is
 *    open never nests and both survive;
 *  - valid-JSON / schema-invalid shot rows fail alone and permanently without
 *    poisoning their page;
 *  - malformed JSON beside a healthy shot does not break the healthy shot's
 *    status lookup (C1) or its sync;
 *  - an account switch after a drain started keeps the in-flight drain bound
 *    to the owner it started with.
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
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  type SyncTransport,
} from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const OTHER_USER = '99999999-2222-4333-8444-555555555555';
const OTHER_OWNER = canonicalDataOwner(OTHER_USER);

function sessionUuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-1111-4000-8000-000000000000`;
}

async function insertShotRow(
  db: LocalDb,
  owner: string,
  n: number,
  sessionId: string | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
    [
      owner,
      JSON.stringify({
        ...realAnalysis({ id: shotId(n), sessionId }),
        analysisPermitId: PERMIT_ID,
      }),
    ],
  );
}

async function insertSessionRow(
  db: LocalDb,
  owner: string,
  id: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)`,
    [
      owner,
      JSON.stringify({
        id,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      }),
    ],
  );
}

function transactionDepthLog(log: string[]): { max: number; open: number } {
  let depth = 0;
  let max = 0;
  for (const sql of log) {
    if (sql === 'BEGIN IMMEDIATE') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      depth -= 1;
    }
  }
  return { max, open: depth };
}

describe('ATTACK fix3 probes (real SQLite)', () => {
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

  it('10,000-row outbox: 200 practice sets × 50 shots drain completely, each shot offered once, sessions before shots', async () => {
    const server = acceptAllTransport();
    const shotsPerSet = 50;
    const sets = 200;
    // Bulk seed with the exact rows saveAnalysis/saveSession write, inside a
    // single transaction for speed; a shot always precedes its own session
    // row (the capture flow's order).
    await db.execute('BEGIN IMMEDIATE');
    let n = 0;
    for (let s = 0; s < sets; s++) {
      const sid = sessionUuid(s);
      for (let k = 0; k < shotsPerSet; k++) {
        await insertShotRow(db, OWNER, n++, sid);
        if (k === 0) await insertSessionRow(db, OWNER, sid);
      }
    }
    await db.execute('COMMIT');
    expect((await outboxRows(db, OWNER)).length).toBe(
      sets * shotsPerSet + sets,
    );
    const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
    const logStart = live.log.length;

    const result = await drainOutbox(db, server);

    expect(result).toEqual({
      synced: sets * shotsPerSet + sets,
      failed: 0,
      remaining: 0,
    });
    expect(server.sessions).toHaveLength(sets);
    const offered = server.syncCalls
      .flat()
      .map(s => String((s as { id: unknown }).id));
    expect(offered).toHaveLength(sets * shotsPerSet);
    expect(new Set(offered).size).toBe(sets * shotsPerSet);
    // Pages are ≤ 50 and ids ascend across the whole pass.
    expect(server.syncCalls.every(page => page.length <= 50)).toBe(true);
    expect([...offered].sort()).toEqual(offered);
    // Every session was created before the first shot went out.
    const log = live.log.slice(logStart);
    const firstReceipt = log.findIndex(sql =>
      sql.includes('INSERT OR REPLACE INTO sync_receipt'),
    );
    const sessionDeletes = log
      .slice(0, firstReceipt)
      .filter(sql => sql.startsWith('DELETE FROM outbox')).length;
    expect(sessionDeletes).toBe(sets);
    expect(transactionDepthLog(log)).toEqual({ max: 1, open: 0 });
    for (const id of [shotId(0), shotId(5000), shotId(9999)]) {
      expect(await hasShotSyncReceipt(db, id)).toBe(true);
    }
  });

  it('I/O failure between the two halves of a receipt: the receipt is rolled back, the row is kept, the shot replays on the next drain', async () => {
    const server = acceptAllTransport();
    await saveAnalysis(db, realAnalysis({ id: shotId(0x700) }), PERMIT_ID);
    let killed = false;
    const dying: LocalDb = {
      async execute(sql, params) {
        if (!killed && sql.startsWith('DELETE FROM outbox')) {
          killed = true;
          throw new Error('SQLITE_IOERR: disk I/O error');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };

    // The statement failure is a row-level transient failure, not a thrown
    // drain; the receipt INSERT that preceded it is rolled back with it.
    const first = await drainOutbox(dying, server);
    expect(first).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(await hasShotSyncReceipt(db, shotId(0x700))).toBe(false);
    const rows = await outboxRows(db, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.last_error).toMatch(/disk I\/O error/);
    const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
    expect(transactionDepthLog(live.log).open).toBe(0);

    const again = await drainOutbox(db, server);
    expect(again).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(server.syncCalls).toHaveLength(2);
    expect(await hasShotSyncReceipt(db, shotId(0x700))).toBe(true);
  });

  it('a receipt landing while a repository write is open: serialized, never nested, both durable', async () => {
    const server = acceptAllTransport();
    await saveAnalysis(db, realAnalysis({ id: shotId(0x800) }), PERMIT_ID);
    const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
    const logStart = live.log.length;

    const drain = drainOutbox(db, server);
    // Start a repository write while the drain awaits the network.
    const write = saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x801) }),
      PERMIT_ID,
    );
    const session = saveSession(db, {
      id: sessionUuid(0x801),
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    await Promise.all([drain, write, session]);

    expect(transactionDepthLog(live.log.slice(logStart))).toEqual({
      max: 1,
      open: 0,
    });
    expect(await hasShotSyncReceipt(db, shotId(0x800))).toBe(true);
    // Re-pinned (L1): the lease is released during the drain's network
    // round trip, so both repository writes commit BEFORE the drain's next
    // statement group (they were queued first) — and that group, a page
    // read against the committed queue, then offers them in the same drain.
    // Before, the writes waited behind the whole drain and their rows were
    // still queued when it returned.
    const rows = await outboxRows(db, OWNER);
    expect(rows).toEqual([]);
    expect(await hasShotSyncReceipt(db, shotId(0x801))).toBe(true);
    expect(await getShotOutboxStatus(db, shotId(0x801))).toEqual({
      state: 'absent',
    });
  });

  it('valid-JSON but schema-invalid shot rows fail alone and permanently; healthy siblings sync', async () => {
    const server = acceptAllTransport();
    const invalid: Array<[string, unknown]> = [
      ['no-permit', { ...realAnalysis({ id: shotId(0x901) }) }],
      [
        'permit-not-string',
        { ...realAnalysis({ id: shotId(0x902) }), analysisPermitId: 42 },
      ],
      ['null-payload', null],
      ['array-payload', [1, 2, 3]],
      ['string-payload', 'just a string'],
      [
        'phases-not-array',
        {
          ...realAnalysis({ id: shotId(0x903) }),
          phases: 'nope',
          analysisPermitId: PERMIT_ID,
        },
      ],
      [
        'unicode-id',
        {
          ...realAnalysis({ id: 'ℬ𝔯𝔬𝔨𝔢𝔫-\u0000-\ud83d\ude00' }),
          analysisPermitId: PERMIT_ID,
        },
      ],
    ];
    for (const [, payload] of invalid) {
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
        [OWNER, JSON.stringify(payload)],
      );
    }
    await saveAnalysis(db, realAnalysis({ id: shotId(0x900) }), PERMIT_ID);

    const first = await drainOutbox(db, server);
    expect(await hasShotSyncReceipt(db, shotId(0x900))).toBe(true);
    // The client only validates what it needs to BUILD a request (an object
    // with a string permit); shape errors beyond that are the Edge's per-item
    // validation (stable, permanent rejection codes). An accept-all server
    // therefore takes the healthy shot plus the two object rows whose permit
    // is a string; the five unbuildable rows (no permit, numeric permit,
    // null, array, string) fail alone, permanently, and none of them poisons
    // the page or throws out of the drain.
    expect(first).toEqual({ synced: 3, failed: 5, remaining: 5 });
    // Re-pinned (S1): a row that can never become a request is quarantined
    // ONCE — its whole budget spent in the drain that finds it, with a
    // truthful last_error — and is never re-read, so later drains of this
    // queue report failed = 0 (the owner's backoff is not held down by it).
    // Before, it was charged one attempt per drain for eight drains.
    const rows = await outboxRows(db, OWNER);
    expect(rows.map(r => r.attempts)).toEqual(
      Array.from({ length: 5 }, () => OUTBOX_MAX_ATTEMPTS),
    );
    expect(rows.every(r => r.last_error !== null)).toBe(true);
    const failedLater: number[] = [];
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) {
      failedLater.push((await drainOutbox(db, server)).failed);
    }
    expect(failedLater).toEqual(
      Array.from({ length: OUTBOX_MAX_ATTEMPTS - 1 }, () => 0),
    );
    const settled = await outboxRows(db, OWNER);
    expect(settled.every(r => r.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(true);
    // And a fresh healthy shot behind them still syncs.
    await saveAnalysis(db, realAnalysis({ id: shotId(0x9ff) }), PERMIT_ID);
    const later = await drainOutbox(db, server);
    expect(later).toMatchObject({ synced: 1, failed: 0 });
    expect(await hasShotSyncReceipt(db, shotId(0x9ff))).toBe(true);
  });

  it('malformed JSON beside a healthy shot: C1 status lookup and sync both survive; the malformed row settles', async () => {
    const server = acceptAllTransport();
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [OWNER, '{"id": "aaaa", "analysisPermitId": '],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)`,
      [OWNER, '\u00ff\u00fe not json'],
    );
    await saveAnalysis(db, realAnalysis({ id: shotId(0xa00) }), PERMIT_ID);
    expect(await getShotOutboxStatus(db, shotId(0xa00))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    const result = await drainOutbox(db, server);
    expect(result).toEqual({ synced: 1, failed: 2, remaining: 2 });
    expect(await hasShotSyncReceipt(db, shotId(0xa00))).toBe(true);
    // Re-pinned (S1): both corrupt rows are quarantined once (budget spent,
    // truthful last_error) rather than charged one attempt per drain.
    const rows = await outboxRows(db, OWNER);
    expect(rows.every(r => r.attempts === OUTBOX_MAX_ATTEMPTS)).toBe(true);
    expect(rows.every(r => r.last_error !== null)).toBe(true);
    expect(await drainOutbox(db, server)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 2,
    });
  });

  it('account switch after a drain started: the in-flight drain stays bound to its starting owner', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = acceptAllTransport();
    const server: SyncTransport = {
      ...inner,
      async syncShots(shots) {
        await gate;
        return inner.syncShots(shots);
      },
    };
    await saveAnalysis(db, realAnalysis({ id: shotId(0xb00) }), PERMIT_ID);
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [
        OTHER_OWNER,
        JSON.stringify({
          ...realAnalysis({ id: shotId(0xb01) }),
          analysisPermitId: PERMIT_ID,
        }),
      ],
    );

    const drain = drainOutbox(db, server);
    // Let the drain read its pages and reach the network, then switch.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    setActiveDataOwner(OTHER_OWNER);
    release!();
    const result = await drain;

    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    const offered = inner.syncCalls
      .flat()
      .map(s => String((s as { id: unknown }).id));
    expect(offered).toEqual([shotId(0xb00)]);
    // The receipt and the delete are OWNER's, never OTHER_OWNER's.
    setActiveDataOwner(OWNER);
    expect(await hasShotSyncReceipt(db, shotId(0xb00))).toBe(true);
    expect(await outboxRows(db, OWNER)).toHaveLength(0);
    setActiveDataOwner(OTHER_OWNER);
    expect(await hasShotSyncReceipt(db, shotId(0xb00))).toBe(false);
    expect(await outboxRows(db, OTHER_OWNER)).toHaveLength(1);
    await db.execute(`DELETE FROM outbox WHERE owner_key = ?`, [OTHER_OWNER]);
  });
});
