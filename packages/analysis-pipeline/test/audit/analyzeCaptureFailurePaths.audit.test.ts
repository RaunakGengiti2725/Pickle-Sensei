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
import type {
  IBiomechanicsExtractor,
  ICoachingRanker,
  IFaultDetector,
  IPhaseSegmenter,
  ITechniqueScorer,
  ProviderDescriptor,
} from "@pickle/vision-contracts";
import {
  analyzeCapture,
  type CaptureAnalysisInput,
  type FusionProviders,
  type IHierarchicalStrokeClassifier,
} from "../../src/index.js";

/**
 * EXECUTION AUDIT HARNESS (pkg-analysis-pipeline, pass 2). New file only —
 * exercises partial-failure / empty / crash paths of analyzeCapture that the
 * shipped suite does not pin. Assertions state the behaviour the code
 * documents; a failing assertion here is an audit finding, not a request to
 * change the assertion.
 */

const descriptor = (providerId: string): ProviderDescriptor => ({
  providerId,
  modelVersion: `${providerId}-0`,
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
});

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
    captureId: "audit-capture",
    pose: sequence,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.9,
      producedBy: {
        providerId: "trigger.temporal-heuristic",
        modelVersion: "temporal-stroke-heuristic-2",
        runtime: "deterministic",
        executionTarget: "on_device",
        artifactHash: null,
      },
    },
    stroke,
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

let counter = 0;
const options = () => ({
  analysisId: `audit-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-audit",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `audit-run-${++counter}`,
});

const crashingAutoClassifier: IHierarchicalStrokeClassifier = {
  descriptor: descriptor("classifier.hier-crash"),
  classify: async () => {
    throw new Error("native classifier bridge died");
  },
};

const failingAutoClassifier: IHierarchicalStrokeClassifier = {
  descriptor: descriptor("classifier.hier-fail"),
  classify: async () =>
    fail(failure("permanent", "classifier.model_load_failed", "corrupt classifier artifact")),
};

describe("AUDIT analyzeCapture — AUTO DETECT classifier failure paths", () => {
  it("AUTO + classifier CRASH: the returned failure names the crash, not a generic 'no prediction exists'", async () => {
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: crashingAutoClassifier }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The classifier DID run and crashed; analyzeCapture wraps that into a
    // 'stroke_classification.provider_crash' model-run failure internally.
    // The caller must be able to see that root cause.
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
  });

  it("AUTO + classifier typed FAILURE: the typed failure is propagated, not replaced", async () => {
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: failingAutoClassifier }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("classifier.model_load_failed");
  });

  it("AUTO + classifier reports NaN confidence with a committed leaf: must abstain, never score", async () => {
    const nanClassifier: IHierarchicalStrokeClassifier = {
      descriptor: descriptor("classifier.hier-nan"),
      classify: async () =>
        ok({
          taxonomyVersion: "pickleball-stroke-taxonomy-v3",
          classifierVersion: "audit-nan",
          label: "FOREHAND_DRIVE",
          leaf: "FOREHAND_DRIVE",
          taxonomyDepth: 3 as const,
          confidence: Number.NaN,
          evidence: [],
          limitingFactors: [],
        }),
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: nanClassifier }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A non-finite confidence is not a commitment the gate can evaluate.
    expect(result.value.result).toBeNull();
    expect(result.value.strokeIntent.resolutionBasis).toBe("abstained");
  });
});

describe("AUDIT analyzeCapture — required-stage crashes abort with the stage's crash code", () => {
  it("phase segmenter throws → phase_segmentation.provider_crash", async () => {
    const phase: IPhaseSegmenter = {
      modelVersion: "phase.crash-0",
      source: "fixture",
      segmentPhases: async () => {
        throw new Error("segmenter blew up");
      },
    };
    const result = await analyzeCapture(providers({ phase }), captureInput(), options());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("phase_segmentation.provider_crash");
  });

  it("biomechanics extractor throws → biomechanics_extraction.provider_crash", async () => {
    const biomechanics: IBiomechanicsExtractor = {
      descriptor: descriptor("biomech.crash"),
      extract: async () => {
        throw new Error("extractor blew up");
      },
    };
    const result = await analyzeCapture(providers({ biomechanics }), captureInput(), options());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("biomechanics_extraction.provider_crash");
  });

  it("empty pose sequence → fusion.empty_pose_sequence (low_confidence), no provider runs", async () => {
    const input = captureInput();
    const emptied: CaptureAnalysisInput = { ...input, pose: { ...input.pose, frames: [] } };
    const result = await analyzeCapture(providers(), emptied, options());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("fusion.empty_pose_sequence");
    expect(result.failure.kind).toBe("low_confidence");
  });
});

describe("AUDIT analyzeCapture — optional-stage crashes degrade, and the degradation must be visible", () => {
  it("fault detector throws → record is ok, faults:[] and the failed run is recorded", async () => {
    const faultDetector: IFaultDetector = {
      descriptor: descriptor("faults.crash"),
      detectFaults: async () => {
        throw new Error("fault detector blew up");
      },
    };
    const result = await analyzeCapture(providers({ faultDetector }), captureInput(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    expect(record.result?.resultKind).toBe("scored");
    expect(record.faults).toEqual([]);
    const faultRun = record.modelRuns.find((run) => run.task === "fault_detection");
    expect(faultRun?.status).toBe("failed");
    expect(faultRun?.failure?.code).toBe("fault_detection.provider_crash");
    // Observation (not asserted): the only trace of the missing faults is
    // the modelRuns entry — uncertainty.limitingFactors does not mention it,
    // so a consumer reading faults:[] cannot distinguish "clean swing" from
    // "detector failed" without scanning modelRuns.
    expect(record.uncertainty.limitingFactors).not.toContain("fault_detection_unavailable");
  });

  it("coach throws → record is ok, priorityFix:null and the failed run is recorded", async () => {
    const coach: ICoachingRanker = {
      descriptor: descriptor("coach.crash"),
      rank: async () => {
        throw new Error("coach blew up");
      },
    };
    const result = await analyzeCapture(providers({ coach }), captureInput(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result?.priorityFix).toBeNull();
    const coachRun = result.value.modelRuns.find((run) => run.task === "coaching_ranking");
    expect(coachRun?.status).toBe("failed");
    expect(coachRun?.failure?.code).toBe("coaching_ranking.provider_crash");
  });

  it("shadow scorer throws → user-facing result unchanged, shadow entry null-scored with failed run", async () => {
    const shadow: ITechniqueScorer = {
      descriptor: descriptor("scorer.shadow-crash"),
      score: async () => {
        throw new Error("shadow blew up");
      },
    };
    const input = captureInput();
    const withShadow = await analyzeCapture(
      providers({ shadowScorers: [shadow] }),
      input,
      options(),
    );
    const without = await analyzeCapture(providers(), input, options());
    expect(withShadow.ok && without.ok).toBe(true);
    if (!withShadow.ok || !without.ok) return;
    expect(withShadow.value.result?.overallScore).toBe(without.value.result?.overallScore);
    expect(withShadow.value.shadow).toHaveLength(1);
    expect(withShadow.value.shadow[0]!.overallScore).toBeNull();
    expect(withShadow.value.shadow[0]!.run.status).toBe("failed");
    expect(withShadow.value.shadow[0]!.run.model.providerId).toBe("scorer.shadow-crash");
  });
});

describe("AUDIT analyzeCapture — non-finite measurements must not become a numeric score", () => {
  it("a NaN measurement value from the extractor yields an abstention or null score, never NaN", async () => {
    const real = new GeometryBiomechanicsExtractor();
    const poisoned: IBiomechanicsExtractor = {
      descriptor: descriptor("biomech.nan"),
      extract: async (input) => {
        const measured = await real.extract(input);
        if (!measured.ok) return measured;
        return ok(
          measured.value.map((m, index) => (index === 0 ? { ...m, value: Number.NaN } : m)),
        );
      },
    };
    const result = await analyzeCapture(
      providers({ biomechanics: poisoned }),
      captureInput(),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const score = result.value.result?.overallScore ?? null;
    expect(score === null || Number.isFinite(score)).toBe(true);
    for (const checkpoint of result.value.result?.checkpoints ?? []) {
      expect(checkpoint.score === null || Number.isFinite(checkpoint.score)).toBe(true);
    }
    // The persisted record must survive a JSON round trip unchanged
    // (NaN → null silently rewrites a "scored" record on disk).
    const roundTripped = JSON.parse(JSON.stringify(result.value));
    expect(roundTripped).toEqual(result.value);
  });
});
