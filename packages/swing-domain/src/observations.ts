import type { ModelRef } from "./provenance.js";

/**
 * Canonical temporal observations. These are the durable, framework-neutral
 * shapes every downstream system consumes. Native pose stacks (Apple Vision,
 * MediaPipe, future models) are converted INTO these; nothing downstream may
 * depend on a vendor's native structure.
 *
 * Temporal data is first-class: sequences preserve per-frame timestamps and
 * never collapse into aggregates. Coordinates always declare their system,
 * and every landmark permits an optional z so 3D pose models slot in without
 * a schema change.
 */

export const COORDINATE_SYSTEMS = [
  /** x,y in [0,1] relative to the image, origin top-left. */
  "normalized_image_top_left",
  /** x,y in pixels, origin top-left. */
  "image_pixels",
  /** Metric camera-space coordinates. */
  "camera_meters",
  /** Metric world/court coordinates (requires court calibration). */
  "world_meters",
  /** Body-relative units (e.g. torso lengths); origin documented per producer. */
  "body_normalized",
] as const;
export type CoordinateSystem = (typeof COORDINATE_SYSTEMS)[number];

export interface CanonicalLandmark {
  /** Canonical joint vocabulary where known; unknown names are preserved. */
  name: string;
  x: number;
  y: number;
  /** Present only when the producing model measures depth. */
  z?: number;
  /** 0..1 measurement confidence for this landmark. */
  visibility: number;
}

export interface CanonicalPoseFrame {
  frameIndex: number;
  /** Clip-relative milliseconds (0 = first frame of the stored clip). */
  timestampMs: number;
  landmarks: CanonicalLandmark[];
  /** Whole-frame confidence 0..1. */
  confidence: number;
}

export const POSE_SEQUENCE_SCHEMA_VERSION = 1 as const;
export const POSE_SEQUENCE_FORMAT = "pickle.pose-sequence.v1" as const;

/** A full temporal pose record for one stored clip window. */
export interface PoseSequence {
  schemaVersion: typeof POSE_SEQUENCE_SCHEMA_VERSION;
  format: typeof POSE_SEQUENCE_FORMAT;
  coordinateSystem: CoordinateSystem;
  producedBy: ModelRef;
  video: PoseSequenceVideo;
  /** Ascending by timestampMs; gaps are real (missed inference), never filled. */
  frames: CanonicalPoseFrame[];
}

/** How a writer arrived at `PoseSequenceVideo.fps`. */
export const POSE_FPS_SOURCES = ["observed_sample_cadence", "nominal_frame_rate"] as const;
export type PoseFpsSource = (typeof POSE_FPS_SOURCES)[number];

export interface PoseSequenceVideo {
  width: number;
  height: number;
  /** Effective sample rate of `frames` — the observed cadence when the writer
   * could measure it (`fpsSource`), else the container's nominal rate. */
  fps: number;
  /** Container/track nominal frame rate as declared by the asset, recorded
   * beside the effective rate so a wrong declaration stays visible. */
  nominalFps?: number;
  fpsSource?: PoseFpsSource;
  /** True when `nominalFps` and the observed cadence disagree materially. */
  fpsMismatch?: boolean;
}

/** Durable pointer to a pose sequence stored beside its clip. */
export interface PoseSequenceRef {
  schemaVersion: typeof POSE_SEQUENCE_SCHEMA_VERSION;
  format: typeof POSE_SEQUENCE_FORMAT;
  uri: string;
  frameCount: number;
  sha256: string;
  coordinateSystem: CoordinateSystem;
  poseModelVersion: string;
}

export interface PaddleObservation {
  frameIndex: number;
  timestampMs: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  keypoints: {
    handleEnd: { x: number; y: number; z?: number } | null;
    throat: { x: number; y: number; z?: number } | null;
    center: { x: number; y: number; z?: number } | null;
    tip: { x: number; y: number; z?: number } | null;
  };
  confidence: number;
}

export interface PaddleTrack {
  schemaVersion: 1;
  coordinateSystem: CoordinateSystem;
  producedBy: ModelRef;
  observations: PaddleObservation[];
  /** 0..1 track continuity across the window. */
  continuity: number;
}

export interface BallObservation {
  frameIndex: number;
  timestampMs: number;
  x: number;
  y: number;
  z?: number;
  confidence: number;
}

export interface BallTrack {
  schemaVersion: 1;
  coordinateSystem: CoordinateSystem;
  producedBy: ModelRef;
  observations: BallObservation[];
  contact: { timestampMs: number; confidence: number } | null;
  bounce: { timestampMs: number; confidence: number } | null;
  continuity: number;
}

export interface CourtGeometry {
  schemaVersion: 1;
  producedBy: ModelRef;
  /** Homography from image to court plane, row-major 3x3; null when unsolved. */
  imageToCourtHomography: number[] | null;
  keypoints: Array<{ name: string; x: number; y: number; confidence: number }>;
  confidence: number;
}

export interface CameraCalibration {
  schemaVersion: 1;
  producedBy: ModelRef;
  intrinsics: {
    focalLengthPx: { x: number; y: number } | null;
    principalPointPx: { x: number; y: number } | null;
  };
  /** Metres per normalized unit at the athlete's plane, when solvable. */
  metricScale: number | null;
  confidence: number;
}

/** A learned temporal representation of the swing (model-defined space). */
export interface LearnedEmbedding {
  schemaVersion: 1;
  producedBy: ModelRef;
  /** Identifier of the embedding space; vectors are only comparable within one. */
  space: string;
  vector: number[];
  confidence: number;
}

/**
 * Honesty at the type level: a modality is either genuinely measured with
 * provenance, or explicitly unavailable with a reason. There is no third
 * state and no way to represent fabricated data.
 */
export type ModalityRecord<T> =
  { status: "measured"; data: T } | { status: "unavailable"; reason: string };

export function measured<T>(data: T): ModalityRecord<T> {
  return { status: "measured", data };
}

export function unavailable<T>(reason: string): ModalityRecord<T> {
  return { status: "unavailable", reason };
}
