/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — rollout state machine
 * and frozen health criteria. `it(...)` = HELD / OBSERVED (pinned current
 * behaviour); `it.fails(...)` = EXPECTED contract that is currently broken.
 */
import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  assertFrozenCriteria,
  createRollout,
  evaluateHealth,
  forceRollback,
  healthCriteriaSha256,
  type HealthCriteria,
  type HealthInputs,
  type RolloutState,
} from "../src/index.js";

const HEALTHY: HealthInputs = {
  crash_rate: { value: 0.001, sampleCount: 1000 },
  analysis_completion_rate: { value: 0.99, sampleCount: 1000 },
  analysis_latency_p95_ms: { value: 8000, sampleCount: 1000 },
  capture_success_rate: { value: 0.97, sampleCount: 1000 },
  abstention_rate: { value: 0.2, sampleCount: 1000 },
  silent_failure_rate: { value: 0, sampleCount: 1000 },
};

function fresh(): RolloutState {
  return createRollout({
    rolloutId: "r-attack",
    modelId: "stroke-classifier",
    candidateVersion: "2.0.0",
    knownGoodVersion: "1.9.3",
    nowMs: 1_000,
  });
}

describe("frozen criteria pin", () => {
  it("HELD: the pinned hash matches and a structurally identical clone with keys in a different order still verifies", () => {
    expect(healthCriteriaSha256(FROZEN_HEALTH_CRITERIA_V1)).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
    const reordered: HealthCriteria = {
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => ({
        minSampleCount: m.minSampleCount,
        threshold: m.threshold,
        direction: m.direction,
        title: m.title,
        id: m.id,
      })),
      schemaVersion: 1,
      id: FROZEN_HEALTH_CRITERIA_V1.id,
    };
    expect(() => assertFrozenCriteria(reordered)).not.toThrow();
  });

  it("HELD: every single-field tamper is refused — threshold ±ulp, minSampleCount −1, title, direction, metric drop, metric reorder, id", () => {
    const base = FROZEN_HEALTH_CRITERIA_V1;
    const variants: HealthCriteria[] = [
      {
        ...base,
        metrics: base.metrics.map((m, i) =>
          i === 0 ? { ...m, threshold: m.threshold + Number.EPSILON } : m,
        ),
      },
      {
        ...base,
        metrics: base.metrics.map((m, i) =>
          i === 0 ? { ...m, minSampleCount: m.minSampleCount - 1 } : m,
        ),
      },
      {
        ...base,
        metrics: base.metrics.map((m, i) => (i === 0 ? { ...m, title: `${m.title} ` } : m)),
      },
      {
        ...base,
        metrics: base.metrics.map((m, i) =>
          i === 0 ? { ...m, direction: "at_least" as const } : m,
        ),
      },
      { ...base, metrics: base.metrics.slice(1) },
      { ...base, metrics: [...base.metrics].reverse() },
      { ...base, id: "rollout-health-frozen-v1 " },
    ];
    for (const v of variants) {
      expect(() => assertFrozenCriteria(v)).toThrowError(/do not match the frozen pin/);
      expect(() => evaluateHealth(HEALTHY, v)).toThrowError(/do not match the frozen pin/);
    }
  });

  it("OBSERVED: extra, non-canonical fields on a criterion are NOT part of the hash and pass the pin (they are also ignored by the evaluator)", () => {
    const padded = {
      ...FROZEN_HEALTH_CRITERIA_V1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => ({ ...m, override: true })),
    } as HealthCriteria;
    expect(() => assertFrozenCriteria(padded)).not.toThrow();
    expect(evaluateHealth(HEALTHY, padded).overall).toBe("HEALTHY");
  });
});

describe("evaluateHealth edge inputs", () => {
  it("OBSERVED: an inputs object MISSING a metric key (undefined, not null) crashes with TypeError instead of NOT_EVALUABLE", () => {
    const { silent_failure_rate: _dropped, ...partial } = HEALTHY;
    void _dropped;
    expect(() =>
      evaluateHealth(partial as unknown as HealthInputs, FROZEN_HEALTH_CRITERIA_V1),
    ).toThrowError(TypeError);
    expect(() => evaluateHealth({} as HealthInputs, FROZEN_HEALTH_CRITERIA_V1)).toThrowError(
      /Cannot read properties of undefined/,
    );
  });

  it.fails(
    "EXPECTED: a missing metric key is treated exactly like null — NOT_EVALUABLE, never a crash",
    () => {
      const report = evaluateHealth({} as HealthInputs, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.overall).toBe("NOT_EVALUABLE");
    },
  );

  it("HELD: sampleCount = Infinity / 1.5 / NaN → NOT_EVALUABLE; negative integer → NOT_EVALUABLE (below minimum)", () => {
    for (const sampleCount of [Infinity, 1.5, NaN, -1]) {
      const r = evaluateHealth(
        { ...HEALTHY, crash_rate: { value: 0, sampleCount } },
        FROZEN_HEALTH_CRITERIA_V1,
      );
      expect(r.metrics.find((m) => m.id === "crash_rate")?.verdict).toBe("NOT_EVALUABLE");
      expect(r.overall).toBe("NOT_EVALUABLE");
    }
  });

  it("HELD: value exactly AT the threshold is healthy for both directions; one ulp past is UNHEALTHY", () => {
    const at = evaluateHealth(
      {
        ...HEALTHY,
        crash_rate: { value: 0.01, sampleCount: 200 },
        analysis_completion_rate: { value: 0.95, sampleCount: 100 },
      },
      FROZEN_HEALTH_CRITERIA_V1,
    );
    expect(at.overall).toBe("HEALTHY");
    const past = evaluateHealth(
      {
        ...HEALTHY,
        crash_rate: { value: 0.01 + Number.EPSILON, sampleCount: 200 },
        analysis_completion_rate: { value: 0.95 - Number.EPSILON, sampleCount: 100 },
      },
      FROZEN_HEALTH_CRITERIA_V1,
    );
    expect(past.overall).toBe("UNHEALTHY");
    expect(past.metrics.filter((m) => m.verdict === "UNHEALTHY").map((m) => m.id)).toEqual([
      "crash_rate",
      "analysis_completion_rate",
    ]);
  });

  it("HELD: -0 and negative crash rates are 'at_most' healthy; a negative completion rate is UNHEALTHY", () => {
    const r = evaluateHealth(
      {
        ...HEALTHY,
        crash_rate: { value: -0, sampleCount: 200 },
        analysis_completion_rate: { value: -1, sampleCount: 100 },
      },
      FROZEN_HEALTH_CRITERIA_V1,
    );
    expect(r.metrics.find((m) => m.id === "crash_rate")?.verdict).toBe("HEALTHY");
    expect(r.metrics.find((m) => m.id === "analysis_completion_rate")?.verdict).toBe("UNHEALTHY");
  });

  it("HELD: unknown extra metric keys in inputs are ignored and cannot make a window healthy", () => {
    const withExtra = {
      ...HEALTHY,
      crash_rate: null,
      bogus_metric: { value: 0, sampleCount: 1e6 },
    };
    const r = evaluateHealth(withExtra as unknown as HealthInputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(r.overall).toBe("NOT_EVALUABLE");
    expect(r.metrics).toHaveLength(6);
  });
});

describe("rollout state machine — corrupt state, clock skew, rapid repeats", () => {
  it("HELD: 1000 consecutive healthy windows can never move past 'complete' — the 6th throws terminal and state is unchanged after", () => {
    let state = fresh();
    for (let i = 0; i < 5; i++) state = applyHealthWindow(state, HEALTHY, 2_000 + i);
    expect(state.status).toBe("complete");
    expect(state.activeVersion).toBe("2.0.0");
    const frozen = state;
    for (let i = 0; i < 1000; i++) {
      expect(() => applyHealthWindow(frozen, HEALTHY, 10_000 + i)).toThrowError(
        /is terminal \(complete\)/,
      );
    }
    expect(frozen.transitions).toHaveLength(6);
  });

  it("HELD: alternating NOT_EVALUABLE / HEALTHY windows 200 times: exposure only ever grows by one rung per HEALTHY window and each pause is logged", () => {
    const notEvaluable: HealthInputs = { ...HEALTHY, crash_rate: null };
    let state = fresh();
    let promotions = 0;
    for (let i = 0; i < 200 && state.status !== "complete"; i++) {
      const before = state.stagePercent;
      state = applyHealthWindow(state, i % 2 === 0 ? notEvaluable : HEALTHY, 2_000 + i);
      if (i % 2 === 0) {
        expect(state.status).toBe("paused");
        expect(state.stagePercent).toBe(before);
      } else {
        promotions += 1;
        const beforeIdx = ROLLOUT_STAGES_V1.indexOf(before as (typeof ROLLOUT_STAGES_V1)[number]);
        if (state.status === "complete") expect(state.stagePercent).toBe(100);
        else expect(state.stagePercent).toBe(ROLLOUT_STAGES_V1[beforeIdx + 1]);
      }
    }
    expect(promotions).toBe(5);
    expect(state.transitions.filter((t) => t.action === "pause")).toHaveLength(5);
    expect(state.transitions.filter((t) => t.action === "resume")).toHaveLength(4);
  });

  it("OBSERVED: nowMs is never validated — a window stamped BEFORE the previous transition (clock skew) or NaN is appended silently", () => {
    let state = fresh();
    state = applyHealthWindow(state, HEALTHY, 5_000);
    state = applyHealthWindow(state, HEALTHY, 4_000);
    state = applyHealthWindow(state, HEALTHY, NaN);
    const times = state.transitions.map((t) => t.occurredAtMs);
    expect(times).toEqual([1_000, 5_000, 4_000, NaN]);
    expect(state.stagePercent).toBe(50);
  });

  it("OBSERVED: a corrupt stagePercent (7, not on the ladder) with a HEALTHY window 'promotes' to 1% instead of rejecting", () => {
    const corrupt = { ...fresh(), stagePercent: 7 as unknown as RolloutState["stagePercent"] };
    const next = applyHealthWindow(corrupt, HEALTHY, 2_000);
    // indexOf(7) === -1 → ROLLOUT_STAGES_V1[0] → the ladder silently restarts at 1%.
    expect(next.stagePercent).toBe(1);
    expect(next.transitions.at(-1)?.fromStagePercent).toBe(7);
  });

  it.fails("EXPECTED: a stagePercent that is not on the frozen ladder is rejected", () => {
    const corrupt = { ...fresh(), stagePercent: 7 as unknown as RolloutState["stagePercent"] };
    expect(() => applyHealthWindow(corrupt, HEALTHY, 2_000)).toThrowError();
  });

  it("HELD: stagePercent 0 with a non-terminal status (corrupt) is rejected", () => {
    const corrupt = { ...fresh(), stagePercent: 0 as const };
    expect(() => applyHealthWindow(corrupt, HEALTHY, 2_000)).toThrowError(/has no active stage/);
  });

  it("OBSERVED: a corrupt status ('in_progress' spelled with unicode homoglyph) is not terminal and is evaluated as if in progress", () => {
    const corrupt = { ...fresh(), status: "in_progrеss" as RolloutState["status"] }; // Cyrillic е
    const next = applyHealthWindow(corrupt, HEALTHY, 2_000);
    expect(next.status).toBe("in_progress");
    expect(next.transitions.at(-1)?.fromStatus).toBe("in_progrеss");
  });

  it("HELD: kill switch after every non-terminal state lands on knownGood; on terminal states it throws", () => {
    let state = fresh();
    expect(forceRollback(state, 2).activeVersion).toBe("1.9.3");
    state = applyHealthWindow(state, { ...HEALTHY, crash_rate: null }, 3);
    expect(state.status).toBe("paused");
    const rolled = forceRollback(state, 4);
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.stagePercent).toBe(0);
    expect(() => forceRollback(rolled, 5)).toThrowError(/is terminal \(rolled_back\)/);
    expect(() => applyHealthWindow(rolled, HEALTHY, 6)).toThrowError(/is terminal/);
  });

  it("HELD: createRollout rejects identical versions but accepts visually identical unicode-normalised variants as DIFFERENT versions (pinned)", () => {
    expect(() =>
      createRollout({
        rolloutId: "r",
        modelId: "m",
        candidateVersion: "1.0.0",
        knownGoodVersion: "1.0.0",
        nowMs: 0,
      }),
    ).toThrowError(/must differ/);
    const nfc = "1.0.0-é";
    const nfd = "1.0.0-e\u0301";
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    const state = createRollout({
      rolloutId: "r",
      modelId: "m",
      candidateVersion: nfc,
      knownGoodVersion: nfd,
      nowMs: 0,
    });
    expect(state.candidateVersion).not.toBe(state.knownGoodVersion);
  });

  it("HELD: the returned state never aliases the input — 10,000 applications leave the original untouched", () => {
    const origin = fresh();
    const snapshot = JSON.stringify(origin);
    let state = origin;
    for (let i = 0; i < 10_000; i++) {
      state = applyHealthWindow(state, { ...HEALTHY, crash_rate: null }, i);
    }
    expect(state.transitions).toHaveLength(10_001);
    expect(state.transitions.at(-1)?.seq).toBe(10_000);
    expect(JSON.stringify(origin)).toBe(snapshot);
  });
});
