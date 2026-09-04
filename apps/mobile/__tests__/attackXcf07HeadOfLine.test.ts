import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getShotOutboxStatus,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
} from '../src/data/sync';
import { createMemoryDb } from '../harness/outbox/memoryDb';
import { createSqliteDb, isSqliteAvailable } from '../harness/outbox/sqliteDb';
import type { HarnessDb } from '../harness/outbox/durableStore';

/**
 * ADVERSARIAL (XCF-07 fix, b7988b25): the session_not_found repair inserts
 * the replacement session.create row at the TAIL of the outbox, but
 * drainOutbox only ever looks at the first 50 retryable rows (ORDER BY id
 * ASC LIMIT 50). When 50 shots of the same lost session sit ahead of the
 * repaired row, resolveSessionNotFound sees "a retryable session.create row
 * is queued" and treats every rejection as transient — while that row can
 * never enter the drain window. Nothing is ever charged, nothing ever
 * converges: the exact "retried forever with shot.session_not_found, attempts
 * never advance" failure the fix claims to have removed.
 */

const owner = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-08-26T18:00:00.000Z';
const WINDOW = 50;

function analysisIn(id: string, sessionId: string | null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: T0,
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

function uuidAt(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Server stand-in that only knows sessions delivered via createSession. */
function serverTransport() {
  const known = new Set<string>();
  const calls: string[] = [];
  return {
    known,
    calls,
    transport: {
      syncShots: async (shots: unknown[]) => {
        calls.push('syncShots');
        const acceptedIds: string[] = [];
        const rejected: Array<{ id: string; code: string; message: string }> =
          [];
        for (const shot of shots as Array<{
          id: string;
          sessionId: string | null;
        }>) {
          if (shot.sessionId === null || known.has(shot.sessionId))
            acceptedIds.push(shot.id);
          else
            rejected.push({
              id: shot.id,
              code: SESSION_NOT_FOUND_REJECTION,
              message: 'Session not found or not yours.',
            });
        }
        return { acceptedIds, rejected };
      },
      createSession: async (session: unknown) => {
        calls.push('createSession');
        known.add((session as { id: string }).id);
      },
      finalizeSession: async () => {},
    },
  };
}

async function lostSessionsWithShots(
  db: LocalDb,
  server: ReturnType<typeof serverTransport>,
  sessionIds: readonly string[],
  shotsPerSession: number,
): Promise<string[]> {
  // Each practice set's session.create was accepted, then the server lost it
  // (rolled back / restored) — the candidate's own repair scenario. The
  // device still holds the local_session rows and no session.create rows.
  for (const sessionId of sessionIds) {
    await saveSession(db, {
      id: sessionId,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: T0,
    });
  }
  await expect(drainOutbox(db, server.transport)).resolves.toEqual({
    synced: sessionIds.length,
    failed: 0,
    remaining: 0,
  });
  for (const sessionId of sessionIds) server.known.delete(sessionId);

  // Shots interleave across the sessions in capture order.
  const shotIds: string[] = [];
  for (let i = 0; i < shotsPerSession * sessionIds.length; i += 1) {
    const id = uuidAt(i + 1);
    shotIds.push(id);
    await saveAnalysis(
      db,
      analysisIn(id, sessionIds[i % sessionIds.length] ?? null),
      uuidAt(1000 + i),
    );
  }
  return shotIds;
}

function lostSessionWithWindowOfShots(
  db: LocalDb,
  server: ReturnType<typeof serverTransport>,
  sessionId: string,
  shotCount: number,
): Promise<string[]> {
  return lostSessionsWithShots(db, server, [sessionId], shotCount);
}

async function drainUntilQuiet(
  db: LocalDb,
  transport: ReturnType<typeof serverTransport>['transport'],
  maxDrains: number,
): Promise<Array<{ synced: number; failed: number; remaining: number }>> {
  const results: Array<{ synced: number; failed: number; remaining: number }> =
    [];
  for (let i = 0; i < maxDrains; i += 1) {
    const result = await drainOutbox(db, transport);
    results.push(result);
    if (result.remaining === 0) break;
  }
  return results;
}

async function expectRepairedOrTerminal(
  db: LocalDb,
  shotIds: readonly string[],
): Promise<void> {
  // The fix's contract: repaired-and-accepted (row gone → 'absent'), or
  // terminally failed.
  const statuses = await Promise.all(
    shotIds.map(id => getShotOutboxStatus(db, id)),
  );
  const stuck = statuses.filter(
    s =>
      s.state !== 'absent' &&
      !(s.state === 'exhausted' && s.attempts >= OUTBOX_MAX_ATTEMPTS),
  );
  expect(stuck).toEqual([]);
}

function describeBackend(name: string, make: () => HarnessDb, only: typeof it) {
  describe(`XCF-07 repair behind a full drain window (${name})`, () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const otherSessionId = '66666666-6666-4666-8666-666666666666';

    beforeEach(() => setActiveDataOwner(owner));
    afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

    only(
      `converges when the lost session has fewer than ${WINDOW} shots (control)`,
      async () => {
        const store = make();
        const server = serverTransport();
        await lostSessionWithWindowOfShots(
          store.db,
          server,
          sessionId,
          WINDOW - 1,
        );
        const results = await drainUntilQuiet(store.db, server.transport, 4);
        expect(results[0]).toMatchObject({ synced: 0, failed: WINDOW - 1 });
        expect(results[results.length - 1]).toMatchObject({ remaining: 0 });
        expect(server.calls.filter(c => c === 'createSession')).toHaveLength(2);
        store.close();
      },
    );

    only(
      `never makes progress when ${WINDOW} shots of the lost session fill the drain window: the re-enqueued session.create sits behind them for ever and every rejection stays "transient"`,
      async () => {
        const store = make();
        const server = serverTransport();
        const shotIds = await lostSessionWithWindowOfShots(
          store.db,
          server,
          sessionId,
          WINDOW,
        );

        // Well past the attempt budget: by now every shot must be either
        // accepted (session repaired) or exhausted (terminal, visible).
        const drains = OUTBOX_MAX_ATTEMPTS * 3;
        const results = await drainUntilQuiet(
          store.db,
          server.transport,
          drains,
        );
        const snap = store.snapshot();
        const repaired = snap.outbox.filter(r => r.kind === 'session.create');
        const shotRows = snap.outbox.filter(r => r.kind === 'shot.sync');

        // Diagnostics for the report.
        console.log(
          JSON.stringify({
            backend: name,
            drains: results.length,
            first: results[0],
            last: results[results.length - 1],
            createSessionCalls: server.calls.filter(c => c === 'createSession')
              .length,
            repairedRows: repaired.map(r => ({
              id: r.id,
              attempts: r.attempts,
            })),
            shotAttempts: Array.from(
              new Set(shotRows.map(r => r.attempts)),
            ).sort(),
          }),
        );

        await expectRepairedOrTerminal(store.db, shotIds);
        expect(results[results.length - 1]).toMatchObject({ remaining: 0 });
        store.close();
      },
    );

    only(
      `also livelocks when the ${WINDOW} shots ahead of the repaired rows belong to two different lost sessions`,
      async () => {
        const store = make();
        const server = serverTransport();
        const shotIds = await lostSessionsWithShots(
          store.db,
          server,
          [sessionId, otherSessionId],
          WINDOW / 2,
        );
        const results = await drainUntilQuiet(
          store.db,
          server.transport,
          OUTBOX_MAX_ATTEMPTS * 3,
        );
        const snap = store.snapshot();
        console.log(
          JSON.stringify({
            backend: name,
            variant: 'two lost sessions',
            drains: results.length,
            last: results[results.length - 1],
            createSessionCalls: server.calls.filter(c => c === 'createSession')
              .length,
            repairedRows: snap.outbox
              .filter(r => r.kind === 'session.create')
              .map(r => ({ id: r.id, attempts: r.attempts })),
          }),
        );
        await expectRepairedOrTerminal(store.db, shotIds);
        expect(results[results.length - 1]).toMatchObject({ remaining: 0 });
        store.close();
      },
    );
  });
}

describeBackend('harness memory model', createMemoryDb, it);
describeBackend(
  'real SQLite (node:sqlite, production schema)',
  createSqliteDb,
  isSqliteAvailable() ? it : it.skip,
);
