import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { CaptureQualityReport, FrameAnalyzabilityReport } from "@pickle/vision-geometry";

/**
 * Pre-analysis OOD/analyzability gate.
 *
 * Runs BEFORE any analysis engine is trusted with a capture, and composes the
 * measured analyzability sources into one typed abstention:
 *
 *  - pose-FREE frame statistics (vision-geometry frameAnalyzability): still
 *    image played as video, solid-color frames, letterboxed title card,
 *    single-frame file, duration sanity — signals that exist even when pose
 *    extraction returned garbage or nothing;
 *  - pose-CONDITIONED checks (vision-geometry captureQuality): no person
 *    found at all, a person at an implausible scale (torso outside the
 *    measured plausibility band), too few frames or too low an effective
 *    frame rate, low mean pose confidence, a body that is not fully visible
 *    for most of the clip, a torso that was never measured, or a tracking
 *    dropout gap across the sequence;
 *  - torso-anchor continuity over the pose frames themselves: every
 *    normalized metric is expressed in the body frame (shoulder/hip anchor),
 *    so a stretch of frames where NO shoulder+hip pair is tracked leaves the
 *    swing unmeasured for that span — an occlusion or exit that a
 *    timestamp-only gap check cannot see, because the frames still exist.
 *
 * The gate never decodes video or runs pose itself, matching this package's
 * orchestration contract. `null` inputs mean "not measured" and are reported
 * in `notEvaluated`, never treated as passing evidence of the opposite.
 */

export const PRE_ANALYSIS_GATE_VERSION = "pre-analysis-gate-2";

/** Pose-quality reason codes that mean "a person exists but at a scale no real capture produces". */
const IMPLAUSIBLE_SCALE_REASONS = new Set([
  "player_too_small_in_frame",
  "player_too_close_or_cropped",
]);

/**
 * Longest tolerated stretch (ms) between two consecutive frames in which the
 * torso is anchored (at least one shoulder AND one hip at visibility ≥ 0.3).
 * One or two dropped frames at 30 fps (≤ 100 ms) are ordinary tracker
 * flicker; anything longer means the body frame was interpolated across
 * motion nobody measured.
 */
export const MAX_TORSO_ANCHOR_GAP_MS = 120;

const LANDMARK_VISIBLE = 0.3;

export interface PreAnalysisGateInput {
  /** Pose-free frame-statistic report; null = frame stats were not computed. */
  frame: FrameAnalyzabilityReport | null;
  /** The extracted pose sequence; null = pose extraction did not run. */
  pose: PoseSequence | null;
  /** Pose capture-quality report; null = not evaluated (requires pose). */
  poseQuality: CaptureQualityReport | null;
}

export interface PreAnalysisGateDecision {
  analyzable: boolean;
  /** Machine-readable reason codes, in evaluation order. */
  reasons: string[];
  /** Signals that were not measured for this capture (honest gaps). */
  notEvaluated: string[];
}

/**
 * Largest gap (ms) between consecutive torso-anchored frames. Frames before
 * the first / after the last anchored frame are not counted here: a torso
 * that is never anchored is already `torso_not_measured` upstream, and
 * leading/trailing loss is coverage, not continuity.
 */
export function largestTorsoAnchorGapMs(pose: PoseSequence): number {
  let previousAnchoredMs: number | null = null;
  let largest = 0;
  for (const frame of pose.frames) {
    let leftShoulder = false;
    let rightShoulder = false;
    let leftHip = false;
    let rightHip = false;
    for (const mark of frame.landmarks) {
      if (mark.visibility < LANDMARK_VISIBLE) continue;
      if (mark.name === "left_shoulder") leftShoulder = true;
      else if (mark.name === "right_shoulder") rightShoulder = true;
      else if (mark.name === "left_hip") leftHip = true;
      else if (mark.name === "right_hip") rightHip = true;
    }
    if (!((leftShoulder || rightShoulder) && (leftHip || rightHip))) continue;
    if (previousAnchoredMs !== null) {
      largest = Math.max(largest, frame.timestampMs - previousAnchoredMs);
    }
    previousAnchoredMs = frame.timestampMs;
  }
  return largest;
}

export function evaluatePreAnalysisGate(input: PreAnalysisGateInput): PreAnalysisGateDecision {
  const reasons: string[] = [];
  const notEvaluated: string[] = [];

  if (input.frame === null) {
    notEvaluated.push("frame_statistics");
  } else if (!input.frame.analyzable) {
    reasons.push(...input.frame.reasons);
    notEvaluated.push(...input.frame.notEvaluated);
  } else {
    notEvaluated.push(...input.frame.notEvaluated);
  }

  if (input.pose === null) {
    notEvaluated.push("pose_presence");
  } else if (input.pose.frames.length === 0) {
    reasons.push("no_person_found");
  }

  if (input.poseQuality === null) {
    notEvaluated.push("pose_capture_quality");
  } else if (input.pose !== null && input.pose.frames.length > 0) {
    let scaleReported = false;
    for (const reason of input.poseQuality.reasons) {
      if (IMPLAUSIBLE_SCALE_REASONS.has(reason)) {
        if (!scaleReported) reasons.push("person_implausible_scale");
        scaleReported = true;
      } else {
        reasons.push(reason);
      }
    }
  }

  if (input.pose === null) {
    notEvaluated.push("torso_anchor_continuity");
  } else if (
    input.pose.frames.length > 0 &&
    largestTorsoAnchorGapMs(input.pose) > MAX_TORSO_ANCHOR_GAP_MS
  ) {
    reasons.push("torso_tracking_gap");
  }

  return { analyzable: reasons.length === 0, reasons, notEvaluated };
}

/**
 * Result-typed form for pipeline callers: `ok(decision)` when analyzable,
 * otherwise a typed failure whose code carries the first (most upstream)
 * reason and whose message lists them all. Frame-statistic failures are
 * `corrupted_media` (the medium itself is out of distribution); pose failures
 * are `low_confidence` (the medium may be fine, the perception is not).
 */
export function preAnalysisGate(input: PreAnalysisGateInput): Result<PreAnalysisGateDecision> {
  const decision = evaluatePreAnalysisGate(input);
  if (decision.analyzable) return ok(decision);
  const frameReasons = new Set(input.frame?.reasons ?? []);
  const poseOnly = decision.reasons.every((reason) => !frameReasons.has(reason));
  return fail(
    failure(
      poseOnly ? "low_confidence" : "corrupted_media",
      `capture.not_analyzable.${decision.reasons[0]!}`,
      `Capture is not analyzable: ${decision.reasons.join(", ")}.`,
      decision,
    ),
  );
}
