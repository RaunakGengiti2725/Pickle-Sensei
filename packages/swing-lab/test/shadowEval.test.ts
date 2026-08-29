import { describe, expect, it } from "vitest";
import {
  buildGoldBenchInputs,
  buildSyntheticInputs,
  compareAxes,
  defaultShadowPair,
  runShadowEval,
  SHADOW_AXES,
  summarizeLatency,
  type ShadowInputRow,
} from "../src/shadowEval.js";
import { classifyStroke } from "../src/strokeHeuristic.js";
import type { StrokePrediction } from "../src/strokeHeuristic.js";

const HELD_OUT = ["wm-dink-01", "afn-vic-rally1"];

function prediction(overrides: Partial<StrokePrediction> = {}): StrokePrediction {
  return {
    taxonomyVersion: "stroke-taxonomy-v3",
    classifierVersion: "test",
    label: "FOREHAND",
    leaf: null,
    taxonomyDepth: 2,
    confidence: 0.7,
    evidence: [],
    limitingFactors: [],
    contactPointSource: "wrist",
    contactPointReliability: "strong",
    ...overrides,
  };
}

describe("shadow eval axis comparison (pure)", () => {
  it("marks stroke disagreement when labels differ", () => {
    const axes = compareAxes(
      prediction({ label: "FOREHAND" }),
      prediction({ label: "UNKNOWN", taxonomyDepth: 1 }),
      { sharedTrackId: "1", paddleProvided: false },
    );
    expect(axes.stroke.status).toBe("disagree");
    expect(axes.stroke.incumbent).toBe("FOREHAND@depth2");
    expect(axes.stroke.candidate).toBe("UNKNOWN@depth1");
  });

  it("marks contact disagreement on differing source/reliability", () => {
    const axes = compareAxes(
      prediction({ contactPointSource: "wrist", contactPointReliability: "strong" }),
      prediction({ contactPointSource: "wrist", contactPointReliability: "degraded" }),
      { sharedTrackId: "1", paddleProvided: false },
    );
    expect(axes.contact.status).toBe("disagree");
  });

  it("marks event disagreement when only one side claims the event-peak reference", () => {
    const axes = compareAxes(
      prediction({ limitingFactors: ["reference_is_event_peak_not_contact"] }),
      prediction({ limitingFactors: [] }),
      { sharedTrackId: "1", paddleProvided: false },
    );
    expect(axes.event.status).toBe("disagree");
    expect(axes.event.incumbent).toBe("event_peak");
    expect(axes.event.candidate).toBe("contact");
  });

  it("paddle and ball axes are honestly not_evaluable without a paddle/ball track", () => {
    const axes = compareAxes(prediction(), prediction(), {
      sharedTrackId: "1",
      paddleProvided: false,
    });
    expect(axes.paddle.status).toBe("not_evaluable");
    expect(axes.ball.status).toBe("not_evaluable");
    expect(axes.paddle.note).toContain("paddle=null");
  });

  it("target axis is not_evaluable for synthetic single-skeleton rows", () => {
    const axes = compareAxes(prediction(), prediction(), {
      sharedTrackId: null,
      paddleProvided: false,
    });
    expect(axes.target.status).toBe("not_evaluable");
  });
});

describe("latency summary (pure)", () => {
  it("computes counts and order statistics", () => {
    const summary = summarizeLatency([3, 1, 2, 10]);
    expect(summary.samples).toBe(4);
    expect(summary.maxMs).toBe(10);
    expect(summary.p50Ms).toBe(3);
    expect(summary.meanMs).toBe(4);
  });

  it("is all-zero for zero samples (never fabricates)", () => {
    expect(summarizeLatency([])).toEqual({
      samples: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    });
  });
});

describe("shadow eval over the committed corpus", () => {
  const report = runShadowEval();

  it("evaluates gold-bench rows plus the synthetic adversarial fixtures", () => {
    expect(report.evaluableGoldRows).toBeGreaterThan(0);
    expect(report.syntheticFixtureRows).toBe(12);
    expect(report.rows.length).toBe(report.evaluableGoldRows + report.syntheticFixtureRows);
  });

  it("names distinct incumbent/candidate versions and roles", () => {
    expect(report.incumbent.role).toBe("primary");
    expect(report.candidate.role).toBe("shadow");
    expect(report.incumbent.classifierVersion).not.toBe(report.candidate.classifierVersion);
    expect(report.candidate.classifierVersion).toContain("stroke-heuristic-5");
  });

  it("scores every axis on every row", () => {
    for (const row of report.rows) {
      for (const axis of SHADOW_AXES) {
        expect(["agree", "disagree", "not_evaluable"]).toContain(row.axes[axis].status);
      }
    }
  });

  it("axis tallies partition the row count", () => {
    for (const axis of SHADOW_AXES) {
      const tally = report.disagreementByAxis[axis];
      expect(tally.agree + tally.disagree + tally.notEvaluable).toBe(report.rows.length);
    }
  });

  it("paddle and ball axes are not_evaluable on every row of this corpus", () => {
    expect(report.disagreementByAxis.paddle.notEvaluable).toBe(report.rows.length);
    expect(report.disagreementByAxis.ball.notEvaluable).toBe(report.rows.length);
  });

  it("coverage + abstention partition rows per side", () => {
    for (const side of [report.coverage.incumbent, report.coverage.candidate]) {
      expect(side.rows).toBe(report.rows.length);
      expect(side.committed + side.abstained).toBe(side.rows);
    }
  });

  it("records a non-negative latency sample per row per side", () => {
    expect(report.latency.incumbent.samples).toBe(report.rows.length);
    expect(report.latency.candidate.samples).toBe(report.rows.length);
    for (const row of report.rows) {
      expect(row.incumbentLatencyMs).toBeGreaterThanOrEqual(0);
      expect(row.candidateLatencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(report.latency.disclosure).toContain("NOT a physical-device measurement");
  });

  it("stroke disagreements list matches the per-row axis verdicts", () => {
    const disagreeing = report.rows.filter((row) => row.axes.stroke.status === "disagree");
    expect(report.strokeDisagreements.length).toBe(disagreeing.length);
  });

  it("never touches the held-out cases", () => {
    for (const row of report.rows) {
      expect(HELD_OUT).not.toContain(row.caseId);
    }
    for (const heldOut of HELD_OUT) {
      expect(Object.keys(report.unevaluableCases)).not.toContain(heldOut);
    }
  });

  it("never promotes", () => {
    expect(report.promotion.decision).toBe("NOT_PROMOTED");
  });

  it("SHADOW NON-INTERFERENCE: primary output equals an incumbent-only run over the same corpus", () => {
    const gold = buildGoldBenchInputs();
    const synthetic = buildSyntheticInputs();
    const inputRows: ShadowInputRow[] = [...gold.rows, ...synthetic];
    expect(inputRows.length).toBe(report.rows.length);
    const pair = defaultShadowPair();
    inputRows.forEach((inputRow, index) => {
      const primaryOnly = classifyStroke(inputRow.input);
      const shadowRow = report.rows[index]!;
      expect(shadowRow.caseId).toBe(inputRow.caseId);
      // The shadow run's primary-side committed label/depth and limiting
      // factors are identical to running the incumbent alone.
      expect(shadowRow.axes.stroke.incumbent).toBe(
        `${primaryOnly.label}@depth${primaryOnly.taxonomyDepth}`,
      );
      expect(shadowRow.incumbentCommitted).toBe(primaryOnly.label !== "UNKNOWN");
      expect(shadowRow.incumbentLimitingFactors).toEqual(primaryOnly.limitingFactors);
      // And the incumbent-only run agrees with the injected pair's incumbent.
      const pairPrediction = pair.incumbent.classify(inputRow.input);
      expect(pairPrediction).toEqual(primaryOnly);
    });
  });
});
