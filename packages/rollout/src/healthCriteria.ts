import { createHash } from "node:crypto";

/**
 * FROZEN canary health criteria (rollout-health-frozen-v1).
 *
 * The criteria below are release-gate thresholds for staged model rollouts.
 * They are frozen: the canonical serialization is pinned by SHA-256, and the
 * evaluator refuses to run against a criteria set whose hash does not match.
 * No threshold can be silently loosened to make a sick canary look healthy.
 *
 * Verdict semantics mirror the coach gates: every metric is HEALTHY,
 * UNHEALTHY, or NOT_EVALUABLE, and NOT_EVALUABLE blocks promotion exactly
 * like UNHEALTHY. Absent data is never healthy.
 */

export const HEALTH_METRIC_IDS = [
  "crash_rate",
  "analysis_completion_rate",
  "analysis_latency_p95_ms",
  "capture_success_rate",
  "abstention_rate",
  "silent_failure_rate",
] as const;
export type HealthMetricId = (typeof HEALTH_METRIC_IDS)[number];

export type MetricDirection = "at_most" | "at_least";

export interface HealthMetricCriterion {
  id: HealthMetricId;
  title: string;
  /** at_most: value must be <= threshold; at_least: value must be >= threshold. */
  direction: MetricDirection;
  threshold: number;
  /** Below this sample count the metric is NOT_EVALUABLE, never healthy. */
  minSampleCount: number;
}

export interface HealthCriteria {
  id: string;
  schemaVersion: 1;
  metrics: readonly HealthMetricCriterion[];
}

export const FROZEN_HEALTH_CRITERIA_V1: HealthCriteria = {
  id: "rollout-health-frozen-v1",
  schemaVersion: 1,
  metrics: [
    {
      id: "crash_rate",
      title: "App crash rate per analysis session",
      direction: "at_most",
      threshold: 0.01,
      minSampleCount: 200,
    },
    {
      id: "analysis_completion_rate",
      title: "Started analyses that reach a terminal result (including honest abstention)",
      direction: "at_least",
      threshold: 0.95,
      minSampleCount: 100,
    },
    {
      id: "analysis_latency_p95_ms",
      title: "p95 end-to-end analysis latency (ms)",
      direction: "at_most",
      threshold: 15000,
      minSampleCount: 100,
    },
    {
      id: "capture_success_rate",
      title: "Motion-triggered captures that persist a playable clip",
      direction: "at_least",
      threshold: 0.9,
      minSampleCount: 100,
    },
    {
      id: "abstention_rate",
      title: "Analyses ending in abstention (a spike signals a degraded candidate)",
      direction: "at_most",
      threshold: 0.6,
      minSampleCount: 100,
    },
    {
      id: "silent_failure_rate",
      title: "Silent-failure indicators: results emitted with missing/contradictory evidence",
      direction: "at_most",
      threshold: 0.005,
      minSampleCount: 100,
    },
  ],
};

/** Pinned SHA-256 of canonicalizeHealthCriteria(FROZEN_HEALTH_CRITERIA_V1). */
export const FROZEN_HEALTH_CRITERIA_V1_SHA256 =
  "8dc9d70b7d3bca52ff682b39967ffa2f650596a7681e85c00880d515471031e4" as const;

/** Deterministic serialization used for the frozen-hash pin. */
export function canonicalizeHealthCriteria(criteria: HealthCriteria): string {
  return JSON.stringify({
    id: criteria.id,
    schemaVersion: criteria.schemaVersion,
    metrics: criteria.metrics.map((m) => ({
      id: m.id,
      title: m.title,
      direction: m.direction,
      threshold: m.threshold,
      minSampleCount: m.minSampleCount,
    })),
  });
}

export function healthCriteriaSha256(criteria: HealthCriteria): string {
  return createHash("sha256").update(canonicalizeHealthCriteria(criteria)).digest("hex");
}

/** Throws unless the criteria hash to the pinned frozen value. */
export function assertFrozenCriteria(criteria: HealthCriteria): void {
  const actual = healthCriteriaSha256(criteria);
  if (criteria.id !== FROZEN_HEALTH_CRITERIA_V1.id || actual !== FROZEN_HEALTH_CRITERIA_V1_SHA256) {
    throw new Error(
      `Health criteria ${criteria.id} do not match the frozen pin ` +
        `(sha256 ${actual} != ${FROZEN_HEALTH_CRITERIA_V1_SHA256}).`,
    );
  }
}

export type MetricVerdict = "HEALTHY" | "UNHEALTHY" | "NOT_EVALUABLE";
export type OverallHealth = "HEALTHY" | "UNHEALTHY" | "NOT_EVALUABLE";

/**
 * One observed metric window. `sampleCount` is the number of underlying
 * events (sessions, analyses, captures) the value was computed from.
 */
export interface MetricObservation {
  value: number;
  sampleCount: number;
}

/** Absent (null) means "we have no measurement" — that is NOT_EVALUABLE. */
export type HealthInputs = Readonly<Record<HealthMetricId, MetricObservation | null>>;

export interface MetricResult {
  id: HealthMetricId;
  verdict: MetricVerdict;
  /** Honest evidence statement — what was measured or what is missing. */
  detail: string;
}

export interface HealthReport {
  criteriaId: string;
  criteriaSha256: string;
  overall: OverallHealth;
  metrics: MetricResult[];
}

function evaluateMetric(
  criterion: HealthMetricCriterion,
  observation: MetricObservation | null,
): MetricResult {
  if (observation === null) {
    return {
      id: criterion.id,
      verdict: "NOT_EVALUABLE",
      detail: "No measurement available for this window.",
    };
  }
  if (!Number.isFinite(observation.value) || !Number.isInteger(observation.sampleCount)) {
    return {
      id: criterion.id,
      verdict: "NOT_EVALUABLE",
      detail: `Malformed observation (value=${String(observation.value)}, samples=${String(observation.sampleCount)}).`,
    };
  }
  if (observation.sampleCount < criterion.minSampleCount) {
    return {
      id: criterion.id,
      verdict: "NOT_EVALUABLE",
      detail: `Only ${observation.sampleCount} samples; ${criterion.minSampleCount} required.`,
    };
  }
  const within =
    criterion.direction === "at_most"
      ? observation.value <= criterion.threshold
      : observation.value >= criterion.threshold;
  return {
    id: criterion.id,
    verdict: within ? "HEALTHY" : "UNHEALTHY",
    detail:
      `${observation.value} (${observation.sampleCount} samples) vs ` +
      `${criterion.direction} ${criterion.threshold}.`,
  };
}

/**
 * Evaluates one health window against the frozen criteria. Overall is
 * HEALTHY only when EVERY metric is HEALTHY; any UNHEALTHY metric makes the
 * window UNHEALTHY; otherwise the window is NOT_EVALUABLE.
 */
export function evaluateHealth(inputs: HealthInputs, criteria: HealthCriteria): HealthReport {
  assertFrozenCriteria(criteria);
  const metrics = criteria.metrics.map((criterion) =>
    evaluateMetric(criterion, inputs[criterion.id]),
  );
  const overall: OverallHealth = metrics.some((m) => m.verdict === "UNHEALTHY")
    ? "UNHEALTHY"
    : metrics.every((m) => m.verdict === "HEALTHY")
      ? "HEALTHY"
      : "NOT_EVALUABLE";
  return {
    criteriaId: criteria.id,
    criteriaSha256: healthCriteriaSha256(criteria),
    overall,
    metrics,
  };
}
