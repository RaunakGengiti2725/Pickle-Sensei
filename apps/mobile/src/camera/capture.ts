import {
  PICKLEBALL_TECHNIQUES,
  type PickleballTechniqueSlug,
} from '@pickle/shared-types';
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription,
} from 'react-native';

export type StrokeRecognition =
  | {
      status: 'recognized';
      shotType: PickleballTechniqueSlug;
      confidence: number;
      modelVersion: string;
      reason?: never;
    }
  | {
      status: 'unknown' | 'abstained';
      reason: string;
      shotType?: never;
      confidence?: number;
      modelVersion?: string;
    };

export interface AutomaticStrokeTrigger {
  startMs: number;
  endMs: number;
  peakMotionMs?: number;
  confidence: number;
  source: 'temporal_pose_motion';
  modelVersion: string;
}

export const CAPTURE_EVIDENCE_JOINTS = [
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export type CaptureEvidenceJoint = (typeof CAPTURE_EVIDENCE_JOINTS)[number];

export interface CaptureJointMotionEvidence {
  joint: CaptureEvidenceJoint;
  sampleCount: number;
  meanNormalizedPerSecond: number;
  peakNormalizedPerSecond: number;
}

/**
 * Measured pose evidence for the detector's motion window. Motion values use
 * normalized 2D image coordinates; they are not physical speed or power.
 */
export interface CaptureEvidenceV1 {
  schemaVersion: 1;
  window: 'detected_motion';
  poseSource: 'apple_vision_body_pose' | 'mediapipe_pose_landmarker';
  poseModelVersion: string;
  triggerAlgorithmVersion: string;
  motionUnit: 'normalized_image_units_per_second';
  analysisInputFrameCount: number;
  poseFrameCount: number;
  poseMissingFrameCount: number;
  trackedDurationMs: number;
  meanCanonicalJointVisibility: number;
  meanJointCoverage: number;
  minimumJointCoverage: number;
  fullBodyVisibleFrameCount: number;
  jointMotion: CaptureJointMotionEvidence[];
}

export type BallSpeedUnavailableReason =
  | 'analysis_not_run'
  | 'calibrated_ball_tracker_unavailable'
  | 'camera_not_calibrated'
  | 'frame_rate_too_low'
  | 'track_too_short'
  | 'out_of_plane_motion'
  | 'low_confidence';

export type BallSpeedEvidence =
  | {
      status: 'unavailable';
      reason: BallSpeedUnavailableReason;
    }
  | {
      status: 'measured';
      milesPerHour: number;
      metersPerSecond: number;
      confidence: number;
      source: 'calibrated_monocular_ball_track';
      calibrationId: string;
      trackerModelVersion: string;
      measurementFrameRate: number;
      trackPointCount: number;
      trackedDistanceMeters: number;
      trackedDurationMs: number;
      reprojectionErrorPx: number;
    };

/** Maximum accepted image-space calibration residual for a measured ball track. */
export const MAX_BALL_SPEED_REPROJECTION_ERROR_PX = 3;

const PICKLEBALL_TECHNIQUE_SLUGS = new Set<string>(
  PICKLEBALL_TECHNIQUES.map(technique => technique.slug),
);

interface CapturedClipBase {
  uri: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  byteSize?: number;
  capturedAtIso: string;
  recognition: StrokeRecognition;
}

export type CaptureCompletionStrategy = 'fixed' | 'adaptive';

/**
 * D-029 adaptive-completion decision constants, frozen for telemetry schema
 * v1. These mirror `packages/swing-lab/src/eventCompletionBench.ts` and the
 * native `StrokeCompletionMonitor.Params` verbatim; a native retune must bump
 * the schema version, so a v1 record always replays with exactly these rules.
 */
export const CAPTURE_COMPLETION_PARAMS_V1 = {
  settleFloorPerSecond: 0.15,
  settlePeakFraction: 0.25,
  settleHoldMs: 400,
  minFollowThroughMs: 300,
  safetyMaxMs: 2500,
  valleyDipFraction: 0.6,
  valleyRiseRatio: 1.5,
  valleyRiseMinGapMs: 80,
} as const;

/**
 * D-029 live movement-completion instrumentation, recorded by guided capture
 * for BOTH strategies (the shipped fixed post-roll and the flagged adaptive
 * candidate). Timestamps are clip-relative like the trigger block. Optional:
 * clips from builds that predate the instrument simply lack it. Motion values
 * are normalized-image units/second — never physical speed.
 *
 *  - `completionStrategy` — what actually finalized THIS clip. Default builds
 *    always say 'fixed'; 'adaptive' requires the explicit bridge switch.
 *  - `movementCompleteMs` — the detector's movement end (equals trigger.endMs).
 *  - `anchorMs` — the D-029 decision anchor (trigger peak motion).
 *  - `finalizeMs` — frame time when the live pipeline committed to stop.
 *  - `settleDetectedMs` / `valleyDetectedMs` / `safetyMaxHit` — the adaptive
 *    decision (shadow-only under 'fixed'); at most one fires per capture.
 *  - `postCompletionMotion` — bounded (≤50 samples) post-anchor wrist-motion
 *    series so offline replay can re-run both policies on real captures.
 */
export interface CaptureCompletionTelemetryV1 {
  schemaVersion: 1;
  completionStrategy: CaptureCompletionStrategy;
  algorithmVersion: string;
  motionUnit: 'normalized_image_units_per_second';
  movementCompleteMs: number;
  anchorMs: number;
  finalizeMs: number;
  peakMotionValue: number;
  settleDetectedMs?: number;
  valleyDetectedMs?: number;
  safetyMaxHit: boolean;
  observedUntilMs: number;
  observedSampleCount: number;
  params: typeof CAPTURE_COMPLETION_PARAMS_V1;
  postCompletionMotion: Array<{ tMs: number; v: number }>;
}

/** Bounded-evidence cap for `postCompletionMotion` (D-023 pattern). */
export const MAX_COMPLETION_MOTION_SAMPLES = 50;

/**
 * Durable reference to the framework-neutral pose sequence recorded beside
 * the clip (`pickle.pose-sequence.v1`). Optional: legacy captures and builds
 * that predate pose retention simply lack it — an honest absence that keeps
 * them un-analyzable rather than reconstructed.
 */
export interface PoseSequenceSidecarRef {
  schemaVersion: 1;
  format: 'pickle.pose-sequence.v1';
  uri: string;
  frameCount: number;
  sha256: string;
  coordinateSystem: 'normalized_image_top_left';
  poseModelVersion: string;
}

export type CapturedClip =
  | (CapturedClipBase & {
      captureMode: 'automatic_pose_trigger';
      trigger: AutomaticStrokeTrigger;
      /** Live target lock from camera setup. The user taps WHERE THEY WILL
       * START, walks out, and the person occupying that region becomes the
       * target (source: 'start_region_occupancy' | 'gesture_confirmed').
       * Normalized capture-space PERSON anchor at lock time. */
      targetSeed?: { x: number; y: number; source: string };
      captureEvidence: CaptureEvidenceV1;
      ballSpeed: BallSpeedEvidence;
      preRollMs: number;
      postRollMs: number;
      poseSequence?: PoseSequenceSidecarRef;
      /** D-029 movement-completion instrumentation (absent on older builds). */
      completion?: CaptureCompletionTelemetryV1;
    })
  | (CapturedClipBase & {
      captureMode: 'imported_video';
      trigger?: never;
      captureEvidence?: never;
      ballSpeed: {
        status: 'unavailable';
        reason: 'analysis_not_run';
      };
      preRollMs?: never;
      postRollMs?: never;
      poseSequence?: never;
      completion?: never;
    });

export type CameraReadinessState =
  | 'no_person'
  | 'full_body_required'
  | 'move_closer'
  | 'move_farther'
  | 'hold_still'
  | 'ready';

interface CameraEventBase {
  captureId?: string;
  emittedAtIso: string;
}

export type CameraEvent =
  | (CameraEventBase & {
      type: 'permission';
      state: 'requesting' | 'granted' | 'denied';
    })
  | (CameraEventBase & {
      type: 'session';
      state:
        | 'configured'
        | 'starting'
        | 'observing'
        | 'armed'
        | 'disarmed'
        | 'interrupted'
        | 'interruption_ended'
        | 'stopped';
      reason?: string;
    })
  | (CameraEventBase & {
      type: 'readiness';
      state: CameraReadinessState;
      poseConfidence: number;
      jointCoverage: number;
      stableForMs: number;
      missingJoints: string[];
      source: 'apple_vision_body_pose' | 'mediapipe_pose_landmarker';
      modelVersion: string;
    })
  | (CameraEventBase & {
      type: 'stroke_detected';
      startTimestampMs: number;
      endTimestampMs: number;
      peakMotionTimestampMs?: number;
      confidence: number;
      detectionModelVersion: string;
      recognition: StrokeRecognition;
    })
  | (CameraEventBase & {
      type: 'processing';
      state: 'preparing_clip';
    })
  | (CameraEventBase & {
      type: 'completed';
      recognition: StrokeRecognition;
    })
  | (CameraEventBase & {
      type: 'abstained';
      reason: string;
      message?: string;
    })
  | (CameraEventBase & {
      type: 'import';
      state: 'selecting' | 'copying' | 'completed';
    });

interface NativeVideoCapture {
  capture(): Promise<unknown>;
  importVideo(): Promise<unknown>;
  readTextFile?(uri: string): Promise<string>;
  setCompletionStrategy?(strategy: string): Promise<string>;
  cancel(): void;
  addListener(eventType: string): void;
  removeListeners(count: number): void;
}

const native = (NativeModules as { PickleVideoCapture?: NativeVideoCapture })
  .PickleVideoCapture;

export function cameraAvailable(): boolean {
  return (
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    typeof native?.capture === 'function'
  );
}

export function videoImportAvailable(): boolean {
  return (
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    typeof native?.importVideo === 'function'
  );
}

export async function captureStrokeVideo(): Promise<CapturedClip> {
  if (!native?.capture) {
    throw new Error(
      'Real guided camera capture is not available on this device.',
    );
  }
  return assertCapturedClip(await native.capture(), 'automatic_pose_trigger');
}

export async function importStrokeVideo(): Promise<CapturedClip> {
  if (!native?.importVideo) {
    throw new Error('Real video import is not available on this device.');
  }
  return assertCapturedClip(await native.importVideo(), 'imported_video');
}

export function cancelCameraOperation(): void {
  native?.cancel?.();
}

export function subscribeToCameraEvents(
  listener: (event: CameraEvent) => void,
): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(
    (NativeModules as { PickleVideoCapture?: NativeVideoCapture })
      .PickleVideoCapture,
  );
  const subscription: EmitterSubscription = emitter.addListener(
    'PickleCameraEvent',
    (event: object) => listener(event as CameraEvent),
  );
  return () => subscription.remove();
}

export function assertCapturedClip(
  value: unknown,
  expectedMode?: CapturedClip['captureMode'],
): CapturedClip {
  if (!isRecord(value)) throw invalidClip();
  const mode = value.captureMode;
  if (
    (mode !== 'automatic_pose_trigger' && mode !== 'imported_video') ||
    (expectedMode !== undefined && mode !== expectedMode)
  ) {
    throw invalidClip();
  }
  if (
    typeof value.uri !== 'string' ||
    !value.uri.startsWith('file:') ||
    !isPositiveFinite(value.durationMs) ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    typeof value.fps !== 'number' ||
    !Number.isFinite(value.fps) ||
    value.fps < 0 ||
    (value.byteSize !== undefined && !isPositiveInteger(value.byteSize)) ||
    typeof value.capturedAtIso !== 'string' ||
    Number.isNaN(Date.parse(value.capturedAtIso)) ||
    !isRecognition(value.recognition)
  ) {
    throw invalidClip();
  }

  if (mode === 'automatic_pose_trigger') {
    if (
      !isTrigger(value.trigger, value.durationMs) ||
      !isCaptureEvidence(value.captureEvidence, value.trigger) ||
      !isBallSpeedEvidence(value.ballSpeed, value.durationMs) ||
      (value.ballSpeed.status === 'unavailable' &&
        value.ballSpeed.reason === 'analysis_not_run') ||
      !isBoundedDuration(value.preRollMs, value.durationMs) ||
      !isBoundedDuration(value.postRollMs, value.durationMs) ||
      (value.poseSequence !== undefined &&
        !isPoseSequenceRef(value.poseSequence)) ||
      (value.completion !== undefined &&
        !isCompletionTelemetry(value.completion, value.trigger))
    ) {
      throw invalidClip();
    }
  } else if (
    value.trigger !== undefined ||
    value.captureEvidence !== undefined ||
    value.preRollMs !== undefined ||
    value.postRollMs !== undefined ||
    value.poseSequence !== undefined ||
    value.completion !== undefined ||
    !isAnalysisNotRunBallSpeed(value.ballSpeed)
  ) {
    throw invalidClip();
  }
  return value as unknown as CapturedClip;
}

/**
 * D-029 completion telemetry validation. Cross-checks the trigger block so a
 * fabricated or drifted record cannot pass: the movement end must be the
 * trigger's end, the anchor must be the trigger's peak, the decision fields
 * must be mutually exclusive, the sample series must be bounded/increasing,
 * and the v1 params must be exactly the benched D-029 constants.
 */
function isCompletionTelemetry(
  value: unknown,
  trigger: AutomaticStrokeTrigger,
): value is CaptureCompletionTelemetryV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    (value.completionStrategy !== 'fixed' &&
      value.completionStrategy !== 'adaptive') ||
    !isNonEmptyString(value.algorithmVersion) ||
    value.motionUnit !== 'normalized_image_units_per_second' ||
    !isNonNegativeFinite(value.movementCompleteMs) ||
    value.movementCompleteMs !== trigger.endMs ||
    !isNonNegativeFinite(value.anchorMs) ||
    value.anchorMs !== (trigger.peakMotionMs ?? trigger.endMs) ||
    !isNonNegativeFinite(value.finalizeMs) ||
    value.finalizeMs < value.movementCompleteMs ||
    !isNonNegativeFinite(value.peakMotionValue) ||
    typeof value.safetyMaxHit !== 'boolean' ||
    !isNonNegativeFinite(value.observedUntilMs) ||
    value.observedUntilMs < value.movementCompleteMs ||
    !isNonNegativeInteger(value.observedSampleCount)
  ) {
    return false;
  }

  // The adaptive decision is single-shot: settle, valley, or safety max.
  const decisions =
    (value.settleDetectedMs !== undefined ? 1 : 0) +
    (value.valleyDetectedMs !== undefined ? 1 : 0) +
    (value.safetyMaxHit === true ? 1 : 0);
  if (decisions > 1) return false;
  if (
    value.settleDetectedMs !== undefined &&
    (!isNonNegativeFinite(value.settleDetectedMs) ||
      value.settleDetectedMs < value.anchorMs)
  ) {
    return false;
  }
  if (
    value.valleyDetectedMs !== undefined &&
    (!isNonNegativeFinite(value.valleyDetectedMs) ||
      value.valleyDetectedMs < value.anchorMs)
  ) {
    return false;
  }

  const expectedParams = CAPTURE_COMPLETION_PARAMS_V1 as Record<string, number>;
  const params = value.params;
  if (!isRecord(params)) return false;
  const paramKeys = Object.keys(expectedParams);
  if (Object.keys(params).length !== paramKeys.length) return false;
  for (const key of paramKeys) {
    if (params[key] !== expectedParams[key]) return false;
  }

  const samples = value.postCompletionMotion;
  if (!Array.isArray(samples)) return false;
  if (samples.length > MAX_COMPLETION_MOTION_SAMPLES) return false;
  if (samples.length > value.observedSampleCount) return false;
  let previousTMs = -1;
  for (const sample of samples) {
    if (!isRecord(sample)) return false;
    if (
      !isNonNegativeInteger(sample.tMs) ||
      sample.tMs <= previousTMs ||
      sample.tMs < value.anchorMs ||
      !isNonNegativeFinite(sample.v)
    ) {
      return false;
    }
    previousTMs = sample.tMs;
  }
  return true;
}

function isPoseSequenceRef(value: unknown): value is PoseSequenceSidecarRef {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.format === 'pickle.pose-sequence.v1' &&
    typeof value.uri === 'string' &&
    value.uri.startsWith('file:') &&
    isPositiveInteger(value.frameCount) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    value.coordinateSystem === 'normalized_image_top_left' &&
    isNonEmptyString(value.poseModelVersion)
  );
}

/**
 * Reads a private capture artifact (pose-sequence sidecar) as text. Native
 * enforces that only files inside the app's capture storage are readable.
 */
export async function readCaptureArtifact(uri: string): Promise<string> {
  if (!native?.readTextFile) {
    throw new Error('Capture artifact reading is not available in this build.');
  }
  return native.readTextFile(uri);
}

/**
 * D-029 instrumentation switch: selects the movement-completion strategy for
 * FUTURE guided captures on this launch. The native default is always
 * 'fixed' (the shipped post-roll); 'adaptive' is the measured D-029 candidate
 * and is NOT promoted — flipping it is an explicit measurement act, never
 * persisted. Resolves with the strategy native actually applied and throws
 * when the switch is unavailable, so a caller can never silently believe a
 * strategy is active.
 */
export async function setCaptureCompletionStrategy(
  strategy: CaptureCompletionStrategy,
): Promise<CaptureCompletionStrategy> {
  if (!native?.setCompletionStrategy) {
    throw new Error(
      'Completion strategy switching is not available in this build.',
    );
  }
  const applied = await native.setCompletionStrategy(strategy);
  if (applied !== 'fixed' && applied !== 'adaptive') {
    throw new Error(
      'The native camera reported an unknown completion strategy.',
    );
  }
  return applied;
}

function isRecognition(value: unknown): value is StrokeRecognition {
  if (!isRecord(value)) return false;
  if (value.status === 'recognized') {
    return (
      isPickleballTechniqueSlug(value.shotType) &&
      isPositiveUnitInterval(value.confidence) &&
      isNonEmptyString(value.modelVersion) &&
      value.reason === undefined
    );
  }
  return (
    (value.status === 'unknown' || value.status === 'abstained') &&
    isNonEmptyString(value.reason) &&
    value.shotType === undefined &&
    (value.confidence === undefined || isUnitInterval(value.confidence)) &&
    (value.modelVersion === undefined || isNonEmptyString(value.modelVersion))
  );
}

function isTrigger(
  value: unknown,
  clipDurationMs: number,
): value is AutomaticStrokeTrigger {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeFinite(value.startMs) &&
    isPositiveFinite(value.endMs) &&
    value.endMs > value.startMs &&
    value.endMs <= clipDurationMs &&
    value.contactMs === undefined &&
    (value.peakMotionMs === undefined ||
      (isNonNegativeFinite(value.peakMotionMs) &&
        value.peakMotionMs >= value.startMs &&
        value.peakMotionMs <= value.endMs)) &&
    isUnitInterval(value.confidence) &&
    value.source === 'temporal_pose_motion' &&
    isNonEmptyString(value.modelVersion)
  );
}

function isCaptureEvidence(
  value: unknown,
  trigger: AutomaticStrokeTrigger,
): value is CaptureEvidenceV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    value.window !== 'detected_motion' ||
    (value.poseSource !== 'apple_vision_body_pose' &&
      value.poseSource !== 'mediapipe_pose_landmarker') ||
    !isNonEmptyString(value.poseModelVersion) ||
    !isNonEmptyString(value.triggerAlgorithmVersion) ||
    value.triggerAlgorithmVersion !== trigger.modelVersion ||
    value.motionUnit !== 'normalized_image_units_per_second' ||
    !isPositiveInteger(value.analysisInputFrameCount) ||
    !isPositiveInteger(value.poseFrameCount) ||
    !isNonNegativeInteger(value.poseMissingFrameCount) ||
    value.analysisInputFrameCount !==
      value.poseFrameCount + value.poseMissingFrameCount ||
    !isNonNegativeInteger(value.trackedDurationMs) ||
    value.trackedDurationMs > trigger.endMs - trigger.startMs ||
    !isUnitInterval(value.meanCanonicalJointVisibility) ||
    !isUnitInterval(value.meanJointCoverage) ||
    !isUnitInterval(value.minimumJointCoverage) ||
    value.minimumJointCoverage > value.meanJointCoverage ||
    !isNonNegativeInteger(value.fullBodyVisibleFrameCount) ||
    value.fullBodyVisibleFrameCount > value.poseFrameCount ||
    !Array.isArray(value.jointMotion) ||
    value.jointMotion.length === 0 ||
    value.jointMotion.length > CAPTURE_EVIDENCE_JOINTS.length
  ) {
    return false;
  }

  let previousJointIndex = -1;
  for (const measurement of value.jointMotion) {
    if (!isRecord(measurement)) return false;
    const jointIndex = CAPTURE_EVIDENCE_JOINTS.indexOf(
      measurement.joint as CaptureEvidenceJoint,
    );
    if (
      jointIndex <= previousJointIndex ||
      !isPositiveInteger(measurement.sampleCount) ||
      measurement.sampleCount >= value.poseFrameCount ||
      !isNonNegativeFinite(measurement.meanNormalizedPerSecond) ||
      !isNonNegativeFinite(measurement.peakNormalizedPerSecond) ||
      measurement.peakNormalizedPerSecond < measurement.meanNormalizedPerSecond
    ) {
      return false;
    }
    previousJointIndex = jointIndex;
  }
  return true;
}

function isBallSpeedEvidence(
  value: unknown,
  clipDurationMs: number,
): value is BallSpeedEvidence {
  if (!isRecord(value)) return false;
  if (value.status === 'unavailable') {
    return (
      isBallSpeedUnavailableReason(value.reason) &&
      value.milesPerHour === undefined &&
      value.metersPerSecond === undefined
    );
  }
  if (value.status !== 'measured') return false;
  if (
    !isPositiveFinite(value.milesPerHour) ||
    !isPositiveFinite(value.metersPerSecond) ||
    !isPositiveUnitInterval(value.confidence) ||
    value.source !== 'calibrated_monocular_ball_track' ||
    !isNonEmptyString(value.calibrationId) ||
    !isNonEmptyString(value.trackerModelVersion) ||
    typeof value.measurementFrameRate !== 'number' ||
    !Number.isFinite(value.measurementFrameRate) ||
    value.measurementFrameRate < 100 ||
    !isPositiveInteger(value.trackPointCount) ||
    value.trackPointCount < 5 ||
    !isPositiveFinite(value.trackedDistanceMeters) ||
    !isPositiveInteger(value.trackedDurationMs) ||
    value.trackedDurationMs > clipDurationMs ||
    !isNonNegativeFinite(value.reprojectionErrorPx) ||
    value.reprojectionErrorPx > MAX_BALL_SPEED_REPROJECTION_ERROR_PX ||
    value.reason !== undefined
  ) {
    return false;
  }
  const convertedMph = value.metersPerSecond * 2.2369362920544;
  const toleranceMph = Math.max(0.01, convertedMph * 0.001);
  const trajectoryMetersPerSecond =
    value.trackedDistanceMeters / (value.trackedDurationMs / 1_000);
  const trajectoryTolerance = Math.max(0.02, trajectoryMetersPerSecond * 0.01);
  // Duration is integer milliseconds, so ceil permits the single interval that
  // can straddle a rounded millisecond while still rejecting impossible tracks.
  const maximumTrackPointCount =
    Math.ceil((value.measurementFrameRate * value.trackedDurationMs) / 1_000) +
    1;
  return (
    value.trackPointCount <= maximumTrackPointCount &&
    Math.abs(value.milesPerHour - convertedMph) <= toleranceMph &&
    Math.abs(value.metersPerSecond - trajectoryMetersPerSecond) <=
      trajectoryTolerance
  );
}

function isAnalysisNotRunBallSpeed(
  value: unknown,
): value is Extract<BallSpeedEvidence, { status: 'unavailable' }> {
  return (
    isRecord(value) &&
    value.status === 'unavailable' &&
    value.reason === 'analysis_not_run' &&
    value.milesPerHour === undefined &&
    value.metersPerSecond === undefined
  );
}

function isBallSpeedUnavailableReason(
  value: unknown,
): value is BallSpeedUnavailableReason {
  return (
    value === 'analysis_not_run' ||
    value === 'calibrated_ball_tracker_unavailable' ||
    value === 'camera_not_calibrated' ||
    value === 'frame_rate_too_low' ||
    value === 'track_too_short' ||
    value === 'out_of_plane_motion' ||
    value === 'low_confidence'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isPositiveUnitInterval(value: unknown): value is number {
  return isUnitInterval(value) && value > 0;
}

function isPickleballTechniqueSlug(
  value: unknown,
): value is PickleballTechniqueSlug {
  return typeof value === 'string' && PICKLEBALL_TECHNIQUE_SLUGS.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoundedDuration(value: unknown, maximum: number): value is number {
  return isNonNegativeFinite(value) && value <= maximum;
}

function invalidClip(): Error {
  return new Error(
    'The native camera returned an invalid or incomplete video result.',
  );
}
