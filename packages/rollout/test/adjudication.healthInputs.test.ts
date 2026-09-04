/**
 * Adjudication repro (shared-packages-ops) — rollout health inputs.
 *
 * evaluateMetric() checks finiteness/integer sample counts but not the
 * physical domain of a rate: crash_rate=-1 and analysis_completion_rate=1.5
 * are HEALTHY and the canary ADVANCES; a missing metric key throws a TypeError
 * instead of reading NOT_EVALUABLE. Every test here FAILS on 4d812e1a.
 */
import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  type HealthInputs,
  type RolloutState,
} from "../src/index.js";

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

function canary(): RolloutState {
  return createRollout({
    rolloutId: "r1",
    modelId: "m",
    candidateVersion: "2",
    knownGoodVersion: "1",
    nowMs: 1_000,
  });
}

describe("adjudication: physically impossible rates never read HEALTHY", () => {
  it("crash_rate = -1 does not advance the canary", () => {
    const inputs = { ...healthy(), crash_rate: { value: -1, sampleCount: 500 } };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(report.metrics.find((m) => m.id === "crash_rate")!.verdict).not.toBe("HEALTHY");
    const next = applyHealthWindow(canary(), inputs, 2_000);
    expect(next.stagePercent).toBe(1);
  });

  it("analysis_completion_rate = 1.5 does not advance the canary", () => {
    const inputs = { ...healthy(), analysis_completion_rate: { value: 1.5, sampleCount: 400 } };
    const next = applyHealthWindow(canary(), inputs, 2_000);
    expect(next.stagePercent).toBe(1);
  });

  it("a missing metric key is NOT_EVALUABLE (pause), not a TypeError", () => {
    const { silent_failure_rate: _dropped, ...partial } = healthy();
    const inputs = partial as unknown as HealthInputs;
    let next: RolloutState | null = null;
    expect(() => {
      next = applyHealthWindow(canary(), inputs, 2_000);
    }).not.toThrow();
    expect(next!.status).toBe("paused");
  });
});
