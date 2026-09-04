/**
 * MDS-3 regression: the outbox drain must stay LIVE — a brand-new practice
 * set has to reach the server no matter how many older rows are parked in the
 * queue, and a shot whose parent `session.create` can never succeed must stop
 * describing itself as freshly queued.
 *
 * `drainOutbox()` used to take ONE window (`ORDER BY id ASC LIMIT 50`,
 * attempts < 8) and only then split it by kind. `shot.session_not_found` is
 * transient by design (a momentary ordering artifact must not burn a rating's
 * retry budget), so 50 orphaned shots stayed eligible forever, held the whole
 * window, and every newer row — including the next set's `session.create` —
 * was never selected again.
 *
 * Contract asserted here, against real SQLite:
 *   1. with 50 permanently-orphaned shots queued, a newer session.create and
 *      its shot still sync within a bounded number of drains,
 *   2. the orphaned rows are kept (evidence is never dropped), are reported
 *      as 'exhausted' — the terminal state of their parent — and are no
 *      longer sent on every pass,
 *   3. rows the server keeps refusing with a TRANSIENT code (budget kept) do
 *      not hold the head of the window either: a newer rating queued behind
 *      60 of them is sent within ceil(61 / 50) + 1 drains.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/outboxDrainLiveness.test.ts
 */
import { createRealSqliteModule } from '../test-support/realSqlite';

const mockSqlite = createRealSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import type { LocalDb } from '../src/data/db';
import { getDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { ApiError } from '../src/data/api';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  sessionId,
  shotId,
} from '../test-support/localDataFixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const DEAD_SESSION = sessionId(0xdead);
const NEW_SESSION = sessionId(0xbeef);
const NEW_SHOT = shotId(0x900);
const ORPHAN_SHOTS = Array.from({ length: 50 }, (_, i) => shotId(0x100 + i));

/** Server that refuses one session id for good (409 is a contract verdict, so
 * that row spends its budget and leaves the window) and rejects every shot
 * whose session it has never seen with the transient session-not-found code. */
function server(): SyncTransport & { created: string[]; posted: string[][] } {
  const known = new Set<string>();
  const created: string[] = [];
  const posted: string[][] = [];
  return {
    created,
    posted,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      if (id === DEAD_SESSION) {
        throw new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );
      }
      known.add(id);
      created.push(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      posted.push(shots.map(raw => (raw as { id: string }).id));
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
}

/** Mirrors AnalyzeScreen: the scored shot is saved first, then
 * commitPracticeSet() writes the session.create row behind it. */
async function practiceSet(
  db: LocalDb,
  session: string,
  shots: string[],
): Promise<void> {
  for (const [index, id] of shots.entries()) {
    await saveAnalysis(db, realAnalysis({ id, sessionId: session }), PERMIT_ID);
    if (index === 0) {
      await saveSession(db, {
        id: session,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      });
    }
  }
}

describe('outbox drain stays live under orphaned rows (real SQLite)', () => {
  const transport = server();
  let db: LocalDb;

  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await practiceSet(db, DEAD_SESSION, ORPHAN_SHOTS);
    // Days of drains: the session.create row spends its budget and drops out
    // of every future window; its 50 shots keep being refused.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i++) {
      await drainOutbox(db, transport);
    }
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('precondition: the orphaned set fills the window and nothing was dropped', async () => {
    const rows = await outboxRows(db, OWNER);
    const creates = rows.filter(row => row.kind === 'session.create');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.attempts).toBeGreaterThanOrEqual(OUTBOX_MAX_ATTEMPTS);
    const orphans = rows.filter(row => row.kind === 'shot.sync');
    expect(orphans).toHaveLength(ORPHAN_SHOTS.length);
    expect(
      orphans.every(row =>
        String(row.lastError).includes(SESSION_NOT_FOUND_REJECTION),
      ),
    ).toBe(true);
  });

  it('a brand-new practice set still reaches the server within a bounded number of drains', async () => {
    await practiceSet(db, NEW_SESSION, [NEW_SHOT]);
    for (let i = 0; i < 3; i++) {
      await drainOutbox(db, transport);
    }
    expect(transport.created).toContain(NEW_SESSION);
    expect(await hasShotSyncReceipt(db, NEW_SHOT)).toBe(true);
  });

  it('an orphaned shot reports the terminal state of its practice set, not "queued"', async () => {
    // The verdict reported is the practice set's own: how often its creation
    // was refused and the server's last response to it.
    const status = await getShotOutboxStatus(db, ORPHAN_SHOTS[0]!);
    expect(status).toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: expect.stringContaining('Session id belongs to another user.'),
    });
  });

  it('the orphaned rows are kept as evidence but no longer sent on every pass', async () => {
    const before = await outboxRows(db, OWNER);
    const postsBefore = transport.posted.length;
    await drainOutbox(db, transport);
    const after = await outboxRows(db, OWNER);
    // Still present (never silently deleted) and still carrying the reason.
    const orphansAfter = after.filter(row => row.kind === 'shot.sync');
    expect(orphansAfter).toHaveLength(
      before.filter(row => row.kind === 'shot.sync').length,
    );
    expect(
      orphansAfter.every(row =>
        String(row.lastError).includes(SESSION_NOT_FOUND_REJECTION),
      ),
    ).toBe(true);
    const sentSince = transport.posted.slice(postsBefore).flat();
    expect(sentSince.filter(id => ORPHAN_SHOTS.includes(id))).toEqual([]);
  });
});

const STUCK_SHOTS = Array.from({ length: 60 }, (_, i) => shotId(0x300 + i));
const LATE_SHOT = shotId(0x3ff);

/** Server whose own shot write keeps failing for 60 ratings (a transient,
 * server-declared verdict that keeps the attempt budget) and accepts
 * everything else. */
function writeFailingServer(): SyncTransport & { posted: string[][] } {
  const posted: string[][] = [];
  return {
    posted,
    async createSession() {},
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(raw => (raw as { id: string }).id);
      posted.push(ids);
      return {
        acceptedIds: ids.filter(id => !STUCK_SHOTS.includes(id)),
        rejected: ids
          .filter(id => STUCK_SHOTS.includes(id))
          .map(id => ({
            id,
            code: 'shot.write_failed',
            message: 'Could not write the shot.',
          })),
      };
    },
  };
}

describe('outbox drain rotates through transiently refused rows (real SQLite)', () => {
  const transport = writeFailingServer();
  let db: LocalDb;

  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    for (const id of STUCK_SHOTS) {
      await saveAnalysis(db, realAnalysis({ id, sessionId: null }), PERMIT_ID);
    }
    // Every stuck row has been refused at least once before the new rating
    // arrives, so none of them is "never tried" any more.
    await drainOutbox(db, transport);
    await drainOutbox(db, transport);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('60 refused rows all keep their budget and all get tried', async () => {
    const rows = await outboxRows(db, OWNER);
    const stuck = rows.filter(row => row.kind === 'shot.sync');
    expect(stuck).toHaveLength(STUCK_SHOTS.length);
    expect(stuck.every(row => row.attempts === 0)).toBe(true);
    expect(
      stuck.every(row => String(row.lastError).includes('shot.write_failed')),
    ).toBe(true);
  });

  it('a rating queued behind 60 refused rows is sent within a bounded number of drains, even after it was refused once itself', async () => {
    await saveAnalysis(
      db,
      realAnalysis({ id: LATE_SHOT, sessionId: null }),
      PERMIT_ID,
    );
    // First pass: the late rating has never been tried, so it goes first.
    await drainOutbox(db, transport);
    expect(await hasShotSyncReceipt(db, LATE_SHOT)).toBe(true);

    // A second late rating that the server refuses ONCE (transient) must not
    // fall behind the 60 stuck rows for good: it is next in line within
    // ceil(61 / 50) passes.
    const flaky = shotId(0x3fe);
    STUCK_SHOTS.push(flaky);
    await saveAnalysis(
      db,
      realAnalysis({ id: flaky, sessionId: null }),
      PERMIT_ID,
    );
    await drainOutbox(db, transport);
    expect(transport.posted.at(-1)).toContain(flaky);
    STUCK_SHOTS.pop();
    let sent = false;
    for (let i = 0; i < 2 && !sent; i++) {
      await drainOutbox(db, transport);
      sent = transport.posted.at(-1)!.includes(flaky);
    }
    expect(sent).toBe(true);
    expect(await hasShotSyncReceipt(db, flaky)).toBe(true);
  });

  it('every refused row is sent at least once every two passes', async () => {
    const window = transport.posted.slice(-2).flat();
    for (const id of STUCK_SHOTS) {
      expect(window).toContain(id);
    }
  });
});
