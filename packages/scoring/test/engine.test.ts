import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import {
  bandFor,
  getAllShotScoringConfigs,
  getShotScoringConfig,
  scoreMetric,
  scoreShot,
  WEIGHT_MATRIX,
} from "../src/index.js";

function m(metricKey: string, value: number, confidence = 0.95): Measurement {
  return { metricKey, value, confidence, unit: "normalized", source: "fixture" };
}

/** Perfect-center measurements for every configured metric of a shot. */
function perfectMeasurements(
  shotType: Parameters<typeof getShotScoringConfig>[0],
  confidence = 0.95,
): Measurement[] {
  const config = getShotScoringConfig(shotType);
  const out: Measurement[] = [];
  for (const cp of config.checkpoints) {
    for (const t of cp.metrics) {
      out.push(m(t.metricKey, (t.lower + t.upper) / 2, confidence));
    }
  }
  return out;
}

const perfectForehandMeasurements = (confidence = 0.95): Measurement[] =>
  perfectMeasurements("forehand_drive", confidence);

describe("scoreMetric", () => {
  const target = {
    metricKey: "contact_forward_of_hip_norm",
    lower: 0.25,
    upper: 0.6,
    sigma: 0.15,
    importance: 1,
    directionBelow: "late" as const,
    directionAbove: "early" as const,
  };

  it("gives full credit anywhere inside the acceptable interval", () => {
    expect(scoreMetric(target, 0.25).q).toBe(100);
    expect(scoreMetric(target, 0.42).q).toBe(100);
    expect(scoreMetric(target, 0.6).q).toBe(100);
    expect(scoreMetric(target, 0.42).direction).toBe("none");
  });

  it("decays smoothly outside with q = 100·exp(−½(d/σ)²)", () => {
    const oneSigmaBelow = scoreMetric(target, 0.25 - 0.15);
    expect(oneSigmaBelow.q).toBeCloseTo(100 * Math.exp(-0.5), 6);
    expect(oneSigmaBelow.direction).toBe("late");
    const twoSigmaAbove = scoreMetric(target, 0.6 + 0.3);
    expect(twoSigmaAbove.q).toBeCloseTo(100 * Math.exp(-2), 6);
    expect(twoSigmaAbove.direction).toBe("early");
  });
});

describe("bands", () => {
  it("matches spec presentation bands", () => {
    expect(bandFor(80)).toBe("green");
    expect(bandFor(79.9)).toBe("yellow");
    expect(bandFor(65)).toBe("yellow");
    expect(bandFor(64.9)).toBe("red");
    expect(bandFor(null)).toBe("unscored");
  });
});

describe("scoreShot", () => {
  it("scores a clean stroke ~10 with high confidence", () => {
    const outcome = scoreShot(
      getShotScoringConfig("forehand_drive"),
      perfectForehandMeasurements(),
    );
    expect(outcome.presentation).toBe("normal");
    expect(outcome.overallScore).toBe(10);
    expect(outcome.analysisConfidence).toBeCloseTo(0.95, 5);
    for (const cp of outcome.checkpoints) {
      expect(cp.band).toBe("green");
      expect(cp.direction).toBe("none");
    }
  });

  it("penalizes a late contact and reports the fault direction", () => {
    const measurements = perfectForehandMeasurements().map((meas) =>
      meas.metricKey === "contact_forward_of_hip_norm" ? { ...meas, value: 0.02 } : meas,
    );
    const outcome = scoreShot(getShotScoringConfig("forehand_drive"), measurements);
    expect(outcome.presentation).toBe("normal");
    expect(outcome.overallScore).toBeLessThan(10);
    const contact = outcome.checkpoints.find((c) => c.key === "contact_position");
    expect(contact?.direction).toBe("late");
    expect(contact?.band).not.toBe("green");
    expect(contact?.severity).toBeGreaterThan(0.2);
  });

  it("scores a low-visibility read as lower_confidence instead of withholding the grade", () => {
    // 2026-09-10: the 0.65 floor turned real swings (Apple Vision measures
    // 0.60–0.70 joint visibility) into NOT SCORED reads. Visibility is
    // disclosed through analysisConfidence and the presentation, never by
    // refusing the score.
    const outcome = scoreShot(
      getShotScoringConfig("forehand_drive"),
      perfectForehandMeasurements(0.3),
    );
    expect(outcome.presentation).toBe("lower_confidence");
    expect(outcome.analysisConfidence).toBeCloseTo(0.3, 5);
    expect(outcome.overallScore).toBe(10);
    expect(outcome.guidance).toBeNull();
    for (const cp of outcome.checkpoints) {
      expect(cp.score).toBe(100);
      expect(cp.band).toBe("green");
    }
  });

  it("scores from the observed checkpoints when others (e.g. paddle metrics) were never observed", () => {
    // Only pose-derived base metrics present — paddle metrics missing entirely.
    const measurements = [
      m("stance_width_ratio", 1.3),
      m("knee_flexion_deg", 30),
      m("shoulder_turn_deg", 50),
    ];
    const outcome = scoreShot(getShotScoringConfig("forehand_drive"), measurements);
    expect(outcome.presentation).toBe("lower_confidence");
    // Coverage is honest: the unobserved checkpoints hold the confidence down.
    expect(outcome.analysisConfidence).toBeCloseTo((22 * 0.95) / 95, 5);
    expect(outcome.overallScore).toBe(10);
    const observed = outcome.checkpoints.filter((cp) => cp.score !== null).map((cp) => cp.key);
    expect(observed.sort()).toEqual(["athletic_base", "preparation"]);
    for (const cp of outcome.checkpoints) {
      if (observed.includes(cp.key)) continue;
      expect(cp.score).toBeNull();
      expect(cp.band).toBe("unscored");
      expect(cp.confidence).toBe(0);
    }
  });

  it("flags lower-confidence presentation below 0.80", () => {
    const outcome = scoreShot(
      getShotScoringConfig("forehand_drive"),
      perfectForehandMeasurements(0.7),
    );
    expect(outcome.presentation).toBe("lower_confidence");
    expect(outcome.overallScore).toBe(10);
  });

  it("honours a config that sets its own confidence floor", () => {
    const config = { ...getShotScoringConfig("forehand_drive"), minAnalysisConfidence: 0.65 };
    const outcome = scoreShot(config, perfectForehandMeasurements(0.3));
    expect(outcome.presentation).toBe("abstain");
    expect(outcome.overallScore).toBeNull();
    expect(outcome.guidance).toMatch(/couldn't read/i);
    for (const cp of outcome.checkpoints) {
      expect(cp.score).toBeNull();
      expect(cp.band).toBe("unscored");
    }
  });

  it("abstains when no configured metric was actually measured (no fake scores)", () => {
    const outcome = scoreShot(getShotScoringConfig("volley"), [m("anything", 1)]);
    expect(outcome.overallScore).toBeNull();
    expect(outcome.presentation).toBe("abstain");
  });

  it("scores EVERY shot type with clean measurements — no unreleased techniques", () => {
    const configs = getAllShotScoringConfigs();
    expect(configs).toHaveLength(8);
    for (const config of configs) {
      const outcome = scoreShot(config, perfectMeasurements(config.shotType));
      expect(outcome.presentation, `${config.shotType} presentation`).toBe("normal");
      expect(outcome.overallScore, `${config.shotType} overall score`).toBe(10);
    }
  });
});

describe("config integrity", () => {
  it("every shot column of the weight matrix sums to exactly 100 (spec p. 32)", () => {
    for (const [shot, column] of Object.entries(WEIGHT_MATRIX)) {
      const sum = Object.values(column).reduce((a, b) => a + b, 0);
      expect(sum, `weights for ${shot}`).toBe(100);
    }
  });

  it("ALL eight shot types have configs with full metric coverage for every measurable checkpoint", () => {
    const configs = getAllShotScoringConfigs();
    expect(configs).toHaveLength(8);
    for (const config of configs) {
      for (const cp of config.checkpoints) {
        if (cp.key === "recovery") {
          // No extractor measures recovery (recovery_time_ms was the trigger
          // window's tail padding, dropped in geometry-2): the checkpoint is
          // not applicable rather than unobserved-against-every-capture.
          expect(cp.metrics, `${config.shotType}/${cp.key}`).toEqual([]);
          continue;
        }
        expect(cp.metrics.length, `${config.shotType}/${cp.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("a checkpoint no extractor can measure never drags analysis confidence toward abstention", () => {
    // Regression (2026-09-10): with `recovery` still targeting the dropped
    // recovery_time_ms metric, every real read carried a permanent zero-
    // confidence checkpoint worth 4–7% of the weight, so reads that measured
    // every REAL checkpoint at 0.66–0.68 mean visibility abstained. The
    // engine must score them exactly as the ten measurable checkpoints say.
    for (const config of getAllShotScoringConfigs()) {
      const outcome = scoreShot(config, perfectMeasurements(config.shotType, 0.66));
      expect(outcome.analysisConfidence, config.shotType).toBeCloseTo(0.66, 6);
      expect(outcome.presentation, config.shotType).toBe("lower_confidence");
      expect(outcome.overallScore, config.shotType).toBe(10);
      expect(outcome.checkpoints.some((cp) => cp.key === "recovery")).toBe(false);
      // A stray recovery measurement changes nothing: there is no target for it.
      const withStray = scoreShot(config, [
        ...perfectMeasurements(config.shotType, 0.66),
        m("recovery_time_ms", 100, 1),
      ]);
      expect(withStray.analysisConfidence).toBeCloseTo(0.66, 6);
      expect(withStray.overallScore).toBe(10);
    }
  });

  it("every configured metric key is one the geometry extractor can measure", () => {
    // The measurable vocabulary of features-geometry-2 (featureExtractor.ts).
    const measurable = new Set([
      "stance_width_ratio",
      "knee_flexion_deg",
      "paddle_ready_height_ratio",
      "shoulder_turn_deg",
      "paddle_set_height_ratio",
      "paddle_set_forward_norm",
      "backswing_length_norm",
      "hip_shoulder_lag_ms",
      "weight_transfer_norm",
      "path_low_to_high_slope",
      "contact_forward_of_hip_norm",
      "contact_height_ratio",
      "wrist_angle_variance_deg",
      "follow_through_length_norm",
    ]);
    for (const config of getAllShotScoringConfigs()) {
      for (const cp of config.checkpoints) {
        for (const t of cp.metrics) {
          expect(measurable.has(t.metricKey), `${config.shotType}/${cp.key}/${t.metricKey}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("configs carry version identifiers for score versioning", () => {
    const config = getShotScoringConfig("dink");
    expect(config.scoringModelVersion).toBe("sm-v1");
    expect(config.shotConfigVersion).toBe("dink@1");
  });
});
