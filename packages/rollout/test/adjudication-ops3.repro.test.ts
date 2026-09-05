import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  HEALTH_METRIC_IDS,
  evaluateHealth,
  type HealthInputs,
  type MetricObservation,
} from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `evaluateMetric` handles `observation === null` but
 * `inputs[criterion.id]` is `undefined` when the key is absent, so
 * `observation.value` throws a native TypeError instead of yielding
 * NOT_EVALUABLE (the documented "no measurement" verdict).
 *
 * Replayed seed (tools/stress/boundary-malformed, origin/devin/stress-pkg-ops-bundle-boundary-malformed):
 *   811933452 — delete inputs.analysis_latency_p95_ms
 *
 * This test asserts the EXPECTED contract and therefore FAILS on 1fb0efd7.
 */

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

describe("rollout health: a missing metric key is NOT_EVALUABLE, never a crash", () => {
  it("seed 811933452: deleting analysis_latency_p95_ms yields NOT_EVALUABLE like an explicit null", () => {
    const withNull: HealthInputs = { ...healthyInputs(), analysis_latency_p95_ms: null };
    const nullReport = evaluateHealth(withNull, FROZEN_HEALTH_CRITERIA_V1);
    expect(nullReport.metrics.find((m) => m.id === "analysis_latency_p95_ms")?.verdict).toBe(
      "NOT_EVALUABLE",
    );

    const partial = healthyInputs() as Partial<
      Record<(typeof HEALTH_METRIC_IDS)[number], MetricObservation>
    >;
    delete partial.analysis_latency_p95_ms;
    const missingReport = evaluateHealth(partial as HealthInputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(missingReport.metrics.find((m) => m.id === "analysis_latency_p95_ms")?.verdict).toBe(
      "NOT_EVALUABLE",
    );
    expect(missingReport.overall).toBe(nullReport.overall);
  });
});
