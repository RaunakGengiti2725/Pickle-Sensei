import type {
  Motion3DArtifact,
  Motion3DFrameStatus,
} from '@pickle/swing-domain';

export const MOTION_REVIEW_SPEEDS = [0.25, 0.5, 1] as const;
export type MotionReviewSpeed = (typeof MOTION_REVIEW_SPEEDS)[number];
export type MotionReviewMode = 'motion' | 'recording';
export type MotionReviewClock = 'video' | 'pose_only';
export type MotionReviewSourceState = 'verified' | 'missing';
export type MotionReviewScale =
  'reference' | 'measured' | 'mixed' | 'unavailable';
export type MotionReviewFrameState =
  Motion3DFrameStatus | 'gap' | 'insufficient_joints' | 'seeking';
export type MotionReviewAction =
  | 'play'
  | 'pause'
  | 'seek'
  | 'step'
  | 'rate'
  | 'motion'
  | 'recording'
  | 'turnLeft'
  | 'turnRight'
  | 'zoomIn'
  | 'zoomOut'
  | 'reset';

export interface MotionReviewCommand {
  id: number;
  action: MotionReviewAction;
  value?: number;
}

export interface MotionReviewReady {
  artifactSha256: string;
  durationMs: number;
  frameCount: number;
  sourceState: MotionReviewSourceState;
  clock: MotionReviewClock;
  scaleBasis: MotionReviewScale;
}

export interface MotionReviewProgress {
  artifactSha256: string;
  positionMs: number;
  actualPositionMs: number;
  seeking: boolean;
  commandId: number;
  jointCount: number;
  durationMs: number;
  playing: boolean;
  canStepBackward: boolean;
  canStepForward: boolean;
  rate: MotionReviewSpeed;
  mode: MotionReviewMode;
  sourceState: MotionReviewSourceState;
  clock: MotionReviewClock;
  frameIndex: number | null;
  sourceFrameIndex: number | null;
  poseTimestampMs: number | null;
  frameStatus: MotionReviewFrameState;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function validClock(value: Record<string, unknown>): boolean {
  return (
    (value.sourceState === 'verified' && value.clock === 'video') ||
    (value.sourceState === 'missing' && value.clock === 'pose_only')
  );
}

function nullableIndex(value: unknown): boolean {
  return (
    value === null || (finite(value, 0, 1_000_000) && Number.isInteger(value))
  );
}

export function readMotionReviewReady(
  value: unknown,
  artifact: Motion3DArtifact,
  digest: string,
): MotionReviewReady | null {
  if (
    !record(value) ||
    value.artifactSha256 !== digest ||
    !validClock(value) ||
    !finite(value.durationMs, 1, 60_000) ||
    value.durationMs !== artifact.source.durationMs ||
    value.frameCount !== artifact.frames.length ||
    !['reference', 'measured', 'mixed', 'unavailable'].includes(
      String(value.scaleBasis),
    )
  )
    return null;
  return value as unknown as MotionReviewReady;
}

export function readMotionReviewProgress(
  value: unknown,
  durationMs: number,
  digest: string,
): MotionReviewProgress | null {
  if (
    !record(value) ||
    value.artifactSha256 !== digest ||
    value.durationMs !== durationMs ||
    !finite(value.positionMs, 0, durationMs) ||
    !finite(value.actualPositionMs, 0, durationMs) ||
    typeof value.seeking !== 'boolean' ||
    !finite(value.commandId, -1, Number.MAX_SAFE_INTEGER) ||
    !Number.isInteger(value.commandId) ||
    !finite(value.jointCount, 0, 17) ||
    !Number.isInteger(value.jointCount) ||
    typeof value.playing !== 'boolean' ||
    typeof value.canStepBackward !== 'boolean' ||
    typeof value.canStepForward !== 'boolean' ||
    !MOTION_REVIEW_SPEEDS.includes(value.rate as MotionReviewSpeed) ||
    !validClock(value) ||
    (value.mode !== 'motion' && value.mode !== 'recording') ||
    (value.mode === 'recording' && value.sourceState !== 'verified') ||
    !nullableIndex(value.frameIndex) ||
    !nullableIndex(value.sourceFrameIndex) ||
    (value.poseTimestampMs !== null &&
      !finite(value.poseTimestampMs, 0, durationMs)) ||
    ![
      'estimated',
      'no_person',
      'multiple_people',
      'unavailable',
      'gap',
      'insufficient_joints',
      'seeking',
    ].includes(String(value.frameStatus))
  )
    return null;
  if (
    (value.frameIndex === null) !== (value.poseTimestampMs === null) ||
    (value.sourceState === 'missing' && value.sourceFrameIndex !== null) ||
    ((value.frameIndex === null ||
      ['no_person', 'multiple_people', 'unavailable'].includes(
        String(value.frameStatus),
      )) &&
      value.jointCount !== 0) ||
    (value.frameStatus === 'gap' || value.frameStatus === 'seeking') !==
      (value.frameIndex === null) ||
    value.seeking !== (value.frameStatus === 'seeking') ||
    (value.seeking &&
      (value.sourceFrameIndex !== null ||
        value.jointCount !== 0 ||
        value.clock !== 'video')) ||
    (!value.seeking && value.positionMs !== value.actualPositionMs) ||
    (typeof value.poseTimestampMs === 'number' &&
      value.poseTimestampMs > value.actualPositionMs + 0.001)
  )
    return null;
  return value as unknown as MotionReviewProgress;
}

export function motionReviewClock(ms: number): string {
  return `${(Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0).toFixed(2)}s`;
}

export function motionReviewSeek(
  locationX: number,
  width: number,
  durationMs: number,
): number | null {
  if (
    !finite(width, 1, 100_000) ||
    !finite(durationMs, 1, 60_000) ||
    !Number.isFinite(locationX)
  )
    return null;
  return Math.max(0, Math.min(1, locationX / width)) * durationMs;
}

export function motionFrameDescription(
  progress: MotionReviewProgress | null,
): string {
  if (!progress) return 'Waiting for the native playback position.';
  switch (progress.frameStatus) {
    case 'seeking':
      return `Seeking to ${motionReviewClock(progress.positionMs)}. Waiting for the recording frame.`;
    case 'estimated':
      return progress.jointCount < 17
        ? `Partial estimate · ${progress.jointCount} of 17 joints available at ${motionReviewClock(progress.poseTimestampMs ?? 0)}`
        : `Raw estimate · source frame ${(progress.frameIndex ?? 0) + 1} at ${motionReviewClock(progress.poseTimestampMs ?? 0)}`;
    case 'no_person':
      return 'No person was detected at this sampled frame. The surface is blank.';
    case 'multiple_people':
      return 'More than one person was detected. No body is selected or shown.';
    case 'unavailable':
      return 'The 3D estimate is unavailable at this sampled frame. The surface is blank.';
    case 'insufficient_joints':
      return 'Not enough available joints to show a surface at this frame.';
    case 'gap':
      return 'No sampled estimate at this time. The surface is blank; gaps are not filled.';
  }
}

export function motionScaleDescription(scale: MotionReviewScale): string {
  switch (scale) {
    case 'reference':
      return 'Scale uses Vision’s 1.8 m reference height, not your measured height.';
    case 'measured':
      return 'Scale uses Vision’s body-height estimate, not a calibrated body measurement.';
    case 'mixed':
      return 'Scale varies between Vision’s body-height estimate and its 1.8 m reference height. It is not calibrated.';
    case 'unavailable':
      return 'No body-scale estimate is available in this record.';
  }
}

export function motionReviewError(code: string): string {
  switch (code) {
    case 'artifact_digest_mismatch':
      return 'The saved 3D record failed its integrity check. Nothing is rendered.';
    case 'source_digest_mismatch':
      return 'This recording does not match the 3D record. Playback is blocked.';
    case 'invalid_source_uri':
      return 'Only a recording in this app’s private Captures folder can be opened.';
    case 'source_timing_mismatch':
      return 'The recording’s source frames do not match the 3D record. Playback is blocked.';
    case 'source_unreadable':
      return 'The recording could not be read. Synchronized playback is unavailable.';
    default:
      return 'The saved 3D record is invalid or unsupported. Nothing is rendered.';
  }
}
