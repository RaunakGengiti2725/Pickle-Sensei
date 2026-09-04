/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  assertFrozenCriteria,
  createRollout,
  evaluateHealth,
  forceRollback,
  healthCriteriaSha256,
  isTerminal,
  type HealthInputs,
  type HealthMetricId,
  type MetricObservation,
  type RolloutState,
} from "../src/index.js";

const criterionOf = (id: HealthMetricId) =>
  FROZEN_HEALTH_CRITERIA_V1.metrics.find((m) => m.id === id)!;

function healthyInputs(): Record<HealthMetricId, MetricObservation | null> {
  const out = {} as Record<HealthMetricId, MetricObservation | null>;
  for (const id of HEALTH_METRIC_IDS) {
    const c = criterionOf(id);
    out[id] = {
      value: c.direction === "at_most" ? c.threshold : c.threshold,
      sampleCount: c.minSampleCount,
    };
  }
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("audit: evaluateHealth input robustness", () => {
  it.fails(
    "FINDING: a missing metric key (undefined, not null) throws instead of NOT_EVALUABLE",
    () => {
      const partial = healthyInputs() as Record<string, MetricObservation | null>;
      delete partial["silent_failure_rate"];
      const report = evaluateHealth(partial as unknown as HealthInputs, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.overall).toBe("NOT_EVALUABLE");
    },
  );

  it("evidence: the missing-key path raises a TypeError from inside evaluateMetric", () => {
    const partial = healthyInputs() as Record<string, MetricObservation | null>;
    delete partial["silent_failure_rate"];
    expect(() =>
      evaluateHealth(partial as unknown as HealthInputs, FROZEN_HEALTH_CRITERIA_V1),
    ).toThrow(TypeError);
  });

  it.fails(
    "FINDING: out-of-range rates (negative / >1) are accepted as HEALTHY, not flagged malformed",
    () => {
      const inputs = healthyInputs();
      inputs.crash_rate = { value: -0.5, sampleCount: 10_000 };
      inputs.analysis_completion_rate = { value: 7, sampleCount: 10_000 };
      inputs.capture_success_rate = { value: 1.5, sampleCount: 10_000 };
      const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
      for (const id of [
        "crash_rate",
        "analysis_completion_rate",
        "capture_success_rate",
      ] as const) {
        expect(report.metrics.find((m) => m.id === id)!.verdict).toBe("NOT_EVALUABLE");
      }
    },
  );

  it("holds: null / NaN / Infinity / fractional sampleCount / low samples are NOT_EVALUABLE", () => {
    const base = healthyInputs();
    const variants: Array<MetricObservation | null> = [
      null,
      { value: NaN, sampleCount: 1000 },
      { value: Infinity, sampleCount: 1000 },
      { value: 0, sampleCount: 1.5 },
      { value: 0, sampleCount: NaN },
      { value: 0, sampleCount: criterionOf("crash_rate").minSampleCount - 1 },
    ];
    for (const v of variants) {
      const report = evaluateHealth({ ...base, crash_rate: v }, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.metrics.find((m) => m.id === "crash_rate")!.verdict).toBe("NOT_EVALUABLE");
      expect(report.overall).toBe("NOT_EVALUABLE");
    }
  });

  it("holds: frozen criteria hash pins every field; any tamper is rejected", () => {
    expect(healthCriteriaSha256(FROZEN_HEALTH_CRITERIA_V1)).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
    const tampered = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) =>
        m.id === "crash_rate" ? { ...m, threshold: m.threshold + 1e-9 } : m,
      ),
    };
    expect(() => assertFrozenCriteria(tampered)).toThrow();
    expect(() => evaluateHealth(healthyInputs(), tampered)).toThrow();
    const reordered = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: [...FROZEN_HEALTH_CRITERIA_V1.metrics].reverse(),
    };
    expect(() => assertFrozenCriteria(reordered)).toThrow();
  });
});

describe("audit: rollout state machine under randomized health windows", () => {
  it("fuzz 2000 runs: exposure only rises on HEALTHY, never past 100, always lands on known-good after rollback", () => {
    const rand = lcg(2026);
    for (let run = 0; run < 2000; run++) {
      let state: RolloutState = createRollout({
        rolloutId: `r-${run}`,
        modelId: "m",
        candidateVersion: "cand",
        knownGoodVersion: "good",
        nowMs: 0,
      });
      let steps = 0;
      while (!isTerminal(state) && steps < 40) {
        steps++;
        const inputs = healthyInputs();
        const roll = rand();
        let expectedOverall: "HEALTHY" | "UNHEALTHY" | "NOT_EVALUABLE" = "HEALTHY";
        if (roll < 0.25) {
          const id = HEALTH_METRIC_IDS[Math.floor(rand() * HEALTH_METRIC_IDS.length)]!;
          const c = criterionOf(id);
          inputs[id] = {
            value: c.direction === "at_most" ? c.threshold + 0.001 : c.threshold - 0.001,
            sampleCount: c.minSampleCount,
          };
          expectedOverall = "UNHEALTHY";
        } else if (roll < 0.55) {
          const id = HEALTH_METRIC_IDS[Math.floor(rand() * HEALTH_METRIC_IDS.length)]!;
          inputs[id] = rand() < 0.5 ? null : { value: 0.5, sampleCount: 1 };
          expectedOverall = "NOT_EVALUABLE";
        }
        const before = state;
        state = applyHealthWindow(state, inputs, steps);
        const last = state.transitions.at(-1)!;
        expect(last.seq).toBe(before.transitions.length);
        expect(last.health?.overall).toBe(expectedOverall);
        if (expectedOverall === "UNHEALTHY") {
          expect(state.status).toBe("rolled_back");
          expect(state.stagePercent).toBe(0);
          expect(state.activeVersion).toBe("good");
        } else if (expectedOverall === "NOT_EVALUABLE") {
          expect(state.status).toBe("paused");
          expect(state.stagePercent).toBe(before.stagePercent);
          expect(state.activeVersion).toBe("good");
        } else {
          expect(state.stagePercent).toBeGreaterThanOrEqual(before.stagePercent);
          expect(ROLLOUT_STAGES_V1).toContain(state.stagePercent);
          if (state.status === "complete") {
            expect(before.stagePercent).toBe(100);
            expect(state.activeVersion).toBe("cand");
          } else {
            expect(state.activeVersion).toBe("good");
            expect(last.action).toBe(before.status === "paused" ? "resume" : "promote");
          }
        }
      }
      if (isTerminal(state)) {
        expect(() => applyHealthWindow(state, healthyInputs(), 999)).toThrow(/terminal/);
        expect(() => forceRollback(state, 999)).toThrow(/terminal/);
      } else {
        const killed = forceRollback(state, 999);
        expect(killed.status).toBe("rolled_back");
        expect(killed.activeVersion).toBe("good");
      }
    }
  });

  it("holds: candidate === knownGood is rejected at creation", () => {
    expect(() =>
      createRollout({
        rolloutId: "x",
        modelId: "m",
        candidateVersion: "v",
        knownGoodVersion: "v",
        nowMs: 0,
      }),
    ).toThrow();
  });

  it("observed: occurredAtMs is not required to be monotonic (documented, not a finding)", () => {
    let s = createRollout({
      rolloutId: "x",
      modelId: "m",
      candidateVersion: "c",
      knownGoodVersion: "g",
      nowMs: 100,
    });
    s = applyHealthWindow(s, healthyInputs(), 50);
    expect(s.transitions.at(-1)!.occurredAtMs).toBeLessThan(s.transitions[0]!.occurredAtMs);
  });
});
