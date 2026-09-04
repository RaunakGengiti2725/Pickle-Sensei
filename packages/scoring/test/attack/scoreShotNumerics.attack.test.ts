/**
 * Adversarial pass 3 / tester #4 — scoring engine numeric robustness.
 *
 * scoreShot is documented as "pure and deterministic"; the shared result
 * contract is overallScore: number|null (0–10, one decimal) — NaN is neither.
 * Attacks: non-finite measurement values (NaN, -Infinity, Number.MAX_VALUE),
 * a MetricTarget with sigma = 0, identical checkpoint scores fed into
 * selectPriorityFix with/without a focusCheckpoint that is absent from the
 * config, and seeded shuffles of the results array to prove order
 * independence. Seeds are recorded in test names.
 */
import { describe, expect, it } from "vitest";
import type { CheckpointKey, Measurement } from "@pickle/shared-types";
import {
  getShotScoringConfig,
  scoreMetric,
  scoreShot,
  selectPriorityFix,
  type CheckpointResultDetail,
  type MetricTarget,
  type ShotScoringConfig,
} from "../../src/index.js";

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

/** Perfect-center measurements for every configured metric of a shot. */
function perfectMeasurements(config: ShotScoringConfig, confidence = 0.95): Measurement[] {
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) out.push(m(t.metricKey, (t.lower + t.upper) / 2, confidence));
  }
  return out;
}

const SEED = 0x5eed_0006;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const isFiniteOrNull = (value: number | null): boolean => value === null || Number.isFinite(value);

describe("[attack] scoreShot — NaN / -Infinity / Number.MAX_VALUE for one metric", () => {
  const config = getShotScoringConfig("forehand_drive");
  const firstMetric = config.checkpoints.find((c) => c.metrics.length > 0)!.metrics[0]!;

  for (const poison of [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
  ]) {
    it(`value=${String(poison)} → overallScore is a finite number or null, never NaN`, () => {
      const measurements = perfectMeasurements(config).map((meas) =>
        meas.metricKey === firstMetric.metricKey ? { ...meas, value: poison } : meas,
      );
      const outcome = scoreShot(config, measurements);
      expect(
        isFiniteOrNull(outcome.overallScore),
        `overallScore=${String(outcome.overallScore)} presentation=${outcome.presentation}`,
      ).toBe(true);
      expect(Number.isFinite(outcome.analysisConfidence)).toBe(true);
      for (const cp of outcome.checkpoints) {
        expect(isFiniteOrNull(cp.score), `${cp.key}.score=${String(cp.score)}`).toBe(true);
        expect(Number.isFinite(cp.severity), `${cp.key}.severity=${String(cp.severity)}`).toBe(
          true,
        );
        expect(Number.isFinite(cp.confidence)).toBe(true);
      }
      for (const detail of outcome.checkpointResults.flatMap((r) => r.metricDetails)) {
        expect(
          Number.isFinite(detail.q),
          `${detail.metricKey}.q=${String(detail.q)} for value=${String(poison)}`,
        ).toBe(true);
      }
    });
  }

  it("a NaN measurement is either dropped as unmeasured or the result abstains (contract), and nothing throws", () => {
    const measurements = perfectMeasurements(config).map((meas) =>
      meas.metricKey === firstMetric.metricKey ? { ...meas, value: Number.NaN } : meas,
    );
    let outcome: ReturnType<typeof scoreShot> | undefined;
    expect(() => {
      outcome = scoreShot(config, measurements);
    }).not.toThrow();
    if (!outcome) return;
    const poisonedCp = outcome.checkpointResults.find((r) =>
      r.metricDetails.some((d) => d.metricKey === firstMetric.metricKey),
    );
    const treatedAsUnmeasured =
      poisonedCp === undefined ||
      !poisonedCp.metricDetails.some(
        (d) => d.metricKey === firstMetric.metricKey && Number.isNaN(d.q),
      );
    expect(
      treatedAsUnmeasured || outcome.presentation === "abstain",
      `NaN metric was scored (q=NaN) and the result did not abstain: overallScore=${String(outcome.overallScore)}`,
    ).toBe(true);
  });

  it("NaN confidence (not value) never yields NaN analysisConfidence / overallScore", () => {
    const measurements = perfectMeasurements(config).map((meas) =>
      meas.metricKey === firstMetric.metricKey ? { ...meas, confidence: Number.NaN } : meas,
    );
    const outcome = scoreShot(config, measurements);
    expect(
      Number.isFinite(outcome.analysisConfidence),
      `analysisConfidence=${outcome.analysisConfidence}`,
    ).toBe(true);
    expect(
      isFiniteOrNull(outcome.overallScore),
      `overallScore=${String(outcome.overallScore)}`,
    ).toBe(true);
  });

  it("scoreMetric direct: -Infinity and MAX_VALUE decay to q=0 with a real direction", () => {
    const target: MetricTarget = {
      metricKey: "attack_metric",
      lower: 0.25,
      upper: 0.6,
      sigma: 0.15,
      importance: 1,
      directionBelow: "late",
      directionAbove: "early",
    };
    expect(scoreMetric(target, Number.NEGATIVE_INFINITY)).toMatchObject({
      q: 0,
      direction: "late",
    });
    expect(scoreMetric(target, Number.MAX_VALUE)).toMatchObject({ q: 0, direction: "early" });
    expect(scoreMetric(target, Number.POSITIVE_INFINITY)).toMatchObject({
      q: 0,
      direction: "early",
    });
  });
});

describe("[attack] scoreShot — MetricTarget.sigma = 0", () => {
  const zeroSigma: MetricTarget = {
    metricKey: "zero_sigma_metric",
    lower: 0.25,
    upper: 0.6,
    sigma: 0,
    importance: 1,
    directionBelow: "late",
    directionAbove: "early",
  };

  it("scoreMetric with sigma=0 inside the interval yields q=100 (or throws a typed error), never NaN", () => {
    let result: ReturnType<typeof scoreMetric> | undefined;
    let thrown: unknown;
    try {
      result = scoreMetric(zeroSigma, 0.4);
    } catch (error) {
      thrown = error;
    }
    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(Error);
      return;
    }
    expect(result).toBeDefined();
    expect(
      Number.isFinite(result!.q),
      `q=${String(result!.q)} for an in-interval value with sigma=0`,
    ).toBe(true);
    expect(result!.q).toBe(100);
  });

  it("scoreMetric with sigma=0 outside the interval yields q=0 (step function), never NaN", () => {
    const result = scoreMetric(zeroSigma, 0.7);
    expect(Number.isFinite(result.q), `q=${String(result.q)}`).toBe(true);
    expect(result.q).toBe(0);
  });

  it("scoreShot over a config with sigma=0 never produces NaN overallScore", () => {
    const base = getShotScoringConfig("dink");
    const config: ShotScoringConfig = {
      ...base,
      checkpoints: base.checkpoints.map((cp) => ({
        ...cp,
        metrics: cp.metrics.map((t) => ({ ...t, sigma: 0 })),
      })),
    };
    const outcome = scoreShot(config, perfectMeasurements(config));
    expect(
      isFiniteOrNull(outcome.overallScore),
      `overallScore=${String(outcome.overallScore)} presentation=${outcome.presentation}`,
    ).toBe(true);
  });

  it("negative sigma behaves like |sigma| or is rejected — never NaN", () => {
    const result = scoreMetric({ ...zeroSigma, sigma: -0.15 }, 0.75);
    expect(Number.isFinite(result.q)).toBe(true);
  });
});

describe(`[attack] identical checkpoint scores → selectPriorityFix (seed ${SEED})`, () => {
  const config = getShotScoringConfig("forehand_drive");

  /** Every configured metric one sigma above upper → every checkpoint scores identically (~60.65). */
  function uniformlyFlawedMeasurements(): Measurement[] {
    const out: Measurement[] = [];
    for (const cp of config.checkpoints) {
      for (const t of cp.metrics) out.push(m(t.metricKey, t.upper + t.sigma, 0.9));
    }
    return out;
  }

  it("all checkpoints score identically and neither call throws", () => {
    const outcome = scoreShot(config, uniformlyFlawedMeasurements());
    const scores = new Set(
      outcome.checkpointResults.map((r) => (r.score === null ? "null" : r.score.toFixed(6))),
    );
    expect(scores.size).toBe(1);
    expect(() => selectPriorityFix(config, outcome.checkpointResults)).not.toThrow();
    expect(() =>
      selectPriorityFix(config, outcome.checkpointResults, {
        focusCheckpoint: "not_a_real_checkpoint" as unknown as CheckpointKey,
      }),
    ).not.toThrow();
  });

  it("the chosen fix is identical across 200 seeded shuffles of the results array (no focus)", () => {
    const outcome = scoreShot(config, uniformlyFlawedMeasurements());
    const reference = selectPriorityFix(config, outcome.checkpointResults);
    expect(reference).not.toBeNull();
    const rand = mulberry32(SEED);
    for (let i = 0; i < 200; i += 1) {
      const fix = selectPriorityFix(config, shuffled(outcome.checkpointResults, rand));
      expect(fix, `shuffle ${i}`).toEqual(reference);
    }
  });

  it("a focusCheckpoint absent from the config changes nothing and is deterministic under shuffles", () => {
    const outcome = scoreShot(config, uniformlyFlawedMeasurements());
    const withoutFocus = selectPriorityFix(config, outcome.checkpointResults);
    const bogusFocus = "definitely_absent" as unknown as CheckpointKey;
    const withBogus = selectPriorityFix(config, outcome.checkpointResults, {
      focusCheckpoint: bogusFocus,
    });
    expect(withBogus).toEqual(withoutFocus);
    const rand = mulberry32(SEED ^ 0xff);
    for (let i = 0; i < 100; i += 1) {
      expect(
        selectPriorityFix(config, shuffled(outcome.checkpointResults, rand), {
          focusCheckpoint: bogusFocus,
        }),
      ).toEqual(withoutFocus);
    }
  });

  it("a focusCheckpoint that IS configured is selected (stickiness) when priorities are otherwise flat", () => {
    const flatConfig: ShotScoringConfig = {
      ...config,
      dependencies: [],
      checkpoints: config.checkpoints.map((cp) => ({ ...cp, coachPriority: 1, changeability: 1 })),
    };
    const outcome = scoreShot(flatConfig, uniformlyFlawedMeasurements());
    const observedKeys = outcome.checkpointResults.filter((r) => r.observed).map((r) => r.key);
    expect(observedKeys.length).toBeGreaterThan(1);
    const noFocus = selectPriorityFix(flatConfig, outcome.checkpointResults);
    expect(noFocus).not.toBeNull();
    // Near-tie priorities (equal up to float noise from per-checkpoint Σa·c
    // normalisation) must still resolve to the same key on every call.
    const rand = mulberry32(SEED ^ 0xabcd);
    for (let i = 0; i < 50; i += 1) {
      expect(selectPriorityFix(flatConfig, shuffled(outcome.checkpointResults, rand))).toEqual(
        noFocus,
      );
    }
    for (const focus of observedKeys) {
      const focused = selectPriorityFix(flatConfig, outcome.checkpointResults, {
        focusCheckpoint: focus,
      });
      expect(focused?.checkpoint, `focus=${focus}`).toBe(focus);
    }
  });

  it("results for checkpoints absent from the config are ignored, never dereferenced", () => {
    const outcome = scoreShot(config, uniformlyFlawedMeasurements());
    const alien: CheckpointResultDetail = {
      ...outcome.checkpointResults[0]!,
      key: "alien_checkpoint" as unknown as CheckpointKey,
      severity: 1,
      confidence: 1,
    };
    const fix = selectPriorityFix(config, [alien, ...outcome.checkpointResults]);
    expect(fix?.checkpoint).not.toBe("alien_checkpoint");
  });

  it("NaN severity in a result never becomes the selected fix or throws", () => {
    const outcome = scoreShot(config, uniformlyFlawedMeasurements());
    const poisoned = outcome.checkpointResults.map((r, i) =>
      i === 0 ? { ...r, severity: Number.NaN } : r,
    );
    let fix: ReturnType<typeof selectPriorityFix> | undefined;
    expect(() => {
      fix = selectPriorityFix(config, poisoned);
    }).not.toThrow();
    expect(fix?.checkpoint).not.toBe(poisoned[0]!.key);
    if (fix) expect(Number.isFinite(fix.severity)).toBe(true);
  });
});
