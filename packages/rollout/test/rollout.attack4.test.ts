import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  forceRollback,
  type HealthCriteria,
  type HealthInputs,
  type RolloutState,
} from "../src/index.js";

/**
 * Adversarial pass 3 (tester #4) — extra scenarios against the rollout
 * state machine: corrupt state, clock skew, criteria tampering by aliasing,
 * degenerate observations. Pins observed behaviour; BROKEN cases use
 * `it.fails` for the expected behaviour.
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
    rolloutId: "r-attack4",
    modelId: "scorer.sm-v1",
    candidateVersion: "sm-v2",
    knownGoodVersion: "sm-v1",
    nowMs: 1000,
  });
}

describe("corrupt state", () => {
  it("REPRO: a stagePercent outside the ladder (e.g. 7 from a corrupt store) 'promotes' DOWN to 1%", () => {
    const corrupt = { ...fresh(), stagePercent: 7 as unknown as RolloutState["stagePercent"] };
    const next = applyHealthWindow(corrupt, healthy(), 2000);
    // indexOf(7) === -1 → ROLLOUT_STAGES_V1[0] → exposure silently drops 7 → 1
    // and the transition is recorded as a "promote".
    expect(next.stagePercent).toBe(1);
    expect(next.transitions.at(-1)!.action).toBe("promote");
    expect(next.transitions.at(-1)!.fromStagePercent).toBe(7);
  });

  it.fails("EXPECTED: a stagePercent not in ROLLOUT_STAGES_V1 is rejected (BROKEN, P3)", () => {
    const corrupt = { ...fresh(), stagePercent: 7 as unknown as RolloutState["stagePercent"] };
    expect(() => applyHealthWindow(corrupt, healthy(), 2000)).toThrow();
  });

  it("REPRO: candidate === knownGood is only checked at create; a corrupt state completes onto itself", () => {
    const corrupt: RolloutState = { ...fresh(), candidateVersion: "sm-v1", stagePercent: 100 };
    const done = applyHealthWindow(corrupt, healthy(), 2000);
    expect(done.status).toBe("complete");
    expect(done.activeVersion).toBe("sm-v1");
  });

  it("a state whose status is not in ROLLOUT_STATUSES is treated as non-terminal and evaluated", () => {
    const corrupt = { ...fresh(), status: "bogus" as unknown as RolloutState["status"] };
    const next = applyHealthWindow(corrupt, healthy(), 2000);
    expect(next.status).toBe("in_progress");
    expect(next.transitions.at(-1)!.fromStatus).toBe("bogus");
  });
});

describe("clock skew", () => {
  it("REPRO: occurredAtMs may go backwards — no monotonicity check on the transition log", () => {
    let state = fresh();
    state = applyHealthWindow(state, healthy(), 5000);
    state = applyHealthWindow(state, healthy(), 10); // clock jumped back
    const times = state.transitions.map((t) => t.occurredAtMs);
    expect(times).toEqual([1000, 5000, 10]);
    expect(state.stagePercent).toBe(20);
  });

  it("NaN / Infinity / negative nowMs are accepted verbatim (pin)", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const next = applyHealthWindow(fresh(), healthy(), now);
      expect(Object.is(next.transitions.at(-1)!.occurredAtMs, now)).toBe(true);
    }
    expect(forceRollback(fresh(), Number.NaN).status).toBe("rolled_back");
  });
});

describe("criteria tampering by structural aliasing", () => {
  it("a byte-identical copy of the frozen criteria with an extra hidden field still passes the pin", () => {
    // canonicalizeHealthCriteria projects known fields only, so extra props
    // are invisible to the hash. They are also ignored by the evaluator, so
    // this is safe — pinned so a future 'extra field' cannot change verdicts.
    const aliased = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => ({ ...m, threshold2: 1 })),
    } as HealthCriteria;
    expect(() => evaluateHealth(healthy(), aliased)).not.toThrow();
  });

  it("re-ordering metrics changes the canonical hash → refused", () => {
    const reordered: HealthCriteria = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: [...FROZEN_HEALTH_CRITERIA_V1.metrics].reverse(),
    };
    expect(() => evaluateHealth(healthy(), reordered)).toThrow(/frozen pin/);
  });

  it("-0 vs 0 threshold: JSON.stringify(-0) === '0', so a -0 threshold hashes identical (pin, harmless)", () => {
    const m = FROZEN_HEALTH_CRITERIA_V1.metrics.map((c) =>
      c.id === "silent_failure_rate"
        ? { ...c, threshold: c.threshold === 0 ? -0 : c.threshold }
        : c,
    );
    expect(() =>
      evaluateHealth(healthy(), { ...FROZEN_HEALTH_CRITERIA_V1, metrics: m }),
    ).not.toThrow();
  });

  it("dropping a metric changes the hash → refused (cannot make a metric un-evaluated by omission)", () => {
    const fewer: HealthCriteria = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.slice(0, 5),
    };
    expect(() => evaluateHealth(healthy(), fewer)).toThrow(/frozen pin/);
  });
});

describe("degenerate observations", () => {
  it("negative sampleCount is NOT_EVALUABLE (below minimum), never healthy", () => {
    const inputs = { ...healthy(), crash_rate: { value: 0, sampleCount: -1 } };
    const r = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(r.metrics.find((m) => m.id === "crash_rate")!.verdict).toBe("NOT_EVALUABLE");
    expect(r.overall).toBe("NOT_EVALUABLE");
  });

  it("huge sampleCount (2^53) with a healthy value is HEALTHY (no upper sanity bound — pin)", () => {
    const inputs = { ...healthy(), crash_rate: { value: 0, sampleCount: 2 ** 53 } };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("HEALTHY");
  });

  it("-Infinity crash_rate is 'malformed' (NOT_EVALUABLE), not HEALTHY via <= threshold", () => {
    const inputs = { ...healthy(), crash_rate: { value: -Infinity, sampleCount: 500 } };
    const r = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(r.metrics.find((m) => m.id === "crash_rate")!.verdict).toBe("NOT_EVALUABLE");
  });

  it("a negative rate (-0.5 crash_rate) IS HEALTHY — no [0,1] range check (pin)", () => {
    const inputs = { ...healthy(), crash_rate: { value: -0.5, sampleCount: 500 } };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("HEALTHY");
  });

  it("an extra unknown metric key in inputs is ignored (cannot inject a verdict)", () => {
    const inputs = { ...healthy(), bogus: { value: 999, sampleCount: 999 } } as HealthInputs;
    const r = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(r.metrics.map((m) => m.id)).toEqual([
      ...FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => m.id),
    ]);
    expect(r.overall).toBe("HEALTHY");
  });

  it("rapid repeats: 1000 healthy windows after completion all throw; state is frozen", () => {
    let state = fresh();
    for (let i = 0; i < ROLLOUT_STAGES_V1.length; i += 1) {
      state = applyHealthWindow(state, healthy(), 2000 + i);
    }
    expect(state.status).toBe("complete");
    const snapshot = JSON.stringify(state);
    for (let i = 0; i < 1000; i += 1) {
      expect(() => applyHealthWindow(state, healthy(), 9000 + i)).toThrow(/terminal/);
      expect(() => forceRollback(state, 9000 + i)).toThrow(/terminal/);
    }
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
