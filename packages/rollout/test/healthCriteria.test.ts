import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  assertFrozenCriteria,
  evaluateHealth,
  healthCriteriaSha256,
  type HealthCriteria,
  type HealthInputs,
  type MetricObservation,
} from "../src/index.js";

function healthyInputs(): Record<(typeof HEALTH_METRIC_IDS)[number], MetricObservation> {
  return {
    crash_rate: { value: 0.001, sampleCount: 500 },
    analysis_completion_rate: { value: 0.99, sampleCount: 400 },
    analysis_latency_p95_ms: { value: 6000, sampleCount: 400 },
    capture_success_rate: { value: 0.97, sampleCount: 300 },
    abstention_rate: { value: 0.2, sampleCount: 400 },
    silent_failure_rate: { value: 0, sampleCount: 400 },
  };
}

describe("frozen health criteria", () => {
  it("matches the pinned SHA-256 and covers every metric id", () => {
    expect(healthCriteriaSha256(FROZEN_HEALTH_CRITERIA_V1)).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
    expect(FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => m.id).sort()).toEqual(
      [...HEALTH_METRIC_IDS].sort(),
    );
  });

  it("refuses tampered criteria (a loosened threshold cannot evaluate)", () => {
    const tampered: HealthCriteria = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) =>
        m.id === "crash_rate" ? { ...m, threshold: 0.5 } : m,
      ),
    };
    expect(() => assertFrozenCriteria(tampered)).toThrow(/frozen pin/);
    expect(() => evaluateHealth(healthyInputs(), tampered)).toThrow(/frozen pin/);
  });

  it("is HEALTHY only when every metric is measured, sufficient, and within threshold", () => {
    const report = evaluateHealth(healthyInputs(), FROZEN_HEALTH_CRITERIA_V1);
    expect(report.overall).toBe("HEALTHY");
    expect(report.metrics.every((m) => m.verdict === "HEALTHY")).toBe(true);
  });

  it("treats absent data as NOT_EVALUABLE, never healthy", () => {
    const inputs: HealthInputs = { ...healthyInputs(), silent_failure_rate: null };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(report.overall).toBe("NOT_EVALUABLE");
    expect(report.metrics.find((m) => m.id === "silent_failure_rate")?.verdict).toBe(
      "NOT_EVALUABLE",
    );
  });

  it("treats insufficient samples as NOT_EVALUABLE", () => {
    const inputs: HealthInputs = {
      ...healthyInputs(),
      crash_rate: { value: 0, sampleCount: 10 },
    };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("NOT_EVALUABLE");
  });

  it("treats malformed observations (NaN, non-integer samples) as NOT_EVALUABLE", () => {
    const inputs: HealthInputs = {
      ...healthyInputs(),
      analysis_latency_p95_ms: { value: Number.NaN, sampleCount: 400 },
    };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("NOT_EVALUABLE");
    const inputs2: HealthInputs = {
      ...healthyInputs(),
      crash_rate: { value: 0, sampleCount: 10.5 },
    };
    expect(evaluateHealth(inputs2, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("NOT_EVALUABLE");
  });

  it("any single breached metric makes the window UNHEALTHY", () => {
    const inputs: HealthInputs = {
      ...healthyInputs(),
      abstention_rate: { value: 0.8, sampleCount: 400 },
    };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(report.overall).toBe("UNHEALTHY");
  });

  it("UNHEALTHY dominates NOT_EVALUABLE for the overall verdict", () => {
    const inputs: HealthInputs = {
      ...healthyInputs(),
      abstention_rate: { value: 0.8, sampleCount: 400 },
      crash_rate: null,
    };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("UNHEALTHY");
  });
});
