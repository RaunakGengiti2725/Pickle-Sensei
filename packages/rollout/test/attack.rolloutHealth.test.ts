import { describe, expect, it } from "vitest";
import {
  FROZEN_HEALTH_CRITERIA_V1,
  FROZEN_HEALTH_CRITERIA_V1_SHA256,
  HEALTH_METRIC_IDS,
  ROLLOUT_STAGES_V1,
  applyHealthWindow,
  createRollout,
  evaluateHealth,
  healthCriteriaSha256,
  type HealthCriteria,
  type HealthInputs,
  type HealthMetricId,
  type MetricObservation,
  type RolloutState,
} from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against the frozen
 * health evaluator and the rollout state machine. Every case is either a
 * HELD property (the evaluator refuses) or a documented BROKEN behaviour
 * (the test pins what the code does today so the finding is reproducible;
 * the expected-safe behaviour is spelled out in the test name).
 *
 * Seeded LCG so the sweeps are reproducible; seeds are recorded per test.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const criterionFor = (id: HealthMetricId) => {
  const criterion = FROZEN_HEALTH_CRITERIA_V1.metrics.find((m) => m.id === id);
  if (criterion === undefined) throw new Error(`Missing criterion for ${id}`);
  return criterion;
};

/** A comfortably in-range, well-sampled observation for a metric. */
function healthyObservation(id: HealthMetricId): MetricObservation {
  const c = criterionFor(id);
  return {
    value: c.direction === "at_most" ? c.threshold / 2 : c.threshold + (1 - c.threshold) / 2,
    sampleCount: c.minSampleCount * 3,
  };
}

function allHealthy(): Record<HealthMetricId, MetricObservation | null> {
  return Object.fromEntries(
    HEALTH_METRIC_IDS.map((id) => [id, healthyObservation(id)] as const),
  ) as Record<HealthMetricId, MetricObservation | null>;
}

function freshRollout(id: string): RolloutState {
  return createRollout({
    rolloutId: id,
    modelId: "scorer.sm-v1",
    candidateVersion: "candidate-v2",
    knownGoodVersion: "known-good-v1",
    nowMs: 0,
  });
}

const RUNS = 500;

describe("attack: malformed numeric observations never yield HEALTHY", () => {
  it("float (non-integer) sampleCount on any metric → overall never HEALTHY (seed 0x5a11)", () => {
    const rand = lcg(0x5a11);
    let poisoned = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const inputs = allHealthy();
      const victim = HEALTH_METRIC_IDS[Math.floor(rand() * HEALTH_METRIC_IDS.length)]!;
      const c = criterionFor(victim);
      // Above the sample floor, but not an integer: 200.5, 100.000001, 1e6+0.25 …
      const frac = [0.5, 1e-6, 0.25, 0.999999][Math.floor(rand() * 4)]!;
      inputs[victim] = {
        value: healthyObservation(victim).value,
        sampleCount: c.minSampleCount + Math.floor(rand() * 1e6) + frac,
      };
      const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.overall).not.toBe("HEALTHY");
      expect(report.metrics.find((m) => m.id === victim)?.verdict).toBe("NOT_EVALUABLE");
      poisoned += 1;
    }
    expect(poisoned).toBe(RUNS);
  });

  it("value = ±Infinity on any metric → NOT_EVALUABLE, overall never HEALTHY (seed 0x1f1f)", () => {
    const rand = lcg(0x1f1f);
    for (let run = 0; run < RUNS; run += 1) {
      const inputs = allHealthy();
      const victim = HEALTH_METRIC_IDS[Math.floor(rand() * HEALTH_METRIC_IDS.length)]!;
      inputs[victim] = {
        value: rand() < 0.5 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
        sampleCount: criterionFor(victim).minSampleCount * 2,
      };
      const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.overall).not.toBe("HEALTHY");
      expect(report.metrics.find((m) => m.id === victim)?.verdict).toBe("NOT_EVALUABLE");
    }
  });

  it("sampleCount = ±Infinity / NaN / -0 on any metric → never HEALTHY (seed 0x7e57)", () => {
    const rand = lcg(0x7e57);
    const poison = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0];
    for (let run = 0; run < RUNS; run += 1) {
      const inputs = allHealthy();
      const victim = HEALTH_METRIC_IDS[Math.floor(rand() * HEALTH_METRIC_IDS.length)]!;
      inputs[victim] = {
        value: healthyObservation(victim).value,
        sampleCount: poison[Math.floor(rand() * poison.length)]!,
      };
      const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
      expect(report.overall).not.toBe("HEALTHY");
    }
  });

  it("value = -0 is numerically 0: HEALTHY for at_most metrics, UNHEALTHY for at_least (documented)", () => {
    // -0 === 0 in IEEE-754; the evaluator treats it as a true zero. For an
    // at_most rate (crash_rate) zero is legitimately healthy; for an
    // at_least rate (completion) zero is a breach. This is NOT a bypass —
    // recorded here so the boundary is explicit.
    const inputs = allHealthy();
    inputs.crash_rate = { value: -0, sampleCount: 400 };
    expect(evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("HEALTHY");
    const inputs2 = allHealthy();
    inputs2.analysis_completion_rate = { value: -0, sampleCount: 400 };
    expect(evaluateHealth(inputs2, FROZEN_HEALTH_CRITERIA_V1).overall).toBe("UNHEALTHY");
  });

  it("FINDING: strictly negative values for at_most metrics are accepted as HEALTHY (out-of-domain rate)", () => {
    // A rate or latency can never be negative; a producer emitting -1 as an
    // "unknown" sentinel, or a subtraction bug, makes crash_rate / latency
    // / silent_failure_rate look perfectly healthy. Expected: NOT_EVALUABLE.
    const inputs = allHealthy();
    inputs.crash_rate = { value: -1, sampleCount: 400 };
    inputs.analysis_latency_p95_ms = { value: -5000, sampleCount: 400 };
    inputs.silent_failure_rate = { value: -0.5, sampleCount: 400 };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    // Pins current (unsafe) behaviour so the repro is executable.
    expect(report.overall).toBe("HEALTHY");
    expect(report.metrics.find((m) => m.id === "crash_rate")?.verdict).toBe("HEALTHY");
  });

  it("FINDING: at_least rates above 1 (percent-vs-fraction unit slip) are accepted as HEALTHY", () => {
    // completion_rate=96 (meaning 96%) is >= 0.95 → HEALTHY even though a
    // fraction can never exceed 1. Expected: NOT_EVALUABLE for a rate > 1.
    const inputs = allHealthy();
    inputs.analysis_completion_rate = { value: 96, sampleCount: 400 };
    inputs.capture_success_rate = { value: 92, sampleCount: 400 };
    const report = evaluateHealth(inputs, FROZEN_HEALTH_CRITERIA_V1);
    expect(report.overall).toBe("HEALTHY");
  });
});

describe("attack: corrupt rollout state (stagePercent off the frozen ladder)", () => {
  const offLadder = [10, 2, 99, 101, -5, 0.5, Number.NaN, 1e9];

  for (const stage of offLadder) {
    it(`FINDING: applyHealthWindow on stagePercent=${String(stage)} + HEALTHY window does NOT throw — it "promotes" to ${ROLLOUT_STAGES_V1[0]}%`, () => {
      // nextStage() does indexOf(current)+1 → -1+1 = 0 → ROLLOUT_STAGES_V1[0].
      // A persisted state that was corrupted (or produced by a future ladder)
      // is silently accepted and the exposure jumps to the FIRST rung while
      // the transition is labelled "promote". Expected: throw on any stage
      // not in ROLLOUT_STAGES_V1.
      const state = {
        ...freshRollout(`corrupt-${String(stage)}`),
        stagePercent: stage as RolloutState["stagePercent"],
      };
      let threw = false;
      let next: RolloutState | null = null;
      try {
        next = applyHealthWindow(state, allHealthy(), 1_000);
      } catch {
        threw = true;
      }
      if (stage === 0) {
        expect(threw).toBe(true);
        return;
      }
      // Pins current behaviour so the finding is reproducible.
      expect(threw).toBe(false);
      expect(next?.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
      const last = next!.transitions[next!.transitions.length - 1]!;
      expect(last.action).toBe("promote");
      expect(last.fromStagePercent).toBe(stage);
      expect(last.toStagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    });
  }

  it("HELD: on-ladder stages only ever advance one rung", () => {
    let state = freshRollout("ladder");
    for (let i = 1; i < ROLLOUT_STAGES_V1.length; i += 1) {
      state = applyHealthWindow(state, allHealthy(), i);
      expect(state.stagePercent).toBe(ROLLOUT_STAGES_V1[i]);
    }
    state = applyHealthWindow(state, allHealthy(), 99);
    expect(state.status).toBe("complete");
  });
});

describe("attack: frozen criteria tampering", () => {
  function clone(): HealthCriteria {
    return {
      id: FROZEN_HEALTH_CRITERIA_V1.id,
      schemaVersion: 1,
      metrics: FROZEN_HEALTH_CRITERIA_V1.metrics.map((m) => ({ ...m })),
    };
  }

  it("HELD: an exact deep copy hashes to the pin and evaluates", () => {
    const c = clone();
    expect(healthCriteriaSha256(c)).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
    expect(() => applyHealthWindow(freshRollout("c"), allHealthy(), 1, c)).not.toThrow();
  });

  for (const [index, m] of FROZEN_HEALTH_CRITERIA_V1.metrics.entries()) {
    it(`HELD: ${m.id}.threshold changed by +1e-12 → sha mismatch throw`, () => {
      const c = clone();
      const target = c.metrics[index]!;
      const loosened = target.threshold + 1e-12;
      expect(loosened).not.toBe(target.threshold);
      (target as { threshold: number }).threshold = loosened;
      expect(healthCriteriaSha256(c)).not.toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
      expect(() => applyHealthWindow(freshRollout("t"), allHealthy(), 1, c)).toThrow(
        /do not match the frozen pin/,
      );
    });

    it(`HELD: ${m.id}.threshold changed by -1e-12 → sha mismatch throw`, () => {
      const c = clone();
      const target = c.metrics[index]!;
      (target as { threshold: number }).threshold = target.threshold - 1e-12;
      expect(() => evaluateHealth(allHealthy(), c)).toThrow(/do not match the frozen pin/);
    });

    it(`HELD: ${m.id}.minSampleCount changed by 1 → sha mismatch throw`, () => {
      const c = clone();
      const target = c.metrics[index]!;
      (target as { minSampleCount: number }).minSampleCount = target.minSampleCount - 1;
      expect(() => evaluateHealth(allHealthy(), c)).toThrow(/do not match the frozen pin/);
    });
  }

  it("HELD: a delta below float resolution (1e-20) is not a change at all", () => {
    const c = clone();
    const target = c.metrics[0]!;
    (target as { threshold: number }).threshold = target.threshold + 1e-20;
    expect(target.threshold).toBe(FROZEN_HEALTH_CRITERIA_V1.metrics[0]!.threshold);
    expect(healthCriteriaSha256(c)).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
  });

  it("HELD: dropping a metric, reordering, or flipping direction → throw", () => {
    const dropped = clone();
    (dropped as unknown as { metrics: unknown[] }).metrics = dropped.metrics.slice(1);
    expect(() => evaluateHealth(allHealthy(), dropped)).toThrow(/frozen pin/);

    const reordered = clone();
    (reordered as unknown as { metrics: unknown[] }).metrics = [...reordered.metrics].reverse();
    expect(() => evaluateHealth(allHealthy(), reordered)).toThrow(/frozen pin/);

    const flipped = clone();
    (flipped.metrics[0] as { direction: string }).direction = "at_least";
    expect(() => evaluateHealth(allHealthy(), flipped)).toThrow(/frozen pin/);
  });

  it("HELD: renaming the id with an otherwise-identical body → throw", () => {
    const c = clone();
    (c as { id: string }).id = "rollout-health-frozen-v1 ";
    expect(() => evaluateHealth(allHealthy(), c)).toThrow(/frozen pin/);
  });

  it("FINDING (P3): a getter-backed threshold can hash frozen but evaluate loosened (hash/evaluate TOCTOU)", () => {
    // assertFrozenCriteria() reads each threshold once via canonicalize();
    // evaluateMetric() reads it again. A hostile criteria object whose
    // threshold is an accessor returns the frozen value on every read except
    // the one the comparison performs, and so passes the pin while loosening
    // the gate. Requires a deliberately hostile object — the frozen constant
    // itself is not affected — so this is defence-in-depth only.
    const c = clone();
    const victim = c.metrics[0]!; // crash_rate at_most 0.01
    const frozen = victim.threshold;
    let reads = 0;
    Object.defineProperty(victim, "threshold", {
      get() {
        reads += 1;
        // canonicalize (1st read) sees frozen; evaluateMetric's comparison
        // (2nd read) sees 1.0; every later read (detail string, report
        // hash) sees frozen again.
        return reads === 2 ? 1.0 : frozen;
      },
      enumerable: true,
      configurable: true,
    });
    const inputs = allHealthy();
    inputs.crash_rate = { value: 0.5, sampleCount: 400 }; // 50% crash rate
    const report = evaluateHealth(inputs, c);
    expect(report.criteriaSha256).toBe(FROZEN_HEALTH_CRITERIA_V1_SHA256);
    // Pins current behaviour: the report claims the frozen pin AND HEALTHY.
    expect(report.overall).toBe("HEALTHY");
  });
});

describe("attack: absent / thin data interleaved with corrupt state", () => {
  it("HELD: every all-null window pauses and never promotes, 200 windows", () => {
    let state = freshRollout("nulls");
    const nulls = Object.fromEntries(HEALTH_METRIC_IDS.map((id) => [id, null])) as HealthInputs;
    for (let i = 0; i < 200; i += 1) {
      state = applyHealthWindow(state, nulls, i);
      expect(state.status).toBe("paused");
      expect(state.stagePercent).toBe(ROLLOUT_STAGES_V1[0]);
    }
  });

  it("HELD: healthy → unhealthy → terminal; further windows throw", () => {
    let state = applyHealthWindow(freshRollout("term"), allHealthy(), 1);
    const bad = allHealthy();
    bad.crash_rate = { value: 0.5, sampleCount: 400 };
    state = applyHealthWindow(state, bad, 2);
    expect(state.status).toBe("rolled_back");
    expect(state.activeVersion).toBe("known-good-v1");
    expect(() => applyHealthWindow(state, allHealthy(), 3)).toThrow(/terminal/);
  });
});
