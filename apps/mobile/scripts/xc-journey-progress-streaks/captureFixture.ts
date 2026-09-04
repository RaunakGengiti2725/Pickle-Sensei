import type { CapturedClip, CaptureEvidenceV1 } from '../../src/camera/capture';
import type { PendingCapture } from '../../src/data/repository';

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;

/** A guided-camera capture that passes `isVerifiedPracticeCapture`. */
export function verifiedCapture(
  id: string,
  capturedAtIso: string,
): PendingCapture {
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount: 4,
    poseMissingFrameCount: 1,
    analysisInputFrameCount: 5,
    trackedDurationMs: 300,
    meanCanonicalJointVisibility: 0.8,
    meanJointCoverage: 0.75,
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
  const uri = `file:///captures/${id}.mov`;
  const clip: AutomaticClip = {
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}
