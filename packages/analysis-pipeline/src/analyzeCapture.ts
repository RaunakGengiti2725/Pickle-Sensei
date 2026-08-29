import type {
  CameraView,
  Handedness,
  PhaseKey,
  PhaseSpan,
  Result,
  ShotAnalysis,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import {
  resolveStroke,
  toLegacyPoseFrames,
  type AnalysisRecord,
  type BallTrack,
  type EvidenceRef,
  type ModalityRecord,
  type ModelRef,
  type ModelRunRecord,
  type ModelTask,
  type PaddleTrack,
  type PoseSequence,
  type StrokeIdentity,
  type StrokeResolution,
  type TriggerWindow,
  type UncertaintySummary,
} from "@pickle/swing-domain";
import type {
  IBiomechanicsExtractor,
  ICoachingRanker,
  IFaultDetector,
  IPhaseSegmenter,
  IStrokeClassifier,
  ITechniqueScorer,
  IUncertaintyEstimator,
  ProviderDescriptor,
} from "@pickle/vision-contracts";
import {
  detectFlatDisagreement,
  detectHierarchicalDisagreement,
  resolvePredictedProfile,
  resolveSlugProfileId,
  type CaptureAnalysisRecord,
  type HierarchicalStrokePrediction,
  type IHierarchicalStrokeClassifier,
  type StrokeIntentEnvelope,
  type StrokeResolutionBasis,
} from "./strokeAutoResolution.js";

/**
 * Multimodal fusion engine.
 *
 * Consumes the canonical capture (pose sequence + whatever other modalities
 * exist) through provider contracts and produces an immutable, versioned
 * AnalysisRecord. Missing modalities degrade the analysis honestly — they are
 * reported in `modalities` and `uncertainty.limitingFactors`, never invented.
 *
 * Reprocessing is the core design: the same capture can be analyzed again by
 * any future provider set; each run appends a new record and the capture is
 * never mutated.
 */

export const FUSION_ENGINE_VERSION = "fusion-1";
export const STROKE_TAXONOMY_VERSION = "pickleball-taxonomy-v2";
export const PREDICTION_CONFIDENCE_THRESHOLD = 0.8;

export interface FusionProviders {
  /** Required minimum: temporal phase structure + measured biomechanics. */
  phase: IPhaseSegmenter;
  biomechanics: IBiomechanicsExtractor;
  scorer: ITechniqueScorer;
  faultDetector: IFaultDetector;
  uncertainty: IUncertaintyEstimator;
  coach: ICoachingRanker;
  /** Optional modalities — absent means genuinely absent. */
  classifier: IStrokeClassifier | null;
  /**
   * Hierarchical (taxonomy-depth-aware) stroke classifier — the AUTO DETECT
   * route. Optional so existing provider bundles keep compiling; absent
   * means declared-null captures stay honestly unresolved, exactly as
   * before. See strokeAutoResolution.ts for the resolution ladder + gate.
   */
  autoStrokeClassifier?: IHierarchicalStrokeClassifier | null;
  /** Shadow scorer candidates (§ shadow deployment); never user-facing. */
  shadowScorers: ITechniqueScorer[];
}

export interface CaptureAnalysisInput {
  captureId: string;
  pose: PoseSequence;
  paddle: ModalityRecord<PaddleTrack>;
  ball: ModalityRecord<BallTrack>;
  trigger: TriggerWindow;
  stroke: StrokeIdentity;
  /**
   * Canonical technique from the TechniqueIntent (e.g. "BACKHAND_DINK") when
   * the user declared one. Optional: it only disambiguates the declared
   * slug's profile (dink/volley map to several canonicals) and is validated
   * against the registry — it can never introduce a route the slug does not
   * support. declared/predicted stay separate regardless.
   */
  declaredCanonical?: string | null;
  handedness: Handedness;
  cameraView: CameraView;
  capturedAtIso: string;
}

export interface CaptureAnalysisOptions {
  analysisId: string;
  sessionId: string | null;
  appVersion: string;
  modelBundleVersion: string;
  nowIso: () => string;
  makeId: () => string;
  focusCheckpoint?: string;
}

const CHECKPOINT_PHASE: Record<string, PhaseKey> = {
  ready_position: "ready",
  athletic_base: "ready",
  preparation: "prepare",
  paddle_set: "prepare",
  swing_length: "prepare",
  sequencing: "accelerate",
  paddle_path: "accelerate",
  contact_position: "contact",
  face_wrist_stability: "contact",
  follow_through: "follow_through",
  recovery: "recover",
};

export async function analyzeCapture(
  providers: FusionProviders,
  input: CaptureAnalysisInput,
  options: CaptureAnalysisOptions,
): Promise<Result<CaptureAnalysisRecord>> {
  const modelRuns: ModelRunRecord[] = [];
  const run = async <T>(
    task: ModelTask,
    descriptor: ProviderDescriptor,
    execute: () => Promise<Result<T>>,
  ): Promise<Result<T>> => {
    const startedAtIso = options.nowIso();
    const result = await execute().catch((error: unknown) =>
      fail<T>(
        failure(
          "permanent",
          `${task}.provider_crash`,
          error instanceof Error ? error.message : String(error),
        ),
      ),
    );
    modelRuns.push({
      id: options.makeId(),
      task,
      model: toModelRef(descriptor),
      inputSchemaVersion: descriptor.inputSchemaVersion,
      outputSchemaVersion: descriptor.outputSchemaVersion,
      startedAtIso,
      completedAtIso: options.nowIso(),
      status: result.ok
        ? "succeeded"
        : result.failure.kind === "low_confidence"
          ? "abstained"
          : "failed",
      failure: result.ok ? null : result.failure,
    });
    return result;
  };

  if (input.pose.frames.length === 0) {
    return fail(
      failure("low_confidence", "fusion.empty_pose_sequence", "The capture has no pose frames."),
    );
  }

  // ── Stroke identity ────────────────────────────────────────────────────
  let identity = input.stroke;
  if (providers.classifier) {
    const prediction = await run("stroke_classification", providers.classifier.descriptor, () =>
      providers.classifier!.classify({
        pose: input.pose,
        paddle: input.paddle.status === "measured" ? input.paddle.data : null,
        ball: input.ball.status === "measured" ? input.ball.data : null,
      }),
    );
    if (prediction.ok) identity = { ...identity, predicted: prediction.value };
  }

  // Hierarchical classification (AUTO DETECT route + disagreement check).
  // Runs whenever the provider exists: on declared runs its only power is to
  // SURFACE disagreement — declaration narrows interpretation, prediction
  // never silently replaces it (and vice versa).
  let autoPrediction: HierarchicalStrokePrediction | null = null;
  if (providers.autoStrokeClassifier) {
    const prediction = await run(
      "stroke_classification",
      providers.autoStrokeClassifier.descriptor,
      () =>
        providers.autoStrokeClassifier!.classify({
          pose: input.pose,
          paddle: input.paddle.status === "measured" ? input.paddle.data : null,
          ball: input.ball.status === "measured" ? input.ball.data : null,
          window: { startMs: input.trigger.startMs, endMs: input.trigger.endMs },
          // Fusion has no confirmed contact before phase segmentation; the
          // trigger's measured motion peak is the only honest reference and
          // the classifier records that substitution in limitingFactors.
          contactMs: null,
          eventPeakMs: input.trigger.peakMotionMs,
          handedness: input.handedness,
        }),
    );
    if (prediction.ok) autoPrediction = prediction.value;
  }

  const resolution = resolveStroke(identity, {
    predictionConfidenceThreshold: PREDICTION_CONFIDENCE_THRESHOLD,
  });

  // Declared-vs-predicted disagreement (both must genuinely exist; the
  // hierarchical prediction is checked first, the flat one as fallback).
  const disagreement =
    identity.declared !== null
      ? (autoPrediction && detectHierarchicalDisagreement(identity.declared, autoPrediction)) ??
        detectFlatDisagreement(identity.declared, identity.predicted)
      : null;

  let shotType: ShotTypeSlug;
  let strokeResolution: StrokeResolution = resolution;
  let resolutionBasis: StrokeResolutionBasis;
  let resolvedProfileId: string | null;
  let resolvedProfileVersion: string | null;

  if (resolution.kind === "unresolved") {
    if (identity.declared === null && autoPrediction !== null) {
      // AUTO DETECT: resolve from the prediction, registry-terminated.
      const predictedProfile = resolvePredictedProfile(autoPrediction);
      if (predictedProfile.kind === "leaf") {
        shotType = predictedProfile.legacySlug;
        strokeResolution = {
          kind: "predicted",
          shotType,
          confidence: autoPrediction.confidence,
        };
        resolutionBasis = "predicted_l3";
        resolvedProfileId = predictedProfile.profileId;
        resolvedProfileVersion = predictedProfile.profileVersion;
      } else {
        // Side-depth resolution or abstention: no leaf technique exists, so
        // the slug-conditioned stages (biomechanics, scoring, faults,
        // coaching) cannot run without fabricating one. Return a durable
        // partial record instead of a score.
        return partialAutoRecord({
          providers,
          input,
          options,
          run,
          modelRuns,
          autoPrediction,
          resolution: predictedProfile,
        });
      }
    } else {
      return fail(failure("low_confidence", "fusion.stroke_unresolved", resolution.reason));
    }
  } else if (resolution.kind === "declared") {
    shotType = resolution.shotType;
    resolutionBasis = "declared";
    const profile = resolveSlugProfileId(resolution.shotType, input.declaredCanonical ?? null);
    resolvedProfileId = profile.profileId;
    resolvedProfileVersion = profile.profileVersion;
  } else {
    // Legacy flat classifier won (validated prediction ≥ threshold). The
    // slug is leaf-level identity, so the basis is predicted_l3; the profile
    // maps only when the slug is unambiguous in the registry — never guessed.
    shotType = resolution.shotType;
    resolutionBasis = "predicted_l3";
    const profile = resolveSlugProfileId(resolution.shotType, null);
    resolvedProfileId = profile.profileId;
    resolvedProfileVersion = profile.profileVersion;
  }

  const strokeIntent: StrokeIntentEnvelope = {
    declaredStroke: identity.declared,
    predictedStroke: autoPrediction,
    resolutionBasis,
    resolvedProfileId,
    resolvedProfileVersion,
    disagreement,
  };

  // ── Temporal structure ─────────────────────────────────────────────────
  const legacyFrames = toLegacyPoseFrames(input.pose);
  const strokeEvent = {
    startMs: input.trigger.startMs,
    endMs: input.trigger.endMs,
    contactMs: input.trigger.peakMotionMs,
    shotTypeHypothesis: null,
    confidence: input.trigger.confidence,
  };
  const phases = await run("phase_segmentation", segDescriptor(providers.phase), () =>
    providers.phase.segmentPhases(legacyFrames, [], strokeEvent),
  );
  if (!phases.ok) return phases;

  // ── Biomechanics (one modality signal, not "the model") ───────────────
  const measurements = await run("biomechanics_extraction", providers.biomechanics.descriptor, () =>
    providers.biomechanics.extract({
      pose: input.pose,
      paddle: input.paddle.status === "measured" ? input.paddle.data : null,
      phases: phases.value,
      shotType,
      handedness: input.handedness,
      cameraView: input.cameraView,
    }),
  );
  if (!measurements.ok) return measurements;

  // ── Scoring ────────────────────────────────────────────────────────────
  const scored = await run("technique_scoring", providers.scorer.descriptor, () =>
    providers.scorer.score({ shotType, measurements: measurements.value, embedding: null }),
  );
  if (!scored.ok) return scored;

  const faults = await run("fault_detection", providers.faultDetector.descriptor, () =>
    providers.faultDetector.detectFaults({
      shotType,
      checkpoints: scored.value.checkpoints,
      scorerInternal: scored.value.internal,
    }),
  );

  const uncertainty = await run("uncertainty_estimation", providers.uncertainty.descriptor, () =>
    providers.uncertainty.estimate({
      checkpoints: scored.value.checkpoints,
      analysisConfidence: scored.value.analysisConfidence,
      presentation: scored.value.presentation,
      modalitiesUsed: {
        pose: true,
        paddle: input.paddle.status === "measured",
        ball: input.ball.status === "measured",
        court: false,
      },
    }),
  );
  if (!uncertainty.ok) return uncertainty;

  const coached =
    scored.value.presentation === "abstain"
      ? null
      : await run("coaching_ranking", providers.coach.descriptor, () =>
          providers.coach.rank({
            shotType,
            scorerInternal: scored.value.internal,
            ...(options.focusCheckpoint ? { focusCheckpoint: options.focusCheckpoint } : {}),
          }),
        );

  // ── Shadow candidates (never user-facing) ─────────────────────────────
  const shadow: AnalysisRecord["shadow"] = [];
  for (const candidate of providers.shadowScorers) {
    const shadowResult = await run("technique_scoring", candidate.descriptor, () =>
      candidate.score({ shotType, measurements: measurements.value, embedding: null }),
    );
    shadow.push({
      run: modelRuns[modelRuns.length - 1]!,
      overallScore: shadowResult.ok ? shadowResult.value.overallScore : null,
      analysisConfidence: shadowResult.ok ? shadowResult.value.analysisConfidence : null,
    });
  }

  // ── Evidence: claims → frames + metrics + producing model ─────────────
  const phaseByKey = new Map(phases.value.map((span) => [span.key, span]));
  const evidence: EvidenceRef[] = scored.value.checkpointEvidence
    .filter((entry) => entry.metricKeys.length > 0)
    .map((entry) => {
      const window = phaseWindow(phaseByKey, CHECKPOINT_PHASE[entry.checkpoint]);
      const checkpoint = scored.value.checkpoints.find((c) => c.key === entry.checkpoint);
      return {
        claim: `checkpoint:${entry.checkpoint}`,
        window,
        metricKeys: entry.metricKeys,
        producedByProviderId: providers.scorer.descriptor.providerId,
        confidence: checkpoint?.confidence ?? 0,
      };
    });

  const contactPhase = phaseByKey.get("contact");
  const result: ShotAnalysis = {
    id: options.analysisId,
    sessionId: options.sessionId,
    shotType,
    cameraView: input.cameraView,
    handedness: input.handedness,
    capturedAtIso: input.capturedAtIso,
    timestamps: {
      startMs: input.trigger.startMs,
      contactMs: contactPhase?.representativeMs ?? input.trigger.peakMotionMs,
      endMs: input.trigger.endMs,
    },
    phases: phases.value,
    measurements: measurements.value,
    checkpoints: scored.value.checkpoints,
    overallScore: scored.value.overallScore,
    analysisConfidence: scored.value.analysisConfidence,
    resultKind: scored.value.presentation === "abstain" ? "low_confidence" : "scored",
    guidance: scored.value.guidance,
    priorityFix: coached && coached.ok ? coached.value : null,
    versionVector: {
      appVersion: options.appVersion,
      modelBundleVersion: options.modelBundleVersion,
      poseModelVersion: input.pose.producedBy.modelVersion,
      paddleModelVersion:
        input.paddle.status === "measured"
          ? input.paddle.data.producedBy.modelVersion
          : "paddle-none-0",
      strokeDetectorVersion: input.trigger.producedBy.modelVersion,
      phaseModelVersion: segDescriptor(providers.phase).modelVersion,
      scoringModelVersion: providers.scorer.descriptor.modelVersion,
      shotConfigVersion: `${shotType}@1`,
    },
    source: "real",
  };

  return ok({
    schemaVersion: 1,
    id: options.analysisId,
    captureId: input.captureId,
    createdAtIso: options.nowIso(),
    engineVersion: FUSION_ENGINE_VERSION,
    strokeTaxonomyVersion: STROKE_TAXONOMY_VERSION,
    strokeResolution,
    modalities: {
      pose: true,
      paddle: input.paddle.status === "measured",
      ball: input.ball.status === "measured",
      court: false,
      camera: false,
    },
    modelRuns,
    result,
    faults: faults.ok ? faults.value : [],
    uncertainty: uncertainty.value,
    evidence,
    shadow,
    strokeIntent,
  });
}

/**
 * AUTO run that could not reach a leaf technique: either a defensible
 * depth-2 side resolution (shared profile, basis "predicted_family") or an
 * explicit abstention (basis "abstained"). Both produce a durable
 * AnalysisRecord with result:null — the classifier's output is preserved
 * for reprocessing history, and nothing slug-conditioned was executed, so
 * no stroke, measurement, or score is invented.
 */
async function partialAutoRecord(args: {
  providers: FusionProviders;
  input: CaptureAnalysisInput;
  options: CaptureAnalysisOptions;
  run: <T>(
    task: ModelTask,
    descriptor: ProviderDescriptor,
    execute: () => Promise<Result<T>>,
  ) => Promise<Result<T>>;
  modelRuns: ModelRunRecord[];
  autoPrediction: HierarchicalStrokePrediction;
  resolution:
    | { kind: "side"; side: "FOREHAND" | "BACKHAND"; profileId: string; profileVersion: string }
    | { kind: "abstain"; reason: string };
}): Promise<Result<CaptureAnalysisRecord>> {
  const { providers, input, options, run, modelRuns, autoPrediction, resolution } = args;

  // Temporal structure is slug-independent perception — run and record it
  // for the side-resolved case so the record carries a real event window.
  // Its failure degrades the evidence window, never the record.
  let contactWindow: { startMs: number; endMs: number } | null = null;
  if (resolution.kind === "side") {
    const legacyFrames = toLegacyPoseFrames(input.pose);
    const phases = await run("phase_segmentation", segDescriptor(providers.phase), () =>
      providers.phase.segmentPhases(legacyFrames, [], {
        startMs: input.trigger.startMs,
        endMs: input.trigger.endMs,
        contactMs: input.trigger.peakMotionMs,
        shotTypeHypothesis: null,
        confidence: input.trigger.confidence,
      }),
    );
    if (phases.ok) {
      const contact = phases.value.find((span) => span.key === "contact");
      contactWindow = contact ? { startMs: contact.startMs, endMs: contact.endMs } : null;
    }
  }

  const limitingFactors = [
    ...new Set([
      ...autoPrediction.limitingFactors,
      ...(input.paddle.status === "measured" ? [] : ["paddle_track_unavailable"]),
      ...(input.ball.status === "measured" ? [] : ["ball_track_unavailable"]),
      resolution.kind === "side"
        ? "auto_stroke_resolved_at_side_depth_no_leaf_for_scoring"
        : resolution.reason,
    ]),
  ];
  const uncertainty: UncertaintySummary = {
    // No score exists; the floor is the only honest analysis confidence.
    analysisConfidence: 0,
    presentation: "abstain",
    perCheckpoint: {},
    limitingFactors,
  };

  const evidence: EvidenceRef[] =
    resolution.kind === "side"
      ? [
          {
            claim: `stroke:predicted_side:${resolution.side}`,
            window: contactWindow ?? {
              startMs: input.trigger.startMs,
              endMs: input.trigger.endMs,
            },
            metricKeys: [],
            producedByProviderId: providers.autoStrokeClassifier!.descriptor.providerId,
            confidence: autoPrediction.confidence,
          },
        ]
      : [];

  const strokeIntent: StrokeIntentEnvelope = {
    declaredStroke: null,
    predictedStroke: autoPrediction,
    resolutionBasis: resolution.kind === "side" ? "predicted_family" : "abstained",
    resolvedProfileId: resolution.kind === "side" ? resolution.profileId : null,
    resolvedProfileVersion: resolution.kind === "side" ? resolution.profileVersion : null,
    disagreement: null,
  };

  return ok({
    schemaVersion: 1,
    id: options.analysisId,
    captureId: input.captureId,
    createdAtIso: options.nowIso(),
    engineVersion: FUSION_ENGINE_VERSION,
    strokeTaxonomyVersion: STROKE_TAXONOMY_VERSION,
    strokeResolution: {
      kind: "unresolved",
      reason:
        resolution.kind === "side"
          ? `AUTO resolved to shared profile ${resolution.profileId} at taxonomy depth 2; no leaf technique was claimed.`
          : `AUTO abstained: ${resolution.reason}.`,
    },
    modalities: {
      pose: true,
      paddle: input.paddle.status === "measured",
      ball: input.ball.status === "measured",
      court: false,
      camera: false,
    },
    modelRuns,
    result: null,
    faults: [],
    uncertainty,
    evidence,
    shadow: [],
    strokeIntent,
  });
}

function phaseWindow(
  phases: Map<PhaseKey, PhaseSpan>,
  key: PhaseKey | undefined,
): { startMs: number; endMs: number } | null {
  if (key === undefined) return null;
  const span = phases.get(key);
  return span ? { startMs: span.startMs, endMs: span.endMs } : null;
}

/** Legacy IPhaseSegmenter predates ProviderDescriptor; adapt its identity. */
function segDescriptor(segmenter: IPhaseSegmenter): ProviderDescriptor {
  return {
    providerId: "phase.geometry",
    modelVersion: segmenter.modelVersion,
    runtime: "deterministic",
    executionTarget: "on_device",
    artifactHash: null,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
  };
}

function toModelRef(descriptor: ProviderDescriptor): ModelRef {
  return {
    providerId: descriptor.providerId,
    modelVersion: descriptor.modelVersion,
    runtime: descriptor.runtime,
    executionTarget: descriptor.executionTarget,
    artifactHash: descriptor.artifactHash,
  };
}
