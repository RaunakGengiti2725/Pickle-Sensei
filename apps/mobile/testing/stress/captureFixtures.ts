/**
 * Seed-driven native payload generator for the capture boundary. Every
 * payload is tagged with a unique `uri` so a burst can prove that the value a
 * caller receives is the value native produced FOR THAT CALL (no cross-talk
 * between interleaved promises). Values are contract-shape placeholders —
 * no measurement claims.
 */
import type { CaptureQualitySignalsV1 } from '../../src/camera/capture';
import { pick, randomInt, type Rng } from './harness';

export const ODD_FPS: readonly number[] = [
  0, 1, 7.5, 12, 15, 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90,
  100, 119.88, 120, 239.76, 240, 1000,
];

export const ODD_ASPECT: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 3],
  [144, 176],
  [320, 240],
  [480, 640],
  [640, 360],
  [720, 1280],
  [1080, 1920],
  [1920, 1080],
  [1, 4096],
  [4096, 1],
  [2160, 3840],
  [4032, 3024],
  [7680, 4320],
];

export const ODD_DURATION_MS: readonly number[] = [
  1, 16, 250, 900, 1500, 2100, 4200, 9000, 30000, 120000, 3600000,
];

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
  schemaVersion: 1,
  window: 'detected_motion',
  poseSource: 'apple_vision_body_pose',
  poseModelVersion: 'apple-vision-bodypose-1',
  triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
  motionUnit: 'normalized_image_units_per_second',
  analysisInputFrameCount: 7,
  poseFrameCount: 6,
  poseMissingFrameCount: 1,
  trackedDurationMs: 620,
  meanCanonicalJointVisibility: 0.88,
  meanJointCoverage: 0.94,
  minimumJointCoverage: 0.83,
  fullBodyVisibleFrameCount: 4,
  jointMotion: [
    {
      joint: 'left_shoulder',
      sampleCount: 3,
      meanNormalizedPerSecond: 0.3,
      peakNormalizedPerSecond: 0.7,
    },
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

export function automaticClipPayload(uri: string): Record<string, unknown> {
  return {
    uri,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: { ...trigger },
    captureEvidence: {
      ...captureEvidence,
      jointMotion: captureEvidence.jointMotion.map(j => ({ ...j })),
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
  };
}

export function importedClipPayload(uri: string): Record<string, unknown> {
  return {
    uri,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

export function poseExtractionPayload(
  seedTag: string,
): Record<string, unknown> {
  return {
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/var/mobile/pose-${seedTag}.json`,
      sha256: 'a'.repeat(64),
      frameCount: 120,
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
    framesWithPose: 110,
    framesTotal: 120,
  };
}

/**
 * Malformed native payload families the boundary MUST reject. Each mutation
 * is named so a failing seed's table row says which one leaked through.
 * "Frame drop" and "device denial" here are the payload-level shapes a
 * dropping or denied camera pipeline could hand back (missing/inconsistent
 * frame counts, zero-size frames), not a claim about the Swift pipeline.
 */
export const MALFORMED_MUTATIONS: ReadonlyArray<{
  name: string;
  apply: (p: Record<string, unknown>) => void;
}> = [
  { name: 'fps_negative', apply: p => (p.fps = -30) },
  { name: 'fps_nan', apply: p => (p.fps = Number.NaN) },
  { name: 'fps_infinite', apply: p => (p.fps = Number.POSITIVE_INFINITY) },
  { name: 'fps_string', apply: p => (p.fps = '59.94') },
  { name: 'width_zero', apply: p => (p.width = 0) },
  { name: 'height_zero', apply: p => (p.height = 0) },
  { name: 'width_fractional', apply: p => (p.width = 719.5) },
  { name: 'height_negative', apply: p => (p.height = -1280) },
  { name: 'duration_zero', apply: p => (p.durationMs = 0) },
  { name: 'duration_nan', apply: p => (p.durationMs = Number.NaN) },
  { name: 'uri_not_file', apply: p => (p.uri = 'https://example.invalid/x') },
  { name: 'uri_empty', apply: p => (p.uri = '') },
  { name: 'captured_at_garbage', apply: p => (p.capturedAtIso = 'yesterday') },
  { name: 'mode_unknown', apply: p => (p.captureMode = 'live_stream') },
  { name: 'recognition_missing', apply: p => delete p.recognition },
  {
    name: 'payload_null',
    apply: p => Object.keys(p).forEach(k => delete p[k]),
  },
  {
    name: 'frame_drop_inconsistent_counts',
    apply: p => {
      const ev = p.captureEvidence as Record<string, unknown> | undefined;
      if (ev) ev.analysisInputFrameCount = 99;
      else p.trigger = { ...trigger }; // imported clip may not carry a trigger
    },
  },
  {
    name: 'frame_drop_zero_pose_frames',
    apply: p => {
      const ev = p.captureEvidence as Record<string, unknown> | undefined;
      if (ev) ev.poseFrameCount = 0;
      else p.preRollMs = 2000;
    },
  },
  {
    name: 'trigger_outside_clip',
    apply: p => {
      const t = p.trigger as Record<string, unknown> | undefined;
      if (t) t.endMs = 999_999;
      else p.completion = { schemaVersion: 1 };
    },
  },
  {
    name: 'ball_speed_analysis_not_run_on_automatic',
    apply: p => {
      if (p.captureMode === 'automatic_pose_trigger') {
        p.ballSpeed = { status: 'unavailable', reason: 'analysis_not_run' };
      } else {
        p.ballSpeed = { status: 'unavailable', reason: 'tracker_unavailable' };
      }
    },
  },
];

export interface PlannedPayload {
  kind: 'valid' | 'malformed';
  mutation: string | null;
  payload: Record<string, unknown>;
}

export function planClipPayload(
  random: Rng,
  mode: 'automatic_pose_trigger' | 'imported_video',
  uri: string,
  malformedProbability = 0.35,
): PlannedPayload {
  const payload =
    mode === 'automatic_pose_trigger'
      ? automaticClipPayload(uri)
      : importedClipPayload(uri);
  // Odd-but-legal geometry on VALID payloads: the boundary is structural,
  // the envelope judges quality. A legal odd fps/aspect must never be
  // rejected as malformed.
  if (random() < 0.5) {
    payload.fps = pick(random, ODD_FPS);
    const [w, h] = pick(random, ODD_ASPECT);
    payload.width = w;
    payload.height = h;
  }
  if (random() < malformedProbability) {
    const mutation = pick(random, MALFORMED_MUTATIONS);
    mutation.apply(payload);
    return { kind: 'malformed', mutation: mutation.name, payload };
  }
  return { kind: 'valid', mutation: null, payload };
}

export function qualitySignals(
  random: Rng,
  overrides: Partial<CaptureQualitySignalsV1> = {},
): CaptureQualitySignalsV1 {
  const [w, h] = pick(random, ODD_ASPECT);
  return {
    schemaVersion: 1,
    frameWidthPx: random() < 0.15 ? null : w,
    frameHeightPx: random() < 0.15 ? null : h,
    avgFrameRateFps: random() < 0.15 ? null : pick(random, ODD_FPS),
    brightnessMeanLuma: random() < 0.2 ? null : randomInt(random, 0, 255),
    laplacianVarianceMedian: random() < 0.2 ? null : randomInt(random, 0, 800),
    meanAbsFrameDiff: random() < 0.2 ? null : random() * 40,
    sampledFrameCount: randomInt(random, 0, 240),
    ...overrides,
  };
}

export const READINESS_STATES = [
  'no_person',
  'full_body_required',
  'move_closer',
  'move_farther',
  'hold_still',
  'ready',
] as const;
