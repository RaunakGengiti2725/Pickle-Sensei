import type {
  CameraView,
  Handedness,
  Measurement,
  PhaseSpan,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { toLegacyPoseFrames, type PaddleTrack, type PoseSequence } from "@pickle/swing-domain";
import type { IBiomechanicsExtractor, ProviderDescriptor } from "@pickle/vision-contracts";
import { FEATURE_EXTRACTOR_VERSION, PoseGeometryFeatureExtractor } from "./featureExtractor.js";

/**
 * geometry-1 in its correct architectural role: ONE biomechanics signal for
 * the fusion engine — measured, explainable features with confidence — not
 * "the Pickle Sensei model". A learned extractor replaces this by
 * implementing the same contract under a new registry entry.
 */
export class GeometryBiomechanicsExtractor implements IBiomechanicsExtractor {
  public readonly descriptor: ProviderDescriptor = {
    providerId: "biomech.geometry",
    modelVersion: FEATURE_EXTRACTOR_VERSION,
    runtime: "deterministic",
    executionTarget: "on_device",
    artifactHash: null,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
  };

  public async extract(input: {
    pose: PoseSequence;
    paddle: PaddleTrack | null;
    phases: PhaseSpan[];
    shotType: ShotTypeSlug;
    handedness: Handedness;
    cameraView: CameraView;
  }): Promise<Result<Measurement[]>> {
    const aspectRatio =
      input.pose.video.height > 0 ? input.pose.video.width / input.pose.video.height : 1;
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio });
    return extractor.extractMeasurements({
      poseFrames: toLegacyPoseFrames(input.pose),
      paddleFrames: [],
      phases: input.phases,
      shotType: input.shotType,
      handedness: input.handedness,
      cameraView: input.cameraView,
    });
  }
}
