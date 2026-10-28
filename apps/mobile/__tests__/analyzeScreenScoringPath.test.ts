// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure scoring-gate logic under test never touches
// it, so the db module is replaced wholesale.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { clipSupportsScoring } from '../src/screens/AnalyzeScreen';
import { assertCapturedClip } from '../src/camera/capture';

/**
 * Saved-phase scoring state machine (AnalyzeScreen).
 *
 * The product contract: guided captures score from their recorded pose
 * sequence; imported videos always enter the scoring flow (declare stroke →
 * analyze, with the player selected automatically).
 * This locks in the branch that a narrowing bug once made unreachable.
 */

const baseClip = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
};

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
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const automaticClipWithoutPoseSequence = assertCapturedClip({
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
});

const automaticClipWithPoseSequence = assertCapturedClip({
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
  poseSequence: {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///private/var/mobile/clip.pose.json',
    frameCount: 6,
    sha256: 'a'.repeat(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  },
});

const importedClip = assertCapturedClip({
  ...baseClip,
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

describe('AnalyzeScreen saved-phase scoring gate', () => {
  it('admits guided captures only when the recorded pose sequence exists', () => {
    expect(clipSupportsScoring(automaticClipWithPoseSequence)).toBe(true);
    expect(clipSupportsScoring(automaticClipWithoutPoseSequence)).toBe(false);
  });

  it('always admits imported videos', () => {
    expect(clipSupportsScoring(importedClip)).toBe(true);
  });
});
