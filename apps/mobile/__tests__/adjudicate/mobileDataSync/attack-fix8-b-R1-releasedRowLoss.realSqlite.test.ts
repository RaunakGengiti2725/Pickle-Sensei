/**
 * PORT of round-8 candidate B's adversary R1 (cb1fe96a) to candidate A's
 * durable columns (`local_session.rearms`, `outbox.refusals`).
 *
 * Candidate B released a parked-at-cap shot under a `shot.session_released`
 * marker in `last_error`; on this base the release is `attempts = 0,
 * last_error = NULL` (retireAcceptedSessionCreate) while the lifetime
 * `refusals` column keeps counting. The behavioural invariant is the same and
 * is what every assertion below pins: once its set is accepted, a shot that
 * was parked at the attempt cap is DELIVERABLE again, and no non-final
 * outcome — a transport failure, the server's own transient
 * `shot.write_failed`, a receipt store that fails after an accepted write —
 * may turn that release into a silent exhaustion. The row stays visible to
 * the shot pass and lands as soon as the next healthy drain runs (the server
 * upsert is idempotent, so a replayed accepted id is safe).
 *
 * The one structural difference (recorded, not hidden): B asserted the raw
 * marker text in `last_error`; here the equivalent SQL truth is
 * `attempts < OUTBOX_MAX_ATTEMPTS` (the row is under budget) together with a
 * status that is `queued`/`rejected` (retrying) and never `exhausted`.
 *
 * Real modules, real node:sqlite.
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
}

function idsOf(shots: unknown[]): string[] {
  return shots.map(s => String((s as { id: unknown }).id));
}

/** Accepts every set; refuses every shot `shot.session_not_found`. */
function acceptCreateRefuseShots(): SyncTransport & { offers: string[][] } {
  const offers: string[][] = [];
  return {
    offers,
    async createSession() {},
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = idsOf(shots);
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

/** The row of `id` as SQL sees it. */
async function shotRow(
  db: LocalDb,
  id: string,
): Promise<{ attempts: number; refusals: number; last_error: string | null }> {
  const { rows } = await db.execute(
    `SELECT attempts, refusals, last_error FROM outbox
     WHERE owner_key = ? AND kind = 'shot.sync'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END = ?`,
    [OWNER, id],
  );
  const row = rows[0];
  if (!row) throw new Error(`row for ${id} vanished`);
  return {
    attempts: Number(row['attempts']),
    refusals: Number(row['refusals']),
    last_error: row['last_error'] === null ? null : String(row['last_error']),
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

describe('attack-fix8-b R1 (ported) — a released-at-cap shot survives every non-final outcome', () => {
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

  it('R1.1 — set accepted, then the network drops before the shot request: the released shot stays deliverable and lands on the next healthy drain', async () => {
    const parked = shotId(0xb101);
    const fresh = shotId(0xb102);
    await parkedAtCapThenSetSaved(db, parked, fresh);

    const offered: string[][] = [];
    const cutAfterCreate: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        offered.push(idsOf(shots));
        throw new ApiError(503, 'server.unavailable', 'upstream timeout');
      },
    };
    const cut = await drainOutbox(db, cutAfterCreate);
    expect(cut.synced).toBe(1); // the session.create
    // The released shot WAS in the batch that never reached the server.
    expect(offered).toEqual([expect.arrayContaining([parked, fresh])]);

    // SQL truth: under budget (the release gave it a fresh attempt budget and
    // a transient failure spends none of it), lifetime refusals untouched.
    const row = await shotRow(db, parked);
    expect(row.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
    expect(row.refusals).toBe(OUTBOX_MAX_ATTEMPTS);
    const status = await getShotOutboxStatus(db, parked);
    expect(status.state).toMatch(/^(queued|rejected)$/);

    const accepting = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, accepting);
    expect(idsOf(accepting.syncCalls.flat())).toContain(parked);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.2 — set accepted, shot accepted, receipt write fails: the released shot is replayed (idempotent) on the next drain, never exhausted', async () => {
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
    expect(idsOf(transport.syncCalls.flat())).toContain(parked);
    expect(await hasShotSyncReceipt(db, parked)).toBe(false);

    const row = await shotRow(db, parked);
    expect(row.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
    const status = await getShotOutboxStatus(db, parked);
    expect(status.state).toMatch(/^(queued|rejected)$/);

    const healthy = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, healthy);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.3 — set accepted, server answers the released shot with its own transient code (`shot.write_failed`): budget intact, delivered later', async () => {
    const parked = shotId(0xb301);
    const fresh = shotId(0xb302);
    await parkedAtCapThenSetSaved(db, parked, fresh);

    const writeFailedOnce: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots(shots) {
        const ids = idsOf(shots);
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
    const row = await shotRow(db, parked);
    expect(row.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
    // `shot.write_failed` is the server's own transient verdict: not a
    // refusal, so the lifetime count does not move either.
    expect(row.refusals).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await getShotOutboxStatus(db, parked)).state).toMatch(
      /^(queued|rejected)$/,
    );
    const healthy = acceptAllTransport();
    for (let d = 0; d < 5; d += 1) await drainOutbox(db, healthy);
    expect(await hasShotSyncReceipt(db, parked)).toBe(true);
  });

  it('R1.4 — UploadQueueStatus never counts a released (deliverable) row as exhausted / needs_attention', async () => {
    const parked = shotId(0xb401);
    const fresh = shotId(0xb402);
    await parkedAtCapThenSetSaved(db, parked, fresh);
    // The drain that lands the set is interrupted after the session pass:
    // the app is killed / the connection drops before the shot request. The
    // durable state left behind is the released row.
    const cutAfterCreate: SyncTransport = {
      async createSession() {},
      async finalizeSession() {},
      async syncShots() {
        throw new ApiError(503, 'server.unavailable', 'upstream timeout');
      },
    };
    // Snapshot the released row right after the retire transaction commits
    // (the shot pass of the same drain records the transport error on it
    // moments later).
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
          if (rows[0] && Number(rows[0]['attempts']) < OUTBOX_MAX_ATTEMPTS) {
            releasedSnapshot = {
              attempts: Number(rows[0]['attempts']),
              last_error:
                rows[0]['last_error'] === null
                  ? null
                  : String(rows[0]['last_error']),
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
    expect(snap.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);

    const queue = deriveUploadQueueStatus([
      {
        kind: 'shot.sync',
        attempts: snap.attempts,
        lastError: snap.last_error,
      },
      { kind: 'shot.sync', attempts: 0, lastError: null },
    ]);
    expect(queue).toEqual({ state: 'queued', pending: 2 });

    // And the same for the row as it is AFTER the transport failure landed
    // on it: still pending, never needs_attention.
    const rows = await outboxRows(db, OWNER);
    const after = deriveUploadQueueStatus(
      rows.map(r => ({
        kind: r.kind,
        attempts: r.attempts,
        lastError: r.last_error,
      })),
    );
    expect(after).toEqual({ state: 'queued', pending: rows.length });
  });
});
