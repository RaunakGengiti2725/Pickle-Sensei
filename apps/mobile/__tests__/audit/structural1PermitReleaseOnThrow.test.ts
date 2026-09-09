import {
  createCaptureAnalysisDb,
  captureDbState,
  fixtureUuid,
  signInCaptureOwner,
  closeCaptureHarness,
  seedCaptureRequest,
} from '../../testSupport/captureAnalysisHarness';
/**
 * Structural audit #1 (mobile-analyze-capture) — permit lifecycle when the
 * post-reservation path THROWS instead of returning a typed failure.
 *
 * Invariant under test (AGENTS.md / runCaptureAnalysis.ts): a reserved
 * permit is consumed only by the sync transaction of a scored result and is
 * otherwise released with a reason. These cases exercise exceptions raised
 * AFTER `permits.reserve()` succeeded: local persistence failures
 * (saveAnalysisRecord / markCaptureAnalyzed / saveAnalysis) and an
 * `analyzeCapture` throw. Each case asserts that the client releases the
 * permit before the exception escapes.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  activeReleaseAuthority,
  isReleasePolicyRequest,
} from '../../testSupport/releasePolicyFixture';
import { finalizeAcknowledgement } from '../../__harness__/analysisPermitRoute';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return {
    ...actual,
    analyzeCapture: (...args: unknown[]) =>
      mockAnalyzeCapture
        ? mockAnalyzeCapture()
        : (actual.analyzeCapture as (...a: unknown[]) => unknown)(...args),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
let mockAnalyzeCapture: (() => Promise<unknown>) | null = null;

const owner = '11111111-1111-4111-8111-111111111111';

function throwingDb(failWhen: (sql: string) => boolean) {
  return createCaptureAnalysisDb(sql => {
    if (failWhen(sql)) throw new Error('SQLITE_FULL: database or disk is full');
  });
}

function permitServer(): {
  fetchMock: jest.Mock;
  finalized: Array<{ url: string; body: unknown }>;
} {
  const finalized: Array<{ url: string; body: unknown }> = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse({
        permit: {
          id: fixtureUuid('permit-leak-1'),
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
        access: {
          premium: false,
          entitlements: [],
          freeRatings: {
            limit: 2,
            used: 0,
            reserved: 1,
            remaining: 2,
            availableToReserve: 1,
          },
          canStartRating: true,
          paywallRequired: false,
        },
      });
    }
    if (url.includes('/finalize')) {
      const body: unknown = JSON.parse(String(init?.body));
      finalized.push({ url, body });
      return jsonResponse(finalizeAcknowledgement(url, body));
    }
    if (isReleasePolicyRequest(url))
      return jsonResponse(activeReleaseAuthority());
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-leak.mov',
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
      trackedDurationMs: window.endMs - window.startMs,
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
      uri: 'file:///captures/stroke-leak.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    ...seedCaptureRequest(db, clip, 'capture-leak-1'),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

describe('structural audit #1 — permit release when the post-reservation path throws', () => {
  beforeEach(() => {
    signInCaptureOwner(owner);
    mockAnalyzeCapture = null;
  });
  afterEach(() => {
    closeCaptureHarness();
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('releases the permit when saveAnalysisRecord throws after reservation', async () => {
    const { db } = throwingDb(sql => sql.includes('local_analysis_record'));
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'SQLITE_FULL',
    );

    const reserveCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/analysis-permits'),
    );
    expect(reserveCalls).toHaveLength(1);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.url).toContain(
      `/${fixtureUuid('permit-leak-1')}/finalize`,
    );
    expect(finalized[0]!.body).toMatchObject({ outcome: 'failed' });
  });

  it('releases the permit when markCaptureAnalyzed throws after reservation', async () => {
    const { db } = throwingDb(sql => sql.includes("SET status = 'analyzed'"));
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'SQLITE_FULL',
    );
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.body).toMatchObject({ outcome: 'failed' });
  });

  it('releases the permit when saveAnalysis (local_shot / outbox) throws after reservation', async () => {
    const { db } = throwingDb(sql =>
      sql.includes('INSERT OR REPLACE INTO local_shot'),
    );
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'SQLITE_FULL',
    );
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.body).toMatchObject({ outcome: 'failed' });
  });

  it('releases the permit when analyzeCapture throws (not a typed !ok result)', async () => {
    const { db } = throwingDb(() => false);
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    mockAnalyzeCapture = async () => {
      throw new TypeError('pose frame joints undefined');
    };
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    await expect(runCaptureAnalysis(request(db, clip))).rejects.toThrow(
      'pose frame joints undefined',
    );
    expect(captureDbState(db)).toMatchObject({
      shots: 0,
      records: 0,
      outbox: 0,
      journal: [
        expect.objectContaining({
          state: 'released',
          release_outcome: 'failed',
        }),
      ],
    });
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.body).toMatchObject({ outcome: 'failed' });
  });
});
