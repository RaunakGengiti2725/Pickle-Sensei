import type {
  AnalysisSource,
  CameraView,
  Handedness,
  Measurement,
  PaddleFrame,
  PhaseSpan,
  PoseFrame,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";

/**
 * Vision subsystem contracts (directive §61). The real implementations live in
 * native/vision-core; the app orchestrates through these interfaces so real
 * models replace test implementations cleanly via dependency injection.
 */

export interface VideoClipRef {
  /** Local file URI or test-only identifier. */
  uri: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

export interface StrokeEvent {
  /** Candidate stroke window inside the clip/stream. */
  startMs: number;
  endMs: number;
  /** Probable contact neighborhood, null when not established. */
  contactMs: number | null;
  shotTypeHypothesis: ShotTypeSlug | null;
  confidence: number;
}

export interface IPoseProvider {
  readonly modelVersion: string;
  readonly source: AnalysisSource;
  extractPose(
    clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<Result<PoseFrame[]>>;
}

export interface IPaddleDetector {
  readonly modelVersion: string;
  readonly source: AnalysisSource;
  detectPaddle(
    clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<Result<PaddleFrame[]>>;
}

export interface IStrokeDetector {
  readonly modelVersion: string;
  readonly source: AnalysisSource;
  detectStrokes(clip: VideoClipRef): Promise<Result<StrokeEvent[]>>;
}

export interface IPhaseSegmenter {
  readonly modelVersion: string;
  readonly source: AnalysisSource;
  segmentPhases(
    poseFrames: PoseFrame[],
    paddleFrames: PaddleFrame[],
    stroke: StrokeEvent,
  ): Promise<Result<PhaseSpan[]>>;
}

export interface IFeatureExtractor {
  readonly version: string;
  extractMeasurements(input: {
    poseFrames: PoseFrame[];
    paddleFrames: PaddleFrame[];
    phases: PhaseSpan[];
    shotType: ShotTypeSlug;
    handedness: Handedness;
    cameraView: CameraView;
  }): Promise<Result<Measurement[]>>;
}

/** Ball tracking is architected now, gated later (directive §17). */
export interface BallDetection {
  timestampMs: number;
  x: number;
  y: number;
  confidence: number;
}
export interface BallTrack {
  detections: BallDetection[];
  continuity: number;
}
export interface ContactHypothesis {
  timestampMs: number;
  confidence: number;
}
export interface Trajectory {
  points: Array<{ timestampMs: number; x: number; y: number }>;
  confidence: number;
}
export interface IBallTracker {
  readonly modelVersion: string;
  readonly source: AnalysisSource;
  trackBall(
    clip: VideoClipRef,
    window: { startMs: number; endMs: number },
  ): Promise<
    Result<{ track: BallTrack; contact: ContactHypothesis | null; trajectory: Trajectory | null }>
  >;
}

/** Bundle of providers the analysis pipeline consumes. */
export interface VisionProviderSet {
  readonly source: AnalysisSource;
  pose: IPoseProvider;
  paddle: IPaddleDetector;
  stroke: IStrokeDetector;
  phase: IPhaseSegmenter;
  features: IFeatureExtractor;
  /** Optional until ball tracking ships. */
  ball: IBallTracker | null;
}
