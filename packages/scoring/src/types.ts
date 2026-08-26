import type { CheckpointKey, FaultDirection, ShotTypeSlug } from "@pickle/shared-types";

/**
 * Data-driven scoring configuration (directive §20): the database/config —
 * not code — decides applicability, weights, targets, thresholds and
 * dependencies. No shot-specific switch blocks.
 */

export interface MetricTarget {
  metricKey: string;
  /** Acceptable interval [lower, upper] — full credit inside (spec p. 33). */
  lower: number;
  upper: number;
  /** Decay width σ_m for q_m = 100·exp(−½(d/σ)²). */
  sigma: number;
  /** Metric importance a_m. */
  importance: number;
  /** Fault direction reported when the value is below `lower` / above `upper`. */
  directionBelow: FaultDirection;
  directionAbove: FaultDirection;
}

export interface CheckpointConfig {
  key: CheckpointKey;
  /** W_j from the shot weighting matrix (per-shot column sums to 100). */
  weight: number;
  /** Coach-priority multiplier for the priority engine (typically 0.5–2). */
  coachPriority: number;
  /** How coachable/fixable this checkpoint is (0..1). */
  changeability: number;
  metrics: MetricTarget[];
}

/** Coaching dependency: a fault at `cause` tends to produce faults at `effect`. */
export interface CheckpointDependency {
  cause: CheckpointKey;
  effect: CheckpointKey;
}

export interface ShotScoringConfig {
  shotType: ShotTypeSlug;
  /** e.g. "forehand_drive@1" — persisted on every analysis. */
  shotConfigVersion: string;
  /** e.g. "sm-v1" — the scoring model release. */
  scoringModelVersion: string;
  /** Below this analysis confidence the engine abstains (spec: 0.65). */
  minAnalysisConfidence: number;
  /** Between min and this, results carry a "lower confidence" indicator (spec: 0.80). */
  lowerConfidenceThreshold: number;
  checkpoints: CheckpointConfig[];
  dependencies: CheckpointDependency[];
}

export interface MetricScoreDetail {
  metricKey: string;
  value: number;
  q: number;
  confidence: number;
  direction: FaultDirection;
}

export interface CheckpointResultDetail {
  key: CheckpointKey;
  score: number | null;
  confidence: number;
  severity: number;
  direction: FaultDirection;
  applicable: boolean;
  observed: boolean;
  metricDetails: MetricScoreDetail[];
}

export type ConfidencePresentation = "normal" | "lower_confidence" | "abstain";
