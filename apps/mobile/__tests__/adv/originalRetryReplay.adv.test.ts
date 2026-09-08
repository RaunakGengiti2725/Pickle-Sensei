/**
 * ADVERSARY (INT-import-media-capture): original-clip retry when the media,
 * the sidecar or the account is no longer what the saved operation recorded.
 *
 * `runOriginalCaptureAnalysis` resumes a saved original operation for an
 * imported clip that has NOT been pose-extracted yet. Before extracting it
 * asks native whether the movie bytes are still the ones the original
 * receipt hashed. These attacks make that byte check, the extraction, or the
 * sidecar read lie/fail/disappear at replay and assert: no scored record, no
 * permit reservation, no charge, no extraction on foreign bytes, and the
 * saved operation is still recoverable afterwards (never a second operation).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { OriginalAnalysisSnapshot } from '../../src/analysis/originalAnalysisSnapshot';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations as operations,
} from '../../src/analysis/originalAnalysisOperations';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../../src/camera/capture';
import * as captureRunner from '../../src/analysis/runCaptureAnalysis';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));

const originalFetch = globalThis.fetch;
const verifyBytes = jest.mocked(verifyCapturedClipCurrentBytes);
const readArtifact = jest.mocked(readCaptureArtifact);
const extractPose = jest.mocked(extractImportedPoseSequence);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const LOGICAL = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const leases: OriginalAnalysisExecution[] = [];

function signIn() {
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: ORIGIN,
    bearerToken: 'not-persisted-test-bearer',
    provider: 'apple',
  });
}

function fixture() {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/original.mov',
    captureMode: 'imported_video',
    capturedAtIso: '2026-09-06T12:00:00.000Z',
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
  };
  const poseRef: NonNullable<CapturedClip['poseSequence']> = {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///private/captures/original.pose.json',
    frameCount: sequence.frames.length,
    sha256: sha256Hex(sidecar),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: sequence.producedBy.modelVersion,
  };
  const snapshot: OriginalAnalysisSnapshot = {
    version: 'original-analysis-v1',
    ownerKey: OWNER,
    apiOrigin: ORIGIN,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'left',
    cameraView: 'rear_oblique',
    focusCheckpoint: 'contact_point',
    targetSeed: {
      point: { x: 0.4, y: 0.6 },
      selectedAtIso: '2026-09-06T12:01:00.000Z',
    },
    sessionId: SESSION,
    practiceSet: {
      owner: OWNER,
      sessionId: SESSION,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-06T12:00:00.000Z',
      nowIso: '2026-09-06T12:00:00.000Z',
    },
    appVersion: '0.1.0',
    modelPolicy: [
      'fusion-test-1',
      'taxonomy-test-1',
      'bundle-test-1',
      ['phase-test-1', 'real'],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [],
    ],
    captureEnvelope: null,
  };
  return { clip, sidecar, snapshot, poseRef };
}

async function runnerSetup() {
  const store = createSqliteTestDb();
  const { snapshot, clip, sidecar, poseRef } = fixture();
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
    ['forehand_drive', JSON.stringify(snapshot.targetSeed), CAPTURE],
  );
  readArtifact.mockResolvedValue(sidecar);
  extractPose.mockResolvedValue({
    poseSequence: poseRef,
    framesWithPose: poseRef.frameCount,
    framesTotal: poseRef.frameCount,
  });
  const owner = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(owner);
  const request: captureRunner.RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: owner.ownerContext,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ORIGIN, token: 'never-save-this-token' },
    sessionId: SESSION,
    practiceSet: snapshot.practiceSet,
    targetSeed: snapshot.targetSeed,
  };
  const operation = await captureRunner.prepareOriginalCaptureAnalysis(
    request,
    owner,
    LOGICAL,
  );
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const ok = (value: unknown) =>
        ({ ok: true, status: 200, json: async () => value }) as Response;
      if (url.endsWith('/v1/analysis-permits')) {
        let permit = reservations.get(body.idempotencyKey);
        if (!permit) {
          permit = {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(body.idempotencyKey, permit);
        }
        return ok({
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: '2026-09-07T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/finalize')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (permit) permit.outcome = body.outcome;
        return ok({ permit });
      }
      if (url.endsWith('/v1/sessions')) return ok({});
      if (url.endsWith('/v1/shots:sync')) {
        for (const shot of body.shots) {
          const permit = [...reservations.values()].find(
            value => value.id === shot.analysisPermitId,
          );
          if (permit) permit.outcome = 'scored';
        }
        return ok({
          acceptedIds: body.shots.map((shot: { id: string }) => shot.id),
          rejected: [],
        });
      }
      throw new Error(`Unexpected test HTTP ${url}`);
    },
  );
  globalThis.fetch = fetch;
  const run = (predecessorAttemptId?: string) =>
    captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
      predecessorAttemptId,
    });
  return { store, owner, request, operation, fetch, reservations, run, clip };
}

function scoredPermits(input: Awaited<ReturnType<typeof runnerSetup>>): number {
  return [...input.reservations.values()].filter(
    permit => permit.outcome === 'scored',
  ).length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  signIn();
  verifyBytes.mockReset();
  readArtifact.mockReset();
  extractPose.mockReset();
  verifyBytes.mockImplementation(async clip => ({
    status: 'verified-current-bytes',
    comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
  }));
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('ADV original-clip retry: media / sidecar / account drift at replay', () => {
  it('control: the saved original imported clip extracts, scores and charges exactly once', async () => {
    const input = await runnerSetup();
    const result = await input.run();
    expect(result).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    expect(input.reservations.size).toBe(1);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    expect(input.store.count('outbox', OWNER)).toBe(2);
    expect(extractPose).toHaveBeenCalledTimes(1);
  });

  it.each(['mismatch', 'unavailable', 'legacy', 'invalid'] as const)(
    'ATTACK C1: native reports current bytes as %s at replay -> no extraction, no permit, no charge, still recoverable',
    async status => {
      const input = await runnerSetup();
      verifyBytes.mockResolvedValueOnce({ status });
      const result = await input.run();
      expect(result.kind).toBe('unavailable');
      expect(extractPose).not.toHaveBeenCalled();
      expect(input.fetch).not.toHaveBeenCalled();
      expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
      expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(0);
      // The saved operation is neither destroyed nor duplicated.
      const saved = await operations.read(input.store.db, input.owner, LOGICAL);
      expect(saved?.snapshot.captureId).toBe(CAPTURE);
      expect(saved?.observation).toBeNull();
    },
  );

  it('ATTACK C2: native says verified but compared a DIFFERENT byte expectation than the original receipt', async () => {
    const input = await runnerSetup();
    verifyBytes.mockResolvedValueOnce({
      status: 'verified-current-bytes',
      comparedExpectation: {
        ...input.clip.nativeMediaIdentity!,
        byteSize: input.clip.nativeMediaIdentity!.byteSize + 1,
      },
    });
    const result = await input.run();
    expect(result.kind).toBe('unavailable');
    expect(extractPose).not.toHaveBeenCalled();
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
  });

  it('ATTACK C3: the native byte comparison itself throws (bridge crash) -> hold, then an honest retry scores once', async () => {
    const input = await runnerSetup();
    verifyBytes.mockRejectedValueOnce(new Error('Native comparison crashed'));
    const first = await input.run();
    expect(first.kind).toBe('unavailable');
    expect(extractPose).not.toHaveBeenCalled();
    expect(input.fetch).not.toHaveBeenCalled();
    const second = await input.run();
    expect(second).toMatchObject({
      kind: 'scored',
      analysisId: input.operation.analysisId,
    });
    expect(input.reservations.size).toBe(1);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    expect(input.store.count('outbox', OWNER)).toBe(2);
  });

  it('ATTACK C4: extraction returns a receipt above the 4000-frame ceiling (native regression) -> refused, no charge, operation intact', async () => {
    const input = await runnerSetup();
    const { poseRef } = fixture();
    extractPose.mockResolvedValueOnce({
      poseSequence: { ...poseRef, frameCount: 4001 },
      framesWithPose: 4001,
      framesTotal: 4001,
    });
    const result = await input.run();
    expect(result.kind).toBe('unavailable');
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
    const saved = await operations.read(input.store.db, input.owner, LOGICAL);
    expect(saved?.snapshot.clip.poseSequence).toBeUndefined();
    expect(saved?.observation).toBeNull();
  });

  it('ATTACK C5: the sidecar file is MISSING at replay (native text reader resolves nothing) -> no throw, no permit, no charge', async () => {
    const input = await runnerSetup();
    // A missing private artifact resolves as a non-string from the bridge.
    readArtifact.mockResolvedValueOnce(undefined as unknown as string);
    const result = await input.run();
    expect(result.kind).toBe('unavailable');
    expect(scoredPermits(input)).toBe(0);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
  });

  it('ATTACK C6: the account switches while native extraction is in flight -> account_changed, nothing persisted for either owner', async () => {
    const input = await runnerSetup();
    const { poseRef } = fixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    extractPose.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return {
        poseSequence: poseRef,
        framesWithPose: poseRef.frameCount,
        framesTotal: poseRef.frameCount,
      };
    });
    const pending = input.run();
    await entered.promise;
    setActiveDataOwner(OTHER_OWNER);
    resume.resolve();
    const result = await pending;
    expect(result).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.store.count('local_analysis_record', OWNER)).toBe(0);
    expect(input.store.count('local_analysis_record', OTHER_OWNER)).toBe(0);
    expect(input.store.count('analysis_execution_attempts', OTHER_OWNER)).toBe(
      0,
    );
    setActiveDataOwner(OWNER);
    const reopened = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      ORIGIN,
    );
    leases.push(reopened);
    const saved = await operations.read(input.store.db, reopened, LOGICAL);
    // The extraction result produced under a stale owner must not have been
    // persisted onto the original clip.
    expect(saved?.snapshot.clip.poseSequence).toBeUndefined();
  });

  it('ATTACK C7: two concurrent replays of the same saved operation extract at most once and charge at most once', async () => {
    const input = await runnerSetup();
    const [first, second] = await Promise.all([input.run(), input.run()]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toContain('scored');
    expect(input.reservations.size).toBe(1);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    expect(input.store.count('outbox', OWNER)).toBe(2);
    expect(extractPose.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
