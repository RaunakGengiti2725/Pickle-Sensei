import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";

/**
 * Expert annotation schema — the label side of the real dataset.
 *
 * Structured by design (not one overall number) so labels can supervise and
 * evaluate specific model tasks: phase boundaries for the segmenter, faults
 * and per-checkpoint scores for the scorer, visibility for the quality gate.
 * One file per annotator per capture; disagreement between annotators is
 * preserved as data, never averaged away at annotation time.
 */

export const ANNOTATION_SCHEMA_VERSION = 1 as const;

export interface PhaseBoundaryLabels {
  /** Milliseconds in video time; null = annotator could not place it. */
  preparationStartMs: number | null;
  accelerationStartMs: number | null;
  contactMs: number | null;
  followThroughEndMs: number | null;
}

export interface FaultLabel {
  checkpoint: (typeof CHECKPOINTS)[number];
  /** Annotator's severity 1 (minor) – 3 (major). */
  severity: 1 | 2 | 3;
  note: string;
}

/**
 * Paddle ground truth on a single frame. Center-point labels (not boxes):
 * fast to place, sufficient for detection-rate and center-error metrics.
 * `occluded` = the paddle exists but is hidden (behind body etc.);
 * `absent` = no paddle should be detected near this player at all.
 */
export interface PaddleFrameLabel {
  tMs: number;
  /** Normalized top-left image coordinates; null unless visibility=visible. */
  point: { x: number; y: number } | null;
  visibility: "visible" | "occluded" | "absent";
}

/**
 * Ball ground truth on a single frame. `not_visible` = the ball is genuinely
 * not in this frame (out of play / out of frame); `occluded` = in play but
 * hidden; `uncertain` = the annotator cannot commit either way — uncertain
 * frames are excluded from precision/recall rather than guessed.
 */
export interface BallFrameLabel {
  tMs: number;
  point: { x: number; y: number } | null;
  visibility: "visible" | "occluded" | "not_visible" | "uncertain";
  /** Optional normalized radius when measurable. */
  radiusNorm?: number;
}

export const CONTACT_UNCERTAINTIES = [
  "exact",
  "plus_minus_1",
  "plus_minus_2",
  "uncertain",
] as const;
export type ContactUncertainty = (typeof CONTACT_UNCERTAINTIES)[number];

/**
 * A labeled stroke EVENT: one temporally localized hitting motion. `owner`
 * distinguishes the target player's strokes from other players' swings in
 * frame (needed to measure neighbor-stroke contamination).
 */
export interface StrokeEventLabel {
  eventStartMs: number;
  contactMs: number | null;
  eventEndMs: number;
  owner: "target" | "other";
  note?: string;
}

export interface SwingAnnotation {
  schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;
  captureBundle: string;
  annotatorId: string;
  createdAtIso: string;
  /** Incremented every save; prior revisions are kept in `history`. */
  revision: number;
  stroke: (typeof SHOT_TYPES)[number] | "not_a_pickleball_stroke" | "unsure";
  /** Optional stroke label in the v3 recognition taxonomy (annotated, not
   * declared and not predicted — the three stay separate everywhere). */
  annotatedStrokeV3?: string;
  handedness: "right" | "left" | "unsure";
  /** Was the full body visible and the footage judgeable at all? */
  analyzable: boolean;
  notAnalyzableReason: string | null;
  phases: PhaseBoundaryLabels;
  /** How precisely the annotator could place phases.contactMs. */
  contactUncertainty?: ContactUncertainty | null;
  faults: FaultLabel[];
  /** Optional per-frame paddle ground truth (see PaddleFrameLabel). */
  paddleFrames?: PaddleFrameLabel[];
  /** NON-target players' paddles — enables direct wrong-player measurement. */
  otherPaddleFrames?: PaddleFrameLabel[];
  /** Optional per-frame ball ground truth (see BallFrameLabel). */
  ballFrames?: BallFrameLabel[];
  /** Labeled stroke events (target and other players). */
  eventLabels?: StrokeEventLabel[];
  /** 0–100 per checkpoint; null = not assessable from this footage. */
  checkpointScores: Partial<Record<(typeof CHECKPOINTS)[number], number | null>>;
  /** Overall technique 0–100 in the annotator's judgment. */
  overallScore: number | null;
  /** Annotator's own confidence in this annotation, 0–1. */
  annotatorConfidence: number;
  notes: string;
  history: Array<{ revision: number; savedAtIso: string }>;
}

export function validateAnnotation(raw: unknown): string[] {
  const problems: string[] = [];
  const annotation = raw as Partial<SwingAnnotation> | null;
  if (!annotation || typeof annotation !== "object") return ["annotation must be an object"];
  if (annotation.schemaVersion !== ANNOTATION_SCHEMA_VERSION) problems.push("bad schemaVersion");
  if (!annotation.annotatorId) problems.push("annotatorId required");
  const strokes = [...SHOT_TYPES, "not_a_pickleball_stroke", "unsure"];
  if (!strokes.includes(annotation.stroke as string)) problems.push("invalid stroke");
  if (typeof annotation.analyzable !== "boolean") problems.push("analyzable required");
  if (
    typeof annotation.annotatorConfidence !== "number" ||
    annotation.annotatorConfidence < 0 ||
    annotation.annotatorConfidence > 1
  ) {
    problems.push("annotatorConfidence must be 0..1");
  }
  for (const fault of annotation.faults ?? []) {
    if (!CHECKPOINTS.includes(fault.checkpoint))
      problems.push(`unknown checkpoint ${String(fault.checkpoint)}`);
    if (![1, 2, 3].includes(fault.severity)) problems.push("fault severity must be 1..3");
  }
  for (const [key, value] of Object.entries(annotation.checkpointScores ?? {})) {
    if (!CHECKPOINTS.includes(key as (typeof CHECKPOINTS)[number])) {
      problems.push(`unknown checkpoint score key ${key}`);
    }
    if (value !== null && (typeof value !== "number" || value < 0 || value > 100)) {
      problems.push(`checkpoint score ${key} must be 0..100 or null`);
    }
  }
  for (const frame of annotation.paddleFrames ?? []) {
    if (typeof frame.tMs !== "number" || frame.tMs < 0) {
      problems.push("paddle frame tMs must be a non-negative number");
    }
    if (!["visible", "occluded", "absent"].includes(frame.visibility)) {
      problems.push(`invalid paddle visibility ${String(frame.visibility)}`);
    }
    if (frame.visibility === "visible") {
      if (!isNormalizedPoint(frame.point)) {
        problems.push("visible paddle frames need a normalized point in [0,1]");
      }
    } else if (frame.point !== null && frame.point !== undefined) {
      problems.push("occluded/absent paddle frames must not carry a point");
    }
  }
  for (const frame of annotation.ballFrames ?? []) {
    if (typeof frame.tMs !== "number" || frame.tMs < 0) {
      problems.push("ball frame tMs must be a non-negative number");
    }
    if (!["visible", "occluded", "not_visible", "uncertain"].includes(frame.visibility)) {
      problems.push(`invalid ball visibility ${String(frame.visibility)}`);
    }
    if (frame.visibility === "visible") {
      if (!isNormalizedPoint(frame.point)) {
        problems.push("visible ball frames need a normalized point in [0,1]");
      }
    } else if (frame.point !== null && frame.point !== undefined) {
      problems.push("non-visible ball frames must not carry a point");
    }
    if (
      frame.radiusNorm !== undefined &&
      (typeof frame.radiusNorm !== "number" || frame.radiusNorm <= 0 || frame.radiusNorm > 0.2)
    ) {
      problems.push("ball radiusNorm must be in (0, 0.2] when present");
    }
  }
  if (
    annotation.contactUncertainty !== undefined &&
    annotation.contactUncertainty !== null &&
    !CONTACT_UNCERTAINTIES.includes(annotation.contactUncertainty)
  ) {
    problems.push(`invalid contactUncertainty ${String(annotation.contactUncertainty)}`);
  }
  for (const frame of annotation.otherPaddleFrames ?? []) {
    if (!["visible", "occluded", "absent"].includes(frame.visibility)) {
      problems.push(`invalid other-paddle visibility ${String(frame.visibility)}`);
    }
    if (frame.visibility === "visible" && !isNormalizedPoint(frame.point)) {
      problems.push("visible other-paddle frames need a normalized point in [0,1]");
    }
  }
  for (const event of annotation.eventLabels ?? []) {
    if (
      typeof event.eventStartMs !== "number" ||
      typeof event.eventEndMs !== "number" ||
      event.eventEndMs <= event.eventStartMs
    ) {
      problems.push("event labels need eventStartMs < eventEndMs");
    }
    if (!["target", "other"].includes(event.owner)) {
      problems.push(`invalid event owner ${String(event.owner)}`);
    }
    if (
      event.contactMs !== null &&
      (typeof event.contactMs !== "number" ||
        event.contactMs < event.eventStartMs ||
        event.contactMs > event.eventEndMs)
    ) {
      problems.push("event contactMs must lie inside the event or be null");
    }
  }
  return problems;
}

function isNormalizedPoint(point: unknown): boolean {
  const candidate = point as { x?: unknown; y?: unknown } | null | undefined;
  return (
    !!candidate &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    candidate.x >= 0 &&
    candidate.x <= 1 &&
    candidate.y >= 0 &&
    candidate.y <= 1
  );
}
