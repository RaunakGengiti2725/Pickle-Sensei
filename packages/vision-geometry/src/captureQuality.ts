import type { PoseSequence } from "@pickle/swing-domain";
import { mean, median } from "./kinematics.js";

/**
 * Capture analyzability — decided BEFORE scoring, from measured pose data
 * only. A recording that fails here must never produce a confident score;
 * every failure carries a specific, user-actionable reason code.
 *
 * Checks that require signals we do not measure yet (camera shake without
 * background features, paddle visibility without a paddle model) are NOT
 * faked; they are listed in `notEvaluated` so callers and reports stay honest.
 */

export interface CaptureQualityReport {
  analyzable: boolean;
  reasons: string[];
  notEvaluated: string[];
  stats: {
    frameCount: number;
    durationMs: number;
    effectiveFps: number;
    meanFrameConfidence: number;
    meanJointsPerFrame: number;
    fullBodyFrameRate: number;
    medianTorsoLengthNorm: number;
    largestGapMs: number;
  };
}

const CORE_JOINTS = [
  "left_shoulder",
  "right_shoulder",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_wrist",
  "right_wrist",
] as const;

export const QUALITY_THRESHOLDS = {
  minFrames: 24,
  minEffectiveFps: 24,
  minMeanFrameConfidence: 0.35,
  minFullBodyFrameRate: 0.5,
  /** Torso shorter than this fraction of image height = player too small. */
  minTorsoLengthNorm: 0.08,
  /** Torso taller than this = player too close / partially out of frame. */
  maxTorsoLengthNorm: 0.6,
  maxGapMs: 700,
} as const;

export function evaluateCaptureQuality(sequence: PoseSequence): CaptureQualityReport {
  const frames = sequence.frames;
  const reasons: string[] = [];
  const durationMs =
    frames.length >= 2 ? frames[frames.length - 1]!.timestampMs - frames[0]!.timestampMs : 0;
  const effectiveFps = durationMs > 0 ? ((frames.length - 1) * 1000) / durationMs : 0;

  let largestGapMs = 0;
  for (let index = 1; index < frames.length; index += 1) {
    largestGapMs = Math.max(
      largestGapMs,
      frames[index]!.timestampMs - frames[index - 1]!.timestampMs,
    );
  }

  const torsoSamples: number[] = [];
  let fullBodyFrames = 0;
  const jointCounts: number[] = [];
  for (const frame of frames) {
    const byName = new Map(frame.landmarks.map((mark) => [mark.name, mark]));
    const visible = CORE_JOINTS.filter((joint) => (byName.get(joint)?.visibility ?? 0) >= 0.3);
    jointCounts.push(visible.length);
    if (visible.length === CORE_JOINTS.length) fullBodyFrames += 1;
    const ls = byName.get("left_shoulder");
    const rs = byName.get("right_shoulder");
    const lh = byName.get("left_hip");
    const rh = byName.get("right_hip");
    if (ls && rs && lh && rh) {
      const shoulderY = (ls.y + rs.y) / 2;
      const hipY = (lh.y + rh.y) / 2;
      const shoulderX = (ls.x + rs.x) / 2;
      const hipX = (lh.x + rh.x) / 2;
      torsoSamples.push(Math.hypot(shoulderX - hipX, shoulderY - hipY));
    }
  }
  const medianTorso = median(torsoSamples);
  const fullBodyRate = frames.length > 0 ? fullBodyFrames / frames.length : 0;
  const meanConfidence = mean(frames.map((frame) => frame.confidence));

  if (frames.length < QUALITY_THRESHOLDS.minFrames) {
    reasons.push("too_few_pose_frames");
  }
  if (effectiveFps > 0 && effectiveFps < QUALITY_THRESHOLDS.minEffectiveFps) {
    reasons.push("insufficient_fps");
  }
  if (meanConfidence < QUALITY_THRESHOLDS.minMeanFrameConfidence) {
    reasons.push("low_pose_confidence");
  }
  if (fullBodyRate < QUALITY_THRESHOLDS.minFullBodyFrameRate) {
    reasons.push("body_not_fully_visible");
  }
  if (torsoSamples.length === 0) {
    reasons.push("torso_not_measured");
  } else if (medianTorso < QUALITY_THRESHOLDS.minTorsoLengthNorm) {
    reasons.push("player_too_small_in_frame");
  } else if (medianTorso > QUALITY_THRESHOLDS.maxTorsoLengthNorm) {
    reasons.push("player_too_close_or_cropped");
  }
  if (largestGapMs > QUALITY_THRESHOLDS.maxGapMs) {
    reasons.push("tracking_dropout_gap");
  }

  return {
    analyzable: reasons.length === 0,
    reasons,
    notEvaluated: [
      "camera_motion", // needs background features we do not extract yet
      "paddle_visibility", // needs a paddle detector
      "lighting_failure", // needs image statistics, not pose
    ],
    stats: {
      frameCount: frames.length,
      durationMs,
      effectiveFps,
      meanFrameConfidence: meanConfidence,
      meanJointsPerFrame: mean(jointCounts),
      fullBodyFrameRate: fullBodyRate,
      medianTorsoLengthNorm: medianTorso,
      largestGapMs,
    },
  };
}
