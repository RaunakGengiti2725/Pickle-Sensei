import type {
  CameraView,
  Handedness,
  Result,
  ShotAnalysis,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import { getShotScoringConfig, scoreShot, selectPriorityFix } from "@pickle/scoring";
import type { CheckpointKey } from "@pickle/shared-types";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";

/**
 * Single-shot analysis pipeline (spec pp. 24–25):
 *   stroke detection → pose + paddle → phases → features → scoring → priority.
 * Pure orchestration over injected providers; the provider's declared source
 * propagates into the persisted result and is never laundered.
 *
 * Every provider call sits behind a Result boundary: a provider that throws or
 * rejects (a native bridge crash, an adapter bug) becomes a typed permanent
 * `<stage>.provider_crash` failure — the pipeline never leaks a raw rejection
 * to its caller. Typed failures the provider returns pass through unchanged.
 */

type ProviderStage = "stroke" | "pose" | "paddle" | "phase" | "features";

async function guarded<T>(
  stage: ProviderStage,
  execute: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await execute();
  } catch (error: unknown) {
    return fail(
      failure(
        "permanent",
        `${stage}.provider_crash`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

export interface AnalyzeClipOptions {
  analysisId: string;
  sessionId: string | null;
  shotType: ShotTypeSlug;
  handedness: Handedness;
  cameraView: CameraView;
  appVersion: string;
  modelBundleVersion: string;
  capturedAtIso: string;
  focusCheckpoint?: CheckpointKey;
}

export async function analyzeClip(
  providers: VisionProviderSet,
  clip: VideoClipRef,
  options: AnalyzeClipOptions,
): Promise<Result<ShotAnalysis>> {
  const strokes = await guarded("stroke", () => providers.stroke.detectStrokes(clip));
  if (!strokes.ok) return strokes;
  const stroke = strokes.value[0];
  if (!stroke) {
    return fail(
      failure(
        "low_confidence",
        "analysis.no_stroke_detected",
        "No stroke detected in the clip. Make sure the full swing is in frame.",
      ),
    );
  }

  const window = { startMs: stroke.startMs, endMs: stroke.endMs };
  const [pose, paddle] = await Promise.all([
    guarded("pose", () => providers.pose.extractPose(clip, window)),
    guarded("paddle", () => providers.paddle.detectPaddle(clip, window)),
  ]);
  if (!pose.ok) return pose;
  if (!paddle.ok) return paddle;

  const phases = await guarded("phase", () =>
    providers.phase.segmentPhases(pose.value, paddle.value, stroke),
  );
  if (!phases.ok) return phases;

  const measurements = await guarded("features", () =>
    providers.features.extractMeasurements({
      poseFrames: pose.value,
      paddleFrames: paddle.value,
      phases: phases.value,
      shotType: options.shotType,
      handedness: options.handedness,
      cameraView: options.cameraView,
    }),
  );
  if (!measurements.ok) return measurements;

  const config = getShotScoringConfig(options.shotType);
  const outcome = scoreShot(config, measurements.value);
  const priorityFix =
    outcome.presentation === "abstain"
      ? null
      : selectPriorityFix(
          config,
          outcome.checkpointResults,
          options.focusCheckpoint ? { focusCheckpoint: options.focusCheckpoint } : {},
        );

  const contactPhase = phases.value.find((p) => p.key === "contact");

  const analysis: ShotAnalysis = {
    id: options.analysisId,
    sessionId: options.sessionId,
    shotType: options.shotType,
    cameraView: options.cameraView,
    handedness: options.handedness,
    capturedAtIso: options.capturedAtIso,
    timestamps: {
      startMs: stroke.startMs,
      contactMs: contactPhase?.representativeMs ?? stroke.contactMs,
      endMs: stroke.endMs,
    },
    phases: phases.value,
    measurements: measurements.value,
    checkpoints: outcome.checkpoints,
    overallScore: outcome.overallScore,
    analysisConfidence: outcome.analysisConfidence,
    resultKind: outcome.presentation === "abstain" ? "low_confidence" : "scored",
    guidance: outcome.guidance,
    priorityFix,
    versionVector: {
      appVersion: options.appVersion,
      modelBundleVersion: options.modelBundleVersion,
      poseModelVersion: providers.pose.modelVersion,
      paddleModelVersion: providers.paddle.modelVersion,
      strokeDetectorVersion: providers.stroke.modelVersion,
      phaseModelVersion: providers.phase.modelVersion,
      scoringModelVersion: config.scoringModelVersion,
      shotConfigVersion: config.shotConfigVersion,
    },
    source: providers.source,
  };
  return ok(analysis);
}
