import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';

export function guidedClipFixture(id: string): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence();
  const preRollMs = 2000;
  const postRollMs = 1500;
  const durationMs = window.endMs + preRollMs + postRollMs;
  const sidecarJson = serializePoseSequence({
    ...sequence,
    frames: sequence.frames.map(frame => ({
      ...frame,
      timestampMs: frame.timestampMs + preRollMs,
    })),
  });
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: `${id}.mov`,
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    durationMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs + preRollMs,
      endMs: window.endMs + preRollMs,
      peakMotionMs: window.peakMs + preRollMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
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
    preRollMs,
    postRollMs,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}
