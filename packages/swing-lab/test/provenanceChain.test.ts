import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { ContactEstimate } from "@pickle/vision-geometry";
import { checkProvenanceChain } from "../src/provenanceChain.js";
import { runCorpusCheck } from "../src/corpusCheck.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import type { BallStageReportEntry, PaddleReportEntry } from "../src/report.js";
import type { StrokePrediction } from "../src/strokeHeuristic.js";
import type { TrackedPaddleObservation } from "../src/paddleTracker.js";

/**
 * provenance-chain-1 — every user-visible Result claim must trace back to
 * OBSERVED / TRACKED / PREDICTED provenance; no PREDICTED value may surface
 * as an observation anywhere in the chain.
 *
 * The COMPLETE fixture below is typed against the real pipeline types
 * (ContactEstimate, PaddleReportEntry, BallStageReportEntry,
 * StrokePrediction, TrackedPaddleObservation), so the type layer and the
 * runtime checker are verified against the same shapes.
 */

const observedContact: ContactEstimate = {
  status: "estimated",
  estimatedContactMs: 4180,
  confidence: 0.72,
  ballConfirmed: true,
  paddleConfirmed: true,
  limitingFactors: [],
  supportingEvidence: [
    {
      signal: "ball_direction_change",
      timestampMs: 4175,
      weight: 1.0,
      detail: "direction reversal 168°",
    },
    {
      signal: "paddle_speed_peak",
      timestampMs: 4190,
      weight: 0.6,
      detail: "paddle peak 3.1 u/s over 30 samples",
    },
  ],
};

const trackedPaddle: PaddleReportEntry = {
  status: "tracked",
  trackId: 3,
  observationCount: 41,
  windowCoverage: 0.58,
  meanDetectorScore: 0.44,
  meanWristDistance: 0.05,
  candidateTracks: 9,
  detector: "dfine-medium-coco@transformers",
  inferenceMsPerFrame: 68,
  confidenceModel: "paddle-track-2",
};

const trackedBall: BallStageReportEntry = {
  status: "tracked",
  trackId: 12,
  observationCount: 18,
  windowOverlapMs: 420,
  medianSpeed: 1.4,
  minPaddleDistance: 0.02,
  gatedTracks: 6,
  ablation: {
    durationSec: 4.2,
    stageA_rawCandidatesPerSec: 40,
    stageB_tracks: 4,
    stageB_trackedObsPerSec: 12,
    stageC_tracks: 2,
    stageC_trackedObsPerSec: 8,
    stageC_coherenceRejected: 0,
  },
  confidenceModel: "ball-track-2",
  timeline: {
    states: ["visible", "occluded_by_body", "visible"],
    reacquisition: "honest",
    bridgePointCount: 2,
  },
};

const prediction: StrokePrediction = {
  label: "FOREHAND",
  confidence: 0.55,
  taxonomyDepth: 1,
  evidence: ["dominant-wrist rightward path", "contact ahead of torso plane"],
  limitingFactors: [],
} as unknown as StrokePrediction;

const bridgeObservation: TrackedPaddleObservation = {
  timestampMs: 4200,
  box: { x: 0.4, y: 0.5, width: 0.05, height: 0.05 },
  center: { x: 0.425, y: 0.525 },
  detectorScore: 0,
  trackId: 3,
  confidence: 0.2,
  nearWrist: false,
  source: "tracked_estimate",
} as unknown as TrackedPaddleObservation;

const completeArtifact = {
  video: "fixture.mp4",
  stroke: "forehand_drive",
  contact: observedContact,
  paddle: trackedPaddle,
  ballStage: trackedBall,
  strokePrediction: prediction,
  observations: [bridgeObservation],
  resultRows: [
    {
      key: "stroke_window",
      label: "Stroke window",
      value: "3900ms – 4400ms",
      provenance: "DETECTED",
    },
    {
      key: "contact_estimate",
      label: "Contact estimate",
      value: "4180ms · ball + paddle",
      provenance: "ESTIMATE",
    },
    {
      key: "phase_timeline",
      label: "Swing phases",
      value: "4 measured from paddle motion",
      provenance: "MEASURED",
    },
    {
      key: "predicted_stroke",
      label: "Classifier read",
      value: "Forehand (family)",
      provenance: "PREDICTED",
    },
  ],
};

const clone = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe("provenance chain — complete artifact set", () => {
  it("a fully-traceable artifact set has zero violations", () => {
    expect(checkProvenanceChain(clone(completeArtifact))).toEqual([]);
  });
});

describe("provenance chain — contact estimate tracing", () => {
  it("flags an estimate with no traceable supporting evidence", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.contact as Record<string, unknown>).supportingEvidence = [];
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_contact_estimate_without_evidence");
  });

  it("flags zero-weight / non-finite evidence as untraceable", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.contact as Record<string, unknown>).supportingEvidence = [
      { signal: "wrist_speed_peak", timestampMs: Number.NaN, weight: 0, detail: "" },
    ];
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_contact_estimate_without_evidence");
  });

  it("flags ballConfirmed without a ball signal", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.contact as Record<string, unknown>).supportingEvidence = [
      { signal: "paddle_speed_peak", timestampMs: 4190, weight: 0.6, detail: "" },
    ];
    const violations = checkProvenanceChain(artifact);
    expect(
      violations.some(
        (violation) =>
          violation.rule === "chain_confirmation_without_signal" &&
          violation.path.endsWith("ballConfirmed"),
      ),
    ).toBe(true);
  });

  it("flags paddleConfirmed without a paddle signal", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.contact as Record<string, unknown>).supportingEvidence = [
      { signal: "ball_direction_change", timestampMs: 4175, weight: 1.0, detail: "" },
    ];
    const violations = checkProvenanceChain(artifact);
    expect(
      violations.some(
        (violation) =>
          violation.rule === "chain_confirmation_without_signal" &&
          violation.path.endsWith("paddleConfirmed"),
      ),
    ).toBe(true);
  });

  it("flags an unregistered evidence signal family", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.contact as Record<string, unknown>).supportingEvidence as unknown[]).push({
      signal: "vibes",
      timestampMs: 4180,
      weight: 0.9,
      detail: "",
    });
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_unregistered_evidence_signal");
  });

  it("does not treat an experiment digest echo (no evidence fields) as a chain source", () => {
    const violations = checkProvenanceChain({
      contact: { status: "estimated", estimatedContactMs: 6650, errMs: 30 },
    });
    expect(violations).toEqual([]);
  });

  it("flags an abstention that still carries an estimate", () => {
    const violations = checkProvenanceChain({
      contact: { status: "abstained", reason: "signals disagree", estimatedContactMs: 4100 },
    });
    expect(violations.map((violation) => violation.rule)).toContain(
      "chain_abstention_with_estimate",
    );
  });
});

describe("provenance chain — tracked claims", () => {
  it("flags a tracked stage with zero observations", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.paddle as Record<string, unknown>).observationCount = 0;
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_tracked_without_observations");
  });

  it("flags bridge points without real anchors to interpolate between", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    const ball = artifact.ballStage as Record<string, unknown>;
    ball.observationCount = 1;
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_bridge_without_anchors");
  });

  it("flags a negative bridge point count", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (
      (artifact.ballStage as Record<string, unknown>).timeline as Record<string, unknown>
    ).bridgePointCount = -1;
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_bridge_without_anchors");
  });
});

describe("provenance chain — PREDICTED never surfaces as observation", () => {
  it("flags a tracked_estimate bridge point carrying a positive detector score", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.observations as unknown[])[0] as Record<string, unknown>).detectorScore = 0.7;
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_predicted_as_observation");
  });

  it("flags a tracked_estimate bridge point claiming nearWrist", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.observations as unknown[])[0] as Record<string, unknown>).nearWrist = true;
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_predicted_as_observation");
  });

  it("flags a committed prediction with no evidence trail", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    (artifact.strokePrediction as Record<string, unknown>).evidence = [];
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_prediction_without_evidence");
  });

  it("accepts an honest abstention (null label needs no evidence)", () => {
    const violations = checkProvenanceChain({
      strokePrediction: { label: null, confidence: 0, taxonomyDepth: 0, evidence: [] },
    });
    expect(violations).toEqual([]);
  });

  it("flags a predicted_stroke row surfacing under an observation chip", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.resultRows as unknown[])[3] as Record<string, unknown>).provenance = "MEASURED";
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_predicted_row_masquerade");
  });

  it("flags a contact_estimate row presented as DETECTED", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.resultRows as unknown[])[1] as Record<string, unknown>).provenance = "DETECTED";
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_predicted_row_masquerade");
  });

  it("flags an unregistered provenance chip", () => {
    const artifact = clone(completeArtifact) as Record<string, unknown>;
    ((artifact.resultRows as unknown[])[0] as Record<string, unknown>).provenance = "OBSERVED_ISH";
    const rules = checkProvenanceChain(artifact).map((violation) => violation.rule);
    expect(rules).toContain("chain_unknown_row_provenance");
  });
});

describe("provenance chain — corpus integration (C15)", () => {
  // 120s: on a Mac with the regenerated canonical run dirs present (gitignored,
  // absent on Linux CI) the scan covers ~1257 files and takes ~55s — same
  // no-assertion-change timeout raise as the h17 ffmpeg tests.
  it(
    "runCorpusCheck reports chain violations as an additional invariant class",
    () => {
      const report = runCorpusCheck(join(REPO_ROOT, "datasets"));
      expect(report.filesChecked).toBeGreaterThan(0);
      expect(report.parseFailures).toEqual([]);
      // Committed-artifact violations are FINDINGS, reported here and in the
      // wave-d4 summary — never silently fixed. This assertion pins the
      // current measured state of the corpus.
      const chainViolations = report.violations.filter((violation) =>
        violation.rule.startsWith("chain_"),
      );
      expect(chainViolations).toEqual([]);
    },
    120_000,
  );
});
