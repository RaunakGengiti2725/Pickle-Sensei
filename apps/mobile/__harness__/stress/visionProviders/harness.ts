/// <reference types="node" />
/**
 * Seeded randomized stress harness for `src/vision/providers.ts`.
 *
 * Every sequence is a pure function of its seed: `generateSequence(seed)`
 * produces a list of actions over the module's public API; `runActions`
 * executes them and checks the documented invariants after every step,
 * recording a replayable trace digest. Failing sequences are shrunk with
 * `minimizeFailure` (delta debugging over the action list) so a failure is
 * reported as `seed + kept action indices`.
 *
 * Invariants (INFERRED from the code comments in providers.ts, the
 * vision-geometry recorded providers, the model registry and the
 * stroke-heuristic classifier; each has an id used in violation records):
 *
 *  select.no_throw          selectVisionProviders never throws.
 *  select.gate              kind is 'unavailable' iff recording is missing
 *                           or has < 6 pose frames; reasons are the two
 *                           documented copy strings; shotType never changes
 *                           the outcome.
 *  select.real_shape        real set: source 'real', ball null, pose /
 *                           stroke / paddle model versions replay the
 *                           recorded ones ('paddle-none-0' for the paddle).
 *  select.input_immutable   the recording passed in is not mutated.
 *  select.pose_replay       extractPose returns exactly the recorded frames
 *                           inside the window (ascending), or a typed
 *                           low_confidence 'pose.too_few_recorded_frames'
 *                           failure when fewer than 6 overlap. Never rejects.
 *  select.stroke_replay     detectStrokes replays the recorded window
 *                           (contactMs = peakMotionMs) or fails typed
 *                           'stroke.invalid_recorded_window' when
 *                           endMs <= startMs. Never rejects.
 *  select.paddle_absent     detectPaddle resolves ok([]) — nothing invented.
 *  select.deterministic     the same provider set answers identically twice.
 *  fusion.no_throw          createFusionProviders never throws.
 *  fusion.gate              outcome matches the registry model: platform
 *                           maps android→android, everything else→ios; real
 *                           iff every required task resolves and (declared)
 *                           a stroke-matching scorer exists or (AUTO) the
 *                           'stroke.heuristic-hierarchical' classifier
 *                           resolves; the reason strings are the documented
 *                           copy.
 *  fusion.real_shape        classifier null, shadowScorers empty, auto
 *                           classifier descriptor equals the manifest entry,
 *                           fresh provider instances per call.
 *  fusion.registry_frozen   the module registry is never mutated by any
 *                           action (list() snapshot unchanged).
 *  classify.resolves        the auto classifier's promise never rejects and
 *                           always resolves ok (typed-outcome policy).
 *  classify.shape           taxonomy v3 version, classifierVersion carries
 *                           the manifest version, depth ∈ {1,2} (mobile
 *                           passes no speed series so depth 3 is
 *                           unreachable), confidence finite in [0,1], leaf
 *                           mirrors label at depth 1 and is null at depth 2,
 *                           evidence/limitingFactors are string arrays.
 *  classify.reference       no contact and no event peak → UNKNOWN with
 *                           'no_contact_and_no_event_peak_reference'; event
 *                           peak substitution is always recorded.
 *  classify.paddle_dropped  paddle observations without a measured center
 *                           are dropped, never filled: a track with no
 *                           centers classifies identically to no track.
 *  classify.ball_ignored    the ball track is not consumed on mobile.
 *  classify.input_immutable the classify input is not mutated.
 *  classify.deterministic   same input twice → deep-equal prediction.
 *  registry.resolve         resolve() returns null or an entry matching the
 *                           query; byId round-trips; alias versions resolve
 *                           to null; withEntry on an existing id@version
 *                           throws and never touches the module registry.
 *  status.stable            scoringStackStatus is constant, carries the
 *                           registered scorer version and requires a
 *                           recorded pose sequence.
 */
import { createHash } from 'node:crypto';
import type { Platform as RnPlatform } from 'react-native';
import {
  SHOT_TYPES,
  type PoseFrame,
  type Result,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { VideoClipRef } from '@pickle/vision-contracts';
import type {
  FusionProviders,
  IHierarchicalStrokeClassifier,
} from '@pickle/analysis-pipeline';
import {
  MODEL_TASKS,
  type BallTrack,
  type ModelTask,
  type PaddleTrack,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  DEFAULT_MODEL_MANIFEST,
  PLATFORMS,
  type ModelManifestEntry,
  type Platform as ModelPlatform,
  type ResolveQuery,
} from '@pickle/model-registry';
import {
  generateSwing,
  generateSwingSequence,
  type SwingTruth,
} from '@pickle/evaluation';
import type { RecordedStrokeInput } from '@pickle/vision-geometry';

import {
  createFusionProviders,
  registry,
  scoringStackStatus,
  selectVisionProviders,
  SCORING_STACK_VERSION,
} from '../../../src/vision/providers';

/** The values `Platform.OS` can carry (providers.ts maps android→android, rest→ios). */
export type PlatformOs = (typeof RnPlatform)['OS'];

// ───────────────────────────── RNG ─────────────────────────────

/** mulberry32 — small, fast, fully reproducible from a 32-bit seed. */
export class SeededRng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  public pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) {
      throw new Error('pick() on empty list');
    }
    return item;
  }

  public bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  public float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

// ───────────────────────────── Actions ─────────────────────────────

export const PLATFORM_OS_VALUES: readonly PlatformOs[] = [
  'ios',
  'android',
  'macos',
  'windows',
  'web',
];

export type FrameMutation =
  | 'none'
  | 'reverse'
  | 'duplicate_frame'
  | 'nan_landmark'
  | 'empty_landmarks'
  | 'negative_timestamps';

export interface RecordingSpec {
  kind: 'undefined' | 'null' | 'frames';
  truth: Partial<SwingTruth>;
  /** Number of frames to keep (clamped to what the generator produced). */
  keepCount: number;
  offset: number;
  mutation: FrameMutation;
  poseModelVersion: string;
  trigger: {
    modelVersion: string;
    /** Relative to the generated window; 'inverted' makes endMs <= startMs. */
    windowMode: 'generated' | 'inverted' | 'zero_length' | 'shifted' | 'huge';
    shiftMs: number;
    peakMode: 'generated' | 'null' | 'outside';
    confidence: number;
  };
  video: { width: number; height: number };
  /** Window used to probe extractPose on the real provider set. */
  probe: { startMs: number; endMs: number };
}

export type PoseMutation =
  | 'none'
  | 'drop_hips'
  | 'drop_shoulders'
  | 'drop_wrists'
  | 'drop_all_landmarks'
  | 'nan_landmark'
  | 'no_frames'
  | 'sparse_frames'
  | 'zero_confidence';

export interface ClassifySpec {
  truth: Partial<SwingTruth>;
  mutation: PoseMutation;
  windowMode: 'generated' | 'shifted' | 'inverted' | 'point' | 'huge';
  shiftMs: number;
  contactMode: 'null' | 'peak' | 'random' | 'outside';
  eventPeakMode: 'null' | 'peak' | 'random';
  randomMs: number;
  handedness: 'right' | 'left' | 'ambidextrous';
  paddle: null | {
    count: number;
    centerMask: boolean[];
    continuity: number;
    confidence: number;
    spread: number;
  };
  ball: null | { count: number; withContact: boolean };
}

export type Action =
  | {
      op: 'select';
      shotType: ShotTypeSlug;
      altShotType: ShotTypeSlug;
      recording: RecordingSpec;
    }
  | { op: 'fusion'; shotType: ShotTypeSlug | null }
  | { op: 'platform'; os: PlatformOs }
  | { op: 'classify'; spec: ClassifySpec }
  | { op: 'registry'; query: ResolveQuery }
  | { op: 'status' }
  | { op: 'withEntry'; mode: 'duplicate' | 'fresh' };

export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

const POSE_MODEL_VERSIONS = [
  'apple-vision-bodypose-1',
  'apple-vision-bodypose-2',
  'pose-test-0',
];
const TRIGGER_MODEL_VERSIONS = [
  'temporal-stroke-heuristic-2',
  'temporal-stroke-heuristic-3',
];

function randomTruth(rng: SeededRng): Partial<SwingTruth> {
  const truth: Partial<SwingTruth> = {};
  if (rng.bool(0.5)) truth.fps = rng.pick([24, 30, 60, 120]);
  if (rng.bool(0.4)) truth.handed = rng.pick(['right', 'left']);
  if (rng.bool(0.3)) truth.torsoLength = rng.pick([0.02, 0.1, 0.2, 0.35]);
  if (rng.bool(0.3)) truth.contactForwardNorm = rng.float(-0.3, 1.2);
  if (rng.bool(0.3)) truth.contactHeightRatio = rng.float(0, 1.6);
  if (rng.bool(0.3)) truth.backswingLengthNorm = rng.float(0, 1.5);
  if (rng.bool(0.3)) truth.shoulderTurnDeg = rng.float(0, 90);
  if (rng.bool(0.2)) truth.accelerateMs = rng.pick([50, 100, 250, 400]);
  if (rng.bool(0.2)) truth.readyMs = rng.pick([0, 100, 400]);
  return truth;
}

function randomRecordingSpec(rng: SeededRng): RecordingSpec {
  const roll = rng.next();
  const kind: RecordingSpec['kind'] =
    roll < 0.1 ? 'undefined' : roll < 0.2 ? 'null' : 'frames';
  const keepCount = rng.pick([0, 1, 2, 5, 6, 7, 12, rng.int(6, 160), 10_000]);
  return {
    kind,
    truth: randomTruth(rng),
    keepCount,
    offset: rng.int(0, 40),
    mutation: rng.pick<FrameMutation>([
      'none',
      'none',
      'none',
      'reverse',
      'duplicate_frame',
      'nan_landmark',
      'empty_landmarks',
      'negative_timestamps',
    ]),
    poseModelVersion: rng.pick(POSE_MODEL_VERSIONS),
    trigger: {
      modelVersion: rng.pick(TRIGGER_MODEL_VERSIONS),
      windowMode: rng.pick([
        'generated',
        'generated',
        'generated',
        'inverted',
        'zero_length',
        'shifted',
        'huge',
      ]),
      shiftMs: rng.int(-3000, 3000),
      peakMode: rng.pick(['generated', 'generated', 'null', 'outside']),
      confidence: rng.pick([0, 0.2, 0.5, 0.86, 1, 1.5, -0.1]),
    },
    video: {
      width: rng.pick([0, -10, 720, 1080, 1920]),
      height: rng.pick([0, 720, 1080, 1920]),
    },
    probe: {
      startMs: rng.int(-500, 2500),
      endMs: rng.int(-500, 3500),
    },
  };
}

function randomClassifySpec(rng: SeededRng): ClassifySpec {
  const paddleCount = rng.int(0, 40);
  const centerMask: boolean[] = [];
  const centerMode = rng.pick(['all', 'none', 'mixed']);
  for (let i = 0; i < paddleCount; i += 1) {
    centerMask.push(
      centerMode === 'all' ? true : centerMode === 'none' ? false : rng.bool(),
    );
  }
  return {
    truth: randomTruth(rng),
    mutation: rng.pick<PoseMutation>([
      'none',
      'none',
      'none',
      'none',
      'drop_hips',
      'drop_shoulders',
      'drop_wrists',
      'drop_all_landmarks',
      'nan_landmark',
      'no_frames',
      'sparse_frames',
      'zero_confidence',
    ]),
    windowMode: rng.pick([
      'generated',
      'generated',
      'generated',
      'shifted',
      'inverted',
      'point',
      'huge',
    ]),
    shiftMs: rng.int(-2000, 2000),
    contactMode: rng.pick([
      'null',
      'null',
      'peak',
      'peak',
      'random',
      'outside',
    ]),
    eventPeakMode: rng.pick(['null', 'peak', 'peak', 'random']),
    randomMs: rng.int(-1000, 4000),
    handedness: rng.pick(['right', 'right', 'left', 'ambidextrous']),
    paddle: rng.bool(0.5)
      ? null
      : {
          count: paddleCount,
          centerMask,
          continuity: rng.float(0, 1),
          confidence: rng.pick([0, 0.1, 0.3, 0.7, 0.9]),
          spread: rng.float(0, 0.6),
        },
    ball: rng.bool(0.7)
      ? null
      : { count: rng.int(0, 20), withContact: rng.bool() },
  };
}

function randomRegistryQuery(rng: SeededRng): ResolveQuery {
  const query: ResolveQuery = {
    task: rng.pick(MODEL_TASKS),
    platform: rng.pick(PLATFORMS),
  };
  if (rng.bool(0.4)) query.stroke = rng.pick(SHOT_TYPES);
  if (rng.bool(0.3)) {
    query.status = rng.pick([
      'experimental',
      'shadow',
      'production',
      'deprecated',
    ] as const);
  }
  return query;
}

function randomAction(rng: SeededRng): Action {
  const roll = rng.next();
  if (roll < 0.3) {
    return {
      op: 'select',
      shotType: rng.pick(SHOT_TYPES),
      altShotType: rng.pick(SHOT_TYPES),
      recording: randomRecordingSpec(rng),
    };
  }
  if (roll < 0.5) {
    return {
      op: 'fusion',
      shotType: rng.bool(0.3) ? null : rng.pick(SHOT_TYPES),
    };
  }
  if (roll < 0.58) {
    return { op: 'platform', os: rng.pick(PLATFORM_OS_VALUES) };
  }
  if (roll < 0.83) {
    return { op: 'classify', spec: randomClassifySpec(rng) };
  }
  if (roll < 0.91) {
    return { op: 'registry', query: randomRegistryQuery(rng) };
  }
  if (roll < 0.96) {
    return { op: 'status' };
  }
  return { op: 'withEntry', mode: rng.pick(['duplicate', 'fresh']) };
}

/** Pure: the same seed always yields the same action list. */
export function generateSequence(seed: number): Action[] {
  const rng = new SeededRng(seed);
  const length = rng.int(MIN_SEQUENCE_LENGTH, MAX_SEQUENCE_LENGTH);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    actions.push(randomAction(rng));
  }
  return actions;
}

// ───────────────────────────── Fixtures ─────────────────────────────

function buildRecording(
  spec: RecordingSpec,
): RecordedStrokeInput | null | undefined {
  if (spec.kind === 'undefined') return undefined;
  if (spec.kind === 'null') return null;
  const swing = generateSwing(spec.truth);
  const offset = Math.min(
    spec.offset,
    Math.max(0, swing.frames.length - spec.keepCount),
  );
  let frames: PoseFrame[] = swing.frames
    .slice(offset, offset + spec.keepCount)
    .map(frame => ({
      ...frame,
      landmarks: frame.landmarks.map(mark => ({ ...mark })),
    }));
  switch (spec.mutation) {
    case 'none':
      break;
    case 'reverse':
      frames = frames.reverse();
      break;
    case 'duplicate_frame': {
      const first = frames[0];
      if (first) frames = [first, ...frames];
      break;
    }
    case 'nan_landmark': {
      const mark = frames[0]?.landmarks[0];
      if (mark) mark.x = Number.NaN;
      break;
    }
    case 'empty_landmarks':
      frames = frames.map((frame, index) =>
        index % 2 === 0 ? { ...frame, landmarks: [] } : frame,
      );
      break;
    case 'negative_timestamps':
      frames = frames.map(frame => ({
        ...frame,
        timestampMs: frame.timestampMs - 5000,
      }));
      break;
  }
  const window = swing.window;
  let startMs = window.startMs;
  let endMs = window.endMs;
  switch (spec.trigger.windowMode) {
    case 'generated':
      break;
    case 'inverted':
      startMs = window.endMs;
      endMs = window.startMs;
      break;
    case 'zero_length':
      endMs = startMs;
      break;
    case 'shifted':
      startMs += spec.trigger.shiftMs;
      endMs += spec.trigger.shiftMs;
      break;
    case 'huge':
      startMs = -1_000_000;
      endMs = 1_000_000;
      break;
  }
  const peakMotionMs =
    spec.trigger.peakMode === 'null'
      ? null
      : spec.trigger.peakMode === 'outside'
        ? window.peakMs + 100_000
        : window.peakMs;
  return {
    poseFrames: frames,
    poseModelVersion: spec.poseModelVersion,
    trigger: {
      modelVersion: spec.trigger.modelVersion,
      startMs,
      endMs,
      peakMotionMs,
      confidence: spec.trigger.confidence,
    },
    video: { ...spec.video },
  };
}

type ClassifyInput = Parameters<IHierarchicalStrokeClassifier['classify']>[0];

function buildClassifyInput(spec: ClassifySpec): ClassifyInput {
  const generated = generateSwingSequence(spec.truth);
  const sequence: PoseSequence = generated.sequence;
  const dropNames = (names: readonly string[]) => {
    sequence.frames = sequence.frames.map(frame => ({
      ...frame,
      landmarks: frame.landmarks.filter(mark => !names.includes(mark.name)),
    }));
  };
  switch (spec.mutation) {
    case 'none':
      break;
    case 'drop_hips':
      dropNames(['left_hip', 'right_hip']);
      break;
    case 'drop_shoulders':
      dropNames(['left_shoulder', 'right_shoulder']);
      break;
    case 'drop_wrists':
      dropNames(['left_wrist', 'right_wrist']);
      break;
    case 'drop_all_landmarks':
      sequence.frames = sequence.frames.map(frame => ({
        ...frame,
        landmarks: [],
      }));
      break;
    case 'nan_landmark': {
      const mid = sequence.frames[Math.floor(sequence.frames.length / 2)];
      const mark = mid?.landmarks[0];
      if (mark) mark.y = Number.NaN;
      break;
    }
    case 'no_frames':
      sequence.frames = [];
      break;
    case 'sparse_frames':
      sequence.frames = sequence.frames.filter((_, index) => index % 7 === 0);
      break;
    case 'zero_confidence':
      sequence.frames = sequence.frames.map(frame => ({
        ...frame,
        confidence: 0,
        landmarks: frame.landmarks.map(mark => ({ ...mark, visibility: 0 })),
      }));
      break;
  }
  const generatedWindow = generated.window;
  let window = {
    startMs: generatedWindow.startMs,
    endMs: generatedWindow.endMs,
  };
  switch (spec.windowMode) {
    case 'generated':
      break;
    case 'shifted':
      window = {
        startMs: window.startMs + spec.shiftMs,
        endMs: window.endMs + spec.shiftMs,
      };
      break;
    case 'inverted':
      window = { startMs: window.endMs, endMs: window.startMs };
      break;
    case 'point':
      window = {
        startMs: generatedWindow.peakMs,
        endMs: generatedWindow.peakMs,
      };
      break;
    case 'huge':
      window = { startMs: -1_000_000, endMs: 1_000_000 };
      break;
  }
  const contactMs =
    spec.contactMode === 'null'
      ? null
      : spec.contactMode === 'peak'
        ? generatedWindow.peakMs
        : spec.contactMode === 'outside'
          ? generatedWindow.endMs + 50_000
          : spec.randomMs;
  const eventPeakMs =
    spec.eventPeakMode === 'null'
      ? null
      : spec.eventPeakMode === 'peak'
        ? generatedWindow.peakMs
        : spec.randomMs;

  const producedBy = {
    providerId: 'stress.synthetic-track',
    modelVersion: 'stress-1',
    runtime: 'deterministic',
    executionTarget: 'on_device',
    artifactHash: null,
  } as const;

  let paddle: PaddleTrack | null = null;
  if (spec.paddle) {
    const p = spec.paddle;
    const span = Math.max(1, window.endMs - window.startMs);
    paddle = {
      schemaVersion: 1,
      coordinateSystem: sequence.coordinateSystem,
      producedBy: { ...producedBy },
      continuity: p.continuity,
      observations: Array.from({ length: p.count }, (_, index) => {
        const t = p.count > 1 ? index / (p.count - 1) : 0;
        const timestampMs = Math.round(window.startMs + t * span);
        const hasCenter = p.centerMask[index] ?? false;
        const center = hasCenter
          ? { x: 0.5 + (t - 0.5) * p.spread, y: 0.5 - t * p.spread * 0.5 }
          : null;
        return {
          frameIndex: index,
          timestampMs,
          bbox: center
            ? {
                x: center.x - 0.05,
                y: center.y - 0.05,
                width: 0.1,
                height: 0.1,
              }
            : null,
          keypoints: { handleEnd: null, throat: null, center, tip: null },
          confidence: p.confidence,
        };
      }),
    };
  }

  let ball: BallTrack | null = null;
  if (spec.ball) {
    const b = spec.ball;
    ball = {
      schemaVersion: 1,
      coordinateSystem: sequence.coordinateSystem,
      producedBy: { ...producedBy },
      observations: Array.from({ length: b.count }, (_, index) => ({
        frameIndex: index,
        timestampMs: window.startMs + index * 16,
        x: 0.2 + index * 0.01,
        y: 0.5,
        confidence: 0.6,
      })),
      contact: b.withContact
        ? { timestampMs: generatedWindow.peakMs, confidence: 0.7 }
        : null,
      bounce: null,
      continuity: 0.5,
    };
  }

  return {
    pose: sequence,
    paddle,
    ball,
    window,
    contactMs,
    eventPeakMs,
    handedness: spec.handedness,
  };
}

const PROBE_CLIP: VideoClipRef = {
  uri: 'stress://clip',
  durationMs: 4000,
  fps: 60,
  width: 1080,
  height: 1920,
};

// ───────────────────────────── Documented copy ─────────────────────────────

export const REASON_NO_RECORDING =
  'This capture has no recorded pose sequence. Scoring runs only on pose frames measured during capture — Pickle Sensei will not generate a score from reconstructed or placeholder motion.';
export const REASON_TOO_FEW_FRAMES =
  'Too few pose frames were measured during this capture to score it honestly.';
export const REASON_PROVIDER_MISSING =
  'A required analysis provider is missing from the model registry.';
export const REASON_AUTO_SCORER_MISSING =
  'Technique scoring is not registered for this platform. No score will be invented.';
export const REASON_AUTO_CLASSIFIER_MISSING =
  'Auto Detect needs the on-device stroke classifier, which is not registered for this platform. Declare the technique to analyze this capture.';
export function reasonStrokeScorerMissing(shotType: ShotTypeSlug): string {
  return `Technique scoring for "${shotType.replace(
    /_/g,
    ' ',
  )}" is not yet released. No score will be invented.`;
}

// ───────────────────────────── Execution ─────────────────────────────

export interface Violation {
  step: number;
  op: Action['op'];
  invariant: string;
  detail: string;
}

export interface StepRecord {
  step: number;
  op: Action['op'];
  digest: string;
}

export interface RunResult {
  steps: StepRecord[];
  violations: Violation[];
  traceHash: string;
}

export interface HarnessEnv {
  /** Swap the react-native Platform.OS seen by providers.ts. */
  setPlatformOs(os: PlatformOs): void;
  currentPlatformOs(): PlatformOs;
}

/** Stable JSON: sorted keys, NaN/±Infinity/undefined made explicit. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      return `__nonfinite:${String(item)}`;
    }
    if (item === undefined) return '__undefined';
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const source = item as Record<string, unknown>;
      return Object.keys(source)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = source[key];
          return acc;
        }, {});
    }
    return item;
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function modelPlatform(os: PlatformOs): ModelPlatform {
  return os === 'android' ? 'android' : 'ios';
}

const REQUIRED_FUSION_TASKS: readonly ModelTask[] = [
  'phase_segmentation',
  'biomechanics_extraction',
  'fault_detection',
  'uncertainty_estimation',
  'coaching_ranking',
];

type ExpectedFusion =
  | { kind: 'real'; classifierEntry: ModelManifestEntry | null }
  | { kind: 'unavailable'; reason: string };

/** Registry-derived oracle for createFusionProviders (documented gate). */
export function expectedFusion(
  os: PlatformOs,
  shotType: ShotTypeSlug | null,
): ExpectedFusion {
  const platform = modelPlatform(os);
  const required = REQUIRED_FUSION_TASKS.map(task =>
    registry.resolve({ task, platform }),
  );
  const scorer =
    shotType === null
      ? registry.resolve({ task: 'technique_scoring', platform })
      : registry.resolve({
          task: 'technique_scoring',
          platform,
          stroke: shotType,
        });
  const classifierEntry = registry.resolve({
    task: 'stroke_classification',
    platform,
  });
  if (required.some(entry => entry === null)) {
    return { kind: 'unavailable', reason: REASON_PROVIDER_MISSING };
  }
  if (!scorer) {
    return {
      kind: 'unavailable',
      reason:
        shotType === null
          ? REASON_AUTO_SCORER_MISSING
          : reasonStrokeScorerMissing(shotType),
    };
  }
  if (
    shotType === null &&
    (!classifierEntry || classifierEntry.id !== 'stroke.heuristic-hierarchical')
  ) {
    return { kind: 'unavailable', reason: REASON_AUTO_CLASSIFIER_MISSING };
  }
  return {
    kind: 'real',
    classifierEntry:
      classifierEntry?.id === 'stroke.heuristic-hierarchical'
        ? classifierEntry
        : null,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

interface ExecutionState {
  registrySnapshot: string;
  statusSnapshot: string | null;
  lastRealFusion: FusionProviders | null;
  seenProviderInstances: Set<unknown>;
}

async function settle<T>(
  promise: Promise<Result<T>>,
): Promise<
  | { settled: 'resolved'; result: Result<T> }
  | { settled: 'rejected'; error: string }
> {
  try {
    return { settled: 'resolved', result: await promise };
  } catch (error) {
    return { settled: 'rejected', error: describeError(error) };
  }
}

async function execSelect(
  action: Extract<Action, { op: 'select' }>,
  step: number,
  violations: Violation[],
): Promise<unknown> {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'select', invariant, detail });
  const recording = buildRecording(action.recording);
  const before = stableJson(recording ?? null);

  let outcome: ReturnType<typeof selectVisionProviders>;
  try {
    outcome = selectVisionProviders(action.shotType, recording);
  } catch (error) {
    fail('select.no_throw', describeError(error));
    return { threw: describeError(error) };
  }

  let alt: ReturnType<typeof selectVisionProviders> | null = null;
  try {
    alt = selectVisionProviders(action.altShotType, recording);
  } catch (error) {
    fail('select.no_throw', `alt shotType: ${describeError(error)}`);
  }

  const frameCount = recording ? recording.poseFrames.length : null;
  const expectedKind =
    !recording || recording.poseFrames.length < 6 ? 'unavailable' : 'real';
  if (outcome.kind !== expectedKind) {
    fail(
      'select.gate',
      `frames=${frameCount} expected ${expectedKind}, got ${outcome.kind}`,
    );
  }
  if (outcome.kind === 'unavailable') {
    const expectedReason = recording
      ? REASON_TOO_FEW_FRAMES
      : REASON_NO_RECORDING;
    if (outcome.reason !== expectedReason) {
      fail('select.gate', `reason mismatch: ${outcome.reason}`);
    }
  }
  if (alt) {
    if (alt.kind !== outcome.kind) {
      fail(
        'select.gate',
        `shotType changed the gate: ${action.shotType}=${outcome.kind} vs ${action.altShotType}=${alt.kind}`,
      );
    } else if (
      alt.kind === 'unavailable' &&
      outcome.kind === 'unavailable' &&
      alt.reason !== outcome.reason
    ) {
      fail('select.gate', 'shotType changed the unavailable reason');
    }
  }
  if (stableJson(recording ?? null) !== before) {
    fail(
      'select.input_immutable',
      'recording mutated by selectVisionProviders',
    );
  }

  const digest: Record<string, unknown> = {
    kind: outcome.kind,
    reason: outcome.kind === 'unavailable' ? outcome.reason : null,
    frameCount,
  };

  if (outcome.kind === 'real' && recording) {
    const set = outcome.providers;
    if (set.source !== 'real')
      fail('select.real_shape', `source=${set.source}`);
    if (set.ball !== null)
      fail('select.real_shape', 'ball provider is not null');
    if (set.pose.modelVersion !== recording.poseModelVersion) {
      fail('select.real_shape', `pose.modelVersion=${set.pose.modelVersion}`);
    }
    if (set.stroke.modelVersion !== recording.trigger.modelVersion) {
      fail(
        'select.real_shape',
        `stroke.modelVersion=${set.stroke.modelVersion}`,
      );
    }
    if (set.paddle.modelVersion !== 'paddle-none-0') {
      fail(
        'select.real_shape',
        `paddle.modelVersion=${set.paddle.modelVersion}`,
      );
    }
    if (
      set.pose.source !== 'real' ||
      set.stroke.source !== 'real' ||
      set.paddle.source !== 'real'
    ) {
      fail('select.real_shape', 'sub-provider source is not real');
    }

    const probe = action.recording.probe;
    const poseA = await settle(set.pose.extractPose(PROBE_CLIP, probe));
    const poseB = await settle(set.pose.extractPose(PROBE_CLIP, probe));
    if (poseA.settled === 'rejected') {
      fail('select.pose_replay', `extractPose rejected: ${poseA.error}`);
    } else {
      const inWindow = recording.poseFrames
        .filter(
          f => f.timestampMs >= probe.startMs && f.timestampMs <= probe.endMs,
        )
        .map(f => f.timestampMs)
        .sort((a, b) => a - b);
      const result = poseA.result;
      if (inWindow.length < 6) {
        if (result.ok) {
          fail(
            'select.pose_replay',
            `expected typed failure for ${inWindow.length} frames in window, got ok(${result.value.length})`,
          );
        } else if (
          result.failure.kind !== 'low_confidence' ||
          result.failure.code !== 'pose.too_few_recorded_frames'
        ) {
          fail(
            'select.pose_replay',
            `unexpected failure ${result.failure.kind}/${result.failure.code}`,
          );
        }
      } else if (!result.ok) {
        fail(
          'select.pose_replay',
          `expected ok for ${inWindow.length} frames, got ${result.failure.code}`,
        );
      } else {
        const got = result.value.map(f => f.timestampMs);
        const ascending = got.every(
          (t, i) => i === 0 || (got[i - 1] ?? 0) <= t,
        );
        if (!ascending)
          fail('select.pose_replay', 'replayed frames not ascending');
        if (stableJson(got) !== stableJson(inWindow)) {
          fail(
            'select.pose_replay',
            `replayed ${got.length} frames, recorded ${inWindow.length} in window`,
          );
        }
      }
      digest.pose = result.ok
        ? { ok: true, n: result.value.length }
        : { ok: false, code: result.failure.code };
    }
    if (stableJson(poseA) !== stableJson(poseB)) {
      fail(
        'select.deterministic',
        'extractPose differs between identical calls',
      );
    }

    const strokes = await settle(set.stroke.detectStrokes(PROBE_CLIP));
    if (strokes.settled === 'rejected') {
      fail('select.stroke_replay', `detectStrokes rejected: ${strokes.error}`);
    } else {
      const result = strokes.result;
      const { startMs, endMs, peakMotionMs, confidence } = recording.trigger;
      if (endMs <= startMs) {
        if (result.ok) {
          fail('select.stroke_replay', 'inverted/empty window replayed as ok');
        } else if (result.failure.code !== 'stroke.invalid_recorded_window') {
          fail(
            'select.stroke_replay',
            `unexpected code ${result.failure.code}`,
          );
        }
      } else if (!result.ok) {
        fail(
          'select.stroke_replay',
          `valid window failed: ${result.failure.code}`,
        );
      } else {
        const event = result.value[0];
        if (
          result.value.length !== 1 ||
          !event ||
          event.startMs !== startMs ||
          event.endMs !== endMs ||
          event.contactMs !== peakMotionMs ||
          event.confidence !== confidence ||
          event.shotTypeHypothesis !== null
        ) {
          fail(
            'select.stroke_replay',
            `replayed event ${stableJson(result.value)} != recorded trigger`,
          );
        }
      }
      digest.stroke = result.ok
        ? { ok: true }
        : { ok: false, code: result.failure.code };
    }

    const paddle = await settle(set.paddle.detectPaddle(PROBE_CLIP, probe));
    if (paddle.settled === 'rejected') {
      fail('select.paddle_absent', `detectPaddle rejected: ${paddle.error}`);
    } else if (!paddle.result.ok || paddle.result.value.length !== 0) {
      fail(
        'select.paddle_absent',
        `detectPaddle returned ${stableJson(paddle.result)}`,
      );
    }
    digest.phase = set.phase.modelVersion;
    digest.features = set.features.version;
  }
  return digest;
}

function execFusion(
  action: Extract<Action, { op: 'fusion' }>,
  step: number,
  violations: Violation[],
  env: HarnessEnv,
  state: ExecutionState,
): unknown {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'fusion', invariant, detail });
  const os = env.currentPlatformOs();
  const expected = expectedFusion(os, action.shotType);
  let outcome: ReturnType<typeof createFusionProviders>;
  try {
    outcome = createFusionProviders(action.shotType);
  } catch (error) {
    fail('fusion.no_throw', describeError(error));
    return { threw: describeError(error) };
  }
  if (outcome.kind !== expected.kind) {
    fail(
      'fusion.gate',
      `os=${os} shotType=${action.shotType} expected ${expected.kind}, got ${outcome.kind}`,
    );
  } else if (
    outcome.kind === 'unavailable' &&
    expected.kind === 'unavailable'
  ) {
    if (outcome.reason !== expected.reason) {
      fail(
        'fusion.gate',
        `reason "${outcome.reason}" != expected "${expected.reason}"`,
      );
    }
  }
  const digest: Record<string, unknown> = {
    os,
    shotType: action.shotType,
    kind: outcome.kind,
    reason: outcome.kind === 'unavailable' ? outcome.reason : null,
  };
  if (outcome.kind === 'real') {
    const p = outcome.providers;
    if (p.classifier !== null)
      fail('fusion.real_shape', 'flat classifier is not null');
    if (p.shadowScorers.length !== 0)
      fail('fusion.real_shape', 'shadowScorers not empty');
    const entry = expected.kind === 'real' ? expected.classifierEntry : null;
    if (entry) {
      if (!p.autoStrokeClassifier) {
        fail(
          'fusion.real_shape',
          'auto classifier missing although registered',
        );
      } else {
        const d = p.autoStrokeClassifier.descriptor;
        const expectedDescriptor = {
          providerId: entry.id,
          modelVersion: entry.version,
          runtime: entry.runtime,
          executionTarget: entry.executionTarget,
          artifactHash: entry.artifactHash,
          inputSchemaVersion: entry.inputSchemaVersion,
          outputSchemaVersion: entry.outputSchemaVersion,
        };
        if (stableJson(d) !== stableJson(expectedDescriptor)) {
          fail(
            'fusion.real_shape',
            `descriptor ${stableJson(d)} != manifest ${stableJson(expectedDescriptor)}`,
          );
        }
      }
    } else if (p.autoStrokeClassifier) {
      fail(
        'fusion.real_shape',
        'auto classifier present without registry entry',
      );
    }
    for (const instance of [
      p.phase,
      p.biomechanics,
      p.scorer,
      p.faultDetector,
      p.uncertainty,
      p.coach,
    ]) {
      if (state.seenProviderInstances.has(instance)) {
        fail(
          'fusion.real_shape',
          'provider instance shared across createFusionProviders calls',
        );
      }
      state.seenProviderInstances.add(instance);
    }
    digest.descriptors = {
      phase: { modelVersion: p.phase.modelVersion, source: p.phase.source },
      biomechanics: p.biomechanics.descriptor,
      scorer: p.scorer.descriptor,
      faults: p.faultDetector.descriptor,
      uncertainty: p.uncertainty.descriptor,
      coach: p.coach.descriptor,
      auto: p.autoStrokeClassifier?.descriptor ?? null,
    };
    state.lastRealFusion = p;
  }
  return digest;
}

const TAXONOMY_LABELS_MOBILE = ['UNKNOWN', 'OVERHEAD', 'FOREHAND', 'BACKHAND'];

async function execClassify(
  action: Extract<Action, { op: 'classify' }>,
  step: number,
  violations: Violation[],
  state: ExecutionState,
): Promise<unknown> {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'classify', invariant, detail });
  let classifier = state.lastRealFusion?.autoStrokeClassifier ?? null;
  if (!classifier) {
    const fusion = createFusionProviders(null);
    if (fusion.kind !== 'real' || !fusion.providers.autoStrokeClassifier) {
      return { skipped: 'no auto classifier available on current platform' };
    }
    classifier = fusion.providers.autoStrokeClassifier;
    state.lastRealFusion = fusion.providers;
  }
  const input = buildClassifyInput(action.spec);
  const before = stableJson(input);
  const first = await settle(classifier.classify(input));
  if (first.settled === 'rejected') {
    fail('classify.resolves', `classify rejected: ${first.error}`);
    return { rejected: first.error };
  }
  if (stableJson(input) !== before) {
    fail('classify.input_immutable', 'classify input mutated');
  }
  const result = first.result;
  if (!result.ok) {
    fail('classify.resolves', `typed failure ${result.failure.code}`);
    return { ok: false, code: result.failure.code };
  }
  const v = result.value;
  if (v.taxonomyVersion !== 'pickleball-stroke-taxonomy-v3') {
    fail('classify.shape', `taxonomyVersion=${v.taxonomyVersion}`);
  }
  if (!v.classifierVersion.startsWith(classifier.descriptor.modelVersion)) {
    fail(
      'classify.shape',
      `classifierVersion "${v.classifierVersion}" does not carry manifest version "${classifier.descriptor.modelVersion}"`,
    );
  }
  if (![1, 2].includes(v.taxonomyDepth)) {
    fail(
      'classify.shape',
      `taxonomyDepth=${v.taxonomyDepth} (speed series are never passed on mobile)`,
    );
  }
  if (!Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    fail('classify.shape', `confidence=${v.confidence}`);
  }
  if (!TAXONOMY_LABELS_MOBILE.includes(v.label)) {
    fail('classify.shape', `label=${v.label}`);
  }
  if (v.taxonomyDepth === 1 && v.leaf !== v.label) {
    fail('classify.shape', `depth 1 leaf=${v.leaf} label=${v.label}`);
  }
  if (v.taxonomyDepth === 2 && v.leaf !== null) {
    fail('classify.shape', `depth 2 leaf=${v.leaf}`);
  }
  if (
    v.label === 'UNKNOWN' &&
    (v.taxonomyDepth !== 1 || v.confidence !== 0.2)
  ) {
    fail(
      'classify.shape',
      `UNKNOWN with depth=${v.taxonomyDepth} confidence=${v.confidence}`,
    );
  }
  if (
    !Array.isArray(v.evidence) ||
    !v.evidence.every(e => typeof e === 'string') ||
    !Array.isArray(v.limitingFactors) ||
    !v.limitingFactors.every(e => typeof e === 'string')
  ) {
    fail('classify.shape', 'evidence/limitingFactors are not string arrays');
  }
  if (input.contactMs === null && input.eventPeakMs === null) {
    if (
      v.label !== 'UNKNOWN' ||
      !v.limitingFactors.includes('no_contact_and_no_event_peak_reference')
    ) {
      fail(
        'classify.reference',
        `no reference but label=${v.label} factors=${stableJson(v.limitingFactors)}`,
      );
    }
  }
  if (input.contactMs === null && input.eventPeakMs !== null) {
    if (!v.limitingFactors.includes('reference_is_event_peak_not_contact')) {
      fail(
        'classify.reference',
        'event-peak substitution not recorded in limitingFactors',
      );
    }
  }
  if (
    v.taxonomyDepth === 2 &&
    !v.limitingFactors.includes('no_speed_series_for_intensity')
  ) {
    fail('classify.shape', 'depth 2 without no_speed_series_for_intensity');
  }

  const second = await settle(classifier.classify(input));
  if (
    second.settled !== 'resolved' ||
    stableJson(second.result) !== stableJson(result)
  ) {
    fail('classify.deterministic', 'same input classified differently twice');
  }

  if (
    input.paddle &&
    input.paddle.observations.every(o => o.keypoints.center === null)
  ) {
    const noPaddle = await settle(
      classifier.classify({ ...input, paddle: null }),
    );
    if (
      noPaddle.settled !== 'resolved' ||
      stableJson(noPaddle.result) !== stableJson(result)
    ) {
      fail(
        'classify.paddle_dropped',
        'centerless paddle track changed the prediction vs. no track',
      );
    }
  }
  if (input.ball) {
    const noBall = await settle(classifier.classify({ ...input, ball: null }));
    if (
      noBall.settled !== 'resolved' ||
      stableJson(noBall.result) !== stableJson(result)
    ) {
      fail(
        'classify.ball_ignored',
        'ball track changed the prediction on mobile',
      );
    }
  }
  return {
    label: v.label,
    leaf: v.leaf,
    depth: v.taxonomyDepth,
    confidence: v.confidence,
    limitingFactors: v.limitingFactors,
    frames: input.pose.frames.length,
    mutation: action.spec.mutation,
  };
}

function execRegistry(
  action: Extract<Action, { op: 'registry' }>,
  step: number,
  violations: Violation[],
): unknown {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'registry', invariant, detail });
  let entry: ModelManifestEntry | null;
  try {
    entry = registry.resolve(action.query);
  } catch (error) {
    fail('registry.resolve', `resolve threw ${describeError(error)}`);
    return { threw: describeError(error) };
  }
  const status = action.query.status ?? 'production';
  if (entry) {
    if (entry.task !== action.query.task)
      fail('registry.resolve', `task ${entry.task}`);
    if (entry.deploymentStatus !== status)
      fail('registry.resolve', `status ${entry.deploymentStatus}`);
    if (!entry.supportedPlatforms.includes(action.query.platform)) {
      fail(
        'registry.resolve',
        `platform ${action.query.platform} unsupported by ${entry.id}`,
      );
    }
    if (
      action.query.stroke !== undefined &&
      entry.supportedStrokes !== 'all' &&
      !entry.supportedStrokes.includes(action.query.stroke)
    ) {
      fail(
        'registry.resolve',
        `stroke ${action.query.stroke} unsupported by ${entry.id}`,
      );
    }
    if (registry.byId(entry.id, entry.version) !== entry) {
      fail('registry.resolve', 'byId does not round-trip the resolved entry');
    }
    for (const alias of ['latest', 'current', 'head', '']) {
      if (registry.byId(entry.id, alias) !== null) {
        fail('registry.resolve', `alias version "${alias}" resolved`);
      }
    }
    // Highest version wins: no other matching entry may sort above it.
    const better = registry.list(action.query.task).filter(
      candidate =>
        candidate.deploymentStatus === status &&
        candidate.supportedPlatforms.includes(action.query.platform) &&
        (action.query.stroke === undefined ||
          candidate.supportedStrokes === 'all' ||
          candidate.supportedStrokes.includes(action.query.stroke)) &&
        candidate.version.localeCompare(entry!.version, undefined, {
          numeric: true,
        }) > 0,
    );
    if (better.length > 0) {
      fail(
        'registry.resolve',
        `${better[0]?.id}@${better[0]?.version} outranks resolved ${entry.version}`,
      );
    }
  } else {
    const any = registry
      .list(action.query.task)
      .some(
        candidate =>
          candidate.deploymentStatus === status &&
          candidate.supportedPlatforms.includes(action.query.platform) &&
          (action.query.stroke === undefined ||
            candidate.supportedStrokes === 'all' ||
            candidate.supportedStrokes.includes(action.query.stroke)),
      );
    if (any)
      fail(
        'registry.resolve',
        'resolve returned null although a matching entry exists',
      );
  }
  const again = registry.resolve(action.query);
  if (again !== entry) fail('registry.resolve', 'resolve is not deterministic');
  return {
    query: action.query,
    id: entry?.id ?? null,
    version: entry?.version ?? null,
  };
}

function execWithEntry(
  action: Extract<Action, { op: 'withEntry' }>,
  step: number,
  violations: Violation[],
): unknown {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'withEntry', invariant, detail });
  const before = registry.list().length;
  const existing = DEFAULT_MODEL_MANIFEST.entries[0];
  if (!existing) {
    fail('registry.resolve', 'default manifest is empty');
    return { empty: true };
  }
  if (action.mode === 'duplicate') {
    let threw = false;
    try {
      registry.withEntry({ ...existing });
    } catch {
      threw = true;
    }
    if (!threw)
      fail('registry.resolve', 'withEntry accepted a duplicate id@version');
    if (registry.list().length !== before)
      fail('registry.resolve', 'duplicate withEntry grew the module registry');
    return { mode: 'duplicate', threw };
  }
  const fresh: ModelManifestEntry = {
    ...existing,
    id: 'stress.fresh-entry',
    version: `stress-${step}`,
  };
  let derivedCount: number | null = null;
  try {
    derivedCount = registry.withEntry(fresh).list().length;
  } catch (error) {
    fail('registry.resolve', `withEntry(fresh) threw ${describeError(error)}`);
  }
  if (derivedCount !== null && derivedCount !== before + 1) {
    fail(
      'registry.resolve',
      `derived registry has ${derivedCount} entries, expected ${before + 1}`,
    );
  }
  if (
    registry.list().length !== before ||
    registry.byId(fresh.id, fresh.version) !== null
  ) {
    fail(
      'registry.resolve',
      'withEntry(fresh) leaked into the module registry',
    );
  }
  return { mode: 'fresh', derivedCount };
}

function execStatus(
  step: number,
  violations: Violation[],
  state: ExecutionState,
): unknown {
  const fail = (invariant: string, detail: string) =>
    violations.push({ step, op: 'status', invariant, detail });
  let status: ReturnType<typeof scoringStackStatus>;
  try {
    status = scoringStackStatus();
  } catch (error) {
    fail('status.stable', describeError(error));
    return { threw: describeError(error) };
  }
  const json = stableJson(status);
  if (state.statusSnapshot === null) state.statusSnapshot = json;
  else if (state.statusSnapshot !== json)
    fail('status.stable', `status changed: ${json}`);
  if (!status.installed) fail('status.stable', 'installed=false');
  if (status.version !== SCORING_STACK_VERSION)
    fail('status.stable', `version=${status.version}`);
  if (status.requirement !== 'recorded_pose_sequence')
    fail('status.stable', `requirement=${status.requirement}`);
  const scorer = registry.resolve({
    task: 'technique_scoring',
    platform: 'ios',
  });
  if (scorer && !status.version.includes(scorer.version)) {
    fail(
      'status.stable',
      `version "${status.version}" does not carry registered scorer ${scorer.version}`,
    );
  }
  return status;
}

/** Executes an action list, checking invariants after every step. */
export async function runActions(
  actions: readonly Action[],
  env: HarnessEnv,
): Promise<RunResult> {
  const violations: Violation[] = [];
  const steps: StepRecord[] = [];
  const state: ExecutionState = {
    registrySnapshot: stableJson(registry.list()),
    statusSnapshot: null,
    lastRealFusion: null,
    seenProviderInstances: new Set(),
  };
  const initialOs = env.currentPlatformOs();
  try {
    for (let step = 0; step < actions.length; step += 1) {
      const action = actions[step]!;
      let digest: unknown;
      switch (action.op) {
        case 'select':
          digest = await execSelect(action, step, violations);
          break;
        case 'fusion':
          digest = execFusion(action, step, violations, env, state);
          break;
        case 'platform':
          env.setPlatformOs(action.os);
          digest = { os: action.os };
          break;
        case 'classify':
          digest = await execClassify(action, step, violations, state);
          break;
        case 'registry':
          digest = execRegistry(action, step, violations);
          break;
        case 'status':
          digest = execStatus(step, violations, state);
          break;
        case 'withEntry':
          digest = execWithEntry(action, step, violations);
          break;
      }
      if (stableJson(registry.list()) !== state.registrySnapshot) {
        violations.push({
          step,
          op: action.op,
          invariant: 'fusion.registry_frozen',
          detail: 'module registry contents changed',
        });
      }
      steps.push({ step, op: action.op, digest: stableJson(digest) });
    }
  } finally {
    env.setPlatformOs(initialOs);
  }
  return {
    steps,
    violations,
    traceHash: sha256(
      steps.map(s => `${s.step}:${s.op}:${s.digest}`).join('\n'),
    ),
  };
}

// ───────────────────────────── Campaign ─────────────────────────────

/** Coarse tags describing what a step actually reached (for coverage). */
function coverageTags(record: StepRecord): string[] {
  const digest = JSON.parse(record.digest) as Record<string, unknown>;
  const tags: string[] = [];
  const tag = (key: string) => {
    if (key in digest) tags.push(`${record.op}.${key}=${String(digest[key])}`);
  };
  switch (record.op) {
    case 'select':
      tag('kind');
      if (digest.frameCount === null) tags.push('select.recording=missing');
      if (digest.pose && typeof digest.pose === 'object') {
        const pose = digest.pose as { ok: boolean };
        tags.push(`select.pose.ok=${pose.ok}`);
      }
      if (digest.stroke && typeof digest.stroke === 'object') {
        const stroke = digest.stroke as { ok: boolean };
        tags.push(`select.stroke.ok=${stroke.ok}`);
      }
      break;
    case 'fusion':
      tag('os');
      tag('kind');
      tags.push(`fusion.auto=${digest.shotType === null}`);
      break;
    case 'classify':
      tag('label');
      tag('depth');
      tag('mutation');
      if ('skipped' in digest) tags.push('classify.skipped');
      break;
    case 'registry':
      tags.push(`registry.resolved=${digest.id !== null}`);
      break;
    case 'withEntry':
      tag('mode');
      break;
    default:
      break;
  }
  return tags;
}

export interface SequenceOutcome {
  seed: number;
  length: number;
  ops: Record<string, number>;
  coverage: Record<string, number>;
  outcome: 'HELD' | 'BROKEN';
  traceHash: string;
  deterministic: boolean;
  violations: Violation[];
  minimized: { keptIndices: number[]; violations: Violation[] } | null;
}

export async function runSeed(
  seed: number,
  env: HarnessEnv,
): Promise<SequenceOutcome> {
  const actions = generateSequence(seed);
  const actionsAgain = generateSequence(seed);
  const generationStable = stableJson(actions) === stableJson(actionsAgain);
  const first = await runActions(actions, env);
  const second = await runActions(actions, env);
  const deterministic =
    generationStable &&
    first.traceHash === second.traceHash &&
    stableJson(first.violations) === stableJson(second.violations);
  const violations = [...first.violations];
  if (!deterministic) {
    violations.push({
      step: -1,
      op: 'status',
      invariant: 'sequence.deterministic',
      detail: `trace ${first.traceHash} vs ${second.traceHash}; generation stable=${generationStable}`,
    });
  }
  const ops: Record<string, number> = {};
  for (const action of actions) ops[action.op] = (ops[action.op] ?? 0) + 1;
  const coverage: Record<string, number> = {};
  for (const record of first.steps) {
    for (const tag of coverageTags(record)) {
      coverage[tag] = (coverage[tag] ?? 0) + 1;
    }
  }
  const outcome: SequenceOutcome = {
    seed,
    length: actions.length,
    ops,
    coverage,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    traceHash: first.traceHash,
    deterministic,
    violations,
    minimized: null,
  };
  if (first.violations.length > 0) {
    outcome.minimized = await minimizeFailure(actions, first.violations, env);
  }
  return outcome;
}

/**
 * ddmin-style shrink: drop chunks of actions while the same invariant ids
 * still fire. Returns the kept indices (into the seed's action list) and the
 * violations the minimal list produces.
 */
export async function minimizeFailure(
  actions: readonly Action[],
  target: readonly Violation[],
  env: HarnessEnv,
): Promise<{ keptIndices: number[]; violations: Violation[] }> {
  const targetIds = new Set(target.map(v => v.invariant));
  const reproduces = (violations: Violation[]) =>
    violations.some(v => targetIds.has(v.invariant));
  let kept = actions.map((_, index) => index);
  let chunk = Math.max(1, Math.floor(kept.length / 2));
  let lastViolations = [...target];
  while (chunk >= 1 && kept.length > 1) {
    let reduced = false;
    for (let start = 0; start < kept.length; start += chunk) {
      const candidate = [...kept.slice(0, start), ...kept.slice(start + chunk)];
      if (candidate.length === 0) continue;
      const result = await runActions(
        candidate.map(i => actions[i]!),
        env,
      );
      if (reproduces(result.violations)) {
        kept = candidate;
        lastViolations = result.violations;
        reduced = true;
        start -= chunk;
      }
    }
    if (!reduced) chunk = Math.floor(chunk / 2);
  }
  return { keptIndices: kept, violations: lastViolations };
}

export interface CampaignSummary {
  startSeed: number;
  sequences: number;
  executedSteps: number;
  held: number;
  broken: number;
  nonDeterministic: number;
  opCounts: Record<string, number>;
  coverage: Record<string, number>;
  minLength: number;
  maxLength: number;
  failingSeeds: number[];
  invariantsViolated: Record<string, number>;
  rows: SequenceOutcome[];
}

export async function runCampaign(
  startSeed: number,
  sequences: number,
  env: HarnessEnv,
): Promise<CampaignSummary> {
  const rows: SequenceOutcome[] = [];
  const opCounts: Record<string, number> = {};
  const coverage: Record<string, number> = {};
  const invariantsViolated: Record<string, number> = {};
  let executedSteps = 0;
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;
  for (let i = 0; i < sequences; i += 1) {
    const row = await runSeed(startSeed + i, env);
    rows.push(row);
    executedSteps += row.length;
    minLength = Math.min(minLength, row.length);
    maxLength = Math.max(maxLength, row.length);
    for (const [op, count] of Object.entries(row.ops)) {
      opCounts[op] = (opCounts[op] ?? 0) + count;
    }
    for (const [tag, count] of Object.entries(row.coverage)) {
      coverage[tag] = (coverage[tag] ?? 0) + count;
    }
    for (const violation of row.violations) {
      invariantsViolated[violation.invariant] =
        (invariantsViolated[violation.invariant] ?? 0) + 1;
    }
  }
  return {
    startSeed,
    sequences,
    executedSteps,
    held: rows.filter(r => r.outcome === 'HELD').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').length,
    nonDeterministic: rows.filter(r => !r.deterministic).length,
    opCounts,
    coverage,
    minLength,
    maxLength,
    failingSeeds: rows.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    invariantsViolated,
    rows,
  };
}
