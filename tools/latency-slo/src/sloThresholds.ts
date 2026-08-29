/**
 * Frozen SLO thresholds and regression-alert configuration for the metric
 * MOVEMENT_COMPLETION -> RESULT_INTERACTIVE.
 *
 * Frozen 2026-08-29. The tier numbers are identical to the GATE B
 * iphone-latency-targets-v1 (ideal <=2000ms, strong <=3000ms, max <=5000ms,
 * judged at p95) so device evidence and Linux-bench trend tracking share one
 * bar. Changing any number requires a new version string and a decision-log
 * entry — never edit v1 in place.
 */

export const LATENCY_SLO_THRESHOLDS_VERSION = "latency-slo-thresholds-v1" as const;

export interface LatencySloThresholdsV1 {
  version: typeof LATENCY_SLO_THRESHOLDS_VERSION;
  metric: "MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE";
  /** Percentile the tier verdict is judged on. */
  judgedPercentile: "p95";
  idealMs: number;
  strongMs: number;
  maxMs: number;
}

export const LATENCY_SLO_THRESHOLDS: LatencySloThresholdsV1 = {
  version: LATENCY_SLO_THRESHOLDS_VERSION,
  metric: "MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE",
  judgedPercentile: "p95",
  idealMs: 2000,
  strongMs: 3000,
  maxMs: 5000,
};

export type SloTier = "IDEAL" | "STRONG" | "MAX" | "FAIL";

const TIER_RANK: Record<SloTier, number> = { IDEAL: 0, STRONG: 1, MAX: 2, FAIL: 3 };

/** Tier for a judged latency value against the frozen thresholds. */
export function sloTier(
  judgedMs: number,
  thresholds: LatencySloThresholdsV1 = LATENCY_SLO_THRESHOLDS,
): SloTier {
  if (!Number.isFinite(judgedMs) || judgedMs < 0) {
    throw new Error(`sloTier: invalid judged latency ${judgedMs}`);
  }
  if (judgedMs <= thresholds.idealMs) return "IDEAL";
  if (judgedMs <= thresholds.strongMs) return "STRONG";
  if (judgedMs <= thresholds.maxMs) return "MAX";
  return "FAIL";
}

/** True when `current` is a worse tier than `baseline`. */
export function isTierDegradation(baseline: SloTier, current: SloTier): boolean {
  return TIER_RANK[current] > TIER_RANK[baseline];
}

/**
 * Frozen regression-alert configuration. A p95 regression only alerts when it
 * exceeds BOTH the relative and the absolute floor, so timer jitter on fast
 * slices cannot page anyone; slices with fewer than `minSamplesForAlert`
 * samples produce LOW_SAMPLE warnings instead of alerts.
 */
export const LATENCY_SLO_ALERT_CONFIG_VERSION = "latency-slo-regression-alerts-v1" as const;

export interface LatencySloAlertConfigV1 {
  version: typeof LATENCY_SLO_ALERT_CONFIG_VERSION;
  p95RegressionPct: number;
  p95RegressionAbsMs: number;
  minSamplesForAlert: number;
}

export const LATENCY_SLO_ALERT_CONFIG: LatencySloAlertConfigV1 = {
  version: LATENCY_SLO_ALERT_CONFIG_VERSION,
  p95RegressionPct: 10,
  p95RegressionAbsMs: 200,
  minSamplesForAlert: 5,
};
