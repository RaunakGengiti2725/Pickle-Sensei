// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure scoring-gate logic under test never touches
// it, so the db module is replaced wholesale.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import {
  clipSupportsScoring,
  importedClipNeedsTargetTap,
} from '../src/screens/AnalyzeScreen';
import { assertCapturedClip } from '../src/camera/capture';
import type { TargetSelection } from '../src/camera/TargetSelector';

/**
 * Saved-phase scoring state machine (AnalyzeScreen).
 *
 * The product contract: guided captures score from their recorded pose
 * sequence; imported videos enter the scoring flow through the
 * tap-the-person selector (declare stroke → tap yourself → analyze).
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
  recognition: { status: 'unknown', reason: 'validated_classifier_unavailable' },
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
  recognition: { status: 'unknown', reason: 'validated_classifier_unavailable' },
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

const seed: TargetSelection = {
  point: { x: 0.42, y: 0.63 },
  selectedAtIso: '2026-08-28T00:00:00.000Z',
};

describe('AnalyzeScreen saved-phase scoring gate', () => {
  it('admits guided captures only when the recorded pose sequence exists', () => {
    expect(clipSupportsScoring(automaticClipWithPoseSequence)).toBe(true);
    expect(clipSupportsScoring(automaticClipWithoutPoseSequence)).toBe(false);
  });

  it('always admits imported videos so the tap-the-person path is reachable', () => {
    expect(clipSupportsScoring(importedClip)).toBe(true);
  });

  it('requires the target tap for imported clips once a stroke is declared', () => {
    expect(
      importedClipNeedsTargetTap(importedClip, 'forehand_drive', null),
    ).toBe(true);
  });

  it('waits for a stroke declaration before asking for the tap', () => {
    expect(importedClipNeedsTargetTap(importedClip, null, null)).toBe(false);
  });

  it('stops asking once a target seed is confirmed', () => {
    expect(
      importedClipNeedsTargetTap(importedClip, 'forehand_drive', seed),
    ).toBe(false);
  });

  it('never asks guided captures for a tap — their seed was locked live', () => {
    expect(
      importedClipNeedsTargetTap(
        automaticClipWithPoseSequence,
        'forehand_drive',
        null,
      ),
    ).toBe(false);
  });
});
