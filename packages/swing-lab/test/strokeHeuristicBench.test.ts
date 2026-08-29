import { describe, expect, it } from "vitest";
import type { StrokePrediction } from "../src/strokeHeuristic.js";
import {
  goldL1Class,
  predictedL1Class,
  runStrokeHeuristicBench,
  scoreL1,
  scoreL2,
  STROKE_BENCH_POSE_CASES,
} from "../src/strokeHeuristicBench.js";
import type { StrokeGoldLabel } from "../src/strokeTaxonomyBench.js";

function gold(overrides: Partial<StrokeGoldLabel> = {}): StrokeGoldLabel {
  return {
    caseId: "wavea-marne-serve",
    eventStartMs: 1000,
    contactMs: 1200,
    eventEndMs: 1500,
    owner: "target",
    l1: "serve",
    l2: "forehand",
    l3: "unknown",
    reasoning: "fixture",
    annotatorId: "test",
    createdAtIso: "2026-08-29T00:00:00Z",
    ...overrides,
  };
}

function prediction(overrides: Partial<StrokePrediction> = {}): StrokePrediction {
  return {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "test",
    label: "FOREHAND",
    leaf: null,
    taxonomyDepth: 2,
    confidence: 0.8,
    evidence: [],
    limitingFactors: [],
    ...overrides,
  };
}

describe("bench L1 scoring (OVERHEAD vs SWING)", () => {
  it("maps gold families: overhead_lob → OVERHEAD, others → SWING, unknown → null", () => {
    expect(goldL1Class("overhead_lob")).toBe("OVERHEAD");
    expect(goldL1Class("volley")).toBe("SWING");
    expect(goldL1Class("serve")).toBe("SWING");
    expect(goldL1Class("unknown")).toBeNull();
  });

  it("UNKNOWN prediction is ABSTAINED, never wrong", () => {
    expect(predictedL1Class(prediction({ label: "UNKNOWN" }))).toBe("ABSTAINED");
    expect(scoreL1(gold(), prediction({ label: "UNKNOWN" }))).toBe("abstained");
  });

  it("gold-unknown L1 is never scored as correct or wrong", () => {
    expect(scoreL1(gold({ l1: "unknown" }), prediction())).toBe("gold_unknown");
  });

  it("side claim vs overhead gold is wrong; OVERHEAD claim vs overhead gold is correct", () => {
    expect(scoreL1(gold({ l1: "overhead_lob" }), prediction({ label: "FOREHAND" }))).toBe("wrong");
    expect(
      scoreL1(gold({ l1: "overhead_lob" }), prediction({ label: "OVERHEAD", taxonomyDepth: 1 })),
    ).toBe("correct");
  });
});

describe("bench L2 scoring (side / overhead / unknown handling)", () => {
  it("scores forehand/backhand sides against side gold", () => {
    expect(scoreL2(gold({ l2: "forehand" }), prediction({ label: "FOREHAND" }))).toBe("correct");
    expect(scoreL2(gold({ l2: "backhand" }), prediction({ label: "FOREHAND" }))).toBe("wrong");
    expect(scoreL2(gold({ l2: "two_hand_backhand" }), prediction({ label: "BACKHAND" }))).toBe(
      "correct",
    );
  });

  it("gold unknown / not_applicable stay first-class outcomes", () => {
    expect(scoreL2(gold({ l2: "unknown" }), prediction())).toBe("gold_unknown");
    expect(scoreL2(gold({ l2: "not_applicable" }), prediction())).toBe("not_applicable");
  });

  it("abstention propagates; OVERHEAD claim vs a side gold is abstained (no side claimed)", () => {
    expect(scoreL2(gold({ l2: "forehand" }), prediction({ label: "UNKNOWN" }))).toBe("abstained");
    expect(scoreL2(gold({ l2: "forehand" }), prediction({ label: "OVERHEAD" }))).toBe("abstained");
  });

  it("overhead gold L2 asks exactly 'did it claim OVERHEAD'", () => {
    expect(scoreL2(gold({ l2: "overhead" }), prediction({ label: "OVERHEAD" }))).toBe("correct");
    expect(scoreL2(gold({ l2: "overhead" }), prediction({ label: "FOREHAND" }))).toBe("wrong");
  });
});

describe("bench execution on committed data", () => {
  it("never evaluates held-out cases and reports unevaluable labels explicitly", () => {
    expect(STROKE_BENCH_POSE_CASES["wm-dink-01"]).toBeUndefined();
    expect(STROKE_BENCH_POSE_CASES["afn-vic-rally1"]).toBeUndefined();
    const report = runStrokeHeuristicBench();
    for (const row of report.rows) {
      expect(row.caseId).not.toBe("wm-dink-01");
      expect(row.caseId).not.toBe("afn-vic-rally1");
    }
    const accounted =
      report.evaluableLabels +
      Object.values(report.unevaluableCases).reduce((sum, count) => sum + count, 0);
    expect(accounted).toBe(report.goldLabelsTotal);
  });

  it("slice counts add up to the overall counts", () => {
    const report = runStrokeHeuristicBench();
    const groupN = Object.values(report.byGroup).reduce((sum, slice) => sum + slice.n, 0);
    const ownerN = Object.values(report.byOwner).reduce((sum, slice) => sum + slice.n, 0);
    expect(groupN).toBe(report.overall.n);
    expect(ownerN).toBe(report.overall.n);
  });

  it("confidently-wrong only counts committed (non-UNKNOWN) predictions", () => {
    const report = runStrokeHeuristicBench();
    const committedWrong = report.rows.filter(
      (row) => row.predictedLabel !== "UNKNOWN" && (row.l1 === "wrong" || row.l2 === "wrong"),
    ).length;
    expect(report.overall.confidentlyWrong).toBe(committedWrong);
  });
});
