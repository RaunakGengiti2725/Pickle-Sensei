/**
 * ADVERSARY fix round 8 / candidate B (d1c42d78) — claims 4, 5, 6, 7.
 *
 * A shot parked at the attempt cap is released under SESSION_RELEASED_MARKER
 * when its set is accepted: "offered once more under a set the server now
 * has, without its lifetime attempt count being touched" (sync.ts). The
 * marker is the ONLY thing that keeps an attempts=8 row visible to the shot
 * pass (`SHOT_PASS.budgetSql`). Every non-permanent bookkeeping write on the
 * row — a transport failure, a server-side transient rejection, a receipt
 * that could not be stored — goes through `recordRowFailure(..., false)`,
 * which REPLACES `last_error` with the error text. The marker is gone, the
 * count is 8, and the row is invisible to every later drain: a transient
 * failure has permanently exhausted a durable rating, which is exactly what
 * the module's own contract ("transient failures never consume [the
 * budget]") forbids.
 *
 * Real modules, real node:sqlite, real transport contract (ApiError 503 /
 * `shot.write_failed` are the codes the module itself labels transient).
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
  SESSION_RELEASED_MARKER,
  drainOutbox,
  isSessionReleasedMarker,
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
const SET = 'a8a8a8a8-0000-4000-8000-0000000000b1';

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
  await db.execute(`DELETE FROM outbox`);
  await db.execute(`DELETE FROM local_shot`);
  await db.execute(`DELETE FROM local_session`);
  await db.execute(`DELETE FROM sync_receipt`);
  await db.execute(`DELETE FROM sync_set_state`);
}

/** Accepts every set; refuses every shot `shot.session_not_found`. */
function acceptCreateRefuseShots(): SyncTransport & { offers: string[][] } {
  const offers: string[][] = [];
  return {
    offers,
    async createSession() {},
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

/**
 * The reachable pre-state: a read saved into set SET before the device knew
 * the set (no local_session row, no session.create row — the capture flow
 * was interrupted between the shot and its set), refused
 * `shot.session_not_found` OUTBOX_MAX_ATTEMPTS times → parked at the cap
 * (settleSessionNotFound case 4). Then the user saves a new read into the
 * set, which creates the set locally and queues its session.create.
 */
async function parkedAtCapThenSetSaved(
  db: LocalDb,
  parked: string,
  fresh: string,
): Promise<void> {
  await saveAnalysis(
    db,
    realAnalysis({ id: parked, sessionId: SET }),
    PERMIT_ID,
    {},
  );
  const refusing = acceptCreateRefuseShots();
  for (let d = 0; d < OUTBOX_MAX_ATTEMPTS; d += 1) {
    await drainOutbox(db, refusing);
  }
  expect(refusing.offers).toHaveLength(OUTBOX_MAX_ATTEMPTS);
  expect(await getShotOutboxStatus(db, parked)).toMatchObject({
    state: 'orphaned',
    attempts: OUTBOX_MAX_ATTEMPTS,
  });
  await saveAnalysis(
    db,
    realAnalysis({ id: fresh, sessionId: SET }),
    PERMIT_ID,
    { session: setInput(SET) },
  );
}

describe('attack-fix8-b R1 — a released-at-cap shot is exhausted by any transient failure (claims 4/5/6/7)', () => {
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

  it('R1.1 BREAK — set accepted, then the network drops before the shot request: the released shot is exhausted for good and never offered again', async () => {
    const parked = shotId(0xb101);
    const fresh = shotId(0xb102);
    await parkedAtCapThenSetSaved(db, parked, fresh);

    // The drain that lands the set. The connection drops between the two
    // requests: createSession is accepted, syncShots never reaches the
    // server (the transport's own typed timeout / 5xx — transient by the
    // module's definition, isPermanentSyncFailure === false).
    const offered: string[][] = [];
    const cutAfterCreate: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offered.push(shots.map(s => String((s as { id: unknown }).id)));
        throw new ApiError(503, 'server.unavailable', 'upstream timeout');
      },
    };
    const cut = await drainOutbox(db, cutAfterCreate);
    expect(cut.synced).toBe(1); // the session.create
    // The released shot WAS in the batch that never reached the server.
    expect(offered).toEqual([expect.arrayContaining([parked, fresh])]);

    const rows = await outboxRows(db, OWNER);
    const parkedRow = rows.find(r => r.kind === 'shot.sync' && r.attempts >= 8);
    expect(parkedRow).toBeDefined();
    // EXPECTED (claim 4 "unpark keeps attempts monotone", module contract
    // "transient failures never consume the budget"): the row is still
    // deliverable — it still carries the released marker (or is parked
    // again), so the next drain offers it once the network is back.
    // OBSERVED: recordRowFailure(..., false) replaced the marker with the
    // transport error; attempts=8 with neither marker is invisible to the
    // shot pass forever → getShotOutboxStatus = exhausted.
    expect({
      status: await getShotOutboxStatus(db, parked),
      last_error: parkedRow!.last_error,
    }).toMatchObject({
      status: { state: expect.stringMatching(/^(queued|orphaned)$/) },
      last_error: expect.stringContaining(`${SESSION_RELEASED_MARKER}:`),
    });

    // The network is back and the server accepts everything: the released
    // read must be delivered. It is not — it is never offered again.
    const accepting = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, accepting);
    expect(
      accepting.syncCalls.flat().map(s => String((s as { id: unknown }).id)),
    ).toContain(parked);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.2 BREAK — set accepted, shot accepted, receipt write fails: the released shot is exhausted; the server holds the read, the device says it was refused', async () => {
    const parked = shotId(0xb201);
    const fresh = shotId(0xb202);
    await parkedAtCapThenSetSaved(db, parked, fresh);

    const transport = acceptAllTransport();
    const failReceiptForParked: LocalDb = {
      async execute(sql, params) {
        if (
          sql.includes('INSERT OR REPLACE INTO sync_receipt') &&
          params?.[1] === parked
        ) {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };
    await drainOutbox(failReceiptForParked, transport);
    // The server accepted the parked read in this drain.
    expect(
      transport.syncCalls.flat().map(s => String((s as { id: unknown }).id)),
    ).toContain(parked);
    expect(await hasShotSyncReceipt(db, parked)).toBe(false);

    const status = await getShotOutboxStatus(db, parked);
    // EXPECTED (claim 5): "the row keeps its attempt count ... offered again
    // by the next drain, and apply_synced_shot accepts a replayed id" — the
    // row must still be `queued`/`orphaned`, i.e. visible to the next drain.
    // OBSERVED: attempts=8 and last_error='shot.receipt_not_saved: …'
    // (marker overwritten) → `exhausted`; ResultScreen renders "Sync was
    // refused 8 times and this read will not be sent again (last response:
    // shot.receipt_not_saved: The server accepted this read …)".
    expect(status).toMatchObject({
      state: expect.stringMatching(/^(queued|orphaned)$/),
    });

    // The disk is fine again; the next drains must replay the id and land the
    // receipt. They never see the row.
    const healthy = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, healthy);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.3 BREAK — set accepted, server answers the released shot with its own transient code (`shot.write_failed`): the shot is exhausted', async () => {
    const parked = shotId(0xb301);
    const fresh = shotId(0xb302);
    await parkedAtCapThenSetSaved(db, parked, fresh);

    const writeFailedOnce: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        const ids = shots.map(s => String((s as { id: unknown }).id));
        return {
          acceptedIds: ids.filter(id => id !== parked),
          rejected: ids
            .filter(id => id === parked)
            .map(id => ({
              id,
              code: 'shot.write_failed',
              message: 'The server could not write this shot; retry.',
            })),
        };
      },
    };
    await drainOutbox(db, writeFailedOnce);
    const status = await getShotOutboxStatus(db, parked);
    // EXPECTED: `shot.write_failed` is in TRANSIENT_SYNC_REJECTION_CODES —
    // "they record the reason but keep the row's attempt budget intact". A
    // row whose budget is intact is offered again.
    // OBSERVED: `exhausted`, attempts 8, and no later drain offers it.
    expect(status).toMatchObject({
      state: expect.stringMatching(/^(queued|orphaned)$/),
    });
    const healthy = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, healthy);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.4 BREAK — UploadQueueStatus counts a released (queued for one more offer) row as `exhausted` / needs_attention', async () => {
    const parked = shotId(0xb401);
    const fresh = shotId(0xb402);
    await parkedAtCapThenSetSaved(db, parked, fresh);
    // The drain that lands the set is interrupted after the session pass:
    // the app is killed / the connection drops before the shot request. The
    // durable state left behind is the released marker on the parked row.
    const cutAfterCreate: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots() {
        throw new ApiError(503, 'server.unavailable', 'upstream timeout');
      },
    };
    // Reproduce the exact durable row the session pass leaves (the shot pass
    // of the same drain would immediately overwrite it — R1.1): read it back
    // from a db facade that records the row after the retire transaction.
    let releasedSnapshot: {
      attempts: number;
      last_error: string | null;
    } | null = null;
    const observing: LocalDb = {
      async execute(sql, params) {
        const result = await db.execute(sql, params);
        if (sql.trim().startsWith('COMMIT') && releasedSnapshot === null) {
          const { rows } = await db.execute(
            `SELECT attempts, last_error FROM outbox
             WHERE owner_key = ? AND kind = 'shot.sync'
               AND json_extract(payload, '$.id') = ?`,
            [OWNER, parked],
          );
          if (
            rows[0] &&
            isSessionReleasedMarker(String(rows[0]['last_error'] ?? ''))
          ) {
            releasedSnapshot = {
              attempts: Number(rows[0]['attempts']),
              last_error: String(rows[0]['last_error']),
            };
          }
        }
        return result;
      },
      close: () => db.close(),
    };
    await drainOutbox(observing, cutAfterCreate);
    expect(releasedSnapshot).not.toBeNull();
    const snap = releasedSnapshot!;
    expect(snap.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(snap.last_error).toContain(`${SESSION_RELEASED_MARKER}:`);

    // getShotOutboxStatus calls that row `queued` (ResultScreen: "still in
    // the secure outbox"); the queue status must agree (claim 6: parked /
    // deliverable rows are never `exhausted`).
    const queue = deriveUploadQueueStatus([
      {
        kind: 'shot.sync',
        attempts: snap.attempts,
        lastError: snap.last_error,
      },
      { kind: 'shot.sync', attempts: 0, lastError: null },
    ]);
    // EXPECTED: { state: 'queued', pending: 2 }.
    // OBSERVED: { state: 'needs_attention', pending: 1, exhausted: 1 }.
    expect(queue).toEqual({ state: 'queued', pending: 2 });
  });
});
