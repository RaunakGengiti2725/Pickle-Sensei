import type { OperationFailure } from "@pickle/shared-types";

/**
 * Model provenance — every machine-produced artifact in the swing domain
 * carries one of these. The application never needs to know whether a value
 * came from a deterministic algorithm, Core ML, ONNX, a server transformer,
 * or a runtime that does not exist yet; it only consumes these records.
 */

export const MODEL_TASKS = [
  "pose_estimation",
  "paddle_detection",
  "paddle_tracking",
  "ball_detection",
  "ball_tracking",
  "court_detection",
  "camera_calibration",
  "stroke_trigger",
  "stroke_classification",
  "phase_segmentation",
  "target_player_tracking",
  "stroke_event_detection",
  "paddle_ownership",
  "paddle_selection",
  "paddle_track_merge",
  "contact_estimation",
  "stroke_auto_resolution",
  "capture_completion",
  "biomechanics_extraction",
  "temporal_encoding",
  "technique_scoring",
  "fault_detection",
  "uncertainty_estimation",
  "coaching_ranking",
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

export const MODEL_RUNTIMES = [
  "deterministic",
  "vision_framework",
  "mediapipe",
  "coreml",
  "onnx",
  "tflite",
  "pytorch",
  "tensorflow",
  "server_remote",
  "unknown_future_runtime",
] as const;
export type ModelRuntime = (typeof MODEL_RUNTIMES)[number];

export const EXECUTION_TARGETS = ["on_device", "server", "hybrid"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

/** Identity of the exact model/algorithm that produced an artifact. */
export interface ModelRef {
  /** Stable provider id, e.g. "pose.apple-vision", "scorer.sm-v1". */
  providerId: string;
  /** Artifact/semantic version, e.g. "apple-vision-bodypose-1", "sm-v1". */
  modelVersion: string;
  runtime: ModelRuntime;
  executionTarget: ExecutionTarget;
  /** SHA-256 of the model artifact when one exists; null for pure code. */
  artifactHash: string | null;
}

/** One recorded execution of a model over one capture. Immutable. */
export interface ModelRunRecord {
  id: string;
  task: ModelTask;
  model: ModelRef;
  inputSchemaVersion: number;
  outputSchemaVersion: number;
  startedAtIso: string;
  completedAtIso: string;
  status: "succeeded" | "failed" | "abstained";
  /** Present when status !== "succeeded". */
  failure: OperationFailure | null;
}
