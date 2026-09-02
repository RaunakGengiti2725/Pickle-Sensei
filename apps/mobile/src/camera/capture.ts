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
import { stabilitySlo } from '../analysis/stabilityTelemetry';

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
  /**
   * Optional still-frame poster written beside the clip (file: URI), used
   * for tap-target previews. Absent on builds that predate it — the UI must
   * degrade honestly, never fabricate a frame.
   */
  posterUri?: string;
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
 * Live target-acquisition constants, frozen for telemetry schema v1. These
 * mirror the promoted D-027 `GuidedCaptureViewController` acquisition
 * verbatim; a native retune must bump the schema version, so a v1 record
 * always replays with exactly these rules.
 */
export const TARGET_LOCK_PARAMS_V1 = {
  startRegionRadius: 0.17,
  occupancyFramesToLock: 9,
  sustainedGestureFrames: 5,
  ambiguityTimeoutMs: 3000,
  gestureElevationThreshold: 0.03,
} as const;

/** Live lock sources the shipped (D-027) acquisition can emit. */
export type TargetLockSource =
  'start_region_occupancy' | 'gesture_confirmed' | 'ambiguity_timeout';

/**
 * Live target-lock instrumentation, recorded by guided capture whenever the
 * user tapped a start region (always-on; acquisition behavior is unchanged —
 * the shipped D-027 configuration stays default). Persisted with the clip so
 * an offline replay can run the D-027-style promotion gate for acquire-v4's
 * tap-centered lock gate against real live taps. Points are normalized
 * capture space like `targetSeed`; durations are camera-clock milliseconds
 * (never rebased — the lock happens before the exported clip window).
 *
 *  - `tapPoint` — where the user tapped (the start region center).
 *  - `lockTorso` — the acquired track's torso center at the lock frame (its
 *    earliest identity; the anchor the follower is seeded with).
 *  - `tapToLockDistance` — hypot(lockTorso − tapPoint), the acquire-v4 gate
 *    signal.
 *  - `timeToLockMs` — first acquisition frame after the tap → lock frame.
 *  - `ambiguityEntered` / `ambiguityDurationMs` — whether the ≥2-occupant
 *    ambiguity state was entered and how long it lasted (to the lock, or to
 *    the last acquisition frame when no lock happened).
 *  - `lockOutcome` — 'locked' or 'no_lock' (capture completed without one).
 */
export interface TargetLockTelemetryV1 {
  schemaVersion: 1;
  algorithmVersion: string;
  coordinateSystem: 'normalized_capture_space';
  tapPoint: { x: number; y: number };
  lockOutcome: 'locked' | 'no_lock';
  lockSource?: TargetLockSource;
  lockTorso?: { x: number; y: number };
  tapToLockDistance?: number;
  timeToLockMs?: number;
  ambiguityEntered: boolean;
  ambiguityDurationMs?: number;
  params: typeof TARGET_LOCK_PARAMS_V1;
}

/** Tolerance for the recomputed tap-to-lock distance (JSON float round-trip). */
export const TARGET_LOCK_DISTANCE_TOLERANCE = 1e-6;

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
      /** Target-lock instrumentation (absent when the user never tapped a
       * start region, and on builds that predate the instrument). */
      targetLock?: TargetLockTelemetryV1;
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
      targetLock?: never;
      captureEvidence?: never;
      ballSpeed: {
        status: 'unavailable';
        reason: 'analysis_not_run';
      };
      preRollMs?: never;
      postRollMs?: never;
      /** Real measured pose sequence for the imported file, attached by the
       * explicit `extractImportedPoseSequence` pass (never by the import
       * itself). Absent until that pass has actually run and succeeded. */
      poseSequence?: PoseSequenceSidecarRef;
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

/**
 * Typed native contract for on-device-computable capture-envelope signals.
 * Resolution/fps come from the configured camera format; brightness, blur
 * and camera-motion proxies are computed over sampled preview frames using
 * the SAME normalization the offline prober uses (grayscale, 320px-wide
 * downscale) so `capture-envelope-thresholds-v0.1-provisional` applies.
 *
 * The Swift side of this contract is CONTRACT-ONLY and UNVERIFIED-ON-DEVICE
 * (native/vision-core/Sources/CaptureQualitySignals.swift): no emitter is
 * wired in this build, so no `capture_quality` event fires yet. A field the
 * emitter cannot compute is null — the envelope checker reports that
 * dimension NOT_MEASURED rather than guessing.
 */
export interface CaptureQualitySignalsV1 {
  schemaVersion: 1;
  /** Configured capture format, physical pixels. */
  frameWidthPx: number | null;
  frameHeightPx: number | null;
  /** Configured (or measured over the sample window) capture frame rate. */
  avgFrameRateFps: number | null;
  /** Mean luma (0–255) over sampled normalized preview frames. */
  brightnessMeanLuma: number | null;
  /** Median Laplacian variance over sampled normalized preview frames. */
  laplacianVarianceMedian: number | null;
  /** Mean abs per-pixel luma diff between consecutive sampled frames. */
  meanAbsFrameDiff: number | null;
  /** Number of preview frames the proxies were computed over. */
  sampledFrameCount: number;
}

export type CameraEvent =
  | (CameraEventBase & {
      type: 'permission';
      state: 'requesting' | 'granted' | 'denied';
    })
  | (CameraEventBase & {
      type: 'session';
      /**
       * `composing` — camera live, nothing recorded yet (shutter shown);
       * `recording_started` — the user pressed the shutter and the rolling
       * spool began; `recording_stopped` — the spool was discarded and the
       * camera returned to composing (`reason`: user_stopped |
       * observation_timeout | no_stroke_detected). `observing`/`armed`/
       * `disarmed` keep their pre-shutter-era meanings.
       */
      state:
        | 'configured'
        | 'starting'
        | 'composing'
        | 'observing'
        | 'recording_started'
        | 'recording_stopped'
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
      type: 'capture_quality';
      signals: CaptureQualitySignalsV1;
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
    })
  | (CameraEventBase & {
      /** Progress of the offline pose-extraction pass over an imported
       * file. `progress` is the native pass's real measured fraction when
       * it reports one — never synthesized on the JS side. */
      type: 'import_pose_extraction';
      state: 'extracting' | 'completed' | 'failed';
      progress?: number;
    });

interface NativeVideoCapture {
  capture(): Promise<unknown>;
  importVideo(): Promise<unknown>;
  readTextFile?(uri: string): Promise<string>;
  setCompletionStrategy?(strategy: string): Promise<string>;
  startSessionCapture?(): Promise<unknown>;
  stopSessionCapture?(sessionCaptureId: string): Promise<unknown>;
  extractSessionEventClip?(request: {
    sessionCaptureId: string;
    startMs: number;
    endMs: number;
    peakMs: number | null;
    confidence: number;
    detectionModelVersion: string;
  }): Promise<unknown>;
  extractImportedPoseSequence?(request: {
    uri: string;
    seedX?: number;
    seedY?: number;
  }): Promise<unknown>;
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

/** All three session-capture bridge methods must exist: continuous motion
 * streaming without per-event clip extraction (or vice versa) is not a
 * usable session capture, so partial builds honestly report unavailable. */
export function sessionCaptureAvailable(): boolean {
  return (
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    typeof native?.startSessionCapture === 'function' &&
    typeof native?.stopSessionCapture === 'function' &&
    typeof native?.extractSessionEventClip === 'function'
  );
}

export interface SessionCaptureReceipt {
  sessionCaptureId: string;
}

export interface SessionEventClipBounds {
  /** Exact closed-event bounds on the session time axis (ms since the first
   * streamed motion sample — the same axis those samples use). */
  startMs: number;
  endMs: number;
  peakMs: number | null;
  /** The frozen proposal's segmentation confidence, carried verbatim. */
  confidence: number;
  /** The JS session engine version that proposed the event bounds. */
  detectionModelVersion: string;
}

export async function startSessionCapture(): Promise<SessionCaptureReceipt> {
  if (!native?.startSessionCapture) {
    stabilitySlo.record({
      kind: 'camera_startup_failed',
      reason: 'session_capture_unavailable',
    });
    throw new Error('Native session capture is not available on this device.');
  }
  let receipt: unknown;
  try {
    receipt = await native.startSessionCapture();
  } catch (error) {
    stabilitySlo.record({
      kind: 'camera_startup_failed',
      reason: 'native_session_start_error',
    });
    throw error;
  }
  if (
    !isRecord(receipt) ||
    typeof receipt.sessionCaptureId !== 'string' ||
    receipt.sessionCaptureId.length === 0
  ) {
    stabilitySlo.record({
      kind: 'camera_startup_failed',
      reason: 'invalid_session_receipt',
    });
    throw new Error('The native camera returned an invalid session receipt.');
  }
  stabilitySlo.record({ kind: 'camera_startup_succeeded' });
  return { sessionCaptureId: receipt.sessionCaptureId };
}

export async function stopSessionCapture(
  sessionCaptureId: string,
): Promise<void> {
  if (!native?.stopSessionCapture) {
    throw new Error('Native session capture is not available on this device.');
  }
  await native.stopSessionCapture(sessionCaptureId);
}

/** Requests a clip cut from the rolling session recording for one closed
 * event, plus the pose sidecar sliced to the same window. The receipt is the
 * SAME validated CapturedClip contract guided capture returns — a session
 * event clip that cannot pass validation is rejected, never repaired. */
export async function extractSessionEventClip(
  sessionCaptureId: string,
  bounds: SessionEventClipBounds,
): Promise<CapturedClip> {
  if (!native?.extractSessionEventClip) {
    throw new Error(
      'Native session clip extraction is not available on this device.',
    );
  }
  const payload = await native.extractSessionEventClip({
    sessionCaptureId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    peakMs: bounds.peakMs,
    confidence: bounds.confidence,
    detectionModelVersion: bounds.detectionModelVersion,
  });
  return assertCapturedClip(payload, 'automatic_pose_trigger');
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

/**
 * Native imported-video pose extraction: an offline Vision/MediaPipe pass
 * over the copied file that records the SAME hash-addressed
 * `pickle.pose-sequence.v1` sidecar guided capture writes. Optional bridge
 * method — builds that predate it honestly report unavailable instead of
 * pretending a recorded sequence could exist.
 */
export function importedPoseExtractionAvailable(): boolean {
  return (
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    typeof native?.extractImportedPoseSequence === 'function'
  );
}

/** Validated receipt of the imported-video pose-extraction pass. */
export interface ImportedPoseExtraction {
  poseSequence: PoseSequenceSidecarRef;
  /** Still-frame poster written during extraction (file: URI), if any. */
  posterUri?: string;
  /** Frames in which the tracked person had a measured pose. */
  framesWithPose: number;
  /** Total frames the extraction pass analyzed. */
  framesTotal: number;
}

/**
 * Runs the native pose-extraction pass over an imported clip. `seed` is the
 * user's "tap yourself" point in SOURCE-normalized image coordinates (origin
 * top-left); omit it when the user skipped the tap. Native rejections keep
 * their codes (`camera.import_too_long`, `camera.import_no_person`) so the
 * screen can map them to honest copy. The receipt is validated with the same
 * strictness as `assertCapturedClip` — an invalid payload is rejected, never
 * repaired.
 */
export async function extractImportedPoseSequence(
  clip: Extract<CapturedClip, { captureMode: 'imported_video' }>,
  seed?: { x: number; y: number } | null,
): Promise<ImportedPoseExtraction> {
  if (!native?.extractImportedPoseSequence) {
    throw new Error(
      'Imported-video pose extraction is not available in this build.',
    );
  }
  if (seed && (!isUnitInterval(seed.x) || !isUnitInterval(seed.y))) {
    throw new Error(
      'The target seed must be a normalized point inside the video frame.',
    );
  }
  const payload = await native.extractImportedPoseSequence({
    uri: clip.uri,
    ...(seed ? { seedX: seed.x, seedY: seed.y } : {}),
  });
  return assertImportedPoseExtraction(payload);
}

export function assertImportedPoseExtraction(
  value: unknown,
): ImportedPoseExtraction {
  if (
    !isRecord(value) ||
    !isPoseSequenceRef(value.poseSequence) ||
    (value.posterUri !== undefined &&
      (typeof value.posterUri !== 'string' ||
        !value.posterUri.startsWith('file:'))) ||
    !isPositiveInteger(value.framesWithPose) ||
    !isPositiveInteger(value.framesTotal) ||
    value.framesWithPose > value.framesTotal
  ) {
    throw new Error(
      'The native importer returned an invalid pose-extraction result.',
    );
  }
  return {
    poseSequence: value.poseSequence,
    ...(value.posterUri !== undefined ? { posterUri: value.posterUri } : {}),
    framesWithPose: value.framesWithPose,
    framesTotal: value.framesTotal,
  };
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
    (value.posterUri !== undefined &&
      (typeof value.posterUri !== 'string' ||
        !value.posterUri.startsWith('file:'))) ||
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
        !isCompletionTelemetry(value.completion, value.trigger)) ||
      (value.targetLock !== undefined &&
        !isTargetLockTelemetry(value.targetLock, value.targetSeed))
    ) {
      throw invalidClip();
    }
  } else if (
    value.trigger !== undefined ||
    value.targetLock !== undefined ||
    value.captureEvidence !== undefined ||
    value.preRollMs !== undefined ||
    value.postRollMs !== undefined ||
    // A pose sequence on an imported clip is legitimate ONLY as the fully
    // validated sidecar ref the explicit extraction pass produces; anything
    // less is rejected, never repaired.
    (value.poseSequence !== undefined &&
      !isPoseSequenceRef(value.poseSequence)) ||
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

/**
 * Target-lock telemetry validation. Cross-checks the clip's `targetSeed`
 * so a fabricated or drifted record cannot pass: a locked record must carry
 * the seed's exact torso and source, the distance must recompute from the
 * recorded points, ambiguity-resolved sources require the ambiguity flag,
 * a timeout lock requires a duration at least the timeout, and the v1 params
 * must be exactly the shipped D-027 constants.
 */
function isTargetLockTelemetry(
  value: unknown,
  targetSeed: unknown,
): value is TargetLockTelemetryV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.algorithmVersion) ||
    value.coordinateSystem !== 'normalized_capture_space' ||
    !isNormalizedPoint(value.tapPoint) ||
    (value.lockOutcome !== 'locked' && value.lockOutcome !== 'no_lock') ||
    typeof value.ambiguityEntered !== 'boolean'
  ) {
    return false;
  }

  const expectedParams = TARGET_LOCK_PARAMS_V1 as Record<string, number>;
  const params = value.params;
  if (!isRecord(params)) return false;
  const paramKeys = Object.keys(expectedParams);
  if (Object.keys(params).length !== paramKeys.length) return false;
  for (const key of paramKeys) {
    if (params[key] !== expectedParams[key]) return false;
  }

  if (
    value.ambiguityDurationMs !== undefined &&
    (!isNonNegativeInteger(value.ambiguityDurationMs) ||
      value.ambiguityEntered !== true)
  ) {
    return false;
  }
  if (
    value.ambiguityEntered === true &&
    value.ambiguityDurationMs === undefined
  ) {
    return false;
  }

  if (value.lockOutcome === 'no_lock') {
    return (
      value.lockSource === undefined &&
      value.lockTorso === undefined &&
      value.tapToLockDistance === undefined &&
      value.timeToLockMs === undefined &&
      targetSeed === undefined
    );
  }

  if (
    !isTargetLockSource(value.lockSource) ||
    !isNormalizedPoint(value.lockTorso) ||
    !isNonNegativeFinite(value.tapToLockDistance) ||
    !isNonNegativeInteger(value.timeToLockMs)
  ) {
    return false;
  }
  const recomputed = Math.hypot(
    value.lockTorso.x - value.tapPoint.x,
    value.lockTorso.y - value.tapPoint.y,
  );
  if (
    Math.abs(value.tapToLockDistance - recomputed) >
    TARGET_LOCK_DISTANCE_TOLERANCE
  ) {
    return false;
  }
  if (
    (value.lockSource === 'gesture_confirmed' ||
      value.lockSource === 'ambiguity_timeout') &&
    value.ambiguityEntered !== true
  ) {
    return false;
  }
  if (
    value.lockSource === 'ambiguity_timeout' &&
    (value.ambiguityDurationMs === undefined ||
      value.ambiguityDurationMs < TARGET_LOCK_PARAMS_V1.ambiguityTimeoutMs)
  ) {
    return false;
  }
  return (
    isRecord(targetSeed) &&
    targetSeed.source === value.lockSource &&
    targetSeed.x === value.lockTorso.x &&
    targetSeed.y === value.lockTorso.y
  );
}

function isTargetLockSource(value: unknown): value is TargetLockSource {
  return (
    value === 'start_region_occupancy' ||
    value === 'gesture_confirmed' ||
    value === 'ambiguity_timeout'
  );
}

function isNormalizedPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isUnitInterval(value.x) && isUnitInterval(value.y);
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
