import { describe, expect, it } from "vitest";
import {
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  forceRollback,
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

function unhealthy(): HealthInputs {
  return { ...healthy(), crash_rate: { value: 0.2, sampleCount: 500 } };
}

function notEvaluable(): HealthInputs {
  return { ...healthy(), capture_success_rate: null };
}

function fresh(): RolloutState {
  return createRollout({
    rolloutId: "r-1",
    modelId: "scorer.sm-v1",
    candidateVersion: "sm-v2",
    knownGoodVersion: "sm-v1",
    nowMs: 1000,
  });
}

describe("staged rollout state machine", () => {
  it("starts at the first stage with the known-good version active", () => {
    const state = fresh();
    expect(state.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    expect(state.status).toBe("in_progress");
    expect(state.activeVersion).toBe("sm-v1");
    expect(state.transitions).toHaveLength(1);
    expect(state.transitions[0]?.action).toBe("create");
  });

  it("rejects a rollout whose candidate equals its predecessor", () => {
    expect(() =>
      createRollout({
        rolloutId: "r-x",
        modelId: "m",
        candidateVersion: "v1",
        knownGoodVersion: "v1",
        nowMs: 0,
      }),
    ).toThrow(/must differ/);
  });

  it("promotes through 1→5→20→50→100 on consecutive healthy windows, then completes", () => {
    let state = fresh();
    const seen: number[] = [state.stagePercent];
    for (let i = 0; i < 4; i += 1) {
      state = applyHealthWindow(state, healthy(), 2000 + i);
      seen.push(state.stagePercent);
    }
    expect(seen).toEqual([...ROLLOUT_STAGES_V1]);
    expect(state.status).toBe("in_progress");
    state = applyHealthWindow(state, healthy(), 9000);
    expect(state.status).toBe("complete");
    expect(state.activeVersion).toBe("sm-v2");
  });

  it("pauses on NOT_EVALUABLE without changing exposure", () => {
    let state = fresh();
    state = applyHealthWindow(state, healthy(), 2000);
    const stage = state.stagePercent;
    state = applyHealthWindow(state, notEvaluable(), 3000);
    expect(state.status).toBe("paused");
    expect(state.stagePercent).toBe(stage);
    expect(state.activeVersion).toBe("sm-v1");
  });

  it("resumes from paused only on a healthy window", () => {
    let state = fresh();
    state = applyHealthWindow(state, notEvaluable(), 2000);
    expect(state.status).toBe("paused");
    state = applyHealthWindow(state, notEvaluable(), 3000);
    expect(state.status).toBe("paused");
    state = applyHealthWindow(state, healthy(), 4000);
    expect(state.status).toBe("in_progress");
    expect(state.transitions[state.transitions.length - 1]?.action).toBe("resume");
  });

  it("rolls back to the recorded predecessor on an unhealthy window", () => {
    let state = fresh();
    state = applyHealthWindow(state, healthy(), 2000);
    state = applyHealthWindow(state, healthy(), 3000);
    state = applyHealthWindow(state, unhealthy(), 4000);
    expect(state.status).toBe("rolled_back");
    expect(state.stagePercent).toBe(0);
    expect(state.activeVersion).toBe("sm-v1");
  });

  it("rolls back from paused on an unhealthy window", () => {
    let state = fresh();
    state = applyHealthWindow(state, notEvaluable(), 2000);
    state = applyHealthWindow(state, unhealthy(), 3000);
    expect(state.status).toBe("rolled_back");
    expect(state.activeVersion).toBe("sm-v1");
  });

  it("supports an operator kill switch that needs no health report", () => {
    let state = fresh();
    state = applyHealthWindow(state, healthy(), 2000);
    state = forceRollback(state, 3000);
    expect(state.status).toBe("rolled_back");
    expect(state.activeVersion).toBe("sm-v1");
    expect(state.transitions[state.transitions.length - 1]?.health).toBeNull();
  });

  it("rejects evaluation of terminal rollouts", () => {
    let state = fresh();
    state = forceRollback(state, 2000);
    expect(() => applyHealthWindow(state, healthy(), 3000)).toThrow(/terminal/);
    expect(() => forceRollback(state, 3000)).toThrow(/terminal/);
  });

  it("keeps an append-only transition log with contiguous sequence numbers", () => {
    let state = fresh();
    state = applyHealthWindow(state, healthy(), 2000);
    state = applyHealthWindow(state, notEvaluable(), 3000);
    state = applyHealthWindow(state, unhealthy(), 4000);
    expect(state.transitions.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
    expect(state.transitions.map((t) => t.action)).toEqual([
      "create",
      "promote",
      "pause",
      "rollback",
    ]);
  });
});
