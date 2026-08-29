import type {
  CheckpointScore,
  Handedness,
  Measurement,
  PhaseSpan,
  PriorityFix,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";
import type {
  BallTrack,
  CameraCalibration,
  CourtGeometry,
  DetectedFault,
  ExecutionTarget,
  LearnedEmbedding,
  ModelRuntime,
  PaddleTrack,
  PoseSequence,
  StrokePrediction,
  UncertaintySummary,
} from "@pickle/swing-domain";

/**
 * The permanent provider taxonomy. Each interface is a stable domain
 * contract; implementations are interchangeable — deterministic code, Core
 * ML, ONNX, a server transformer, or runtimes that do not exist yet. The
 * application layer consumes these contracts only and never branches on the
 * implementation behind them.
 *
 * Every provider self-describes through `descriptor` so registries, shadow
 * runs, and analyses can record exact provenance.
 */

export interface ProviderDescriptor {
  /** Stable id, e.g. "biomech.geometry", "scorer.sm-v1". */
  providerId: string;
  modelVersion: string;
  runtime: ModelRuntime;
  executionTarget: ExecutionTarget;
  artifactHash: string | null;
  inputSchemaVersion: number;
  outputSchemaVersion: number;
}

/** Canonical sequence-in, prediction-out stroke classifier. */
export interface IStrokeClassifier {
  readonly descriptor: ProviderDescriptor;
  classify(input: {
    pose: PoseSequence;
    paddle: PaddleTrack | null;
    ball: BallTrack | null;
  }): Promise<Result<StrokePrediction>>;
}

/** Court keypoints/homography from the clip. */
export interface ICourtDetector {
  readonly descriptor: ProviderDescriptor;
  detectCourt(input: { pose: PoseSequence }): Promise<Result<CourtGeometry>>;
}

/** Camera intrinsics / metric scale estimation. */
export interface ICameraCalibrator {
  readonly descriptor: ProviderDescriptor;
  calibrate(input: {
    pose: PoseSequence;
    court: CourtGeometry | null;
  }): Promise<Result<CameraCalibration>>;
}

/** Learned temporal representation of the whole swing. */
export interface ITemporalFeatureEncoder {
  readonly descriptor: ProviderDescriptor;
  encode(input: {
    pose: PoseSequence;
    paddle: PaddleTrack | null;
    ball: BallTrack | null;
  }): Promise<Result<LearnedEmbedding>>;
}

/**
 * Biomechanics extraction: measured, explainable features. geometry-1 is the
 * current production implementation of THIS contract — one signal among the
 * modalities, not "the model".
 */
export interface IBiomechanicsExtractor {
  readonly descriptor: ProviderDescriptor;
  extract(input: {
    pose: PoseSequence;
    paddle: PaddleTrack | null;
    phases: PhaseSpan[];
    shotType: ShotTypeSlug;
    handedness: Handedness;
    cameraView: "side" | "rear_oblique";
  }): Promise<Result<Measurement[]>>;
}

/** Fusion-facing scoring contract. sm-v1 is one implementation. */
export interface ITechniqueScorer {
  readonly descriptor: ProviderDescriptor;
  score(input: {
    shotType: ShotTypeSlug;
    measurements: Measurement[];
    embedding: LearnedEmbedding | null;
  }): Promise<
    Result<{
      overallScore: number | null;
      checkpoints: CheckpointScore[];
      analysisConfidence: number;
      presentation: "normal" | "lower_confidence" | "abstain";
      guidance: string | null;
      /** Which measured metrics grounded each checkpoint — evidence source. */
      checkpointEvidence: Array<{ checkpoint: string; metricKeys: string[] }>;
      /** Scorer-internal detail forwarded to fault/coaching stages. */
      internal: unknown;
    }>
  >;
}

export interface IFaultDetector {
  readonly descriptor: ProviderDescriptor;
  detectFaults(input: {
    shotType: ShotTypeSlug;
    checkpoints: CheckpointScore[];
    scorerInternal: unknown;
  }): Promise<Result<DetectedFault[]>>;
}

export interface IUncertaintyEstimator {
  readonly descriptor: ProviderDescriptor;
  estimate(input: {
    checkpoints: CheckpointScore[];
    analysisConfidence: number;
    presentation: "normal" | "lower_confidence" | "abstain";
    modalitiesUsed: { pose: boolean; paddle: boolean; ball: boolean; court: boolean };
  }): Promise<Result<UncertaintySummary>>;
}

export interface ICoachingRanker {
  readonly descriptor: ProviderDescriptor;
  rank(input: {
    shotType: ShotTypeSlug;
    scorerInternal: unknown;
    focusCheckpoint?: string;
  }): Promise<Result<PriorityFix | null>>;
}
