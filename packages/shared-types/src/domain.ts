/**
 * Core domain model shared by mobile, backend, scoring, and vision layers.
 * Source of truth: Deep Research blueprint (docs/SPEC_DIGEST.md).
 */

export const SHOT_TYPES = [
  "serve",
  "return",
  "forehand_drive",
  "backhand_drive",
  "third_shot_drop",
  "dink",
  "volley",
  "overhead",
] as const;
export type ShotTypeSlug = (typeof SHOT_TYPES)[number];

/** The four strokes in the initial working implementation (spec p. 59). */
export const MVP_SHOT_TYPES = ["forehand_drive", "dink", "third_shot_drop", "serve"] as const;
export type MvpShotTypeSlug = (typeof MVP_SHOT_TYPES)[number];

export const PHASES = [
  "ready",
  "prepare",
  "accelerate",
  "contact",
  "follow_through",
  "recover",
] as const;
export type PhaseKey = (typeof PHASES)[number];

export const CHECKPOINTS = [
  "ready_position",
  "athletic_base",
  "preparation",
  "paddle_set",
  "swing_length",
  "sequencing",
  "paddle_path",
  "contact_position",
  "face_wrist_stability",
  "follow_through",
  "recovery",
] as const;
export type CheckpointKey = (typeof CHECKPOINTS)[number];

export const CAMERA_VIEWS = ["side", "rear_oblique"] as const;
export type CameraView = (typeof CAMERA_VIEWS)[number];

export type Handedness = "right" | "left" | "ambidextrous";

export type ScoreBand = "green" | "yellow" | "red" | "unscored";

/**
 * Direction of a technique fault relative to the target range.
 * Labels are metric-specific (configured per scoring target), these are the
 * canonical vocabulary the UI and audio coach understand.
 */
export const FAULT_DIRECTIONS = [
  "late",
  "early",
  "high",
  "low",
  "long",
  "short",
  "wide",
  "narrow",
  "open",
  "closed",
  "unstable",
  "none",
] as const;
export type FaultDirection = (typeof FAULT_DIRECTIONS)[number];

/**
 * Every persisted analysis must carry the complete version vector (spec p. 22).
 * Historical scores stay attached to the versions that created them.
 */
export interface VersionVector {
  appVersion: string;
  modelBundleVersion: string;
  poseModelVersion: string;
  paddleModelVersion: string;
  strokeDetectorVersion: string;
  phaseModelVersion: string;
  scoringModelVersion: string;
  shotConfigVersion: string;
}

/**
 * Provenance of an analysis. Fixture output must never be presented as real
 * inference (directive §5); the tag travels with every derived artifact.
 */
export type AnalysisSource = "real" | "fixture";

/** Coordinate spaces are always explicit — never mixed implicitly (directive §15). */
export type CoordinateSpace = "normalized-image" | "pixel" | "body-relative" | "world-approx";

export const POSE_LANDMARK_NAMES = [
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
] as const;
export type PoseLandmarkName = (typeof POSE_LANDMARK_NAMES)[number];

export interface PoseLandmark {
  name: PoseLandmarkName;
  x: number;
  y: number;
  /** Present only for world-approx space. */
  z?: number;
  /** 0..1 visibility/estimation confidence for this landmark. */
  visibility: number;
}

export interface PoseFrame {
  timestampMs: number;
  space: CoordinateSpace;
  landmarks: PoseLandmark[];
  /** Whole-frame pose confidence 0..1. */
  confidence: number;
}

export interface PaddleKeypoints {
  handleEnd: { x: number; y: number } | null;
  throat: { x: number; y: number } | null;
  center: { x: number; y: number } | null;
  tip: { x: number; y: number } | null;
}

export interface PaddleFrame {
  timestampMs: number;
  space: CoordinateSpace;
  bbox: { x: number; y: number; width: number; height: number } | null;
  keypoints: PaddleKeypoints;
  confidence: number;
}

/** A single scalar biomechanical measurement produced by the vision layer. */
export interface Measurement {
  metricKey: string;
  value: number;
  /** 0..1 — how reliably the vision layer measured this. */
  confidence: number;
  unit: "normalized" | "ratio" | "degrees" | "ms" | "count";
  source: AnalysisSource;
}

export interface PhaseSpan {
  key: PhaseKey;
  startMs: number;
  /** Representative frame (for contact: probability-window representative). */
  representativeMs: number;
  endMs: number;
  confidence: number;
}

export interface CheckpointScore {
  key: CheckpointKey;
  /** 0..100; null when unobservable this analysis. */
  score: number | null;
  confidence: number;
  band: ScoreBand;
  direction: FaultDirection;
  /** 0..1 — how far below acceptable this checkpoint is. */
  severity: number;
  applicable: boolean;
}

export type AnalysisResultKind = "scored" | "low_confidence";

export interface PriorityFix {
  checkpoint: CheckpointKey;
  /** Why this checkpoint (dependency-aware), for the result screen. */
  reasonKey: string;
  severity: number;
  confidence: number;
}

/** The complete result of analyzing one stroke. */
export interface ShotAnalysis {
  /** Client-generated UUID (offline-first). */
  id: string;
  sessionId: string | null;
  shotType: ShotTypeSlug;
  cameraView: CameraView;
  handedness: Handedness;
  capturedAtIso: string;
  timestamps: { startMs: number; contactMs: number | null; endMs: number };
  phases: PhaseSpan[];
  measurements: Measurement[];
  checkpoints: CheckpointScore[];
  /** 0..10 with one decimal, null when result is LOW_CONFIDENCE. */
  overallScore: number | null;
  analysisConfidence: number;
  resultKind: AnalysisResultKind;
  /** Actionable setup guidance when low confidence. */
  guidance: string | null;
  priorityFix: PriorityFix | null;
  versionVector: VersionVector;
  source: AnalysisSource;
}
