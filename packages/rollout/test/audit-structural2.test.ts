import { describe, expect, it } from "vitest";
import {
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  FROZEN_HEALTH_CRITERIA_V1,
  type HealthInputs,
  type RolloutState,
} from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for
 * untrusted-input handling in the rollout state machine. Rollout state and
 * health inputs cross a persistence/JSON boundary in any real deployment, so
 * the shapes below are reachable at runtime even though the TS types forbid
 * them at compile time.
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
    rolloutId: "SYNTHETIC-r-1",
    modelId: "scorer.synthetic",
    candidateVersion: "v2",
    knownGoodVersion: "v1",
    nowMs: 1000,
  });
}

describe("AUDIT evaluateHealth: an ABSENT metric (missing key) is NOT_EVALUABLE, not a crash", () => {
  it("dropping a key from the health inputs yields NOT_EVALUABLE like an explicit null", () => {
    const partial = { ...healthy() } as Record<string, unknown>;
    delete partial["capture_success_rate"];
    const inputs = partial as unknown as HealthInputs;
    let report;
    expect(() => {
      report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    }).not.toThrow();
    expect(report!.overall).toBe("NOT_EVALUABLE");
  });

  it("applyHealthWindow with a missing metric pauses (records a transition) instead of throwing", () => {
    const partial = { ...healthy() } as Record<string, unknown>;
    delete partial["silent_failure_rate"];
    const inputs = partial as unknown as HealthInputs;
    let next: RolloutState | undefined;
    expect(() => {
      next = applyHealthWindow(fresh(), inputs, 2000);
    }).not.toThrow();
    expect(next!.status).toBe("paused");
  });
});

describe("AUDIT applyHealthWindow: an off-ladder stagePercent must be rejected, never promoted", () => {
  it("a corrupt persisted stage (7%) on a HEALTHY window throws instead of landing on a ladder rung", () => {
    const corrupt = { ...fresh(), stagePercent: 7 } as unknown as RolloutState;
    expect((ROLLOUT_STAGES_V1 as readonly number[]).includes(7)).toBe(false);
    let next: RolloutState | undefined;
    try {
      next = applyHealthWindow(corrupt, healthy(), 2000);
    } catch {
      return; // rejecting the corrupt state is the expected behaviour
    }
    expect.fail(
      `corrupt stage 7 was accepted and mapped to stage ${String(next.stagePercent)} ` +
        `(status=${next.status}, last transition=${JSON.stringify(next.transitions.at(-1))})`,
    );
  });
});
