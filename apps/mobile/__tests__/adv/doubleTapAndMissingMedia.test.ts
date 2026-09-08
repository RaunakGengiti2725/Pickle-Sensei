import { sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import * as captureRunner from '../../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../../src/analysis/originalAnalysisOperations';
import { captureDataOwnerContext } from '../../src/data/accountScope';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../../src/camera/capture';
import { listShots } from '../../src/data/repository';
import { drainOutbox } from '../../src/data/sync';
import { closeSqliteTestDatabases } from '../../testSupport/sqlite';
import {
  ADV_API_ORIGIN,
  ADV_OWNER_A,
  advFixture,
  advOpenDb,
  advRows,
  advSeedCapture,
  advServer,
  advSignIn,
  advSignOut,
  advTransport,
  deferred,
  type AdvStore,
} from '../../testSupport/advJourneyHarness';

/**
 * ATTACK AREA: repeated actions and double taps on the "Rate this swing"
 * path the screen actually uses (`prepareOriginalCaptureAnalysis` with a
 * fresh operation id per tap, then `runOriginalCaptureAnalysis`), plus
 * missing/changed media and a slow native decoder during an import.
 *
 * Money invariant under attack: two taps must never reserve or charge two
 * permits, never write two shots, and never enqueue two uploads.
 */

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});
jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));

const CAPTURE = '33333333-3333-4333-8333-333333333333';
const SESSION = '55555555-5555-4555-8555-555555555555';
const TAP_1 = '44444444-4444-4444-8444-444444444441';
const TAP_2 = '44444444-4444-4444-8444-444444444442';
const originalFetch = globalThis.fetch;
const verifyBytes = jest.mocked(verifyCapturedClipCurrentBytes);
const leases: OriginalAnalysisExecution[] = [];

function importedClip(noPose = false): {
  clip: CapturedClip;
  sidecar: string;
  pose: NonNullable<CapturedClip['poseSequence']>;
} {
  const { clip: base, sidecar } = advFixture('import');
  const pose = base.poseSequence!;
  const clip: CapturedClip = {
    ...base,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'import.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
  };
  if (noPose) delete clip.poseSequence;
  return { clip, sidecar, pose };
}

function execution() {
  const lease = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ADV_API_ORIGIN,
  );
  leases.push(lease);
  return lease;
}

async function seeded(noPose = false) {
  const store = advOpenDb();
  const { clip, sidecar, pose } = importedClip(noPose);
  advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', ADV_OWNER_A, CAPTURE],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  jest.mocked(extractImportedPoseSequence).mockResolvedValue({
    poseSequence: pose,
    framesWithPose: pose.frameCount,
    framesTotal: pose.frameCount,
  });
  const http = advServer();
  globalThis.fetch = http.fetchPort;
  return { store, clip, sidecar, pose, http };
}

function screenRequest(
  store: AdvStore,
  clip: CapturedClip,
): captureRunner.RunCaptureAnalysisRequest {
  return {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ADV_API_ORIGIN, token: 'request-time-token' },
    sessionId: SESSION,
    practiceSet: {
      owner: ADV_OWNER_A,
      sessionId: SESSION,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-06T12:00:00.000Z',
      nowIso: '2026-09-06T12:00:00.000Z',
    },
  };
}

/** One "Rate" tap exactly as AnalyzeScreen performs it. */
async function tap(
  store: AdvStore,
  clip: CapturedClip,
  lease: OriginalAnalysisExecution,
  mintedOperationId: string,
) {
  const operation = await captureRunner.prepareOriginalCaptureAnalysis(
    screenRequest(store, clip),
    lease,
    mintedOperationId,
  );
  const outcome = await captureRunner.runOriginalCaptureAnalysis({
    db: store.db,
    execution: lease,
    operationId: operation.operationId,
  });
  return { operation, outcome };
}

beforeEach(() => {
  advSignIn(ADV_OWNER_A);
  verifyBytes.mockReset();
  verifyBytes.mockImplementation(async clip => ({
    status: 'verified-current-bytes',
    comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
  }));
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
  jest.mocked(readCaptureArtifact).mockReset();
  jest.mocked(extractImportedPoseSequence).mockReset();
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  advSignOut();
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('double tap on Rate (two minted operation ids, same capture)', () => {
  it('sequential double tap: the second tap replays the first result and never reserves, scores or enqueues again', async () => {
    const { store, clip, http } = await seeded();
    const lease = execution();
    const first = await tap(store, clip, lease, TAP_1);
    expect(first.outcome.kind).toBe('scored');
    const second = await tap(store, clip, lease, TAP_2);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(second.outcome.kind).toBe('scored');
    if (first.outcome.kind === 'scored' && second.outcome.kind === 'scored')
      expect(second.outcome.analysisId).toBe(first.outcome.analysisId);
    expect(http.reservations.size).toBe(1);
    expect(http.requests(/analysis-permits$/)).toHaveLength(1);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(1);
    expect(
      advRows(store, 'analysis_logical_operations', ADV_OWNER_A),
    ).toHaveLength(1);
    expect(
      advRows(store, 'analysis_execution_attempts', ADV_OWNER_A),
    ).toHaveLength(1);
    expect(
      advRows(store, 'outbox', ADV_OWNER_A).filter(
        row => row.kind === 'shot.sync',
      ),
    ).toHaveLength(1);
    expect(
      await drainOutbox(store.db, advTransport(ADV_OWNER_A)),
    ).toMatchObject({
      failed: 0,
      remaining: 0,
    });
    expect(http.charged).toBe(1);
    expect(jest.mocked(pipeline.analyzeCapture)).toHaveBeenCalledTimes(1);
  });

  it('concurrent double tap: two overlapping taps produce one reservation, one score, one upload', async () => {
    const { store, clip, http } = await seeded();
    const leaseA = execution();
    const leaseB = execution();
    const [a, b] = await Promise.all([
      tap(store, clip, leaseA, TAP_1),
      tap(store, clip, leaseB, TAP_2),
    ]);
    expect(a.operation.operationId).toBe(b.operation.operationId);
    const kinds = [a.outcome.kind, b.outcome.kind].sort();
    // One tap must win with a score; the other may replay it or be told to wait.
    expect(kinds).toContain('scored');
    for (const outcome of [a.outcome, b.outcome])
      expect(['scored', 'unavailable']).toContain(outcome.kind);
    expect(http.reservations.size).toBe(1);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(1);
    expect(
      advRows(store, 'analysis_execution_attempts', ADV_OWNER_A),
    ).toHaveLength(1);
    expect(
      advRows(store, 'outbox', ADV_OWNER_A).filter(
        row => row.kind === 'shot.sync',
      ),
    ).toHaveLength(1);
    await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(http.charged).toBe(1);
    expect(jest.mocked(pipeline.analyzeCapture)).toHaveBeenCalledTimes(1);
    expect(await listShots(store.db)).toHaveLength(1);
  });

  it('second tap arriving while the first is still inside inference does not start a second inference or reservation', async () => {
    const { store, clip, http } = await seeded();
    const gate = deferred<void>();
    const actual = jest.requireActual<typeof pipeline>(
      '@pickle/analysis-pipeline',
    ).analyzeCapture;
    jest
      .mocked(pipeline.analyzeCapture)
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return actual(...args);
      });
    const leaseA = execution();
    const leaseB = execution();
    const first = tap(store, clip, leaseA, TAP_1);
    for (let index = 0; index < 200 && http.reservations.size === 0; index += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(http.reservations.size).toBe(1);
    const second = await tap(store, clip, leaseB, TAP_2);
    expect(second.outcome.kind).toBe('unavailable');
    if (second.outcome.kind === 'unavailable')
      expect(second.outcome.cause).toBe('recovery_pending');
    expect(http.reservations.size).toBe(1);
    expect(jest.mocked(pipeline.analyzeCapture)).toHaveBeenCalledTimes(1);
    gate.resolve();
    const done = await first;
    expect(done.outcome.kind).toBe('scored');
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(1);
    // The impatient second tap, retried after the first completes, replays.
    const third = await tap(store, clip, leaseB, TAP_2);
    expect(third.outcome.kind).toBe('scored');
    expect(http.reservations.size).toBe(1);
    await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(http.charged).toBe(1);
  });
});

describe('missing or changed media on an import', () => {
  it('media deleted from the device before Rate: no reservation, no score, honest non-scored outcome, retry after restore rates once', async () => {
    const { store, clip, http } = await seeded(true);
    verifyBytes.mockResolvedValueOnce({ status: 'mismatch' });
    const lease = execution();
    const outcome = await tap(store, clip, lease, TAP_1);
    expect(outcome.outcome.kind).not.toBe('scored');
    expect(http.reservations.size).toBe(0);
    expect(jest.mocked(extractImportedPoseSequence)).not.toHaveBeenCalled();
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    expect(advRows(store, 'outbox', ADV_OWNER_A)).toHaveLength(0);
    // The saved operation survives and rates once when bytes verify again.
    const again = await tap(store, clip, lease, TAP_2);
    expect(again.operation.operationId).toBe(outcome.operation.operationId);
    expect(again.outcome.kind).toBe('scored');
    expect(http.reservations.size).toBe(1);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(1);
  });

  it('native byte comparison unavailable (permission revoked / native reader busy): held without spending a permit', async () => {
    const { store, clip, http } = await seeded(true);
    verifyBytes.mockResolvedValueOnce({ status: 'unavailable' });
    const outcome = await tap(store, clip, execution(), TAP_1);
    expect(outcome.outcome.kind).not.toBe('scored');
    expect(http.reservations.size).toBe(0);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    expect(
      advRows(store, 'analysis_execution_attempts', ADV_OWNER_A),
    ).toHaveLength(0);
  });

  it('pose sidecar tampered on disk after capture: hash mismatch never becomes a scored shot or a reservation', async () => {
    const { store, clip, sidecar, http } = await seeded();
    const tampered = JSON.stringify({
      ...(JSON.parse(sidecar) as Record<string, unknown>),
      producedBy: { modelVersion: 'attacker' },
    });
    jest.mocked(readCaptureArtifact).mockResolvedValue(tampered);
    const outcome = await tap(store, clip, execution(), TAP_1);
    expect(outcome.outcome.kind).not.toBe('scored');
    expect(http.reservations.size).toBe(0);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    expect(advRows(store, 'outbox', ADV_OWNER_A)).toHaveLength(0);
    expect(jest.mocked(pipeline.analyzeCapture)).not.toHaveBeenCalled();
  });

  it('slow native decoder that eventually fails: no reservation is opened before pose evidence exists', async () => {
    const { store, clip, http } = await seeded(true);
    jest
      .mocked(extractImportedPoseSequence)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('Native decoder timed out')), 30),
          ),
      );
    const outcome = await tap(store, clip, execution(), TAP_1);
    expect(outcome.outcome.kind).toBe('unavailable');
    expect(http.reservations.size).toBe(0);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    // The capture row keeps no partial pose evidence.
    const capture = advRows(store, 'local_capture', ADV_OWNER_A)[0];
    expect(String(capture?.clip_payload ?? capture?.payload ?? '')).not.toMatch(
      /"poseSequence"/,
    );
  });
});
