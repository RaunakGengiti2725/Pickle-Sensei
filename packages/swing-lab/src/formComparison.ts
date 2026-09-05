import { createHash } from "node:crypto";
import {
  CAMERA_VIEWS,
  PHASES,
  POSE_LANDMARK_NAMES,
  SHOT_TYPES,
  type CameraView,
  type PhaseKey,
  type PhaseSpan,
  type PoseFrame,
  type PoseLandmarkName,
  type ShotAnalysis,
  type VersionVector,
} from "@pickle/shared-types";
import {
  EXECUTION_TARGETS,
  MODEL_RUNTIMES,
  parsePoseSequence,
  toLegacyPoseFrames,
  type CaptureRecord,
  type ModelRef,
  type PoseSequence,
} from "@pickle/swing-domain";
import {
  angularDifferenceDeg,
  distance,
  frameNearest,
  interiorAngleDeg,
  landmark,
  mean,
  median,
  midpoint,
  segmentAngleDeg,
  type Point,
} from "../../vision-geometry/src/kinematics.js";

export const FORM_COMPARISON_ACCEPTANCE = Object.freeze({
  protocol: "offline-form-comparison-v1",
  enabledByDefault: false,
  applicationReachable: false,
  evaluationBasis: "deterministic_synthetic_software_invariants_only",
  baseline:
    "Direct paired 2D wrist/hip/torso geometry and projected joint angles using existing vision-geometry kinematics; original stored phase times, not scores or an ideal template.",
  reviewRequirement:
    "Hash-bound independent frame review of the original clips, or explicitly synthetic fixtures; stored cameraView and native pose sidecars alone are insufficient.",
  compatibility:
    "Same player, same nonempty session, same independently reviewed camera setup/view, capture mode, handedness, technique, source, and every VersionVector entry. Upright, unmirrored normalized-image coordinates only.",
  continuity:
    "Review every pose frame in the analysis window: one unambiguous person and stable track ID, no switch, no required-joint occlusion, target bounding box, and three labeled stationary non-collinear scene points shared by both clips. All six ordered phase spans must cover the stroke without unlabeled gaps.",
  matching:
    "Five fixed phase anchors: start, halfway to representative, representative, halfway to end, end. Nearest observed sample within its phase; earlier timestamp wins ties. No interpolation, smoothing, rotation, reflection, DTW, or retiming of observations. Deltas summarize only these anchors; full in-phase observations and original times are retained.",
  maxGapMs: 120,
  maxAnchorDistanceMs: 120,
  minDistinctSamplesPerPhase: 3,
  minVisibility: 0.3,
  minConfidence: 0.3,
  maxFrames: 10000,
  maxInputFileBytes: 16 * 1024 * 1024,
  maxVideoDimension: 16384,
  minFps: 1,
  maxFps: 240,
  maxStrokeDurationMs: 60000,
  minSamplePeriodFractionOfNominal: 0.25,
  minTorsoImageHeights: 0.05,
  maxTorsoImageHeights: 0.7,
  minBoneTorsoLengths: 0.05,
  maxBoneTorsoLengths: 2,
  maxBoneRatioWithinClip: 1.5,
  maxTorsoRatioWithinClip: 1.25,
  maxHipStepTorsoLengths: 0.5,
  maxWristStepTorsoLengths: 1,
  maxUprightDeviationDeg: 35,
  maxPairedTorsoAngleDifferenceDeg: 12,
  minHorizontalShoulderSeparationTorso: 0.05,
  maxPairedShoulderWidthDifferenceTorso: 0.15,
  maxPairedBoneRatio: 1.25,
  minSceneTriangleArea: 0.01,
  maxScenePointDriftImageHeights: 0.01,
  changeFloors: Object.freeze({ wristTorsoLengths: 0.05, jointAngleDeg: 5, timingMs: 40 }),
  thresholdMeaning:
    "Unvalidated engineering rejection and display thresholds, not measurement uncertainty, detectable improvement, statistical significance, clinical validity, or coaching validity.",
  requiredInvariants: Object.freeze([
    "disabled_without_explicit_opt_in",
    "hash_and_metadata_binding",
    "identity_translation_uniform_scale_time_offset_no_change",
    "rotation_mirror_view_capture_mode_person_session_hand_technique_model_mismatch_abstention",
    "missing_joints_occlusion_track_switch_camera_motion_outliers_timebase_gap_abstention",
    "missing_frames_at_120ms_tolerated_without_filling_longer_gaps_abstain",
    "original_timestamps_and_real_phase_durations_preserved",
    "no_interpolation_no_score_or_improvement_verdict",
  ]),
});

export const FORM_COMPARISON_EVALUATION_SCHEMA = Object.freeze({
  schemaVersion: 1,
  artifactKind: "evaluation_requirements_not_execution_results",
  protocol: FORM_COMPARISON_ACCEPTANCE.protocol,
  unit: "one_explicit_local_pair",
  requiredCaseFields: Object.freeze([
    "caseId",
    "partition",
    "expectedOutcome",
    "actualOutcome",
    "abstentionCodes",
    "originalTimestampsPreserved",
    "passed",
  ]),
  allowedPartitions: Object.freeze(["synthetic_software_invariants"]),
  outcomes: Object.freeze([
    "insufficient_evidence",
    "not_comparable",
    "no_reliable_change",
    "observed_change",
  ]),
  passRule:
    "A separate software test run must satisfy every required invariant. This criteria export contains no execution results, does not validate measurements and cannot authorize release.",
  realPairCount: 0,
  coachReviewedPairCount: 0,
  realDataValidation: "missing",
  coachValidation: "missing",
  independentPairLabels: "missing",
  sameConditionRepeatabilityDataset: "missing",
  measurementUncertaintyCalibration: "missing",
  clinicalValidation: "not_performed",
  lockedHoldoutInspected: false,
  releaseAuthorized: false,
});

export type FormComparisonOutcome =
  "insufficient_evidence" | "not_comparable" | "no_reliable_change" | "observed_change";

export interface FormComparisonEvaluationCase {
  caseId: string;
  partition: "synthetic_software_invariants";
  expectedOutcome: FormComparisonOutcome;
  actualOutcome: FormComparisonOutcome;
  abstentionCodes: string[];
  originalTimestampsPreserved: boolean;
  passed: boolean;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface FormComparisonReviewedFrame {
  frameIndex: number;
  timestampMs: number;
  playerId: string;
  trackId: string;
  personCount: number;
  identityAmbiguous: boolean;
  trackSwitch: boolean;
  cameraView: CameraView | "unknown";
  cameraStable: boolean;
  occludedJoints: string[];
  targetBox: { x: number; y: number; width: number; height: number };
  scenePoints: [ImagePoint, ImagePoint, ImagePoint];
}

export interface FormComparisonRecordingMetadata {
  analysisId: string;
  analysisSha256: string;
  poseSha256: string;
  playerId: string;
  sessionId: string;
  cameraView: CameraView;
  captureMode: CaptureRecord["captureMode"];
  handedness: "right" | "left";
  technique: ShotAnalysis["shotType"];
  versionVector: VersionVector;
  poseModel: ModelRef;
  review: {
    basis: "independent_frame_review" | "synthetic_fixture";
    evidenceId: string;
    reviewerId: string;
    clipSha256: string;
    timebase: "original_clip_ms";
    cameraSetupId: string;
    scenePointIds: [string, string, string];
    rotationDegrees: 0 | 90 | 180 | 270;
    mirrored: boolean;
    frames: FormComparisonReviewedFrame[];
  };
}

export interface FormComparisonPairMetadata {
  schemaVersion: 1;
  before: FormComparisonRecordingMetadata;
  after: FormComparisonRecordingMetadata;
}

export interface FormComparisonFiles {
  analysisBytes: Uint8Array;
  poseBytes: Uint8Array;
}

export interface FormComparisonInput {
  before: FormComparisonFiles;
  after: FormComparisonFiles;
  metadata: unknown;
}

export interface FormComparisonReason {
  code: string;
  detail: string;
  side: "before" | "after" | null;
  phase: PhaseKey | null;
}

export interface FormObservation {
  frameIndex: number;
  timestampMs: number;
  wristTorso: ImagePoint;
  elbowAngleDeg: number;
  shoulderAngleDeg: number;
  torsoImageHeights: number;
}

export interface FormPhaseComparison {
  phase: PhaseKey;
  phaseMeaning: "stored_phase_label_only_not_verified_contact_or_event_truth";
  outcome: FormComparisonOutcome;
  reasons: FormComparisonReason[];
  timing: {
    before: PhaseSpan & { durationMs: number; startFromStrokeMs: number };
    after: PhaseSpan & { durationMs: number; startFromStrokeMs: number };
    durationDeltaMs: number;
    startFromStrokeDeltaMs: number;
    representativeFromStrokeDeltaMs: number;
  };
  beforeTrajectory: FormObservation[];
  afterTrajectory: FormObservation[];
  matches: Array<{
    anchor: "start" | "pre_representative" | "representative" | "post_representative" | "end";
    beforeTargetMs: number;
    afterTargetMs: number;
    before: FormObservation;
    after: FormObservation;
    wristDeltaTorso: ImagePoint;
    elbowAngleDeltaDeg: number;
    shoulderAngleDeltaDeg: number;
  }>;
  observedDelta: {
    wristRmsTorsoLengths: number;
    elbowMeanAbsoluteDeg: number;
    shoulderMeanAbsoluteDeg: number;
    exceedsEngineeringFloor: string[];
  } | null;
}

export interface FormComparisonResult {
  schemaVersion: 1;
  protocol: string;
  outcome: FormComparisonOutcome;
  reasons: FormComparisonReason[];
  evidenceBoundary: {
    measurement: string;
    metadata: string;
    validation: string;
    interpretation: string;
  };
  provenance: {
    before: Omit<FormComparisonRecordingMetadata, "review"> & {
      source: ShotAnalysis["source"];
      reviewBasis: FormComparisonRecordingMetadata["review"]["basis"];
      reviewEvidenceId: string;
      reviewerId: string;
      reviewedClipSha256: string;
    };
    after: Omit<FormComparisonRecordingMetadata, "review"> & {
      source: ShotAnalysis["source"];
      reviewBasis: FormComparisonRecordingMetadata["review"]["basis"];
      reviewEvidenceId: string;
      reviewerId: string;
      reviewedClipSha256: string;
    };
  } | null;
  strokeTiming: {
    before: { startMs: number; contactMs: number | null; endMs: number; durationMs: number };
    after: { startMs: number; contactMs: number | null; endMs: number; durationMs: number };
    durationDeltaMs: number;
    exceedsEngineeringFloor: boolean;
  } | null;
  phases: FormPhaseComparison[];
}

const C = FORM_COMPARISON_ACCEPTANCE;
const VERSION_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const satisfies readonly (keyof VersionVector)[];
type Side = "before" | "after";
type ComparisonAnalysis = Pick<
  ShotAnalysis,
  | "id"
  | "sessionId"
  | "shotType"
  | "cameraView"
  | "handedness"
  | "timestamps"
  | "phases"
  | "versionVector"
  | "source"
>;

class Rejection extends Error {
  constructor(
    readonly outcome: "not_comparable" | "insufficient_evidence",
    readonly reason: FormComparisonReason,
  ) {
    super(reason.detail);
  }
}

function check(
  condition: unknown,
  code: string,
  detail: string,
  side: Side | null = null,
  phase: PhaseKey | null = null,
  outcome: "not_comparable" | "insufficient_evidence" = "not_comparable",
): asserts condition {
  if (!condition) throw new Rejection(outcome, { code, detail, side, phase });
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const timestamp = (value: unknown): value is number =>
  finite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const imagePoint = (value: unknown): value is ImagePoint =>
  record(value) && unit(value.x) && unit(value.y);
const versions = (value: unknown): value is VersionVector =>
  record(value) &&
  Object.keys(value).length === VERSION_KEYS.length &&
  VERSION_KEYS.every((key) => text(value[key]));
const sameVersions = (a: VersionVector, b: VersionVector): boolean =>
  VERSION_KEYS.every((key) => a[key] === b[key]);
const sameModel = (a: ModelRef, b: ModelRef): boolean =>
  a.providerId === b.providerId &&
  a.modelVersion === b.modelVersion &&
  a.runtime === b.runtime &&
  a.executionTarget === b.executionTarget &&
  a.artifactHash === b.artifactHash;

function parseMetadata(raw: unknown): FormComparisonPairMetadata {
  check(
    record(raw) && raw.schemaVersion === 1,
    "independent_metadata_required",
    "Provide the separate schemaVersion=1 pair review; stored analysis fields are not independent evidence.",
    null,
    null,
    "insufficient_evidence",
  );
  for (const side of ["before", "after"] as const) {
    const member = raw[side];
    check(record(member), "invalid_metadata", "Both pair members are required.", side);
    check(
      text(member.analysisId) &&
        hash(member.analysisSha256) &&
        hash(member.poseSha256) &&
        text(member.playerId) &&
        text(member.sessionId) &&
        CAMERA_VIEWS.includes(member.cameraView as CameraView) &&
        (member.handedness === "right" || member.handedness === "left") &&
        SHOT_TYPES.includes(member.technique as ShotAnalysis["shotType"]) &&
        versions(member.versionVector),
      "invalid_metadata",
      "Explicit artifact hashes, player, session, view, hand, technique and complete versions are required.",
      side,
    );
    check(
      member.captureMode === "automatic_pose_trigger" || member.captureMode === "imported_video",
      "capture_mode_required",
      "An independent capture mode is required; it cannot be inferred from ShotAnalysis or a pose sidecar.",
      side,
      null,
      "insufficient_evidence",
    );
    const model = member.poseModel;
    check(
      record(model) &&
        text(model.providerId) &&
        text(model.modelVersion) &&
        MODEL_RUNTIMES.includes(model.runtime as ModelRef["runtime"]) &&
        EXECUTION_TARGETS.includes(model.executionTarget as ModelRef["executionTarget"]) &&
        (model.artifactHash === null || hash(model.artifactHash)),
      "pose_provenance_required",
      "Supply the original pose producer; the reader must not invent a provider or runtime.",
      side,
    );
    const review = member.review;
    check(
      record(review),
      "independent_review_required",
      "Native sidecars have no track ID/switch evidence; provide an independent review trace.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      (review.basis === "independent_frame_review" || review.basis === "synthetic_fixture") &&
        text(review.evidenceId) &&
        text(review.reviewerId) &&
        hash(review.clipSha256) &&
        text(review.cameraSetupId) &&
        Array.isArray(review.scenePointIds) &&
        review.scenePointIds.length === 3 &&
        review.scenePointIds.every(text) &&
        new Set(review.scenePointIds).size === 3 &&
        Array.isArray(review.frames) &&
        review.frames.length <= C.maxFrames,
      "independent_review_required",
      "Review provenance, a clip hash, three stable labeled scene references and a bounded frame trace are required.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      review.timebase === "original_clip_ms",
      "timebase_mismatch",
      "Review must use the original clip-relative millisecond axis; no offset or time warp is accepted.",
      side,
    );
    check(
      review.rotationDegrees === 0 && review.mirrored === false,
      "orientation_mismatch",
      "Only independently reviewed upright, unmirrored image coordinates are supported; nothing is rotated or reflected to force a match.",
      side,
    );
  }
  return raw as unknown as FormComparisonPairMetadata;
}

function parseAnalysis(bytes: Uint8Array, side: Side): ComparisonAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    check(false, "invalid_analysis", "Analysis is not valid JSON.", side);
  }
  check(record(raw), "invalid_analysis", "Expected a local ShotAnalysis JSON object.", side);
  check(
    text(raw.id) &&
      (raw.sessionId === null || text(raw.sessionId)) &&
      SHOT_TYPES.includes(raw.shotType as ShotAnalysis["shotType"]) &&
      CAMERA_VIEWS.includes(raw.cameraView as CameraView) &&
      ["left", "right", "ambidextrous"].includes(raw.handedness as string) &&
      (raw.source === "real" || raw.source === "fixture") &&
      versions(raw.versionVector),
    "invalid_analysis",
    "Analysis identity, view, hand, source and full version vector must be explicit.",
    side,
  );
  const window = raw.timestamps;
  check(
    record(window) &&
      timestamp(window.startMs) &&
      timestamp(window.endMs) &&
      window.endMs > window.startMs &&
      window.endMs - window.startMs <= C.maxStrokeDurationMs &&
      (window.contactMs === null ||
        (timestamp(window.contactMs) &&
          window.contactMs >= window.startMs &&
          window.contactMs <= window.endMs)),
    "invalid_timebase",
    "Expected a positive bounded stroke window on the original clip millisecond axis.",
    side,
  );
  check(
    Array.isArray(raw.phases) && raw.phases.length === PHASES.length,
    "phase_evidence_missing",
    "This bounded baseline requires all six stored phase spans; it never synthesizes missing phases.",
    side,
    null,
    "insufficient_evidence",
  );
  let previousEnd = window.startMs;
  for (const [index, span] of raw.phases.entries()) {
    check(
      record(span) &&
        span.key === PHASES[index] &&
        finite(span.startMs) &&
        finite(span.representativeMs) &&
        finite(span.endMs) &&
        unit(span.confidence) &&
        span.startMs >= previousEnd &&
        span.representativeMs >= span.startMs &&
        span.endMs >= span.representativeMs &&
        span.endMs <= window.endMs,
      "invalid_phase_timebase",
      "Phase spans must be ordered, nonoverlapping, finite and inside the recorded stroke window.",
      side,
    );
    check(
      span.startMs === previousEnd,
      "phase_coverage_missing",
      "Stored phases must cover the stroke from its start without unlabeled gaps; no phase is extended to fill one.",
      side,
      span.key as PhaseKey,
      "insufficient_evidence",
    );
    previousEnd = span.endMs;
  }
  check(
    previousEnd === window.endMs,
    "phase_coverage_missing",
    "Stored phases do not cover the end of the stroke window.",
    side,
    null,
    "insufficient_evidence",
  );
  return raw as unknown as ComparisonAnalysis;
}

interface LoadedRecording {
  side: Side;
  metadata: FormComparisonRecordingMetadata;
  analysis: ComparisonAnalysis;
  sequence: PoseSequence;
  aspect: number;
}

function loadRecording(
  files: FormComparisonFiles,
  metadata: FormComparisonRecordingMetadata,
  side: Side,
): LoadedRecording {
  for (const [bytes, expected, label] of [
    [files.analysisBytes, metadata.analysisSha256, "analysis"],
    [files.poseBytes, metadata.poseSha256, "pose"],
  ] as const) {
    check(
      bytes instanceof Uint8Array && bytes.byteLength <= C.maxInputFileBytes,
      "input_size_or_type",
      "Input must be bounded local file bytes.",
      side,
    );
    check(
      createHash("sha256").update(bytes).digest("hex") === expected,
      "artifact_hash_mismatch",
      `The supplied ${label} bytes do not match the independently recorded SHA-256.`,
      side,
    );
  }
  const analysis = parseAnalysis(files.analysisBytes, side);
  check(
    analysis.id === metadata.analysisId,
    "analysis_identity_mismatch",
    "Review is bound to a different analysis ID.",
    side,
  );
  check(
    analysis.sessionId === metadata.sessionId,
    "session_mismatch",
    "Review session does not match the stored analysis session.",
    side,
  );
  check(
    analysis.shotType === metadata.technique,
    "technique_mismatch",
    "Reviewed technique contradicts the stored analysis.",
    side,
  );
  check(
    analysis.cameraView === metadata.cameraView,
    "view_mismatch",
    "Independent view review contradicts the stored cameraView.",
    side,
  );
  check(
    analysis.handedness === metadata.handedness,
    "handedness_mismatch",
    "Hand must be explicit and agree; ambidextrous is not inferred from wrist motion.",
    side,
  );
  check(
    sameVersions(analysis.versionVector, metadata.versionVector),
    "version_mismatch",
    "Review versions do not match every stored VersionVector field.",
    side,
  );
  check(
    (analysis.source === "fixture" && metadata.review.basis === "synthetic_fixture") ||
      (analysis.source === "real" && metadata.review.basis === "independent_frame_review"),
    "review_source_mismatch",
    "Synthetic evidence cannot authenticate real data, and fixture input cannot be relabeled as real validation.",
    side,
  );
  const parsed = parsePoseSequence(
    Buffer.from(files.poseBytes).toString("utf8"),
    metadata.poseModel,
  );
  check(
    parsed.ok,
    "invalid_pose_sequence",
    parsed.ok ? "" : `${parsed.failure.code}: ${parsed.failure.message}`,
    side,
  );
  const sequence = parsed.value;
  check(
    sequence.coordinateSystem === "normalized_image_top_left",
    "unsupported_coordinates",
    "Only canonical normalized-image top-left 2D coordinates are supported.",
    side,
  );
  check(
    [sequence.video.width, sequence.video.height].every(
      (size) => Number.isInteger(size) && size > 0 && size <= C.maxVideoDimension,
    ) &&
      sequence.video.fps >= C.minFps &&
      sequence.video.fps <= C.maxFps,
    "invalid_video_metadata",
    "Video dimensions and nominal FPS must stay within the exported offline bounds.",
    side,
  );
  check(
    sequence.producedBy.modelVersion === analysis.versionVector.poseModelVersion &&
      metadata.poseModel.modelVersion === sequence.producedBy.modelVersion,
    "pose_model_mismatch",
    "Pose sidecar, producer and analysis model versions must agree exactly.",
    side,
  );
  check(
    sequence.frames.length > 0 && sequence.frames.length <= C.maxFrames,
    "pose_evidence_missing",
    "Pose frame count is empty or exceeds the offline bound.",
    side,
    null,
    "insufficient_evidence",
  );
  let previous = sequence.frames[0]!;
  for (const [index, frame] of sequence.frames.entries()) {
    check(
      Number.isSafeInteger(frame.frameIndex) &&
        frame.frameIndex >= 0 &&
        timestamp(frame.timestampMs) &&
        unit(frame.confidence),
      "invalid_pose_timebase",
      "Frame indices, millisecond timestamps and confidence must be valid.",
      side,
    );
    if (index > 0) {
      check(
        frame.frameIndex > previous.frameIndex && frame.timestampMs > previous.timestampMs,
        "invalid_pose_timebase",
        "Frame indices and original timestamps must both increase; sorting or repairing is forbidden.",
        side,
      );
      check(
        frame.timestampMs - previous.timestampMs >=
          (1000 / sequence.video.fps) * C.minSamplePeriodFractionOfNominal,
        "invalid_pose_timebase",
        "Sample times are implausibly short for the declared FPS; seconds or retimed samples cannot be treated as milliseconds.",
        side,
      );
    }
    check(
      new Set(frame.landmarks.map((point) => point.name)).size === frame.landmarks.length &&
        frame.landmarks.every((point) => unit(point.x) && unit(point.y) && unit(point.visibility)),
      "invalid_pose_geometry",
      "Duplicate joints, out-of-image coordinates or invalid visibility cannot enter 2D geometry.",
      side,
    );
    previous = frame;
  }
  const first = sequence.frames[0]!.timestampMs;
  const last = sequence.frames.at(-1)!.timestampMs;
  check(
    analysis.timestamps.startMs >= first - C.maxGapMs &&
      analysis.timestamps.endMs <= last + C.maxGapMs,
    "analysis_pose_timebase_mismatch",
    "Analysis lies outside the supplied pose timebase; no automatic rebase is allowed.",
    side,
  );
  return {
    side,
    metadata,
    analysis,
    sequence,
    aspect: sequence.video.width / sequence.video.height,
  };
}

function checkPair(before: LoadedRecording, after: LoadedRecording): void {
  const a = before.metadata;
  const b = after.metadata;
  check(
    a.playerId === b.playerId,
    "player_mismatch",
    "This experiment compares the same explicitly reviewed player only.",
  );
  check(
    a.sessionId === b.sessionId,
    "session_mismatch",
    "This bounded prototype compares one nonempty session only.",
  );
  check(
    a.cameraView === b.cameraView && a.review.cameraSetupId === b.review.cameraSetupId,
    "view_mismatch",
    "Independent camera view and fixed setup must match, not just stored cameraView.",
  );
  check(
    a.captureMode === b.captureMode,
    "capture_mode_mismatch",
    "Automatic pose-trigger captures and imported clips are not treated as the same capture condition.",
  );
  check(
    a.handedness === b.handedness,
    "handedness_mismatch",
    "Left/right comparisons and automatic mirroring are not supported.",
  );
  check(
    a.technique === b.technique,
    "technique_mismatch",
    "Different techniques are not comparable.",
  );
  check(
    sameVersions(a.versionVector, b.versionVector) && sameModel(a.poseModel, b.poseModel),
    "version_mismatch",
    "Every version and original pose producer must match; no cross-version calibration exists.",
  );
  check(
    before.analysis.source === after.analysis.source,
    "source_mismatch",
    "Real and fixture observations cannot be compared as one evidence source.",
  );
  check(
    Math.abs(before.aspect - after.aspect) <= 1e-9 &&
      a.review.scenePointIds.every((id, index) => id === b.review.scenePointIds[index]),
    "camera_reference_mismatch",
    "Image aspect and the ordered independent scene reference identities must match.",
  );
}

interface MeasuredFrame {
  frame: PoseFrame;
  observation: FormObservation;
  hip: Point;
  torsoAngleDeg: number;
  shoulderWidthTorso: number;
  projectionSign: number;
  bonesTorso: number[];
}

interface MeasuredRecording extends LoadedRecording {
  samples: MeasuredFrame[];
  scenePoints: [ImagePoint, ImagePoint, ImagePoint];
}

const ratio = (a: number, b: number): number => Math.max(a / b, b / a);
const sceneDistance = (a: ImagePoint, b: ImagePoint, aspect: number): number =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function requiredJoints(hand: "left" | "right"): PoseLandmarkName[] {
  return [
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    `${hand}_elbow`,
    `${hand}_wrist`,
  ];
}

function measureFrame(frame: PoseFrame, frameIndex: number, input: LoadedRecording): MeasuredFrame {
  const { side, aspect } = input;
  check(
    frame.confidence >= C.minConfidence,
    "pose_confidence_low",
    "Low-confidence pose samples cannot be skipped to hide a gap.",
    side,
    null,
    "insufficient_evidence",
  );
  const points = requiredJoints(input.metadata.handedness).map((name) =>
    landmark(frame, name, aspect),
  );
  check(
    points.every((point) => point !== null && point.visibility >= C.minVisibility),
    "required_joint_unobserved",
    "Both shoulders/hips and the explicitly chosen elbow/wrist must be observed in every sample.",
    side,
    null,
    "insufficient_evidence",
  );
  const [ls, rs, lh, rh, elbow, wrist] = points as [Point, Point, Point, Point, Point, Point];
  const hip = midpoint(lh, rh);
  const shoulderMid = midpoint(ls, rs);
  const torso = distance(hip, shoulderMid);
  const shoulder = input.metadata.handedness === "left" ? ls : rs;
  const sameHip = input.metadata.handedness === "left" ? lh : rh;
  check(
    torso >= C.minTorsoImageHeights && torso <= C.maxTorsoImageHeights,
    "degenerate_body_scale",
    "Torso span is outside the fixed engineering bounds; no fallback body scale is invented.",
    side,
    null,
    "insufficient_evidence",
  );
  const bonesTorso = [
    distance(shoulder, elbow),
    distance(elbow, wrist),
    distance(sameHip, shoulder),
  ].map((length) => length / torso);
  check(
    bonesTorso.every(
      (length) => length >= C.minBoneTorsoLengths && length <= C.maxBoneTorsoLengths,
    ),
    "geometry_outlier",
    "Collapsed or implausibly long projected segments cannot define a joint angle.",
    side,
    null,
    "insufficient_evidence",
  );
  const torsoAngleDeg = segmentAngleDeg(hip, shoulderMid);
  check(
    angularDifferenceDeg(torsoAngleDeg, -90) <= C.maxUprightDeviationDeg,
    "orientation_or_projection_mismatch",
    "Observed torso projection contradicts the upright comparison envelope, regardless of the metadata claim.",
    side,
  );
  check(
    Math.abs(rs.x - ls.x) / torso >= C.minHorizontalShoulderSeparationTorso,
    "projection_ambiguous",
    "Left/right shoulder projection is too ambiguous to reject a reflection reliably.",
    side,
    null,
    "insufficient_evidence",
  );
  return {
    frame,
    observation: {
      frameIndex,
      timestampMs: frame.timestampMs,
      wristTorso: { x: (wrist.x - hip.x) / torso, y: (wrist.y - hip.y) / torso },
      elbowAngleDeg: interiorAngleDeg(shoulder, elbow, wrist),
      shoulderAngleDeg: interiorAngleDeg(sameHip, shoulder, elbow),
      torsoImageHeights: torso,
    },
    hip,
    torsoAngleDeg,
    shoulderWidthTorso: distance(ls, rs) / torso,
    projectionSign: Math.sign(rs.x - ls.x),
    bonesTorso,
  };
}

function measureRecording(input: LoadedRecording): MeasuredRecording {
  const { sequence, analysis, metadata, side, aspect } = input;
  const frames = sequence.frames.filter(
    (frame) =>
      frame.timestampMs >= analysis.timestamps.startMs &&
      frame.timestampMs <= analysis.timestamps.endMs,
  );
  check(
    frames.length > 0,
    "pose_evidence_missing",
    "No observed pose sample lies in the stored stroke window.",
    side,
    null,
    "insufficient_evidence",
  );
  check(
    metadata.review.frames.length === frames.length,
    "review_coverage_missing",
    "The independent trace must cover every in-window pose frame exactly, not only selected good frames.",
    side,
    null,
    "insufficient_evidence",
  );
  const legacy = toLegacyPoseFrames({ ...sequence, frames });
  let scenePoints: FormComparisonReviewedFrame["scenePoints"] | null = null;
  let trackId: string | null = null;
  const samples: MeasuredFrame[] = [];
  for (const [index, frame] of frames.entries()) {
    const review = metadata.review.frames[index];
    check(
      record(review) &&
        review.frameIndex === frame.frameIndex &&
        review.timestampMs === frame.timestampMs,
      "review_timebase_mismatch",
      "Review rows must retain the exact original frame indices/timestamps in order.",
      side,
    );
    check(
      review.playerId === metadata.playerId &&
        text(review.trackId) &&
        review.personCount === 1 &&
        review.identityAmbiguous === false &&
        review.trackSwitch === false,
      "track_continuity_unverified",
      "A single reviewed person, explicit player identity and no ambiguity or switch are required at every frame.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      trackId === null || trackId === review.trackId,
      "track_switch",
      "A changed track ID cannot be aligned as the same continuous person.",
      side,
    );
    trackId = review.trackId;
    check(
      review.cameraView === metadata.cameraView && review.cameraStable === true,
      "camera_view_unverified",
      "The independent per-frame view or stationary-camera evidence is absent or contradictory.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      Array.isArray(review.occludedJoints) &&
        review.occludedJoints.every((name) =>
          POSE_LANDMARK_NAMES.includes(name as PoseLandmarkName),
        ),
      "occlusion_review_missing",
      "An explicit known-joint occlusion list is required for every reviewed frame.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      !requiredJoints(metadata.handedness).some((name) => review.occludedJoints.includes(name)),
      "required_joint_occluded",
      "Required-joint occlusion cannot be repaired or interpreted as a form change.",
      side,
      null,
      "insufficient_evidence",
    );
    const box = review.targetBox;
    check(
      record(box) &&
        unit(box.x) &&
        unit(box.y) &&
        finite(box.width) &&
        finite(box.height) &&
        box.width > 0 &&
        box.height > 0 &&
        box.x + box.width <= 1 &&
        box.y + box.height <= 1,
      "target_bounds_missing",
      "An independently reviewed in-image target bounding box is required.",
      side,
      null,
      "insufficient_evidence",
    );
    check(
      frame.landmarks
        .filter((point) =>
          requiredJoints(metadata.handedness).includes(point.name as PoseLandmarkName),
        )
        .every(
          (point) =>
            point.x >= box.x &&
            point.x <= box.x + box.width &&
            point.y >= box.y &&
            point.y <= box.y + box.height,
        ),
      "target_pose_mismatch",
      "Observed joints lie outside the reviewed target; metadata cannot overwrite the pose evidence.",
      side,
    );
    check(
      Array.isArray(review.scenePoints) &&
        review.scenePoints.length === 3 &&
        review.scenePoints.every(imagePoint),
      "camera_reference_missing",
      "Three independently reviewed stationary scene points must be observed in every frame.",
      side,
      null,
      "insufficient_evidence",
    );
    const [a, b, c] = review.scenePoints;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    check(
      area >= C.minSceneTriangleArea,
      "camera_reference_degenerate",
      "Scene references are too close or collinear to support the fixed-camera gate.",
      side,
      null,
      "insufficient_evidence",
    );
    scenePoints ??= review.scenePoints;
    check(
      review.scenePoints.every(
        (point, pointIndex) =>
          sceneDistance(point, scenePoints![pointIndex]!, aspect) <=
          C.maxScenePointDriftImageHeights,
      ),
      "camera_motion",
      "Independent stationary references moved; no compensation or alignment will hide camera motion.",
      side,
    );
    const sample = measureFrame(legacy[index]!, frame.frameIndex, input);
    const previous = samples.at(-1);
    if (previous) {
      check(
        sample.observation.timestampMs - previous.observation.timestampMs <= C.maxGapMs,
        "pose_gap",
        "Consecutive observed samples exceed the existing 120 ms limit; gaps are never bridged.",
        side,
        null,
        "insufficient_evidence",
      );
      check(
        distance(previous.hip, sample.hip) / sample.observation.torsoImageHeights <=
          C.maxHipStepTorsoLengths &&
          sceneDistance(previous.observation.wristTorso, sample.observation.wristTorso, 1) <=
            C.maxWristStepTorsoLengths,
        "geometry_discontinuity",
        "Abrupt body or wrist jumps fail the continuity screen even when review metadata claims no switch.",
        side,
        null,
        "insufficient_evidence",
      );
      check(
        previous.projectionSign === sample.projectionSign,
        "projection_switch",
        "Shoulder projection changes sign; a side/identity switch cannot be distinguished safely.",
        side,
      );
    }
    samples.push(sample);
  }
  const medianTorso = median(samples.map((sample) => sample.observation.torsoImageHeights));
  const medianBones = [0, 1, 2].map((index) =>
    median(samples.map((sample) => sample.bonesTorso[index]!)),
  );
  check(
    samples.every(
      (sample) =>
        ratio(sample.observation.torsoImageHeights, medianTorso) <= C.maxTorsoRatioWithinClip &&
        sample.bonesTorso.every(
          (length, index) => ratio(length, medianBones[index]!) <= C.maxBoneRatioWithinClip,
        ),
    ),
    "geometry_outlier",
    "Torso or projected bone lengths vary beyond the fixed sanity envelope; suspicious samples are not silently dropped.",
    side,
    null,
    "insufficient_evidence",
  );
  return { ...input, samples, scenePoints: scenePoints! };
}

function phaseAnchors(
  span: PhaseSpan,
): Array<[FormPhaseComparison["matches"][number]["anchor"], number]> {
  return [
    ["start", span.startMs],
    ["pre_representative", (span.startMs + span.representativeMs) / 2],
    ["representative", span.representativeMs],
    ["post_representative", (span.representativeMs + span.endMs) / 2],
    ["end", span.endMs],
  ];
}

function nearestSample(
  samples: MeasuredFrame[],
  targetMs: number,
  side: Side,
  phase: PhaseKey,
): MeasuredFrame {
  const frame = frameNearest(
    samples.map((sample) => sample.frame),
    targetMs,
  );
  check(
    frame && Math.abs(frame.timestampMs - targetMs) <= C.maxAnchorDistanceMs,
    "phase_anchor_unobserved",
    "No in-phase observed sample is within 120 ms of the stored anchor; no interpolation or out-of-phase match is used.",
    side,
    phase,
    "insufficient_evidence",
  );
  return samples.find((sample) => sample.frame === frame)!;
}

function comparePhase(
  before: MeasuredRecording,
  after: MeasuredRecording,
  phase: PhaseKey,
): FormPhaseComparison {
  const a = before.analysis.phases.find((span) => span.key === phase)!;
  const b = after.analysis.phases.find((span) => span.key === phase)!;
  const inPhase = (input: MeasuredRecording, span: PhaseSpan): MeasuredFrame[] =>
    input.samples.filter(
      (sample) =>
        sample.observation.timestampMs >= span.startMs &&
        sample.observation.timestampMs <= span.endMs,
    );
  const aSamples = inPhase(before, a);
  const bSamples = inPhase(after, b);
  const phaseTiming = (
    span: PhaseSpan,
    strokeStartMs: number,
  ): FormPhaseComparison["timing"]["before"] => ({
    key: span.key,
    startMs: span.startMs,
    representativeMs: span.representativeMs,
    endMs: span.endMs,
    confidence: span.confidence,
    durationMs: span.endMs - span.startMs,
    startFromStrokeMs: span.startMs - strokeStartMs,
  });
  const aTiming = phaseTiming(a, before.analysis.timestamps.startMs);
  const bTiming = phaseTiming(b, after.analysis.timestamps.startMs);
  const result: FormPhaseComparison = {
    phase,
    phaseMeaning: "stored_phase_label_only_not_verified_contact_or_event_truth",
    outcome: "insufficient_evidence",
    reasons: [],
    timing: {
      before: aTiming,
      after: bTiming,
      durationDeltaMs: bTiming.durationMs - aTiming.durationMs,
      startFromStrokeDeltaMs: bTiming.startFromStrokeMs - aTiming.startFromStrokeMs,
      representativeFromStrokeDeltaMs:
        b.representativeMs -
        after.analysis.timestamps.startMs -
        (a.representativeMs - before.analysis.timestamps.startMs),
    },
    beforeTrajectory: aSamples.map((sample) => sample.observation),
    afterTrajectory: bSamples.map((sample) => sample.observation),
    matches: [],
    observedDelta: null,
  };
  try {
    for (const [samples, span, side] of [
      [aSamples, a, "before"],
      [bSamples, b, "after"],
    ] as const) {
      check(
        span.confidence >= C.minConfidence,
        "phase_confidence_low",
        "Stored phase confidence is below the fixed evidence floor.",
        side,
        phase,
        "insufficient_evidence",
      );
      check(
        samples.length >= C.minDistinctSamplesPerPhase,
        "phase_samples_insufficient",
        "Fewer than three distinct measured samples cannot support a phase trajectory comparison.",
        side,
        phase,
        "insufficient_evidence",
      );
    }
    const bAnchors = phaseAnchors(b);
    const matches = phaseAnchors(a).map(([anchor, beforeTargetMs], index) => {
      const afterTargetMs = bAnchors[index]![1];
      const left = nearestSample(aSamples, beforeTargetMs, "before", phase);
      const right = nearestSample(bSamples, afterTargetMs, "after", phase);
      check(
        left.projectionSign === right.projectionSign &&
          angularDifferenceDeg(left.torsoAngleDeg, right.torsoAngleDeg) <=
            C.maxPairedTorsoAngleDifferenceDeg &&
          Math.abs(left.shoulderWidthTorso - right.shoulderWidthTorso) <=
            C.maxPairedShoulderWidthDifferenceTorso &&
          left.bonesTorso.every(
            (length, bone) => ratio(length, right.bonesTorso[bone]!) <= C.maxPairedBoneRatio,
          ),
        "projection_mismatch",
        "Observed projections contradict a conservative same-view/body-shape comparison. This cannot distinguish a view, reflection, person or foreshortening change and therefore abstains.",
        null,
        phase,
      );
      const x = right.observation.wristTorso.x - left.observation.wristTorso.x;
      const y = right.observation.wristTorso.y - left.observation.wristTorso.y;
      return {
        anchor,
        beforeTargetMs,
        afterTargetMs,
        before: left.observation,
        after: right.observation,
        wristDeltaTorso: { x, y },
        elbowAngleDeltaDeg: right.observation.elbowAngleDeg - left.observation.elbowAngleDeg,
        shoulderAngleDeltaDeg:
          right.observation.shoulderAngleDeg - left.observation.shoulderAngleDeg,
      };
    });
    check(
      new Set(matches.map((match) => match.before.frameIndex)).size >=
        C.minDistinctSamplesPerPhase &&
        new Set(matches.map((match) => match.after.frameIndex)).size >=
          C.minDistinctSamplesPerPhase,
      "phase_anchors_reuse_samples",
      "Nearest anchors reuse too few observed samples; repetition does not increase evidence.",
      null,
      phase,
      "insufficient_evidence",
    );
    const uniqueMatches = [
      ...new Map(
        matches.map((match) => [`${match.before.frameIndex}:${match.after.frameIndex}`, match]),
      ).values(),
    ];
    const wristRmsTorsoLengths = Math.sqrt(
      mean(
        uniqueMatches.map((match) => match.wristDeltaTorso.x ** 2 + match.wristDeltaTorso.y ** 2),
      ),
    );
    const elbowMeanAbsoluteDeg = mean(
      uniqueMatches.map((match) => Math.abs(match.elbowAngleDeltaDeg)),
    );
    const shoulderMeanAbsoluteDeg = mean(
      uniqueMatches.map((match) => Math.abs(match.shoulderAngleDeltaDeg)),
    );
    const exceedsEngineeringFloor = [
      ...(wristRmsTorsoLengths > C.changeFloors.wristTorsoLengths ? ["wrist_position_2d"] : []),
      ...(elbowMeanAbsoluteDeg > C.changeFloors.jointAngleDeg ? ["elbow_angle_2d"] : []),
      ...(shoulderMeanAbsoluteDeg > C.changeFloors.jointAngleDeg ? ["shoulder_angle_2d"] : []),
      ...(Math.abs(result.timing.durationDeltaMs) > C.changeFloors.timingMs
        ? ["stored_phase_duration"]
        : []),
      ...(Math.abs(result.timing.startFromStrokeDeltaMs) > C.changeFloors.timingMs
        ? ["stored_phase_onset"]
        : []),
      ...(Math.abs(result.timing.representativeFromStrokeDeltaMs) > C.changeFloors.timingMs
        ? ["stored_phase_representative_time"]
        : []),
    ];
    result.matches = matches;
    result.observedDelta = {
      wristRmsTorsoLengths,
      elbowMeanAbsoluteDeg,
      shoulderMeanAbsoluteDeg,
      exceedsEngineeringFloor,
    };
    result.outcome = exceedsEngineeringFloor.length > 0 ? "observed_change" : "no_reliable_change";
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    result.outcome = error.outcome;
    result.reasons = [error.reason];
  }
  return result;
}

function emptyResult(
  outcome: FormComparisonOutcome,
  reasons: FormComparisonReason[],
): FormComparisonResult {
  return {
    schemaVersion: 1,
    protocol: C.protocol,
    outcome,
    reasons,
    evidenceBoundary: {
      measurement:
        "Observed image-plane 2D wrist positions relative to hip midpoint, divided by shoulder-midpoint to hip-midpoint torso span; x is aspect-corrected. Projected elbow/shoulder angles only. No paddle speed, ball/contact detection, 3D, force or injury inference.",
      metadata:
        "SHA-256 checks bind the supplied file bytes, not authorship or identity. Independent frame-review claims, capture mode and the clip hash are caller supplied, not authenticated or verified against video by this CLI. Only poseModelVersion is carried in the pose bytes; provider, runtime, execution target and model artifact hash are caller declarations, not sidecar-verified provenance. Native sidecars contain no track/switch proof; mobile cameraView is hardcoded to side, not measured view evidence. Internally consistent forged metadata can evade these sanity checks.",
      validation:
        "Deterministic synthetic cases check software behavior, not measurement validation. Real-data and coach validation, independent pair labels, same-condition repeatability data and measurement-uncertainty calibration are missing; clinical validation is not performed. This run does not change that status or authorize release.",
      interpretation:
        "Observed change never means improvement. All deltas are conditional on truthful independent review. no_reliable_change means no anchor/timing difference above unvalidated engineering display floors, not whole-trajectory equivalence or proof of unchanged skill. Neither outcome separates pose/phase-estimation error or unequal nearest-sample timing from true movement differences. Phase labels/times and contactMs are stored estimates; a wrist-speed peak is not actual ball contact. contactMs is retained but is not used for alignment or a change verdict. Partial phase coverage yields insufficient_evidence; no score is produced.",
    },
    provenance: null,
    strokeTiming: null,
    phases: [],
  };
}

export function formComparisonAbstention(
  outcome: "not_comparable" | "insufficient_evidence",
  code: string,
  detail: string,
): FormComparisonResult {
  return emptyResult(outcome, [{ code, detail, side: null, phase: null }]);
}

function provenance(
  input: LoadedRecording,
): NonNullable<FormComparisonResult["provenance"]>["before"] {
  const meta = input.metadata;
  return {
    analysisId: meta.analysisId,
    analysisSha256: meta.analysisSha256,
    poseSha256: meta.poseSha256,
    playerId: meta.playerId,
    sessionId: meta.sessionId,
    cameraView: meta.cameraView,
    captureMode: meta.captureMode,
    handedness: meta.handedness,
    technique: meta.technique,
    versionVector: { ...meta.versionVector },
    poseModel: {
      providerId: meta.poseModel.providerId,
      modelVersion: meta.poseModel.modelVersion,
      runtime: meta.poseModel.runtime,
      executionTarget: meta.poseModel.executionTarget,
      artifactHash: meta.poseModel.artifactHash,
    },
    source: input.analysis.source,
    reviewBasis: meta.review.basis,
    reviewEvidenceId: meta.review.evidenceId,
    reviewerId: meta.review.reviewerId,
    reviewedClipSha256: meta.review.clipSha256,
  };
}

export function compareFormPair(
  input: FormComparisonInput,
  options: { enableOfflineExperiment?: boolean } = {},
): FormComparisonResult {
  if (options.enableOfflineExperiment !== true) {
    return formComparisonAbstention(
      "insufficient_evidence",
      "experiment_disabled",
      "Offline experiment is disabled. Explicit enableOfflineExperiment=true is required; there is no application entrypoint.",
    );
  }
  try {
    const metadata = parseMetadata(input.metadata);
    const before = loadRecording(input.before, metadata.before, "before");
    const after = loadRecording(input.after, metadata.after, "after");
    checkPair(before, after);
    const a = measureRecording(before);
    const b = measureRecording(after);
    check(
      a.scenePoints.every(
        (point, index) =>
          sceneDistance(point, b.scenePoints[index]!, a.aspect) <= C.maxScenePointDriftImageHeights,
      ),
      "camera_reference_mismatch",
      "Independent scene geometry differs across recordings; stored view strings cannot authorize a comparison.",
    );
    const phases = PHASES.map((phase) => comparePhase(a, b, phase));
    const outcome: FormComparisonOutcome = phases.some(
      (phase) => phase.outcome === "not_comparable",
    )
      ? "not_comparable"
      : phases.some((phase) => phase.outcome === "insufficient_evidence")
        ? "insufficient_evidence"
        : phases.some((phase) => phase.outcome === "observed_change")
          ? "observed_change"
          : "no_reliable_change";
    const result = emptyResult(
      outcome,
      phases.flatMap((phase) => phase.reasons),
    );
    const window = (
      analysis: ComparisonAnalysis,
    ): NonNullable<FormComparisonResult["strokeTiming"]>["before"] => ({
      startMs: analysis.timestamps.startMs,
      contactMs: analysis.timestamps.contactMs,
      endMs: analysis.timestamps.endMs,
      durationMs: analysis.timestamps.endMs - analysis.timestamps.startMs,
    });
    const aWindow = window(before.analysis);
    const bWindow = window(after.analysis);
    result.provenance = { before: provenance(before), after: provenance(after) };
    const durationDeltaMs = bWindow.durationMs - aWindow.durationMs;
    const exceedsEngineeringFloor = Math.abs(durationDeltaMs) > C.changeFloors.timingMs;
    result.strokeTiming = {
      before: aWindow,
      after: bWindow,
      durationDeltaMs,
      exceedsEngineeringFloor,
    };
    if (result.outcome === "no_reliable_change" && exceedsEngineeringFloor)
      result.outcome = "observed_change";
    result.phases = phases;
    return result;
  } catch (error) {
    if (error instanceof Rejection) return emptyResult(error.outcome, [error.reason]);
    return formComparisonAbstention(
      "not_comparable",
      "invalid_input_shape",
      "Malformed input cannot enter the offline comparison; no data was repaired.",
    );
  }
}
