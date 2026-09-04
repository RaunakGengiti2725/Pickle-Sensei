import { describe, expect, it } from "vitest";
import { ok } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type StrokeIdentity } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import {
  analyzeCapture,
  detectHierarchicalDisagreement,
  resolvePredictedProfile,
  type CaptureAnalysisInput,
  type FusionProviders,
  type HierarchicalStrokePrediction,
  type IHierarchicalStrokeClassifier,
} from "../src/index.js";

/**
 * ADJUDICATION REPRO (area pkg-analysis-pipeline, baseline 4d812e1a).
 * Each `it` asserts the EXPECTED behaviour; a failure at the baseline is the
 * reproduction. Real geometry/scoring providers; only the hierarchical
 * classifier is a stub (no validated on-device model exists on Linux).
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function providers(overrides: Partial<FusionProviders> = {}): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
    ...overrides,
  };
}

function captureInput(stroke: StrokeIdentity): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence();
  return {
    captureId: "adj-capture",
    pose: sequence,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.9,
      producedBy: TRIGGER_MODEL,
    },
    stroke,
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

let counter = 0;
const options = () => ({
  analysisId: `adj-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-test",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `adj-run-${++counter}`,
});

const DESCRIPTOR = {
  providerId: "classifier.hier-adj",
  modelVersion: "hier-adj-1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
};

function prediction(
  overrides: Partial<HierarchicalStrokePrediction>,
): HierarchicalStrokePrediction {
  return {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "stroke-heuristic-1 (uncalibrated)",
    label: "FOREHAND_DRIVE",
    taxonomyDepth: 3,
    leaf: "FOREHAND_DRIVE",
    confidence: 0.9,
    evidence: ["stub evidence"],
    limitingFactors: [],
    ...overrides,
  } as HierarchicalStrokePrediction;
}

describe("ADJ-AP-005 AUTO confidence floor must reject non-finite confidence", () => {
  it("resolvePredictedProfile abstains on confidence NaN", () => {
    const resolved = resolvePredictedProfile(prediction({ confidence: Number.NaN }));
    console.log("ADJ-AP-005 resolvePredictedProfile(NaN):", JSON.stringify(resolved));
    expect(resolved.kind).toBe("abstain");
  });

  it("detectHierarchicalDisagreement claims nothing on confidence NaN", () => {
    const disagreement = detectHierarchicalDisagreement(
      "backhand_drive",
      prediction({ confidence: Number.NaN }),
    );
    console.log("ADJ-AP-005 disagreement(NaN):", JSON.stringify(disagreement));
    expect(disagreement).toBeNull();
  });

  it("analyzeCapture never records a predicted resolution with non-finite confidence", async () => {
    const classifier: IHierarchicalStrokeClassifier = {
      descriptor: DESCRIPTOR,
      classify: async () => ok(prediction({ confidence: Number.NaN })),
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: classifier }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolution = result.value.strokeResolution;
    console.log("ADJ-AP-005 strokeResolution:", JSON.stringify(resolution));
    if (resolution.kind === "predicted") {
      expect(Number.isFinite(resolution.confidence)).toBe(true);
    }
  });
});

describe("ADJ-AP-006 AUTO classifier crash must not be laundered into 'stroke_unresolved'", () => {
  it("a rejecting hierarchical classifier on a declared-null run surfaces the provider crash", async () => {
    const classifier: IHierarchicalStrokeClassifier = {
      descriptor: DESCRIPTOR,
      classify: async () => {
        throw new Error("coreml_model_load_failed");
      },
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: classifier }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    console.log(
      "ADJ-AP-006 result:",
      result.ok ? "ok" : JSON.stringify({ code: result.failure.code, kind: result.failure.kind }),
    );
    if (result.ok) {
      // Acceptable alternative: a durable partial record carrying the failed run.
      expect(result.value.modelRuns.some((run) => run.status === "failed")).toBe(true);
      return;
    }
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
    expect(result.failure.message).toContain("coreml_model_load_failed");
  });
});
