/**
 * Adversarial pass 3 — staged rollout: corrupt/deserialized state, negative
 * or absurd metric observations, missing metric keys, clock going backwards.
 */
import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
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

function fresh(): RolloutState {
  return createRollout({
    rolloutId: "r1",
    modelId: "m",
    candidateVersion: "2",
    knownGoodVersion: "1",
    nowMs: 1_000,
  });
}

describe("attack3: rollout state rehydrated from storage with a corrupt stagePercent", () => {
  it("stagePercent not on the ladder (7) must not 'promote' to 1% — it must throw", () => {
    const corrupt = { ...fresh(), stagePercent: 7 as unknown as RolloutState["stagePercent"] };
    let next: RolloutState | null = null;
    let threw = false;
    try {
      next = applyHealthWindow(corrupt, healthy(), 2_000);
    } catch {
      threw = true;
    }
    expect(
      { threw, to: next?.stagePercent, action: next?.transitions.at(-1)?.action },
      "corrupt stage silently re-entered the ladder",
    ).toEqual({ threw: true, to: undefined, action: undefined });
  });

  it('stagePercent as the JSON string "50" must not be treated as a fresh 1% canary', () => {
    const corrupt = { ...fresh(), stagePercent: "50" as unknown as RolloutState["stagePercent"] };
    let next: RolloutState | null = null;
    let threw = false;
    try {
      next = applyHealthWindow(corrupt, healthy(), 2_000);
    } catch {
      threw = true;
    }
    expect({ threw, to: next?.stagePercent }, "string stage coerced onto the ladder").toEqual({
      threw: true,
      to: undefined,
    });
  });

  it("status 'complete' with a non-zero stage (inconsistent) is still terminal", () => {
    const corrupt = { ...fresh(), status: "complete" as const };
    expect(() => applyHealthWindow(corrupt, healthy(), 2_000)).toThrow(/terminal/);
    expect(() => forceRollback(corrupt, 2_000)).toThrow(/terminal/);
  });
});

describe("attack3: metric observations that are numerically 'in range' but physically impossible", () => {
  it("a NEGATIVE crash_rate (-1) must not be HEALTHY", () => {
    const inputs: HealthInputs = { ...healthy(), crash_rate: { value: -1, sampleCount: 500 } };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(
      report.metrics.find((m) => m.id === "crash_rate")!.verdict,
      JSON.stringify(report),
    ).not.toBe("HEALTHY");
  });

  it("a completion RATE above 1 (1.5) must not be HEALTHY", () => {
    const inputs: HealthInputs = {
      ...healthy(),
      analysis_completion_rate: { value: 1.5, sampleCount: 500 },
    };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(
      report.metrics.find((m) => m.id === "analysis_completion_rate")!.verdict,
      JSON.stringify(report),
    ).not.toBe("HEALTHY");
  });

  it("a NEGATIVE sampleCount is malformed, not merely 'too few samples'", () => {
    const inputs: HealthInputs = { ...healthy(), crash_rate: { value: 0, sampleCount: -5 } };
    const m = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).metrics.find(
      (x) => x.id === "crash_rate",
    )!;
    expect(m.verdict).toBe("NOT_EVALUABLE");
  });

  it("sampleCount = 2^53 (unsafe integer) is accepted as an integer — documenting", () => {
    const inputs: HealthInputs = { ...healthy(), crash_rate: { value: 0, sampleCount: 2 ** 53 } };
    const m = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).metrics.find(
      (x) => x.id === "crash_rate",
    )!;
    expect(["HEALTHY", "NOT_EVALUABLE"]).toContain(m.verdict);
  });
});

describe("attack3: inputs object missing a metric key (deserialized from an older producer)", () => {
  it("a missing key is NOT_EVALUABLE, not a TypeError crash in the promotion path", () => {
    const partial = { ...healthy() } as Record<string, unknown>;
    delete partial["silent_failure_rate"];
    let report: ReturnType<typeof evaluateHealth> | null = null;
    let err: unknown = null;
    try {
      report = evaluateHealth(partial as unknown as HealthInputs, FROZEN_HEALTH_CRITERIA_V1);
    } catch (e) {
      err = e;
    }
    expect(
      {
        threw: err instanceof Error ? err.constructor.name + ": " + err.message : null,
        overall: report?.overall,
      },
      "missing metric key crashed instead of NOT_EVALUABLE",
    ).toEqual({ threw: null, overall: "NOT_EVALUABLE" });
  });
});

describe("attack3: clock skew and rapid repeats", () => {
  it("nowMs going backwards is recorded verbatim; seq stays strictly increasing", () => {
    let s = fresh();
    s = applyHealthWindow(s, healthy(), 5_000);
    s = applyHealthWindow(s, healthy(), 4_000); // clock went backwards
    s = applyHealthWindow(s, healthy(), 4_000); // same instant twice
    const seqs = s.transitions.map((t) => t.seq);
    expect(seqs).toEqual([0, 1, 2, 3]);
    expect(s.stagePercent).toBe(50);
  });

  it("1000 rapid HEALTHY windows: completes after exactly 5 promotions and then refuses", () => {
    let s = fresh();
    let promotions = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (s.status === "complete") break;
      s = applyHealthWindow(s, healthy(), 10_000 + i);
      promotions += 1;
    }
    expect(promotions).toBe(5);
    expect(s.activeVersion).toBe("2");
    expect(() => applyHealthWindow(s, healthy(), 99_999)).toThrow(/terminal/);
  });

  it("paused → HEALTHY skips straight to the next stage in ONE window (documenting: no re-soak at the paused stage)", () => {
    let s = fresh();
    s = applyHealthWindow(s, { ...healthy(), crash_rate: null }, 2_000);
    expect(s.status).toBe("paused");
    s = applyHealthWindow(s, healthy(), 3_000);
    expect(s.transitions.at(-1)?.action).toBe("resume");
    expect(s.stagePercent).toBe(5);
  });
});
