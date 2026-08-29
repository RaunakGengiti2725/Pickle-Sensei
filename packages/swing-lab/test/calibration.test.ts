import { describe, expect, it } from "vitest";
import {
  areaUnderRiskCoverage,
  coverageRiskCurve,
  expectedCalibrationError,
  reliabilityBins,
  type ConfidenceSample,
} from "../src/calibration.js";
import { loadW14Datasets } from "../src/coverageRisk.js";

const samples = (pairs: Array<[number, boolean]>): ConfidenceSample[] =>
  pairs.map(([confidence, correct]) => ({ confidence, correct }));

describe("reliabilityBins", () => {
  it("bins by confidence and reports empty bins honestly", () => {
    const bins = reliabilityBins(
      samples([
        [0.05, false],
        [0.95, true],
        [0.92, true],
        [0.98, false],
      ]),
      10,
    );
    expect(bins).toHaveLength(10);
    expect(bins[0]?.count).toBe(1);
    expect(bins[0]?.accuracy).toBe(0);
    expect(bins[9]?.count).toBe(3);
    expect(bins[9]?.accuracy).toBeCloseTo(2 / 3);
    expect(bins[9]?.meanConfidence).toBeCloseTo((0.95 + 0.92 + 0.98) / 3);
    expect(bins[5]?.count).toBe(0);
    expect(bins[5]?.accuracy).toBeNull();
  });

  it("confidence 1.0 lands in the top bin; out-of-range throws", () => {
    const bins = reliabilityBins(samples([[1.0, true]]), 10);
    expect(bins[9]?.count).toBe(1);
    expect(() => reliabilityBins(samples([[1.2, true]]), 10)).toThrow();
    expect(() => reliabilityBins([], 0)).toThrow();
  });
});

describe("expectedCalibrationError", () => {
  it("is 0 for perfectly calibrated bins and for empty input", () => {
    expect(expectedCalibrationError([], 10)).toBe(0);
    // Two samples at conf .5, one correct → bin accuracy .5 = mean conf .5.
    expect(
      expectedCalibrationError(
        samples([
          [0.5, true],
          [0.5, false],
        ]),
        10,
      ),
    ).toBeCloseTo(0);
  });

  it("weights bins by count", () => {
    // Bin [0.9,1]: 2 samples conf .9 both wrong → |0 − .9| = .9, weight 2/4.
    // Bin [0.1,0.2): 2 samples conf .1 both correct → |1 − .1| = .9, weight 2/4.
    const ece = expectedCalibrationError(
      samples([
        [0.9, false],
        [0.9, false],
        [0.1, true],
        [0.1, true],
      ]),
      10,
    );
    expect(ece).toBeCloseTo(0.9);
  });
});

describe("coverageRiskCurve", () => {
  it("sweeps thresholds from most to least confident with exact denominators", () => {
    const curve = coverageRiskCurve(
      samples([
        [0.9, true],
        [0.7, false],
        [0.5, true],
        [0.3, false],
      ]),
    );
    expect(curve).toEqual([
      { threshold: 0.9, coverage: 0.25, risk: 0, nAnswered: 1, nWrongAnswered: 0 },
      { threshold: 0.7, coverage: 0.5, risk: 0.5, nAnswered: 2, nWrongAnswered: 1 },
      { threshold: 0.5, coverage: 0.75, risk: 1 / 3, nAnswered: 3, nWrongAnswered: 1 },
      { threshold: 0.3, coverage: 1, risk: 0.5, nAnswered: 4, nWrongAnswered: 2 },
    ]);
  });

  it("collapses tied confidences into one point and handles empty input", () => {
    const curve = coverageRiskCurve(
      samples([
        [0.8, true],
        [0.8, false],
      ]),
    );
    expect(curve).toEqual([
      { threshold: 0.8, coverage: 1, risk: 0.5, nAnswered: 2, nWrongAnswered: 1 },
    ]);
    expect(coverageRiskCurve([])).toEqual([]);
  });
});

describe("areaUnderRiskCoverage", () => {
  it("is 0 when everything is correct and higher when confident answers are wrong", () => {
    expect(
      areaUnderRiskCoverage(
        samples([
          [0.9, true],
          [0.5, true],
        ]),
      ),
    ).toBe(0);
    const good = areaUnderRiskCoverage(
      samples([
        [0.9, true],
        [0.5, false],
      ]),
    );
    const bad = areaUnderRiskCoverage(
      samples([
        [0.9, false],
        [0.5, true],
      ]),
    );
    expect(bad).toBeGreaterThan(good);
  });
});

describe("loadW14Datasets (committed artifacts)", () => {
  it("loads the two W14 blind-overlap datasets with the documented sizes and disagreement counts", () => {
    const datasets = loadW14Datasets();
    expect(datasets).toHaveLength(2);
    const [ta, ownership] = datasets;
    expect(ta?.samples).toHaveLength(12);
    expect(ta?.samples.filter((sample) => !sample.correct)).toHaveLength(2);
    expect(ownership?.samples).toHaveLength(31);
    expect(ownership?.samples.filter((sample) => !sample.correct)).toHaveLength(3);
    for (const dataset of datasets) {
      expect(dataset.provenance).toContain("not gold");
      for (const sample of dataset.samples) {
        expect(sample.confidence).toBeGreaterThanOrEqual(0);
        expect(sample.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});
