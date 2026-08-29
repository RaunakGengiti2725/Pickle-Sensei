import type { Handedness } from "@pickle/shared-types";
import { toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";

/**
 * Stroke recognition taxonomy v3 + the hierarchical HEURISTIC baseline —
 * PURE PORT of packages/swing-lab/src/strokeHeuristic.ts (stroke-heuristic-1).
 *
 * WHY THIS FILE EXISTS: the mobile app wires AUTO DETECT (declared-null
 * stroke routing, see analysis-pipeline/strokeAutoResolution.ts) and must not
 * depend on @pickle/swing-lab, whose package drags in node-only tooling.
 * The classifier itself is pure TypeScript over pose frames, so it lives
 * here in the deterministic geometry bundle.
 *
 * DEDUP FOLLOW-UP (intentionally not done this wave): swing-lab keeps its
 * own byte-equivalent copy for the desktop lab; a later wave should delete
 * that copy and re-export from here. Until then, behavioral changes must be
 * made in BOTH files or (better) not at all without calibration data.
 *
 * This is measured geometry, not a learned classifier, and it says so:
 * predictions stop at the deepest taxonomy level the evidence supports.
 * Level 1 separates OVERHEAD / SWING (bounce information does not exist yet,
 * so volley-vs-groundstroke is NOT claimable at L1). Level 2 decides
 * FOREHAND/BACKHAND from the dominant wrist's position relative to the body
 * midline in the PLAYER's frame (camera-facing corrected). Level 3 commits to
 * DINK vs DRIVE only when contact height and swing speed agree with margin —
 * which today they never can without bounce observation.
 *
 * declared / annotated / predicted stroke stay separate records everywhere.
 */

export const STROKE_TAXONOMY_V3 = {
  version: "pickleball-stroke-taxonomy-v3",
  labels: [
    "FOREHAND_DRIVE",
    "BACKHAND_DRIVE",
    "SERVE",
    "RETURN",
    "FOREHAND_DINK",
    "BACKHAND_DINK",
    "FOREHAND_VOLLEY",
    "BACKHAND_VOLLEY",
    "DROP",
    "RESET",
    "OVERHEAD",
    "SPEEDUP",
    "UNKNOWN",
  ] as const,
} as const;
export type StrokeV3 = (typeof STROKE_TAXONOMY_V3.labels)[number];

export const STROKE_HEURISTIC_VERSION = "stroke-heuristic-1 (uncalibrated)";

/**
 * Minimal paddle observation the heuristic actually reads. swing-lab's
 * TrackedPaddleObservation is structurally assignable to this, so the lab
 * can pass its tracks through unchanged when it adopts this port.
 */
export interface HeuristicPaddleObservation {
  timestampMs: number;
  center: { x: number; y: number };
}

/**
 * Structurally identical to swing-lab's StrokePrediction and to the fusion
 * engine's HierarchicalStrokePrediction (strokeAutoResolution.ts) — an
 * adapter passes it through unchanged.
 */
export interface HeuristicStrokePrediction {
  taxonomyVersion: string;
  classifierVersion: string;
  /** Deepest label the evidence supports (may be coarse, e.g. "FOREHAND"). */
  label: string;
  /** Mapped v3 leaf when depth reaches 3 (or OVERHEAD at depth 1); else null. */
  leaf: StrokeV3 | null;
  taxonomyDepth: 1 | 2 | 3;
  /** Heuristic, uncalibrated. */
  confidence: number;
  evidence: string[];
  limitingFactors: string[];
}

export function classifyStroke(input: {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  /** Measured kinematic peak of the ISOLATED event — the only permitted
   * reference when contact is missing (never a window midpoint). */
  eventPeakMs?: number | null;
  handedness: Handedness;
  paddle: readonly HeuristicPaddleObservation[] | null;
  paddleSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
  wristSpeeds: ReadonlyArray<{ timestampMs: number; value: number }> | null;
}): HeuristicStrokePrediction {
  const evidence: string[] = [];
  const limitingFactors: string[] = [];
  const frames = toLegacyPoseFrames(input.sequence);
  let contactMs: number;
  if (input.contactMs !== null) {
    contactMs = input.contactMs;
  } else if (input.eventPeakMs !== null && input.eventPeakMs !== undefined) {
    contactMs = input.eventPeakMs;
    limitingFactors.push("reference_is_event_peak_not_contact");
  } else {
    return unknown("no_contact_and_no_event_peak_reference", evidence, limitingFactors);
  }

  const frame = nearestFrame(frames, contactMs);
  if (!frame) {
    return unknown("no_pose_frame_near_contact", evidence, limitingFactors);
  }
  const joints = new Map(frame.landmarks.map((mark) => [mark.name, mark]));
  const leftShoulder = joints.get("left_shoulder");
  const rightShoulder = joints.get("right_shoulder");
  const leftHip = joints.get("left_hip");
  const rightHip = joints.get("right_hip");
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return unknown("torso_not_measured_at_contact", evidence, limitingFactors);
  }
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const midX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderWidth = Math.max(0.02, Math.abs(rightShoulder.x - leftShoulder.x));

  // Contact point: measured paddle center near contact when available,
  // else the dominant-motion wrist. The source is recorded as evidence.
  let contactPoint: { x: number; y: number } | null = null;
  const paddleNear = input.paddle
    ?.filter((observation) => Math.abs(observation.timestampMs - contactMs) <= 80)
    .sort((a, b) => Math.abs(a.timestampMs - contactMs) - Math.abs(b.timestampMs - contactMs))[0];
  if (paddleNear) {
    contactPoint = paddleNear.center;
    evidence.push(
      `paddle center at contact (${paddleNear.center.x.toFixed(2)}, ${paddleNear.center.y.toFixed(2)})`,
    );
  } else {
    const wrist = dominantWrist(frames, contactMs);
    if (wrist) {
      contactPoint = wrist;
      evidence.push(
        `wrist at contact (${wrist.x.toFixed(2)}, ${wrist.y.toFixed(2)}) — paddle not tracked at contact`,
      );
      limitingFactors.push("paddle_not_tracked_at_contact");
    }
  }
  if (!contactPoint) {
    return unknown("no_contact_point_measurable", evidence, limitingFactors);
  }

  // ── Level 1: vertical motion class ─────────────────────────────────────
  const torso = Math.max(0.02, hipY - shoulderY);
  const aboveShoulder = (shoulderY - contactPoint.y) / torso; // >0 above

  if (aboveShoulder > 0.25) {
    evidence.push(`contact ${aboveShoulder.toFixed(2)} torso-units above shoulders`);
    return {
      taxonomyVersion: STROKE_TAXONOMY_V3.version,
      classifierVersion: STROKE_HEURISTIC_VERSION,
      label: "OVERHEAD",
      leaf: "OVERHEAD",
      taxonomyDepth: 1,
      confidence: clamp(0.5 + aboveShoulder / 2, 0.5, 0.85),
      evidence,
      limitingFactors,
    };
  }
  evidence.push(
    `contact height: ${contactPoint.y < shoulderY ? "above" : contactPoint.y < hipY ? "between shoulders and hips" : "below hips"}`,
  );
  limitingFactors.push("bounce_not_observed_volley_vs_groundstroke_unresolved");

  // ── Level 2: side (forehand/backhand) in the player's frame ────────────
  if (input.handedness === "ambidextrous") {
    limitingFactors.push("ambidextrous_declared_side_unresolvable");
    return unknown(null, evidence, limitingFactors);
  }
  // Facing sign: rear view keeps anatomical right on image right (+1);
  // front view mirrors it (-1).
  const facing = rightShoulder.x >= leftShoulder.x ? 1 : -1;
  evidence.push(
    facing === 1 ? "rear-ish view (shoulder order)" : "front-ish view (shoulder order)",
  );
  const offset = ((contactPoint.x - midX) / shoulderWidth) * facing;
  // offset > 0 = contact on the player's RIGHT side.
  const dominantRight = input.handedness === "right";
  const sameSide = dominantRight ? offset > 0 : offset < 0;
  const sideMargin = Math.abs(offset);
  const side = sameSide ? "FOREHAND" : "BACKHAND";
  evidence.push(
    `contact ${sideMargin.toFixed(2)} shoulder-widths ${offset > 0 ? "right" : "left"} of midline (${input.handedness}-handed → ${side.toLowerCase()})`,
  );
  if (sideMargin < 0.15) {
    limitingFactors.push("contact_too_close_to_midline_for_confident_side");
    return unknown(null, evidence, limitingFactors);
  }
  const sideConfidence = clamp(0.45 + sideMargin * 0.5, 0.45, 0.8);

  // ── Level 3: intensity class (dink vs drive) ───────────────────────────
  const speeds =
    input.paddleSpeeds && input.paddleSpeeds.length >= 5
      ? { series: input.paddleSpeeds, source: "paddle" }
      : input.wristSpeeds && input.wristSpeeds.length >= 5
        ? { series: input.wristSpeeds, source: "wrist" }
        : null;
  if (!speeds) {
    limitingFactors.push("no_speed_series_for_intensity");
    return {
      taxonomyVersion: STROKE_TAXONOMY_V3.version,
      classifierVersion: STROKE_HEURISTIC_VERSION,
      label: side,
      leaf: null,
      taxonomyDepth: 2,
      confidence: sideConfidence,
      evidence,
      limitingFactors,
    };
  }
  const inWindow = speeds.series.filter(
    (sample) =>
      sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
  );
  const peak = inWindow.reduce((best, sample) => Math.max(best, sample.value), 0);
  const lowContact = contactPoint.y > hipY - 0.35 * torso;
  const intensity = peak < 0.9 ? "slow" : peak >= 1.4 ? "fast" : "medium";
  evidence.push(
    `${speeds.source} speed peak ${peak.toFixed(2)} u/s (${intensity} swing, ${lowContact ? "low" : "mid/high"} contact)`,
  );
  // Without bounce observation, DRIVE/VOLLEY/DINK/DROP/RESET cannot be
  // separated defensibly — a fast volley is as fast as a drive. The
  // intensity stays EVIDENCE; the commitment stops at depth 2.
  limitingFactors.push("bounce_not_observed_level3_uncommitted");
  return {
    taxonomyVersion: STROKE_TAXONOMY_V3.version,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    label: side,
    leaf: null,
    taxonomyDepth: 2,
    confidence: sideConfidence,
    evidence,
    limitingFactors,
  };
}

function unknown(
  reason: string | null,
  evidence: string[],
  limitingFactors: string[],
): HeuristicStrokePrediction {
  if (reason) limitingFactors.push(reason);
  return {
    taxonomyVersion: STROKE_TAXONOMY_V3.version,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    label: "UNKNOWN",
    leaf: "UNKNOWN",
    taxonomyDepth: 1,
    confidence: 0.2,
    evidence,
    limitingFactors,
  };
}

function nearestFrame(frames: ReturnType<typeof toLegacyPoseFrames>, timestampMs: number) {
  let best: (typeof frames)[number] | null = null;
  let bestDelta = Infinity;
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frame;
    }
  }
  return best && bestDelta <= 80 ? best : null;
}

/** The wrist that moved more around contact (±200ms). */
function dominantWrist(
  frames: ReturnType<typeof toLegacyPoseFrames>,
  contactMs: number,
): { x: number; y: number } | null {
  const nearby = frames.filter((frame) => Math.abs(frame.timestampMs - contactMs) <= 200);
  const travel = { left: 0, right: 0 };
  const previous: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
  for (const frame of nearby) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = previous[sideName];
      if (prior) travel[sideName] += Math.hypot(mark.x - prior.x, mark.y - prior.y);
      previous[sideName] = { x: mark.x, y: mark.y };
    }
  }
  const chosen = travel.right >= travel.left ? "right" : "left";
  const frame = nearestFrame(frames, contactMs);
  const mark = frame?.landmarks.find(
    (landmark) => landmark.name === `${chosen}_wrist` && landmark.visibility >= 0.25,
  );
  return mark ? { x: mark.x, y: mark.y } : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
