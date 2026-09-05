/**
 * Seeded generators for the native capture payloads `assertCapturedClip`
 * validates (apps/mobile/src/camera/capture.ts), plus a catalogue of
 * near-legal MUTATIONS, each tagged with the outcome the documented contract
 * requires (`invalid: true` → the boundary must reject; `invalid: false` →
 * a legal variant the boundary must accept unchanged).
 *
 * The legal generator deliberately lands on the contract's boundaries
 * (fps 0, 1×1 and 100×4000 frames, trigger.endMs === durationMs,
 * confidence 0/1, reprojection error === 3px, exactly 50 completion
 * samples, ambiguityDurationMs === 3000 …) because that is where a
 * validator drifts. Nothing here reads a clock or Math.random.
 */
import { PICKLEBALL_TECHNIQUES } from '@pickle/shared-types';
import {
  CAPTURE_COMPLETION_PARAMS_V1,
  CAPTURE_EVIDENCE_JOINTS,
  MAX_BALL_SPEED_REPROJECTION_ERROR_PX,
  MAX_COMPLETION_MOTION_SAMPLES,
  TARGET_LOCK_PARAMS_V1,
} from '../../src/camera/capture';
import type { SeededRng } from './seededRng';

export type Payload = Record<string, unknown>;
export type ClipMode = 'automatic_pose_trigger' | 'imported_video';

const TECHNIQUE_SLUGS = PICKLEBALL_TECHNIQUES.map(t => t.slug);

/** Frame rates the boundary must accept (finite, ≥ 0) — including the odd ones. */
export const LEGAL_FPS = [
  0, 0.5, 1, 14.99, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100,
  119.88, 120, 240, 1000,
] as const;

/** Frame geometries the boundary must accept (positive safe integers). */
export const LEGAL_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1080, 1920],
  [1280, 720],
  [720, 1280],
  [640, 480],
  [480, 640],
  [3840, 2160],
  [7680, 4320],
  [1, 1],
  [4000, 100],
  [100, 4000],
  [1, 4096],
  [1080, 2340],
  [479, 479],
  [720, 719],
];

export const LEGAL_DURATIONS = [
  1, 999, 1000, 1500, 2000, 2999.9666, 3000, 4500.5, 7000, 12000, 30000, 90000,
  180000, 180001, 600000,
] as const;

function fileUri(rng: SeededRng, name: string, ext: string): string {
  return `file:///private/var/mobile/Containers/Data/Application/${rng.hex(
    8,
  )}/tmp/${name}-${rng.hex(6)}.${ext}`;
}

function isoDate(rng: SeededRng): string {
  const ms = Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23));
  return new Date(ms + rng.int(0, 3_599_999)).toISOString();
}

function unit(rng: SeededRng): number {
  return rng.pick([0, 1, 0.5, rng.float(), Number(rng.float().toFixed(3))]);
}

function positiveUnit(rng: SeededRng): number {
  return rng.pick([1, 0.5, 1e-9, Math.max(1e-9, rng.float())]);
}

function version(rng: SeededRng, prefix: string): string {
  return `${prefix}-v${rng.int(1, 9)}.${rng.int(0, 20)}`;
}

export function legalRecognition(rng: SeededRng): Payload {
  if (rng.chance(0.5)) {
    return {
      status: 'recognized',
      shotType: rng.pick(TECHNIQUE_SLUGS),
      confidence: positiveUnit(rng),
      modelVersion: version(rng, 'stroke-classifier'),
    };
  }
  const recognition: Payload = {
    status: rng.pick(['unknown', 'abstained']),
    reason: rng.pick(['low_confidence', 'no_match', 'not_run']),
  };
  if (rng.chance(0.5)) recognition.confidence = unit(rng);
  if (rng.chance(0.5)) recognition.modelVersion = version(rng, 'cls');
  return recognition;
}

export function legalPoseSequenceRef(rng: SeededRng): Payload {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: fileUri(rng, 'pose', 'json'),
    frameCount: rng.int(1, 5000),
    sha256: rng.hex(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: version(rng, 'apple-vision-body-pose'),
  };
}

interface Trigger {
  startMs: number;
  endMs: number;
  peakMotionMs?: number;
  confidence: number;
  source: 'temporal_pose_motion';
  modelVersion: string;
}

function legalTrigger(rng: SeededRng, durationMs: number): Trigger {
  const endMs = rng.chance(0.2)
    ? durationMs
    : Math.max(Number.MIN_VALUE, durationMs * (0.3 + rng.float() * 0.7));
  const startMs = rng.chance(0.2) ? 0 : endMs * rng.float() * 0.9;
  const trigger: Trigger = {
    startMs,
    endMs,
    confidence: unit(rng),
    source: 'temporal_pose_motion',
    modelVersion: version(rng, 'temporal-pose-motion'),
  };
  if (rng.chance(0.7)) {
    trigger.peakMotionMs = rng.pick([
      startMs,
      endMs,
      startMs + (endMs - startMs) * rng.float(),
    ]);
  }
  return trigger;
}

function legalCaptureEvidence(rng: SeededRng, trigger: Trigger): Payload {
  const poseFrameCount = rng.int(2, 400);
  const poseMissingFrameCount = rng.pick([0, rng.int(0, 100)]);
  const window = trigger.endMs - trigger.startMs;
  const meanJointCoverage = unit(rng);
  const minimumJointCoverage = rng.chance(0.3)
    ? meanJointCoverage
    : meanJointCoverage * rng.float();
  const jointCount = rng.int(1, CAPTURE_EVIDENCE_JOINTS.length);
  const joints = CAPTURE_EVIDENCE_JOINTS.filter(() => true)
    .map((joint, index) => ({ joint, index, keep: rng.float() }))
    .sort((a, b) => a.keep - b.keep)
    .slice(0, jointCount)
    .sort((a, b) => a.index - b.index);
  return {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: rng.pick([
      'apple_vision_body_pose',
      'mediapipe_pose_landmarker',
    ]),
    poseModelVersion: version(rng, 'pose-model'),
    triggerAlgorithmVersion: trigger.modelVersion,
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: poseFrameCount + poseMissingFrameCount,
    poseFrameCount,
    poseMissingFrameCount,
    trackedDurationMs: rng.chance(0.3)
      ? Math.floor(window)
      : rng.int(0, Math.floor(window)),
    meanCanonicalJointVisibility: unit(rng),
    meanJointCoverage,
    minimumJointCoverage,
    fullBodyVisibleFrameCount: rng.pick([
      0,
      poseFrameCount,
      rng.int(0, poseFrameCount),
    ]),
    jointMotion: joints.map(({ joint }) => {
      const mean = rng.pick([0, rng.float() * 5]);
      return {
        joint,
        sampleCount: rng.chance(0.3)
          ? poseFrameCount - 1
          : rng.int(1, poseFrameCount - 1),
        meanNormalizedPerSecond: mean,
        peakNormalizedPerSecond: rng.chance(0.3)
          ? mean
          : mean + rng.float() * 5,
      };
    }),
  };
}

export const MPH_PER_MPS = 2.2369362920544;

function legalBallSpeed(rng: SeededRng, durationMs: number): Payload {
  const measurementFrameRate = rng.pick([
    100,
    120,
    240,
    100 + rng.float() * 900,
  ]);
  const minTracked = Math.ceil(4000 / measurementFrameRate) + 1;
  const maxTracked = Math.min(Math.floor(durationMs), 2000);
  if (rng.chance(0.5) || maxTracked < minTracked) {
    return {
      status: 'unavailable',
      reason: rng.pick([
        'calibrated_ball_tracker_unavailable',
        'camera_not_calibrated',
        'frame_rate_too_low',
        'track_too_short',
        'out_of_plane_motion',
        'low_confidence',
      ]),
    };
  }
  const trackedDurationMs = rng.int(minTracked, maxTracked);
  const metersPerSecond = 1 + rng.float() * 40;
  const maxPoints =
    Math.ceil((measurementFrameRate * trackedDurationMs) / 1000) + 1;
  return {
    status: 'measured',
    milesPerHour: metersPerSecond * MPH_PER_MPS,
    metersPerSecond,
    confidence: positiveUnit(rng),
    source: 'calibrated_monocular_ball_track',
    calibrationId: `cal-${rng.hex(8)}`,
    trackerModelVersion: version(rng, 'ball-tracker'),
    measurementFrameRate,
    trackPointCount: rng.chance(0.3) ? maxPoints : rng.int(5, maxPoints),
    trackedDistanceMeters: (metersPerSecond * trackedDurationMs) / 1000,
    trackedDurationMs,
    reprojectionErrorPx: rng.pick([
      0,
      MAX_BALL_SPEED_REPROJECTION_ERROR_PX,
      rng.float() * MAX_BALL_SPEED_REPROJECTION_ERROR_PX,
    ]),
  };
}

function legalCompletion(rng: SeededRng, trigger: Trigger): Payload {
  const anchorMs = trigger.peakMotionMs ?? trigger.endMs;
  const movementCompleteMs = trigger.endMs;
  const sampleCount = rng.pick([
    0,
    MAX_COMPLETION_MOTION_SAMPLES,
    rng.int(0, MAX_COMPLETION_MOTION_SAMPLES),
  ]);
  const samples: Array<{ tMs: number; v: number }> = [];
  let tMs = Math.ceil(anchorMs);
  for (let i = 0; i < sampleCount; i++) {
    samples.push({ tMs, v: rng.pick([0, rng.float() * 3]) });
    tMs += rng.int(1, 40);
  }
  const completion: Payload = {
    schemaVersion: 1,
    completionStrategy: rng.pick(['fixed', 'adaptive']),
    algorithmVersion: version(rng, 'd029-completion'),
    motionUnit: 'normalized_image_units_per_second',
    movementCompleteMs,
    anchorMs,
    finalizeMs: rng.chance(0.3)
      ? movementCompleteMs
      : movementCompleteMs + rng.float() * 2500,
    peakMotionValue: rng.pick([0, rng.float() * 10]),
    safetyMaxHit: false,
    observedUntilMs: rng.chance(0.3)
      ? movementCompleteMs
      : movementCompleteMs + rng.float() * 2500,
    observedSampleCount: rng.chance(0.5)
      ? sampleCount
      : sampleCount + rng.int(0, 200),
    params: { ...CAPTURE_COMPLETION_PARAMS_V1 },
    postCompletionMotion: samples,
  };
  switch (rng.int(0, 3)) {
    case 0:
      completion.settleDetectedMs =
        anchorMs + rng.pick([0, rng.float() * 2000]);
      break;
    case 1:
      completion.valleyDetectedMs =
        anchorMs + rng.pick([0, rng.float() * 2000]);
      break;
    case 2:
      completion.safetyMaxHit = true;
      break;
    default:
      break;
  }
  return completion;
}

function legalTargetLock(rng: SeededRng): {
  targetLock: Payload;
  targetSeed?: Payload;
} {
  const tapPoint = { x: unit(rng), y: unit(rng) };
  const base: Payload = {
    schemaVersion: 1,
    algorithmVersion: version(rng, 'd027-acquire'),
    coordinateSystem: 'normalized_capture_space',
    tapPoint,
    params: { ...TARGET_LOCK_PARAMS_V1 },
  };
  if (rng.chance(0.3)) {
    const ambiguityEntered = rng.chance(0.5);
    return {
      targetLock: {
        ...base,
        lockOutcome: 'no_lock',
        ambiguityEntered,
        ...(ambiguityEntered
          ? { ambiguityDurationMs: rng.int(0, 10_000) }
          : {}),
      },
    };
  }
  const lockSource = rng.pick([
    'start_region_occupancy',
    'gesture_confirmed',
    'ambiguity_timeout',
  ] as const);
  const lockTorso = { x: unit(rng), y: unit(rng) };
  const ambiguityEntered =
    lockSource === 'start_region_occupancy' ? rng.chance(0.5) : true;
  const ambiguityDurationMs =
    lockSource === 'ambiguity_timeout'
      ? TARGET_LOCK_PARAMS_V1.ambiguityTimeoutMs +
        rng.pick([0, rng.int(0, 5000)])
      : rng.int(0, 10_000);
  return {
    targetLock: {
      ...base,
      lockOutcome: 'locked',
      lockSource,
      lockTorso,
      tapToLockDistance: Math.hypot(
        lockTorso.x - tapPoint.x,
        lockTorso.y - tapPoint.y,
      ),
      timeToLockMs: rng.int(0, 20_000),
      ambiguityEntered,
      ...(ambiguityEntered ? { ambiguityDurationMs } : {}),
    },
    targetSeed: { x: lockTorso.x, y: lockTorso.y, source: lockSource },
  };
}

function legalBase(rng: SeededRng): Payload {
  const [width, height] = rng.pick(LEGAL_DIMENSIONS);
  const base: Payload = {
    uri: fileUri(rng, 'clip', rng.pick(['mov', 'mp4'])),
    durationMs: rng.pick(LEGAL_DURATIONS),
    fps: rng.pick(LEGAL_FPS),
    width,
    height,
    capturedAtIso: isoDate(rng),
    recognition: legalRecognition(rng),
  };
  if (rng.chance(0.5)) base.byteSize = rng.int(1, 2 ** 31);
  if (rng.chance(0.5)) base.posterUri = fileUri(rng, 'poster', 'jpg');
  if (rng.chance(0.3)) base.poseSequence = legalPoseSequenceRef(rng);
  if (rng.chance(0.2)) base[`vendorExtension_${rng.hex(4)}`] = rng.int(0, 99);
  return base;
}

/** A structurally legal automatic-pose-trigger payload (shape only — no measurement claims). */
export function legalAutomaticClip(rng: SeededRng): Payload {
  const base = legalBase(rng);
  const durationMs = base.durationMs as number;
  const trigger = legalTrigger(rng, durationMs);
  const clip: Payload = {
    ...base,
    captureMode: 'automatic_pose_trigger',
    trigger,
    captureEvidence: legalCaptureEvidence(rng, trigger),
    ballSpeed: legalBallSpeed(rng, durationMs),
    preRollMs: rng.pick([0, durationMs, durationMs * rng.float()]),
    postRollMs: rng.pick([0, durationMs, durationMs * rng.float()]),
  };
  if (rng.chance(0.5)) clip.completion = legalCompletion(rng, trigger);
  const lockRoll = rng.int(0, 3);
  if (lockRoll === 0 || lockRoll === 1) {
    const { targetLock, targetSeed } = legalTargetLock(rng);
    clip.targetLock = targetLock;
    if (targetSeed) clip.targetSeed = targetSeed;
  } else if (lockRoll === 2) {
    // Legal per contract: a seed without lock telemetry (older builds).
    clip.targetSeed = {
      x: unit(rng),
      y: unit(rng),
      source: rng.pick(['start_region_occupancy', 'gesture_confirmed']),
    };
  }
  return clip;
}

/** A structurally legal imported-video payload. */
export function legalImportedClip(rng: SeededRng): Payload {
  const base = legalBase(rng);
  return {
    ...base,
    captureMode: 'imported_video',
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

export function legalClip(rng: SeededRng, mode: ClipMode): Payload {
  return mode === 'automatic_pose_trigger'
    ? legalAutomaticClip(rng)
    : legalImportedClip(rng);
}

/** A structurally legal imported-pose-extraction receipt. */
export function legalPoseExtraction(rng: SeededRng): Payload {
  const framesTotal = rng.int(1, 20_000);
  const receipt: Payload = {
    poseSequence: legalPoseSequenceRef(rng),
    framesWithPose: rng.pick([1, framesTotal, rng.int(1, framesTotal)]),
    framesTotal,
  };
  if (rng.chance(0.5)) receipt.posterUri = fileUri(rng, 'poster', 'jpg');
  if (rng.chance(0.3)) receipt.extractionWallMs = rng.int(1, 60_000);
  return receipt;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export interface Mutation {
  id: string;
  /** Payload modes the mutation applies to. */
  modes: readonly ClipMode[];
  /** True when the documented contract requires rejection after this mutation. */
  invalid: boolean;
  /** Mutates in place; returns false when the payload has no such field. */
  apply(payload: Payload, rng: SeededRng): boolean;
}

const BOTH: readonly ClipMode[] = ['automatic_pose_trigger', 'imported_video'];
const AUTO: readonly ClipMode[] = ['automatic_pose_trigger'];
const IMPORTED: readonly ClipMode[] = ['imported_video'];

function rec(value: unknown): Payload | null {
  return typeof value === 'object' && value !== null
    ? (value as Payload)
    : null;
}

function motionOf(payload: Payload): Payload[] | null {
  const evidence = rec(payload.captureEvidence);
  const motion = evidence?.jointMotion;
  return Array.isArray(motion) ? (motion as Payload[]) : null;
}

function setField(
  id: string,
  modes: readonly ClipMode[],
  path: readonly string[],
  value: (current: unknown, root: Payload, rng: SeededRng) => unknown,
  invalid = true,
): Mutation {
  return {
    id,
    modes,
    invalid,
    apply(payload, rng) {
      let target: Payload = payload;
      for (let i = 0; i < path.length - 1; i++) {
        const next = rec(target[path[i] as string]);
        if (!next) return false;
        target = next;
      }
      const key = path[path.length - 1] as string;
      if (!(key in target)) return false;
      // An earlier mutation may have replaced the fields this one derives
      // from (trigger → null, evidence → {}, …); computing throws BEFORE any
      // write, so declining is safe and keeps the expected verdict honest.
      let next: unknown;
      try {
        next = value(target[key], payload, rng);
      } catch {
        return false;
      }
      target[key] = next;
      return true;
    },
  };
}

function deleteField(
  id: string,
  modes: readonly ClipMode[],
  path: readonly string[],
  invalid: boolean,
): Mutation {
  return {
    id,
    modes,
    invalid,
    apply(payload) {
      let target: Payload = payload;
      for (let i = 0; i < path.length - 1; i++) {
        const next = rec(target[path[i] as string]);
        if (!next) return false;
        target = next;
      }
      const key = path[path.length - 1] as string;
      if (!(key in target)) return false;
      delete target[key];
      return true;
    },
  };
}

function nextUp(value: number): number {
  const bumped = value + Math.max(Number.MIN_VALUE, Math.abs(value) * 2.3e-16);
  return bumped > value ? bumped : value + Number.EPSILON;
}

export const MUTATIONS: readonly Mutation[] = [
  // Base fields
  setField(
    'uri_https',
    BOTH,
    ['uri'],
    () => 'https://example.invalid/clip.mov',
  ),
  setField('uri_empty', BOTH, ['uri'], () => ''),
  setField('uri_number', BOTH, ['uri'], () => 42),
  setField(
    'uri_capitalised_scheme',
    BOTH,
    ['uri'],
    () => 'File:///tmp/clip.mov',
  ),
  setField('duration_zero', BOTH, ['durationMs'], () => 0),
  setField('duration_negative_zero', BOTH, ['durationMs'], () => -0),
  setField('duration_negative', BOTH, ['durationMs'], () => -1),
  setField('duration_nan', BOTH, ['durationMs'], () => Number.NaN),
  setField(
    'duration_infinity',
    BOTH,
    ['durationMs'],
    () => Number.POSITIVE_INFINITY,
  ),
  setField('duration_string', BOTH, ['durationMs'], () => '3000'),
  setField('width_zero', BOTH, ['width'], () => 0),
  setField('width_fraction', BOTH, ['width'], () => 1.5),
  setField('width_negative', BOTH, ['width'], () => -1920),
  setField('width_unsafe_integer', BOTH, ['width'], () => 2 ** 53),
  setField('height_nan', BOTH, ['height'], () => Number.NaN),
  setField('height_string', BOTH, ['height'], () => '1080'),
  setField('fps_negative', BOTH, ['fps'], () => -1),
  setField('fps_negative_tiny', BOTH, ['fps'], () => -1e-9),
  setField('fps_nan', BOTH, ['fps'], () => Number.NaN),
  setField('fps_infinity', BOTH, ['fps'], () => Number.POSITIVE_INFINITY),
  setField('fps_string', BOTH, ['fps'], () => '30'),
  setField('fps_zero_legal', BOTH, ['fps'], () => 0, false),
  setField('fps_negative_zero_legal', BOTH, ['fps'], () => -0, false),
  setField('byteSize_zero', BOTH, ['byteSize'], () => 0),
  setField('byteSize_fraction', BOTH, ['byteSize'], () => 1024.5),
  deleteField('byteSize_removed_legal', BOTH, ['byteSize'], false),
  setField(
    'capturedAt_garbage',
    BOTH,
    ['capturedAtIso'],
    () => 'yesterday-ish',
  ),
  setField('capturedAt_empty', BOTH, ['capturedAtIso'], () => ''),
  setField(
    'capturedAt_number',
    BOTH,
    ['capturedAtIso'],
    () => 1_700_000_000_000,
  ),
  setField(
    'posterUri_https',
    BOTH,
    ['posterUri'],
    () => 'https://cdn.invalid/p.jpg',
  ),
  setField('posterUri_null', BOTH, ['posterUri'], () => null),
  deleteField('posterUri_removed_legal', BOTH, ['posterUri'], false),
  setField('captureMode_unknown', BOTH, ['captureMode'], () => 'manual'),
  setField('captureMode_null', BOTH, ['captureMode'], () => null),
  // Recognition
  setField('recognition_null', BOTH, ['recognition'], () => null),
  setField('recognition_bad_slug', BOTH, ['recognition'], () => ({
    status: 'recognized',
    shotType: 'forehand_smash_9000',
    confidence: 0.9,
    modelVersion: 'x',
  })),
  setField(
    'recognition_confidence_zero',
    BOTH,
    ['recognition'],
    (_c, _r, rng) => ({
      status: 'recognized',
      shotType: rng.pick(TECHNIQUE_SLUGS),
      confidence: 0,
      modelVersion: 'x',
    }),
  ),
  setField(
    'recognition_confidence_above_one',
    BOTH,
    ['recognition'],
    (_c, _r, rng) => ({
      status: 'recognized',
      shotType: rng.pick(TECHNIQUE_SLUGS),
      confidence: nextUp(1),
      modelVersion: 'x',
    }),
  ),
  setField(
    'recognition_missing_model',
    BOTH,
    ['recognition'],
    (_c, _r, rng) => ({
      status: 'recognized',
      shotType: rng.pick(TECHNIQUE_SLUGS),
      confidence: 0.7,
    }),
  ),
  setField('recognition_blank_model', BOTH, ['recognition'], (_c, _r, rng) => ({
    status: 'recognized',
    shotType: rng.pick(TECHNIQUE_SLUGS),
    confidence: 0.7,
    modelVersion: '   ',
  })),
  setField(
    'recognition_recognized_with_reason',
    BOTH,
    ['recognition'],
    (_c, _r, rng) => ({
      status: 'recognized',
      shotType: rng.pick(TECHNIQUE_SLUGS),
      confidence: 0.7,
      modelVersion: 'x',
      reason: 'why',
    }),
  ),
  setField(
    'recognition_unknown_with_shotType',
    BOTH,
    ['recognition'],
    (_c, _r, rng) => ({
      status: 'unknown',
      reason: 'low_confidence',
      shotType: rng.pick(TECHNIQUE_SLUGS),
    }),
  ),
  setField('recognition_unknown_blank_reason', BOTH, ['recognition'], () => ({
    status: 'abstained',
    reason: ' ',
  })),
  setField(
    'recognition_unknown_confidence_above_one',
    BOTH,
    ['recognition'],
    () => ({
      status: 'unknown',
      reason: 'low_confidence',
      confidence: 1.0001,
    }),
  ),
  setField('recognition_status_unknown_value', BOTH, ['recognition'], () => ({
    status: 'guessed',
    reason: 'low_confidence',
  })),
  setField(
    'recognition_unknown_confidence_zero_legal',
    BOTH,
    ['recognition'],
    () => ({ status: 'unknown', reason: 'low_confidence', confidence: 0 }),
    false,
  ),
  // Pose sequence sidecar
  setField('poseSeq_sha_uppercase', BOTH, ['poseSequence', 'sha256'], c =>
    String(c).toUpperCase(),
  ),
  setField('poseSeq_sha_63_chars', BOTH, ['poseSequence', 'sha256'], c =>
    String(c).slice(0, 63),
  ),
  setField(
    'poseSeq_frameCount_zero',
    BOTH,
    ['poseSequence', 'frameCount'],
    () => 0,
  ),
  setField(
    'poseSeq_uri_https',
    BOTH,
    ['poseSequence', 'uri'],
    () => 'https://x.invalid/p.json',
  ),
  setField(
    'poseSeq_format_v2',
    BOTH,
    ['poseSequence', 'format'],
    () => 'pickle.pose-sequence.v2',
  ),
  setField(
    'poseSeq_schema_2',
    BOTH,
    ['poseSequence', 'schemaVersion'],
    () => 2,
  ),
  setField('poseSeq_null', BOTH, ['poseSequence'], () => null),
  deleteField('poseSeq_removed_legal', BOTH, ['poseSequence'], false),
  // Trigger (automatic only)
  deleteField('trigger_missing', AUTO, ['trigger'], true),
  setField(
    'trigger_end_past_duration',
    AUTO,
    ['trigger', 'endMs'],
    (_c, root) => nextUp(root.durationMs as number),
  ),
  setField(
    'trigger_end_equals_start',
    AUTO,
    ['trigger', 'endMs'],
    (_c, root) => (root.trigger as Trigger).startMs,
  ),
  setField('trigger_start_negative', AUTO, ['trigger', 'startMs'], () => -1e-6),
  setField('trigger_start_nan', AUTO, ['trigger', 'startMs'], () => Number.NaN),
  setField(
    'trigger_peak_past_end',
    AUTO,
    ['trigger', 'peakMotionMs'],
    (_c, root) => nextUp((root.trigger as Trigger).endMs),
  ),
  setField(
    'trigger_peak_before_start',
    AUTO,
    ['trigger', 'peakMotionMs'],
    (_c, root) => {
      const start = (root.trigger as Trigger).startMs;
      return start === 0 ? -1e-9 : start - Math.min(start, 1e-6);
    },
  ),
  setField(
    'trigger_confidence_above_one',
    AUTO,
    ['trigger', 'confidence'],
    () => nextUp(1),
  ),
  setField(
    'trigger_confidence_negative',
    AUTO,
    ['trigger', 'confidence'],
    () => -1e-9,
  ),
  setField(
    'trigger_source_wrong',
    AUTO,
    ['trigger', 'source'],
    () => 'audio_impulse',
  ),
  setField(
    'trigger_model_blank',
    AUTO,
    ['trigger', 'modelVersion'],
    () => '  ',
  ),
  {
    id: 'trigger_contactMs_present',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const trigger = rec(payload.trigger);
      if (!trigger) return false;
      trigger.contactMs = trigger.startMs;
      return true;
    },
  },
  // Capture evidence
  deleteField('evidence_missing', AUTO, ['captureEvidence'], true),
  setField(
    'evidence_schema_2',
    AUTO,
    ['captureEvidence', 'schemaVersion'],
    () => 2,
  ),
  setField(
    'evidence_window_wrong',
    AUTO,
    ['captureEvidence', 'window'],
    () => 'whole_clip',
  ),
  setField(
    'evidence_poseSource_wrong',
    AUTO,
    ['captureEvidence', 'poseSource'],
    () => 'openpose',
  ),
  setField(
    'evidence_algo_mismatch',
    AUTO,
    ['captureEvidence', 'triggerAlgorithmVersion'],
    c => `${String(c)}-drift`,
  ),
  setField(
    'evidence_frame_sum_off',
    AUTO,
    ['captureEvidence', 'analysisInputFrameCount'],
    c => (c as number) + 1,
  ),
  setField(
    'evidence_poseFrames_zero',
    AUTO,
    ['captureEvidence', 'poseFrameCount'],
    () => 0,
  ),
  setField(
    'evidence_missingFrames_negative',
    AUTO,
    ['captureEvidence', 'poseMissingFrameCount'],
    () => -1,
  ),
  setField(
    'evidence_tracked_past_window',
    AUTO,
    ['captureEvidence', 'trackedDurationMs'],
    (_c, root) => {
      const trigger = root.trigger as Trigger;
      return Math.floor(trigger.endMs - trigger.startMs) + 1;
    },
  ),
  setField(
    'evidence_tracked_fraction',
    AUTO,
    ['captureEvidence', 'trackedDurationMs'],
    () => 10.5,
  ),
  setField(
    'evidence_min_above_mean',
    AUTO,
    ['captureEvidence', 'minimumJointCoverage'],
    (_c, root) => {
      const mean = (root.captureEvidence as Payload)
        .meanJointCoverage as number;
      return mean >= 1 ? nextUp(1) : nextUp(mean);
    },
  ),
  setField(
    'evidence_visibility_above_one',
    AUTO,
    ['captureEvidence', 'meanCanonicalJointVisibility'],
    () => nextUp(1),
  ),
  setField(
    'evidence_fullBody_above_pose',
    AUTO,
    ['captureEvidence', 'fullBodyVisibleFrameCount'],
    (_c, root) =>
      ((root.captureEvidence as Payload).poseFrameCount as number) + 1,
  ),
  setField(
    'evidence_joints_empty',
    AUTO,
    ['captureEvidence', 'jointMotion'],
    () => [],
  ),
  setField(
    'evidence_joints_not_array',
    AUTO,
    ['captureEvidence', 'jointMotion'],
    () => ({}),
  ),
  {
    id: 'evidence_joint_unknown',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const motion = motionOf(payload);
      if (!motion || motion.length === 0) return false;
      (motion[motion.length - 1] as Payload).joint = 'neck';
      return true;
    },
  },
  {
    id: 'evidence_joint_duplicate',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const motion = motionOf(payload);
      if (!motion || motion.length === 0) return false;
      motion.push({ ...(motion[motion.length - 1] as Payload) });
      return true;
    },
  },
  {
    id: 'evidence_joint_out_of_order',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const motion = motionOf(payload);
      if (!motion || motion.length < 2) return false;
      motion.reverse();
      return true;
    },
  },
  {
    id: 'evidence_sampleCount_equals_poseFrames',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const evidence = rec(payload.captureEvidence);
      const motion = motionOf(payload);
      if (!evidence || !motion || motion.length === 0) return false;
      (motion[0] as Payload).sampleCount = evidence.poseFrameCount;
      return true;
    },
  },
  {
    id: 'evidence_peak_below_mean',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const motion = motionOf(payload);
      if (!motion || motion.length === 0) return false;
      const m = motion[0] as Payload;
      m.meanNormalizedPerSecond = (m.peakNormalizedPerSecond as number) + 1e-6;
      return true;
    },
  },
  {
    id: 'evidence_motion_negative',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const motion = motionOf(payload);
      if (!motion || motion.length === 0) return false;
      (motion[0] as Payload).meanNormalizedPerSecond = -1e-9;
      return true;
    },
  },
  // Ball speed
  setField(
    'ballSpeed_analysis_not_run_on_automatic',
    AUTO,
    ['ballSpeed'],
    () => ({
      status: 'unavailable',
      reason: 'analysis_not_run',
    }),
  ),
  setField('ballSpeed_unknown_reason', AUTO, ['ballSpeed'], () => ({
    status: 'unavailable',
    reason: 'ball_was_shy',
  })),
  setField('ballSpeed_unavailable_with_mph', AUTO, ['ballSpeed'], () => ({
    status: 'unavailable',
    reason: 'low_confidence',
    milesPerHour: 40,
  })),
  setField('ballSpeed_status_unknown', AUTO, ['ballSpeed'], () => ({
    status: 'estimated',
  })),
  {
    id: 'ballSpeed_mph_off_by_1pct',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.milesPerHour = (ball.milesPerHour as number) * 1.01;
      return true;
    },
  },
  {
    id: 'ballSpeed_distance_inconsistent',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.trackedDistanceMeters =
        (ball.trackedDistanceMeters as number) * 1.05;
      return true;
    },
  },
  {
    id: 'ballSpeed_rate_below_100',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.measurementFrameRate = 99.999;
      return true;
    },
  },
  {
    id: 'ballSpeed_points_below_5',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.trackPointCount = 4;
      return true;
    },
  },
  {
    id: 'ballSpeed_points_impossible',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.trackPointCount =
        Math.ceil(
          ((ball.measurementFrameRate as number) *
            (ball.trackedDurationMs as number)) /
            1000,
        ) + 2;
      return true;
    },
  },
  {
    id: 'ballSpeed_reprojection_over_max',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.reprojectionErrorPx = nextUp(MAX_BALL_SPEED_REPROJECTION_ERROR_PX);
      return true;
    },
  },
  {
    id: 'ballSpeed_tracked_past_clip',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.trackedDurationMs = Math.floor(payload.durationMs as number) + 1;
      return true;
    },
  },
  {
    id: 'ballSpeed_measured_with_reason',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.reason = 'low_confidence';
      return true;
    },
  },
  {
    id: 'ballSpeed_confidence_zero',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const ball = rec(payload.ballSpeed);
      if (!ball || ball.status !== 'measured') return false;
      ball.confidence = 0;
      return true;
    },
  },
  // Roll windows
  setField('preRoll_negative', AUTO, ['preRollMs'], () => -1),
  setField('preRoll_past_duration', AUTO, ['preRollMs'], (_c, root) =>
    nextUp(root.durationMs as number),
  ),
  setField('postRoll_nan', AUTO, ['postRollMs'], () => Number.NaN),
  deleteField('postRoll_missing', AUTO, ['postRollMs'], true),
  // Completion telemetry
  setField(
    'completion_movement_drift',
    AUTO,
    ['completion', 'movementCompleteMs'],
    c => nextUp(c as number),
  ),
  setField('completion_anchor_drift', AUTO, ['completion', 'anchorMs'], c =>
    nextUp(c as number),
  ),
  setField(
    'completion_finalize_before_movement',
    AUTO,
    ['completion', 'finalizeMs'],
    (_c, root) => {
      const movement = (root.completion as Payload)
        .movementCompleteMs as number;
      return movement === 0 ? -1e-9 : movement - Math.min(movement, 1e-6);
    },
  ),
  setField(
    'completion_observedUntil_before_movement',
    AUTO,
    ['completion', 'observedUntilMs'],
    (_c, root) => {
      const movement = (root.completion as Payload)
        .movementCompleteMs as number;
      return movement === 0 ? -1e-9 : movement - Math.min(movement, 1e-6);
    },
  ),
  setField(
    'completion_strategy_unknown',
    AUTO,
    ['completion', 'completionStrategy'],
    () => 'hybrid',
  ),
  setField(
    'completion_schema_2',
    AUTO,
    ['completion', 'schemaVersion'],
    () => 2,
  ),
  setField(
    'completion_safetyMaxHit_string',
    AUTO,
    ['completion', 'safetyMaxHit'],
    () => 'true',
  ),
  setField(
    'completion_observedSampleCount_fraction',
    AUTO,
    ['completion', 'observedSampleCount'],
    () => 3.5,
  ),
  {
    id: 'completion_two_decisions',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      completion.settleDetectedMs = completion.anchorMs;
      completion.valleyDetectedMs = completion.anchorMs;
      return true;
    },
  },
  {
    id: 'completion_settle_before_anchor',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const anchor = completion.anchorMs as number;
      delete completion.valleyDetectedMs;
      completion.safetyMaxHit = false;
      completion.settleDetectedMs =
        anchor === 0 ? -1e-9 : anchor - Math.min(anchor, 1e-6);
      return true;
    },
  },
  {
    id: 'completion_params_retuned',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      completion.params = {
        ...CAPTURE_COMPLETION_PARAMS_V1,
        settleHoldMs: 401,
      };
      return true;
    },
  },
  {
    id: 'completion_params_extra_key',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      completion.params = { ...CAPTURE_COMPLETION_PARAMS_V1, experimental: 1 };
      return true;
    },
  },
  {
    id: 'completion_params_missing_key',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const params: Payload = { ...CAPTURE_COMPLETION_PARAMS_V1 };
      delete params.valleyRiseMinGapMs;
      completion.params = params;
      return true;
    },
  },
  {
    id: 'completion_samples_over_cap',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const anchor = Math.ceil(completion.anchorMs as number);
      const samples: Array<{ tMs: number; v: number }> = [];
      for (let i = 0; i <= MAX_COMPLETION_MOTION_SAMPLES; i++) {
        samples.push({ tMs: anchor + i, v: 0 });
      }
      completion.postCompletionMotion = samples;
      completion.observedSampleCount = samples.length;
      return true;
    },
  },
  {
    id: 'completion_samples_exceed_observed',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const samples = completion.postCompletionMotion as Array<{
        tMs: number;
        v: number;
      }>;
      const anchor = Math.ceil(completion.anchorMs as number);
      if (samples.length === 0) samples.push({ tMs: anchor, v: 0 });
      completion.observedSampleCount = samples.length - 1;
      return true;
    },
  },
  {
    id: 'completion_samples_unsorted',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const anchor = Math.ceil(completion.anchorMs as number);
      completion.postCompletionMotion = [
        { tMs: anchor + 5, v: 0 },
        { tMs: anchor + 5, v: 0 },
      ];
      completion.observedSampleCount = Math.max(
        2,
        completion.observedSampleCount as number,
      );
      return true;
    },
  },
  {
    id: 'completion_sample_before_anchor',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const anchor = completion.anchorMs as number;
      if (anchor < 1) return false;
      completion.postCompletionMotion = [{ tMs: Math.ceil(anchor) - 1, v: 0 }];
      completion.observedSampleCount = Math.max(
        1,
        completion.observedSampleCount as number,
      );
      return true;
    },
  },
  {
    id: 'completion_sample_fractional_time',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const completion = rec(payload.completion);
      if (!completion) return false;
      const anchor = Math.ceil(completion.anchorMs as number);
      completion.postCompletionMotion = [{ tMs: anchor + 0.5, v: 0 }];
      completion.observedSampleCount = Math.max(
        1,
        completion.observedSampleCount as number,
      );
      return true;
    },
  },
  deleteField('completion_removed_legal', AUTO, ['completion'], false),
  // Target lock telemetry
  {
    id: 'targetLock_seed_mismatch',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      const seed = rec(payload.targetSeed);
      if (!lock || !seed || lock.lockOutcome !== 'locked') return false;
      seed.x = (seed.x as number) >= 1 ? 0 : nextUp(seed.x as number);
      return true;
    },
  },
  {
    id: 'targetLock_seed_source_mismatch',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      const seed = rec(payload.targetSeed);
      if (!lock || !seed || lock.lockOutcome !== 'locked') return false;
      seed.source =
        seed.source === 'gesture_confirmed'
          ? 'start_region_occupancy'
          : 'gesture_confirmed';
      return true;
    },
  },
  {
    id: 'targetLock_distance_drift',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock || lock.lockOutcome !== 'locked') return false;
      lock.tapToLockDistance = (lock.tapToLockDistance as number) + 1e-5;
      return true;
    },
  },
  {
    id: 'targetLock_no_lock_with_seed',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock || lock.lockOutcome !== 'no_lock') return false;
      payload.targetSeed = { x: 0.5, y: 0.5, source: 'start_region_occupancy' };
      return true;
    },
  },
  {
    id: 'targetLock_no_lock_with_torso',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock || lock.lockOutcome !== 'no_lock') return false;
      lock.lockTorso = { x: 0.5, y: 0.5 };
      return true;
    },
  },
  {
    id: 'targetLock_gesture_without_ambiguity',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      const seed = rec(payload.targetSeed);
      if (!lock || !seed || lock.lockOutcome !== 'locked') return false;
      lock.lockSource = 'gesture_confirmed';
      seed.source = 'gesture_confirmed';
      lock.ambiguityEntered = false;
      delete lock.ambiguityDurationMs;
      return true;
    },
  },
  {
    id: 'targetLock_timeout_too_short',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      const seed = rec(payload.targetSeed);
      if (!lock || !seed || lock.lockOutcome !== 'locked') return false;
      lock.lockSource = 'ambiguity_timeout';
      seed.source = 'ambiguity_timeout';
      lock.ambiguityEntered = true;
      lock.ambiguityDurationMs = TARGET_LOCK_PARAMS_V1.ambiguityTimeoutMs - 1;
      return true;
    },
  },
  {
    id: 'targetLock_duration_without_ambiguity',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock) return false;
      if (
        lock.lockSource === 'gesture_confirmed' ||
        lock.lockSource === 'ambiguity_timeout'
      ) {
        return false;
      }
      lock.ambiguityEntered = false;
      lock.ambiguityDurationMs = 10;
      return true;
    },
  },
  {
    id: 'targetLock_ambiguity_without_duration',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock) return false;
      lock.ambiguityEntered = true;
      delete lock.ambiguityDurationMs;
      return true;
    },
  },
  {
    id: 'targetLock_ambiguityDuration_fraction',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock) return false;
      lock.ambiguityEntered = true;
      lock.ambiguityDurationMs = 3000.5;
      return true;
    },
  },
  setField(
    'targetLock_tap_outside_frame',
    AUTO,
    ['targetLock', 'tapPoint'],
    () => ({
      x: nextUp(1),
      y: 0.5,
    }),
  ),
  setField(
    'targetLock_coordinateSystem_wrong',
    AUTO,
    ['targetLock', 'coordinateSystem'],
    () => 'pixels',
  ),
  setField(
    'targetLock_outcome_unknown',
    AUTO,
    ['targetLock', 'lockOutcome'],
    () => 'maybe',
  ),
  setField('targetLock_params_retuned', AUTO, ['targetLock', 'params'], () => ({
    ...TARGET_LOCK_PARAMS_V1,
    occupancyFramesToLock: 8,
  })),
  {
    id: 'targetLock_locked_missing_torso',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (!lock || lock.lockOutcome !== 'locked') return false;
      delete lock.lockTorso;
      return true;
    },
  },
  {
    id: 'targetLock_locked_missing_seed',
    modes: AUTO,
    invalid: true,
    apply(payload) {
      const lock = rec(payload.targetLock);
      if (
        !lock ||
        lock.lockOutcome !== 'locked' ||
        payload.targetSeed === undefined
      )
        return false;
      delete payload.targetSeed;
      return true;
    },
  },
  {
    id: 'targetLock_removed_legal',
    modes: AUTO,
    invalid: false,
    apply(payload) {
      if (payload.targetLock === undefined) return false;
      delete payload.targetLock;
      return true;
    },
  },
  // Imported-only contract: nothing automatic may ride along.
  {
    id: 'imported_with_trigger',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.trigger = {
        startMs: 0,
        endMs: 1,
        confidence: 1,
        source: 'temporal_pose_motion',
        modelVersion: 'x',
      };
      return true;
    },
  },
  {
    id: 'imported_with_preRoll_zero',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.preRollMs = 0;
      return true;
    },
  },
  {
    id: 'imported_with_postRoll',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.postRollMs = 500;
      return true;
    },
  },
  {
    id: 'imported_with_captureEvidence',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.captureEvidence = { schemaVersion: 1 };
      return true;
    },
  },
  {
    id: 'imported_with_completion',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.completion = { schemaVersion: 1 };
      return true;
    },
  },
  {
    id: 'imported_with_targetLock',
    modes: IMPORTED,
    invalid: true,
    apply(payload) {
      payload.targetLock = { schemaVersion: 1 };
      return true;
    },
  },
  setField('imported_ballSpeed_other_reason', IMPORTED, ['ballSpeed'], () => ({
    status: 'unavailable',
    reason: 'low_confidence',
  })),
  setField('imported_ballSpeed_measured', IMPORTED, ['ballSpeed'], () => ({
    status: 'measured',
    milesPerHour: 30,
    metersPerSecond: 30 / MPH_PER_MPS,
  })),
  setField('imported_ballSpeed_with_mph', IMPORTED, ['ballSpeed'], () => ({
    status: 'unavailable',
    reason: 'analysis_not_run',
    milesPerHour: 30,
  })),
  setField('imported_ballSpeed_null', IMPORTED, ['ballSpeed'], () => null),
  // Cross-mode: relabel keeps the other mode's blocks → must be rejected.
  setField(
    'automatic_relabelled_imported',
    AUTO,
    ['captureMode'],
    () => 'imported_video',
  ),
  setField(
    'imported_relabelled_automatic',
    IMPORTED,
    ['captureMode'],
    () => 'automatic_pose_trigger',
  ),
  // Legal variants
  {
    id: 'unknown_key_added_legal',
    modes: BOTH,
    invalid: false,
    apply(payload, rng) {
      payload[`vendor_${rng.hex(4)}`] = { nested: [rng.int(0, 9)] };
      return true;
    },
  },
];

export interface MutatedClip {
  payload: Payload;
  mode: ClipMode;
  applied: string[];
  /** True when at least one contract-invalidating mutation was applied. */
  expectInvalid: boolean;
}

/**
 * Applies 1–3 mutations drawn for `mode`. Legal variants are applied BEFORE
 * invalidating ones so a later legal deletion can never undo an earlier
 * invalidation (which would make `expectInvalid` lie).
 */
export function mutateClip(
  rng: SeededRng,
  payload: Payload,
  mode: ClipMode,
  count = rng.int(1, 3),
): MutatedClip {
  const candidates = MUTATIONS.filter(m => m.modes.includes(mode));
  const distinct = new Map<string, Mutation>();
  for (let i = 0; i < count; i++) {
    const m = rng.pick(candidates);
    distinct.set(m.id, m);
  }
  const chosen = [...distinct.values()].sort(
    (a, b) => Number(a.invalid) - Number(b.invalid),
  );
  const applied: string[] = [];
  let expectInvalid = false;
  for (const mutation of chosen) {
    if (mutation.apply(payload, rng)) {
      applied.push(mutation.id);
      if (mutation.invalid) expectInvalid = true;
    }
  }
  return { payload, mode, applied, expectInvalid };
}

/** Near-legal imported-pose-extraction receipts: id → (mutated receipt, invalid?). */
export const POSE_EXTRACTION_MUTATIONS: ReadonlyArray<{
  id: string;
  invalid: boolean;
  apply(receipt: Payload): boolean;
}> = [
  {
    id: 'framesWithPose_above_total',
    invalid: true,
    apply(r) {
      r.framesWithPose = (r.framesTotal as number) + 1;
      return true;
    },
  },
  {
    id: 'framesWithPose_zero',
    invalid: true,
    apply(r) {
      r.framesWithPose = 0;
      return true;
    },
  },
  {
    id: 'framesTotal_fraction',
    invalid: true,
    apply(r) {
      r.framesTotal = (r.framesTotal as number) + 0.5;
      r.framesWithPose = 1;
      return true;
    },
  },
  {
    id: 'framesTotal_string',
    invalid: true,
    apply(r) {
      r.framesTotal = String(r.framesTotal);
      return true;
    },
  },
  {
    id: 'posterUri_https',
    invalid: true,
    apply(r) {
      r.posterUri = 'https://cdn.invalid/poster.jpg';
      return true;
    },
  },
  {
    id: 'posterUri_null',
    invalid: true,
    apply(r) {
      r.posterUri = null;
      return true;
    },
  },
  {
    id: 'poseSequence_sha_uppercase',
    invalid: true,
    apply(r) {
      const ref = rec(r.poseSequence);
      if (!ref) return false;
      ref.sha256 = String(ref.sha256).toUpperCase();
      return true;
    },
  },
  {
    id: 'poseSequence_frameCount_zero',
    invalid: true,
    apply(r) {
      const ref = rec(r.poseSequence);
      if (!ref) return false;
      ref.frameCount = 0;
      return true;
    },
  },
  {
    id: 'poseSequence_missing',
    invalid: true,
    apply(r) {
      delete r.poseSequence;
      return true;
    },
  },
  {
    id: 'poseSequence_uri_https',
    invalid: true,
    apply(r) {
      const ref = rec(r.poseSequence);
      if (!ref) return false;
      ref.uri = 'https://x.invalid/pose.json';
      return true;
    },
  },
  {
    id: 'posterUri_removed_legal',
    invalid: false,
    apply(r) {
      if (r.posterUri === undefined) return false;
      delete r.posterUri;
      return true;
    },
  },
  {
    id: 'framesWithPose_equals_total_legal',
    invalid: false,
    apply(r) {
      r.framesWithPose = r.framesTotal;
      return true;
    },
  },
];
