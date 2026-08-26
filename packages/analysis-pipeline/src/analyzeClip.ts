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
 * Pure orchestration over injected providers; provider provenance (real vs
 * fixture) propagates into the persisted result and is never laundered.
 */

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
  const strokes = await providers.stroke.detectStrokes(clip);
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
    providers.pose.extractPose(clip, window),
    providers.paddle.detectPaddle(clip, window),
  ]);
  if (!pose.ok) return pose;
  if (!paddle.ok) return paddle;

  const phases = await providers.phase.segmentPhases(pose.value, paddle.value, stroke);
  if (!phases.ok) return phases;

  const measurements = await providers.features.extractMeasurements({
    poseFrames: pose.value,
    paddleFrames: paddle.value,
    phases: phases.value,
    shotType: options.shotType,
    handedness: options.handedness,
    cameraView: options.cameraView,
  });
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
