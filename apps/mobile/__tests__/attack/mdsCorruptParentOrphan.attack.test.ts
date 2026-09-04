/**
 * ADVERSARIAL TEST (expected to FAIL on ca8a3407) — MDS-3 variant.
 *
 * The candidate's "exhausted parent" rule (sync.ts SHOT_SESSION_EXHAUSTED_SQL,
 * repository.ts getShotOutboxStatus) only recognises a parent whose payload
 * is valid JSON: `... parent.attempts >= 8 AND json_valid(parent.payload)`.
 * A session.create row whose payload is corrupt is exhausted BY the drain
 * itself (JSON.parse fails → permanent → attempts reaches 8 in 8 passes), yet
 * its shots are never matched by that rule:
 *   - the drain keeps posting them every pass (server answers
 *     shot.session_not_found, transient), and
 *   - getShotOutboxStatus keeps reporting `queued`, attempts 0 — the exact
 *     "orphan stays queued for good" state MDS-3 set out to end.
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *      __tests__/attack/mdsCorruptParentOrphan.attack.test.ts --ci
 */
import { createRealSqliteModule } from '../../test-support/realSqlite';

const mockSqlite = createRealSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import { getDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  getShotOutboxStatus,
  saveAnalysis,
  saveSession,
} from '../../src/data/repository';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  sessionId,
  shotId,
} from '../../test-support/localDataFixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

/** Server that has never seen any session: every shot is an orphan. */
function orphanRejectingServer() {
  const posted: string[][] = [];
  const transport: SyncTransport = {
    async createSession() {},
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(raw => String((raw as { id: unknown }).id));
      posted.push(ids);
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
  return { transport, posted };
}

afterEach(() => {
  try {
    getDb().close();
  } catch {
    // already closed
  }
  mockSqlite.reset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('MDS-3 variant: parent session.create exhausted through a corrupt payload', () => {
  it('its orphaned shot reaches a terminal state and is no longer sent', async () => {
    setActiveDataOwner(OWNER);
    const db = getDb();
    const session = sessionId(1);
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(1), sessionId: session }),
      PERMIT_ID,
    );
    await saveSession(db, {
      id: session,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    // A truncated write leaves the parent's payload as non-JSON.
    await db.execute(
      `UPDATE outbox SET payload = substr(payload, 1, 20)
       WHERE kind = 'session.create'`,
    );

    const { transport, posted } = orphanRejectingServer();
    for (let pass = 0; pass < OUTBOX_MAX_ATTEMPTS; pass += 1) {
      await drainOutbox(db, transport);
    }
    const parent = (await outboxRows(db, OWNER)).find(
      row => row.kind === 'session.create',
    );
    expect(parent?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);

    // Parent is exhausted: from here on the candidate's contract is that the
    // shot is excluded from the drain and reports its parent's verdict.
    const sentBefore = posted.length;
    await drainOutbox(db, transport);
    await drainOutbox(db, transport);
    expect(posted.slice(sentBefore).flat()).toEqual([]);

    const status = await getShotOutboxStatus(db, shotId(1));
    expect(status.state).not.toBe('queued');
  });
});
