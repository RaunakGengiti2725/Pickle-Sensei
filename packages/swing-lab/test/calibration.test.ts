import { describe, expect, it } from "vitest";
import {
  ECE_MIN_SAMPLES,
  areaUnderRiskCoverage,
  calibrationReport,
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

  // REGRESSION (D3-10 break B1): NaN confidence used to be SILENTLY DROPPED
  // from every bin while still counting in the ECE denominator, deflating ECE.
  it("non-finite confidence throws instead of silently vanishing (B1)", () => {
    expect(() => reliabilityBins(samples([[NaN, true]]))).toThrow(/finite/);
    expect(() => reliabilityBins(samples([[Infinity, true]]))).toThrow(/finite/);
    expect(() =>
      expectedCalibrationError(
        samples([
          [NaN, true],
          [0.9, false],
        ]),
      ),
    ).toThrow(/finite/);
  });
});

describe("expectedCalibrationError", () => {
  // REGRESSION (D3-10 break B2): ECE([]) used to return a confident 0
  // ("perfectly calibrated") for zero evidence. The raw primitive now throws;
  // guarded reporting goes through calibrationReport.
  it("throws on empty input instead of printing a confident 0 (B2)", () => {
    expect(() => expectedCalibrationError([], 10)).toThrow(/empty/);
  });

  it("is 0 for perfectly calibrated bins", () => {
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

describe("calibrationReport (guarded ECE)", () => {
  // REGRESSION (D3-10 break B2): tiny-n ECE used to print as a bare confident
  // number (e.g. n=1, conf 1.0, wrong → "ECE 1.0"). The report must carry n
  // and REFUSE below the floor rather than print.
  it("refuses below the sample floor and always reports n", () => {
    const refused = calibrationReport(samples([[1.0, false]]));
    expect(refused.n).toBe(1);
    expect(refused.ece).toBeNull();
    expect(refused.flagged).toBe(true);
    expect(refused.flags.join(" ")).toMatch(/insufficient n: 1 < floor/);
    const empty = calibrationReport([]);
    expect(empty.n).toBe(0);
    expect(empty.ece).toBeNull();
    expect(empty.flagged).toBe(true);
  });

  it("computes ECE at/above the floor and respects a custom floor", () => {
    const pairs: Array<[number, boolean]> = Array.from({ length: ECE_MIN_SAMPLES }, (_, i) => [
      0.05 + (0.9 * i) / (ECE_MIN_SAMPLES - 1),
      i % 2 === 0,
    ]);
    const report = calibrationReport(samples(pairs));
    expect(report.n).toBe(ECE_MIN_SAMPLES);
    expect(report.ece).not.toBeNull();
    const custom = calibrationReport(samples(pairs.slice(0, 4)), { minSamples: 3 });
    expect(custom.ece).not.toBeNull();
  });

  // REGRESSION (D3-10 break B4): degenerate distributions (all confidences
  // identical, e.g. all 1.0) produce a single-bin ECE that is not a
  // calibration curve; the report must flag this, not present it bare.
  it("flags all-equal / all-1.0 degenerate confidence distributions (B4)", () => {
    const allOne = calibrationReport(
      samples(Array.from({ length: 12 }, (_, i) => [1.0, i % 2 === 0] as [number, boolean])),
    );
    expect(allOne.ece).toBeCloseTo(0.5);
    expect(allOne.flagged).toBe(true);
    expect(allOne.flags.join(" ")).toMatch(/degenerate/);
    const spread = calibrationReport(
      samples(Array.from({ length: 12 }, (_, i) => [i / 12, i % 2 === 0] as [number, boolean])),
    );
    expect(spread.flagged).toBe(false);
  });

  it("throws on non-finite confidence even below the floor", () => {
    expect(() => calibrationReport(samples([[NaN, true]]))).toThrow(/finite/);
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

  // REGRESSION (D3-10 break B3): NaN confidence used to flow straight through
  // (no validation) producing a threshold:NaN point and NaN-poisoned AURC that
  // was silently written into reports.
  it("non-finite confidence throws instead of emitting NaN thresholds (B3)", () => {
    const poisoned = samples([
      [NaN, false],
      [0.5, true],
    ]);
    expect(() => coverageRiskCurve(poisoned)).toThrow(/finite/);
    expect(() => areaUnderRiskCoverage(poisoned)).toThrow(/finite/);
  });

  // REGRESSION (D3-10 probe): zero-abstention shape — all samples share one
  // confidence, so the curve is a single answer-everything point and AURC is
  // exactly that point's risk (verified NOT broken; pinned so it stays true).
  it("zero-abstention curve is one full-coverage point; AURC equals its risk", () => {
    const zeroAbstention = samples([
      [0.7, true],
      [0.7, false],
      [0.7, true],
      [0.7, true],
    ]);
    const curve = coverageRiskCurve(zeroAbstention);
    expect(curve).toEqual([
      { threshold: 0.7, coverage: 1, risk: 0.25, nAnswered: 4, nWrongAnswered: 1 },
    ]);
    expect(areaUnderRiskCoverage(zeroAbstention)).toBeCloseTo(0.25);
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
