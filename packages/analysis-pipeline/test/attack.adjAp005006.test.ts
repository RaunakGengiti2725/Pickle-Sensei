import { describe, expect, it } from "vitest";
import { fail, failure, ok } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type StrokeIdentity, type StrokePrediction } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import type { IStrokeClassifier } from "@pickle/vision-contracts";
import {
  analyzeCapture,
  type CaptureAnalysisInput,
  type FusionProviders,
  type HierarchicalStrokePrediction,
  type IHierarchicalStrokeClassifier,
} from "../src/index.js";

/**
 * Adversarial probes against the ADJ-AP-005 / ADJ-AP-006 fix (60ef4716).
 * Each case is a VARIANT of the adjudicated repro: a different classifier
 * (flat vs hierarchical), a different non-finite value, a different failure
 * kind, or a different throw shape. Expectations encode the invariants the
 * fix claims ("below-floor claims nothing", "a classifier failure on a
 * declared-null run is never laundered into fusion.stroke_unresolved").
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const HIER_DESCRIPTOR = {
  providerId: "classifier.hier-attack",
  modelVersion: "hier-attack-1",
  runtime: "coreml" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
};

const FLAT_DESCRIPTOR = {
  providerId: "classifier.flat-attack",
  modelVersion: "flat-attack-1",
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
    captureId: "capture-attack-1",
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
  analysisId: `attack-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-test",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `attack-run-${++counter}`,
});

const AUTO = { declared: null, predicted: null } as const satisfies StrokeIdentity;

const leaf = (confidence: number): HierarchicalStrokePrediction => ({
  taxonomyVersion: "pickleball-stroke-taxonomy-v3",
  classifierVersion: "stroke-heuristic-1 (uncalibrated)",
  label: "FOREHAND_DRIVE",
  leaf: "FOREHAND_DRIVE",
  taxonomyDepth: 3,
  confidence,
  evidence: ["stub evidence"],
  limitingFactors: [],
});

const side = (confidence: number): HierarchicalStrokePrediction => ({
  ...leaf(confidence),
  label: "FOREHAND",
  leaf: null,
  taxonomyDepth: 2,
});

const flat = (confidence: number): StrokePrediction => ({
  shotType: "forehand_drive",
  confidence,
  alternatives: [],
  producedBy: TRIGGER_MODEL,
});

const hier = (prediction: HierarchicalStrokePrediction): IHierarchicalStrokeClassifier => ({
  descriptor: HIER_DESCRIPTOR,
  classify: async () => ok(prediction),
});

const flatClassifier = (prediction: StrokePrediction): IStrokeClassifier => ({
  descriptor: FLAT_DESCRIPTOR,
  classify: async () => ok(prediction),
});

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe("ATTACK ADJ-AP-005 variants: every non-finite confidence, every route", () => {
  it.each(NON_FINITE)(
    "hierarchical LEAF with confidence %p abstains in analyzeCapture",
    async (c) => {
      const result = await analyzeCapture(
        providers({ autoStrokeClassifier: hier(leaf(c)) }),
        captureInput(AUTO),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.strokeResolution.kind).toBe("unresolved");
      expect(result.value.strokeIntent.resolutionBasis).toBe("abstained");
      expect(result.value.result).toBeNull();
    },
  );

  it.each(NON_FINITE)(
    "hierarchical SIDE with confidence %p abstains in analyzeCapture",
    async (c) => {
      const result = await analyzeCapture(
        providers({ autoStrokeClassifier: hier(side(c)) }),
        captureInput(AUTO),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.strokeResolution.kind).toBe("unresolved");
      expect(result.value.strokeIntent.resolutionBasis).toBe("abstained");
      // The side route would otherwise emit an EvidenceRef carrying the
      // non-finite confidence.
      expect(result.value.evidence).toEqual([]);
    },
  );

  it.each(NON_FINITE)(
    "hierarchical prediction with confidence %p claims no disagreement on a DECLARED run",
    async (c) => {
      const result = await analyzeCapture(
        providers({ autoStrokeClassifier: hier(leaf(c)) }),
        captureInput({ declared: "backhand_drive", predicted: null }),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.strokeIntent.disagreement).toBeNull();
      expect(result.value.strokeResolution).toEqual({
        kind: "declared",
        shotType: "backhand_drive",
      });
    },
  );

  it.each(NON_FINITE)(
    "FLAT classifier with confidence %p never yields a predicted resolution with non-finite confidence",
    async (c) => {
      const result = await analyzeCapture(
        providers({ classifier: flatClassifier(flat(c)) }),
        captureInput(AUTO),
        options(),
      );
      if (result.ok) {
        // If the flat route resolves at all, its recorded confidence must be finite.
        const resolution = result.value.strokeResolution;
        if (resolution.kind === "predicted") {
          expect(Number.isFinite(resolution.confidence)).toBe(true);
        }
      } else {
        expect(result.failure.code).toBe("fusion.stroke_unresolved");
      }
    },
  );

  it.each(NON_FINITE)(
    "FLAT classifier with confidence %p neither claims disagreement NOR overrides the declaration on a DECLARED run",
    async (c) => {
      const result = await analyzeCapture(
        providers({ classifier: flatClassifier(flat(c)) }),
        captureInput({ declared: "backhand_drive", predicted: null }),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.strokeIntent.disagreement).toBeNull();
      // A non-finite confidence "claims nothing" for disagreement purposes;
      // the same prediction must not be allowed to win the stroke resolution.
      expect(result.value.strokeResolution).toEqual({
        kind: "declared",
        shotType: "backhand_drive",
      });
    },
  );
});

describe("ATTACK ADJ-AP-006 variants: classifier failure on a declared-null run", () => {
  const crashingHier: IHierarchicalStrokeClassifier = {
    descriptor: HIER_DESCRIPTOR,
    classify: async () => {
      throw new Error("coreml_model_load_failed");
    },
  };

  it("hierarchical classifier rejecting with a non-Error value still surfaces as provider_crash", async () => {
    const weird: IHierarchicalStrokeClassifier = {
      descriptor: HIER_DESCRIPTOR,
      classify: async () => Promise.reject("plain-string-rejection"),
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: weird }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
    expect(result.failure.message).toBe("plain-string-rejection");
  });

  it("hierarchical classifier TIMEOUT failure keeps its retryable kind", async () => {
    const timingOut: IHierarchicalStrokeClassifier = {
      descriptor: HIER_DESCRIPTOR,
      classify: async () =>
        fail(failure("timeout", "stroke_classification.timeout", "classifier exceeded 2000ms")),
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: timingOut }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("timeout");
    expect(result.failure.code).toBe("stroke_classification.timeout");
    expect(result.failure.retryable).toBe(true);
  });

  it("hierarchical classifier typed low_confidence failure surfaces with its own code", async () => {
    const abstaining: IHierarchicalStrokeClassifier = {
      descriptor: HIER_DESCRIPTOR,
      classify: async () =>
        fail(failure("low_confidence", "stroke_classification.too_few_frames", "only 3 frames")),
    };
    const result = await analyzeCapture(
      providers({ autoStrokeClassifier: abstaining }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("stroke_classification.too_few_frames");
  });

  it("FLAT classifier crash on a declared-null run (no hierarchical classifier) is NOT laundered into fusion.stroke_unresolved", async () => {
    const crashingFlat: IStrokeClassifier = {
      descriptor: FLAT_DESCRIPTOR,
      classify: async () => {
        throw new Error("flat_model_load_failed");
      },
    };
    const result = await analyzeCapture(
      providers({ classifier: crashingFlat }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
    expect(result.failure.message).toBe("flat_model_load_failed");
  });

  it("both classifiers crash on a declared-null run: a provider_crash surfaces", async () => {
    const crashingFlat: IStrokeClassifier = {
      descriptor: FLAT_DESCRIPTOR,
      classify: async () => {
        throw new Error("flat_model_load_failed");
      },
    };
    const result = await analyzeCapture(
      providers({ classifier: crashingFlat, autoStrokeClassifier: crashingHier }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
  });

  it("hierarchical crash + confident FLAT prediction: the flat route still scores and the crash is recorded", async () => {
    const result = await analyzeCapture(
      providers({ classifier: flatClassifier(flat(0.95)), autoStrokeClassifier: crashingHier }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeResolution).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: 0.95,
    });
    const crashed = result.value.modelRuns.find(
      (run) => run.model.providerId === HIER_DESCRIPTOR.providerId,
    );
    expect(crashed?.status).toBe("failed");
  });

  it("hierarchical crash + BELOW-threshold FLAT prediction on a declared-null run surfaces the crash", async () => {
    const result = await analyzeCapture(
      providers({ classifier: flatClassifier(flat(0.3)), autoStrokeClassifier: crashingHier }),
      captureInput(AUTO),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stroke_classification.provider_crash");
  });

  it("no classifier at all on a declared-null run keeps the honest generic unresolved failure", async () => {
    const result = await analyzeCapture(providers(), captureInput(AUTO), options());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("fusion.stroke_unresolved");
  });

  it("is deterministic under concurrency: 25 parallel AUTO runs with a crashing classifier all surface the crash", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        analyzeCapture(
          providers({ autoStrokeClassifier: crashingHier }),
          captureInput(AUTO),
          options(),
        ),
      ),
    );
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe("stroke_classification.provider_crash");
    }
  });
});
