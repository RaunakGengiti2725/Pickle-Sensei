import { describe, expect, it, vi } from "vitest";
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
import {
  analyzeCapture,
  detectHierarchicalDisagreement,
  parseNeedsTechniqueConfirmationRecord,
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
        classifierVersion: "hier-test-1",
        leaf: null,
        confidence: 0.6,
        evidence: ["stub evidence"],
        limitingFactors: ["bounce_not_observed_level3_uncommitted"],
        ...prediction,
      }),
  };
}

describe("W03 exact technique confirmation", () => {
  it.each(["FOREHAND", "BACKHAND"])(
    "%s family evidence cannot select drive targets or produce a numerical rating",
    async (label) => {
      const bundle = providers({
        autoStrokeClassifier: autoClassifier({ label, taxonomyDepth: 2, confidence: 1 }),
      });
      const extract = vi.spyOn(bundle.biomechanics, "extract");
      const score = vi.spyOn(bundle.scorer, "score");
      const coach = vi.spyOn(bundle.coach, "rank");
      const result = await analyzeCapture(
        bundle,
        captureInput({ declared: null, predicted: null }),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        kind: "needs_technique_confirmation",
        confirmationReason: "family_only",
        result: null,
        strokeResolution: { kind: "unresolved" },
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: { label, leaf: null },
          resolutionBasis: "predicted_family",
          resolvedProfileId: `SHARED_${label}_SWING`,
        },
      });
      expect(extract).not.toHaveBeenCalled();
      expect(score).not.toHaveBeenCalled();
      expect(coach).not.toHaveBeenCalled();
      expect(result.value.faults).toEqual([]);
      expect(result.value.shadow).toEqual([]);
    },
  );

  it.each([
    {
      label: "UNKNOWN",
      leaf: "UNKNOWN",
      taxonomyDepth: 1 as const,
      reason: "unresolved_technique",
    },
    {
      label: "TWEENER",
      leaf: "TWEENER",
      taxonomyDepth: 3 as const,
      reason: "unsupported_technique",
    },
    {
      label: "FOREHAND_DRIVE",
      leaf: "FOREHAND_DRIVE",
      taxonomyDepth: 3 as const,
      reason: "unvalidated_prediction",
    },
    {
      label: "OVERHEAD",
      leaf: "OVERHEAD",
      taxonomyDepth: 1 as const,
      reason: "unvalidated_prediction",
    },
  ])("requires confirmation for $label even at maximum model confidence", async (prediction) => {
    const bundle = providers({
      autoStrokeClassifier: autoClassifier({ ...prediction, confidence: 1 }),
    });
    const score = vi.spyOn(bundle.scorer, "score");
    const result = await analyzeCapture(
      bundle,
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: "needs_technique_confirmation",
      confirmationReason: prediction.reason,
      result: null,
      strokeIntent: { declaredStroke: null, predictedStroke: { label: prediction.label } },
    });
    expect(score).not.toHaveBeenCalled();
  });

  it.each([
    { slug: "dink" as const, canonical: null },
    { slug: "volley" as const, canonical: null },
    { slug: "forehand_drive" as const, canonical: "BACKHAND_DINK" },
    { slug: "serve" as const, canonical: "UNSUPPORTED_SERVE" },
  ])(
    "does not score an ambiguous or unsupported declared route: $slug / $canonical",
    async ({ slug, canonical }) => {
      const bundle = providers();
      const score = vi.spyOn(bundle.scorer, "score");
      const result = await analyzeCapture(
        bundle,
        captureInput({ declared: slug, predicted: null }, canonical),
        options(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        kind: "needs_technique_confirmation",
        result: null,
        strokeIntent: { declaredStroke: slug, resolvedProfileId: null },
      });
      expect(score).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicit exact declaration instead of replacing it with a confident flat prediction", async () => {
    const input = captureInput(
      {
        declared: "backhand_drive",
        predicted: {
          shotType: "forehand_drive",
          confidence: 1,
          alternatives: [],
          producedBy: { ...TRIGGER_MODEL, providerId: "classifier.test" },
        },
      },
      "BACKHAND_DRIVE",
    );
    const result = await analyzeCapture(providers(), input, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result?.shotType).toBe("backhand_drive");
    expect(result.value.strokeIntent).toMatchObject({
      declaredStroke: "backhand_drive",
      resolutionBasis: "declared",
      flatPrediction: input.stroke.predicted,
      disagreement: {
        declared: "backhand_drive",
        predictedLabel: "forehand_drive",
        basis: "slug_vs_declared",
      },
    });
  });
});

async function durableConfirmationFixture(
  prediction = autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }),
  stroke: StrokeIdentity = { declared: null, predicted: null },
  canonical: string | null = null,
  unsupported = false,
) {
  const input = {
    ...captureInput(stroke, canonical),
    captureId: "11111111-1111-4111-8111-111111111111",
  };
  const bundle = providers({ autoStrokeClassifier: prediction });
  if (unsupported)
    vi.spyOn(bundle.scorer, "score").mockResolvedValue(
      fail(failure("unsupported_device", "scoring.unsupported_stroke", "Not supported")),
    );
  const result = await analyzeCapture(bundle, input, {
    ...options(),
    analysisId: "22222222-2222-4222-8222-222222222222",
    makeId: () => `33333333-3333-4333-8333-${String(++counter).padStart(12, "0")}`,
  });
  if (!result.ok || result.value.kind !== "needs_technique_confirmation")
    throw new Error("Expected pending fixture");
  return {
    ...result.value,
    observationHash: "a".repeat(64),
    captureEnvelope: null,
    inputSelection: {
      version: "capture-analysis-input-v1",
      ownerKey: "44444444-4444-4444-8444-444444444444",
      ownerGeneration: 1,
      apiOrigin: "https://api.test",
      captureId: input.captureId,
      observationHash: "a".repeat(64),
      definitionHash: "b".repeat(64),
      modelPolicyHash: "c".repeat(64),
      capture: {
        captureMode: "automatic_pose_trigger",
        capturedAtIso: input.capturedAtIso,
        durationMs: input.trigger.endMs,
        width: 1080,
        height: 1080,
        fps: 60,
        poseFrameCount: input.pose.frames.length,
        poseModelVersion: input.pose.producedBy.modelVersion,
        poseUri: "file:///captures/test.pose.json",
        payloadHash: "e".repeat(64),
      },
      trigger: {
        startMs: input.trigger.startMs,
        endMs: input.trigger.endMs,
        peakMotionMs: input.trigger.peakMotionMs,
        confidence: input.trigger.confidence,
        modelVersion: input.trigger.producedBy.modelVersion,
      },
      declaredStroke: stroke.declared,
      declaredCanonical: canonical,
      handedness: input.handedness,
      cameraView: input.cameraView,
      focusCheckpoint: null,
      target: { userSelection: null, guidedStartTap: null, acquiredAnchor: null },
    },
  };
}

describe("W03 durable confirmation parser", () => {
  it("accepts complete family, abstained, predicted-leaf, declared and unsupported-scorer records without conflating them", async () => {
    for (const value of [
      await durableConfirmationFixture(),
      await durableConfirmationFixture(
        autoClassifier({ label: "UNKNOWN", leaf: "UNKNOWN", taxonomyDepth: 1 }),
      ),
      await durableConfirmationFixture(
        autoClassifier({ label: "OVERHEAD", leaf: "OVERHEAD", taxonomyDepth: 1 }),
      ),
      await durableConfirmationFixture(
        autoClassifier({ label: "TWEENER", leaf: "TWEENER", taxonomyDepth: 3 }),
      ),
      await durableConfirmationFixture(autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }), {
        declared: null,
        predicted: { shotType: "dink", confidence: 1, alternatives: [], producedBy: TRIGGER_MODEL },
      }),
      await durableConfirmationFixture(autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }), {
        declared: "dink",
        predicted: null,
      }),
      await durableConfirmationFixture(
        autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }),
        { declared: "forehand_drive", predicted: null },
        "FOREHAND_DRIVE",
        true,
      ),
    ]) {
      expect(parseNeedsTechniqueConfirmationRecord(value)).toEqual({ ok: true, value });
    }
  });

  it("rejects a hierarchical prediction whose successful classifier execution is missing", async () => {
    const good = await durableConfirmationFixture();
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        modelRuns: good.modelRuns.filter((run) => run.task !== "stroke_classification"),
      }).ok,
    ).toBe(false);
  });

  it("binds a hierarchical prediction to the version of its successful classifier execution", async () => {
    const good = await durableConfirmationFixture();
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        strokeIntent: {
          ...good.strokeIntent,
          predictedStroke: {
            ...good.strokeIntent.predictedStroke,
            classifierVersion: "another-classifier",
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("does not accept a flat prediction with an unrelated producer merely because a hierarchical classifier also ran", async () => {
    const good = await durableConfirmationFixture();
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        strokeIntent: {
          ...good.strokeIntent,
          flatPrediction: {
            shotType: "dink",
            confidence: 0.2,
            alternatives: [],
            producedBy: { ...TRIGGER_MODEL, providerId: "untracked-flat-classifier" },
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects a guided selection timestamp later than its immutable original record", async () => {
    const good = await durableConfirmationFixture();
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        inputSelection: {
          ...good.inputSelection,
          target: {
            ...good.inputSelection.target,
            guidedStartTap: {
              point: { x: 0.2, y: 0.5 },
              source: "guided_start_region",
              selectedAtIso: "2099-01-01T00:00:00.000Z",
            },
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects a reason that contradicts the recorded declared resolution", async () => {
    const good = await durableConfirmationFixture(
      autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }),
      { declared: "dink", predicted: null },
    );
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        confirmationReason: "unvalidated_prediction",
      }).ok,
    ).toBe(false);
  });

  it.each([
    { label: "OVERHEAD", reason: "unsupported_technique" },
    { label: "UNKNOWN", reason: "unvalidated_prediction" },
  ])(
    "rejects a confirmation reason inconsistent with $label evidence",
    async ({ label, reason }) => {
      const good = await durableConfirmationFixture(
        autoClassifier({ label, leaf: label, taxonomyDepth: 1 }),
      );
      expect(
        parseNeedsTechniqueConfirmationRecord({ ...good, confirmationReason: reason }).ok,
      ).toBe(false);
    },
  );

  it("binds an unsupported scorer execution to the configured score version", async () => {
    const good = await durableConfirmationFixture(
      autoClassifier({ label: "FOREHAND", taxonomyDepth: 2 }),
      { declared: "forehand_drive", predicted: null },
      "FOREHAND_DRIVE",
      true,
    );
    expect(
      parseNeedsTechniqueConfirmationRecord({
        ...good,
        provenance: { ...good.provenance, scoreVersion: "unrelated-scorer" },
      }).ok,
    ).toBe(false);
  });

  it("rejects incomplete, inconsistent, or unbound numerical/selection/provenance payloads", async () => {
    const good = await durableConfirmationFixture();
    const mutations = [
      { ...good, id: "not-an-id" },
      { ...good, schemaVersion: 2 },
      { ...good, confirmationReason: "scored" },
      { ...good, result: { overallScore: 9 } },
      { ...good, strokeIntent: {} },
      { ...good, strokeIntent: { ...good.strokeIntent, predictedStroke: {} } },
      { ...good, modelRuns: [{}] },
      { ...good, provenance: {} },
      { ...good, provenance: { ...good.provenance, providerVersions: [] } },
      { ...good, captureEnvelope: {} },
      { ...good, observationHash: "wrong" },
      { ...good, inputSelection: undefined },
      {
        ...good,
        inputSelection: { ...good.inputSelection, apiOrigin: "https://api.test?token=wrong" },
      },
      { ...good, inputSelection: { ...good.inputSelection, observationHash: "d".repeat(64) } },
      {
        ...good,
        inputSelection: {
          ...good.inputSelection,
          target: {
            ...good.inputSelection.target,
            userSelection: { point: { x: 1.1, y: 0.5 }, selectedAtIso: good.createdAtIso },
          },
        },
      },
      {
        ...good,
        inputSelection: {
          ...good.inputSelection,
          target: {
            ...good.inputSelection.target,
            userSelection: { point: { x: 0.5, y: 0.5 }, selectedAtIso: "2026-02-30T00:00:00.000Z" },
          },
        },
      },
    ];
    for (const value of mutations)
      expect(parseNeedsTechniqueConfirmationRecord(value).ok).toBe(false);
  });
});

describe("W03 confirmation boundaries", () => {
  it("preserves an original disagreement as user confirmation appends a differently conditioned analysis", async () => {
    const first = await analyzeCapture(
      providers({
        autoStrokeClassifier: autoClassifier({
          label: "OVERHEAD",
          leaf: "OVERHEAD",
          taxonomyDepth: 1,
        }),
      }),
      captureInput({ declared: "volley", predicted: null }),
      options(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe("needs_technique_confirmation");
    const original = JSON.stringify(first.value);
    const confirmation = {
      analysisId: first.value.id,
      intent: {
        version: "technique-intent-v1" as const,
        source: "tap" as const,
        canonical: "BACKHAND_VOLLEY",
        legacySlug: "volley" as const,
        confidence: 1,
      },
      confirmedAtIso: "2026-09-06T18:00:00.000Z",
      originalStrokeIntent: first.value.strokeIntent,
    };
    const second = await analyzeCapture(
      providers({ autoStrokeClassifier: autoClassifier({ label: "BACKHAND", taxonomyDepth: 2 }) }),
      {
        ...captureInput({ declared: "volley", predicted: null }, "BACKHAND_VOLLEY"),
        techniqueConfirmation: confirmation,
      },
      options(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.result?.shotType).toBe("volley");
    expect(second.value.strokeIntent.confirmation).toEqual(confirmation);
    expect(second.value.strokeIntent.confirmation?.originalStrokeIntent.disagreement).toEqual({
      declared: "volley",
      predictedLabel: "OVERHEAD",
      basis: "leaf_vs_declared",
    });
    expect(second.value.strokeIntent.disagreement).toBeNull();
    expect(second.value.id).not.toBe(first.value.id);
    expect(second.value.captureId).toBe(first.value.captureId);
    expect(JSON.stringify(first.value)).toBe(original);
  });

  it("keeps an exact declared technique unscored when its scorer reports unsupported", async () => {
    const bundle = providers();
    vi.spyOn(bundle.scorer, "score").mockResolvedValue(
      fail(failure("unsupported_device", "scoring.unsupported_stroke", "Not supported")),
    );
    const coach = vi.spyOn(bundle.coach, "rank");
    const result = await analyzeCapture(
      bundle,
      captureInput({ declared: "forehand_drive", predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: "needs_technique_confirmation",
      result: null,
      confirmationReason: "unsupported_technique",
    });
    expect(coach).not.toHaveBeenCalled();
  });

  it("a confident flat prediction without a declaration is not proof of scoring eligibility", async () => {
    const input = captureInput({
      declared: null,
      predicted: {
        shotType: "forehand_drive",
        confidence: 1,
        alternatives: [],
        producedBy: TRIGGER_MODEL,
      },
    });
    const bundle = providers();
    const score = vi.spyOn(bundle.scorer, "score");
    const result = await analyzeCapture(bundle, input, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: "needs_technique_confirmation",
      result: null,
      confirmationReason: "unvalidated_prediction",
    });
    expect(result.value.strokeIntent.flatPrediction).toEqual(input.stroke.predicted);
    expect(score).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2])(
    "invalid prediction confidence %s cannot resolve a profile",
    async (confidence) => {
      const classifier = autoClassifier({
        label: "FOREHAND_DRIVE",
        leaf: "FOREHAND_DRIVE",
        taxonomyDepth: 3,
        confidence,
      });
      const prediction = await classifier.classify({
        pose: captureInput({ declared: null, predicted: null }).pose,
        paddle: null,
        ball: null,
        window: { startMs: 0, endMs: 2000 },
        contactMs: null,
        eventPeakMs: 1000,
        handedness: "right",
      });
      if (!prediction.ok) throw new Error("Expected test prediction");
      expect(resolvePredictedProfile(prediction.value).kind).toBe("abstain");
    },
  );
});

describe("AUTO DETECT: declared-null routing", () => {
  it("depth-2 FOREHAND prediction retains the shared side profile without scoring a leaf", async () => {
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
    expect(record.result).toBeNull();
    expect(record.kind).toBe("needs_technique_confirmation");
    expect(record.strokeResolution.kind).toBe("unresolved");
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

  it("a committed leaf keeps predicted_l3 provenance but requires confirmation without validation", async () => {
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
    expect(record.strokeResolution.kind).toBe("unresolved");
    // The slug-conditioned chain genuinely ran on the predicted leaf.
    expect(record.result).toBeNull();
    expect(record.kind).toBe("needs_technique_confirmation");
    expect(record.modelRuns.some((run) => run.task === "technique_scoring")).toBe(false);
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
    expect(result.value.result).toBeNull();
    expect(result.value.confirmationReason).toBe("unvalidated_prediction");
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

  it("declared-null with no auto classifier preserves an unscored confirmation request", async () => {
    const result = await analyzeCapture(
      providers(),
      captureInput({ declared: null, predicted: null }),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("needs_technique_confirmation");
    expect(result.value.result).toBeNull();
    expect(result.value.strokeIntent.predictedStroke).toBeNull();
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
