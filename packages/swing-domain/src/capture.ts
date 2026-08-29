import type { CameraView, Handedness, ShotTypeSlug } from "@pickle/shared-types";
import type {
  BallTrack,
  CameraCalibration,
  CourtGeometry,
  ModalityRecord,
  PaddleTrack,
  PoseSequenceRef,
} from "./observations.js";
import type { ModelRef } from "./provenance.js";

/**
 * Canonical capture record — the durable, reprocessable description of one
 * recorded swing. The capture is immutable once written; analyses reference
 * it and accumulate beside it, so a swing recorded today can be re-analyzed
 * by any future model without touching the original record.
 */

export const CAPTURE_RECORD_SCHEMA_VERSION = 1 as const;

/**
 * Declared and predicted stroke identity are deliberately separate concepts.
 * Declaration is user input; prediction is a model output with provenance.
 * Downstream systems choose which to trust via explicit policy, and a future
 * validated classifier replaces the need for declaration without changing
 * this shape.
 */
export interface StrokePrediction {
  shotType: ShotTypeSlug | "unknown";
  confidence: number;
  alternatives: Array<{ shotType: ShotTypeSlug; confidence: number }>;
  producedBy: ModelRef;
}

export interface StrokeIdentity {
  declared: ShotTypeSlug | null;
  predicted: StrokePrediction | null;
}

/** How the stroke used for analysis was chosen. */
export type StrokeResolution =
  | { kind: "predicted"; shotType: ShotTypeSlug; confidence: number }
  | { kind: "declared"; shotType: ShotTypeSlug }
  | { kind: "unresolved"; reason: string };

/**
 * Resolution policy: a validated prediction wins when confident; otherwise
 * the user's declaration; otherwise honestly unresolved. The threshold is an
 * explicit argument so policy changes are visible at call sites.
 */
export function resolveStroke(
  identity: StrokeIdentity,
  options: { predictionConfidenceThreshold: number },
): StrokeResolution {
  const predicted = identity.predicted;
  if (
    predicted &&
    predicted.shotType !== "unknown" &&
    predicted.confidence >= options.predictionConfidenceThreshold
  ) {
    return {
      kind: "predicted",
      shotType: predicted.shotType,
      confidence: predicted.confidence,
    };
  }
  if (identity.declared !== null) {
    return { kind: "declared", shotType: identity.declared };
  }
  return {
    kind: "unresolved",
    reason:
      predicted === null
        ? "No stroke was declared and no classifier prediction exists."
        : "No stroke was declared and the classifier prediction is not confident enough.",
  };
}

/** The measured trigger window recorded by the on-device stroke trigger. */
export interface TriggerWindow {
  startMs: number;
  endMs: number;
  peakMotionMs: number | null;
  confidence: number;
  producedBy: ModelRef;
}

export type TrainingConsentState = "not_asked" | "granted" | "denied";

/**
 * Consent is explicit and separate from product telemetry. Nothing is
 * training data unless this says so; "not_asked" is the default and is
 * treated identically to "denied" by every exporter.
 */
export interface TrainingConsent {
  state: TrainingConsentState;
  /** Version of the consent terms shown when granted. */
  termsVersion: string | null;
  decidedAtIso: string | null;
}

export interface CaptureRecord {
  schemaVersion: typeof CAPTURE_RECORD_SCHEMA_VERSION;
  id: string;
  capturedAtIso: string;
  captureMode: "automatic_pose_trigger" | "imported_video";
  device: { platform: "ios" | "android" | "unknown"; appVersion: string };
  video: {
    uri: string;
    width: number;
    height: number;
    fps: number;
    durationMs: number;
  };
  handedness: Handedness | null;
  cameraView: CameraView | null;
  stroke: StrokeIdentity;
  trigger: TriggerWindow | null;
  observations: {
    pose: ModalityRecord<PoseSequenceRef>;
    paddle: ModalityRecord<PaddleTrack>;
    ball: ModalityRecord<BallTrack>;
    court: ModalityRecord<CourtGeometry>;
    camera: ModalityRecord<CameraCalibration>;
  };
  consent: TrainingConsent;
}

/**
 * Player profile — personalization surface. Everything is optional and
 * voluntarily supplied; absence is a valid state, not a default guess.
 */
export interface PlayerProfile {
  schemaVersion: 1;
  handedness: Handedness | null;
  heightCm: number | null;
  skillLevel: string | null;
  mobilityNotes: string | null;
}
