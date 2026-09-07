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
 *    found at all, or every whole-clip pose-quality reason the report
 *    measured — too few frames, insufficient fps, low pose confidence, body
 *    not fully visible, a tracking dropout gap, an unmeasured torso, or a
 *    person at an implausible scale (torso outside the plausibility band);
 *  - stroke-WINDOW tracking continuity: whether the torso anchor stays
 *    tracked across the measured motion window the engine is about to
 *    analyze. A whole-clip report cannot see a short occlusion through
 *    contact; the engine's phases are measured exactly there, so this gate
 *    must.
 *
 * The gate is pure composition over already-evaluated reports plus the one
 * measurement only this layer has the context for (the stroke window) — it
 * never decodes video or runs pose itself, matching this package's
 * orchestration contract. `null` inputs mean "not measured" and are reported
 * in `notEvaluated`, never treated as passing evidence of the opposite.
 */

export const PRE_ANALYSIS_GATE_VERSION = "pre-analysis-gate-2";

/** Pose-quality reason codes that mean "a person exists but at a scale no real capture produces". */
const IMPLAUSIBLE_SCALE_REASONS = new Set([
  "player_too_small_in_frame",
  "player_too_close_or_cropped",
]);

export const STROKE_WINDOW_TRACKING = {
  /** A landmark at/above this visibility counts as tracked (the whole-clip full-body coverage rule). */
  minVisibility: 0.3,
  /**
   * Longest stretch of the stroke window with the torso anchor untracked
   * before the stroke is unmeasurable there. Tracked frames at 30 fps are
   * 33 ms apart, at 24 fps 42 ms: 150 ms means more than three consecutive
   * inferences lost at 30 fps (more than two at 24 fps) — a stroke phase, not
   * a single missed frame. The torso is the anchor every normalized metric is
   * measured against; wrists legitimately vanish behind the body (rear-oblique
   * backswing) and are left to the engine's per-landmark confidence.
   */
  maxGapMs: 150,
} as const;

const TORSO_JOINTS = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] as const;

/**
 * The MEASURED MOTION window the engine is about to analyze (the live
 * trigger's movement window, or the offline detector's motion core for an
 * imported clip) — never the raw container span: untracked footage before
 * the player steps in or after they leave is not a stroke dropout. Clip-
 * relative milliseconds.
 */
export interface StrokeWindowContext {
  windowStartMs: number;
  windowEndMs: number;
}

export interface PreAnalysisGateInput {
  /** Pose-free frame-statistic report; null = frame stats were not computed. */
  frame: FrameAnalyzabilityReport | null;
  /** The extracted pose sequence; null = pose extraction did not run. */
  pose: PoseSequence | null;
  /** Pose capture-quality report; null = not evaluated (requires pose). */
  poseQuality: CaptureQualityReport | null;
  /** Stroke window the engine will analyze; omitted/null = not evaluated. */
  stroke?: StrokeWindowContext | null;
}

export interface PreAnalysisGateDecision {
  analyzable: boolean;
  /** Machine-readable reason codes, in evaluation order. */
  reasons: string[];
  /** Signals that were not measured for this capture (honest gaps). */
  notEvaluated: string[];
}

/**
 * Longest span inside the stroke window with no torso-tracked frame (all four
 * torso landmarks at/above `minVisibility`), counting the lead-in before the
 * first tracked frame and the tail after the last — the window is a measured
 * motion span, so untracked edges are tracking lost during the motion. The
 * whole window length when nothing inside it is tracked; null for an
 * empty/inverted window.
 */
export function strokeWindowTrackingGapMs(
  pose: PoseSequence,
  stroke: StrokeWindowContext,
): number | null {
  const { windowStartMs, windowEndMs } = stroke;
  if (!(windowEndMs > windowStartMs)) return null;
  const tracked: number[] = [];
  for (const frame of pose.frames) {
    if (frame.timestampMs < windowStartMs || frame.timestampMs > windowEndMs) continue;
    const visibility = new Map<string, number>();
    for (const mark of frame.landmarks) visibility.set(mark.name, mark.visibility);
    const seen = (name: string): boolean =>
      (visibility.get(name) ?? 0) >= STROKE_WINDOW_TRACKING.minVisibility;
    if (TORSO_JOINTS.every(seen)) tracked.push(frame.timestampMs);
  }
  if (tracked.length === 0) return windowEndMs - windowStartMs;
  let largest = Math.max(tracked[0]! - windowStartMs, windowEndMs - tracked[tracked.length - 1]!);
  for (let i = 1; i < tracked.length; i += 1) {
    largest = Math.max(largest, tracked[i]! - tracked[i - 1]!);
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

  const hasPose = input.pose !== null && input.pose.frames.length > 0;
  if (input.pose === null) {
    notEvaluated.push("pose_presence");
  } else if (!hasPose) {
    reasons.push("no_person_found");
  }

  if (input.poseQuality === null) {
    notEvaluated.push("pose_capture_quality");
  } else if (hasPose) {
    if (!input.poseQuality.analyzable) {
      for (const reason of input.poseQuality.reasons) {
        const slug = IMPLAUSIBLE_SCALE_REASONS.has(reason) ? "person_implausible_scale" : reason;
        if (!reasons.includes(slug)) reasons.push(slug);
      }
    }
    notEvaluated.push(...input.poseQuality.notEvaluated);
  }

  const stroke = input.stroke ?? null;
  if (stroke === null || !hasPose) {
    notEvaluated.push("stroke_window_tracking");
  } else {
    const gap = strokeWindowTrackingGapMs(input.pose!, stroke);
    if (gap === null) {
      notEvaluated.push("stroke_window_tracking");
    } else if (gap > STROKE_WINDOW_TRACKING.maxGapMs) {
      reasons.push("stroke_window_tracking_gap");
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
  const frameReasons = new Set(input.frame?.analyzable === false ? input.frame.reasons : []);
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
