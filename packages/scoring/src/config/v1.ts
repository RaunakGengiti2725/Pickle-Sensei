import type { CheckpointKey, ShotTypeSlug } from "@pickle/shared-types";
import type {
  CheckpointConfig,
  CheckpointDependency,
  MetricTarget,
  ShotScoringConfig,
} from "../types.js";

/**
 * Scoring model v1 — the initial shot weighting matrix straight from the
 * blueprint (spec p. 32) plus metric targets for the four MVP strokes.
 *
 * IMPORTANT: weights and target ranges are the blueprint's explicitly labeled
 * "starting hypothesis for expert validation" — they must be calibrated with
 * the coach advisory panel before any public launch (spec pp. 32, 34, 51).
 * They are versioned so recalibration produces sm-v2 without rescoring history.
 */

export const SCORING_MODEL_VERSION = "sm-v1";

/** Columns per spec p. 32; every column sums to 100. */
export const WEIGHT_MATRIX: Record<ShotTypeSlug, Record<CheckpointKey, number>> = {
  serve: {
    ready_position: 8,
    athletic_base: 10,
    preparation: 8,
    paddle_set: 8,
    swing_length: 8,
    sequencing: 12,
    paddle_path: 12,
    contact_position: 16,
    face_wrist_stability: 8,
    follow_through: 5,
    recovery: 5,
  },
  return: {
    ready_position: 6,
    athletic_base: 12,
    preparation: 10,
    paddle_set: 7,
    swing_length: 7,
    sequencing: 11,
    paddle_path: 12,
    contact_position: 16,
    face_wrist_stability: 8,
    follow_through: 5,
    recovery: 6,
  },
  forehand_drive: {
    ready_position: 5,
    athletic_base: 10,
    preparation: 12,
    paddle_set: 8,
    swing_length: 8,
    sequencing: 12,
    paddle_path: 12,
    contact_position: 15,
    face_wrist_stability: 8,
    follow_through: 5,
    recovery: 5,
  },
  backhand_drive: {
    ready_position: 5,
    athletic_base: 10,
    preparation: 12,
    paddle_set: 8,
    swing_length: 8,
    sequencing: 12,
    paddle_path: 12,
    contact_position: 15,
    face_wrist_stability: 8,
    follow_through: 5,
    recovery: 5,
  },
  third_shot_drop: {
    ready_position: 6,
    athletic_base: 12,
    preparation: 8,
    paddle_set: 10,
    swing_length: 8,
    sequencing: 8,
    paddle_path: 12,
    contact_position: 16,
    face_wrist_stability: 12,
    follow_through: 4,
    recovery: 4,
  },
  dink: {
    ready_position: 8,
    athletic_base: 15,
    preparation: 4,
    paddle_set: 10,
    swing_length: 5,
    sequencing: 4,
    paddle_path: 10,
    contact_position: 18,
    face_wrist_stability: 15,
    follow_through: 5,
    recovery: 6,
  },
  volley: {
    ready_position: 10,
    athletic_base: 15,
    preparation: 5,
    paddle_set: 12,
    swing_length: 2,
    sequencing: 4,
    paddle_path: 8,
    contact_position: 18,
    face_wrist_stability: 16,
    follow_through: 3,
    recovery: 7,
  },
  overhead: {
    ready_position: 5,
    athletic_base: 10,
    preparation: 12,
    paddle_set: 8,
    swing_length: 10,
    sequencing: 15,
    paddle_path: 12,
    contact_position: 13,
    face_wrist_stability: 5,
    follow_through: 6,
    recovery: 4,
  },
};

/**
 * Coach dependency graph (spec p. 35): faults propagate cause → effect.
 * Kept small and reviewable; the coach advisory panel owns its evolution.
 */
export const DEPENDENCIES_V1: CheckpointDependency[] = [
  { cause: "ready_position", effect: "preparation" },
  { cause: "athletic_base", effect: "sequencing" },
  { cause: "preparation", effect: "paddle_path" },
  { cause: "preparation", effect: "contact_position" },
  { cause: "paddle_set", effect: "swing_length" },
  { cause: "swing_length", effect: "contact_position" },
  { cause: "sequencing", effect: "contact_position" },
  { cause: "paddle_path", effect: "contact_position" },
  { cause: "contact_position", effect: "face_wrist_stability" },
  { cause: "swing_length", effect: "recovery" },
];

function target(
  metricKey: string,
  lower: number,
  upper: number,
  sigma: number,
  importance: number,
  directionBelow: MetricTarget["directionBelow"],
  directionAbove: MetricTarget["directionAbove"],
): MetricTarget {
  return { metricKey, lower, upper, sigma, importance, directionBelow, directionAbove };
}

/** Coach-priority and changeability starting values (uniform-ish; panel-owned). */
const COACH_PRIORITY: Record<CheckpointKey, number> = {
  ready_position: 1.0,
  athletic_base: 1.2,
  preparation: 1.5,
  paddle_set: 1.2,
  swing_length: 1.3,
  sequencing: 1.1,
  paddle_path: 1.3,
  contact_position: 1.4,
  face_wrist_stability: 1.2,
  follow_through: 0.8,
  recovery: 0.9,
};

const CHANGEABILITY: Record<CheckpointKey, number> = {
  ready_position: 0.95,
  athletic_base: 0.85,
  preparation: 0.9,
  paddle_set: 0.9,
  swing_length: 0.85,
  sequencing: 0.6,
  paddle_path: 0.7,
  contact_position: 0.65,
  face_wrist_stability: 0.6,
  follow_through: 0.8,
  recovery: 0.8,
};

/**
 * Metric target sets per MVP shot. Units are body-relative normalized
 * quantities (torso-length normalized distances), degrees, or milliseconds —
 * coordinate conventions documented in docs/ARCHITECTURE.md.
 */
const METRICS: Partial<Record<ShotTypeSlug, Partial<Record<CheckpointKey, MetricTarget[]>>>> = {
  forehand_drive: {
    ready_position: [target("paddle_ready_height_ratio", 0.25, 0.6, 0.2, 1, "low", "high")],
    athletic_base: [
      target("stance_width_ratio", 1.0, 1.7, 0.35, 1, "narrow", "wide"),
      target("knee_flexion_deg", 15, 45, 15, 0.8, "low", "high"),
    ],
    preparation: [target("shoulder_turn_deg", 30, 70, 18, 1, "short", "long")],
    paddle_set: [target("paddle_set_height_ratio", 0.2, 0.55, 0.2, 1, "low", "high")],
    swing_length: [target("backswing_length_norm", 0.5, 1.1, 0.3, 1, "short", "long")],
    sequencing: [
      target("hip_shoulder_lag_ms", 20, 120, 50, 1, "short", "long"),
      target("weight_transfer_norm", 0.15, 0.5, 0.15, 0.8, "short", "long"),
    ],
    paddle_path: [target("path_low_to_high_slope", 0.15, 0.6, 0.2, 1, "low", "high")],
    contact_position: [
      target("contact_forward_of_hip_norm", 0.25, 0.6, 0.15, 1, "late", "early"),
      target("contact_height_ratio", 0.25, 0.55, 0.15, 0.7, "low", "high"),
    ],
    face_wrist_stability: [target("wrist_angle_variance_deg", 0, 12, 8, 1, "none", "unstable")],
    follow_through: [target("follow_through_length_norm", 0.5, 1.2, 0.35, 1, "short", "long")],
    recovery: [target("recovery_time_ms", 0, 900, 350, 1, "none", "long")],
  },
  dink: {
    ready_position: [target("paddle_ready_height_ratio", 0.3, 0.65, 0.18, 1, "low", "high")],
    athletic_base: [
      target("stance_width_ratio", 1.0, 1.8, 0.35, 1, "narrow", "wide"),
      target("knee_flexion_deg", 20, 55, 15, 1, "low", "high"),
    ],
    preparation: [target("shoulder_turn_deg", 0, 25, 12, 1, "short", "long")],
    paddle_set: [target("paddle_set_forward_norm", 0.15, 0.5, 0.15, 1, "late", "early")],
    swing_length: [target("backswing_length_norm", 0.0, 0.35, 0.15, 1, "short", "long")],
    sequencing: [target("weight_transfer_norm", 0.0, 0.25, 0.12, 1, "short", "long")],
    paddle_path: [target("path_low_to_high_slope", 0.05, 0.4, 0.15, 1, "low", "high")],
    contact_position: [
      target("contact_forward_of_hip_norm", 0.2, 0.55, 0.12, 1, "late", "early"),
      target("contact_height_ratio", 0.05, 0.35, 0.12, 0.8, "low", "high"),
    ],
    face_wrist_stability: [target("wrist_angle_variance_deg", 0, 8, 6, 1, "none", "unstable")],
    follow_through: [target("follow_through_length_norm", 0.05, 0.45, 0.18, 1, "short", "long")],
    recovery: [target("recovery_time_ms", 0, 700, 300, 1, "none", "long")],
  },
  third_shot_drop: {
    ready_position: [target("paddle_ready_height_ratio", 0.25, 0.6, 0.2, 1, "low", "high")],
    athletic_base: [
      target("stance_width_ratio", 1.0, 1.7, 0.35, 1, "narrow", "wide"),
      target("knee_flexion_deg", 20, 50, 15, 1, "low", "high"),
    ],
    preparation: [target("shoulder_turn_deg", 10, 40, 15, 1, "short", "long")],
    paddle_set: [target("paddle_set_height_ratio", 0.1, 0.4, 0.15, 1, "low", "high")],
    swing_length: [target("backswing_length_norm", 0.15, 0.6, 0.2, 1, "short", "long")],
    sequencing: [target("weight_transfer_norm", 0.1, 0.35, 0.12, 1, "short", "long")],
    paddle_path: [target("path_low_to_high_slope", 0.2, 0.6, 0.18, 1, "low", "high")],
    contact_position: [
      target("contact_forward_of_hip_norm", 0.2, 0.55, 0.13, 1, "late", "early"),
      target("contact_height_ratio", 0.1, 0.4, 0.12, 0.8, "low", "high"),
    ],
    face_wrist_stability: [target("wrist_angle_variance_deg", 0, 9, 6, 1, "none", "unstable")],
    follow_through: [target("follow_through_length_norm", 0.2, 0.7, 0.2, 1, "short", "long")],
    recovery: [target("recovery_time_ms", 0, 800, 320, 1, "none", "long")],
  },
  serve: {
    ready_position: [target("paddle_ready_height_ratio", 0.15, 0.5, 0.18, 1, "low", "high")],
    athletic_base: [
      target("stance_width_ratio", 1.0, 1.7, 0.35, 1, "narrow", "wide"),
      target("knee_flexion_deg", 10, 40, 15, 0.8, "low", "high"),
    ],
    preparation: [target("shoulder_turn_deg", 25, 65, 18, 1, "short", "long")],
    paddle_set: [target("paddle_set_height_ratio", 0.0, 0.35, 0.15, 1, "low", "high")],
    swing_length: [target("backswing_length_norm", 0.4, 1.0, 0.3, 1, "short", "long")],
    sequencing: [
      target("hip_shoulder_lag_ms", 20, 130, 55, 1, "short", "long"),
      target("weight_transfer_norm", 0.2, 0.55, 0.15, 1, "short", "long"),
    ],
    paddle_path: [target("path_low_to_high_slope", 0.3, 0.8, 0.2, 1, "low", "high")],
    contact_position: [
      target("contact_forward_of_hip_norm", 0.3, 0.65, 0.15, 1, "late", "early"),
      target("contact_height_ratio", 0.1, 0.4, 0.12, 1, "low", "high"),
    ],
    face_wrist_stability: [target("wrist_angle_variance_deg", 0, 12, 8, 1, "none", "unstable")],
    follow_through: [target("follow_through_length_norm", 0.5, 1.2, 0.35, 1, "short", "long")],
    recovery: [target("recovery_time_ms", 0, 1000, 400, 1, "none", "long")],
  },
};

function buildShotConfig(shotType: ShotTypeSlug): ShotScoringConfig {
  const weights = WEIGHT_MATRIX[shotType];
  const metricSets = METRICS[shotType] ?? {};
  const checkpoints: CheckpointConfig[] = (Object.keys(weights) as CheckpointKey[]).map((key) => ({
    key,
    weight: weights[key],
    coachPriority: COACH_PRIORITY[key],
    changeability: CHANGEABILITY[key],
    metrics: metricSets[key] ?? [],
  }));
  return {
    shotType,
    shotConfigVersion: `${shotType}@1`,
    scoringModelVersion: SCORING_MODEL_VERSION,
    minAnalysisConfidence: 0.65,
    lowerConfidenceThreshold: 0.8,
    checkpoints,
    dependencies: DEPENDENCIES_V1,
  };
}

const CONFIGS = new Map<ShotTypeSlug, ShotScoringConfig>();
for (const shotType of Object.keys(WEIGHT_MATRIX) as ShotTypeSlug[]) {
  CONFIGS.set(shotType, buildShotConfig(shotType));
}

export function getShotScoringConfig(shotType: ShotTypeSlug): ShotScoringConfig {
  const config = CONFIGS.get(shotType);
  if (!config) throw new Error(`No scoring config for shot type: ${shotType}`);
  return config;
}

export function getAllShotScoringConfigs(): ShotScoringConfig[] {
  return [...CONFIGS.values()];
}
