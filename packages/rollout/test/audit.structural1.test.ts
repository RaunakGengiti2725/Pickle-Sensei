import { describe, expect, it } from "vitest";
import {
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  type HealthInputs,
  type RolloutState,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). Contract (rollout.ts):
 * the ladder is never skipped and every promotion lands on the NEXT stage.
 * Persisted rollout state is untyped at rest (JSON); a stagePercent that is
 * not on the ladder must be rejected loudly, never silently re-mapped.
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
    rolloutId: "r-audit",
    modelId: "scorer.sm-v1",
    candidateVersion: "sm-v2",
    knownGoodVersion: "sm-v1",
    nowMs: 1000,
  });
}

describe("audit: off-ladder stagePercent (corrupt persisted state)", () => {
  it("a HEALTHY window on stagePercent=7 must throw, not promote to 1%", () => {
    // Simulates state rehydrated from a store where stagePercent was edited
    // or written by an older ladder version.
    const corrupt = { ...fresh(), stagePercent: 7 } as unknown as RolloutState;
    let outcome: RolloutState | null = null;
    let error: unknown = null;
    try {
      outcome = applyHealthWindow(corrupt, healthy(), 2000);
    } catch (e) {
      error = e;
    }
    if (outcome !== null) {
      // If it did not throw, at minimum the transition must not claim a
      // "promotion" from 7 down to the bottom rung.
      const last = outcome.transitions.at(-1);
      expect(last?.action, JSON.stringify(last)).not.toBe("promote");
      expect(outcome.stagePercent).not.toBe(ROLLOUT_STAGES_V1[0]);
    }
    expect(error).not.toBeNull();
  });

  it("promotions always land on the ladder successor of the FROM stage", () => {
    let state = fresh();
    for (let i = 0; i < ROLLOUT_STAGES_V1.length - 1; i += 1) {
      const from = state.stagePercent;
      state = applyHealthWindow(state, healthy(), 2000 + i);
      const fromIndex = ROLLOUT_STAGES_V1.indexOf(from as (typeof ROLLOUT_STAGES_V1)[number]);
      expect(state.stagePercent).toBe(ROLLOUT_STAGES_V1[fromIndex + 1]);
    }
  });
});
