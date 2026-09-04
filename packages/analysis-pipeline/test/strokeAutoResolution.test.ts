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
  detectFlatDisagreement,
  detectHierarchicalDisagreement,
  resolvePredictedProfile,
  resolveSlugProfileId,
  type CaptureAnalysisInput,
  type FusionProviders,
  type HierarchicalStrokePrediction,
  type IHierarchicalStrokeClassifier,
} from "../src/index.js";

/**
 * D-031 follow-up: AUTO DETECT (declaredStroke=null) routed end-to-end.
 * Hard rules verified here: no fabricated classification, declared/predicted
 * separate everywhere, registry-terminated profile resolution, conservative
 * documented abstention gate, declared path unchanged.
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

function captureInput(
  stroke: StrokeIdentity,
  declaredCanonical?: string | null,
): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence();
  return {
    captureId: "capture-auto-1",
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
    ...(declaredCanonical !== undefined ? { declaredCanonical } : {}),
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

let counter = 0;
const options = () => ({
  analysisId: `auto-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-test",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `auto-run-${++counter}`,
});

/** Stub hierarchical classifier returning a fixed prediction (recorded as prediction). */
function autoClassifier(
  prediction: Partial<HierarchicalStrokePrediction> & {
    label: string;
    taxonomyDepth: 1 | 2 | 3;
  },
): IHierarchicalStrokeClassifier {
  return {
    descriptor: {
      providerId: "classifier.hier-test",
      modelVersion: "hier-test-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
    },
    classify: async () =>
      ok({
        taxonomyVersion: "pickleball-stroke-taxonomy-v3",
        classifierVersion: "stroke-heuristic-1 (uncalibrated)",
        leaf: null,
        confidence: 0.6,
        evidence: ["stub evidence"],
        limitingFactors: ["bounce_not_observed_level3_uncommitted"],
        ...prediction,
      }),
  };
}

describe("AUTO DETECT: declared-null routing", () => {
  it("depth-2 FOREHAND prediction scores with the shared side profile — no leaf invented", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    expect(record.strokeIntent.declaredStroke).toBeNull();
    expect(record.strokeIntent.predictedStroke?.label).toBe("FOREHAND");
    expect(record.strokeIntent.resolutionBasis).toBe("predicted_family");
    expect(record.strokeIntent.resolvedProfileId).toBe("SHARED_FOREHAND_SWING");
    expect(record.strokeIntent.disagreement).toBeNull();
    // The side's representative swing target set scores the run: the user
    // gets a real technique score while provenance stays family-level.
    expect(record.result).not.toBeNull();
    expect(record.result?.shotType).toBe("forehand_drive");
    expect(record.strokeResolution).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: 0.6,
    });
    // The classification itself is recorded provenance.
    expect(
      record.modelRuns.some(
        (run) =>
          run.task === "stroke_classification" && run.model.providerId === "classifier.hier-test",
      ),
    ).toBe(true);
    // The full slug-conditioned chain ran and recorded checkpoint evidence.
    expect(record.evidence.length).toBeGreaterThan(0);
  });

  it("UNKNOWN prediction produces a typed abstention — no stroke is invented", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "UNKNOWN",
          leaf: "UNKNOWN",
          taxonomyDepth: 1,
          confidence: 0.2,
          limitingFactors: ["torso_not_measured_at_contact"],
        }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    expect(record.strokeIntent.resolutionBasis).toBe("abstained");
    expect(record.strokeIntent.resolvedProfileId).toBeNull();
    expect(record.strokeIntent.declaredStroke).toBeNull();
    expect(record.strokeIntent.predictedStroke?.label).toBe("UNKNOWN");
    expect(record.result).toBeNull();
    expect(record.strokeResolution.kind).toBe("unresolved");
    expect(record.uncertainty.presentation).toBe("abstain");
    expect(record.uncertainty.limitingFactors).toContain("auto_stroke_prediction_unknown");
    expect(record.uncertainty.limitingFactors).toContain("torso_not_measured_at_contact");
  });

  it("a committed side below the confidence floor abstains (backstop for future providers)", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "FOREHAND",
          taxonomyDepth: 2,
          confidence: 0.3,
        }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeIntent.resolutionBasis).toBe("abstained");
    expect(result.value.strokeIntent.resolvedProfileId).toBeNull();
    expect(result.value.result).toBeNull();
    expect(result.value.uncertainty.limitingFactors).toContain(
      "auto_stroke_confidence_below_floor",
    );
  });

  it("a committed leaf routes the full chain from the PREDICTED stroke (predicted_l3)", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "FOREHAND_DRIVE",
          leaf: "FOREHAND_DRIVE",
          taxonomyDepth: 3,
          confidence: 0.75,
        }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    expect(record.strokeIntent.resolutionBasis).toBe("predicted_l3");
    expect(record.strokeIntent.resolvedProfileId).toBe("FOREHAND_DRIVE");
    expect(record.strokeIntent.declaredStroke).toBeNull();
    expect(record.strokeResolution).toEqual({
      kind: "predicted",
      shotType: "forehand_drive",
      confidence: 0.75,
    });
    // The slug-conditioned chain genuinely ran on the predicted leaf.
    expect(record.result?.shotType).toBe("forehand_drive");
    expect(record.result?.resultKind).toBe("scored");
    expect(record.result?.versionVector.shotConfigVersion).toBe("forehand_drive@1");
  });

  it("OVERHEAD (taxonomy leaf at depth 1) routes as a leaf commit", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "OVERHEAD",
          leaf: "OVERHEAD",
          taxonomyDepth: 1,
          confidence: 0.7,
        }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeIntent.resolutionBasis).toBe("predicted_l3");
    expect(result.value.strokeIntent.resolvedProfileId).toBe("OVERHEAD");
    expect(result.value.result?.shotType).toBe("overhead");
  });

  it("a leaf outside the registry can never become a route", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "TWEENER",
          leaf: "TWEENER",
          taxonomyDepth: 3,
          confidence: 0.9,
        }),
      }),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeIntent.resolutionBasis).toBe("abstained");
    expect(result.value.result).toBeNull();
    expect(result.value.uncertainty.limitingFactors).toContain("auto_stroke_leaf_not_in_registry");
  });
});

describe("declared runs with a hierarchical prediction", () => {
  it("disagreement is surfaced; the declared profile is kept (declaration narrows, never forces)", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({ label: "BACKHAND", taxonomyDepth: 2 }),
      }),
      captureInput({ declared: "forehand_drive", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;

    // Declared profile kept — the full chain ran on the declaration.
    expect(record.strokeIntent.resolutionBasis).toBe("declared");
    expect(record.strokeIntent.resolvedProfileId).toBe("FOREHAND_DRIVE");
    expect(record.strokeResolution).toEqual({ kind: "declared", shotType: "forehand_drive" });
    expect(record.result?.shotType).toBe("forehand_drive");
    // Both fields exist separately, and the conflict is stated, not resolved.
    expect(record.strokeIntent.declaredStroke).toBe("forehand_drive");
    expect(record.strokeIntent.predictedStroke?.label).toBe("BACKHAND");
    expect(record.strokeIntent.disagreement).toEqual({
      declared: "forehand_drive",
      predictedLabel: "BACKHAND",
      basis: "side_vs_declared",
    });
  });

  it("a side prediction cannot contradict a side-agnostic declaration (serve)", async () => {
    const result = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({ label: "BACKHAND", taxonomyDepth: 2 }),
      }),
      captureInput({ declared: "serve", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeIntent.disagreement).toBeNull();
    expect(result.value.strokeIntent.resolutionBasis).toBe("declared");
  });

  it("declaredCanonical disambiguates a shared slug; without it no side is guessed", async () => {
    const withCanonical = await analyzeCapture(
      providers(),
      captureInput({ declared: "dink", predicted: null }, "BACKHAND_DINK"),
      options(),
    );
    expect(withCanonical.ok).toBe(true);
    if (withCanonical.ok) {
      expect(withCanonical.value.strokeIntent.resolvedProfileId).toBe("BACKHAND_DINK");
      expect(withCanonical.value.strokeIntent.resolutionBasis).toBe("declared");
    }

    const withoutCanonical = await analyzeCapture(
      providers(),
      captureInput({ declared: "dink", predicted: null }),
      options(),
    );
    expect(withoutCanonical.ok).toBe(true);
    if (withoutCanonical.ok) {
      // dink ⊇ {FOREHAND_DINK, BACKHAND_DINK, RESET} — ambiguous, never guessed.
      expect(withoutCanonical.value.strokeIntent.resolvedProfileId).toBeNull();
      expect(withoutCanonical.value.strokeIntent.resolutionBasis).toBe("declared");
    }
  });

  it("a mismatched declaredCanonical is ignored, not trusted", async () => {
    const result = await analyzeCapture(
      providers(),
      // OVERHEAD's slug is "overhead", not "dink" — the canonical is invalid here.
      captureInput({ declared: "dink", predicted: null }, "OVERHEAD"),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeIntent.resolvedProfileId).toBeNull();
  });
});

describe("declared path compatibility", () => {
  it("declared run without any classifier carries a declared envelope and unchanged behavior", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({ declared: "forehand_drive", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strokeResolution).toEqual({
      kind: "declared",
      shotType: "forehand_drive",
    });
    expect(result.value.result?.resultKind).toBe("scored");
    expect(result.value.strokeIntent).toEqual({
      declaredStroke: "forehand_drive",
      predictedStroke: null,
      resolutionBasis: "declared",
      resolvedProfileId: "FOREHAND_DRIVE",
      resolvedProfileVersion: "technique-profile-v1",
      disagreement: null,
    });
  });

  it("declared-null with no auto classifier still fails honestly (fusion.stroke_unresolved)", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("fusion.stroke_unresolved");
  });
});

describe("resolution helpers (registry-terminated, conservative gate)", () => {
  const base: HierarchicalStrokePrediction = {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "stroke-heuristic-1 (uncalibrated)",
    label: "FOREHAND",
    leaf: null,
    taxonomyDepth: 2,
    confidence: 0.6,
    evidence: [],
    limitingFactors: [],
  };

  it("resolvePredictedProfile: side → shared profile; UNKNOWN/floor/unregistered → abstain", () => {
    expect(resolvePredictedProfile(base)).toMatchObject({
      kind: "side",
      profileId: "SHARED_FOREHAND_SWING",
    });
    expect(
      resolvePredictedProfile({ ...base, label: "UNKNOWN", leaf: "UNKNOWN", taxonomyDepth: 1 }),
    ).toMatchObject({ kind: "abstain", reason: "auto_stroke_prediction_unknown" });
    expect(resolvePredictedProfile({ ...base, confidence: 0.49 })).toMatchObject({
      kind: "abstain",
      reason: "auto_stroke_confidence_below_floor",
    });
    expect(
      resolvePredictedProfile({ ...base, label: "BERT", leaf: "BERT", taxonomyDepth: 3 }),
    ).toMatchObject({ kind: "abstain", reason: "auto_stroke_leaf_not_in_registry" });
  });

  it("non-finite confidence (NaN, ±Infinity) is below the floor at every gate", () => {
    const leaf = { ...base, label: "OVERHEAD", leaf: "OVERHEAD", taxonomyDepth: 1 as const };
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(resolvePredictedProfile({ ...base, confidence })).toEqual({
        kind: "abstain",
        reason: "auto_stroke_confidence_below_floor",
      });
      expect(resolvePredictedProfile({ ...leaf, confidence })).toEqual({
        kind: "abstain",
        reason: "auto_stroke_confidence_below_floor",
      });
      expect(detectHierarchicalDisagreement("dink", { ...leaf, confidence })).toBeNull();
      expect(
        detectHierarchicalDisagreement("forehand_drive", { ...base, label: "BACKHAND", confidence }),
      ).toBeNull();
      expect(
        detectFlatDisagreement("forehand_drive", {
          shotType: "backhand_drive",
          confidence,
          alternatives: [],
          producedBy: TRIGGER_MODEL,
        }),
      ).toBeNull();
    }
  });

  it("resolveSlugProfileId: unambiguous slugs resolve, shared slugs need the canonical", () => {
    expect(resolveSlugProfileId("forehand_drive", null).profileId).toBe("FOREHAND_DRIVE");
    expect(resolveSlugProfileId("third_shot_drop", null).profileId).toBe("DROP");
    expect(resolveSlugProfileId("dink", null).profileId).toBeNull();
    expect(resolveSlugProfileId("volley", null).profileId).toBeNull();
    expect(resolveSlugProfileId("dink", "FOREHAND_DINK").profileId).toBe("FOREHAND_DINK");
  });

  it("detectHierarchicalDisagreement stays silent without demonstrable conflict", () => {
    // Same side — agreement.
    expect(detectHierarchicalDisagreement("forehand_drive", base)).toBeNull();
    // UNKNOWN claims nothing.
    expect(
      detectHierarchicalDisagreement("forehand_drive", {
        ...base,
        label: "UNKNOWN",
        leaf: "UNKNOWN",
        taxonomyDepth: 1,
      }),
    ).toBeNull();
    // Below the floor claims nothing.
    expect(
      detectHierarchicalDisagreement("forehand_drive", {
        ...base,
        label: "BACKHAND",
        confidence: 0.3,
      }),
    ).toBeNull();
    // Committed leaf vs declared leaf-set conflict is claimable.
    expect(
      detectHierarchicalDisagreement("dink", {
        ...base,
        label: "OVERHEAD",
        leaf: "OVERHEAD",
        taxonomyDepth: 1,
        confidence: 0.7,
      }),
    ).toEqual({ declared: "dink", predictedLabel: "OVERHEAD", basis: "leaf_vs_declared" });
  });
});
