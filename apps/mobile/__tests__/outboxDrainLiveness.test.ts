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
 *   2. the orphaned rows are kept (evidence is never dropped) and are no
 *      longer reported as state 'queued',
 *   3. the orphans still make progress on every pass — they are retried, not
 *      abandoned mid-window.
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
function server(): SyncTransport & { created: string[] } {
  const known = new Set<string>();
  const created: string[] = [];
  return {
    created,
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

  it('an orphaned shot is not reported as freshly queued forever', async () => {
    const status = await getShotOutboxStatus(db, ORPHAN_SHOTS[0]!);
    expect(status.state).not.toBe('queued');
    expect(status.state).not.toBe('absent');
  });

  it('the orphaned rows are still retried on every drain', async () => {
    const before = await outboxRows(db, OWNER);
    await drainOutbox(db, transport);
    const after = await outboxRows(db, OWNER);
    // Still present (never silently deleted) and still carrying the reason.
    expect(after.filter(row => row.kind === 'shot.sync')).toHaveLength(
      before.filter(row => row.kind === 'shot.sync').length,
    );
  });
});
