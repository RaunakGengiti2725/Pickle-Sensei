import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { CaptureQualityReport, FrameAnalyzabilityReport } from "@pickle/vision-geometry";

/**
 * Pre-analysis OOD/analyzability gate.
 *
 * Runs BEFORE any analysis engine is trusted with a capture, and composes the
 * two measured analyzability sources into one typed abstention:
 *
 *  - pose-FREE frame statistics (vision-geometry frameAnalyzability): still
 *    image played as video, solid-color frames, letterboxed title card,
 *    single-frame file, duration sanity — signals that exist even when pose
 *    extraction returned garbage or nothing;
 *  - pose-CONDITIONED checks (vision-geometry captureQuality): no person
 *    found at all, or a person at an implausible scale (torso outside the
 *    measured plausibility band).
 *
 * The gate is pure composition over already-evaluated reports — it never
 * decodes video or runs pose itself, matching this package's orchestration
 * contract. `null` inputs mean "not measured" and are reported in
 * `notEvaluated`, never treated as passing evidence of the opposite.
 */

export const PRE_ANALYSIS_GATE_VERSION = "pre-analysis-gate-1";

/** Pose-quality reason codes that mean "a person exists but at a scale no real capture produces". */
const IMPLAUSIBLE_SCALE_REASONS = new Set([
  "player_too_small_in_frame",
  "player_too_close_or_cropped",
]);

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
    for (const reason of input.poseQuality.reasons) {
      if (IMPLAUSIBLE_SCALE_REASONS.has(reason)) {
        reasons.push("person_implausible_scale");
        break;
      }
    }
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
  const poseOnly = decision.reasons.every(
    (reason) => reason === "no_person_found" || reason === "person_implausible_scale",
  );
  return fail(
    failure(
      poseOnly ? "low_confidence" : "corrupted_media",
      `capture.not_analyzable.${decision.reasons[0]!}`,
      `Capture is not analyzable: ${decision.reasons.join(", ")}.`,
      decision,
    ),
  );
}
