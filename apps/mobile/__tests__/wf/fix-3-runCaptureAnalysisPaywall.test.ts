import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import {
  PAYWALL_REQUIRED_CODE,
  runCaptureAnalysis,
} from '../../src/analysis/runCaptureAnalysis';

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
  const calls: string[] = [];
  const db: LocalDb = {
    async execute(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
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
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-abc.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
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
      poseModelVersion: 'apple-vision-bodypose-1',
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
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: 'capture-1',
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '1.0',
  };
}

describe('runCaptureAnalysis — paywall-required reserve refusals', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('a 402 access.paywall_required refusal is surfaced with cause paywall_required and writes nothing', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    (globalThis as { fetch?: unknown }).fetch = refusingServer(
      errorResponse(
        402,
        PAYWALL_REQUIRED_CODE,
        'Your free ratings are used up. Upgrade to Pro to keep rating.',
      ),
    );

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBe('paywall_required');
    expect(outcome.reason).toContain('Upgrade to Pro');
    expect(calls).toHaveLength(0);
  });

  it('a 503 outage keeps the plain unavailable shape so the screen still offers a retry', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    (globalThis as { fetch?: unknown }).fetch = refusingServer(
      errorResponse(
        503,
        'server.unavailable',
        'The rating service is temporarily unavailable.',
      ),
    );

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(outcome.reason).toContain('temporarily unavailable');
  });

  it('a network failure (no ApiError) stays a retryable unavailable outcome', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(outcome.reason).toContain('could not be reached');
  });
});
