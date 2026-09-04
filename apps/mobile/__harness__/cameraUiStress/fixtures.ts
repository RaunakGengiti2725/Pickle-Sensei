/**
 * Seeded fixture generators for the camera-UI stress campaign.
 *
 * Two payload grades, recorded on every row:
 *   - `validatorAccepts: true` — the clip passes `assertCapturedClip`, i.e. it
 *     is a payload the native bridge would actually hand the UI. Any defect
 *     rendered from such a payload is a real finding.
 *   - `validatorAccepts: false` — hostile shape the bridge rejects upstream;
 *     rendering it measures the component's own robustness only.
 */
import {
  ENVELOPE_DIMENSIONS,
  type EnvelopeDimension,
  type EnvelopeVerdict,
} from '@pickle/shared-types';
import {
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from '@pickle/capture-envelope';
import {
  assertCapturedClip,
  CAPTURE_EVIDENCE_JOINTS,
  type BallSpeedEvidence,
  type BallSpeedUnavailableReason,
  type CapturedClip,
  type CaptureEvidenceJoint,
} from '../../src/camera/capture';
import { NUMERIC_EXTREMES, STRING_CORPUS, type StringClass } from './corpus';
import type { SeededRng } from './rng';

export type ContentClass =
  'valid' | 'boundary-numeric' | 'hostile-string' | 'structural';

export interface Mutation {
  id: string;
  /** JSON-safe description of the injected value. */
  value: string;
}

export function describeValue(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'string') {
    const preview = value.length > 40 ? `${value.slice(0, 37)}…` : value;
    return `"${preview}" (len=${value.length}, cps=${[...value].length})`;
  }
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  return JSON.stringify(value);
}

export function hostileString(rng: SeededRng, classes: readonly StringClass[]) {
  const cls = rng.pick(classes);
  return { cls, value: rng.pick(STRING_CORPUS[cls]) };
}

const UNAVAILABLE_REASONS: readonly BallSpeedUnavailableReason[] = [
  'calibrated_ball_tracker_unavailable',
  'camera_not_calibrated',
  'frame_rate_too_low',
  'track_too_short',
  'out_of_plane_motion',
  'low_confidence',
];

type MeasuredClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;
type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

/** Validator-clean measured clip with seeded, in-contract values. */
export function baseMeasuredClip(rng: SeededRng): MeasuredClip {
  const durationMs = rng.int(1200, 12000);
  const startMs = rng.int(0, Math.floor(durationMs * 0.4));
  const endMs = rng.int(startMs + 200, durationMs);
  const poseFrameCount = rng.int(3, 900);
  const poseMissingFrameCount = rng.int(0, 120);
  const meanJointCoverage = rng.float(0.2, 1);
  const jointCount = rng.int(1, CAPTURE_EVIDENCE_JOINTS.length);
  const joints = CAPTURE_EVIDENCE_JOINTS.filter(
    (_, index) => index < jointCount,
  );
  const measured = rng.chance(0.35);
  const trackedDurationMs = rng.int(200, Math.max(200, endMs - startMs));
  const metersPerSecond = rng.float(3, 40);
  const ballTrackedDurationMs = rng.int(80, Math.min(durationMs, 600));
  const measurementFrameRate = rng.pick([120, 240, 480]);
  const ballSpeed: BallSpeedEvidence = measured
    ? {
        status: 'measured',
        milesPerHour: metersPerSecond * 2.2369362920544,
        metersPerSecond,
        confidence: rng.float(0.05, 1),
        source: 'calibrated_monocular_ball_track',
        calibrationId: `cal-${rng.int(1, 9999)}`,
        trackerModelVersion: `ball-track-${rng.int(1, 9)}`,
        measurementFrameRate,
        trackPointCount: rng.int(
          5,
          Math.max(
            5,
            Math.ceil((measurementFrameRate * ballTrackedDurationMs) / 1000),
          ),
        ),
        trackedDistanceMeters: (metersPerSecond * ballTrackedDurationMs) / 1000,
        trackedDurationMs: ballTrackedDurationMs,
        reprojectionErrorPx: rng.float(0, 2.9),
      }
    : { status: 'unavailable', reason: rng.pick(UNAVAILABLE_REASONS) };
  return {
    uri: 'file:///private/captures/stress.mov',
    durationMs,
    fps: rng.pick([24, 29.97, 30, 59.94, 60, 120, 240]),
    width: rng.pick([720, 1080, 1920]),
    height: rng.pick([1280, 1920, 3840]),
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs,
      endMs,
      peakMotionMs: rng.int(startMs, endMs),
      confidence: rng.float(0, 1),
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: rng.chance(0.8)
        ? 'apple_vision_body_pose'
        : 'mediapipe_pose_landmarker',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: poseFrameCount + poseMissingFrameCount,
      poseFrameCount,
      poseMissingFrameCount,
      trackedDurationMs,
      meanCanonicalJointVisibility: rng.float(0, 1),
      meanJointCoverage,
      minimumJointCoverage: rng.float(0, meanJointCoverage),
      fullBodyVisibleFrameCount: rng.int(0, poseFrameCount),
      jointMotion: joints.map(joint => {
        const mean = rng.float(0, 8);
        return {
          joint,
          sampleCount: rng.int(1, Math.max(1, poseFrameCount - 1)),
          meanNormalizedPerSecond: mean,
          peakNormalizedPerSecond: mean + rng.float(0, 12),
        };
      }),
    },
    ballSpeed,
    preRollMs: rng.int(0, durationMs),
    postRollMs: rng.int(0, durationMs),
  };
}

export function baseImportedClip(rng: SeededRng): ImportedClip {
  return {
    uri: 'file:///private/imports/stress.mp4',
    durationMs: rng.int(500, 600000),
    fps: rng.pick([0, 23.976, 25, 29.97, 30, 60, 240]),
    width: rng.pick([640, 1280, 1920, 3840]),
    height: rng.pick([360, 480, 720, 1080, 2160]),
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'imported_video',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

type Mutable = Record<string, unknown>;

interface ClipMutator {
  id: string;
  kind: 'string' | 'numeric' | 'structural';
  appliesTo: 'measured' | 'imported' | 'both';
  apply(
    clip: Mutable,
    rng: SeededRng,
    classes: readonly StringClass[],
  ): unknown;
}

function evidence(clip: Mutable): Mutable {
  return clip['captureEvidence'] as Mutable;
}

function setNumeric(target: Mutable, key: string, rng: SeededRng): number {
  const value = rng.pick(NUMERIC_EXTREMES);
  target[key] = value;
  return value;
}

function setString(
  target: Mutable,
  key: string,
  rng: SeededRng,
  classes: readonly StringClass[],
): string {
  const { value } = hostileString(rng, classes);
  target[key] = value;
  return value;
}

const CLIP_MUTATORS: readonly ClipMutator[] = [
  {
    id: 'evidence.poseModelVersion',
    kind: 'string',
    appliesTo: 'measured',
    apply: (c, rng, cls) =>
      setString(evidence(c), 'poseModelVersion', rng, cls),
  },
  {
    id: 'evidence.triggerAlgorithmVersion',
    kind: 'string',
    appliesTo: 'measured',
    apply: (c, rng, cls) =>
      setString(evidence(c), 'triggerAlgorithmVersion', rng, cls),
  },
  {
    id: 'evidence.poseSource',
    kind: 'string',
    appliesTo: 'measured',
    apply: (c, rng, cls) => setString(evidence(c), 'poseSource', rng, cls),
  },
  {
    id: 'evidence.jointMotion[0].joint',
    kind: 'string',
    appliesTo: 'measured',
    apply: (c, rng, cls) => {
      const motion = evidence(c)['jointMotion'] as Mutable[];
      const first = motion[0];
      if (!first) return undefined;
      return setString(first, 'joint', rng, cls);
    },
  },
  {
    id: 'ballSpeed.reason',
    kind: 'string',
    appliesTo: 'both',
    apply: (c, rng, cls) =>
      setString(c['ballSpeed'] as Mutable, 'reason', rng, cls),
  },
  {
    id: 'uri',
    kind: 'string',
    appliesTo: 'both',
    apply: (c, rng, cls) => setString(c, 'uri', rng, cls),
  },
  {
    id: 'capturedAtIso',
    kind: 'string',
    appliesTo: 'both',
    apply: (c, rng, cls) => setString(c, 'capturedAtIso', rng, cls),
  },
  {
    id: 'evidence.poseFrameCount',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => setNumeric(evidence(c), 'poseFrameCount', rng),
  },
  {
    id: 'evidence.meanJointCoverage',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => setNumeric(evidence(c), 'meanJointCoverage', rng),
  },
  {
    id: 'evidence.meanCanonicalJointVisibility',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) =>
      setNumeric(evidence(c), 'meanCanonicalJointVisibility', rng),
  },
  {
    id: 'evidence.trackedDurationMs',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => setNumeric(evidence(c), 'trackedDurationMs', rng),
  },
  {
    id: 'evidence.jointMotion[*].peakNormalizedPerSecond',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => {
      const motion = evidence(c)['jointMotion'] as Mutable[];
      const value = rng.pick(NUMERIC_EXTREMES);
      for (const item of motion) item['peakNormalizedPerSecond'] = value;
      return value;
    },
  },
  {
    id: 'ballSpeed.milesPerHour',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => {
      const speed = c['ballSpeed'] as Mutable;
      if (speed['status'] !== 'measured') return undefined;
      return setNumeric(speed, 'milesPerHour', rng);
    },
  },
  {
    id: 'ballSpeed.confidence',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => {
      const speed = c['ballSpeed'] as Mutable;
      if (speed['status'] !== 'measured') return undefined;
      return setNumeric(speed, 'confidence', rng);
    },
  },
  {
    id: 'ballSpeed.measurementFrameRate',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => {
      const speed = c['ballSpeed'] as Mutable;
      if (speed['status'] !== 'measured') return undefined;
      return setNumeric(speed, 'measurementFrameRate', rng);
    },
  },
  {
    id: 'durationMs',
    kind: 'numeric',
    appliesTo: 'both',
    apply: (c, rng) => setNumeric(c, 'durationMs', rng),
  },
  {
    id: 'fps',
    kind: 'numeric',
    appliesTo: 'both',
    apply: (c, rng) => setNumeric(c, 'fps', rng),
  },
  {
    id: 'height',
    kind: 'numeric',
    appliesTo: 'both',
    apply: (c, rng) => setNumeric(c, 'height', rng),
  },
  {
    id: 'preRollMs',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => setNumeric(c, 'preRollMs', rng),
  },
  {
    id: 'postRollMs',
    kind: 'numeric',
    appliesTo: 'measured',
    apply: (c, rng) => setNumeric(c, 'postRollMs', rng),
  },
  {
    id: 'evidence.jointMotion=[]',
    kind: 'structural',
    appliesTo: 'measured',
    apply: c => {
      evidence(c)['jointMotion'] = [];
      return [];
    },
  },
  {
    id: 'evidence.jointMotion=undefined',
    kind: 'structural',
    appliesTo: 'measured',
    apply: c => {
      delete evidence(c)['jointMotion'];
      return undefined;
    },
  },
  {
    id: 'captureEvidence=undefined',
    kind: 'structural',
    appliesTo: 'measured',
    apply: c => {
      delete c['captureEvidence'];
      return undefined;
    },
  },
  {
    id: 'ballSpeed=undefined',
    kind: 'structural',
    appliesTo: 'both',
    apply: c => {
      delete c['ballSpeed'];
      return undefined;
    },
  },
  {
    id: 'ballSpeed=null',
    kind: 'structural',
    appliesTo: 'both',
    apply: c => {
      c['ballSpeed'] = null;
      return null;
    },
  },
  {
    id: 'ballSpeed.reason=undefined',
    kind: 'structural',
    appliesTo: 'both',
    apply: c => {
      delete (c['ballSpeed'] as Mutable)['reason'];
      return undefined;
    },
  },
  {
    id: 'ballSpeed.status=hostile',
    kind: 'structural',
    appliesTo: 'both',
    apply: (c, rng, cls) =>
      setString(c['ballSpeed'] as Mutable, 'status', rng, cls),
  },
  {
    id: 'captureMode=hostile',
    kind: 'structural',
    appliesTo: 'both',
    apply: (c, rng, cls) => setString(c, 'captureMode', rng, cls),
  },
  {
    id: 'evidence.jointMotion[*].joint=duplicate',
    kind: 'structural',
    appliesTo: 'measured',
    apply: c => {
      const motion = evidence(c)['jointMotion'] as Mutable[];
      const first = motion[0];
      if (!first) return undefined;
      for (const item of motion) item['joint'] = first['joint'];
      return first['joint'];
    },
  },
  {
    id: 'evidence.jointMotion[*].joint=unknown',
    kind: 'structural',
    appliesTo: 'measured',
    apply: c => {
      const motion = evidence(c)['jointMotion'] as Mutable[];
      motion.forEach((item, i) => {
        item['joint'] = `left_toe_${i}` as CaptureEvidenceJoint;
      });
      return 'left_toe_*';
    },
  },
];

export const CLIP_MUTATOR_IDS = CLIP_MUTATORS.map(m => m.id);

export interface ClipScenario {
  clip: CapturedClip;
  mode: 'measured' | 'imported';
  contentClass: ContentClass;
  mutations: Mutation[];
  validatorAccepts: boolean;
  validatorError: string | null;
}

export function validatorAccepts(clip: unknown): {
  ok: boolean;
  error: string | null;
} {
  try {
    assertCapturedClip(clip);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Throwaway copy a mutator can write into so its rng draws still happen. */
function scratch(value: Mutable): Mutable {
  return JSON.parse(JSON.stringify(value)) as Mutable;
}

/**
 * Builds a clip scenario. `forcedMutations` replays a minimized seed: the
 * mutator selection and every value draw happen exactly as in the unforced
 * run (so ids and values match the parent row), but only the listed ids are
 * applied to the clip that gets rendered.
 */
export function clipScenario(
  rng: SeededRng,
  contentClass: ContentClass,
  classes: readonly StringClass[],
  forcedMutations?: readonly string[],
): ClipScenario {
  const mode = rng.chance(0.7) ? 'measured' : 'imported';
  const clip = (mode === 'measured'
    ? baseMeasuredClip(rng)
    : baseImportedClip(rng)) as unknown as Mutable;
  const eligible = CLIP_MUTATORS.filter(
    m => m.appliesTo === 'both' || m.appliesTo === mode,
  );
  let chosen: ClipMutator[] = [];
  if (contentClass === 'boundary-numeric') {
    chosen = rng
      .shuffle(eligible.filter(m => m.kind === 'numeric'))
      .slice(0, rng.int(1, 3));
  } else if (contentClass === 'hostile-string') {
    chosen = rng
      .shuffle(eligible.filter(m => m.kind === 'string'))
      .slice(0, rng.int(1, 3));
  } else if (contentClass === 'structural') {
    chosen = [rng.pick(eligible.filter(m => m.kind === 'structural'))];
  }
  const want = (id: string) =>
    forcedMutations === undefined || forcedMutations.includes(id);
  const mutations: Mutation[] = [];
  for (const m of chosen) {
    if (want(m.id)) {
      mutations.push({
        id: m.id,
        value: describeValue(m.apply(clip, rng, classes)),
      });
    } else {
      m.apply(scratch(clip), rng, classes);
    }
  }
  const verdict = validatorAccepts(clip);
  return {
    clip: clip as unknown as CapturedClip,
    mode,
    contentClass,
    mutations,
    validatorAccepts: verdict.ok,
    validatorError: verdict.error,
  };
}

/* ---------------------------------------------------------------------- */
/* Envelope fixtures                                                       */
/* ---------------------------------------------------------------------- */

export interface EnvelopeScenario {
  envelope: EnvelopeVerdict | null | undefined;
  contentClass: ContentClass;
  mutations: Mutation[];
  /** Guidance lines the panel must render (canonical order), when well-formed. */
  expectedLines: Array<{ dimension: EnvelopeDimension; status: string }> | null;
  expectedBlocked: boolean | null;
  wellFormed: boolean;
}

const MEASUREMENT_KEYS: ReadonlyArray<keyof CaptureEnvelopeMeasurements> = [
  'frameWidthPx',
  'frameHeightPx',
  'avgFrameRateFps',
  'brightnessMeanLuma',
  'brightnessStdLuma',
  'laplacianVarianceMedian',
  'meanAbsFrameDiff',
  'denoiseSurvivalRatio',
  'clippedPixelFraction',
  'contrastNormalizedFrameDiff',
  'frameIntervalCv',
  'clipDurationMs',
  'playerPixelHeightFraction',
  'playerMeanJointVisibility',
];

function seededMeasurements(
  rng: SeededRng,
  contentClass: ContentClass,
): CaptureEnvelopeMeasurements {
  const m: Partial<Record<keyof CaptureEnvelopeMeasurements, number | null>> =
    {};
  for (const key of MEASUREMENT_KEYS) {
    const roll = rng.next();
    if (roll < 0.2) m[key] = null;
    else if (contentClass === 'boundary-numeric' && roll < 0.6) {
      m[key] = rng.pick(NUMERIC_EXTREMES);
    } else m[key] = rng.float(-10, 5000);
  }
  return m as CaptureEnvelopeMeasurements;
}

/**
 * Builds an envelope scenario. Every non-valid row carries exactly one
 * mutation, so `forcedMutations = []` is the zero-mutation control: the same
 * seed rendered with the mutation drawn but not applied.
 */
export function envelopeScenario(
  rng: SeededRng,
  contentClass: ContentClass,
  classes: readonly StringClass[],
  forcedMutations?: readonly string[],
): EnvelopeScenario {
  const mutations: Mutation[] = [];
  if (contentClass === 'valid' || contentClass === 'boundary-numeric') {
    if (contentClass === 'valid' && rng.chance(0.1)) {
      return {
        envelope: null,
        contentClass,
        mutations: [{ id: 'envelope=null', value: 'null' }],
        expectedLines: [],
        expectedBlocked: false,
        wellFormed: true,
      };
    }
    const envelope = evaluateCaptureEnvelope(
      seededMeasurements(rng, contentClass),
    );
    const expectedLines = ENVELOPE_DIMENSIONS.flatMap(dimension => {
      const verdict = envelope.dimensions.find(d => d.dimension === dimension);
      return verdict &&
        (verdict.status === 'DEGRADED' || verdict.status === 'UNSUPPORTED')
        ? [{ dimension, status: verdict.status }]
        : [];
    });
    return {
      envelope,
      contentClass,
      mutations,
      expectedLines,
      expectedBlocked: envelope.dimensions.some(
        d => d.status === 'UNSUPPORTED',
      ),
      wellFormed: true,
    };
  }
  const pristine = evaluateCaptureEnvelope(seededMeasurements(rng, 'valid'));
  const envelope = scratch(pristine as unknown as Mutable);
  const dims = envelope['dimensions'] as Mutable[];
  const variant = rng.int(0, contentClass === 'structural' ? 6 : 2);
  if (forcedMutations !== undefined && forcedMutations.length === 0) {
    if (variant <= 2) hostileString(rng, classes);
    const expectedLines = ENVELOPE_DIMENSIONS.flatMap(dimension => {
      const verdict = pristine.dimensions.find(d => d.dimension === dimension);
      return verdict &&
        (verdict.status === 'DEGRADED' || verdict.status === 'UNSUPPORTED')
        ? [{ dimension, status: verdict.status }]
        : [];
    });
    return {
      envelope: pristine,
      contentClass,
      mutations,
      expectedLines,
      expectedBlocked: pristine.dimensions.some(
        d => d.status === 'UNSUPPORTED',
      ),
      wellFormed: true,
    };
  }
  switch (variant) {
    case 0: {
      const { value } = hostileString(rng, classes);
      for (const d of dims) d['status'] = value;
      mutations.push({
        id: 'dimensions[*].status=hostile',
        value: describeValue(value),
      });
      break;
    }
    case 1: {
      const { value } = hostileString(rng, classes);
      for (const d of dims) d['dimension'] = value;
      mutations.push({
        id: 'dimensions[*].dimension=hostile',
        value: describeValue(value),
      });
      break;
    }
    case 2: {
      const { value } = hostileString(rng, classes);
      envelope['thresholdsVersion'] = value;
      envelope['overall'] = value;
      mutations.push({
        id: 'thresholdsVersion,overall=hostile',
        value: describeValue(value),
      });
      break;
    }
    case 3:
      envelope['dimensions'] = [];
      mutations.push({ id: 'dimensions=[]', value: 'array(len=0)' });
      break;
    case 4:
      delete envelope['dimensions'];
      mutations.push({ id: 'dimensions=undefined', value: 'undefined' });
      break;
    case 5:
      envelope['dimensions'] = [...dims, ...dims];
      mutations.push({
        id: 'dimensions=duplicated',
        value: `array(len=${dims.length * 2})`,
      });
      break;
    default:
      return {
        envelope: undefined,
        contentClass,
        mutations: [{ id: 'envelope=undefined', value: 'undefined' }],
        expectedLines: null,
        expectedBlocked: null,
        wellFormed: false,
      };
  }
  return {
    envelope: envelope as unknown as EnvelopeVerdict,
    contentClass,
    mutations,
    expectedLines: null,
    expectedBlocked: null,
    wellFormed: variant === 2 || variant === 5 || variant === 3,
  };
}

/* ---------------------------------------------------------------------- */
/* TargetSelector fixtures                                                 */
/* ---------------------------------------------------------------------- */

export interface SelectorScenario {
  frameUri: string;
  posterUri: string | undefined;
  sourceWidth: number | undefined;
  sourceHeight: number | undefined;
  layout: { width: number; height: number };
  tap: { x: number; y: number };
  failPreview: boolean;
  contentClass: ContentClass;
  mutations: Mutation[];
  /** Layout the component can honestly map from (finite, positive). */
  layoutUsable: boolean;
  /** Layout, tap and URIs a real device could actually deliver. */
  inContract: boolean;
}

/**
 * `forcedMutations` (minimization/replay) keeps the rng draw order intact
 * but only APPLIES the listed mutation ids, so each candidate mutation can be
 * isolated against the same seed.
 */
export function selectorScenario(
  rng: SeededRng,
  contentClass: ContentClass,
  classes: readonly StringClass[],
  window: { width: number },
  forcedMutations?: readonly string[],
): SelectorScenario {
  const mutations: Mutation[] = [];
  const want = (id: string) =>
    forcedMutations === undefined || forcedMutations.includes(id);
  const contentWidth = Math.max(1, window.width - 48);
  let layout = {
    width: contentWidth,
    height: Math.min(380, (contentWidth * 16) / 9),
  };
  let frameUri = 'file:///private/captures/frame.jpg';
  let posterUri: string | undefined = rng.chance(0.5)
    ? 'file:///private/captures/poster.jpg'
    : undefined;
  let sourceWidth: number | undefined = rng.pick([720, 1080, 1920, 3840]);
  let sourceHeight: number | undefined = rng.pick([1280, 1920, 2160]);
  if (rng.chance(0.25) && want('source=undefined')) {
    sourceWidth = undefined;
    sourceHeight = undefined;
    mutations.push({ id: 'source=undefined', value: 'undefined' });
  }
  if (contentClass === 'hostile-string') {
    const f = hostileString(rng, classes);
    if (want('frameUri')) {
      frameUri = f.value;
      mutations.push({ id: 'frameUri', value: describeValue(f.value) });
    }
    if (rng.chance(0.5)) {
      const p = hostileString(rng, classes);
      if (want('posterUri')) {
        posterUri = p.value;
        mutations.push({ id: 'posterUri', value: describeValue(p.value) });
      }
    }
  }
  if (contentClass === 'boundary-numeric') {
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i += 1) {
      const which = rng.int(0, 3);
      const value = rng.pick(NUMERIC_EXTREMES);
      const id =
        which === 0
          ? 'sourceWidth'
          : which === 1
            ? 'sourceHeight'
            : which === 2
              ? 'layout.width'
              : 'layout.height';
      if (!want(id)) continue;
      if (which === 0) sourceWidth = value;
      else if (which === 1) sourceHeight = value;
      else if (which === 2) layout = { ...layout, width: value };
      else layout = { ...layout, height: value };
      mutations.push({ id, value: describeValue(value) });
    }
  }
  if (contentClass === 'structural') {
    const variant = rng.int(0, 2);
    if (variant === 0 && want('sourceHeight=undefined(only)')) {
      sourceWidth = 1080;
      sourceHeight = undefined;
      mutations.push({
        id: 'sourceHeight=undefined(only)',
        value: 'undefined',
      });
    } else if (variant === 1 && want('posterUri=""')) {
      posterUri = '';
      mutations.push({ id: 'posterUri=""', value: '""' });
    } else if (variant === 2 && want('frameUri=""')) {
      frameUri = '';
      posterUri = undefined;
      mutations.push({ id: 'frameUri=""', value: '""' });
    }
  }
  const tapRoll = rng.next();
  let tap = {
    x: rng.float(0, Number.isFinite(layout.width) ? layout.width : 300),
    y: rng.float(0, Number.isFinite(layout.height) ? layout.height : 500),
  };
  if (tapRoll >= 0.6) {
    const hostileTap = {
      x: rng.pick(NUMERIC_EXTREMES),
      y: rng.pick(NUMERIC_EXTREMES),
    };
    if (want('tap')) {
      tap = hostileTap;
      mutations.push({
        id: 'tap',
        value: `${describeValue(tap.x)},${describeValue(tap.y)}`,
      });
    }
  }
  const failPreview = rng.chance(0.3);
  const layoutUsable =
    Number.isFinite(layout.width) &&
    Number.isFinite(layout.height) &&
    layout.width > 0 &&
    layout.height > 0;
  // What a real onLayout / touch event can deliver: finite device points in
  // a plausible range. Anything else is a hostile robustness probe.
  const deviceRealistic = (v: number) =>
    Number.isFinite(v) && v >= 1 && v <= 1e5;
  const inContract =
    deviceRealistic(layout.width) &&
    deviceRealistic(layout.height) &&
    Number.isFinite(tap.x) &&
    Number.isFinite(tap.y) &&
    Math.abs(tap.x) <= 1e5 &&
    Math.abs(tap.y) <= 1e5 &&
    frameUri !== '' &&
    posterUri !== '';
  return {
    frameUri,
    posterUri,
    sourceWidth,
    sourceHeight,
    layout,
    tap,
    failPreview,
    contentClass,
    mutations,
    layoutUsable,
    inContract,
  };
}
