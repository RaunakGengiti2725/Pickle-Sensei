/**
 * STRESS SUPPORT — unit `mod-session-flow`, lens `randomized-seeded`.
 *
 * Seeded generator + executor + invariant model for the session flow public
 * API: `LiveSessionFlow` (src/flow/session.ts), the native bridge seams in
 * src/flow/sessionNative.ts (`connectNativeSessionMotionFeed`, clip source /
 * analysis provider contracts) and `sessionScoreProgression`
 * (src/flow/sessionProgress.ts).
 *
 * Every sequence is a JSON-serialisable list of fully parameterised actions
 * derived from ONE seed, so a failing seed replays from the seed alone and a
 * failing action list can be ddmin-shrunk without losing determinism.
 *
 * ORACLES
 *  - A REFERENCE `LiveSessionFlow` (pending-stub provider) is fed exactly the
 *    pushes the native-feed contract says the SUT flow must receive; event
 *    structure (ids, bounds, close reasons, closure times), `droppedLateSamples`
 *    and quality notes must be identical.
 *  - A per-event lifecycle model derived from the provider/clip-source
 *    contracts documented in src/flow/session.ts (dispatchAnalysis) predicts
 *    the state / pendingReason / abstainReason / analysis every event must
 *    show after each settle.
 *  - An independent re-fold of the score progression rules documented in
 *    src/flow/sessionProgress.ts, plus monotonicity across steps.
 *
 * INVARIANTS (checked after EVERY step, ids referenced from the JSON table)
 *  INV-01  phase: `ended()` mirrors snapshot.phase; once ended, stays ended.
 *  INV-02  events append-only: ids E1..En in order, index = position, count
 *          never decreases, frozen proposal fields never change.
 *  INV-03  event bounds: startMs ≤ peakMs ≤ endMs ≤ closedAtMs, and every
 *          later event's peak lies past every earlier event's end (frontier).
 *  INV-04  durationMs = max(0, max finite tMs pushed) and is non-decreasing.
 *          INV-04c (SOFT unless STRICT): a non-finite tMs pushed through
 *          pushSample must not poison durationMs (the engine drops the sample).
 *  INV-05  droppedLateSamples equals the model's count of finite pushes at or
 *          before the frontier, and equals the reference flow's count.
 *  INV-06  reference structural equality (events, droppedLate, notes).
 *  INV-07  native feed: droppedInvalidSamples per feed equals the model's
 *          count of motion-typed-but-invalid payloads seen while connected;
 *          foreign captureIds / non-motion payloads are silently ignored; a
 *          post-end emission disconnects the feed without throwing.
 *  INV-08  end() idempotent: second end() returns an equal snapshot, dispatches
 *          nothing, creates no deferred work.
 *  INV-09  registry: after end, getCompletedSession(id) equals snapshot().
 *          INV-09b (SOFT unless STRICT): including `onUpdateFailures` (the
 *          registry is written BEFORE the subscriber runs in notify(), so it
 *          lags by one exactly when the latest onUpdate threw).
 *  INV-10  per-event lifecycle matches the contract model (state,
 *          pendingReason, abstainReason, analysis identity, terminal states
 *          never rewritten, `ready` ⇒ analysis, `abstained` ⇒ reason).
 *  INV-11  provider seam: analyzeEvent called at most once per event, only
 *          after a successful extraction, with the frozen proposal, the
 *          event's sessionId/eventId/closeReason/closedAtMs, declaredStroke
 *          null and the exact clip returned by the clip source (null without
 *          a clip source); extract called at most once per event.
 *  INV-12  onUpdateFailures equals the number of subscriber throws; a
 *          throwing subscriber never changes event outcomes (via INV-10).
 *  INV-13  pushSample after end throws the documented error and changes
 *          nothing.
 *  INV-14  view helpers: timelineSegments one per event with fractions in
 *          [0,1]; techniqueDistribution counts sum to strokeCount;
 *          formatSessionClock is m:ss; captureModePillLabel by source.
 *  INV-15  progression = independent re-fold; bucket counts partition the
 *          events (modulo contract-violating views, none generated here);
 *          points strictly index-ordered; order-independent under shuffle.
 *  INV-16  progression MONOTONE across steps: pendingCount never grows by
 *          more than the events emitted in the step; scoredCount and
 *          noReadCount never decrease; an existing point is never removed or
 *          changed.
 *  INV-17  settled(): with no hanging work, no event is left 'processing'.
 *  INV-18  determinism: generate + run the same seed twice → identical trace
 *          (checked by the suite, recorded per row).
 */
import type {
  CapturedClip,
  PoseSequenceSidecarRef,
} from '../../src/camera/capture';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { SessionStrokeEvent } from '@pickle/analysis-pipeline';
import {
  LiveSessionFlow,
  SESSION_MOTION_SAMPLE_EVENT_TYPE,
  captureModePillLabel,
  createPendingStubAnalysisProvider,
  formatSessionClock,
  getCompletedSession,
  techniqueDistribution,
  timelineSegments,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventAnalysisRequest,
  type SessionEventClipExtraction,
  type SessionEventClipSource,
  type SessionEventView,
} from '../../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  type SessionMotionFeedConnection,
} from '../../src/flow/sessionNative';
import {
  sessionScoreProgression,
  type SessionScoreProgression,
} from '../../src/flow/sessionProgress';
import fixture from '../../__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json';

// ─── seeded RNG ─────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi < lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const weight of weights) total += weight;
    let roll = this.next() * total;
    for (let index = 0; index < items.length; index += 1) {
      roll -= weights[index] ?? 0;
      if (roll < 0) return items[index]!;
    }
    return items[items.length - 1]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}

/** Stable per-iteration seed: mixes the campaign seed with the index. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string — cheap trace fingerprint for determinism checks. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ─── action vocabulary (JSON-serialisable, fully parameterised) ─────────────

/** Non-finite numbers cannot round-trip through JSON; encode them by name. */
export type NumberSpec = number | 'nan' | 'inf' | 'ninf';

export function decodeNumber(spec: NumberSpec): number {
  if (spec === 'nan') return Number.NaN;
  if (spec === 'inf') return Number.POSITIVE_INFINITY;
  if (spec === 'ninf') return Number.NEGATIVE_INFINITY;
  return spec;
}

export type MalformedVariant =
  | 'neg_tMs'
  | 'nan_tMs'
  | 'inf_tMs'
  | 'str_tMs'
  | 'missing_tMs'
  | 'neg_v'
  | 'inf_v'
  | 'nan_v'
  | 'str_v'
  | 'missing_v'
  | 'null_v'
  | 'captureId_number'
  | 'captureId_null'
  | 'emittedAtIso_number';

export type NoiseVariant =
  | 'other_type'
  | 'no_type'
  | 'null'
  | 'string'
  | 'number'
  | 'array'
  | 'sample_shaped_wrong_type';

export type SettleKind =
  | 'ready_scored'
  | 'ready_low_confidence'
  | 'ready_resultless'
  | 'abstained'
  | 'pending'
  | 'reject'
  | 'hang';

export type Action =
  | { kind: 'push'; samples: Array<{ tMs: number; v: number }> }
  | { kind: 'pushNonFinite'; tMs: NumberSpec; v: NumberSpec }
  | {
      kind: 'nativeValid';
      tMs: number;
      v: number;
      captureId: 'own' | 'foreign' | 'none';
    }
  | { kind: 'nativeMalformed'; variant: MalformedVariant }
  | { kind: 'nativeNoise'; variant: NoiseVariant }
  | { kind: 'connectFeed'; filterByCaptureId: boolean }
  | { kind: 'disconnectFeed'; pick: number }
  | { kind: 'end' }
  | { kind: 'settle'; pick: number; outcome: SettleKind; score: number }
  | { kind: 'setOnUpdateThrow'; count: number }
  | { kind: 'setAvailability'; available: boolean }
  | { kind: 'setSyncThrow'; analyze: boolean; extract: boolean }
  | { kind: 'awaitSettled' }
  | { kind: 'tick' };

export interface SequenceConfig {
  /** `progression` biases toward many closed, scored events so the score
   * progression window rules (1/2/3) are exercised through the live flow. */
  profile: 'mixed' | 'progression';
  source: 'live' | 'replay';
  withClipSource: boolean;
  withOnUpdate: boolean;
  initiallyAvailable: boolean;
  startedAtIso: string | null;
}

export interface GeneratedSequence {
  seed: number;
  config: SequenceConfig;
  actions: Action[];
}

const FIXTURE_SAMPLES: ReadonlyArray<{ tMs: number; v: number }> =
  fixture.wristSamples;

const MALFORMED: readonly MalformedVariant[] = [
  'neg_tMs',
  'nan_tMs',
  'inf_tMs',
  'str_tMs',
  'missing_tMs',
  'neg_v',
  'inf_v',
  'nan_v',
  'str_v',
  'missing_v',
  'null_v',
  'captureId_number',
  'captureId_null',
  'emittedAtIso_number',
];
const NOISE: readonly NoiseVariant[] = [
  'other_type',
  'no_type',
  'null',
  'string',
  'number',
  'array',
  'sample_shaped_wrong_type',
];
const SETTLE_KINDS: readonly SettleKind[] = [
  'ready_scored',
  'ready_low_confidence',
  'ready_resultless',
  'abstained',
  'pending',
  'reject',
  'hang',
];
const SETTLE_WEIGHTS: readonly number[] = [40, 10, 6, 14, 12, 12, 6];
const PROGRESSION_SETTLE_WEIGHTS: readonly number[] = [82, 5, 3, 4, 3, 2, 1];

/** Synthetic wrist-speed series: quiet baseline with stroke-shaped bursts,
 * jittered cadence, occasional gaps, out-of-order and duplicate timestamps.
 * Used ONLY to drive the state machine — no claim about CV quality. */
class SeriesGen {
  cursorMs: number;
  private strokeLeft = 0;
  private strokeLen = 0;
  private strokeAmp = 0;

  constructor(
    private readonly rng: Rng,
    startMs: number,
  ) {
    this.cursorMs = startMs;
  }

  burst(count: number): Array<{ tMs: number; v: number }> {
    const out: Array<{ tMs: number; v: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const roll = this.rng.float();
      if (roll < 0.06) {
        // Out-of-order sample: behind the cursor, maybe behind the frontier.
        out.push({
          tMs: Math.max(0, this.cursorMs - this.rng.int(1, 700)),
          v: this.value(),
        });
        continue;
      }
      if (roll < 0.09) {
        // Duplicate timestamp.
        out.push({ tMs: this.cursorMs, v: this.value() });
        continue;
      }
      const dt = this.rng.weighted(
        [33, this.rng.int(16, 60), this.rng.int(200, 900)],
        [70, 20, 10],
      );
      this.cursorMs += dt;
      out.push({ tMs: this.cursorMs, v: this.value() });
    }
    return out;
  }

  fixtureSlice(): Array<{ tMs: number; v: number }> {
    const start = this.rng.int(0, FIXTURE_SAMPLES.length - 8);
    const length = this.rng.int(
      6,
      Math.min(32, FIXTURE_SAMPLES.length - start),
    );
    const slice = FIXTURE_SAMPLES.slice(start, start + length);
    const first = slice[0]!.tMs;
    const base = this.cursorMs + 33;
    const out = slice.map(sample => ({
      tMs: base + (sample.tMs - first),
      v: sample.v,
    }));
    this.cursorMs = out[out.length - 1]!.tMs;
    return out;
  }

  private value(): number {
    if (this.strokeLeft > 0) {
      const k = this.strokeLen - this.strokeLeft;
      this.strokeLeft -= 1;
      const shape = Math.sin((Math.PI * (k + 0.5)) / this.strokeLen);
      return Math.max(
        0,
        this.strokeAmp * shape + (this.rng.float() - 0.5) * 0.1,
      );
    }
    if (this.rng.chance(0.1)) {
      this.strokeLen = this.rng.int(6, 14);
      this.strokeLeft = this.strokeLen;
      this.strokeAmp = 0.7 + this.rng.float() * 3.8;
    }
    const extreme = this.rng.float();
    if (extreme < 0.015) return 0;
    if (extreme < 0.022) return 10_000;
    return 0.02 + this.rng.float() * 0.33;
  }
}

/** Sequence length 5..60; action mix weighted toward pushes so events close. */
export function generateSequence(seed: number): GeneratedSequence {
  const rng = new Rng(seed);
  const profile: SequenceConfig['profile'] = rng.chance(0.4)
    ? 'progression'
    : 'mixed';
  const config: SequenceConfig = {
    profile,
    source: rng.chance(0.7) ? 'live' : 'replay',
    withClipSource: rng.chance(0.55),
    withOnUpdate: rng.chance(0.75),
    initiallyAvailable: profile === 'progression' || rng.chance(0.85),
    startedAtIso: rng.chance(0.8) ? '2026-09-05T02:00:00.000Z' : null,
  };
  const length = profile === 'progression' ? rng.int(20, 60) : rng.int(5, 60);
  const progression = profile === 'progression';
  const series = new SeriesGen(rng, rng.chance(0.85) ? 0 : rng.int(1, 5000));
  const actions: Action[] = [];
  let ended = false;
  let feeds = 0;
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted(
      [
        'push',
        'pushNonFinite',
        'nativeValid',
        'nativeMalformed',
        'nativeNoise',
        'connectFeed',
        'disconnectFeed',
        'end',
        'settle',
        'setOnUpdateThrow',
        'setAvailability',
        'setSyncThrow',
        'awaitSettled',
        'tick',
      ] as const,
      ended
        ? [10, 2, 10, 4, 3, 2, 2, 4, 30, 4, 2, 2, 10, 6]
        : progression
          ? [30, 0, 4, 1, 1, 1, 0.5, 1, 40, 1, 0, 0.5, 2, 1]
          : [34, 1.5, 14, 4, 2, feeds === 0 ? 8 : 3, 2, 4, 16, 3, 2, 2, 4, 3],
    );
    switch (kind) {
      case 'push': {
        const samples = rng.chance(progression ? 0.75 : 0.3)
          ? series.fixtureSlice()
          : series.burst(rng.int(1, 16));
        actions.push({ kind, samples });
        break;
      }
      case 'pushNonFinite': {
        const specs: readonly NumberSpec[] = ['nan', 'inf', 'ninf'];
        const which = rng.int(0, 2);
        actions.push({
          kind,
          tMs: which === 0 ? series.cursorMs + 33 : rng.pick(specs),
          v: which === 1 ? 0.5 : rng.pick(specs),
        });
        break;
      }
      case 'nativeValid': {
        const [sample] = series.burst(1);
        actions.push({
          kind,
          tMs: sample!.tMs,
          v: sample!.v,
          captureId: rng.weighted(
            ['own', 'foreign', 'none'] as const,
            [70, 20, 10],
          ),
        });
        break;
      }
      case 'nativeMalformed':
        actions.push({ kind, variant: rng.pick(MALFORMED) });
        break;
      case 'nativeNoise':
        actions.push({ kind, variant: rng.pick(NOISE) });
        break;
      case 'connectFeed':
        feeds += 1;
        actions.push({ kind, filterByCaptureId: rng.chance(0.8) });
        break;
      case 'disconnectFeed':
        actions.push({ kind, pick: rng.int(0, 7) });
        break;
      case 'end':
        ended = true;
        actions.push({ kind });
        break;
      case 'settle':
        actions.push({
          kind,
          pick: rng.int(0, 15),
          outcome: rng.weighted(
            SETTLE_KINDS,
            progression ? PROGRESSION_SETTLE_WEIGHTS : SETTLE_WEIGHTS,
          ),
          score: Math.round(rng.float() * 100) / 10,
        });
        break;
      case 'setOnUpdateThrow':
        actions.push({ kind, count: rng.int(1, 4) });
        break;
      case 'setAvailability':
        actions.push({ kind, available: rng.chance(0.5) });
        break;
      case 'setSyncThrow':
        actions.push({
          kind,
          analyze: rng.chance(0.5),
          extract: rng.chance(0.5),
        });
        break;
      case 'awaitSettled':
      case 'tick':
        actions.push({ kind });
        break;
    }
  }
  return { seed, config, actions };
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'push':
      return `push[${action.samples.length}] ${action.samples
        .slice(0, 3)
        .map(s => `${s.tMs}:${s.v.toFixed(2)}`)
        .join(',')}${action.samples.length > 3 ? ',…' : ''}`;
    case 'pushNonFinite':
      return `pushNonFinite tMs=${action.tMs} v=${action.v}`;
    case 'nativeValid':
      return `nativeValid ${action.tMs}:${action.v.toFixed(2)} cid=${action.captureId}`;
    case 'nativeMalformed':
      return `nativeMalformed ${action.variant}`;
    case 'nativeNoise':
      return `nativeNoise ${action.variant}`;
    case 'connectFeed':
      return `connectFeed filter=${action.filterByCaptureId}`;
    case 'disconnectFeed':
      return `disconnectFeed pick=${action.pick}`;
    case 'settle':
      return `settle pick=${action.pick} ${action.outcome} score=${action.score}`;
    case 'setOnUpdateThrow':
      return `setOnUpdateThrow ${action.count}`;
    case 'setAvailability':
      return `setAvailability ${action.available}`;
    case 'setSyncThrow':
      return `setSyncThrow analyze=${action.analyze} extract=${action.extract}`;
    default:
      return action.kind;
  }
}

// ─── SUT doubles: scripted provider / clip source / native emitter ──────────

export interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

type Deferred =
  | {
      id: number;
      kind: 'analyze';
      eventId: string;
      request: SessionEventAnalysisRequest;
      resolve: (value: SessionEventAnalysisOutcome) => void;
      reject: (error: Error) => void;
      hanging: boolean;
    }
  | {
      id: number;
      kind: 'extract';
      eventId: string;
      resolve: (value: SessionEventClipExtraction) => void;
      reject: (error: Error) => void;
      hanging: boolean;
    };

/** Expected per-event lifecycle derived from the contract in session.ts. */
interface EventExpectation {
  state: 'pending' | 'processing' | 'ready' | 'abstained';
  pendingReason: string | null;
  abstainReason: string | null;
  analysis: AnalysisRecord | null;
  /** Clip the provider must receive (null without a clip source). */
  clip: CapturedClip | null;
  poseSequenceSlice: PoseSequenceSidecarRef | null;
  dispatchedAvailable: boolean;
}

const CAPTURE_ID = 'stress-capture';
const FOREIGN_CAPTURE_ID = 'stale-capture-from-previous-session';
const UNAVAILABLE_REASON = 'STRESS_PROVIDER_UNAVAILABLE: scripted build gap';
const SYNC_THROW_ANALYZE = 'stress analyze sync throw';
const SYNC_THROW_EXTRACT = 'stress extract sync throw';

/** Minimal AnalysisRecord STATE-MACHINE DOUBLE (the seam is under test, not
 * the pipeline). `result` carries only the fields sessionProgress reads. */
function analysisRecordDouble(
  eventId: string,
  kind: 'scored' | 'low_confidence' | 'resultless',
  score: number,
): AnalysisRecord {
  const result =
    kind === 'resultless'
      ? null
      : ({
          id: `analysis-${eventId}`,
          resultKind: kind,
          overallScore: kind === 'scored' ? score : null,
        } as unknown as ShotAnalysis);
  return {
    schemaVersion: 1,
    id: `record-${eventId}`,
    captureId: `capture-${eventId}`,
    createdAtIso: '2026-09-05T02:00:00.000Z',
    engineVersion: 'stress-double',
    strokeTaxonomyVersion: 'stress-double',
    strokeResolution: { kind: 'unresolved', reason: 'stress double' },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'stress-double',
      pipelineVersion: 'stress-double',
      providerVersions: [],
      scoreVersion: 'stress-double',
      taxonomyVersion: 'stress-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-09-05T02:00:00.000Z',
    },
    result,
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['STRESS_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

function clipDouble(eventId: string): {
  clip: CapturedClip;
  poseSequenceSlice: PoseSequenceSidecarRef;
} {
  const poseSequenceSlice = {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: `file:///stress/${eventId}.pose.json`,
    frameCount: 6,
    sha256: 'b'.repeat(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'stress-double',
  } as unknown as PoseSequenceSidecarRef;
  // The flow never inspects the clip; it must only hand it through verbatim.
  const clip = {
    uri: `file:///stress/${eventId}.mov`,
    captureMode: 'automatic_pose_trigger',
    poseSequence: poseSequenceSlice,
  } as unknown as CapturedClip;
  return { clip, poseSequenceSlice };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Independent re-statement of the frozen native payload contract. */
function modelValidMotionPayload(value: unknown): value is {
  tMs: number;
  v: number;
  captureId?: string;
} {
  if (!isRecord(value)) return false;
  if (value.type !== SESSION_MOTION_SAMPLE_EVENT_TYPE) return false;
  const { tMs, v, captureId, emittedAtIso } = value;
  if (typeof tMs !== 'number' || !Number.isFinite(tMs) || tMs < 0) return false;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  if (captureId !== undefined && typeof captureId !== 'string') return false;
  if (emittedAtIso !== undefined && typeof emittedAtIso !== 'string')
    return false;
  return true;
}

function malformedPayload(
  variant: MalformedVariant,
  tMs: number,
  v: number,
): unknown {
  const base: Record<string, unknown> = {
    type: SESSION_MOTION_SAMPLE_EVENT_TYPE,
    tMs,
    v,
    captureId: CAPTURE_ID,
    emittedAtIso: '2026-09-05T02:00:00.000Z',
  };
  switch (variant) {
    case 'neg_tMs':
      base.tMs = -1;
      break;
    case 'nan_tMs':
      base.tMs = Number.NaN;
      break;
    case 'inf_tMs':
      base.tMs = Number.POSITIVE_INFINITY;
      break;
    case 'str_tMs':
      base.tMs = String(tMs);
      break;
    case 'missing_tMs':
      delete base.tMs;
      break;
    case 'neg_v':
      base.v = -0.01;
      break;
    case 'inf_v':
      base.v = Number.POSITIVE_INFINITY;
      break;
    case 'nan_v':
      base.v = Number.NaN;
      break;
    case 'str_v':
      base.v = '1.2';
      break;
    case 'missing_v':
      delete base.v;
      break;
    case 'null_v':
      base.v = null;
      break;
    case 'captureId_number':
      base.captureId = 42;
      break;
    case 'captureId_null':
      base.captureId = null;
      break;
    case 'emittedAtIso_number':
      base.emittedAtIso = 1_700_000_000;
      break;
  }
  return base;
}

function noisePayload(variant: NoiseVariant, tMs: number, v: number): unknown {
  switch (variant) {
    case 'other_type':
      return { type: 'capture_progress', framesTotal: 12, tMs, v };
    case 'no_type':
      return { tMs, v, captureId: CAPTURE_ID };
    case 'null':
      return null;
    case 'string':
      return SESSION_MOTION_SAMPLE_EVENT_TYPE;
    case 'number':
      return tMs;
    case 'array':
      return [SESSION_MOTION_SAMPLE_EVENT_TYPE, tMs, v];
    case 'sample_shaped_wrong_type':
      return { type: 'session_motion_samples', tMs, v, captureId: CAPTURE_ID };
  }
}

// ─── executor ───────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Delivers a raw payload to every registered native camera listener. */
  emitNative: (payload: unknown) => void;
  /** Whether the SOFT invariants (INV-04c, INV-09b) count as violations. */
  strict?: boolean;
  checkInvariants?: boolean;
}

export interface RunResult {
  trace: string[];
  traceHash: string;
  violations: Violation[];
  observations: Violation[];
  steps: number;
  events: number;
  pushes: number;
  scoredPoints: number;
  hangs: number;
}

interface FeedModel {
  handle: SessionMotionFeedConnection;
  connected: boolean;
  filterCaptureId: string | undefined;
  droppedInvalid: number;
}

function structural(view: SessionEventView) {
  return {
    eventId: view.eventId,
    index: view.index,
    startMs: view.startMs,
    endMs: view.endMs,
    peakMs: view.peakMs,
    peakSpeed: view.peakSpeed,
    paddleConfirmed: view.paddleConfirmed,
    closeReason: view.closeReason,
    closedAtMs: view.closedAtMs,
  };
}

/** Independent re-fold of the documented progression rules. */
export function referenceProgression(
  events: readonly SessionEventView[],
): SessionScoreProgression {
  const points: SessionScoreProgression['points'] = [];
  let noReadCount = 0;
  let pendingCount = 0;
  const ordered = [...events].sort((a, b) => a.index - b.index);
  for (const event of ordered) {
    if (event.state === 'pending' || event.state === 'processing') {
      pendingCount += 1;
    } else if (event.state === 'abstained') {
      noReadCount += 1;
    } else if (event.analysis === null) {
      // 'ready' without a record: contract violation, no bucket.
    } else if (
      event.analysis.result === null ||
      event.analysis.result.resultKind === 'low_confidence'
    ) {
      noReadCount += 1;
    } else if (event.analysis.result.overallScore !== null) {
      points.push({
        eventId: event.eventId,
        eventIndex: event.index,
        endMs: event.endMs,
        score: event.analysis.result.overallScore,
      });
    }
  }
  const n = points.length;
  const windowSize = n >= 6 ? 3 : n >= 4 ? 2 : 1;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const mean = (xs: readonly { score: number }[]) =>
    xs.reduce((sum, p) => sum + p.score, 0) / xs.length;
  const startAverage =
    n === 0 ? null : round1(mean(points.slice(0, windowSize)));
  const endAverage = n === 0 ? null : round1(mean(points.slice(-windowSize)));
  const delta =
    n >= 2 && startAverage !== null && endAverage !== null
      ? round1(endAverage - startAverage)
      : null;
  let best: SessionScoreProgression['best'] = null;
  for (const point of points)
    if (best === null || point.score > best.score) best = point;
  return {
    points,
    scoredCount: n,
    noReadCount,
    pendingCount,
    startAverage,
    endAverage,
    delta,
    best,
    windowSize,
  };
}

const flushAsync = () =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

export async function runSequence(
  sequence: GeneratedSequence,
  options: RunOptions,
): Promise<RunResult> {
  const { seed, config, actions } = sequence;
  const strict = options.strict ?? false;
  const check = options.checkInvariants ?? true;
  const trace: string[] = [];
  const violations: Violation[] = [];
  const observations: Violation[] = [];
  const sessionId = `stress-session-${seed}`;
  const rng = new Rng(seed ^ 0x5bd1e995);

  let deferredIds = 0;
  const outstanding: Deferred[] = [];
  const expectations = new Map<string, EventExpectation>();
  // Seam calls happen synchronously inside pushSample()/end(), i.e. before
  // the model has seen the new event, so they are counted independently.
  const extractCalls = new Map<string, number>();
  const analyzeCalls = new Map<string, number>();
  const bump = (map: Map<string, number>, eventId: string) =>
    map.set(eventId, (map.get(eventId) ?? 0) + 1);
  let providerAvailable = config.initiallyAvailable;
  let analyzeSyncThrow = false;
  let extractSyncThrow = false;
  let onUpdateThrowsLeft = 0;
  let onUpdateThrows = 0;
  let lastNotifyThrew = false;
  let onUpdateCalls = 0;
  let analyzeCallsTotal = 0;

  const provider: SessionEventAnalysisProvider = {
    providerId: 'stress-scripted-provider',
    availability() {
      return providerAvailable
        ? { status: 'available' }
        : { status: 'unavailable', pendingReason: UNAVAILABLE_REASON };
    },
    analyzeEvent(request) {
      analyzeCallsTotal += 1;
      bump(analyzeCalls, request.eventId);
      if (analyzeSyncThrow) throw new Error(SYNC_THROW_ANALYZE);
      return new Promise<SessionEventAnalysisOutcome>((resolve, reject) => {
        deferredIds += 1;
        outstanding.push({
          id: deferredIds,
          kind: 'analyze',
          eventId: request.eventId,
          request,
          resolve,
          reject,
          hanging: false,
        });
      });
    },
  };

  const clipSource: SessionEventClipSource | undefined = config.withClipSource
    ? {
        sourceId: 'stress-scripted-clip-source',
        extract(event: SessionStrokeEvent) {
          bump(extractCalls, event.eventId);
          if (extractSyncThrow) throw new Error(SYNC_THROW_EXTRACT);
          return new Promise<SessionEventClipExtraction>((resolve, reject) => {
            deferredIds += 1;
            outstanding.push({
              id: deferredIds,
              kind: 'extract',
              eventId: event.eventId,
              resolve,
              reject,
              hanging: false,
            });
          });
        },
      }
    : undefined;

  const onUpdate = config.withOnUpdate
    ? (_snapshot: LiveSessionSnapshot) => {
        onUpdateCalls += 1;
        if (onUpdateThrowsLeft > 0) {
          onUpdateThrowsLeft -= 1;
          onUpdateThrows += 1;
          lastNotifyThrew = true;
          throw new Error('stress onUpdate subscriber throw');
        }
        lastNotifyThrew = false;
      }
    : undefined;

  const flow = new LiveSessionFlow({
    sessionId,
    source: config.source,
    provider,
    ...(clipSource ? { clipSource } : {}),
    ...(config.startedAtIso ? { startedAtIso: config.startedAtIso } : {}),
    ...(onUpdate ? { onUpdate } : {}),
  });
  const reference = new LiveSessionFlow({
    sessionId: `${sessionId}-reference`,
    source: config.source,
    provider: createPendingStubAnalysisProvider(),
  });

  // Model state.
  const feeds: FeedModel[] = [];
  let modelEnded = false;
  let modelDroppedLate = 0;
  let modelDurationMs = 0;
  let nonFiniteTmsPushed = false;
  let pushes = 0;
  let frontierMs = Number.NEGATIVE_INFINITY;
  let previousStructural: ReturnType<typeof structural>[] = [];
  let previousStates = new Map<string, SessionEventView['state']>();
  let previousProgression: SessionScoreProgression | null = null;
  let previousDuration = 0;
  let hangs = 0;
  let stepIndex = 0;
  let currentAction = 'init';

  const fail = (invariant: string, detail: string, soft = false) => {
    const violation: Violation = {
      invariant,
      step: stepIndex,
      action: currentAction,
      detail,
    };
    if (soft && !strict) observations.push(violation);
    else violations.push(violation);
  };

  /** One push into the SUT-equivalent reference plus the late/duration model. */
  const modelPush = (tMs: number, v: number) => {
    pushes += 1;
    if (Number.isFinite(tMs)) modelDurationMs = Math.max(modelDurationMs, tMs);
    else nonFiniteTmsPushed = true;
    if (Number.isFinite(tMs) && Number.isFinite(v) && tMs <= frontierMs) {
      modelDroppedLate += 1;
    }
    const closed = reference.pushSample({ tMs, v });
    for (const event of closed) {
      frontierMs = Math.max(frontierMs, event.proposal.endMs);
    }
  };

  const directPush = (tMs: number, v: number): void => {
    if (modelEnded) {
      const before = JSON.stringify(flow.snapshot());
      let threw: string | null = null;
      try {
        flow.pushSample({ tMs, v });
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }
      if (threw === null) {
        fail(
          'INV-13-push-after-end-throws',
          'pushSample after end() did not throw',
        );
      } else if (!/already ended/.test(threw)) {
        fail(
          'INV-13-push-after-end-throws',
          `unexpected error message: ${threw}`,
        );
      }
      if (JSON.stringify(flow.snapshot()) !== before) {
        fail(
          'INV-13-push-after-end-throws',
          'snapshot changed after a rejected push',
        );
      }
      return;
    }
    modelPush(tMs, v);
    flow.pushSample({ tMs, v });
  };

  const emitNativeModelled = (payload: unknown) => {
    const motionTyped =
      isRecord(payload) && payload.type === SESSION_MOTION_SAMPLE_EVENT_TYPE;
    const valid = modelValidMotionPayload(payload);
    // The SUT is driven FIRST so the model can observe the same ordering the
    // listener registry delivers (connection order, self-disconnects).
    // Predict, then act, then compare.
    const expectedPushes: Array<{ tMs: number; v: number }> = [];
    for (const feed of feeds) {
      if (!feed.connected) continue;
      if (motionTyped && !valid) {
        feed.droppedInvalid += 1;
        continue;
      }
      if (!valid) continue;
      if (
        feed.filterCaptureId !== undefined &&
        payload.captureId !== undefined &&
        payload.captureId !== feed.filterCaptureId
      ) {
        continue;
      }
      if (modelEnded) {
        feed.connected = false;
        continue;
      }
      expectedPushes.push({ tMs: payload.tMs, v: payload.v });
    }
    for (const sample of expectedPushes) modelPush(sample.tMs, sample.v);
    let threw: string | null = null;
    try {
      options.emitNative(payload);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    if (threw !== null) {
      fail(
        'INV-07-native-feed',
        `native emission threw into the bridge: ${threw}`,
      );
    }
  };

  const onEventsEmitted = (views: readonly SessionEventView[]) => {
    for (const view of views) {
      if (expectations.has(view.eventId)) continue;
      const available = providerAvailable;
      expectations.set(view.eventId, {
        state: available ? 'processing' : 'pending',
        pendingReason: available ? null : UNAVAILABLE_REASON,
        abstainReason: null,
        analysis: null,
        clip: null,
        poseSequenceSlice: null,
        dispatchedAvailable: available,
      });
    }
  };

  /** Refresh expectations for sync-throw paths that resolve without a settle. */
  const applySyncThrowExpectations = () => {
    for (const [eventId, expectation] of expectations) {
      if (!expectation.dispatchedAvailable) continue;
      if (expectation.state !== 'processing') continue;
      const hasDeferred = outstanding.some(d => d.eventId === eventId);
      if (hasDeferred) continue;
      // No deferred exists for a processing event: a sync throw must have
      // short-circuited the chain. Which one is decided by the call counts.
      const extracts = extractCalls.get(eventId) ?? 0;
      const analyzes = analyzeCalls.get(eventId) ?? 0;
      if (clipSource && extracts === 1 && analyzes === 0) {
        expectation.state = 'pending';
        expectation.pendingReason = `SESSION_CLIP_EXTRACTION_FAILED: ${SYNC_THROW_EXTRACT}`;
      } else if (analyzes === 1) {
        expectation.state = 'abstained';
        expectation.abstainReason = `ANALYSIS_DISPATCH_FAILED: ${SYNC_THROW_ANALYZE}`;
      }
    }
  };

  /** Callers flush microtasks first so the dispatch chain has progressed
   * to a stable point before the model is compared. */
  const checkAll = async (newEventsAllowed: boolean) => {
    if (!check) {
      const snapshot = flow.snapshot();
      onEventsEmitted(snapshot.events);
      applySyncThrowExpectations();
      return snapshot;
    }
    const snapshot = flow.snapshot();
    const refSnapshot = reference.snapshot();
    onEventsEmitted(snapshot.events);
    applySyncThrowExpectations();

    // INV-01
    if ((snapshot.phase === 'ended') !== flow.ended()) {
      fail(
        'INV-01-phase',
        `ended()=${flow.ended()} but phase=${snapshot.phase}`,
      );
    }
    if (modelEnded && snapshot.phase !== 'ended') {
      fail('INV-01-phase', 'flow reverted from ended to running');
    }
    if (!modelEnded && snapshot.phase !== 'running') {
      fail('INV-01-phase', 'flow ended without end() being called');
    }
    if (snapshot.sessionId !== sessionId || snapshot.source !== config.source) {
      fail('INV-01-phase', 'sessionId/source drifted');
    }
    if (snapshot.startedAtIso !== config.startedAtIso) {
      fail('INV-01-phase', `startedAtIso drifted: ${snapshot.startedAtIso}`);
    }
    if (snapshot.analysisProviderId !== provider.providerId) {
      fail('INV-01-phase', 'analysisProviderId drifted');
    }

    // INV-02 / INV-03
    const structuralNow = snapshot.events.map(structural);
    if (structuralNow.length < previousStructural.length) {
      fail(
        'INV-02-append-only',
        `event count fell ${previousStructural.length}→${structuralNow.length}`,
      );
    }
    if (
      !newEventsAllowed &&
      structuralNow.length !== previousStructural.length
    ) {
      fail(
        'INV-02-append-only',
        `events emitted by an action that must not emit (${previousStructural.length}→${structuralNow.length})`,
      );
    }
    for (let i = 0; i < previousStructural.length; i += 1) {
      const before = JSON.stringify(previousStructural[i]);
      const after = JSON.stringify(structuralNow[i]);
      if (before !== after) {
        fail(
          'INV-02-append-only',
          `event ${i} rewritten: ${before} → ${after}`,
        );
      }
    }
    if (snapshot.strokeCount !== snapshot.events.length) {
      fail('INV-02-append-only', 'strokeCount ≠ events.length');
    }
    let maxEndSoFar = Number.NEGATIVE_INFINITY;
    snapshot.events.forEach((view, i) => {
      if (view.eventId !== `E${i + 1}` || view.index !== i) {
        fail(
          'INV-02-append-only',
          `event ${i} has id ${view.eventId}/index ${view.index}`,
        );
      }
      if (!(view.startMs <= view.peakMs && view.peakMs <= view.endMs)) {
        fail(
          'INV-03-bounds',
          `${view.eventId} start/peak/end ${view.startMs}/${view.peakMs}/${view.endMs}`,
        );
      }
      if (view.closedAtMs < view.endMs) {
        fail(
          'INV-03-bounds',
          `${view.eventId} closedAt ${view.closedAtMs} < end ${view.endMs}`,
        );
      }
      if (view.durationMs !== view.endMs - view.startMs) {
        fail('INV-03-bounds', `${view.eventId} durationMs mismatch`);
      }
      if (view.peakMs <= maxEndSoFar) {
        fail(
          'INV-03-bounds',
          `${view.eventId} peak ${view.peakMs} not past frontier ${maxEndSoFar}`,
        );
      }
      maxEndSoFar = Math.max(maxEndSoFar, view.endMs);
      if (view.boundaryUncertain !== (view.closeReason === 'flush')) {
        fail(
          'INV-03-bounds',
          `${view.eventId} boundaryUncertain ≠ (closeReason==='flush')`,
        );
      }
      if (
        Number.isFinite(snapshot.durationMs) &&
        view.endMs > snapshot.durationMs
      ) {
        fail(
          'INV-03-bounds',
          `${view.eventId} end ${view.endMs} > durationMs ${snapshot.durationMs}`,
        );
      }
    });

    // INV-04
    if (!Object.is(snapshot.durationMs, modelDurationMs)) {
      fail(
        'INV-04c-duration-nonfinite',
        `durationMs ${snapshot.durationMs} ≠ model ${modelDurationMs}`,
        nonFiniteTmsPushed,
      );
    }
    if (
      Number.isFinite(snapshot.durationMs) &&
      Number.isFinite(previousDuration) &&
      snapshot.durationMs < previousDuration
    ) {
      fail(
        'INV-04-duration',
        `durationMs fell ${previousDuration}→${snapshot.durationMs}`,
      );
    }
    previousDuration = snapshot.durationMs;

    // INV-05 / INV-06
    if (snapshot.droppedLateSamples !== modelDroppedLate) {
      fail(
        'INV-05-dropped-late',
        `droppedLate ${snapshot.droppedLateSamples} ≠ model ${modelDroppedLate}`,
      );
    }
    if (snapshot.droppedLateSamples !== refSnapshot.droppedLateSamples) {
      fail(
        'INV-06-reference',
        `droppedLate ${snapshot.droppedLateSamples} ≠ reference ${refSnapshot.droppedLateSamples}`,
      );
    }
    const refStructural = JSON.stringify(refSnapshot.events.map(structural));
    if (JSON.stringify(structuralNow) !== refStructural) {
      fail(
        'INV-06-reference',
        `event structure ≠ reference (${structuralNow.length} vs ${refSnapshot.events.length})`,
      );
    }
    if (
      JSON.stringify(snapshot.qualityNotes) !==
      JSON.stringify(refSnapshot.qualityNotes)
    ) {
      fail('INV-06-reference', 'qualityNotes ≠ reference');
    }
    if (!Object.is(snapshot.durationMs, refSnapshot.durationMs)) {
      fail(
        'INV-06-reference',
        `durationMs ${snapshot.durationMs} ≠ reference ${refSnapshot.durationMs}`,
      );
    }

    // INV-07 per-feed counters
    feeds.forEach((feed, i) => {
      const dropped = feed.handle.droppedInvalidSamples();
      if (dropped !== feed.droppedInvalid) {
        fail(
          'INV-07-native-feed',
          `feed ${i} droppedInvalid ${dropped} ≠ model ${feed.droppedInvalid}`,
        );
      }
    });

    // INV-09 registry
    if (modelEnded) {
      const registry = getCompletedSession(sessionId);
      if (!registry) {
        fail('INV-09-registry', 'getCompletedSession(id) null after end()');
      } else {
        const strip = (s: LiveSessionSnapshot) =>
          JSON.stringify({ ...s, onUpdateFailures: 0 });
        if (strip(registry) !== strip(snapshot)) {
          fail(
            'INV-09-registry',
            'registry snapshot ≠ live snapshot (excluding onUpdateFailures)',
          );
        }
        if (registry.onUpdateFailures !== snapshot.onUpdateFailures) {
          const lagsByOne =
            lastNotifyThrew &&
            registry.onUpdateFailures === snapshot.onUpdateFailures - 1;
          fail(
            'INV-09b-registry-onUpdateFailures',
            `registry.onUpdateFailures ${registry.onUpdateFailures} ≠ live ${snapshot.onUpdateFailures}` +
              (lagsByOne
                ? ' (lags by one: registry written before the throwing subscriber ran)'
                : ''),
            lagsByOne,
          );
        }
      }
    }

    // INV-10 / INV-11 per-event lifecycle
    for (const view of snapshot.events) {
      const expectation = expectations.get(view.eventId);
      if (!expectation) continue;
      if (view.state !== expectation.state) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} state ${view.state} ≠ expected ${expectation.state}`,
        );
      }
      if (view.pendingReason !== expectation.pendingReason) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} pendingReason ${JSON.stringify(view.pendingReason)} ≠ expected ${JSON.stringify(expectation.pendingReason)}`,
        );
      }
      if (view.abstainReason !== expectation.abstainReason) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} abstainReason ${JSON.stringify(view.abstainReason)} ≠ expected ${JSON.stringify(expectation.abstainReason)}`,
        );
      }
      if (view.analysis !== expectation.analysis) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} analysis identity ≠ expected`,
        );
      }
      if (view.state === 'ready' && view.analysis === null) {
        fail('INV-10-lifecycle', `${view.eventId} ready without analysis`);
      }
      if (view.state === 'abstained' && view.abstainReason === null) {
        fail('INV-10-lifecycle', `${view.eventId} abstained without reason`);
      }
      if (view.state !== 'ready' && view.analysis !== null) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} carries analysis in state ${view.state}`,
        );
      }
      if (view.state === 'ready' && view.family !== null) {
        // Records here are 'unresolved' → family must be null.
        fail(
          'INV-10-lifecycle',
          `${view.eventId} family ${view.family} from an unresolved record`,
        );
      }
      const previous = previousStates.get(view.eventId);
      if (
        (previous === 'ready' || previous === 'abstained') &&
        view.state !== previous
      ) {
        fail(
          'INV-10-lifecycle',
          `${view.eventId} terminal ${previous} rewritten to ${view.state}`,
        );
      }
      const extracts = extractCalls.get(view.eventId) ?? 0;
      const analyzes = analyzeCalls.get(view.eventId) ?? 0;
      if (analyzes > 1) {
        fail(
          'INV-11-provider-seam',
          `${view.eventId} analyzeEvent called ${analyzes}×`,
        );
      }
      if (extracts > 1) {
        fail(
          'INV-11-provider-seam',
          `${view.eventId} extract called ${extracts}×`,
        );
      }
      if (!expectation.dispatchedAvailable && (analyzes > 0 || extracts > 0)) {
        fail(
          'INV-11-provider-seam',
          `${view.eventId} dispatched while provider unavailable`,
        );
      }
      if (expectation.dispatchedAvailable && clipSource && extracts === 0) {
        fail(
          'INV-11-provider-seam',
          `${view.eventId} dispatched available but extract never called`,
        );
      }
      if (!clipSource && extracts > 0) {
        fail(
          'INV-11-provider-seam',
          `${view.eventId} extract called without a clip source`,
        );
      }
    }
    previousStates = new Map(snapshot.events.map(v => [v.eventId, v.state]));

    // INV-11 request contents for outstanding analyze deferreds
    for (const deferred of outstanding) {
      if (deferred.kind !== 'analyze') continue;
      const view = snapshot.events.find(v => v.eventId === deferred.eventId);
      const expectation = expectations.get(deferred.eventId);
      if (!view || !expectation) {
        fail(
          'INV-11-provider-seam',
          `analyze request for unknown event ${deferred.eventId}`,
        );
        continue;
      }
      const request = deferred.request;
      const problems: string[] = [];
      if (request.sessionId !== sessionId) problems.push('sessionId');
      if (request.declaredStroke !== null) problems.push('declaredStroke');
      if (request.closeReason !== view.closeReason)
        problems.push('closeReason');
      if (request.closedAtMs !== view.closedAtMs) problems.push('closedAtMs');
      if (
        request.proposal.startMs !== view.startMs ||
        request.proposal.endMs !== view.endMs ||
        request.proposal.peakMs !== view.peakMs ||
        request.proposal.peakSpeed !== view.peakSpeed ||
        request.proposal.eventId !== view.eventId
      ) {
        problems.push('proposal');
      }
      if (!Object.isFrozen(request.proposal))
        problems.push('proposal-not-frozen');
      if (request.clip !== expectation.clip) problems.push('clip');
      if (request.poseSequenceSlice !== expectation.poseSequenceSlice) {
        problems.push('poseSequenceSlice');
      }
      if (problems.length > 0) {
        fail(
          'INV-11-provider-seam',
          `${deferred.eventId} request drift: ${problems.join(',')}`,
        );
      }
    }

    // INV-12
    if (snapshot.onUpdateFailures !== onUpdateThrows) {
      fail(
        'INV-12-onUpdate',
        `onUpdateFailures ${snapshot.onUpdateFailures} ≠ throws ${onUpdateThrows}`,
      );
    }

    // INV-14 view helpers
    const segments = timelineSegments(snapshot.events, snapshot.durationMs);
    if (snapshot.durationMs > 0 && segments.length !== snapshot.events.length) {
      fail(
        'INV-14-view-helpers',
        `timelineSegments ${segments.length} ≠ events ${snapshot.events.length}`,
      );
    }
    for (const segment of segments) {
      if (
        !(segment.startFraction >= 0 && segment.startFraction <= 1) ||
        !(segment.endFraction >= 0 && segment.endFraction <= 1) ||
        segment.startFraction > segment.endFraction
      ) {
        fail(
          'INV-14-view-helpers',
          `${segment.eventId} fractions ${segment.startFraction}/${segment.endFraction}`,
        );
      }
    }
    const distribution = techniqueDistribution(snapshot.events);
    const distributionTotal = distribution.reduce(
      (sum, chip) => sum + chip.count,
      0,
    );
    if (distributionTotal !== snapshot.events.length) {
      fail(
        'INV-14-view-helpers',
        `distribution total ${distributionTotal} ≠ events ${snapshot.events.length}`,
      );
    }
    if (
      JSON.stringify(distribution) !== JSON.stringify(snapshot.distribution)
    ) {
      fail(
        'INV-14-view-helpers',
        'snapshot.distribution ≠ techniqueDistribution(events)',
      );
    }
    const clock = formatSessionClock(snapshot.durationMs);
    if (!/^\d+:\d{2}$/.test(clock)) {
      // A poisoned durationMs (INV-04c) renders as "NaN:NaN" — same root.
      fail(
        'INV-14-view-helpers',
        `formatSessionClock(${snapshot.durationMs}) → ${clock}`,
        !Number.isFinite(snapshot.durationMs) && nonFiniteTmsPushed,
      );
    }
    const pill = captureModePillLabel(snapshot.source);
    if ((pill === null) !== (snapshot.source === 'live')) {
      fail(
        'INV-14-view-helpers',
        `captureModePillLabel(${snapshot.source}) → ${pill}`,
      );
    }

    // INV-15 / INV-16 progression
    const progression = sessionScoreProgression(snapshot.events);
    const expectedProgression = referenceProgression(snapshot.events);
    if (JSON.stringify(progression) !== JSON.stringify(expectedProgression)) {
      fail(
        'INV-15-progression',
        `progression ≠ reference fold: ${JSON.stringify(progression)} vs ${JSON.stringify(expectedProgression)}`,
      );
    }
    const shuffled = sessionScoreProgression(rng.shuffle(snapshot.events));
    if (JSON.stringify(shuffled) !== JSON.stringify(progression)) {
      fail('INV-15-progression', 'progression depends on input order');
    }
    if (
      progression.scoredCount +
        progression.noReadCount +
        progression.pendingCount !==
      snapshot.events.length
    ) {
      fail('INV-15-progression', 'buckets do not partition the events');
    }
    for (let i = 1; i < progression.points.length; i += 1) {
      if (
        progression.points[i]!.eventIndex <=
        progression.points[i - 1]!.eventIndex
      ) {
        fail('INV-15-progression', 'points not strictly index-ordered');
      }
    }
    if (previousProgression) {
      const emitted = structuralNow.length - previousStructural.length;
      if (
        progression.pendingCount >
        previousProgression.pendingCount + emitted
      ) {
        fail(
          'INV-16-progress-monotone',
          `pendingCount ${previousProgression.pendingCount}→${progression.pendingCount} with ${emitted} new events`,
        );
      }
      if (progression.scoredCount < previousProgression.scoredCount) {
        fail(
          'INV-16-progress-monotone',
          `scoredCount fell ${previousProgression.scoredCount}→${progression.scoredCount}`,
        );
      }
      if (progression.noReadCount < previousProgression.noReadCount) {
        fail(
          'INV-16-progress-monotone',
          `noReadCount fell ${previousProgression.noReadCount}→${progression.noReadCount}`,
        );
      }
      for (const point of previousProgression.points) {
        const still = progression.points.find(p => p.eventId === point.eventId);
        if (!still || JSON.stringify(still) !== JSON.stringify(point)) {
          fail(
            'INV-16-progress-monotone',
            `point ${point.eventId} removed or changed`,
          );
        }
      }
    }
    previousProgression = progression;
    previousStructural = structuralNow;
    return snapshot;
  };

  // Initial state.
  await checkAll(false);
  const digest = (snapshot: LiveSessionSnapshot) =>
    `${snapshot.phase}|d=${snapshot.durationMs}|late=${snapshot.droppedLateSamples}|` +
    `ouf=${snapshot.onUpdateFailures}|calls=${onUpdateCalls}|az=${analyzeCallsTotal}|` +
    snapshot.events
      .map(
        v =>
          `${v.eventId}:${v.startMs}-${v.peakMs}-${v.endMs}@${v.closedAtMs}/${v.closeReason}/${v.state}` +
          `/${v.pendingReason ?? '-'}/${v.abstainReason ?? '-'}/${v.analysis?.result?.overallScore ?? '-'}`,
      )
      .join(';');
  trace.push(`0 init ${digest(flow.snapshot())}`);

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    stepIndex = i + 1;
    currentAction = describeAction(action);
    let newEventsAllowed = false;
    let note = '';
    switch (action.kind) {
      case 'push': {
        newEventsAllowed = !modelEnded;
        for (const sample of action.samples) {
          directPush(sample.tMs, sample.v);
          // Every sample is a step of its own for the model check.
          await flushAsync();
          await checkAll(newEventsAllowed);
        }
        break;
      }
      case 'pushNonFinite': {
        newEventsAllowed = !modelEnded;
        directPush(decodeNumber(action.tMs), decodeNumber(action.v));
        break;
      }
      case 'nativeValid': {
        newEventsAllowed = !modelEnded;
        const payload: Record<string, unknown> = {
          type: SESSION_MOTION_SAMPLE_EVENT_TYPE,
          tMs: action.tMs,
          v: action.v,
          emittedAtIso: '2026-09-05T02:00:00.000Z',
        };
        if (action.captureId === 'own') payload.captureId = CAPTURE_ID;
        if (action.captureId === 'foreign')
          payload.captureId = FOREIGN_CAPTURE_ID;
        emitNativeModelled(payload);
        break;
      }
      case 'nativeMalformed':
        emitNativeModelled(
          malformedPayload(action.variant, modelDurationMs + 33, 0.4),
        );
        break;
      case 'nativeNoise':
        emitNativeModelled(
          noisePayload(action.variant, modelDurationMs + 33, 0.4),
        );
        break;
      case 'connectFeed': {
        const handle = connectNativeSessionMotionFeed(
          flow,
          action.filterByCaptureId
            ? { sessionCaptureId: CAPTURE_ID }
            : undefined,
        );
        feeds.push({
          handle,
          connected: true,
          filterCaptureId: action.filterByCaptureId ? CAPTURE_ID : undefined,
          droppedInvalid: 0,
        });
        break;
      }
      case 'disconnectFeed': {
        if (feeds.length === 0) {
          note = 'no-feed';
          break;
        }
        const feed = feeds[action.pick % feeds.length]!;
        feed.handle.disconnect();
        feed.connected = false;
        break;
      }
      case 'end': {
        newEventsAllowed = !modelEnded;
        if (modelEnded) {
          const before = flow.snapshot();
          const beforeCalls = analyzeCallsTotal;
          const beforeDeferreds = outstanding.length;
          const beforeNotifies = onUpdateCalls;
          const again = flow.end();
          if (JSON.stringify(again) !== JSON.stringify(before)) {
            fail(
              'INV-08-end-idempotent',
              'second end() returned a different snapshot',
            );
          }
          if (
            analyzeCallsTotal !== beforeCalls ||
            outstanding.length !== beforeDeferreds
          ) {
            fail('INV-08-end-idempotent', 'second end() dispatched analysis');
          }
          if (onUpdateCalls !== beforeNotifies) {
            fail('INV-08-end-idempotent', 'second end() notified subscribers');
          }
          note = 'again';
        } else {
          reference.end();
          const snapshot = flow.end();
          modelEnded = true;
          if (snapshot.phase !== 'ended') {
            fail('INV-01-phase', 'end() returned a running snapshot');
          }
        }
        break;
      }
      case 'settle': {
        const candidates = outstanding.filter(d => !d.hanging);
        if (candidates.length === 0) {
          note = 'nothing-outstanding';
          break;
        }
        const deferred = candidates[action.pick % candidates.length]!;
        const expectation = expectations.get(deferred.eventId);
        if (!expectation) {
          fail(
            'INV-11-provider-seam',
            `deferred for unknown event ${deferred.eventId}`,
          );
          break;
        }
        if (action.outcome === 'hang') {
          deferred.hanging = true;
          hangs += 1;
          note = `hang ${deferred.kind} ${deferred.eventId}`;
          break;
        }
        const remove = () => {
          const index = outstanding.indexOf(deferred);
          if (index >= 0) outstanding.splice(index, 1);
        };
        if (deferred.kind === 'extract') {
          remove();
          if (action.outcome === 'reject') {
            expectation.state = 'pending';
            expectation.pendingReason =
              'SESSION_CLIP_EXTRACTION_FAILED: stress extract rejection';
            deferred.reject(new Error('stress extract rejection'));
          } else if (
            action.outcome === 'abstained' ||
            action.outcome === 'pending'
          ) {
            expectation.state = 'pending';
            expectation.pendingReason =
              'SESSION_CLIP_POSE_SLICE_EMPTY: stress scripted unavailable';
            deferred.resolve({
              status: 'unavailable',
              pendingReason:
                'SESSION_CLIP_POSE_SLICE_EMPTY: stress scripted unavailable',
            });
          } else {
            const { clip, poseSequenceSlice } = clipDouble(deferred.eventId);
            expectation.clip = clip;
            expectation.poseSequenceSlice = poseSequenceSlice;
            if (analyzeSyncThrow) {
              expectation.state = 'abstained';
              expectation.abstainReason = `ANALYSIS_DISPATCH_FAILED: ${SYNC_THROW_ANALYZE}`;
            }
            deferred.resolve({ status: 'extracted', clip, poseSequenceSlice });
          }
          note = `extract ${deferred.eventId} ${action.outcome}`;
          break;
        }
        remove();
        switch (action.outcome) {
          case 'ready_scored':
          case 'ready_low_confidence':
          case 'ready_resultless': {
            const record = analysisRecordDouble(
              deferred.eventId,
              action.outcome === 'ready_scored'
                ? 'scored'
                : action.outcome === 'ready_low_confidence'
                  ? 'low_confidence'
                  : 'resultless',
              action.score,
            );
            expectation.state = 'ready';
            expectation.analysis = record;
            deferred.resolve({ status: 'ready', analysis: record });
            break;
          }
          case 'abstained':
            expectation.state = 'abstained';
            expectation.abstainReason = `STRESS_ABSTAIN: ${deferred.eventId}`;
            deferred.resolve({
              status: 'abstained',
              abstainReason: `STRESS_ABSTAIN: ${deferred.eventId}`,
            });
            break;
          case 'pending':
            expectation.state = 'pending';
            expectation.pendingReason = `STRESS_PENDING: ${deferred.eventId}`;
            deferred.resolve({
              status: 'pending',
              pendingReason: `STRESS_PENDING: ${deferred.eventId}`,
            });
            break;
          case 'reject':
            expectation.state = 'abstained';
            expectation.abstainReason =
              'ANALYSIS_DISPATCH_FAILED: stress analyze rejection';
            deferred.reject(new Error('stress analyze rejection'));
            break;
        }
        note = `analyze ${deferred.eventId} ${action.outcome}`;
        break;
      }
      case 'setOnUpdateThrow':
        onUpdateThrowsLeft = config.withOnUpdate ? action.count : 0;
        break;
      case 'setAvailability':
        providerAvailable = action.available;
        break;
      case 'setSyncThrow':
        analyzeSyncThrow = action.analyze;
        extractSyncThrow = action.extract;
        break;
      case 'awaitSettled': {
        if (outstanding.some(d => d.hanging)) {
          note = 'skipped-hanging-work';
          break;
        }
        // Resolve everything still outstanding as honest 'pending' first so
        // settled() can complete, then require no 'processing' leftovers.
        for (const deferred of [...outstanding]) {
          const expectation = expectations.get(deferred.eventId);
          const index = outstanding.indexOf(deferred);
          if (index >= 0) outstanding.splice(index, 1);
          if (deferred.kind === 'extract') {
            if (expectation) {
              expectation.state = 'pending';
              expectation.pendingReason =
                'SESSION_CLIP_EXTRACTION_FAILED: settled sweep';
            }
            deferred.resolve({
              status: 'unavailable',
              pendingReason: 'SESSION_CLIP_EXTRACTION_FAILED: settled sweep',
            });
          } else {
            if (expectation) {
              expectation.state = 'pending';
              expectation.pendingReason = 'STRESS_PENDING: settled sweep';
            }
            deferred.resolve({
              status: 'pending',
              pendingReason: 'STRESS_PENDING: settled sweep',
            });
          }
        }
        await flow.settled();
        await flushAsync();
        const snapshot = flow.snapshot();
        const processing = snapshot.events.filter(
          v => v.state === 'processing',
        );
        if (processing.length > 0) {
          fail(
            'INV-17-settled',
            `${processing.map(v => v.eventId).join(',')} still processing after settled()`,
          );
        }
        note = 'settled';
        break;
      }
      case 'tick':
        break;
    }
    await flushAsync();
    await flushAsync();
    const snapshot = await checkAll(newEventsAllowed);
    trace.push(
      `${stepIndex} ${currentAction}${note ? ` (${note})` : ''} ${digest(snapshot)}`,
    );
  }

  // Never leave a hanging promise chain attached to a rejected deferred.
  for (const deferred of outstanding) {
    if (deferred.kind === 'extract') {
      deferred.resolve({ status: 'unavailable', pendingReason: 'teardown' });
    } else {
      deferred.resolve({ status: 'pending', pendingReason: 'teardown' });
    }
  }
  outstanding.length = 0;
  for (const feed of feeds) feed.handle.disconnect();
  await flushAsync();

  const finalSnapshot = flow.snapshot();
  return {
    trace,
    traceHash: fnv1a(trace.join('\n')),
    violations,
    observations,
    steps: trace.length - 1,
    events: finalSnapshot.events.length,
    pushes,
    scoredPoints: sessionScoreProgression(finalSnapshot.events).scoredCount,
    hangs,
  };
}

// ─── pure progression campaign (sessionScoreProgression over synthesized views)

export type ViewKind =
  | 'pending'
  | 'processing'
  | 'processing_with_reason'
  | 'abstained'
  | 'ready_scored'
  | 'ready_low_confidence'
  | 'ready_resultless'
  | 'ready_unscored';

const VIEW_KINDS: readonly ViewKind[] = [
  'pending',
  'processing',
  'processing_with_reason',
  'abstained',
  'ready_scored',
  'ready_low_confidence',
  'ready_resultless',
  'ready_unscored',
];

export function synthesizeView(
  index: number,
  kind: ViewKind,
  score: number,
  endMs: number,
): SessionEventView {
  const eventId = `E${index + 1}`;
  const state: SessionEventView['state'] =
    kind === 'pending'
      ? 'pending'
      : kind === 'processing' || kind === 'processing_with_reason'
        ? 'processing'
        : kind === 'abstained'
          ? 'abstained'
          : 'ready';
  let analysis: AnalysisRecord | null = null;
  if (kind === 'ready_scored')
    analysis = analysisRecordDouble(eventId, 'scored', score);
  if (kind === 'ready_low_confidence') {
    analysis = analysisRecordDouble(eventId, 'low_confidence', score);
  }
  if (kind === 'ready_resultless')
    analysis = analysisRecordDouble(eventId, 'resultless', score);
  if (kind === 'ready_unscored') {
    // A scored-kind result whose overallScore is honestly null.
    analysis = analysisRecordDouble(eventId, 'scored', score);
    analysis = {
      ...analysis,
      result: { ...(analysis.result as ShotAnalysis), overallScore: null },
    };
  }
  return {
    eventId,
    index,
    startMs: endMs - 400,
    endMs,
    peakMs: endMs - 200,
    durationMs: 400,
    peakSpeed: 2,
    paddleConfirmed: false,
    closeReason: 'settle',
    closedAtMs: endMs + 100,
    state,
    pendingReason:
      kind === 'pending' || kind === 'processing_with_reason'
        ? 'STRESS_PENDING'
        : null,
    abstainReason: kind === 'abstained' ? 'STRESS_ABSTAIN' : null,
    analysis,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
  };
}

export interface ProgressionRunResult {
  trace: string[];
  traceHash: string;
  violations: Violation[];
  steps: number;
  views: number;
}

/** Seeded pure campaign: 5..60 synthesized views, then random single-event
 * upgrades (pending→terminal) with monotonicity checks after each step. */
export function runProgressionSequence(seed: number): ProgressionRunResult {
  const rng = new Rng(seed ^ 0x2545f491);
  const trace: string[] = [];
  const violations: Violation[] = [];
  let step = 0;
  let action = 'init';
  const fail = (invariant: string, detail: string) =>
    violations.push({ invariant, step, action, detail });

  const count = rng.int(5, 60);
  const views: SessionEventView[] = [];
  let endMs = 500;
  for (let i = 0; i < count; i += 1) {
    endMs += rng.int(300, 2000);
    const kind = rng.weighted(VIEW_KINDS, [12, 8, 4, 12, 40, 8, 6, 5]);
    // Scores on a 0.1 grid, deliberately including ties and exact-half
    // rounding candidates (x.x5) via the mean of the window.
    const score = rng.chance(0.15) ? 5 : Math.round(rng.float() * 100) / 10;
    views.push(synthesizeView(i, kind, score, endMs));
  }

  const round1 = (x: number) => Math.round(x * 10) / 10;

  const check = (
    current: readonly SessionEventView[],
  ): SessionScoreProgression => {
    const progression = sessionScoreProgression(current);
    const expected = referenceProgression(current);
    if (JSON.stringify(progression) !== JSON.stringify(expected)) {
      fail(
        'INV-15-progression',
        `≠ reference fold: ${JSON.stringify(progression)} vs ${JSON.stringify(expected)}`,
      );
    }
    const shuffled = sessionScoreProgression(rng.shuffle(current));
    if (JSON.stringify(shuffled) !== JSON.stringify(progression)) {
      fail('INV-15-progression', 'depends on input order');
    }
    const reversed = sessionScoreProgression([...current].reverse());
    if (JSON.stringify(reversed) !== JSON.stringify(progression)) {
      fail('INV-15-progression', 'depends on reversed input order');
    }
    const n = progression.scoredCount;
    const expectedWindow = n >= 6 ? 3 : n >= 4 ? 2 : 1;
    if (progression.windowSize !== expectedWindow) {
      fail(
        'INV-15-progression',
        `windowSize ${progression.windowSize} for ${n} points`,
      );
    }
    if (progression.points.length !== n)
      fail('INV-15-progression', 'scoredCount ≠ points.length');
    for (let i = 1; i < progression.points.length; i += 1) {
      if (
        progression.points[i]!.eventIndex <=
        progression.points[i - 1]!.eventIndex
      ) {
        fail('INV-15-progression', 'points not strictly index-ordered');
      }
    }
    for (const point of progression.points) {
      const view = current.find(v => v.eventId === point.eventId);
      if (
        !view ||
        view.index !== point.eventIndex ||
        view.endMs !== point.endMs
      ) {
        fail(
          'INV-15-progression',
          `point ${point.eventId} does not mirror its view`,
        );
      }
      if (view && view.analysis?.result?.overallScore !== point.score) {
        fail('INV-15-progression', `point ${point.eventId} score drift`);
      }
    }
    if (n === 0) {
      if (
        progression.startAverage !== null ||
        progression.endAverage !== null ||
        progression.delta !== null ||
        progression.best !== null
      ) {
        fail('INV-15-progression', 'non-null aggregates with zero points');
      }
    } else {
      const head = progression.points.slice(0, expectedWindow);
      const tail = progression.points.slice(-expectedWindow);
      const mean = (xs: readonly { score: number }[]) =>
        xs.reduce((sum, p) => sum + p.score, 0) / xs.length;
      if (progression.startAverage !== round1(mean(head))) {
        fail(
          'INV-15-progression',
          `startAverage ${progression.startAverage} ≠ ${round1(mean(head))}`,
        );
      }
      if (progression.endAverage !== round1(mean(tail))) {
        fail(
          'INV-15-progression',
          `endAverage ${progression.endAverage} ≠ ${round1(mean(tail))}`,
        );
      }
      if (n === 1 && progression.delta !== null)
        fail('INV-15-progression', 'delta with one point');
      if (
        n >= 2 &&
        progression.startAverage !== null &&
        progression.endAverage !== null &&
        progression.delta !==
          round1(progression.endAverage - progression.startAverage)
      ) {
        fail('INV-15-progression', `delta ${progression.delta} ≠ end−start`);
      }
      if (
        progression.startAverage !== null &&
        (progression.startAverage < 0 || progression.startAverage > 10)
      ) {
        fail('INV-15-progression', 'startAverage out of [0,10]');
      }
      const maxScore = Math.max(...progression.points.map(p => p.score));
      const earliestBest =
        progression.points.find(p => p.score === maxScore) ?? null;
      if (JSON.stringify(progression.best) !== JSON.stringify(earliestBest)) {
        fail('INV-15-progression', 'best is not the earliest maximum');
      }
    }
    // A ready event whose scored-kind result carries no overallScore is the
    // one documented no-bucket case; everything else must land in a bucket.
    const unbucketed = current.filter(
      v =>
        v.state === 'ready' &&
        v.analysis !== null &&
        v.analysis.result !== null &&
        v.analysis.result.resultKind !== 'low_confidence' &&
        v.analysis.result.overallScore === null,
    ).length;
    if (
      progression.scoredCount +
        progression.noReadCount +
        progression.pendingCount !==
      current.length - unbucketed
    ) {
      fail(
        'INV-15-progression',
        'buckets do not partition the bucketable views',
      );
    }
    return progression;
  };

  let current = views;
  let previous = check(current);
  trace.push(`0 init n=${count} ${JSON.stringify(previous)}`);

  const upgrades = rng.int(3, 20);
  for (let i = 0; i < upgrades; i += 1) {
    step = i + 1;
    const open = current
      .map((v, index) => ({ v, index }))
      .filter(({ v }) => v.state === 'pending' || v.state === 'processing');
    if (open.length === 0) {
      action = 'noop (no open events)';
      trace.push(`${step} ${action}`);
      continue;
    }
    const target = rng.pick(open);
    const to = rng.weighted(
      [
        'ready_scored',
        'ready_low_confidence',
        'ready_resultless',
        'abstained',
        'pending',
      ] as const,
      [55, 10, 8, 20, 7],
    );
    const score = Math.round(rng.float() * 100) / 10;
    action = `upgrade ${target.v.eventId} ${target.v.state}→${to} score=${score}`;
    const replaced = synthesizeView(target.v.index, to, score, target.v.endMs);
    current = current.map((v, index) =>
      index === target.index ? replaced : v,
    );
    const progression = check(current);
    const expectedPending = previous.pendingCount - (to === 'pending' ? 0 : 1);
    if (progression.pendingCount !== expectedPending) {
      fail(
        'INV-16-progress-monotone',
        `pendingCount ${previous.pendingCount}→${progression.pendingCount} on ${action}`,
      );
    }
    if (progression.scoredCount < previous.scoredCount) {
      fail('INV-16-progress-monotone', 'scoredCount decreased on upgrade');
    }
    if (progression.noReadCount < previous.noReadCount) {
      fail('INV-16-progress-monotone', 'noReadCount decreased on upgrade');
    }
    if (
      to === 'ready_scored' &&
      progression.scoredCount !== previous.scoredCount + 1
    ) {
      fail(
        'INV-16-progress-monotone',
        'scored upgrade did not add exactly one point',
      );
    }
    if (
      (to === 'abstained' ||
        to === 'ready_low_confidence' ||
        to === 'ready_resultless') &&
      progression.noReadCount !== previous.noReadCount + 1
    ) {
      fail(
        'INV-16-progress-monotone',
        `${to} upgrade did not add exactly one no-read`,
      );
    }
    for (const point of previous.points) {
      const still = progression.points.find(p => p.eventId === point.eventId);
      if (!still || JSON.stringify(still) !== JSON.stringify(point)) {
        fail(
          'INV-16-progress-monotone',
          `point ${point.eventId} removed or changed by ${action}`,
        );
      }
    }
    if (
      progression.best &&
      previous.best &&
      progression.best.score < previous.best.score
    ) {
      fail('INV-16-progress-monotone', 'best score decreased on upgrade');
    }
    previous = progression;
    trace.push(`${step} ${action} ${JSON.stringify(progression)}`);
  }

  return {
    trace,
    traceHash: fnv1a(trace.join('\n')),
    violations,
    steps: step,
    views: count,
  };
}

// ─── ddmin minimisation ─────────────────────────────────────────────────────

export interface Minimized {
  length: number;
  actions: string[];
  probes: number;
  violation: Violation;
}

/** Shrinks an action list while the run still reports the same invariant. */
export async function minimizeSequence(
  sequence: GeneratedSequence,
  invariant: string,
  run: (candidate: GeneratedSequence) => Promise<RunResult>,
  budget = 300,
): Promise<Minimized | null> {
  let probes = 0;
  const reproduces = async (actions: Action[]): Promise<Violation | null> => {
    probes += 1;
    const result = await run({ ...sequence, actions });
    return result.violations.find(v => v.invariant === invariant) ?? null;
  };
  let current = sequence.actions;
  let witness = await reproduces(current);
  if (!witness) return null;
  let chunks = 2;
  while (current.length >= 2 && probes < budget) {
    const size = Math.ceil(current.length / chunks);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && probes < budget;
      start += size
    ) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + size),
      ];
      if (candidate.length === 0) continue;
      const hit = await reproduces(candidate);
      if (hit) {
        current = candidate;
        witness = hit;
        chunks = Math.max(2, chunks - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunks >= current.length) break;
      chunks = Math.min(current.length, chunks * 2);
    }
  }
  return {
    length: current.length,
    actions: current.map(describeAction),
    probes,
    violation: witness,
  };
}

export const STRESS_CAPTURE_ID = CAPTURE_ID;
