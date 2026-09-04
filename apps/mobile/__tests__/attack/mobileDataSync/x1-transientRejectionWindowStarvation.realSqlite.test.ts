/// <reference types="node" />
/**
 * ATTACK on the MDS-3 fix (7427f9f0): the per-kind `row_number()` window in
 * sync.ts only unblocks rows of OTHER kinds and shots whose LOCAL parent
 * `session.create` row has been refused. Every other transient rejection the
 * server can hand out per item — `shot.write_failed`, `auth.required`,
 * `evaluation.trial_write_failed`, and `shot.session_not_found` for a shot
 * whose parent row does not exist locally — still never increments
 * `attempts`, so 50 such rows keep the SAME kind's window forever and every
 * newer row of that kind (a brand-new rating, a new evaluation trial) is never
 * offered to the server again.
 *
 * Runs the production SQL against Node's `node:sqlite` via
 * adjudication-support/realSqlite (needs NODE_OPTIONS=--experimental-sqlite
 * on Node 22.12).
 *
 * Run: cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest \
 *   __tests__/attack/mobileDataSync/x1-transientRejectionWindowStarvation.realSqlite.test.ts --ci
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { ApiError } from '../../../src/data/api';
import type { LocalDb } from '../../../src/data/db';
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
  openRealSqlite,
  type RealSqliteHandle,
} from '../../../adjudication-support/realSqlite';

const mockState: { handle: RealSqliteHandle | null } = { handle: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockState.handle) throw new Error('harness: no handle');
    return mockState.handle;
  },
}));

function launch(): LocalDb {
  mockState.handle = openRealSqlite();
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../../../src/data/db')>(
        '../../../src/data/db',
      )
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

const OWNER = canonicalDataOwner('11111111-1111-4111-8111-111111111111');
const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WINDOW = 50;
/** A session id the device references but never queued a session.create for
 * (commitPracticeSet was interrupted between saveAnalysis and saveSession). */
const GHOST_SESSION = 'dddddddd-0000-4000-8000-000000000001';
/** Well past the drains the repo-owned liveness test calls "bounded". */
const DRAINS = OUTBOX_MAX_ATTEMPTS * 3;

function shotId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysis(id: string, sessionId: string | null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
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
      appVersion: '1.0',
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

interface Rejection {
  id: string;
  code: string;
  message: string;
}

/** Server double: rejects every shot in `stuck` with `stuckCode` (the edge
 * function labels a failed `apply_synced_shot` RPC `shot.write_failed` and
 * an unknown session `shot.session_not_found`), accepts everything else, and
 * treats evaluation trials the same way through `stuckTrials`. */
function server(options: {
  stuck: Set<string>;
  stuckCode: string;
  stuckTrials?: Set<string>;
  /** session ids whose session.create keeps failing with a whole-request 5xx */
  stuckSessions?: Set<string>;
}): SyncTransport & {
  offered: string[][];
  trialsOffered: string[][];
  acceptedTrials: string[];
} {
  const offered: string[][] = [];
  const trialsOffered: string[][] = [];
  const acceptedTrials: string[] = [];
  return {
    offered,
    trialsOffered,
    acceptedTrials,
    async createSession(session) {
      const id = String((session as Record<string, unknown>)['id']);
      if (options.stuckSessions?.has(id)) {
        throw new ApiError(503, 'server.unavailable', 'upstream unavailable');
      }
    },
    async finalizeSession() {},
    async syncShots(shots) {
      const ids = shots.map(shot =>
        String((shot as Record<string, unknown>)['id']),
      );
      offered.push(ids);
      const acceptedIds: string[] = [];
      const rejected: Rejection[] = [];
      for (const shot of shots) {
        const record = shot as Record<string, unknown>;
        const id = String(record['id']);
        if (options.stuck.has(id)) {
          rejected.push({ id, code: options.stuckCode, message: 'stuck' });
        } else if (options.stuckSessions?.has(String(record['sessionId']))) {
          // The server has never seen this session, exactly as production
          // answers for a shot whose session.create has not landed.
          rejected.push({
            id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'unknown session',
          });
        } else {
          acceptedIds.push(id);
        }
      }
      return { acceptedIds, rejected };
    },
    async uploadEvaluationTrials(trials) {
      const ids = trials.map(trial =>
        String((trial as Record<string, unknown>)['trialId']),
      );
      trialsOffered.push(ids);
      const acceptedTrialIds: string[] = [];
      const rejected: Array<{
        trialId: string;
        code: string;
        message: string;
      }> = [];
      for (const id of ids) {
        if (options.stuckTrials?.has(id)) {
          rejected.push({
            trialId: id,
            code: 'evaluation.trial_write_failed',
            message: 'stuck',
          });
        } else {
          acceptedTrialIds.push(id);
        }
      }
      acceptedTrials.push(...acceptedTrialIds);
      return { acceptedTrialIds, rejected };
    },
  };
}

async function queueShots(
  db: LocalDb,
  count: number,
  sessionId: string | null,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const id = shotId(0x100 + i);
    ids.add(id);
    await saveAnalysis(db, analysis(id, sessionId), PERMIT);
  }
  return ids;
}

describe('ATTACK X1: per-item transient rejections still freeze the per-kind outbox window (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    db = launch();
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    mockState.handle?.close();
    mockState.handle = null;
  });

  it.each([
    ['shot.write_failed', null],
    [SESSION_NOT_FOUND_REJECTION, GHOST_SESSION],
  ] as const)(
    '%s on 50 older shots must not stop a newer sessionless rating from ever being offered',
    async (code, sessionId) => {
      const stuck = await queueShots(db, WINDOW, sessionId);
      const transport = server({ stuck, stuckCode: code });
      for (let i = 0; i < 2; i += 1) await drainOutbox(db, transport);

      // The transient rows keep their whole budget, exactly as designed —
      // and therefore still report `queued` (attempts 0) after every drain.
      expect(await getShotOutboxStatus(db, shotId(0x100))).toEqual({
        state: 'queued',
        attempts: 0,
        lastError: expect.stringContaining(code),
      });

      const fresh = shotId(0x900);
      await saveAnalysis(db, analysis(fresh, null), PERMIT);
      const offeredBefore = transport.offered.length;
      for (let i = 0; i < DRAINS; i += 1) await drainOutbox(db, transport);

      const freshOffered = transport.offered
        .slice(offeredBefore)
        .some(batch => batch.includes(fresh));
      expect({
        freshOffered,
        drains: DRAINS,
        receipt: await hasShotSyncReceipt(db, fresh),
        status: await getShotOutboxStatus(db, fresh),
      }).toEqual({
        freshOffered: true,
        drains: DRAINS,
        receipt: true,
        status: { state: 'absent' },
      });
    },
  );

  it('50 shots of practice sets whose session.create keeps 5xx-ing occupy the shot window without ever being offered, so a newer sessionless rating never is either', async () => {
    // Ten practice sets of five shots each, saved the way commitPracticeSet
    // does it (first analysis, then the session row, then the rest).
    const stuckSessions = new Set<string>();
    for (let s = 0; s < WINDOW / 5; s += 1) {
      const sessionId = `eeeeeeee-0000-4000-8000-${String(s).padStart(12, '0')}`;
      stuckSessions.add(sessionId);
      await saveAnalysis(
        db,
        analysis(shotId(0x100 + s * 5), sessionId),
        PERMIT,
      );
      await saveSession(db, {
        id: sessionId,
        mode: 'practice_set',
        shotType: 'forehand_drive',
        focusCheckpoint: null,
        startedAt: '2026-08-26T18:00:00.000Z',
      });
      for (let i = 1; i < 5; i += 1) {
        await saveAnalysis(
          db,
          analysis(shotId(0x100 + s * 5 + i), sessionId),
          PERMIT,
        );
      }
    }
    const transport = server({
      stuck: new Set(),
      stuckCode: 'shot.write_failed',
      stuckSessions,
    });
    for (let i = 0; i < 2; i += 1) await drainOutbox(db, transport);

    // 5xx is transient by design: the session rows keep attempts 0, so their
    // shots are neither excluded from the window nor ever accepted.
    expect(await getShotOutboxStatus(db, shotId(0x100))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    const fresh = shotId(0x900);
    await saveAnalysis(db, analysis(fresh, null), PERMIT);
    const offeredBefore = transport.offered.length;
    for (let i = 0; i < DRAINS; i += 1) await drainOutbox(db, transport);

    expect({
      freshOffered: transport.offered
        .slice(offeredBefore)
        .some(batch => batch.includes(fresh)),
      receipt: await hasShotSyncReceipt(db, fresh),
      status: await getShotOutboxStatus(db, fresh),
    }).toEqual({
      freshOffered: true,
      receipt: true,
      status: { state: 'absent' },
    });
  });

  it('evaluation.trial_write_failed on 50 older trials must not stop a newer trial from ever being offered', async () => {
    const stuckTrials = new Set<string>();
    for (let i = 0; i < WINDOW; i += 1) {
      const trialId = `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`;
      stuckTrials.add(trialId);
      await db.execute(
        `INSERT INTO outbox (owner_key, kind, payload)
         VALUES (?, 'evaluation.trial', ?)`,
        [OWNER, JSON.stringify({ trialId })],
      );
    }
    const transport = server({
      stuck: new Set(),
      stuckCode: 'shot.write_failed',
      stuckTrials,
    });
    for (let i = 0; i < 2; i += 1) await drainOutbox(db, transport);

    const freshTrial = 'ffffffff-0000-4000-8000-ffffffffffff';
    await db.execute(
      `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'evaluation.trial', ?)`,
      [OWNER, JSON.stringify({ trialId: freshTrial })],
    );
    const offeredBefore = transport.trialsOffered.length;
    for (let i = 0; i < DRAINS; i += 1) await drainOutbox(db, transport);

    expect({
      freshOffered: transport.trialsOffered
        .slice(offeredBefore)
        .some(batch => batch.includes(freshTrial)),
      accepted: transport.acceptedTrials,
    }).toEqual({ freshOffered: true, accepted: [freshTrial] });
  });
});
