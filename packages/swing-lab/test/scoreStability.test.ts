import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import {
  PERTURBATION_MODELS,
  perturbMeasurements,
  runStabilityProbe,
} from "../src/scoreStability.js";

function measurementFixture(confidence: number): Measurement[] {
  return [
    { metricKey: "stance_width_ratio", value: 1.2, unit: "ratio", confidence, source: "real" },
    { metricKey: "knee_flexion_deg", value: 25, unit: "degrees", confidence, source: "real" },
    { metricKey: "shoulder_turn_deg", value: 40, unit: "degrees", confidence, source: "real" },
  ];
}

describe("score stability probe (formula-level diagnostic)", () => {
  it("covers all five frozen S6 perturbation families", () => {
    expect(PERTURBATION_MODELS.map((model) => model.id).sort()).toEqual([
      "brightness",
      "camera_motion",
      "compression",
      "crop",
      "frame_rate",
    ]);
  });

  it("is deterministic: identical seeds produce identical perturbations", () => {
    const rngA = (() => {
      let s = 42;
      return () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
    })();
    const rngB = (() => {
      let s = 42;
      return () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
    })();
    const model = PERTURBATION_MODELS[0]!;
    const a = perturbMeasurements(measurementFixture(0.9), model, rngA);
    const b = perturbMeasurements(measurementFixture(0.9), model, rngB);
    expect(a).toEqual(b);
  });

  it("perturbation never inflates confidence and clamps to [0,1]", () => {
    const rng = () => 1; // worst case draw
    for (const model of PERTURBATION_MODELS) {
      for (const perturbed of perturbMeasurements(measurementFixture(0.9), model, rng)) {
        expect(perturbed.confidence).toBeLessThanOrEqual(0.9);
        expect(perturbed.confidence).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("low-confidence input abstains at baseline and stays abstained — no score is invented", () => {
    const probe = runStabilityProbe("forehand_drive", measurementFixture(0.1), 25);
    expect(probe.baseline.presentation).toBe("abstain");
    expect(probe.baseline.score).toBeNull();
    for (const summary of probe.summaries) {
      expect(summary.scoredTrials).toBe(0);
    }
  });

  it("probe results are reproducible run-to-run (seeded)", () => {
    const first = runStabilityProbe("forehand_drive", measurementFixture(0.95), 50);
    const second = runStabilityProbe("forehand_drive", measurementFixture(0.95), 50);
    expect(second.summaries).toEqual(first.summaries);
  });
});
