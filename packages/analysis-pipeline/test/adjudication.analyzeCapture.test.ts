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
 * Adjudicated defects for the AUTO DETECT (declared-null) route.
 *
 * ADJ-AP-005 — a non-finite confidence must be treated as BELOW the floor at
 * every gate ("below-floor claims nothing"): profile resolution abstains, no
 * disagreement is claimed, and analyzeCapture never persists a predicted
 * resolution whose confidence is not a finite number.
 *
 * ADJ-AP-006 — when the AUTO classifier crashes on a declared-null run, the
 * failure must surface as the classifier's own permanent failure (or as a
 * durable record carrying the failed run) — never laundered into the generic
 * low_confidence "stroke unresolved" outcome that hides the crash.
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const HIER_DESCRIPTOR = {
  providerId: "classifier.hier-test",
  modelVersion: "hier-test-1",
  runtime: "coreml" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
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
    captureId: "capture-adj-1",
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

const leafPrediction = (confidence: number): HierarchicalStrokePrediction => ({
  taxonomyVersion: "pickleball-stroke-taxonomy-v3",
  classifierVersion: "stroke-heuristic-1 (uncalibrated)",
  label: "FOREHAND_DRIVE",
  leaf: "FOREHAND_DRIVE",
  taxonomyDepth: 3,
  confidence,
  evidence: ["stub evidence"],
  limitingFactors: [],
});

function stubClassifier(prediction: HierarchicalStrokePrediction): IHierarchicalStrokeClassifier {
  return { descriptor: HIER_DESCRIPTOR, classify: async () => ok(prediction) };
}

describe("ADJ-AP-005: non-finite confidence never clears the AUTO floor", () => {
  it("resolvePredictedProfile abstains on a NaN-confidence leaf", () => {
    expect(resolvePredictedProfile(leafPrediction(Number.NaN))).toEqual({
      kind: "abstain",
      reason: "auto_stroke_confidence_below_floor",
    });
  });

  it("detectHierarchicalDisagreement claims nothing from a NaN-confidence leaf", () => {
    expect(detectHierarchicalDisagreement("backhand_drive", leafPrediction(Number.NaN))).toBeNull();
  });

  it("analyzeCapture never persists a predicted resolution with non-finite confidence", async () => {
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: stubClassifier(leafPrediction(Number.NaN)) }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    expect(record.strokeResolution.kind).toBe("unresolved");
    expect(record.strokeIntent.resolutionBasis).toBe("abstained");
    expect(record.strokeIntent.resolvedProfileId).toBeNull();
    expect(record.result).toBeNull();
    expect(record.uncertainty.limitingFactors).toContain("auto_stroke_confidence_below_floor");
  });
});

describe("ADJ-AP-006: AUTO classifier crash on a declared-null run is not laundered", () => {
  it("surfaces the classifier's permanent provider_crash failure, keeping the original message", async () => {
    const crashing: IHierarchicalStrokeClassifier = {
      descriptor: HIER_DESCRIPTOR,
      classify: async () => {
        throw new Error("coreml_model_load_failed");
      },
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: crashing }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("permanent");
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
    expect(result.failure.message).toBe("coreml_model_load_failed");
    expect(result.failure.retryable).toBe(false);
  });
});
