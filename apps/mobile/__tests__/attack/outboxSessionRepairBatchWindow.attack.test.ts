/**
 * ADVERSARIAL (attack-fix-f356fd2a, XCF-07): the session_not_found repair
 * must make progress regardless of how many shots wait on the lost session.
 *
 * drainOutbox() drains `ORDER BY id ASC LIMIT 50`. recordSessionNotFound()
 * repairs a lost practice-set session by INSERTing a fresh `session.create`
 * row — which necessarily gets the HIGHEST id in the table. When 50 or more
 * non-terminal rows precede it, that row is never inside the drain window,
 * every shot keeps being rejected with shot.session_not_found, and because a
 * queued (attempts < max) session.create row exists the shot failure is
 * recorded as TRANSIENT (no attempt charged). Result: attempts never advance,
 * the shots stay 'queued' forever — exactly the livelock XCF-07 claims to
 * have removed, one boundary further out.
 *
 * Real SQLite (node:sqlite, production schema lifted from src/data/db.ts) via
 * the outbox harness, so LIMIT/ORDER BY/json_set behave as on device.
 * Run: NODE_OPTIONS=--experimental-sqlite npx jest --ci __tests__/attack/outboxSessionRepairBatchWindow.attack.test.ts
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  createSqliteDb,
  isSqliteAvailable,
} from '../../harness/outbox/sqliteDb';
import type { HarnessDb } from '../../harness/outbox/durableStore';
import { saveAnalysis, saveSession } from '../../src/data/repository';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  type SyncTransport,
} from '../../src/data/sync';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const owner = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const permitId = '55555555-5555-4555-8555-555555555555';

function shot(n: number): ShotAnalysis {
  return {
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: `2026-09-04T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

/** A healthy server that only knows the sessions it was told to create. */
function healthyServer() {
  const sessions = new Set<string>();
  const accepted: string[] = [];
  const transport: SyncTransport = {
    async syncShots(shots) {
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const raw of shots as Array<{ id: string; sessionId: unknown }>) {
        if (raw.sessionId === null || sessions.has(String(raw.sessionId))) {
          acceptedIds.push(raw.id);
          accepted.push(raw.id);
        } else {
          rejected.push({
            id: raw.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'Session not found.',
          });
        }
      }
      return { acceptedIds, rejected };
    },
    async createSession(session) {
      sessions.add(String((session as { id: string }).id));
    },
    async finalizeSession() {},
  };
  return { transport, sessions, accepted };
}

/**
 * The state XCF-07 sets out to repair: a practice-set session exists locally
 * but its `session.create` outbox row is gone (pre-fix builds swallowed the
 * commitPracticeSet failure; an exhausted/pruned row ends the same way), and
 * `shotCount` shots of that set are queued.
 */
async function seedOrphanedSet(harness: HarnessDb, shotCount: number) {
  await saveSession(harness.db, {
    id: sessionId,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-09-04T10:00:00.000Z',
  });
  await harness.db.execute(
    `DELETE FROM outbox WHERE owner_key = ? AND kind = 'session.create'`,
    [owner],
  );
  for (let n = 1; n <= shotCount; n += 1) {
    await saveAnalysis(harness.db, shot(n), permitId);
  }
}

function outboxSummary(harness: HarnessDb) {
  const snap = harness.snapshot();
  return {
    rows: snap.outbox.length,
    kinds: snap.outbox.reduce<Record<string, number>>((acc, row) => {
      acc[row.kind] = (acc[row.kind] ?? 0) + 1;
      return acc;
    }, {}),
    maxShotAttempts: Math.max(
      0,
      ...snap.outbox
        .filter(row => row.kind === 'shot.sync')
        .map(row => Number(row.attempts)),
    ),
    sessionCreateIds: snap.outbox
      .filter(row => row.kind === 'session.create')
      .map(row => ({ id: row.id, attempts: row.attempts })),
  };
}

const sqliteDescribe = isSqliteAvailable() ? describe : describe.skip;

sqliteDescribe(
  'XCF-07 attack: session repair vs the 50-row drain window',
  () => {
    let harness: HarnessDb;

    beforeEach(() => {
      setActiveDataOwner(owner);
      harness = createSqliteDb();
    });

    afterEach(() => {
      harness.close();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    });

    // Control: one row under the window the fix works exactly as claimed.
    it('49 orphaned shots: the re-enqueued session.create is drained and every shot syncs', async () => {
      await seedOrphanedSet(harness, 49);
      const server = healthyServer();
      let result = await drainOutbox(harness.db, server.transport);
      for (let i = 0; i < 3 && result.remaining > 0; i += 1) {
        result = await drainOutbox(harness.db, server.transport);
      }
      expect(server.sessions.has(sessionId)).toBe(true);
      expect(result.remaining).toBe(0);
      expect(server.accepted).toHaveLength(49);
    });

    it('50 orphaned shots: the repair row sits behind the window and the set never syncs, never fails, never charges an attempt (livelock)', async () => {
      await seedOrphanedSet(harness, 50);
      const server = healthyServer();

      // Far more healthy drains than the whole retry budget could ever need:
      // either the set syncs (repair reached) or every shot goes terminal.
      const drains = OUTBOX_MAX_ATTEMPTS * 3;
      let result = { synced: 0, failed: 0, remaining: 0 };
      for (let i = 0; i < drains; i += 1) {
        result = await drainOutbox(harness.db, server.transport);
        if (result.remaining === 0) break;
      }
      const summary = outboxSummary(harness);

      // The repair itself happened — a fresh session.create row exists (with
      // the highest id, i.e. outside the 50-row window as long as the 50 shots
      // it is meant to unblock are still queued ahead of it).
      expect(summary.sessionCreateIds).toHaveLength(1);
      // Contract (XCF-07 expected): "session_not_found must not be retried
      // indefinitely without progress" — after 24 healthy drains the server has
      // learned the session and every shot is synced (or, at the very least,
      // terminally failed). Observed on f356fd2a: the session.create row is
      // never sent, all 50 shots stay queued with attempts <= 1 and
      // last_error=shot.session_not_found, drain after drain.
      expect({
        serverKnowsSession: server.sessions.has(sessionId),
        synced: server.accepted.length,
        remaining: result.remaining,
        maxShotAttempts: summary.maxShotAttempts,
        kinds: summary.kinds,
        sampleLastError: harness.snapshot().outbox[0]?.last_error ?? null,
      }).toEqual({
        serverKnowsSession: true,
        synced: 50,
        remaining: 0,
        maxShotAttempts: expect.any(Number),
        kinds: {},
        sampleLastError: null,
      });
    });
  },
);
