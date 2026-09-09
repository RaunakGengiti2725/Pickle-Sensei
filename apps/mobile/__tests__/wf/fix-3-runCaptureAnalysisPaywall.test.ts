import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';
import {
  PAYWALL_REQUIRED_CODE,
  runCaptureAnalysis,
} from '../../src/analysis/runCaptureAnalysis';
import {
  activeReleaseAuthorityResponse,
  isReleasePolicyRequest,
  permitCalls,
} from '../../testSupport/releasePolicyFixture';

/**
 * A reserve refused with HTTP 402 `access.paywall_required` is an
 * entitlement decision, not an outage: the outcome must say so, so the
 * screen can offer the upgrade instead of a retry that can never succeed.
 */

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '11111111-1111-4111-8111-111111111111';

function recordingDb(): { db: LocalDb; calls: string[] } {
  const store = createSqliteTestDb();
  const calls: string[] = [];
  store.observeStatements(call => calls.push(call.sql));
  return { db: store.db, calls };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({ error: { code, message } }),
  } as unknown as Response;
}

function refusingServer(response: Response): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.endsWith('/v1/analysis-permits')) return response;
    if (isReleasePolicyRequest(url)) return activeReleaseAuthorityResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function expectReserveRequest(fetchMock: jest.Mock): void {
  expect(permitCalls(fetchMock)).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.test/v1/analysis-permits',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
    }),
  );
}

async function expectPendingReservation(
  db: LocalDb,
  lastHttpStatus: number | null,
): Promise<void> {
  const journal = await db.execute(
    `SELECT owner_key, api_origin, state, release_outcome, terminal_reason,
            last_http_status, permit_id, result_id FROM analysis_run_journal`,
  );
  expect(journal.rows).toEqual([
    {
      owner_key: owner,
      api_origin: 'https://api.test',
      state: 'release_pending',
      release_outcome: 'failed',
      terminal_reason: null,
      last_http_status: lastHttpStatus,
      permit_id: null,
      result_id: null,
    },
  ]);
  for (const table of ['local_analysis_record', 'local_shot', 'outbox']) {
    const { rows } = await db.execute(`SELECT count(*) AS n FROM ${table}`);
    expect(rows).toEqual([{ n: 0 }]);
  }
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  // Reserve tests must use metadata from these exact bytes, not a native model label.
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-abc.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/stroke-abc.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  const captureId = '77777777-7777-4777-8777-777777777777';
  seedSqliteCapture(db, owner, captureId, clip);
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '1.0',
  };
}

describe('runCaptureAnalysis — paywall-required reserve refusals', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    establishApiSession({
      canonicalAppUserId: owner,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      provider: 'apple',
    });
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    setApiUnauthorizedListener(null);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('a 402 access.paywall_required refusal preserves its cause and journals the rejection without a result', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = refusingServer(
      errorResponse(
        402,
        PAYWALL_REQUIRED_CODE,
        'Your free ratings are used up. Upgrade to Pro to keep rating.',
      ),
    );
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expectReserveRequest(fetchMock);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBe('paywall_required');
    expect(outcome.reason).toContain('Upgrade to Pro');
    expect(
      calls.some(
        sql =>
          sql.includes('INSERT INTO local_analysis_record') ||
          sql.includes('INSERT INTO outbox'),
      ),
    ).toBe(false);
    const journal = await db.execute(
      'SELECT state, terminal_reason FROM analysis_run_journal',
    );
    expect(journal.rows).toEqual([
      { state: 'terminal', terminal_reason: 'reservation_rejected' },
    ]);
  });

  it('a 503 outage keeps the plain unavailable shape so the screen still offers a retry', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = refusingServer(
      errorResponse(
        503,
        'server.unavailable',
        'The rating service is temporarily unavailable.',
      ),
    );
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expectReserveRequest(fetchMock);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(outcome.reason).toContain('temporarily unavailable');
    await expectPendingReservation(db, 503);
  });

  it('a network failure (no ApiError) stays a retryable unavailable outcome', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = jest.fn(async (url: string) => {
      if (isReleasePolicyRequest(url)) return activeReleaseAuthorityResponse();
      if (url !== 'https://api.test/v1/analysis-permits') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      throw new TypeError('Network request failed');
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip));
    expectReserveRequest(fetchMock);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(outcome.reason).toContain('could not be reached');
    await expectPendingReservation(db, null);
  });

  it.each([
    {
      status: 401,
      code: 'auth.invalid',
      message: 'The identity token could not be verified.',
    },
    {
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests. Try again later.',
    },
  ])(
    'a $status reserve refusal holds the original reservation for recovery without a paywall cause',
    async ({ status, code, message }) => {
      const { db } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const fetchMock = refusingServer(errorResponse(status, code, message));
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      const unauthorized = jest.fn();
      setApiUnauthorizedListener(unauthorized);

      const outcome = await runCaptureAnalysis(request(db, clip));
      expectReserveRequest(fetchMock);
      expect(outcome).toEqual({ kind: 'unavailable', reason: message });
      await expectPendingReservation(db, status);
      expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      if (status === 401) {
        expect(unauthorized).toHaveBeenCalledWith({
          canonicalAppUserId: owner,
          apiBaseUrl: 'https://api.test',
          bearerToken: 'token-1',
          provider: 'apple',
        });
      }
    },
  );
});
