import type { PoseFrame } from "@pickle/shared-types";
import type { VisionProviderSet } from "@pickle/vision-contracts";
import { PoseGeometryFeatureExtractor } from "./featureExtractor.js";
import { GeometricPhaseSegmenter } from "./phaseSegmenter.js";
import {
  AbsentPaddleDetector,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
} from "./providers.js";

export { PoseGeometryFeatureExtractor, FEATURE_EXTRACTOR_VERSION } from "./featureExtractor.js";
export { GeometricPhaseSegmenter } from "./phaseSegmenter.js";
export {
  AbsentPaddleDetector,
  RecordedPoseProvider,
  RecordedTriggerStrokeDetector,
} from "./providers.js";
export { GeometryBiomechanicsExtractor } from "./biomechanicsExtractor.js";
export {
  evaluateCaptureQuality,
  QUALITY_THRESHOLDS,
  type CaptureQualityReport,
} from "./captureQuality.js";
export {
  evaluateFrameAnalyzability,
  FRAME_ANALYZABILITY_REASONS,
  FRAME_ANALYZABILITY_VERSION,
  FRAME_THRESHOLDS,
  type FrameAnalyzabilityReport,
  type FrameStats,
} from "./frameAnalyzability.js";
export {
  detectOfflineStrokeWindow,
  estimateContact,
  CONTACT_ESTIMATOR_VERSION,
  OFFLINE_TRIGGER_VERSION,
  type ContactDistributionPoint,
  type ContactEstimate,
  type ContactEvidenceSignal,
  type ContactMode,
  type OfflineStrokeWindow,
  type StrokeFamily,
} from "./offlineStroke.js";
export {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  STROKE_TAXONOMY_V3,
  type HeuristicPaddleObservation,
  type HeuristicStrokePrediction,
  type StrokeV3,
} from "./strokeHeuristicLite.js";

/**
 * Version of the deterministic measurement bundle. This is a geometry model —
 * versioned, tested math over recorded pose inference. It is not a learned
 * classifier; stroke identity still requires a validated recognizer.
 */
export const GEOMETRY_BUNDLE_VERSION = "geometry-1";

export interface RecordedStrokeInput {
  /** Pose frames measured on-device while the clip was recorded. */
  poseFrames: readonly PoseFrame[];
  /** e.g. "apple-vision-bodypose-1" — whatever actually produced the frames. */
  poseModelVersion: string;
  /** The native temporal trigger's measured stroke window. */
  trigger: {
    modelVersion: string;
    startMs: number;
    endMs: number;
    peakMotionMs: number | null;
    confidence: number;
  };
  /** Clip pixel dimensions, used only to correct coordinate aspect. */
  video: { width: number; height: number };
}

/**
 * Assembles the full provider set for one recorded stroke. Every provider is
 * deterministic over the recorded inputs; run twice, it produces the same
 * analysis byte for byte.
 */
export function createGeometryProviderSet(input: RecordedStrokeInput): VisionProviderSet {
  const aspectRatio = input.video.height > 0 ? input.video.width / input.video.height : 1;
  return {
    source: "real",
    pose: new RecordedPoseProvider({
      frames: [...input.poseFrames],
      poseModelVersion: input.poseModelVersion,
    }),
    paddle: new AbsentPaddleDetector(),
    stroke: new RecordedTriggerStrokeDetector({
      triggerModelVersion: input.trigger.modelVersion,
      startMs: input.trigger.startMs,
      endMs: input.trigger.endMs,
      peakMotionMs: input.trigger.peakMotionMs,
      confidence: input.trigger.confidence,
    }),
    phase: new GeometricPhaseSegmenter({ aspectRatio }),
    features: new PoseGeometryFeatureExtractor({ aspectRatio }),
    ball: null,
  };
}
