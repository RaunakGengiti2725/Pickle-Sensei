/**
 * STRESS KIT — shared, deterministic helpers for the Live Court failure-
 * injection campaigns under apps/mobile/__tests__/stress/.
 *
 * Everything here is seeded (mulberry32) so every iteration is replayable
 * from its seed alone: the same seed produces byte-identical plans, faults
 * and outcomes on every run. Nothing here touches production code.
 *
 * Fault model (LENS failure-injection): for each dependency of the unit we
 * can inject one of
 *   throw | reject | timeout | malformed | partial | slow | never
 * The kit only builds the faulty doubles; the suites own the invariants.
 */
import type {
  IFeatureExtractor,
  IPaddleDetector,
  IPhaseSegmenter,
  IPoseProvider,
  IStrokeDetector,
  StrokeEvent,
  VideoClipRef,
  VisionProviderSet,
} from '@pickle/vision-contracts';
import type {
  Measurement,
  PhaseSpan,
  PoseFrame,
  PaddleFrame,
  Result,
} from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import type { CoachVoicePort } from '../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';

// ─── Node shims (mobile tsconfig has no node typings; see matrix harness) ──

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };

/** STRESS_ITER scales every campaign; the default keeps suites fast. */
export function stressIterations(defaultValue: number): number {
  const raw = process.env.STRESS_ITER;
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`STRESS_ITER must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

/** STRESS_SEED replays exactly one seed (minimization / flake reruns). */
export function stressOnlySeed(): number | null {
  const raw = process.env.STRESS_SEED;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`STRESS_SEED must be an integer, got '${raw}'`);
  }
  return parsed;
}

/** Seed list for a campaign: STRESS_SEED wins; else STRESS_BASE_SEED + i. */
export function campaignSeeds(defaultCount: number): number[] {
  const only = stressOnlySeed();
  if (only !== null) return [only];
  const base = Number(process.env.STRESS_BASE_SEED ?? 1);
  const count = stressIterations(defaultCount);
  return Array.from({ length: count }, (_, i) => base + i);
}

export function artifactsDir(): string {
  return (
    process.env.STRESS_OUT ??
    path.join(__dirname, '..', '..', 'artifacts', 'stress', 'live-court')
  );
}

declare const __dirname: string;

export function writeArtifact(name: string, data: unknown): string {
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: probability => next() < probability,
    pick: items => {
      if (items.length === 0) throw new Error('pick() from empty list');
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle: items => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}

// ─── Fault vocabulary ───────────────────────────────────────────────────────

export const FAULT_MODES = [
  'none',
  'throw',
  'reject',
  'timeout',
  'malformed',
  'partial',
  'slow',
  'never',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

/** Non-'none' modes — the actual faults. */
export const INJECTED_FAULT_MODES: readonly FaultMode[] = FAULT_MODES.filter(
  mode => mode !== 'none',
);

/** Simulated durations. `slow` resolves inside the 60s watchdog window,
 * `timeout` resolves only after it (a dependency that eventually answers,
 * far too late), `never` is a promise that never settles. */
export const SLOW_MS = 5_000;
export const TIMEOUT_MS = 90_000;
export const WATCHDOG_MS = 60_000;

export class InjectedFault extends Error {
  constructor(
    readonly dependency: string,
    readonly mode: FaultMode,
  ) {
    super(`INJECTED_${mode.toUpperCase()}:${dependency}`);
    this.name = 'InjectedFault';
  }
}

/** Resolve after `ms` of (fake) time. Uses the global setTimeout so jest
 * fake timers control it. */
export function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>(resolve => {
    setTimeout(() => resolve(value), ms);
  });
}

export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Apply a mode to a healthy async dependency call. `malformed`/`partial`
 * are supplied by the caller because they are shape-specific. */
export async function applyAsyncFault<T>(
  dependency: string,
  mode: FaultMode,
  healthy: () => Promise<T>,
  shapes: { malformed: () => T; partial: () => T },
): Promise<T> {
  switch (mode) {
    case 'none':
      return healthy();
    case 'throw':
      throw new InjectedFault(dependency, mode);
    case 'reject':
      return Promise.reject(new InjectedFault(dependency, mode));
    case 'timeout':
      return after(TIMEOUT_MS, await healthy());
    case 'slow':
      return after(SLOW_MS, await healthy());
    case 'never':
      return never<T>();
    case 'malformed':
      return shapes.malformed();
    case 'partial':
      return shapes.partial();
  }
}

// ─── Vision provider doubles (LiveCourtEngine → analyzeClip) ────────────────

export const VISION_DEPENDENCIES = [
  'vision.stroke',
  'vision.pose',
  'vision.paddle',
  'vision.phase',
  'vision.features',
] as const;
export type VisionDependency = (typeof VISION_DEPENDENCIES)[number];

export interface VisionFaultPlan {
  /** One fault per stroke index; missing entries are healthy. */
  perStroke: ReadonlyMap<
    number,
    { dependency: VisionDependency; mode: FaultMode; variant: number }
  >;
}

/** Garbage shapes typed through `unknown` — this is what "malformed" means:
 * the dependency returned an ok() Result whose payload violates its
 * contract (null, wrong type, NaN fields, missing keys). */
function garbage<T>(variant: number, options: readonly unknown[]): T {
  return options[variant % options.length] as T;
}

function okResult<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Clip uri carrying the stroke index so concurrent strokes resolve their own
 * faults (`stress://clip#stroke=<i>`). */
export function strokeClipUri(strokeIndex: number): string {
  return `stress://clip#stroke=${strokeIndex}`;
}

const STROKE_TAG = '__stressStroke';

function tagged(value: unknown, strokeIndex: number | null): void {
  if (strokeIndex === null || value === null || typeof value !== 'object')
    return;
  Object.defineProperty(value, STROKE_TAG, {
    value: strokeIndex,
    enumerable: false,
    configurable: true,
  });
}

function readTag(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const tag = (value as Record<string, unknown>)[STROKE_TAG];
  return typeof tag === 'number' ? tag : null;
}

/** Largest window (ms) the healthy fixture providers are asked to fill. */
const MAX_FORWARDED_WINDOW_MS = 60_000;

function invalidWindowReason(window: {
  startMs: number;
  endMs: number;
}): string | null {
  if (window === null || typeof window !== 'object') return 'window_not_object';
  const { startMs, endMs } = window;
  if (typeof startMs !== 'number' || typeof endMs !== 'number') {
    return `non_numeric(${typeof startMs},${typeof endMs})`;
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return `non_finite(${startMs},${endMs})`;
  }
  if (endMs - startMs > MAX_FORWARDED_WINDOW_MS) {
    return `span_${endMs - startMs}ms`;
  }
  return null;
}

export class FaultyVisionProviderSet {
  private armedIndex = 0;

  /** analyzeClip forwards the stroke detector's window to pose/paddle
   * unvalidated; the healthy FIXTURE providers iterate it frame by frame
   * (`for (t = startMs; t <= endMs; t += step)`), which never terminates for
   * string bounds. Each such forward is recorded here and answered with a
   * failed Result instead of reaching the fixture. */
  readonly forwardedInvalidWindows: Array<{
    stroke: number;
    dependency: VisionDependency;
    reason: string;
  }> = [];

  private guardWindow<T>(
    dependency: VisionDependency,
    stroke: number,
    window: { startMs: number; endMs: number },
  ): Result<T> | null {
    const reason = invalidWindowReason(window);
    if (reason === null) return null;
    this.forwardedInvalidWindows.push({ stroke, dependency, reason });
    return {
      ok: false,
      failure: {
        kind: 'corrupted_media',
        code: 'stress.invalid_window_forwarded',
        message: `${dependency} received an invalid window (${reason})`,
        retryable: false,
      },
    };
  }

  constructor(
    private readonly healthy: VisionProviderSet,
    private readonly plan: VisionFaultPlan,
  ) {}

  /** Fallback stroke index for calls whose inputs carry no stroke tag
   * (e.g. a camera fault replaced the clip uri). */
  arm(strokeIndex: number): void {
    this.armedIndex = strokeIndex;
  }

  private indexFromClip(clip: VideoClipRef): number {
    const match = /#stroke=(\d+)$/.exec(String(clip?.uri ?? ''));
    return match ? Number(match[1]) : this.armedIndex;
  }

  private faultFor(
    dependency: VisionDependency,
    strokeIndex: number,
  ): { mode: FaultMode; variant: number } {
    const entry = this.plan.perStroke.get(strokeIndex);
    if (!entry || entry.dependency !== dependency) {
      return { mode: 'none', variant: 0 };
    }
    return { mode: entry.mode, variant: entry.variant };
  }

  providers(): VisionProviderSet {
    const h = this.healthy;
    const stroke: IStrokeDetector = {
      modelVersion: h.stroke.modelVersion,
      source: h.stroke.source,
      detectStrokes: (clip: VideoClipRef) => {
        const index = this.indexFromClip(clip);
        const { mode, variant } = this.faultFor('vision.stroke', index);
        return applyAsyncFault(
          'vision.stroke',
          mode,
          async () => {
            const result = await h.stroke.detectStrokes(clip);
            if (result.ok)
              for (const event of result.value) tagged(event, index);
            return result;
          },
          {
            malformed: () =>
              okResult(
                garbage<StrokeEvent[]>(variant, [
                  null,
                  undefined,
                  {},
                  'not-an-array',
                  [{}],
                  [{ startMs: NaN, endMs: NaN, contactMs: NaN }],
                  [{ startMs: 500, endMs: -100, contactMs: 200 }],
                  [{ startMs: 'a', endMs: 'b' }],
                ]),
              ),
            partial: () =>
              okResult(
                garbage<StrokeEvent[]>(variant, [
                  [],
                  [{ startMs: 0, endMs: 0, contactMs: 0 }],
                  [{ startMs: 0, endMs: 10, contactMs: 5, confidence: 0 }],
                ]),
              ),
          },
        );
      },
    };
    const pose: IPoseProvider = {
      modelVersion: h.pose.modelVersion,
      source: h.pose.source,
      extractPose: (clip, window) => {
        const index = this.indexFromClip(clip);
        const { mode, variant } = this.faultFor('vision.pose', index);
        return applyAsyncFault(
          'vision.pose',
          mode,
          async () => {
            const guarded = this.guardWindow<PoseFrame[]>(
              'vision.pose',
              index,
              window,
            );
            if (guarded) return guarded;
            const result = await h.pose.extractPose(clip, window);
            if (result.ok) tagged(result.value, index);
            return result;
          },
          {
            malformed: () =>
              okResult(
                garbage<PoseFrame[]>(variant, [
                  null,
                  {},
                  [null],
                  [{ timestampMs: NaN, landmarks: null }],
                  [{ timestampMs: 0, landmarks: 'x', confidence: NaN }],
                  [
                    {
                      timestampMs: 0,
                      space: 'normalized-image',
                      confidence: Infinity,
                      landmarks: [{ name: 'left_shoulder', x: NaN, y: NaN }],
                    },
                  ],
                ]),
              ),
            partial: () =>
              okResult(
                garbage<PoseFrame[]>(variant, [
                  [],
                  [
                    {
                      timestampMs: 0,
                      space: 'normalized-image',
                      confidence: 0.1,
                      landmarks: [],
                    },
                  ],
                ]),
              ),
          },
        );
      },
    };
    const paddle: IPaddleDetector = {
      modelVersion: h.paddle.modelVersion,
      source: h.paddle.source,
      detectPaddle: (clip, window) => {
        const index = this.indexFromClip(clip);
        const { mode, variant } = this.faultFor('vision.paddle', index);
        return applyAsyncFault(
          'vision.paddle',
          mode,
          async () =>
            this.guardWindow<PaddleFrame[]>('vision.paddle', index, window) ??
            h.paddle.detectPaddle(clip, window),
          {
            malformed: () =>
              okResult(
                garbage<PaddleFrame[]>(variant, [
                  null,
                  42,
                  [{ timestampMs: NaN, bbox: null, keypoints: null }],
                  [{ timestampMs: 0, bbox: {}, keypoints: {}, confidence: -1 }],
                ]),
              ),
            partial: () => okResult(garbage<PaddleFrame[]>(variant, [[]])),
          },
        );
      },
    };
    const phase: IPhaseSegmenter = {
      modelVersion: h.phase.modelVersion,
      source: h.phase.source,
      segmentPhases: (poseFrames, paddleFrames, strokeEvent) => {
        const index =
          readTag(strokeEvent) ?? readTag(poseFrames) ?? this.armedIndex;
        const { mode, variant } = this.faultFor('vision.phase', index);
        return applyAsyncFault(
          'vision.phase',
          mode,
          () => h.phase.segmentPhases(poseFrames, paddleFrames, strokeEvent),
          {
            malformed: () =>
              okResult(
                garbage<PhaseSpan[]>(variant, [
                  null,
                  {},
                  [null],
                  [{ key: 'contact', representativeMs: NaN }],
                  [{ key: 'bogus_phase', startMs: 0, endMs: 1 }],
                ]),
              ),
            partial: () =>
              okResult(
                garbage<PhaseSpan[]>(variant, [
                  [],
                  [
                    {
                      key: 'ready',
                      startMs: 0,
                      representativeMs: 1,
                      endMs: 2,
                      confidence: 0.5,
                    },
                  ],
                ]),
              ),
          },
        );
      },
    };
    const features: IFeatureExtractor = {
      version: h.features.version,
      extractMeasurements: input => {
        const index = readTag(input.poseFrames) ?? this.armedIndex;
        const { mode, variant } = this.faultFor('vision.features', index);
        return applyAsyncFault(
          'vision.features',
          mode,
          () => h.features.extractMeasurements(input),
          {
            malformed: () =>
              okResult(
                garbage<Measurement[]>(variant, [
                  null,
                  'garbage',
                  [null],
                  [{ metricKey: 'contact_forward_of_hip_norm', value: NaN }],
                  [
                    {
                      metricKey: 'contact_forward_of_hip_norm',
                      value: Infinity,
                      confidence: 0.9,
                      unit: 'normalized',
                      source: 'fixture',
                    },
                  ],
                  [
                    {
                      metricKey: 'knee_flexion_deg',
                      value: -1e9,
                      confidence: NaN,
                      unit: 'degrees',
                      source: 'fixture',
                    },
                  ],
                  [{ metricKey: 42, value: 'x' }],
                ]),
              ),
            partial: () =>
              okResult(
                garbage<Measurement[]>(variant, [
                  [],
                  [
                    {
                      metricKey: 'knee_flexion_deg',
                      value: 28,
                      confidence: 0.9,
                      unit: 'degrees',
                      source: 'fixture',
                    },
                  ],
                ]),
              ),
          },
        );
      },
    };
    return {
      source: h.source,
      stroke,
      pose,
      paddle,
      phase,
      features,
      ball: null,
    };
  }
}

// ─── Coach voice (TTS) doubles ──────────────────────────────────────────────

export const TTS_FAULTS = [
  'none',
  'available_false',
  'available_throws',
  'available_garbage',
  'speak_throws',
  'speak_false',
  'speak_garbage',
  'stop_throws',
] as const;
export type TtsFault = (typeof TTS_FAULTS)[number];

export interface VoiceLog {
  spoken: string[];
  stopCalls: number;
  faultsFired: number;
}

/** A voice port whose behaviour is decided per call by `faultAt(callIndex)`. */
export function faultyVoice(faultAt: (callIndex: number) => TtsFault): {
  voice: CoachVoicePort;
  log: VoiceLog;
} {
  const log: VoiceLog = { spoken: [], stopCalls: 0, faultsFired: 0 };
  let calls = 0;
  const voice: CoachVoicePort = {
    available() {
      const fault = faultAt(calls++);
      if (fault === 'available_false') return false;
      if (fault === 'available_throws') {
        log.faultsFired += 1;
        throw new InjectedFault('tts.available', 'throw');
      }
      if (fault === 'available_garbage') {
        log.faultsFired += 1;
        return 'yes' as unknown as boolean;
      }
      return true;
    },
    speak(text) {
      const fault = faultAt(calls++);
      if (fault === 'speak_throws') {
        log.faultsFired += 1;
        throw new InjectedFault('tts.speak', 'throw');
      }
      if (fault === 'speak_false') return false;
      if (fault === 'speak_garbage') {
        log.faultsFired += 1;
        log.spoken.push(text);
        return { queued: true } as unknown as boolean;
      }
      log.spoken.push(text);
      return true;
    },
    stop() {
      log.stopCalls += 1;
      const fault = faultAt(calls++);
      if (fault === 'stop_throws') {
        log.faultsFired += 1;
        throw new InjectedFault('tts.stop', 'throw');
      }
    },
  };
  return { voice, log };
}

// ─── Synthetic session events (coach + summary campaigns) ───────────────────

export const CHECKPOINT_KEYS: readonly CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];

const DIRECTIONS: readonly FaultDirection[] = [
  'late',
  'early',
  'high',
  'low',
  'long',
  'short',
  'none',
];

export interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable: boolean;
}

export function scoredAnalysis(
  overallScore: number,
  checkpoints: readonly CheckpointSpec[],
): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: checkpoints.map(spec => ({
        key: spec.key,
        score: spec.score,
        confidence: 0.9,
        band: 'yellow',
        direction: spec.direction,
        severity: spec.severity,
        applicable: spec.applicable,
      })),
    },
  } as unknown as AnalysisRecord;
}

export function lowConfidenceAnalysis(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: [],
    },
  } as unknown as AnalysisRecord;
}

/** Analysis payload shapes a corrupt/partial upstream could hand the coach.
 * Each is a concrete, named malformation so a failing seed is explainable. */
export const MALFORMED_ANALYSES = [
  'result_null_on_ready',
  'overall_nan',
  'overall_infinity',
  'overall_negative',
  'overall_over_ten',
  'overall_string',
  'checkpoints_empty',
  'checkpoints_nan_severity',
  'checkpoints_unknown_key',
  'checkpoints_score_out_of_range',
  'checkpoints_missing_applicable',
  'resultkind_unknown',
  'scored_without_overall',
] as const;
export type MalformedAnalysis = (typeof MALFORMED_ANALYSES)[number];

export function malformedAnalysis(kind: MalformedAnalysis): AnalysisRecord {
  const base = (
    overallScore: unknown,
    checkpoints: unknown,
    resultKind: unknown = 'scored',
  ): AnalysisRecord =>
    ({
      strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
      result: { resultKind, overallScore, checkpoints },
    }) as unknown as AnalysisRecord;
  const cp = (over: Partial<Record<string, unknown>>) => [
    {
      key: 'contact_position',
      score: 40,
      confidence: 0.9,
      band: 'yellow',
      direction: 'late',
      severity: 0.6,
      applicable: true,
      ...over,
    },
  ];
  switch (kind) {
    case 'result_null_on_ready':
      return {
        strokeResolution: { kind: 'unresolved' },
        result: null,
      } as unknown as AnalysisRecord;
    case 'overall_nan':
      return base(NaN, cp({}));
    case 'overall_infinity':
      return base(Infinity, cp({}));
    case 'overall_negative':
      return base(-3.2, cp({}));
    case 'overall_over_ten':
      return base(42, cp({}));
    case 'overall_string':
      return base('7.1', cp({}));
    case 'checkpoints_empty':
      return base(6.5, []);
    case 'checkpoints_nan_severity':
      return base(6.5, cp({ severity: NaN }));
    case 'checkpoints_unknown_key':
      return base(6.5, cp({ key: 'not_a_checkpoint' }));
    case 'checkpoints_score_out_of_range':
      return base(6.5, cp({ score: 1_000, severity: 0.9 }));
    case 'checkpoints_missing_applicable':
      return base(6.5, cp({ applicable: undefined }));
    case 'resultkind_unknown':
      return base(6.5, cp({}), 'mystery');
    case 'scored_without_overall':
      return base(null, cp({}));
  }
}

export function randomScoredAnalysis(rng: Rng): AnalysisRecord {
  const count = rng.int(0, 5);
  const checkpoints: CheckpointSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    checkpoints.push({
      key: rng.pick(CHECKPOINT_KEYS),
      score: rng.chance(0.15) ? null : rng.int(0, 100),
      direction: rng.pick(DIRECTIONS),
      severity: Math.round(rng.next() * 100) / 100,
      applicable: rng.chance(0.9),
    });
  }
  return scoredAnalysis(rng.int(0, 100) / 10, checkpoints);
}

export function eventView(
  index: number,
  partial: Partial<SessionEventView> = {},
): SessionEventView {
  return {
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: 'pending',
    pendingReason: null,
    abstainReason: null,
    analysis: null,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
    ...partial,
  };
}

export function snapshotOf(
  sessionId: string,
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId,
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-09-05T00:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'stress-engine-1',
    analysisProviderId: 'stress-provider',
    ...overrides,
  };
}

// ─── Assertions shared by the campaigns ─────────────────────────────────────

/** Text a coach speaks must never leak a runtime artifact. */
export const FORBIDDEN_TEXT_FRAGMENTS = [
  'NaN',
  'undefined',
  'null',
  'Infinity',
  '[object Object]',
] as const;

export function leaksRuntimeArtifact(text: string): string | null {
  for (const fragment of FORBIDDEN_TEXT_FRAGMENTS) {
    if (text.includes(fragment)) return fragment;
  }
  return null;
}

export function isFiniteOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Stable, canonical JSON for replayability comparisons (sorted keys). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[key] = (inner as Record<string, unknown>)[key];
      }
      return sorted;
    }
    if (typeof inner === 'number' && !Number.isFinite(inner)) {
      return `__nonfinite:${String(inner)}`;
    }
    return inner;
  });
}

// ─── Result table ───────────────────────────────────────────────────────────

export interface SeedOutcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  /** Executed scenario iterations inside this seed (events/strokes/payloads). */
  iterations: number;
  /** Distinct (dependency × mode) faults injected inside this seed. */
  faultsInjected: string[];
  violations: string[];
  detail?: Record<string, unknown>;
}

export interface CampaignTable {
  suite: string;
  commit: string | null;
  generatedAtIso: string;
  seeds: number;
  scenariosExecuted: number;
  distinctFaultsInjected: string[];
  held: number;
  broken: number;
  brokenSeeds: number[];
  /** violation class → occurrences across all seeds */
  violationClasses: Record<string, number>;
  results: SeedOutcome[];
}

export function buildTable(
  suite: string,
  results: SeedOutcome[],
): CampaignTable {
  const faults = new Set<string>();
  const classes = new Map<string, number>();
  for (const result of results) {
    for (const fault of result.faultsInjected) faults.add(fault);
    for (const violation of result.violations) {
      const cls = violationClass(violation);
      classes.set(cls, (classes.get(cls) ?? 0) + 1);
    }
  }
  return {
    suite,
    commit: process.env.STRESS_COMMIT ?? null,
    generatedAtIso: new Date().toISOString(),
    seeds: results.length,
    scenariosExecuted: results.reduce((sum, r) => sum + r.iterations, 0),
    distinctFaultsInjected: [...faults].sort(),
    held: results.filter(r => r.outcome === 'HELD').length,
    broken: results.filter(r => r.outcome === 'BROKEN').length,
    brokenSeeds: results.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    violationClasses: Object.fromEntries([...classes.entries()].sort()),
    results,
  };
}

// ─── Known-BROKEN bookkeeping ───────────────────────────────────────────────
//
// A campaign that reproduces a production defect must stay red for THAT
// defect without hiding anything else and without masking every other
// invariant in the seed. Each suite therefore declares the violation classes
// it has already reduced to a finding (KNOWN_BROKEN). `assertSeedOutcome`
// fails a seed on any violation class outside that list, and
// `assertKnownBrokenStillReproduce` fails the campaign the day a known class
// stops reproducing — the signal to delete the entry and close the finding.
// Nothing is filtered out of the JSON table: BROKEN seeds stay BROKEN.

/** `stroke=3 I3:duplicate_repIndex_in_allReps(6,20) faults=…` → `I3:duplicate_repIndex_in_allReps` */
export function violationClass(violation: string): string {
  const match = /([A-Z][0-9]+:[A-Za-z0-9_]+)/.exec(violation);
  return match ? match[1]! : violation.split(/[\s(]/)[0]!;
}

export interface KnownBroken {
  /** Finding id used in the report (e.g. `LC-1`). */
  finding: string;
  violationClass: string;
  /** One line of what the production code does today. */
  observed: string;
}

export function assertSeedOutcome(
  suite: string,
  outcome: SeedOutcome,
  knownBroken: readonly KnownBroken[],
  replayHint = `STRESS_SEED=${outcome.seed} npx jest --ci ${suite}`,
): void {
  const known = new Set(knownBroken.map(k => k.violationClass));
  const unexpected = outcome.violations.filter(
    v => !known.has(violationClass(v)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `STRESS FAILURE ${suite} seed=${outcome.seed} (replay: ${replayHint})\n` +
        `${unexpected.length} violation(s) outside KNOWN_BROKEN ` +
        `[${[...known].join(', ') || 'none'}]:\n` +
        unexpected.slice(0, 40).join('\n') +
        (unexpected.length > 40 ? `\n… ${unexpected.length - 40} more` : ''),
    );
  }
}

export function assertKnownBrokenStillReproduce(
  suite: string,
  outcomes: readonly SeedOutcome[],
  knownBroken: readonly KnownBroken[],
): void {
  const seen = new Set(outcomes.flatMap(o => o.violations.map(violationClass)));
  const gone = knownBroken.filter(k => !seen.has(k.violationClass));
  if (gone.length > 0) {
    throw new Error(
      `${suite}: known-BROKEN class(es) no longer reproduce — production behaviour changed. ` +
        `Delete the entry from KNOWN_BROKEN and close the finding:\n` +
        gone
          .map(k => `  ${k.finding} ${k.violationClass} — was: ${k.observed}`)
          .join('\n'),
    );
  }
}
