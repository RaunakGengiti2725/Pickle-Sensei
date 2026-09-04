/**
 * xc-matrix::XC-ADJ-VIS-1 — adversarial pin (attack branch devin/attack-fix-322511d1).
 *
 * The candidate routes every `evaluateCaptureQuality` reason through
 * `evaluatePreAnalysisGate` on the phone path (`runCaptureAnalysis`). One of
 * those reasons is `insufficient_fps` (effective pose FPS < 24). The capture
 * envelope (`packages/capture-envelope/src/thresholds.ts`,
 * `frame_rate.supported.min = 24`) declares 24 fps SUPPORTED, and the native
 * import path keeps every frame of a 24 fps recording with timestamps rounded
 * to whole milliseconds. At 24 fps the ideal spacing is 41.666… ms, so for a
 * third of all clip lengths — and for EVERY clip length once a single pose
 * frame is missing — the rounded span measures 23.996 fps and the pristine,
 * fully visible, gap-free swing is refused with the copy "the player was not
 * tracked well enough through the stroke … Nothing was rated". A permit is
 * reserved and handed back as `unsupported`. Baseline 4d812e1a scored the
 * same clip.
 *
 *   cd apps/mobile && npx jest --ci __tests__/xc/attack/twentyFourFpsPhonePath.attack.test.ts
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { CapturedClip } from '../../../src/camera/capture';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import { createFakeLocalDb } from '../../../testing/xcBehavioral/fakeLocalDb';

let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));
jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

import { runCaptureAnalysis } from '../../../src/analysis/runCaptureAnalysis';

const OWNER = '22222222-2222-4222-8222-222222222222';
const API = { baseUrl: 'https://api.test', token: 'bearer-token' };

function clipFor(
  id: string,
  sequence: PoseSequence,
  window: { startMs: number; endMs: number; peakMs: number },
): { clip: CapturedClip; sidecarJson: string } {
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 24,
    width: 1080,
    height: 1920,
    capturedAtIso: '2026-09-04T09:00:00.000Z',
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
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function permitServer() {
  const releases: Array<{ permitId: string; outcome: string }> = [];
  let reserves = 0;
  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    }) as unknown as Response;
  const fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserves += 1;
      return json(200, {
        permit: {
          id: `permit-${reserves}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T09:10:00.000Z',
        },
        access: { premium: false, freeRatings: { availableToReserve: 1 } },
      });
    }
    const match = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
    if (match) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        outcome?: string;
      };
      releases.push({
        permitId: decodeURIComponent(match[1]!),
        outcome: body.outcome ?? '',
      });
      return json(200, { ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return {
    fetch,
    get reserves() {
      return reserves;
    },
    releases,
  };
}

const originalFetch = globalThis.fetch;
let server: ReturnType<typeof permitServer>;

beforeEach(() => {
  setActiveDataOwner(OWNER);
  server = permitServer();
  globalThis.fetch = server.fetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function run(
  clip: CapturedClip,
  fake: ReturnType<typeof createFakeLocalDb>,
) {
  return runCaptureAnalysis({
    db: fake.db,
    captureId: `capture-${clip.uri}`,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: API,
    appVersion: '1.0.0-xc',
    sessionId: null,
  });
}

describe('xc attack: envelope-supported 24 fps footage on the phone path', () => {
  it('a pristine 24 fps swing is rated, not refused as insufficient_fps', async () => {
    // recoverMs=500 → 47 frames; (47 − 1) ≡ 1 (mod 3) → span rounds to
    // 1917 ms → 23.996 effective fps. Every frame is full-body, visibility
    // 0.95, zero gaps.
    const { sequence, window } = generateSwingSequence({
      fps: 24,
      recoverMs: 500,
    });
    const { clip, sidecarJson } = clipFor('pristine-24fps', sequence, window);
    mockReadArtifact = async () => sidecarJson;
    const fake = createFakeLocalDb();

    const outcome = await run(clip, fake);

    expect(outcome.kind).not.toBe('quality_blocked');
    expect(server.reserves).toBe(1);
    expect(server.releases.map(r => r.outcome)).not.toContain('unsupported');
  });

  it('a 24 fps swing missing ONE pose frame is rated, not refused', async () => {
    const { sequence, window } = generateSwingSequence({
      fps: 24,
      recoverMs: 600,
    });
    // An ordinary single Vision miss mid-clip: an 83 ms hole, far below the
    // 700 ms dropout gate and the 120 ms torso-anchor gate.
    const dropped: PoseSequence = {
      ...sequence,
      frames: sequence.frames.filter((_, index) => index !== 10),
    };
    const { clip, sidecarJson } = clipFor('one-miss-24fps', dropped, window);
    mockReadArtifact = async () => sidecarJson;
    const fake = createFakeLocalDb();

    const outcome = await run(clip, fake);

    expect(outcome.kind).not.toBe('quality_blocked');
    expect(server.releases.map(r => r.outcome)).not.toContain('unsupported');
  });
});
