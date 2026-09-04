/**
 * C3 — `drainOutbox()` selects ONE global window
 * (`ORDER BY id ASC LIMIT 50`, attempts < 8) and only then splits it by kind.
 * `shot.session_not_found` is classified transient (no attempt budget), so a
 * shot whose practice-set `session.create` row can never reach the server is
 * retried on EVERY drain forever. Once 50 such rows sit at the head of the
 * queue nothing newer — not even the next session's `session.create` — is
 * ever selected again: every later rating on the device is stranded.
 *
 * Trigger used here: the server permanently refuses two practice sets'
 * `session.create` (409 session.id_conflict — a contract verdict, so it burns
 * the 8-attempt budget and drops out of the window) while their 50 shots are
 * rejected with `shot.session_not_found` each time. The user then records a
 * brand-new practice set.
 *
 * Expected (fails on the baseline): the new set's session and shot still
 * sync, and an orphaned shot does not stay `queued` with 0 attempts forever.
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
  saveAnalysis,
  saveSession,
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
const DEAD_SESSIONS = [
  'dddddddd-0000-4000-8000-000000000001',
  'dddddddd-0000-4000-8000-000000000002',
];
const NEW_SESSION = 'eeeeeeee-0000-4000-8000-000000000001';
const NEW_SHOT = shotId(0x900);

function serverEmulator(): SyncTransport & { knownSessions: Set<string> } {
  const knownSessions = new Set<string>();
  return {
    knownSessions,
    async createSession(session) {
      const id = String((session as { id: unknown }).id);
      if (DEAD_SESSIONS.includes(id)) {
        throw new ApiError(
          409,
          'session.id_conflict',
          'Session id belongs to another user.',
        );
      }
      knownSessions.add(id);
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const raw of shots) {
        const shot = raw as { id: string; sessionId: string | null };
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
      return { acceptedIds, rejected };
    },
  };
}

async function newPracticeSet(
  db: LocalDb,
  sessionId: string,
  shots: number[],
): Promise<void> {
  // Mirrors AnalyzeScreen: the scored shot is saved first, then
  // commitPracticeSet() writes the session.create row behind it.
  for (const [index, n] of shots.entries()) {
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(n), sessionId }),
      PERMIT_ID,
    );
    if (index === 0) {
      await saveSession(db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      });
    }
  }
}

describe('C3: transient orphans starve the outbox window (real SQLite)', () => {
  let db: LocalDb;
  const server = serverEmulator();

  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await newPracticeSet(
      db,
      DEAD_SESSIONS[0]!,
      Array.from({ length: 25 }, (_, i) => 0x100 + i),
    );
    await newPracticeSet(
      db,
      DEAD_SESSIONS[1]!,
      Array.from({ length: 25 }, (_, i) => 0x200 + i),
    );
    // Days of drains: the two session.create rows exhaust their budget and
    // leave the window; their 50 shots never do.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i++) {
      await drainOutbox(db, server);
    }
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('precondition: 50 orphaned shots remain transient at the head of the queue', async () => {
    const rows = await outboxRows(db, OWNER);
    const creates = rows.filter(r => r.kind === 'session.create');
    expect(creates).toHaveLength(2);
    expect(creates.every(r => r.attempts >= OUTBOX_MAX_ATTEMPTS)).toBe(true);
    const orphans = rows.filter(r => r.kind === 'shot.sync');
    expect(orphans).toHaveLength(50);
    expect(orphans.every(r => r.attempts === 0)).toBe(true);
  });

  it('a brand-new practice set still reaches the server', async () => {
    await newPracticeSet(db, NEW_SESSION, [0x900]);
    for (let i = 0; i < 3; i++) {
      await drainOutbox(db, server);
    }
    expect(server.knownSessions.has(NEW_SESSION)).toBe(true);
    expect(await hasShotSyncReceipt(db, NEW_SHOT)).toBe(true);
  });

  it('an orphaned shot is not reported as freshly queued forever', async () => {
    const status = await getShotOutboxStatus(db, shotId(0x100));
    expect(status.state).not.toBe('queued');
  });
});
