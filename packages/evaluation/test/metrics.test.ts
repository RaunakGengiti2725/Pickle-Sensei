import { describe, expect, it } from "vitest";
import {
  calibrationReport,
  classificationReport,
  meanAbsoluteError,
  pearsonCorrelation,
  regressionViolations,
  spearmanCorrelation,
  timingReport,
  type BenchmarkReport,
} from "../src/index.js";

describe("classification metrics", () => {
  it("computes accuracy, per-class precision/recall/F1, and macro F1", () => {
    const report = classificationReport([
      { truth: "serve", predicted: "serve" },
      { truth: "serve", predicted: "dink" },
      { truth: "dink", predicted: "dink" },
      { truth: "dink", predicted: "dink" },
    ]);
    expect(report.accuracy).toBeCloseTo(3 / 4);
    const serve = report.perClass.find((entry) => entry.label === "serve")!;
    expect(serve.precision).toBeCloseTo(1);
    expect(serve.recall).toBeCloseTo(0.5);
    expect(serve.f1).toBeCloseTo(2 / 3);
    const dink = report.perClass.find((entry) => entry.label === "dink")!;
    expect(dink.precision).toBeCloseTo(2 / 3);
    expect(dink.recall).toBeCloseTo(1);
    expect(report.macroF1).toBeCloseTo((2 / 3 + 0.8) / 2);
    expect(report.confusion["serve"]!["dink"]).toBe(1);
  });

  it("handles empty input and never-predicted classes without dividing by zero", () => {
    expect(classificationReport([]).caseCount).toBe(0);
    const report = classificationReport([{ truth: "volley", predicted: "dink" }]);
    const volley = report.perClass.find((entry) => entry.label === "volley")!;
    expect(volley.precision).toBeNull();
    expect(volley.recall).toBe(0);
  });
});

describe("timing metrics", () => {
  it("reports mean/median absolute boundary error and tolerance fraction", () => {
    const report = timingReport([
      { truthMs: 1000, predictedMs: 1010 },
      { truthMs: 500, predictedMs: 470 },
      { truthMs: 200, predictedMs: 200 },
    ]);
    expect(report.meanAbsoluteErrorMs).toBeCloseTo((10 + 30 + 0) / 3);
    expect(report.medianAbsoluteErrorMs).toBe(10);
    expect(report.withinTolerance(10)).toBeCloseTo(2 / 3);
  });
});

describe("score agreement metrics", () => {
  it("computes MAE, Pearson, and tie-aware Spearman", () => {
    const pairs = [
      { truth: 1, predicted: 2 },
      { truth: 2, predicted: 3 },
      { truth: 3, predicted: 5 },
      { truth: 4, predicted: 6 },
    ];
    expect(meanAbsoluteError(pairs)).toBeCloseTo(1.5);
    expect(pearsonCorrelation(pairs)!).toBeGreaterThan(0.98);
    expect(spearmanCorrelation(pairs)!).toBeCloseTo(1);

    const anti = [
      { truth: 1, predicted: 9 },
      { truth: 2, predicted: 5 },
      { truth: 3, predicted: 1 },
    ];
    expect(spearmanCorrelation(anti)!).toBeCloseTo(-1);
    expect(pearsonCorrelation([{ truth: 1, predicted: 1 }])).toBeNull();
  });
});

describe("calibration metrics", () => {
  it("computes ECE of 0 for perfectly calibrated bins and > 0 otherwise", () => {
    const calibrated = calibrationReport(
      [
        { confidence: 0.75, correct: true },
        { confidence: 0.75, correct: true },
        { confidence: 0.75, correct: true },
        { confidence: 0.75, correct: false },
      ],
      10,
    );
    expect(calibrated.expectedCalibrationError).toBeCloseTo(0);

    const overconfident = calibrationReport(
      [
        { confidence: 0.95, correct: false },
        { confidence: 0.95, correct: false },
      ],
      10,
    );
    expect(overconfident.expectedCalibrationError).toBeCloseTo(0.95);
  });

  // REGRESSION (D3-10): NaN confidence used to crash with an opaque TypeError
  // (bins[NaN] undefined); out-of-range flowed into the edge bins silently.
  it("rejects non-finite and out-of-range confidences with a clear error", () => {
    expect(() => calibrationReport([{ confidence: NaN, correct: true }])).toThrow(/finite/);
    expect(() => calibrationReport([{ confidence: 1.5, correct: true }])).toThrow(/\[0,1\]/);
  });

  // REGRESSION (D3-10): empty/tiny-n/degenerate ECE printed as a bare
  // confident number; the report must disclose n and warn.
  it("discloses n and warns on empty, tiny-n, and degenerate inputs", () => {
    const empty = calibrationReport([]);
    expect(empty.n).toBe(0);
    expect(empty.warnings.join(" ")).toMatch(/no samples/);
    const tiny = calibrationReport([{ confidence: 1, correct: false }]);
    expect(tiny.n).toBe(1);
    expect(tiny.warnings.join(" ")).toMatch(/insufficient n/);
    expect(tiny.warnings.join(" ")).toMatch(/degenerate/);
    const healthy = calibrationReport(
      Array.from({ length: 12 }, (_, i) => ({ confidence: i / 12, correct: i % 2 === 0 })),
    );
    expect(healthy.n).toBe(12);
    expect(healthy.warnings).toEqual([]);
  });
});

describe("regression gate", () => {
  const report = (metrics: Record<string, number | null>): BenchmarkReport => ({
    benchmark: {
      id: "b",
      version: "1",
      task: "phase_segmentation",
      provenance: "synthetic",
      caseCount: 1,
      notes: "",
    },
    evaluatedAtIso: "2026-08-27T00:00:00.000Z",
    subject: "phase.geometry@phase-geometry-1",
    metrics,
    abstainedCaseIds: [],
  });

  it("flags silent degradation and missing metrics", () => {
    const baseline = report({ contactWithin50ms: 0.95 });
    expect(
      regressionViolations(baseline, report({ contactWithin50ms: 0.99 }), ["contactWithin50ms"]),
    ).toEqual([]);
    expect(
      regressionViolations(baseline, report({ contactWithin50ms: 0.8 }), ["contactWithin50ms"]),
    ).toHaveLength(1);
    expect(regressionViolations(baseline, report({}), ["contactWithin50ms"])).toHaveLength(1);
  });
});
