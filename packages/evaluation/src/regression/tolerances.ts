import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import { REGRESSION_CONTRACT_ID } from "./summarySchema.js";

/**
 * Committed tolerance configuration for `bench:compare`
 * (`packages/evaluation/regression.tolerances.json`).
 *
 * - `higher_is_better` / `lower_is_better`: a move in the bad direction by
 *   MORE than `absoluteTolerance` is a regression; a move in the good
 *   direction by more than the tolerance is an improvement.
 * - `informational`: reported, never fails the comparison (e.g. wall clock,
 *   counts whose "good" direction is not defined).
 *
 * Metrics present in a summary but absent from `metrics` fall under
 * `unlistedMetricPolicy`.
 */
export const TOLERANCE_CONFIG_VERSION = 1 as const;

export const METRIC_DIRECTIONS = ["higher_is_better", "lower_is_better", "informational"] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const UNLISTED_METRIC_POLICIES = ["informational", "fail"] as const;
export type UnlistedMetricPolicy = (typeof UNLISTED_METRIC_POLICIES)[number];

export interface MetricTolerance {
  direction: MetricDirection;
  /** Absolute slack in the metric's own unit; 0 = any bad move regresses. */
  absoluteTolerance: number;
  /** Why this tolerance exists — required so nobody widens it silently. */
  rationale: string;
}

export interface ToleranceConfig {
  configVersion: typeof TOLERANCE_CONFIG_VERSION;
  contract: typeof REGRESSION_CONTRACT_ID;
  contractVersion: number;
  unlistedMetricPolicy: UnlistedMetricPolicy;
  /** A baseline metric that is a number but null (unmeasurable) in the
   *  candidate is a regression when true. */
  lostMeasurementIsRegression: boolean;
  metrics: Record<string, MetricTolerance>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(code: string, message: string): Result<T> {
  return fail(failure("permanent", code, message));
}

export function validateToleranceConfig(raw: unknown): Result<ToleranceConfig> {
  if (!isRecord(raw)) return invalid("tolerances_not_object", "tolerance config must be an object");
  if (raw.configVersion !== TOLERANCE_CONFIG_VERSION) {
    return invalid(
      "tolerances_version",
      `configVersion must be ${TOLERANCE_CONFIG_VERSION} (got ${String(raw.configVersion)})`,
    );
  }
  if (raw.contract !== REGRESSION_CONTRACT_ID) {
    return invalid("tolerances_contract", `contract must be "${REGRESSION_CONTRACT_ID}"`);
  }
  if (!Number.isInteger(raw.contractVersion) || (raw.contractVersion as number) < 1) {
    return invalid("tolerances_contract_version", "contractVersion must be a positive integer");
  }
  if (
    typeof raw.unlistedMetricPolicy !== "string" ||
    !(UNLISTED_METRIC_POLICIES as readonly string[]).includes(raw.unlistedMetricPolicy)
  ) {
    return invalid(
      "tolerances_unlisted_policy",
      `unlistedMetricPolicy must be one of ${UNLISTED_METRIC_POLICIES.join(", ")}`,
    );
  }
  if (typeof raw.lostMeasurementIsRegression !== "boolean") {
    return invalid("tolerances_lost_measurement", "lostMeasurementIsRegression must be a boolean");
  }
  if (!isRecord(raw.metrics)) return invalid("tolerances_metrics", "metrics must be an object");
  const metrics: Record<string, MetricTolerance> = {};
  for (const [key, value] of Object.entries(raw.metrics)) {
    if (!isRecord(value)) return invalid("tolerance_entry", `metrics.${key} must be an object`);
    if (
      typeof value.direction !== "string" ||
      !(METRIC_DIRECTIONS as readonly string[]).includes(value.direction)
    ) {
      return invalid(
        "tolerance_direction",
        `metrics.${key}.direction must be one of ${METRIC_DIRECTIONS.join(", ")}`,
      );
    }
    if (
      typeof value.absoluteTolerance !== "number" ||
      !Number.isFinite(value.absoluteTolerance) ||
      value.absoluteTolerance < 0
    ) {
      return invalid(
        "tolerance_value",
        `metrics.${key}.absoluteTolerance must be a finite number >= 0`,
      );
    }
    if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
      return invalid("tolerance_rationale", `metrics.${key}.rationale must be a non-empty string`);
    }
    metrics[key] = {
      direction: value.direction as MetricDirection,
      absoluteTolerance: value.absoluteTolerance,
      rationale: value.rationale,
    };
  }
  return ok({
    configVersion: TOLERANCE_CONFIG_VERSION,
    contract: REGRESSION_CONTRACT_ID,
    contractVersion: raw.contractVersion as number,
    unlistedMetricPolicy: raw.unlistedMetricPolicy as UnlistedMetricPolicy,
    lostMeasurementIsRegression: raw.lostMeasurementIsRegression,
    metrics,
  });
}
