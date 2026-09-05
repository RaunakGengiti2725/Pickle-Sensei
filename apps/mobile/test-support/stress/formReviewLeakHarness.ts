/**
 * LONG-RUN LEAK harness support for the Form Review screen
 * (`__tests__/stress/formReviewScreen.longRunLeak.stress.test.tsx`).
 *
 * Pure, deterministic pieces only — nothing here touches React, jest or the
 * database:
 *  - a seeded RNG (mulberry32) so every iteration is replayable from its seed;
 *  - the per-iteration PLAN (which stored stroke the screen opens, the phase
 *    deep-link, the interaction script, and how the screen leaves);
 *  - the real stored shapes the screen reads (a ShotAnalysis, its immutable
 *    analysis record, and the captured clip with its pose sidecar ref);
 *  - the leak statistics (least-squares heap slope per 100 iterations,
 *    monotonicity, render-time drift).
 */
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { PHASES } from '@pickle/shared-types';
import type {
  CapturedClip,
  PoseSequenceSidecarRef,
} from '../../src/camera/capture';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, and identical across Node versions. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
  };
}

// ─── Stored strokes the screen can open ─────────────────────────────────────

/**
 * Every evidence shape `loadStrokeResultEvidence` can hand the screen:
 *  - clip_sidecar     local_shot + record + capture with a VALID pose sidecar
 *                     → native clip player + measured skeleton;
 *  - record_only      no local_shot row, the analysis comes from the
 *                     immutable record's `result`; capture present;
 *  - no_capture       record points at a capture row that no longer exists
 *                     → no clip, no review, pose-only JS clock;
 *  - bad_sidecar      capture whose sidecar hash does not match the file
 *                     → clip plays, skeleton honestly absent;
 *  - missing          no rows at all → the "Review unavailable" state.
 */
export const VARIANTS = [
  'clip_sidecar',
  'record_only',
  'no_capture',
  'bad_sidecar',
  'missing',
] as const;
export type Variant = (typeof VARIANTS)[number];

export const ANALYSIS_ID: Record<Variant, string> = {
  clip_sidecar: 'fr-stress-clip-sidecar',
  record_only: 'fr-stress-record-only',
  no_capture: 'fr-stress-no-capture',
  bad_sidecar: 'fr-stress-bad-sidecar',
  missing: 'fr-stress-missing',
};

export const CAPTURE_ID: Record<Variant, string> = {
  clip_sidecar: 'fr-stress-capture-a',
  record_only: 'fr-stress-capture-b',
  no_capture: 'fr-stress-capture-gone',
  bad_sidecar: 'fr-stress-capture-c',
  missing: 'fr-stress-capture-none',
};

export const SIDECAR_URI: Record<
  'clip_sidecar' | 'record_only' | 'bad_sidecar',
  string
> = {
  clip_sidecar: 'file:///private/captures/fr-stress-a.pose.json',
  record_only: 'file:///private/captures/fr-stress-b.pose.json',
  bad_sidecar: 'file:///private/captures/fr-stress-c.pose.json',
};

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

/** A scored, real-source forehand drive (same shape as the screen suite). */
export function makeAnalysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: 'fr-stress-set',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
        applicable: false,
      }),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

/** The immutable record row `saveAnalysisRecord` persists for one outcome. */
export function makeRecord(
  id: string,
  captureId: string,
  result: ShotAnalysis | null,
): StrokeResultEvidenceRecord & {
  captureId: string;
  createdAtIso: string;
  engineVersion: string;
} {
  return {
    id,
    captureId,
    createdAtIso: '2026-09-01T10:00:02.000Z',
    engineVersion: 'on-device-fusion-1',
    strokeIntent: {
      declaredStroke: 'forehand_drive',
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: [],
    },
  };
}

export function makeSidecarRef(
  uri: string,
  sha256: string,
  frameCount: number,
): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri,
    frameCount,
    sha256,
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  };
}

/** A validated automatic-trigger clip (shape from captureRepository.test). */
export function makeClip(
  uri: string,
  poseSequence: PoseSequenceSidecarRef | null,
): CapturedClip {
  return {
    uri,
    durationMs: 3400,
    fps: 59.94,
    width: 1080,
    height: 1920,
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    posterUri: `${uri}.poster.jpg`,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: 0.84,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'mediapipe_pose_landmarker',
      poseModelVersion: 'mediapipe-pose-landmarker-full-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 8,
      poseFrameCount: 7,
      poseMissingFrameCount: 1,
      trackedDurationMs: 600,
      meanCanonicalJointVisibility: 0.86,
      meanJointCoverage: 0.93,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 5,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 6,
          meanNormalizedPerSecond: 1.2,
          peakNormalizedPerSecond: 2.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1800,
    postRollMs: 1450,
    ...(poseSequence ? { poseSequence } : {}),
  };
}

// ─── Iteration plan ─────────────────────────────────────────────────────────

export type Action =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'play' }
  | { kind: 'speed' }
  | { kind: 'autopause' }
  | { kind: 'layout' }
  | { kind: 'seek'; ratio: number }
  | { kind: 'progress'; positionMs: number }
  | { kind: 'clip_error' }
  | { kind: 'tick'; ms: number };

/** How the screen leaves: plain unmount, the real back CTA (navigator pop),
 * or the re-analyze CTA (arms the try-again handoff, pushes Analyze). */
export type Exit = 'unmount' | 'back' | 'reanalyze';

export interface IterationPlan {
  seed: number;
  variant: Variant;
  analysisId: string;
  /** A real phase, a phase no stop owns, or none. */
  phase: string | undefined;
  actions: Action[];
  exit: Exit;
}

const ACTION_KINDS: Action['kind'][] = [
  'next',
  'prev',
  'play',
  'speed',
  'autopause',
  'layout',
  'seek',
  'progress',
  'clip_error',
  'tick',
];

export function planIteration(seed: number): IterationPlan {
  const rng = makeRng(seed);
  // Weighted toward the replay-bearing variants: the leak surface lives in
  // the player (JS clock, arrow pulse, native clip events), not the empty
  // state.
  const variant = rng.pick<Variant>([
    'clip_sidecar',
    'clip_sidecar',
    'clip_sidecar',
    'record_only',
    'no_capture',
    'no_capture',
    'bad_sidecar',
    'missing',
  ]);
  const phaseRoll = rng.next();
  const phase =
    phaseRoll < 0.55
      ? undefined
      : phaseRoll < 0.9
        ? rng.pick(PHASES)
        : 'not-a-phase';
  const count = variant === 'missing' ? 0 : rng.int(0, 8);
  const actions: Action[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = rng.pick(ACTION_KINDS);
    switch (kind) {
      case 'seek':
        actions.push({ kind, ratio: rng.next() });
        break;
      case 'progress':
        actions.push({ kind, positionMs: rng.int(0, 3600) });
        break;
      case 'tick':
        actions.push({ kind, ms: rng.pick([40, 120, 400, 1000, 2600]) });
        break;
      default:
        actions.push({ kind });
    }
  }
  const exit =
    variant === 'missing'
      ? rng.pick<Exit>(['unmount', 'back'])
      : rng.pick<Exit>(['unmount', 'unmount', 'back', 'reanalyze']);
  return {
    seed,
    variant,
    analysisId:
      variant === 'missing'
        ? `${ANALYSIS_ID.missing}-${seed}`
        : ANALYSIS_ID[variant],
    phase,
    actions,
    exit,
  };
}

// ─── Statistics ─────────────────────────────────────────────────────────────

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  /** `process.getActiveResourcesInfo()` histogram (Node ≥ 17). */
  activeResources: Record<string, number>;
  /** Unmounted renderer roots still reachable after a forced GC. */
  liveRenderers: number;
  liveRendererSeeds: number[];
  /** Fake timers still scheduled after the last unmount. */
  pendingTimers: number;
}

export interface SlopeReport {
  /** Least-squares slope of heapUsed over iteration, in bytes/iteration. */
  bytesPerIteration: number;
  /** Slope × 100 as a fraction of the first retained sample. */
  pctPer100: number;
  /** Fraction of consecutive sample pairs where heapUsed grew. */
  monotoneFraction: number;
  first: number;
  last: number;
  samples: number;
}

/**
 * Heap slope over the samples AFTER `skip` warm-up samples (the first
 * measurement pays for module transforms, jit and caches that never come
 * back — a leak is what keeps growing after that).
 */
export function heapSlope(samples: HeapSample[], skip = 1): SlopeReport | null {
  const kept = samples.slice(skip);
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (!first || !last || kept.length < 2) return null;
  const n = kept.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of kept) {
    sx += s.iteration;
    sy += s.heapUsed;
    sxx += s.iteration * s.iteration;
    sxy += s.iteration * s.heapUsed;
  }
  const denominator = n * sxx - sx * sx;
  const bytesPerIteration =
    denominator === 0 ? 0 : (n * sxy - sx * sy) / denominator;
  let ups = 0;
  for (let i = 1; i < kept.length; i += 1) {
    const prev = kept[i - 1];
    const cur = kept[i];
    if (prev && cur && cur.heapUsed > prev.heapUsed) ups += 1;
  }
  return {
    bytesPerIteration,
    pctPer100: (bytesPerIteration * 100 * 100) / first.heapUsed,
    monotoneFraction: kept.length > 1 ? ups / (kept.length - 1) : 0,
    first: first.heapUsed,
    last: last.heapUsed,
    samples: kept.length,
  };
}

export interface DriftReport {
  headMeanMs: number;
  tailMeanMs: number;
  /** tail / head − 1 (positive = slower at the end). */
  driftRatio: number;
  window: number;
}

/** Mean per-iteration time of the first vs the last `window` iterations. */
export function timeDrift(
  durationsMs: number[],
  window = Math.max(10, Math.floor(durationsMs.length / 5)),
): DriftReport | null {
  if (durationsMs.length < window * 2) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const headMeanMs = mean(durationsMs.slice(0, window));
  const tailMeanMs = mean(durationsMs.slice(-window));
  return {
    headMeanMs,
    tailMeanMs,
    driftRatio: headMeanMs > 0 ? tailMeanMs / headMeanMs - 1 : 0,
    window,
  };
}
