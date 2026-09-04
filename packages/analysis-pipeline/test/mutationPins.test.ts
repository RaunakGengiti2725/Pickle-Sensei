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
import type { IBiomechanicsExtractor } from "@pickle/vision-contracts";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import {
  analyzeCapture,
  PREDICTION_CONFIDENCE_THRESHOLD,
  type CaptureAnalysisInput,
  type FusionProviders,
} from "../src/index.js";

/**
 * Mutation pins for @pickle/analysis-pipeline (tools/mutation-pipeline-scoring).
 *
 * Each test below kills a specific dropped-abstention mutant that SURVIVED the
 * existing @pickle/analysis-pipeline suite AND the regression bench
 * (bench:compare exit 0):
 *   AC-01  analyzeCapture labels the record "scored" even when the scorer abstained
 *   AC-04  PREDICTION_CONFIDENCE_THRESHOLD lowered from 0.8 to 0 (any flat
 *          prediction is accepted — and outranks the user's declared stroke)
 * Replay: `node tools/mutation-pipeline-scoring/run.mjs --only AC-01,AC-04 --with-pins`.
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const FLAT_CLASSIFIER_MODEL = {
  providerId: "classifier.flat-test",
  modelVersion: "flat-test-1",
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
    captureId: "capture-mutation-pin",
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
  analysisId: `pin-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-test",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `pin-run-${++counter}`,
});

/**
 * The real geometry extractor, with every measurement's confidence scaled
 * down to a barely-observed read. The real sm-v1 scorer then abstains on its
 * own (analysis confidence far below minAnalysisConfidence) — this is the
 * honest "paddle never visible / pose barely tracked" path, not a stub scorer.
 */
function barelyObservedBiomechanics(): IBiomechanicsExtractor {
  const real = new GeometryBiomechanicsExtractor();
  return {
    descriptor: real.descriptor,
    extract: async (input) => {
      const measured = await real.extract(input);
      if (!measured.ok) return measured;
      return ok(
        measured.value.map((measurement) => ({
          ...measurement,
          confidence: measurement.confidence * 0.05,
        })),
      );
    },
  };
}

describe("analyzeCapture mutation pins", () => {
  it("AC-01: a scorer abstention is surfaced as low_confidence, never as a scored result", async () => {
    const result = await analyzeCapture(
      providers({ biomechanics: barelyObservedBiomechanics() }),
      captureInput({ declared: "forehand_drive", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    // Precondition: the scorer genuinely abstained on this input.
    expect(record.uncertainty.presentation).toBe("abstain");
    expect(record.result).not.toBeNull();
    if (record.result === null) return;
    expect(record.result.overallScore).toBeNull();
    expect(record.result.checkpoints.every((checkpoint) => checkpoint.score === null)).toBe(true);
    expect(record.result.priorityFix).toBeNull();
    expect(record.result.guidance).not.toBeNull();

    // The user-facing verdict must agree with the scorer: a record with no
    // score is a low_confidence result, not a "scored" one. (A "scored"
    // resultKind is what spends a free rating and enters progress/rank.)
    expect(record.result.resultKind).toBe("low_confidence");
  });

  it("AC-01 control: a normally-scored run is labelled scored", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({ declared: "forehand_drive", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.uncertainty.presentation).not.toBe("abstain");
    expect(result.value.result?.resultKind).toBe("scored");
    expect(result.value.result?.overallScore).not.toBeNull();
  });

  it("AC-04: the flat-prediction acceptance floor is 0.8 and is exported unchanged", () => {
    expect(PREDICTION_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it("AC-04: a flat prediction below the floor never outranks the user's declared stroke", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({
        declared: "backhand_drive",
        predicted: {
          shotType: "forehand_drive",
          confidence: 0.3,
          alternatives: [],
          producedBy: FLAT_CLASSIFIER_MODEL,
        },
      }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    expect(record.strokeResolution).toEqual({ kind: "declared", shotType: "backhand_drive" });
    expect(record.strokeIntent.resolutionBasis).toBe("declared");
    expect(record.result?.shotType).toBe("backhand_drive");
    expect(record.result?.versionVector.shotConfigVersion).toBe("backhand_drive@1");
  });

  it("AC-04: with nothing declared, a flat prediction below the floor is a typed unresolved failure", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({
        declared: null,
        predicted: {
          shotType: "forehand_drive",
          confidence: 0.3,
          alternatives: [],
          producedBy: FLAT_CLASSIFIER_MODEL,
        },
      }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("fusion.stroke_unresolved");
  });

  it("AC-04 control: a flat prediction at the floor is accepted", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({
        declared: null,
        predicted: {
          shotType: "forehand_drive",
          confidence: PREDICTION_CONFIDENCE_THRESHOLD,
          alternatives: [],
          producedBy: FLAT_CLASSIFIER_MODEL,
        },
      }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeResolution).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: PREDICTION_CONFIDENCE_THRESHOLD,
    });
    expect(result.value.result?.resultKind).toBe("scored");
  });
});
