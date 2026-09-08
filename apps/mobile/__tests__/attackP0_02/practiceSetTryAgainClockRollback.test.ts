/**
 * P0-02 adversary — clock rollback at the OTHER provenance boundary of the
 * shipping analysis path: the practice set.
 *
 * The candidate floors the analysis record's clock at the capture, so a
 * device clock that steps back between capture and commit no longer strands
 * the result. But AnalyzeScreen builds the record's practice-set plan from
 * the raw wall clock (`planPracticeSet(db, {shotType, preferredSessionId:
 * rearm?.sessionId})`, no `nowIso`) and `prepareOriginalCaptureAnalysis`
 * refuses any plan whose `nowIso` precedes its `startedAtIso`
 * (originalAnalysisSnapshot.ts). A TRY AGAIN re-arm carries the previous
 * attempt's sessionId and "always wins", so its plan inherits the stored
 * set's `startedAtIso`; after a rollback that instant lies in the plan's
 * future and the definition is rejected before a permit is even reserved.
 * AnalyzeScreen has already retained the operation id at that point, so the
 * user sees the `reconcile_saved` error ("This saved analysis could not be
 * verified…") for an analysis that never existed — on the supported
 * re-record path, with no clock involvement the user can see.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { OriginalAnalysisExecution } from '../../src/analysis/originalAnalysisOperations';
import {
  commitPracticeSet,
  planPracticeSet,
  type PracticeSetPlan,
} from '../../src/analysis/practiceSet';
import * as captureRunner from '../../src/analysis/runCaptureAnalysis';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));

const OWNER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const LOGICAL = '44444444-4444-4444-8444-444444444444';
const originalFetch = globalThis.fetch;
const leases: OriginalAnalysisExecution[] = [];

function fixture(capturedAtIso: string) {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/original.mov',
    captureMode: 'imported_video',
    capturedAtIso,
    durationMs: window.endMs,
    width: 1080,
    height: 1080,
    fps: 60,
    byteSize: 25,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'original.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/original.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

const ok = (value: unknown): Response =>
  ({ ok: true, status: 200, json: async () => value }) as Response;

function server() {
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        idempotencyKey?: string;
        outcome?: string;
        shots?: Array<{ id: string }>;
      };
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(key, permit);
        }
        return ok({
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
          },
        });
      }
      if (url.endsWith('/finalize')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (permit) permit.outcome = String(body.outcome);
        return ok({ permit });
      }
      if (url.endsWith('/v1/sessions')) return ok({});
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots ?? [];
        return ok({ acceptedIds: shots.map(shot => shot.id), rejected: [] });
      }
      throw new Error(`Unexpected test HTTP ${url}`);
    },
  );
  return reservations;
}

function baseRequest(
  db: LocalDb,
  clip: CapturedClip,
): Omit<captureRunner.RunCaptureAnalysisRequest, 'ownerContext'> {
  return {
    db,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ORIGIN, token: 'never-save-this-token' },
  };
}

async function shotSessionIds(db: LocalDb): Promise<string[]> {
  const { rows } = await db.execute(
    'SELECT session_id FROM local_shot WHERE owner_key = ?',
    [OWNER],
  );
  return rows.map(row => String(row.session_id));
}

async function seed(capturedAtIso: string) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(capturedAtIso);
  const pose = clip.poseSequence!;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
    ['forehand_drive', CAPTURE],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  jest.mocked(extractImportedPoseSequence).mockResolvedValue({
    poseSequence: pose,
    framesWithPose: pose.frameCount,
    framesTotal: pose.frameCount,
  });
  return { store, clip };
}

/**
 * The previous sitting: one analysis landed at `firstAnalysisIso` and was
 * committed into the live set, exactly what the user's first attempt leaves
 * behind before tapping TRY AGAIN.
 */
async function priorSitting(
  db: LocalDb,
  firstAnalysisIso: string,
): Promise<PracticeSetPlan> {
  const plan = await planPracticeSet(db, {
    shotType: 'forehand_drive',
    nowIso: firstAnalysisIso,
  });
  if (!plan) throw new Error('signed-in owner expected');
  await commitPracticeSet(db, plan);
  return plan;
}

async function tryAgainAttempt(deviceNowMs: number, rollbackMs: number) {
  // First attempt committed at T; the re-record is captured 2 s later on a
  // device whose clock is then corrected back by `rollbackMs`.
  const firstAnalysisIso = new Date(deviceNowMs).toISOString();
  const capturedAtIso = new Date(deviceNowMs + 2_000).toISOString();
  const deviceClockAtPlanIso = new Date(
    deviceNowMs + 2_000 - rollbackMs,
  ).toISOString();
  const { store, clip } = await seed(capturedAtIso);
  const prior = await priorSitting(store.db, firstAnalysisIso);
  const practiceSet = await planPracticeSet(store.db, {
    shotType: 'forehand_drive',
    preferredSessionId: prior.sessionId,
    nowIso: deviceClockAtPlanIso,
  });
  if (!practiceSet) throw new Error('signed-in owner expected');
  const owner = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(owner);
  const prepare = () =>
    captureRunner.prepareOriginalCaptureAnalysis(
      {
        ...baseRequest(store.db, clip),
        ownerContext: owner.ownerContext,
        sessionId: practiceSet.sessionId,
        practiceSet,
      },
      owner,
      LOGICAL,
    );
  const reservations = server();
  const run = () =>
    captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
    });
  return { store, practiceSet, prior, prepare, run, reservations };
}

beforeEach(() => {
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockImplementation(async clip => ({
      status: 'verified-current-bytes',
      comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
    }));
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: ORIGIN,
    bearerToken: 'not-persisted-test-bearer',
    provider: 'apple',
  });
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

const ROLLBACKS: Array<[string, number]> = [
  ['3 seconds', 3_000],
  ['5 minutes', 5 * 60_000],
  ['1 hour', 3_600_000],
];

describe('TRY AGAIN into the previous set after a device clock rollback', () => {
  it('control: with a monotonic clock the re-record joins the set and scores', async () => {
    const attempt = await tryAgainAttempt(Date.now() - 10_000, 0);
    await expect(attempt.prepare()).resolves.toBeDefined();
    const outcome = await attempt.run();
    expect({
      kind: outcome.kind,
      shotSessions: await shotSessionIds(attempt.store.db),
      resumed: attempt.practiceSet.resumed,
    }).toEqual({
      kind: 'scored',
      shotSessions: [attempt.prior.sessionId],
      resumed: true,
    });
  });

  it.each(ROLLBACKS)(
    'a %s rollback must not turn the re-record into an unverifiable saved analysis',
    async (_label, rollbackMs) => {
      const attempt = await tryAgainAttempt(Date.now() - 10_000, rollbackMs);
      // What AnalyzeScreen hands to prepareOriginalCaptureAnalysis.
      expect(attempt.practiceSet).toMatchObject({
        sessionId: attempt.prior.sessionId,
        resumed: true,
      });
      const prepared = await attempt.prepare().then(
        () => ({ prepared: true as const, error: null }),
        (error: unknown) => ({
          prepared: false as const,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      expect(prepared).toEqual({ prepared: true, error: null });
      const outcome = await attempt.run();
      expect({
        kind: outcome.kind,
        shotSessions: await shotSessionIds(attempt.store.db),
        permits: [...attempt.reservations.values()].map(p => p.outcome),
      }).toEqual({
        kind: 'scored',
        shotSessions: [attempt.prior.sessionId],
        permits: [null],
      });
    },
  );
});

describe('a fresh (non TRY AGAIN) analysis after a rollback', () => {
  it('starts a new set rather than refusing to analyse; the result still scores', async () => {
    const now = Date.now() - 10_000;
    const { store, clip } = await seed(new Date(now + 2_000).toISOString());
    const prior = await priorSitting(store.db, new Date(now).toISOString());
    const practiceSet = await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: new Date(now + 2_000 - 60_000).toISOString(),
    });
    if (!practiceSet) throw new Error('signed-in owner expected');
    const owner = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      ORIGIN,
    );
    leases.push(owner);
    await captureRunner.prepareOriginalCaptureAnalysis(
      {
        ...baseRequest(store.db, clip),
        ownerContext: owner.ownerContext,
        sessionId: practiceSet.sessionId,
        practiceSet,
      },
      owner,
      LOGICAL,
    );
    server();
    const outcome = await captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
    });
    expect({
      kind: outcome.kind,
      resumed: practiceSet.resumed,
      joinedPriorSet: practiceSet.sessionId === prior.sessionId,
    }).toEqual({ kind: 'scored', resumed: false, joinedPriorSet: false });
  });
});
