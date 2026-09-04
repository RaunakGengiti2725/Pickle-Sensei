/**
 * SEEDED RANDOMIZED MODEL of the Live Court session unit:
 *   LiveSessionFlow (real SessionEventEngine) → LiveSessionCoach →
 *   sessionScoreProgression → buildLiveSessionSummaryRecord →
 *   parseLiveSessionSummaryRecord.
 *
 * A plan is a seed plus a list of legal / near-legal actions over the unit's
 * PUBLIC API only (pushSample, end, settled, snapshot, consumeSnapshot,
 * sessionStarted, sessionEnded, setMuted, dispose, recap, ...). The runner
 * executes the plan, drives analysis outcomes through the provider seam with
 * seeded, per-event pre-drawn results (so an outcome never depends on action
 * order), and checks the invariants below after EVERY action.
 *
 * INVARIANTS (each cites the contract it pins):
 *  I1  post-end feed rejected — session.ts L461–463: pushSample after end()
 *      throws; flow.ended() is true; snapshot.phase === 'ended'.
 *  I2  append-only events — sessionEngine.ts L593–607, L679–683: ids are
 *      E1..En in emission order; strokeCount never decreases; a closed
 *      event's proposal bounds (start/peak/end), closeReason and closedAtMs
 *      never change afterwards.
 *  I3  terminal states are final — sessionEngine.ts L904–923: once an event
 *      is 'ready' or 'abstained' its state, analysis and abstainReason never
 *      change; 'ready' ⇒ analysis !== null.
 *  I4  outcome fidelity — session.ts L514–577: the engine state of every
 *      event matches what the provider/clip seam actually returned for it
 *      (scored/low → ready with THAT record, abstained → abstained with THAT
 *      reason, reject → abstained 'ANALYSIS_DISPATCH_FAILED: …', pending /
 *      unavailable / extraction-unavailable → pending with THAT reason).
 *  I5  late data never rewrites history — sessionEngine.ts L839–842:
 *      droppedLateSamples is monotone non-decreasing; malformed (non-finite)
 *      samples never create events (L834, L838).
 *  I6  session clock — session.ts L405–406, L464: durationMs is a finite,
 *      monotone non-decreasing number ("last observed sample time").
 *  I7  one cue per event, terminal only, in snapshot order —
 *      liveSessionCoach.ts L158–189: every event-cue's eventId is a closed
 *      event that was terminal when spoken; no eventId appears twice; the
 *      cue kind matches the event's terminal kind (NO_READ/SETUP_GUIDANCE ⇔
 *      low_confidence|abstained; scored ⇔ the five scored categories).
 *  I8  quiet after end — liveSessionCoach.ts L29–30, L161, L193–212, L215:
 *      after sessionEnded()/dispose() no cue of any category is produced;
 *      SESSION_END appears at most once and, when present, is the last cue.
 *  I9  spoken records the truth — liveSessionCoach.ts L254–265: cue.spoken
 *      ⇔ (not muted ∧ voice available ∧ port did not return false) at emit
 *      time; recap.spokenCount === #spoken cues; the voice port received
 *      exactly the texts of the cues that were speakable.
 *  I10 cue policy shape — audio-coach-core liveSession.ts: text is never
 *      empty; SETUP_GUIDANCE fires exactly on the 3rd consecutive no-read;
 *      CORRECTION/REPEAT_CORRECTION/IMPROVEMENT carry a targetCheckpoint,
 *      the others carry null; scored cues (except PERSONAL_BEST) start with
 *      the 1-decimal score; PERSONAL_BEST requires score > previous best and
 *      repIndex ≥ 3.
 *  I11 progression math — sessionProgress.ts: scored + noRead + pending ===
 *      strokeCount (the seam never emits contract-violating records);
 *      points strictly ascending by eventIndex; best = max score, earliest
 *      on ties; window 1/2/3 by count; start/end averages are 1-decimal
 *      means of the first/last window; delta null unless scored ≥ 2.
 *  I12 summary round trip — liveSessionSummary.ts: buildLiveSessionSummaryRecord
 *      → JSON.stringify → parseLiveSessionSummaryRecord is identity;
 *      cuesSpoken === recap.spokenCount; correctionsByCheckpoint sums to the
 *      number of correction cues with a target; topCorrection is an argmax.
 *  I13 registries mirror the live objects — session.ts L605–611,
 *      liveSessionCoach.ts L209: after end(), getCompletedSession() deep-
 *      equals flow.snapshot() at every step (modulo onUpdateFailures — see
 *      I13b note in checkFull); getCompletedCoachRecap() equals the recap
 *      at sessionEnded().
 *  I14 subscriber isolation — session.ts L612–624: onUpdateFailures equals
 *      the number of times our subscriber threw, and no event state changed
 *      because of it.
 *  I15 idempotent end — session.ts L476–487: a second end() returns a
 *      snapshot equal to the current one and closes nothing new.
 *  DET same seed twice → identical per-step trace digest (checked by the
 *      suite, not here).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  type CheckpointKey,
  type FaultDirection,
} from '@pickle/shared-types';
import {
  DEFAULT_LIVE_CUE_RULES,
  formatSpokenScore,
} from '@pickle/audio-coach-core';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type LiveCoachRecap,
  type SpokenCue,
  type SpokenCueCategory,
} from '../../src/flow/liveSessionCoach';
import {
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventClipExtraction,
  type SessionEventClipSource,
  type SessionEventView,
  type SessionMotionSample,
} from '../../src/flow/session';
import type { SessionStrokeEvent } from '@pickle/analysis-pipeline';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import type { CapturedClip } from '../../src/camera/capture';
import {
  InvariantViolation,
  SeededRng,
  check,
  digest,
  subSeed,
} from './seededStress';

// ─── Actions ────────────────────────────────────────────────────────────────

export type Action =
  | { kind: 'stroke'; peak: number; riseMs: number; fallMs: number }
  | { kind: 'quiet'; ms: number; level: number }
  | { kind: 'gap'; ms: number }
  | { kind: 'duplicateLast' }
  | { kind: 'lateSample'; backMs: number; v: number }
  | { kind: 'malformed'; shape: MalformedShape }
  | { kind: 'resolve'; which: 'oldest' | 'newest' | 'random'; pick: number }
  | { kind: 'resolveAll' }
  | { kind: 'replaySnapshot'; which: 'stale' | 'reversed' | 'current' }
  | { kind: 'setMuted'; muted: boolean }
  | { kind: 'voiceAvailable'; available: boolean }
  | { kind: 'voiceRefuse'; refuse: boolean }
  | { kind: 'subscriberThrows'; on: boolean }
  | { kind: 'coachStart' }
  | { kind: 'end' }
  | { kind: 'pushAfterEnd' }
  | { kind: 'coachEnd' }
  | { kind: 'dispose' };

export type MalformedShape =
  | 'nan_t'
  | 'inf_t'
  | 'neg_inf_t'
  | 'nan_v'
  | 'inf_v'
  | 'neg_v'
  | 'huge_v'
  | 'neg_t';

export const MALFORMED_SHAPES: readonly MalformedShape[] = [
  'nan_t',
  'inf_t',
  'neg_inf_t',
  'nan_v',
  'inf_v',
  'neg_v',
  'huge_v',
  'neg_t',
];

export type ProviderMode = 'available' | 'unavailable';
export type ClipMode = 'none' | 'scripted';

export interface Plan {
  seed: number;
  source: 'live' | 'replay';
  providerMode: ProviderMode;
  clipMode: ClipMode;
  mutedInitially: boolean;
  voiceInitially: boolean;
  /** Malformed samples are a NEAR-legal input class; a plan may exclude
   * them so legal-only invariants are also exercised in isolation. */
  allowMalformed: boolean;
  /** Camera timestamps are not necessarily whole milliseconds (30 fps =
   * 33.333 ms); half the plans emit fractional tMs, half integers. */
  fractionalClock: boolean;
  /** Full invariant sweep every N steps (default 1 — every step). The
   * 10k-event soak raises this because each sweep is O(events). */
  checkEvery?: number;
  actions: Action[];
}

const ACTION_WEIGHTS = {
  stroke: 30,
  quiet: 8,
  gap: 5,
  duplicateLast: 5,
  lateSample: 6,
  malformed: 4,
  resolve: 14,
  resolveAll: 5,
  replaySnapshot: 5,
  setMuted: 2,
  voiceAvailable: 1,
  voiceRefuse: 1,
  subscriberThrows: 2,
  coachStart: 1,
  end: 3,
  pushAfterEnd: 2,
  coachEnd: 2,
  dispose: 1,
} as const;

export function generatePlan(seed: number): Plan {
  const rng = new SeededRng(seed);
  const length = rng.int(5, 60);
  const allowMalformed = rng.bool(0.6);
  const fractionalClock = rng.bool(0.5);
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) {
    const kind = rng.weighted(ACTION_WEIGHTS);
    switch (kind) {
      case 'stroke':
        actions.push({
          kind,
          peak: Number(rng.float(0.6, 6).toFixed(3)),
          riseMs: rng.int(60, 250),
          fallMs: rng.int(200, 700),
        });
        break;
      case 'quiet':
        actions.push({
          kind,
          ms: rng.int(100, 1800),
          level: Number(rng.float(0.02, 0.2).toFixed(3)),
        });
        break;
      case 'gap':
        // Pause / background: the emitter stops, the clock keeps moving.
        actions.push({ kind, ms: rng.int(500, 120_000) });
        break;
      case 'lateSample':
        actions.push({
          kind,
          backMs: rng.int(1, 5000),
          v: Number(rng.float(0, 4).toFixed(3)),
        });
        break;
      case 'malformed':
        if (!allowMalformed) {
          actions.push({ kind: 'duplicateLast' });
          break;
        }
        actions.push({ kind, shape: rng.pick(MALFORMED_SHAPES) });
        break;
      case 'resolve':
        actions.push({
          kind,
          which: rng.pick(['oldest', 'newest', 'random'] as const),
          pick: rng.int(0, 1_000_000),
        });
        break;
      case 'replaySnapshot':
        actions.push({
          kind,
          which: rng.pick(['stale', 'reversed', 'current'] as const),
        });
        break;
      case 'setMuted':
        actions.push({ kind, muted: rng.bool() });
        break;
      case 'voiceAvailable':
        actions.push({ kind, available: rng.bool(0.7) });
        break;
      case 'voiceRefuse':
        actions.push({ kind, refuse: rng.bool(0.4) });
        break;
      case 'subscriberThrows':
        actions.push({ kind, on: rng.bool(0.4) });
        break;
      default:
        actions.push({ kind });
    }
  }
  return {
    seed,
    source: rng.bool(0.8) ? 'live' : 'replay',
    providerMode: rng.bool(0.9) ? 'available' : 'unavailable',
    clipMode: rng.bool(0.5) ? 'none' : 'scripted',
    mutedInitially: rng.bool(0.15),
    voiceInitially: rng.bool(0.9),
    allowMalformed,
    fractionalClock,
    actions,
  };
}

// ─── Seeded per-event outcomes (independent of action order) ────────────────

export type ScriptedOutcome =
  | { status: 'scored'; record: AnalysisRecord; score: number; worst: Worst }
  | { status: 'low_confidence'; record: AnalysisRecord }
  | { status: 'abstained'; reason: string }
  | { status: 'pending'; reason: string }
  | { status: 'reject'; message: string };

interface Worst {
  key: CheckpointKey;
  severity: number;
}

export type ScriptedExtraction =
  | { status: 'extracted' }
  | { status: 'unavailable'; reason: string }
  | { status: 'throw'; message: string };

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable: boolean;
}

function scoredRecord(
  overallScore: number,
  checkpoints: CheckpointSpec[],
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

function lowConfidenceRecord(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: [],
    },
  } as unknown as AnalysisRecord;
}

const ABSTAIN_REASONS = ['NO_POSE', 'POSE_TOO_SPARSE', 'TARGET_LOST'] as const;
const PENDING_REASONS = ['QUEUE_FULL', 'MODEL_LOADING'] as const;

export function outcomeFor(seed: number, eventIndex: number): ScriptedOutcome {
  const rng = new SeededRng(subSeed(seed, `outcome:${eventIndex}`));
  const status = rng.weighted({
    scored: 55,
    low_confidence: 14,
    abstained: 12,
    pending: 8,
    reject: 11,
  });
  switch (status) {
    case 'scored': {
      const score = Number(rng.float(0, 10).toFixed(1));
      const count = rng.int(1, 4);
      const keys = [...CHECKPOINTS];
      const checkpoints: CheckpointSpec[] = [];
      for (let i = 0; i < count; i++) {
        const key = keys.splice(rng.int(0, keys.length - 1), 1)[0]!;
        checkpoints.push({
          key,
          score: rng.bool(0.9) ? rng.int(0, 100) : null,
          direction: rng.pick(FAULT_DIRECTIONS),
          severity: Number(rng.float(0, 1).toFixed(2)),
          applicable: rng.bool(0.85),
        });
      }
      return {
        status,
        record: scoredRecord(score, checkpoints),
        score,
        worst: worstOf(checkpoints),
      };
    }
    case 'low_confidence':
      return { status, record: lowConfidenceRecord() };
    case 'abstained':
      return { status, reason: rng.pick(ABSTAIN_REASONS) };
    case 'pending':
      return { status, reason: rng.pick(PENDING_REASONS) };
    default:
      return { status, message: `boom-${eventIndex}` };
  }
}

/** Same tie rules as audio-coach-core worstCheckpoint (severity desc, then
 * lower score, then input order), computed independently here. */
function worstOf(checkpoints: readonly CheckpointSpec[]): Worst {
  let worst: CheckpointSpec | null = null;
  for (const checkpoint of checkpoints) {
    if (!checkpoint.applicable) continue;
    if (worst === null) {
      worst = checkpoint;
      continue;
    }
    if (checkpoint.severity > worst.severity) worst = checkpoint;
    else if (
      checkpoint.severity === worst.severity &&
      (checkpoint.score ?? 100) < (worst.score ?? 100)
    ) {
      worst = checkpoint;
    }
  }
  return worst
    ? { key: worst.key, severity: worst.severity }
    : { key: 'contact_position', severity: -1 };
}

export function extractionFor(
  seed: number,
  eventIndex: number,
): ScriptedExtraction {
  const rng = new SeededRng(subSeed(seed, `extract:${eventIndex}`));
  const status = rng.weighted({ extracted: 75, unavailable: 15, throw: 10 });
  if (status === 'extracted') return { status };
  if (status === 'unavailable')
    return { status, reason: `CLIP_WINDOW_NOT_READY_${eventIndex}` };
  return { status, message: `extract-fail-${eventIndex}` };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface PendingDispatch {
  eventId: string;
  eventIndex: number;
  deferred: Deferred<SessionEventAnalysisOutcome>;
}

interface EventMemory {
  startMs: number;
  peakMs: number;
  endMs: number;
  closeReason: string;
  closedAtMs: number;
  terminal: {
    state: string;
    analysis: unknown;
    abstainReason: string | null;
  } | null;
}

export interface RunResult {
  seed: number;
  length: number;
  /** null when every invariant held. */
  violation: InvariantViolation | null;
  /** Non-invariant crash (unexpected throw from the unit or the harness). */
  crash: string | null;
  failingStep: number | null;
  trace: string[];
  traceDigest: string;
  stats: Record<string, number>;
}

const EXPECTED_POST_END_MESSAGE =
  'session already ended — no samples may follow flush()';

const SCORED_CATEGORIES: ReadonlySet<SpokenCueCategory> = new Set([
  'CORRECTION',
  'REPEAT_CORRECTION',
  'IMPROVEMENT',
  'PERSONAL_BEST',
  'PRAISE',
]);
const NO_READ_CATEGORIES: ReadonlySet<SpokenCueCategory> = new Set([
  'NO_READ',
  'SETUP_GUIDANCE',
]);
const TARGETED_CATEGORIES: ReadonlySet<SpokenCueCategory> = new Set([
  'CORRECTION',
  'REPEAT_CORRECTION',
  'IMPROVEMENT',
]);

function terminalKindOf(
  event: SessionEventView,
): 'scored' | 'low_confidence' | 'abstained' | null {
  if (event.state === 'abstained') return 'abstained';
  if (event.state !== 'ready') return null;
  const result = event.analysis?.result ?? null;
  if (result === null) return 'low_confidence';
  return result.resultKind === 'scored' && result.overallScore !== null
    ? 'scored'
    : 'low_confidence';
}

export async function runPlan(plan: Plan): Promise<RunResult> {
  const { seed } = plan;
  const checkEvery = Math.max(1, plan.checkEvery ?? 1);
  const sessionId = `stress-${seed}`;
  const trace: string[] = [];
  const stats: Record<string, number> = {
    samples: 0,
    events: 0,
    cues: 0,
    malformed: 0,
    lateSamples: 0,
    duplicates: 0,
    resolves: 0,
    postEndPushes: 0,
    replays: 0,
    steps: 0,
  };

  // Voice port model.
  let voiceAvailable = plan.voiceInitially;
  let voiceRefuses = false;
  const spokenTexts: string[] = [];
  const voice: CoachVoicePort = {
    available: () => voiceAvailable,
    speak: text => {
      spokenTexts.push(text);
      return voiceRefuses ? false : undefined;
    },
    stop: () => undefined,
  };

  // Subscriber model.
  let subscriberThrows = false;
  let subscriberThrewCount = 0;
  const observedCues: SpokenCue[] = [];
  const cueEmitContext: Array<{
    speakable: boolean;
    portCalled: boolean;
    coachEnded: boolean;
  }> = [];
  // coach.ended is private; mirrored here — true after sessionEnded()/dispose().
  let coachEndedAtEmit = false;

  // Pending dispatches (provider seam) — controlled by the plan.
  const pending: PendingDispatch[] = [];
  const clipPending: Array<{
    eventIndex: number;
    deferred: Deferred<SessionEventClipExtraction>;
  }> = [];
  const dispatchedIndices = new Set<number>();
  // One scripted outcome object per event per run, so I4 can compare the
  // record the seam handed out BY IDENTITY (the flow must not copy/rewrite).
  const outcomeMemo = new Map<number, ScriptedOutcome>();
  const scriptedOutcome = (eventIndex: number): ScriptedOutcome => {
    let outcome = outcomeMemo.get(eventIndex);
    if (outcome === undefined) {
      outcome = outcomeFor(seed, eventIndex);
      outcomeMemo.set(eventIndex, outcome);
    }
    return outcome;
  };

  const provider: SessionEventAnalysisProvider = {
    providerId: 'stress-scripted-provider',
    availability: () =>
      plan.providerMode === 'available'
        ? { status: 'available' }
        : { status: 'unavailable', pendingReason: 'PROVIDER_OFFLINE' },
    analyzeEvent: request => {
      const eventIndex = Number(request.eventId.slice(1)) - 1;
      dispatchedIndices.add(eventIndex);
      return new Promise<SessionEventAnalysisOutcome>((resolve, reject) => {
        pending.push({
          eventId: request.eventId,
          eventIndex,
          deferred: { resolve, reject },
        });
      });
    },
  };

  const clipSource: SessionEventClipSource | undefined =
    plan.clipMode === 'scripted'
      ? {
          sourceId: 'stress-scripted-clips',
          extract: (event: SessionStrokeEvent) => {
            const eventIndex = Number(event.eventId.slice(1)) - 1;
            const scripted = extractionFor(seed, eventIndex);
            if (scripted.status === 'throw') {
              return Promise.reject(new Error(scripted.message));
            }
            if (scripted.status === 'unavailable') {
              return Promise.resolve({
                status: 'unavailable' as const,
                pendingReason: scripted.reason,
              });
            }
            // Extraction is asynchronous on device; model it as a deferred
            // step the plan resolves along with the analysis.
            return new Promise<SessionEventClipExtraction>(
              (resolve, reject) => {
                clipPending.push({
                  eventIndex,
                  deferred: { resolve, reject },
                });
              },
            );
          },
        }
      : undefined;

  const coach = new LiveSessionCoach({
    voice,
    muted: plan.mutedInitially,
    onCue: cue => {
      observedCues.push(cue);
    },
  });
  let coachEnded = false;
  let recapAtEnd: LiveCoachRecap | null = null;
  let flowEnded = false;

  const flow = new LiveSessionFlow({
    sessionId,
    source: plan.source,
    provider,
    clipSource,
    startedAtIso: '2026-09-04T00:00:00.000Z',
    fps: 30,
    onUpdate: next => {
      // The UI wiring: every snapshot feeds the coach, and the subscriber
      // may itself be faulty.
      coach.consumeSnapshot(next);
      if (subscriberThrows) {
        subscriberThrewCount += 1;
        throw new Error('subscriber exploded');
      }
    },
  });

  // Model memory.
  const eventMemory = new Map<string, EventMemory>();
  const consumedByCoach = new Set<string>();
  let lastDropped = 0;
  let lastDuration = 0;
  let lastStrokeCount = 0;
  let clock = 0;
  let lastSample: SessionMotionSample | null = null;
  let snapshotHistory: LiveSessionSnapshot[] = [];
  const cueModel = {
    noReadStreak: 0,
    bestOverall: null as number | null,
    repIndex: 0,
    checkedCues: 0,
  };

  // Wrap emitted cues with the speakable context at emit time. The coach
  // calls onCue synchronously inside emit(), so capturing the flags here
  // (before/after each action) is exact for cues produced by that action.
  const speakableNow = () =>
    !coach.isMuted() && voiceAvailable && !voiceRefuses;

  const push = (sample: SessionMotionSample): SessionStrokeEvent[] => {
    stats.samples = (stats.samples ?? 0) + 1;
    const closed = flow.pushSample(sample);
    lastSample = sample;
    if (Number.isFinite(sample.tMs)) clock = Math.max(clock, sample.tMs);
    return closed;
  };

  const emitSeries = (samples: SessionMotionSample[], step: number) => {
    for (const sample of samples) {
      push(sample);
      checkCheap(step);
    }
  };

  const checkCheap = (step: number) => {
    const snapshot = flow.snapshot();
    check(
      snapshot.droppedLateSamples >= lastDropped,
      'I5',
      step,
      () =>
        `droppedLateSamples went ${lastDropped} → ${snapshot.droppedLateSamples}`,
    );
    lastDropped = snapshot.droppedLateSamples;
    check(
      Number.isFinite(snapshot.durationMs),
      'I6',
      step,
      () =>
        `durationMs is ${snapshot.durationMs} (last sample ${JSON.stringify(lastSample)})`,
    );
    check(
      snapshot.durationMs >= lastDuration,
      'I6',
      step,
      () => `durationMs decreased ${lastDuration} → ${snapshot.durationMs}`,
    );
    lastDuration = snapshot.durationMs;
    check(
      snapshot.strokeCount >= lastStrokeCount,
      'I2',
      step,
      () =>
        `strokeCount decreased ${lastStrokeCount} → ${snapshot.strokeCount}`,
    );
    lastStrokeCount = snapshot.strokeCount;
  };

  const resolveDispatch = (entry: PendingDispatch) => {
    stats.resolves = (stats.resolves ?? 0) + 1;
    const outcome = scriptedOutcome(entry.eventIndex);
    switch (outcome.status) {
      case 'scored':
      case 'low_confidence':
        entry.deferred.resolve({ status: 'ready', analysis: outcome.record });
        break;
      case 'abstained':
        entry.deferred.resolve({
          status: 'abstained',
          abstainReason: outcome.reason,
        });
        break;
      case 'pending':
        entry.deferred.resolve({
          status: 'pending',
          pendingReason: outcome.reason,
        });
        break;
      case 'reject':
        entry.deferred.reject(new Error(outcome.message));
        break;
    }
  };

  const resolveClip = (entry: {
    eventIndex: number;
    deferred: Deferred<SessionEventClipExtraction>;
  }) => {
    entry.deferred.resolve({
      status: 'extracted',
      // The flow forwards the clip untouched to the provider; the scripted
      // provider ignores it, so a minimal stand-in is sufficient here.
      clip: {
        uri: `stress://clip/${entry.eventIndex}`,
      } as unknown as CapturedClip,
      poseSequenceSlice: null,
    });
  };

  const flushMicrotasks = () =>
    new Promise<void>(resolve => setImmediate(resolve));

  /** Resolve `count` pending items chosen by the plan; clip extractions are
   * resolved first (they gate the analysis dispatch). */
  const resolveSome = async (
    which: 'oldest' | 'newest' | 'random',
    pick: number,
  ) => {
    if (clipPending.length > 0) {
      const index =
        which === 'oldest'
          ? 0
          : which === 'newest'
            ? clipPending.length - 1
            : pick % clipPending.length;
      const [entry] = clipPending.splice(index, 1);
      resolveClip(entry!);
      await flushMicrotasks();
      return;
    }
    if (pending.length === 0) return;
    const index =
      which === 'oldest'
        ? 0
        : which === 'newest'
          ? pending.length - 1
          : pick % pending.length;
    const [entry] = pending.splice(index, 1);
    resolveDispatch(entry!);
    await flushMicrotasks();
  };

  const resolveEverything = async () => {
    // Clip extractions first, then any analysis dispatches they unlock.
    for (let guard = 0; guard < 4; guard++) {
      while (clipPending.length > 0) resolveClip(clipPending.shift()!);
      await flushMicrotasks();
      while (pending.length > 0) resolveDispatch(pending.shift()!);
      await flushMicrotasks();
      if (clipPending.length === 0 && pending.length === 0) break;
    }
  };

  // ── Invariant sweep after every action ────────────────────────────────
  const checkFull = (step: number) => {
    checkCheap(step);
    const snapshot = flow.snapshot();

    // I1
    check(
      flow.ended() === flowEnded,
      'I1',
      step,
      () => `flow.ended()=${flow.ended()} but model says ${flowEnded}`,
    );
    check(
      (snapshot.phase === 'ended') === flowEnded,
      'I1',
      step,
      () => `snapshot.phase=${snapshot.phase} but model ended=${flowEnded}`,
    );

    // I2 / I3 / I4
    snapshot.events.forEach((event, index) => {
      check(
        event.eventId === `E${index + 1}` && event.index === index,
        'I2',
        step,
        () => `event ${index} has id ${event.eventId}/index ${event.index}`,
      );
      const remembered = eventMemory.get(event.eventId);
      if (remembered) {
        check(
          remembered.startMs === event.startMs &&
            remembered.peakMs === event.peakMs &&
            remembered.endMs === event.endMs &&
            remembered.closeReason === event.closeReason &&
            remembered.closedAtMs === event.closedAtMs,
          'I2',
          step,
          () =>
            `${event.eventId} bounds changed: ${JSON.stringify(remembered)} → ` +
            `${JSON.stringify([event.startMs, event.peakMs, event.endMs, event.closeReason, event.closedAtMs])}`,
        );
        if (remembered.terminal) {
          check(
            remembered.terminal.state === event.state &&
              remembered.terminal.analysis === event.analysis &&
              remembered.terminal.abstainReason === event.abstainReason,
            'I3',
            step,
            () =>
              `${event.eventId} terminal ${remembered.terminal!.state} changed to ${event.state}`,
          );
        }
      } else {
        check(
          Number.isFinite(event.startMs) &&
            Number.isFinite(event.endMs) &&
            Number.isFinite(event.peakMs) &&
            event.startMs <= event.peakMs &&
            event.peakMs <= event.endMs,
          'I5',
          step,
          () =>
            `${event.eventId} has non-finite/inverted bounds ${event.startMs}/${event.peakMs}/${event.endMs}`,
        );
        eventMemory.set(event.eventId, {
          startMs: event.startMs,
          peakMs: event.peakMs,
          endMs: event.endMs,
          closeReason: event.closeReason,
          closedAtMs: event.closedAtMs,
          terminal: null,
        });
        stats.events = (stats.events ?? 0) + 1;
      }
      const memory = eventMemory.get(event.eventId)!;
      if (event.state === 'ready' || event.state === 'abstained') {
        check(
          event.state !== 'ready' || event.analysis !== null,
          'I3',
          step,
          () => `${event.eventId} is ready without an analysis record`,
        );
        memory.terminal ??= {
          state: event.state,
          analysis: event.analysis,
          abstainReason: event.abstainReason,
        };
      }
      // I4 — the recorded state must be exactly what the seam returned.
      const wasDispatched = dispatchedIndices.has(index);
      const stillPending = pending.some(entry => entry.eventIndex === index);
      const scripted = scriptedOutcome(index);
      const extraction =
        plan.clipMode === 'scripted' ? extractionFor(seed, index) : null;
      if (plan.providerMode === 'unavailable') {
        check(
          event.state === 'pending' &&
            event.pendingReason === 'PROVIDER_OFFLINE',
          'I4',
          step,
          () =>
            `${event.eventId} with offline provider is ${event.state}/${event.pendingReason}`,
        );
      } else if (extraction && extraction.status === 'unavailable') {
        // processing → honest pending revert, once the extraction settled.
        check(
          event.state === 'processing' ||
            (event.state === 'pending' &&
              event.pendingReason === extraction.reason),
          'I4',
          step,
          () =>
            `${event.eventId} extraction-unavailable but ${event.state}/${event.pendingReason}`,
        );
      } else if (extraction && extraction.status === 'throw') {
        check(
          event.state === 'processing' ||
            (event.state === 'pending' &&
              event.pendingReason ===
                `SESSION_CLIP_EXTRACTION_FAILED: ${extraction.message}`),
          'I4',
          step,
          () =>
            `${event.eventId} extraction threw but ${event.state}/${event.pendingReason}`,
        );
      } else if (!wasDispatched || stillPending) {
        check(
          event.state === 'processing',
          'I4',
          step,
          () => `${event.eventId} awaiting analysis but state ${event.state}`,
        );
      } else {
        switch (scripted.status) {
          case 'scored':
          case 'low_confidence':
            check(
              event.state === 'ready' && event.analysis === scripted.record,
              'I4',
              step,
              () =>
                `${event.eventId} scripted ${scripted.status} but ${event.state}`,
            );
            break;
          case 'abstained':
            check(
              event.state === 'abstained' &&
                event.abstainReason === scripted.reason,
              'I4',
              step,
              () =>
                `${event.eventId} scripted abstain ${scripted.reason} but ${event.state}/${event.abstainReason}`,
            );
            break;
          case 'pending':
            check(
              event.state === 'pending' &&
                event.pendingReason === scripted.reason,
              'I4',
              step,
              () =>
                `${event.eventId} scripted pending ${scripted.reason} but ${event.state}/${event.pendingReason}`,
            );
            break;
          case 'reject':
            check(
              event.state === 'abstained' &&
                event.abstainReason ===
                  `ANALYSIS_DISPATCH_FAILED: ${scripted.message}`,
              'I4',
              step,
              () =>
                `${event.eventId} scripted reject but ${event.state}/${event.abstainReason}`,
            );
            break;
        }
      }
    });

    // I7 / I8 / I9 / I10 — sweep every cue produced so far (new ones only).
    const recap = coach.recap();
    check(
      recap.cues.length === observedCues.length,
      'I9',
      step,
      () =>
        `recap has ${recap.cues.length} cues, onCue observed ${observedCues.length}`,
    );
    for (let i = cueModel.checkedCues; i < recap.cues.length; i++) {
      const cue = recap.cues[i]!;
      const context = cueEmitContext[i];
      check(
        context !== undefined,
        'I9',
        step,
        () => `cue ${i} has no emit context (harness bug)`,
      );
      check(
        cue.text.length > 0,
        'I10',
        step,
        () => `cue ${i} (${cue.category}) has empty text`,
      );
      check(
        !context!.coachEnded,
        'I8',
        step,
        () =>
          `cue ${i} (${cue.category} "${cue.text}") produced after coach ended`,
      );
      check(
        cue.spoken === context!.speakable,
        'I9',
        step,
        () =>
          `cue ${i} spoken=${cue.spoken} but speakable=${context!.speakable} (muted=${coach.isMuted()})`,
      );
      if (cue.eventId !== null) {
        const event = snapshot.events.find(
          entry => entry.eventId === cue.eventId,
        );
        check(
          event !== undefined,
          'I7',
          step,
          () => `cue for unknown event ${cue.eventId}`,
        );
        check(
          !consumedByCoach.has(cue.eventId),
          'I7',
          step,
          () => `event ${cue.eventId} spoken twice`,
        );
        consumedByCoach.add(cue.eventId);
        const kind = terminalKindOf(event!);
        check(
          kind !== null,
          'I7',
          step,
          () => `cue for ${cue.eventId} while state ${event!.state}`,
        );
        if (kind === 'scored') {
          check(
            SCORED_CATEGORIES.has(cue.category),
            'I7',
            step,
            () => `scored event ${cue.eventId} got ${cue.category}`,
          );
        } else {
          check(
            NO_READ_CATEGORIES.has(cue.category),
            'I7',
            step,
            () => `${kind} event ${cue.eventId} got ${cue.category}`,
          );
        }
        // I10 policy model.
        cueModel.repIndex += 1;
        if (kind !== 'scored') {
          cueModel.noReadStreak += 1;
          const expectSetup =
            cueModel.noReadStreak >= DEFAULT_LIVE_CUE_RULES.setupGuidanceAfter;
          check(
            (cue.category === 'SETUP_GUIDANCE') === expectSetup,
            'I10',
            step,
            () =>
              `no-read streak ${cueModel.noReadStreak} → ${cue.category} (expected setup=${expectSetup})`,
          );
          if (expectSetup) cueModel.noReadStreak = 0;
          check(
            cue.targetCheckpoint === null,
            'I10',
            step,
            () => `${cue.category} carries target ${cue.targetCheckpoint}`,
          );
        } else {
          cueModel.noReadStreak = 0;
          const score = event!.analysis!.result!.overallScore!;
          const previousBest = cueModel.bestOverall;
          const expectPersonalBest =
            previousBest !== null &&
            score > previousBest &&
            cueModel.repIndex >= DEFAULT_LIVE_CUE_RULES.personalBestMinRep;
          check(
            (cue.category === 'PERSONAL_BEST') === expectPersonalBest,
            'I10',
            step,
            () =>
              `${cue.category} at rep ${cueModel.repIndex} score ${score} prev best ${previousBest} (expected PB=${expectPersonalBest})`,
          );
          if (cue.category !== 'PERSONAL_BEST') {
            check(
              cue.text.startsWith(`${formatSpokenScore(score)}. `),
              'I10',
              step,
              () => `${cue.category} text "${cue.text}" lacks score ${score}`,
            );
          }
          cueModel.bestOverall =
            previousBest === null ? score : Math.max(previousBest, score);
          check(
            TARGETED_CATEGORIES.has(cue.category) ===
              (cue.targetCheckpoint !== null),
            'I10',
            step,
            () => `${cue.category} target=${cue.targetCheckpoint}`,
          );
          if (
            cue.category === 'CORRECTION' ||
            cue.category === 'REPEAT_CORRECTION'
          ) {
            const scripted = scriptedOutcome(event!.index);
            check(
              scripted.status === 'scored' &&
                scripted.worst.key === cue.targetCheckpoint &&
                scripted.worst.severity >=
                  DEFAULT_LIVE_CUE_RULES.correctionSeverity,
              'I10',
              step,
              () =>
                `${cue.category} targets ${cue.targetCheckpoint}; scripted worst ${JSON.stringify(
                  scripted.status === 'scored' ? scripted.worst : null,
                )}`,
            );
          }
        }
      } else {
        check(
          cue.category === 'SESSION_START' || cue.category === 'SESSION_END',
          'I7',
          step,
          () => `eventless cue with category ${cue.category}`,
        );
      }
    }
    cueModel.checkedCues = recap.cues.length;
    stats.cues = recap.cues.length;

    const endCues = recap.cues.filter(cue => cue.category === 'SESSION_END');
    check(
      endCues.length <= 1,
      'I8',
      step,
      () => `${endCues.length} SESSION_END cues`,
    );
    if (endCues.length === 1) {
      check(
        recap.cues.at(-1)?.category === 'SESSION_END',
        'I8',
        step,
        () => `SESSION_END is not the last cue: ${recap.cues.at(-1)?.category}`,
      );
    }
    check(
      recap.spokenCount === recap.cues.filter(cue => cue.spoken).length,
      'I9',
      step,
      () => `spokenCount ${recap.spokenCount} ≠ spoken cues`,
    );
    check(
      spokenTexts.length ===
        cueEmitContext.filter(context => context.portCalled).length,
      'I9',
      step,
      () =>
        `voice port received ${spokenTexts.length} texts, expected ${cueEmitContext.filter(context => context.portCalled).length}`,
    );

    // I11 progression.
    const progression = sessionScoreProgression(snapshot.events);
    check(
      progression.scoredCount +
        progression.noReadCount +
        progression.pendingCount ===
        snapshot.strokeCount,
      'I11',
      step,
      () =>
        `buckets ${progression.scoredCount}+${progression.noReadCount}+${progression.pendingCount} ≠ ${snapshot.strokeCount}`,
    );
    const expectedPoints = snapshot.events
      .filter(event => terminalKindOf(event) === 'scored')
      .map(event => ({
        eventId: event.eventId,
        eventIndex: event.index,
        endMs: event.endMs,
        score: event.analysis!.result!.overallScore!,
      }));
    check(
      JSON.stringify(progression.points) === JSON.stringify(expectedPoints),
      'I11',
      step,
      () =>
        `points ${JSON.stringify(progression.points)} ≠ ${JSON.stringify(expectedPoints)}`,
    );
    const n = expectedPoints.length;
    const window = n >= 6 ? 3 : n >= 4 ? 2 : 1;
    const mean = (items: typeof expectedPoints) =>
      Math.round((items.reduce((s, p) => s + p.score, 0) / items.length) * 10) /
      10;
    check(
      progression.windowSize === window &&
        progression.startAverage ===
          (n === 0 ? null : mean(expectedPoints.slice(0, window))) &&
        progression.endAverage ===
          (n === 0 ? null : mean(expectedPoints.slice(-window))) &&
        progression.delta ===
          (n >= 2
            ? Math.round(
                (progression.endAverage! - progression.startAverage!) * 10,
              ) / 10
            : null),
      'I11',
      step,
      () =>
        `window/averages mismatch: ${JSON.stringify({
          windowSize: progression.windowSize,
          startAverage: progression.startAverage,
          endAverage: progression.endAverage,
          delta: progression.delta,
        })} for scores ${JSON.stringify(expectedPoints.map(p => p.score))}`,
    );
    let expectedBest: (typeof expectedPoints)[number] | null = null;
    for (const point of expectedPoints) {
      if (expectedBest === null || point.score > expectedBest.score)
        expectedBest = point;
    }
    check(
      JSON.stringify(progression.best) === JSON.stringify(expectedBest),
      'I11',
      step,
      () =>
        `best ${JSON.stringify(progression.best)} ≠ ${JSON.stringify(expectedBest)}`,
    );

    // I12 summary round trip.
    const record = buildLiveSessionSummaryRecord(snapshot, progression, recap);
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
    check(
      JSON.stringify(parsed) === JSON.stringify(record),
      'I12',
      step,
      () =>
        `round trip differs: ${JSON.stringify(parsed)} vs ${JSON.stringify(record)}`,
    );
    check(
      record.cuesSpoken === recap.spokenCount,
      'I12',
      step,
      () =>
        `cuesSpoken ${record.cuesSpoken} ≠ spokenCount ${recap.spokenCount}`,
    );
    const correctionCues = recap.cues.filter(
      cue =>
        (cue.category === 'CORRECTION' ||
          cue.category === 'REPEAT_CORRECTION') &&
        cue.targetCheckpoint !== null,
    );
    const correctionTotal = Object.values(
      record.correctionsByCheckpoint,
    ).reduce((sum, count) => sum + count, 0);
    check(
      correctionTotal === correctionCues.length,
      'I12',
      step,
      () => `corrections sum ${correctionTotal} ≠ ${correctionCues.length}`,
    );
    const maxCorrection = Math.max(
      0,
      ...Object.values(record.correctionsByCheckpoint),
    );
    check(
      (record.topCorrection === null) === (correctionCues.length === 0) &&
        (record.topCorrection === null ||
          record.correctionsByCheckpoint[record.topCorrection] ===
            maxCorrection),
      'I12',
      step,
      () =>
        `topCorrection ${record.topCorrection} not an argmax of ${JSON.stringify(record.correctionsByCheckpoint)}`,
    );

    // I13 registries. `onUpdateFailures` is compared separately (I13b): the
    // registry is written BEFORE the subscriber runs (session.ts L610 vs
    // L613–L622), so a throwing subscriber leaves the registry one failure
    // behind until the next notify. Everything else must mirror exactly.
    if (flowEnded) {
      const registered = getCompletedSession(sessionId);
      const strip = (value: LiveSessionSnapshot | null) =>
        value === null ? null : { ...value, onUpdateFailures: undefined };
      check(
        JSON.stringify(strip(registered)) === JSON.stringify(strip(snapshot)),
        'I13',
        step,
        () => `completed-session registry out of sync with flow.snapshot()`,
      );
      stats.registryLagObserved =
        (stats.registryLagObserved ?? 0) +
        (registered !== null &&
        registered.onUpdateFailures !== snapshot.onUpdateFailures
          ? 1
          : 0);
    }
    if (recapAtEnd !== null) {
      check(
        JSON.stringify(getCompletedCoachRecap(sessionId)) ===
          JSON.stringify(recapAtEnd),
        'I13',
        step,
        () => `completed-recap registry differs from recap at sessionEnded()`,
      );
    }

    // I14 subscriber isolation.
    check(
      snapshot.onUpdateFailures === subscriberThrewCount,
      'I14',
      step,
      () =>
        `onUpdateFailures ${snapshot.onUpdateFailures} ≠ thrown ${subscriberThrewCount}`,
    );

    trace.push(
      `${step}:${snapshot.strokeCount}:${snapshot.droppedLateSamples}:${snapshot.durationMs}:` +
        `${snapshot.events.map(event => event.state[0]).join('')}:${recap.cues.length}:${recap.spokenCount}:` +
        `${digest(recap.cues.map(cue => [cue.category, cue.text, cue.eventId, cue.spoken]))}`,
    );
  };

  // The coach's onCue fires synchronously inside emit(); the speakable flags
  // and the ended mirror only change through their own (cue-free) actions,
  // so sampling them right after an action equals the value at emit time.
  let seenCues = 0;
  const syncCueContexts = () => {
    while (seenCues < observedCues.length) {
      cueEmitContext.push({
        speakable: speakableNow(),
        coachEnded: coachEndedAtEmit,
        portCalled: !coach.isMuted() && voiceAvailable,
      });
      seenCues += 1;
    }
  };

  const frameMs = plan.fractionalClock ? 1000 / 30 : 33;

  const stroke = (
    peak: number,
    riseMs: number,
    fallMs: number,
    step: number,
  ) => {
    const samples: SessionMotionSample[] = [];
    const stepMs = frameMs;
    let t = clock + stepMs;
    const riseSteps = Math.max(1, Math.round(riseMs / stepMs));
    const fallSteps = Math.max(1, Math.round(fallMs / stepMs));
    for (let i = 1; i <= riseSteps; i++) {
      samples.push({ tMs: t, v: 0.1 + (peak - 0.1) * (i / riseSteps) });
      t += stepMs;
    }
    for (let i = 1; i <= fallSteps; i++) {
      const frac = 1 - i / fallSteps;
      samples.push({ tMs: t, v: 0.08 + (peak - 0.08) * frac * frac });
      t += stepMs;
    }
    emitSeries(samples, step);
  };

  const quiet = (ms: number, level: number, step: number) => {
    const samples: SessionMotionSample[] = [];
    const stepMs = frameMs;
    let t = clock + stepMs;
    const count = Math.max(1, Math.round(ms / stepMs));
    for (let i = 0; i < count; i++) {
      samples.push({ tMs: t, v: level * (0.7 + (0.3 * ((i * 7) % 10)) / 10) });
      t += stepMs;
    }
    emitSeries(samples, step);
  };

  const malformedSample = (shape: MalformedShape): SessionMotionSample => {
    switch (shape) {
      case 'nan_t':
        return { tMs: Number.NaN, v: 1 };
      case 'inf_t':
        return { tMs: Number.POSITIVE_INFINITY, v: 1 };
      case 'neg_inf_t':
        return { tMs: Number.NEGATIVE_INFINITY, v: 1 };
      case 'nan_v':
        return { tMs: clock + 33, v: Number.NaN };
      case 'inf_v':
        return { tMs: clock + 33, v: Number.POSITIVE_INFINITY };
      case 'neg_v':
        return { tMs: clock + 33, v: -2.5 };
      case 'huge_v':
        return { tMs: clock + 33, v: 1e9 };
      case 'neg_t':
        return { tMs: -1, v: 1 };
    }
  };

  /** Feed one sample; after end() the contract is a throw (I1). */
  const feedGuarded = (sample: SessionMotionSample, step: number) => {
    if (!flowEnded) {
      push(sample);
      return;
    }
    stats.postEndPushes = (stats.postEndPushes ?? 0) + 1;
    let threw: unknown = null;
    try {
      flow.pushSample(sample);
    } catch (error) {
      threw = error;
    }
    check(
      threw instanceof Error && threw.message === EXPECTED_POST_END_MESSAGE,
      'I1',
      step,
      () =>
        `post-end pushSample did not throw the contract error (got ${String(threw)})`,
    );
  };

  let violation: InvariantViolation | null = null;
  let crash: string | null = null;
  let failingStep: number | null = null;

  const execute = async (action: Action, step: number) => {
    switch (action.kind) {
      case 'stroke':
        if (flowEnded) {
          feedGuarded({ tMs: clock + 33, v: action.peak }, step);
        } else {
          stroke(action.peak, action.riseMs, action.fallMs, step);
        }
        break;
      case 'quiet':
        if (flowEnded) feedGuarded({ tMs: clock + 33, v: action.level }, step);
        else quiet(action.ms, action.level, step);
        break;
      case 'gap':
        clock += action.ms;
        break;
      case 'duplicateLast':
        stats.duplicates = (stats.duplicates ?? 0) + 1;
        feedGuarded(lastSample ?? { tMs: clock + 33, v: 0.1 }, step);
        break;
      case 'lateSample':
        stats.lateSamples = (stats.lateSamples ?? 0) + 1;
        feedGuarded({ tMs: clock - action.backMs, v: action.v }, step);
        break;
      case 'malformed':
        stats.malformed = (stats.malformed ?? 0) + 1;
        feedGuarded(malformedSample(action.shape), step);
        break;
      case 'resolve':
        await resolveSome(action.which, action.pick);
        break;
      case 'resolveAll':
        await resolveEverything();
        break;
      case 'replaySnapshot': {
        stats.replays = (stats.replays ?? 0) + 1;
        const current = flow.snapshot();
        let replayed: LiveSessionSnapshot = current;
        if (action.which === 'stale' && snapshotHistory.length > 0) {
          replayed = snapshotHistory[Math.floor(snapshotHistory.length / 2)]!;
        } else if (action.which === 'reversed') {
          replayed = { ...current, events: [...current.events].reverse() };
        }
        coach.consumeSnapshot(replayed);
        break;
      }
      case 'setMuted':
        coach.setMuted(action.muted);
        break;
      case 'voiceAvailable':
        voiceAvailable = action.available;
        break;
      case 'voiceRefuse':
        voiceRefuses = action.refuse;
        break;
      case 'subscriberThrows':
        subscriberThrows = action.on;
        break;
      case 'coachStart':
        coach.sessionStarted(plan.source);
        break;
      case 'end': {
        const before = flow.snapshot();
        const result = flow.end();
        if (flowEnded) {
          // I15: idempotent second end().
          check(
            JSON.stringify(result) === JSON.stringify(before),
            'I15',
            step,
            () => 'second end() changed the snapshot',
          );
        }
        flowEnded = true;
        break;
      }
      case 'pushAfterEnd':
        if (flowEnded) feedGuarded({ tMs: clock + 33, v: 1.2 }, step);
        else push({ tMs: clock + 33, v: 1.2 });
        break;
      case 'coachEnd': {
        const recap = coach.sessionEnded(flow.snapshot());
        syncCueContexts();
        if (!coachEnded) recapAtEnd = recap;
        coachEnded = true;
        coachEndedAtEmit = true;
        break;
      }
      case 'dispose':
        coach.dispose();
        syncCueContexts();
        coachEnded = true;
        coachEndedAtEmit = true;
        break;
    }
  };

  try {
    // Every session begins with the start line (screen mount).
    coach.sessionStarted(plan.source);
    syncCueContexts();
    checkFull(0);
    for (let i = 0; i < plan.actions.length; i++) {
      const step = i + 1;
      const action = plan.actions[i]!;
      // Cue contexts must be captured at emit time: cues are emitted
      // synchronously inside the action (push → notify → consumeSnapshot →
      // emit), and the speakable flags only change through separate actions,
      // so the flags observed right after the action equal those at emit.
      await execute(action, step);
      syncCueContexts();
      snapshotHistory.push(flow.snapshot());
      if (snapshotHistory.length > 40)
        snapshotHistory = snapshotHistory.slice(-40);
      if (step % checkEvery === 0 || i === plan.actions.length - 1) {
        checkFull(step);
      }
      stats.steps = step;
    }
    // Epilogue: finish the session the way the screen does.
    const epilogue = plan.actions.length + 1;
    if (!flowEnded) {
      flow.end();
      flowEnded = true;
    }
    await resolveEverything();
    await flow.settled();
    syncCueContexts();
    checkFull(epilogue);
    if (!coachEnded) {
      recapAtEnd = coach.sessionEnded(flow.snapshot());
      syncCueContexts();
      coachEnded = true;
      coachEndedAtEmit = true;
    }
    checkFull(epilogue + 1);
    // Post-end: late snapshots must be silently ignored (I8).
    coach.consumeSnapshot(flow.snapshot());
    coach.consumeSnapshot({
      ...flow.snapshot(),
      events: [...flow.snapshot().events].reverse(),
    });
    syncCueContexts();
    checkFull(epilogue + 2);
  } catch (error) {
    if (error instanceof InvariantViolation) {
      violation = error;
      failingStep = error.step;
    } else {
      crash =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      failingStep = stats.steps ?? 0;
    }
  }

  // Never leave dangling dispatches behind (they would hold the worker).
  while (clipPending.length > 0) resolveClip(clipPending.shift()!);
  await flushMicrotasks();
  while (pending.length > 0) resolveDispatch(pending.shift()!);
  await flushMicrotasks();
  await flow.settled().catch(() => undefined);

  return {
    seed,
    length: plan.actions.length,
    violation,
    crash,
    failingStep,
    trace,
    traceDigest: digest(trace),
    stats,
  };
}

/** Plan with a replaced action list (for minimization). */
export function withActions(plan: Plan, actions: readonly Action[]): Plan {
  return { ...plan, actions: [...actions] };
}

export function failureLabel(result: RunResult): string | null {
  if (result.violation) return result.violation.invariant;
  if (result.crash) return `CRASH:${result.crash}`;
  return null;
}
