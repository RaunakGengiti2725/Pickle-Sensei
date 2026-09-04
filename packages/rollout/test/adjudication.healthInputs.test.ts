import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  type HealthInputs,
  type HealthMetricId,
  type RolloutState,
} from "../src/index.js";

/**
 * Adjudication: a health window built from physically impossible or absent
 * measurements must never read as HEALTHY, and must never crash the
 * promotion path. A rate is a fraction of events, so it lives in [0, 1]; a
 * latency cannot be negative. Anything outside that domain is a measurement
 * defect — NOT_EVALUABLE, which pauses the rollout at its current exposure.
 */

function healthy(): HealthInputs {
  return {
    crash_rate: { value: 0.001, sampleCount: 500 },
    analysis_completion_rate: { value: 0.99, sampleCount: 400 },
    analysis_latency_p95_ms: { value: 6000, sampleCount: 400 },
    capture_success_rate: { value: 0.97, sampleCount: 300 },
    abstention_rate: { value: 0.2, sampleCount: 400 },
    silent_failure_rate: { value: 0, sampleCount: 400 },
  };
}

function fresh(): RolloutState {
  return createRollout({
    rolloutId: "adj-1",
    modelId: "scorer.sm-v1",
    candidateVersion: "sm-v2",
    knownGoodVersion: "sm-v1",
    nowMs: 1000,
  });
}

const RATE_METRICS: readonly HealthMetricId[] = HEALTH_METRIC_IDS.filter(
  (id) => id !== "analysis_latency_p95_ms",
);

function verdictOf(inputs: HealthInputs, id: HealthMetricId) {
  return evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).metrics.find((m) => m.id === id)
    ?.verdict;
}

describe("adjudication: impossible and absent health inputs", () => {
  it("rate metrics outside [0, 1] are never HEALTHY and never advance the canary", () => {
    const negativeCrash: HealthInputs = {
      ...healthy(),
      crash_rate: { value: -1, sampleCount: 500 },
    };
    expect(verdictOf(negativeCrash, "crash_rate")).not.toBe("HEALTHY");
    expect(evaluateHealth(negativeCrash, FROZEN_HEALTH_CRITERIA_V1).overall).not.toBe("HEALTHY");
    const afterNegative = applyHealthWindow(fresh(), negativeCrash, 2000);
    expect(afterNegative.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    expect(afterNegative.status).toBe("paused");

    const overCompletion: HealthInputs = {
      ...healthy(),
      analysis_completion_rate: { value: 1.5, sampleCount: 400 },
    };
    expect(verdictOf(overCompletion, "analysis_completion_rate")).not.toBe("HEALTHY");
    const afterOver = applyHealthWindow(fresh(), overCompletion, 2000);
    expect(afterOver.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    expect(afterOver.status).toBe("paused");

    // Every rate metric, in both directions of the impossible domain.
    for (const id of RATE_METRICS) {
      for (const value of [-Number.EPSILON, -1, 1 + Number.EPSILON, 1.5, 100]) {
        const inputs: HealthInputs = { ...healthy(), [id]: { value, sampleCount: 1000 } };
        expect(verdictOf(inputs, id), `${id}=${value}`).toBe("NOT_EVALUABLE");
        expect(applyHealthWindow(fresh(), inputs, 2000).stagePercent, `${id}=${value}`).toBe(
          ROLLOUT_STAGES_V1[0],
        );
      }
      // The domain boundaries themselves are legitimate measurements.
      expect(verdictOf({ ...healthy(), [id]: { value: 0, sampleCount: 1000 } }, id)).not.toBe(
        "NOT_EVALUABLE",
      );
      expect(verdictOf({ ...healthy(), [id]: { value: 1, sampleCount: 1000 } }, id)).not.toBe(
        "NOT_EVALUABLE",
      );
    }
  });

  it("a negative latency is never HEALTHY and never advances the canary", () => {
    const negativeLatency: HealthInputs = {
      ...healthy(),
      analysis_latency_p95_ms: { value: -5, sampleCount: 400 },
    };
    expect(verdictOf(negativeLatency, "analysis_latency_p95_ms")).toBe("NOT_EVALUABLE");
    const after = applyHealthWindow(fresh(), negativeLatency, 2000);
    expect(after.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    expect(after.status).toBe("paused");
    // Zero latency is implausible but not impossible for the evaluator to
    // reason about; it must still be a real verdict, not a crash.
    expect(
      verdictOf(
        { ...healthy(), analysis_latency_p95_ms: { value: 0, sampleCount: 400 } },
        "analysis_latency_p95_ms",
      ),
    ).toBe("HEALTHY");
  });

  it("an absent metric key is treated like null: NOT_EVALUABLE and paused, never a throw", () => {
    for (const dropped of HEALTH_METRIC_IDS) {
      const { [dropped]: _omitted, ...rest } = healthy();
      // Runtime inputs (deserialized state, a metrics exporter that skipped a
      // key) may simply lack the property; the type cannot express that.
      const missingOne = rest as unknown as HealthInputs;
      expect(() => evaluateHealth(missingOne, FROZEN_HEALTH_CRITERIA_V1)).not.toThrow();
      expect(verdictOf(missingOne, dropped)).toBe("NOT_EVALUABLE");
      expect(evaluateHealth(missingOne, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("NOT_EVALUABLE");

      let after: RolloutState | undefined;
      expect(() => {
        after = applyHealthWindow(fresh(), missingOne, 2000);
      }).not.toThrow();
      expect(after?.status).toBe("paused");
      expect(after?.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
      expect(after?.activeVersion).toBe("sm-v1");
    }

    const explicitUndefined = {
      ...healthy(),
      silent_failure_rate: undefined,
    } as unknown as HealthInputs;
    expect(() => applyHealthWindow(fresh(), explicitUndefined, 2000)).not.toThrow();
    expect(applyHealthWindow(fresh(), explicitUndefined, 2000).status).toBe("paused");
  });
});
