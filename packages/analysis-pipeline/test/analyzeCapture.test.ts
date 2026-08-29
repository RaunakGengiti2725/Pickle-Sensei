import { describe, expect, it } from "vitest";
import { fail, failure, ok } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type StrokeIdentity } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import type { ITechniqueScorer } from "@pickle/vision-contracts";
import {
  analyzeCapture,
  FUSION_ENGINE_VERSION,
  type CaptureAnalysisInput,
  type FusionProviders,
} from "../src/index.js";

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

function captureInput(
  stroke: StrokeIdentity = { declared: "forehand_drive", predicted: null },
): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence();
  return {
    captureId: "capture-123",
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
  analysisId: `analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-test",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `run-${++counter}`,
});

describe("analyzeCapture fusion engine", () => {
  it("produces a fully versioned, provenance-complete record from pose alone", async () => {
    const result = await analyzeCapture(providers(), captureInput(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    expect(record.engineVersion).toBe(FUSION_ENGINE_VERSION);
    expect(record.captureId).toBe("capture-123");
    expect(record.strokeResolution).toEqual({ kind: "declared", shotType: "forehand_drive" });
    // Missing modalities are recorded, not fabricated.
    expect(record.modalities).toEqual({
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    });
    expect(record.uncertainty.limitingFactors).toContain("paddle_track_unavailable");
    expect(record.uncertainty.limitingFactors).toContain("ball_track_unavailable");
    // Every stage left a model run with provenance.
    const tasks = record.modelRuns.map((run) => run.task);
    expect(tasks).toEqual(
      expect.arrayContaining([
        "phase_segmentation",
        "biomechanics_extraction",
        "technique_scoring",
        "fault_detection",
        "uncertainty_estimation",
        "coaching_ranking",
      ]),
    );
    expect(record.result?.resultKind).toBe("scored");
    expect(record.result?.overallScore).not.toBeNull();
    expect(record.result?.versionVector.scoringModelVersion).toBe("sm-v1");
    expect(record.result?.versionVector.paddleModelVersion).toBe("paddle-none-0");
    // Evidence ties checkpoint claims to phase windows and measured metrics.
    expect(record.evidence.length).toBeGreaterThan(0);
    const contact = record.evidence.find((e) => e.claim === "checkpoint:contact_position");
    expect(contact?.window).not.toBeNull();
    expect(contact?.metricKeys).toContain("contact_forward_of_hip_norm");
  });

  it("refuses to analyze when the stroke is honestly unresolved", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("fusion.stroke_unresolved");
  });

  it("supports reprocessing: same capture, two engines' records, capture untouched", async () => {
    const input = captureInput();
    const first = await analyzeCapture(providers(), input, options());

    const renamedScorer = new Sm1TechniqueScorer();
    Object.defineProperty(renamedScorer, "descriptor", {
      value: {
        ...new Sm1TechniqueScorer().descriptor,
        providerId: "scorer.sm-v2",
        modelVersion: "sm-v2",
      },
    });
    const second = await analyzeCapture(providers({ scorer: renamedScorer }), input, options());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.id).not.toBe(second.value.id);
    expect(first.value.captureId).toBe(second.value.captureId);
    expect(first.value.result?.versionVector.scoringModelVersion).toBe("sm-v1");
    expect(second.value.result?.versionVector.scoringModelVersion).toBe("sm-v2");
    // Same measurements, different scorer identity: provider replacement
    // without touching capture, storage, or the temporal stack.
    expect(second.value.result?.measurements).toEqual(first.value.result?.measurements);
  });

  it("runs shadow scorers without changing the user-facing result", async () => {
    const shadow = new Sm1TechniqueScorer();
    Object.defineProperty(shadow, "descriptor", {
      value: {
        ...new Sm1TechniqueScorer().descriptor,
        providerId: "scorer.candidate",
        modelVersion: "sm-v2rc1",
      },
    });
    const withShadow = await analyzeCapture(
      providers({ shadowScorers: [shadow] }),
      captureInput(),
      options(),
    );
    const withoutShadow = await analyzeCapture(providers(), captureInput(), options());
    expect(withShadow.ok && withoutShadow.ok).toBe(true);
    if (!withShadow.ok || !withoutShadow.ok) return;
    expect(withShadow.value.result?.overallScore).toBe(withoutShadow.value.result?.overallScore);
    expect(withShadow.value.shadow).toHaveLength(1);
    expect(withShadow.value.shadow[0]!.run.model.providerId).toBe("scorer.candidate");
    expect(withShadow.value.shadow[0]!.overallScore).not.toBeNull();
  });

  it("propagates provider failure as a typed failure with a recorded run", async () => {
    const brokenScorer: ITechniqueScorer = {
      descriptor: {
        providerId: "scorer.broken",
        modelVersion: "0",
        runtime: "coreml",
        executionTarget: "on_device",
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      score: async () =>
        fail(failure("permanent", "scoring.model_load_failed", "corrupt artifact")),
    };
    const result = await analyzeCapture(
      providers({ scorer: brokenScorer }),
      captureInput(),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("scoring.model_load_failed");
  });

  it("treats a crashing provider as failure, never as silent success", async () => {
    const crashing: ITechniqueScorer = {
      descriptor: {
        providerId: "scorer.crashy",
        modelVersion: "0",
        runtime: "onnx",
        executionTarget: "server",
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      score: async () => {
        throw new Error("segfault-adjacent");
      },
    };
    const result = await analyzeCapture(providers({ scorer: crashing }), captureInput(), options());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("technique_scoring.provider_crash");
  });

  it("a confident classifier prediction overrides the declaration (recorded as predicted)", async () => {
    const classifier = {
      descriptor: {
        providerId: "classifier.test",
        modelVersion: "clf-test-1",
        runtime: "deterministic" as const,
        executionTarget: "on_device" as const,
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      classify: async () =>
        ok({
          shotType: "forehand_drive" as const,
          confidence: 0.95,
          alternatives: [],
          producedBy: {
            providerId: "classifier.test",
            modelVersion: "clf-test-1",
            runtime: "deterministic" as const,
            executionTarget: "on_device" as const,
            artifactHash: null,
          },
        }),
    };
    const result = await analyzeCapture(
      providers({ classifier }),
      captureInput({ declared: "dink", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeResolution).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: 0.95,
    });
  });

  it("is deterministic for identical inputs and options", async () => {
    const input = captureInput();
    const fixed = {
      analysisId: "analysis-fixed",
      sessionId: null,
      appVersion: "0.1.0",
      modelBundleVersion: "fusion-test",
      nowIso: () => "2026-08-27T18:30:00.000Z",
      makeId: (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    };
    const again = {
      ...fixed,
      makeId: (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    };
    const first = await analyzeCapture(providers(), input, fixed);
    const second = await analyzeCapture(providers(), input, again);
    expect(second).toEqual(first);
  });
});
