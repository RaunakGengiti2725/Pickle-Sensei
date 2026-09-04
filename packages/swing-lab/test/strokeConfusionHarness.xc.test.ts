import { describe, expect, it } from "vitest";
import {
  buildConfusionRows,
  buildReport,
  contractMetricsFromRows,
  matrixTotal,
  perClassScores,
  predictedBenchL1,
  predictedFamily,
  predictedSide,
  primaryAbstainReason,
  ratio,
  type ConfusionMatrix,
} from "../src/strokeConfusionHarness.js";
import type { StrokePrediction } from "../src/strokeHeuristic.js";

/**
 * xc-cv-classification-confusion — pins for the confusion harness.
 *
 * Two layers: pure scoring semantics on synthetic matrices (abstention ≠
 * error, gold-unknown ≠ false positive, empty denominators → null), and
 * corpus-level invariants of the real replay (every gold label is either a
 * row or an explicit unevaluable entry; the harness reproduces the
 * regression contract's stroke_heuristic metrics exactly; the committed
 * baseline is compared, never assumed).
 */

function prediction(partial: Partial<StrokePrediction>): StrokePrediction {
  return {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "test",
    label: "UNKNOWN",
    leaf: "UNKNOWN",
    taxonomyDepth: 1,
    confidence: 0.2,
    evidence: [],
    limitingFactors: [],
    ...partial,
  };
}

describe("prediction → class mappings stay conservative", () => {
  it("depth-2 FOREHAND is a SWING at bench-L1, a side at L2, and ABSTAINED for the v2 family", () => {
    const forehand = prediction({
      label: "FOREHAND",
      leaf: null,
      taxonomyDepth: 2,
      confidence: 0.8,
    });
    expect(predictedBenchL1(forehand)).toBe("SWING");
    expect(predictedSide(forehand)).toBe("FOREHAND");
    expect(predictedFamily(forehand)).toBe("ABSTAINED");
  });

  it("OVERHEAD maps to overhead_lob at the family level and OVERHEAD at the side level", () => {
    const overhead = prediction({
      label: "OVERHEAD",
      leaf: "OVERHEAD",
      taxonomyDepth: 3,
      confidence: 0.85,
    });
    expect(predictedBenchL1(overhead)).toBe("OVERHEAD");
    expect(predictedSide(overhead)).toBe("OVERHEAD");
    expect(predictedFamily(overhead)).toBe("overhead_lob");
  });

  it("UNKNOWN abstains everywhere and a missing prediction is pose_unavailable, never a class", () => {
    const unknown = prediction({ limitingFactors: ["no_swing_energy_in_window"] });
    expect(predictedBenchL1(unknown)).toBe("ABSTAINED");
    expect(predictedSide(unknown)).toBe("ABSTAINED");
    expect(predictedFamily(unknown)).toBe("ABSTAINED");
    expect(predictedBenchL1(null)).toBe("pose_unavailable");
    expect(predictedSide(null)).toBe("pose_unavailable");
    expect(predictedFamily(null)).toBe("pose_unavailable");
  });

  it("primary abstain reason is the LAST recognised abstention factor; committed labels have none", () => {
    expect(
      primaryAbstainReason(
        prediction({
          limitingFactors: ["paddle_not_tracked_at_contact", "no_swing_energy_in_window"],
        }),
      ),
    ).toBe("no_swing_energy_in_window");
    expect(
      primaryAbstainReason(prediction({ limitingFactors: ["paddle_not_tracked_at_contact"] })),
    ).toBe("unreasoned_abstain");
    expect(
      primaryAbstainReason(prediction({ label: "FOREHAND", limitingFactors: ["x"] })),
    ).toBeNull();
  });
});

describe("per-class precision/recall semantics", () => {
  const matrix: ConfusionMatrix = {
    forehand: { FOREHAND: 3, BACKHAND: 1, ABSTAINED: 4 },
    backhand: { FOREHAND: 2, ABSTAINED: 5, pose_unavailable: 1 },
    unknown: { FOREHAND: 2, ABSTAINED: 6 },
  };
  const classes = [
    { gold: "forehand", predicted: "FOREHAND" },
    { gold: "backhand", predicted: "BACKHAND" },
  ];
  const [forehand, backhand] = perClassScores(matrix, classes, "unknown");

  it("gold-unknown rows never count as false positives and abstentions never count as wrong", () => {
    expect(forehand).toMatchObject({
      tp: 3,
      fpVsKnownGold: 2,
      predictedGoldUnknown: 2,
      fnWrongClass: 1,
      fnAbstained: 4,
      fnPoseUnavailable: 0,
      goldSupport: 8,
      predictedSupport: 7,
    });
    expect(forehand!.precisionKnownGold).toEqual(ratio(3, 5));
    expect(forehand!.recallAll).toEqual(ratio(3, 8));
    expect(forehand!.recallCommitted).toEqual(ratio(3, 4));
  });

  it("an empty denominator is null, not zero", () => {
    expect(backhand).toMatchObject({
      tp: 0,
      fpVsKnownGold: 1,
      fnWrongClass: 2,
      fnAbstained: 5,
      fnPoseUnavailable: 1,
    });
    expect(backhand!.precisionKnownGold).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(backhand!.recallAll).toEqual({ numerator: 0, denominator: 8, value: 0 });
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it("matrix total is the row count", () => {
    expect(matrixTotal(matrix)).toBe(24);
  });
});

describe("gold-corpus replay (linux_replay_proxy)", () => {
  const report = buildReport();

  it("accounts for every gold label exactly once — as a row or an explicit unevaluable entry", () => {
    expect(report.rows.length + report.unevaluable.length).toBe(report.goldLabelsTotal);
    expect(report.goldLabelsTotal).toBe(29);
    expect(report.rows.length).toBe(18);
    for (const item of report.unevaluable)
      expect(item.reason).toBe("case_not_in_committed_pose_set");
    const ids = new Set([...report.rows, ...report.unevaluable].map((entry) => entry.rowId));
    expect(ids.size).toBe(report.goldLabelsTotal);
  });

  it("never includes the held-out cases", () => {
    for (const entry of [...report.rows, ...report.unevaluable]) {
      expect(entry.caseId).not.toBe("wm-dink-01");
      expect(entry.caseId).not.toBe("afn-vic-rally1");
    }
  });

  it("reproduces the regression contract's stroke_heuristic metrics from its own rows", () => {
    expect(report.harnessMatchesLiveBench).toBe(true);
    expect(contractMetricsFromRows(report.rows, report.goldLabelsTotal)).toEqual(
      report.liveBenchMetrics,
    );
  });

  it("matches the committed baseline on every stroke_heuristic metric", () => {
    expect(report.baselineComparison).not.toBeNull();
    const changed = report.baselineComparison!.metrics.filter((entry) => !entry.equal);
    expect(changed).toEqual([]);
  });

  it("every matrix sums to the evaluable row count", () => {
    for (const matrix of [
      report.matrices.benchL1,
      report.matrices.family,
      report.matrices.side,
      report.matrices.raw,
      report.matrices.taxonomyBench.l1,
      report.matrices.taxonomyBench.l2,
      report.matrices.taxonomyBench.l3,
    ]) {
      expect(matrixTotal(matrix)).toBe(report.rows.length);
    }
  });

  it("never claims an exact technique (L3) from pose alone", () => {
    for (const row of report.rows)
      expect(row.prediction?.taxonomyDepth ?? 0).toBeLessThanOrEqual(2);
    for (const goldRow of Object.values(report.matrices.taxonomyBench.l3)) {
      expect(Object.keys(goldRow)).toEqual(["ABSTAINED"]);
    }
  });

  it("gold-unknown rows are never scored wrong and every abstention carries a recognised reason", () => {
    for (const row of report.rows) {
      if (row.gold.l1 === "unknown") expect(row.benchL1).toBe("gold_unknown");
      if (row.gold.l2 === "unknown") expect(row.benchL2).toBe("gold_unknown");
      if (row.predictedLabel === "UNKNOWN") {
        expect(row.primaryAbstainReason).not.toBeNull();
        expect(row.primaryAbstainReason).not.toBe("unreasoned_abstain");
      } else {
        expect(row.primaryAbstainReason).toBeNull();
      }
    }
    expect(report.abstention.total).toBe(
      report.rows.filter((row) => row.predictedLabel === "UNKNOWN").length,
    );
  });

  it("the single confidently-wrong row is the wheelchair backhand read as FOREHAND with a wide margin", () => {
    const wrong = report.rows.filter((row) => row.benchL1 === "wrong" || row.benchL2 === "wrong");
    expect(wrong.map((row) => row.rowId)).toEqual(["wavea-wgm-wheelchair@182400/target"]);
    expect(wrong[0]).toMatchObject({
      predictedLabel: "FOREHAND",
      benchL1: "correct",
      benchL2: "wrong",
    });
    expect(wrong[0]!.sideMargin).toBeGreaterThan(1);
    expect(report.ambiguity.byKind.committed_wrong_side).toBe(1);
  });

  it("is deterministic across two independent builds", () => {
    const again = buildConfusionRows();
    expect(
      again.rows.map((row) => [
        row.rowId,
        row.predictedLabel,
        row.confidence,
        row.primaryAbstainReason,
      ]),
    ).toEqual(
      report.rows.map((row) => [
        row.rowId,
        row.predictedLabel,
        row.confidence,
        row.primaryAbstainReason,
      ]),
    );
  });
});
