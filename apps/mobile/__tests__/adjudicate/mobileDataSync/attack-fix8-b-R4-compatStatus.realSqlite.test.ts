/**
 * PORT of round-8 candidate B's adversary R4 (cb1fe96a) to candidate A's
 * durable columns: upgrade/compat (LOCAL_MIGRATIONS on a pre-account store)
 * and status truthfulness (UploadQueueStatus vs getShotOutboxStatus vs the
 * drain's actual offer set).
 *
 * The compat store is seeded BEFORE the first `getDb()` at the pre-account
 * schema (no owner_key, no sync_receipt, no refusals, no rearms) with the
 * durable rows the d29b95f5-era build leaves behind. Structural differences
 * recorded, not hidden: B's store had a `sync_set_state` table (asserted
 * empty after the upgrade) — here the equivalent invariant is that every
 * migrated `local_session` row starts with `rearms = 0`; B's
 * `shot.session_released` marker does not exist on this base (a release is
 * `attempts = 0, last_error = NULL`; the row's lifetime `refusals` keep the
 * count), so the "released" rows are seeded in that shape and the truth
 * assertion is `exhausted + quarantined == rows the drain will never offer
 * again` (quarantined rows are their own bucket here). Real modules, real
 * node:sqlite.
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
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import { deriveUploadQueueStatus } from '../../../src/data/offlineCapabilities';
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
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const LEGACY_SET = 'a8a8a8a8-0000-4000-8000-0000000000c4';

function setInput(id: string): SessionInput {
  return {
    id,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-08-26T18:00:00.000Z',
  };
}

function shotPayload(id: string, sessionId: string | null = null): string {
  return JSON.stringify({
    id,
    sessionId,
    analysisPermitId: PERMIT_ID,
    source: 'real',
    shotType: 'forehand_drive',
    capturedAt: '2026-08-26T18:00:00.000Z',
    overallScore: 61,
    confidence: 0.9,
    resultKind: 'scored',
    checkpoints: [],
  });
}

const LEGACY = {
  healthy: shotId(0xd401),
  retrying: shotId(0xd402),
  exhaustedOld: shotId(0xd403),
  parkedInSet: shotId(0xd404),
  releasedInSet: shotId(0xd405),
};

function seedLegacyStore(): void {
  const seed = (sql: string, params: unknown[] = []) =>
    mockSqlite.seed(sql, params);
  seed(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  seed(`CREATE TABLE local_shot (
     id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
     result_kind TEXT NOT NULL, source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
  seed(`CREATE TABLE local_session (
     id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT,
     focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`);
  seed(`CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
     payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`);
  seed(
    `INSERT INTO local_session (id, mode, shot_type, started_at) VALUES (?, 'practice_set', 'forehand_drive', '2026-08-26T18:00:00.000Z')`,
    [LEGACY_SET],
  );
  const row = (
    kind: string,
    payload: string,
    attempts: number,
    lastError: string | null,
  ) =>
    seed(
      `INSERT INTO outbox (kind, payload, attempts, last_error) VALUES (?, ?, ?, ?)`,
      [kind, payload, attempts, lastError],
    );
  // d29b95f5-era rows
  row('shot.sync', shotPayload(LEGACY.healthy), 0, null);
  row('shot.sync', shotPayload(LEGACY.retrying), 3, 'HTTP 503 upstream');
  row(
    'shot.sync',
    shotPayload(LEGACY.exhaustedOld),
    OUTBOX_MAX_ATTEMPTS,
    `${SESSION_NOT_FOUND_REJECTION}: Session not found for this shot.`,
  );
  row('shot.sync', 'null', 0, null);
  row('shot.sync', '{"id":', 2, 'SyntaxError: Unexpected end of JSON input');
  row('shot.sync', '{"id":7}', 0, null);
  row('session.create', 'null', 0, null);
  // A parked set (create exhausted) with a parked shot, a shot the previous
  // build had already released (attempts 0, no verdict) and a fresh one.
  row(
    'session.create',
    JSON.stringify({ id: LEGACY_SET, mode: 'practice_set' }),
    OUTBOX_MAX_ATTEMPTS,
    'ApiError 503 server.unavailable',
  );
  row(
    'shot.sync',
    shotPayload(LEGACY.parkedInSet, LEGACY_SET),
    OUTBOX_MAX_ATTEMPTS,
    `${SESSION_ORPHANED_VERDICT}: parked behind set`,
  );
  row('shot.sync', shotPayload(LEGACY.releasedInSet, LEGACY_SET), 0, null);
  row('shot.sync', shotPayload(shotId(0xd406), LEGACY_SET), 0, null);
}

describe('attack-fix8-b R4 (ported) — pre-fix store upgrade + status truthfulness', () => {
  let db: LocalDb;

  beforeAll(() => {
    seedLegacyStore();
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('C1 — LOCAL_MIGRATIONS run on the legacy store (twice, idempotent); every legacy row lands in the guest bucket intact', async () => {
    expect(() => {
      db = getDb();
    }).not.toThrow();
    setActiveDataOwner(GUEST_DATA_OWNER);
    const first = await outboxRows(db, GUEST_DATA_OWNER);
    expect(first).toHaveLength(11);
    const state = await db.execute(
      `SELECT count(*) AS n FROM local_session WHERE rearms <> 0`,
    );
    expect(Number(state.rows[0]!['n'])).toBe(0);
    const refusals = await db.execute(
      `SELECT count(*) AS n FROM outbox WHERE refusals <> 0`,
    );
    expect(Number(refusals.rows[0]!['n'])).toBe(0);
    db.close();
    expect(() => {
      db = getDb();
    }).not.toThrow();
    const second = await outboxRows(db, GUEST_DATA_OWNER);
    expect(second).toEqual(first);
  });

  it('C2 — first drain on the upgraded store: no throw, legacy healthy/retrying rows accepted, malformed rows quarantined, nothing healthy charged', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const accepting = acceptAllTransport();
    const result = await drainOutbox(db, accepting);
    console.log(
      'attack-fix8-b C2 drain 1',
      result,
      await outboxRows(db, GUEST_DATA_OWNER),
    );
    expect(await hasShotSyncReceipt(db, LEGACY.healthy)).toBe(true);
    expect(await hasShotSyncReceipt(db, LEGACY.retrying)).toBe(true);
    // The legacy parked set (create exhausted by a build that recorded no
    // refusals, local_session exists) is NOT re-armed by a drain — only a
    // new read saved into it re-arms (the parked copy says exactly that).
    const second = await drainOutbox(db, accepting);
    expect(second).toEqual({ synced: 0, failed: 0, remaining: 9 });
    expect(accepting.sessions).toHaveLength(0);
    const parkedStatus = await getShotOutboxStatus(db, LEGACY.parkedInSet);
    expect(parkedStatus).toMatchObject({
      state: 'orphaned',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    // Save a new read into the legacy set → rearmExhaustedSessionCreate →
    // one create, all three parked shots released and accepted.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xd407), sessionId: LEGACY_SET }),
      PERMIT_ID,
      { session: setInput(LEGACY_SET) },
    );
    const third = await drainOutbox(db, accepting);
    console.log('attack-fix8-b C2 drain 3', third, {
      creates: accepting.sessions.length,
      rearms: (
        await db.execute(
          `SELECT owner_key, rearms FROM local_session WHERE id = ?`,
          [LEGACY_SET],
        )
      ).rows,
    });
    expect(accepting.sessions).toHaveLength(1);
    expect(await hasShotSyncReceipt(db, shotId(0xd407))).toBe(true);
    expect(await hasShotSyncReceipt(db, LEGACY.parkedInSet)).toBe(true);
    expect(await hasShotSyncReceipt(db, LEGACY.releasedInSet)).toBe(true);
    expect(await hasShotSyncReceipt(db, shotId(0xd406))).toBe(true);
    const left = await outboxRows(db, GUEST_DATA_OWNER);
    console.log('attack-fix8-b C2 rows left', left);
    const quarantined = left.filter(
      r => r.attempts >= OUTBOX_MAX_ATTEMPTS && r.kind === 'shot.sync',
    );
    // 3 malformed shot rows + the d29b95f5 exhausted row.
    expect(quarantined).toHaveLength(4);
    for (const r of left) expect(r.last_error).toBeTruthy();
    const createLeft = left.filter(r => r.kind === 'session.create');
    // malformed 'null' create quarantined; the set's own create retired.
    expect(createLeft).toHaveLength(1);
    expect(createLeft[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it('C3 — legacy exhausted row copy after upgrade is truthful: exhausted, never re-offered', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const status = await getShotOutboxStatus(db, LEGACY.exhaustedOld);
    expect(status).toMatchObject({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    const accepting = acceptAllTransport();
    await drainOutbox(db, accepting);
    expect(accepting.syncCalls).toHaveLength(0);
  });

  it('S1 — status matrix vs SQL truth: the rows UploadQueueStatus reports as finished (exhausted + quarantined) are exactly the rows the drain will never offer again', async () => {
    setActiveDataOwner(OWNER);
    for (const t of ['outbox', 'local_shot', 'local_session', 'sync_receipt'])
      await db.execute(`DELETE FROM ${t}`);
    const SET = 'a8a8a8a8-0000-4000-8000-0000000000c5';
    // Durable states, produced by the real modules where a path exists.
    const queued = shotId(0xd501);
    await saveAnalysis(db, realAnalysis({ id: queued }), PERMIT_ID, {});
    const retrying = shotId(0xd502);
    await saveAnalysis(db, realAnalysis({ id: retrying }), PERMIT_ID, {});
    const parked = shotId(0xd503);
    await saveAnalysis(
      db,
      realAnalysis({ id: parked, sessionId: SET }),
      PERMIT_ID,
      {},
    );
    const capped = shotId(0xd504);
    await saveAnalysis(db, realAnalysis({ id: capped }), PERMIT_ID, {});
    const released = shotId(0xd505);
    await saveAnalysis(
      db,
      realAnalysis({ id: released, sessionId: SET }),
      PERMIT_ID,
      {},
    );
    await db.execute(
      `UPDATE outbox SET attempts = 3, last_error = 'ApiError 503 server.unavailable'
       WHERE json_extract(payload,'$.id') = ?`,
      [retrying],
    );
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = ?
       WHERE json_extract(payload,'$.id') = ?`,
      [OUTBOX_MAX_ATTEMPTS, `${SESSION_ORPHANED_VERDICT}: parked`, parked],
    );
    await db.execute(
      `UPDATE outbox SET attempts = ?, last_error = 'shot.invalid: refused for good'
       WHERE json_extract(payload,'$.id') = ?`,
      [OUTBOX_MAX_ATTEMPTS, capped],
    );
    // A released row on this base: fresh attempt budget, no verdict, its
    // lifetime refusals intact.
    await db.execute(
      `UPDATE outbox SET attempts = 0, refusals = ?, last_error = NULL
       WHERE json_extract(payload,'$.id') = ?`,
      [OUTBOX_MAX_ATTEMPTS, released],
    );
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload, created_at, attempts, last_error)
       VALUES (?, 'shot.sync', 'null', datetime('now'), ?, 'shot.payload_invalid: null')`,
      [OWNER, OUTBOX_MAX_ATTEMPTS],
    );
    // Make the set live so the parked shot has a set to be released under.
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0xd506), sessionId: SET }),
      PERMIT_ID,
      { session: setInput(SET) },
    );

    const rows = await outboxRows(db, OWNER);
    const shotRows = rows.filter(r => r.kind === 'shot.sync');
    const queue = deriveUploadQueueStatus(
      rows.map(r => ({
        kind: r.kind,
        attempts: r.attempts,
        lastError: r.last_error,
      })),
    );
    const perShot = new Map<string, string>();
    for (const id of [
      queued,
      retrying,
      parked,
      capped,
      released,
      shotId(0xd506),
    ]) {
      perShot.set(id, (await getShotOutboxStatus(db, id)).state);
    }
    // SQL truth: which shot rows does an accepting drain offer?
    const accepting = acceptAllTransport();
    const offered = new Set<string>();
    const recording: SyncTransport = {
      ...accepting,
      async syncShots(shots) {
        for (const s of shots) offered.add(String((s as { id: unknown }).id));
        return { acceptedIds: [], rejected: [] };
      },
    };
    await drainOutbox(db, recording);
    const truth = {
      shotRows: shotRows.length,
      offered: offered.size,
      neverOfferedBySql: shotRows.length - offered.size,
    };
    console.log('attack-fix8-b S1 (ported)', {
      queue,
      perShot: [...perShot],
      truth,
    });
    // The rows the drain will never offer again are the capped row and the
    // quarantined `null` row (2); released and parked rows are pending (the
    // parked one is released by the set's accepted create in this drain).
    expect(truth.neverOfferedBySql).toBe(2);
    expect(perShot.get(released)).toBe('queued');
    expect(offered.has(released)).toBe(true);
    expect(offered.has(parked)).toBe(true);
    expect(offered.has(capped)).toBe(false);
    expect(perShot.get(capped)).toBe('exhausted');
    if (queue.state !== 'needs_attention') {
      throw new Error(`queue is ${queue.state}, expected needs_attention`);
    }
    // `quarantined` is this base's own bucket for rows the server never saw.
    const finished =
      queue.exhausted + ((queue as { quarantined?: number }).quarantined ?? 0);
    expect(finished).toBe(truth.neverOfferedBySql);
    expect(queue.pending).toBe(rows.length - truth.neverOfferedBySql);
  });
});
