/**
 * CONCURRENCY STRESS — LiveSessionCoach (src/flow/liveSessionCoach.ts) fed by
 * (A) seeded synthetic snapshot streams and (B) the REAL LiveSessionFlow +
 * SessionEventEngine with a provider whose analyses settle in a seeded order.
 *
 * Perturbations: out-of-order terminal settlement, duplicate snapshot
 * delivery, stale (older) snapshots re-delivered, events shuffled inside a
 * snapshot, non-monotonic session clocks (skew), voice availability flips,
 * mute toggles, a port that deliberately suppresses cues, a second coach on
 * the same session id (remount / two actors), sessionEnded() before the
 * analyses settle (stop mid-flight), dispose() before sessionEnded(),
 * sessionEnded() twice, a throwing UI subscriber, samples after end(),
 * end() twice, providers that throw or leave events pending.
 *
 * Invariants — synthetic stream (C*), real flow (F*):
 *   C1 idempotent: each eventId is cued at most once
 *   C2 nothing fabricated: cued eventIds were terminal before the end
 *   C3 nothing lost: every event terminal before the end was cued
 *   C4 quiet after end: no cue after sessionEnded()/dispose(); recap frozen
 *   C5 structure: SESSION_START first, exactly one SESSION_END (last) when
 *      sessionEnded() ran before dispose()
 *   C6 `spoken` is the truth: spokenCount == speak() calls that voiced
 *   C7 onCue observer log ≡ recap.cues
 *   C8 atMs comes from a delivered snapshot clock
 *   C9 registry: getCompletedCoachRecap == recap of the last coach that ended
 *   C10 doc contract "spoken … in event order": cue eventIds ascend
 *   C11 replay determinism
 *   C12 second actor (same session id) obeys C1–C3 for its own window
 *   F1 bounded settle (no deadlock)   F2 final states match the plan,
 *   no 'processing' left              F3 registry events ≡ snapshot events
 *   F3b registry byte-identical to snapshot (incl. onUpdateFailures)
 *   F4 coach cues ≡ terminal events (no dup, no loss, none after end)
 *   F5 progression counts ≡ states, order-independent
 *   F6 summary record JSON round-trip is lossless
 *   F7 end() is idempotent; pushSample() after end() throws
 *   F8 replay determinism             F9 doc contract "in event order" (real engine)
 *   F10 successive snapshots append-only; terminal events never rewritten
 *
 * Campaign size: STRESS_ITER (default 60; the full run uses 500).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type LiveCoachRecap,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import {
  ResultsTable,
  SeededScheduler,
  Violations,
  campaignSeeds,
  canonicalJson,
  describeViolations,
  firstDifference,
  flushMicrotasks,
  mulberry32,
  withDeadline,
  type Rng,
} from './liveCourtStress.support.test';

const DEFAULT_ITERATIONS = 60;
const DEADLINE_MS = 15_000;

const CHECKPOINT_POOL: CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'contact_position',
  'follow_through',
  'recovery',
];
const DIRECTION_POOL: FaultDirection[] = [
  'late',
  'early',
  'high',
  'low',
  'none',
  'unstable',
];

// ─── Analysis record builders (same shape the existing coach tests use) ─────

function randomCheckpoints(rng: Rng) {
  const count = rng.int(1, 3);
  return rng
    .shuffle(CHECKPOINT_POOL)
    .slice(0, count)
    .map(key => {
      const severity = rng.chance(0.5) ? Math.round(rng.next() * 100) / 100 : 0;
      return {
        key,
        score: rng.chance(0.1) ? null : rng.int(20, 100),
        confidence: 0.9,
        band: 'yellow' as const,
        direction: severity > 0 ? rng.pick(DIRECTION_POOL) : ('none' as const),
        severity,
        applicable: rng.chance(0.9),
      };
    });
}

function scoredAnalysis(rng: Rng, overallScore: number | null): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    result: {
      resultKind: 'scored',
      overallScore,
      checkpoints: randomCheckpoints(rng),
    },
  } as unknown as AnalysisRecord;
}

function lowConfidenceAnalysis(rng: Rng): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: randomCheckpoints(rng),
    },
  } as unknown as AnalysisRecord;
}

function randomScore(rng: Rng): number {
  return Math.round(rng.int(20, 100)) / 10; // 2.0 .. 10.0, one decimal
}

// ─── Instrumented voice port ────────────────────────────────────────────────

interface VoiceHarness {
  port: CoachVoicePort;
  available: boolean;
  suppressNext: boolean;
  /** Every speak() call: whether the port reported it as voiced. */
  calls: Array<{ text: string; voiced: boolean }>;
  stops: number;
}

function makeVoice(): VoiceHarness {
  const harness: VoiceHarness = {
    available: true,
    suppressNext: false,
    calls: [],
    stops: 0,
    port: {
      available: () => harness.available,
      speak: text => {
        const voiced = !harness.suppressNext;
        harness.calls.push({ text, voiced });
        harness.suppressNext = false;
        return voiced ? undefined : false;
      },
      stop: () => {
        harness.stops += 1;
      },
    },
  };
  return harness;
}

/** A coach plus everything the invariants need to know about its history. */
interface Actor {
  name: string;
  coach: LiveSessionCoach;
  voice: VoiceHarness;
  hud: SpokenCue[];
  /** eventIds that were terminal in a snapshot delivered BEFORE the actor ended. */
  terminalBeforeEnd: Set<string>;
  ended: boolean;
  endedVia: 'sessionEnded' | 'dispose' | null;
  cuesAtEnd: number;
  recapAtEnd: string | null;
  deliveredClocks: Set<number>;
}

function makeActor(name: string, source: 'live' | 'replay'): Actor {
  const voice = makeVoice();
  const hud: SpokenCue[] = [];
  const coach = new LiveSessionCoach({
    voice: voice.port,
    onCue: cue => hud.push(cue),
  });
  coach.sessionStarted(source);
  return {
    name,
    coach,
    voice,
    hud,
    terminalBeforeEnd: new Set(),
    ended: false,
    endedVia: null,
    cuesAtEnd: 0,
    recapAtEnd: null,
    deliveredClocks: new Set(),
  };
}

function isTerminalView(event: SessionEventView): boolean {
  return event.state === 'ready' || event.state === 'abstained';
}

function deliver(actor: Actor, snapshot: LiveSessionSnapshot): void {
  if (!actor.ended) {
    for (const event of snapshot.events) {
      if (isTerminalView(event)) actor.terminalBeforeEnd.add(event.eventId);
    }
    actor.deliveredClocks.add(snapshot.durationMs);
  }
  actor.coach.consumeSnapshot(snapshot);
}

function endActor(
  actor: Actor,
  snapshot: LiveSessionSnapshot,
  via: 'sessionEnded' | 'dispose',
): void {
  if (via === 'dispose') actor.coach.dispose();
  else actor.coach.sessionEnded(snapshot);
  if (!actor.ended) {
    actor.ended = true;
    actor.endedVia = via;
    actor.cuesAtEnd = actor.coach.recap().cues.length;
    actor.recapAtEnd = canonicalJson(actor.coach.recap());
  }
}

function eventIndexOf(eventId: string): number {
  return Number(eventId.slice(1));
}

/** Shared C1–C8 + C10 checks for one actor. `prefix` distinguishes the second
 * actor (C12) so the two never mask each other. */
function checkActor(
  actor: Actor,
  violations: Violations,
  prefix: string,
): void {
  const recap = actor.coach.recap();
  const eventCues = recap.cues.filter(cue => cue.eventId !== null);
  const cuedIds = eventCues.map(cue => cue.eventId as string);
  const id = (inv: string): string => (prefix ? `${prefix}` : inv);

  violations.check(
    id('C1'),
    new Set(cuedIds).size === cuedIds.length,
    () =>
      `${actor.name}: an event was cued more than once: ${cuedIds.join(',')}`,
  );
  const fabricated = cuedIds.filter(
    eventId => !actor.terminalBeforeEnd.has(eventId),
  );
  violations.check(
    id('C2'),
    fabricated.length === 0,
    () =>
      `${actor.name}: cued events never terminal before end: ${fabricated.join(',')}`,
  );
  const lost = [...actor.terminalBeforeEnd].filter(
    eventId => !cuedIds.includes(eventId),
  );
  violations.check(
    id('C3'),
    lost.length === 0,
    () =>
      `${actor.name}: terminal-before-end events never cued: ${lost.join(',')}`,
  );
  if (actor.ended) {
    violations.check(
      id('C4'),
      recap.cues.length === actor.cuesAtEnd &&
        canonicalJson(recap) === actor.recapAtEnd,
      () =>
        `${actor.name}: ${recap.cues.length - actor.cuesAtEnd} cue(s) after end / recap changed`,
    );
  }
  if (prefix) return; // C5–C10 are asserted on the primary actor only.

  violations.check(
    'C5',
    recap.cues[0]?.category === 'SESSION_START',
    () => `first cue ${recap.cues[0]?.category}`,
  );
  const ends = recap.cues.filter(cue => cue.category === 'SESSION_END');
  if (actor.endedVia === 'sessionEnded') {
    violations.check(
      'C5',
      ends.length === 1 && recap.cues.at(-1)?.category === 'SESSION_END',
      () =>
        `${ends.length} SESSION_END cue(s); last=${recap.cues.at(-1)?.category}`,
    );
  } else {
    violations.check(
      'C5',
      ends.length === 0,
      () => `SESSION_END emitted after dispose()`,
    );
  }
  const voiced = actor.voice.calls.filter(call => call.voiced).length;
  violations.check(
    'C6',
    recap.spokenCount === voiced &&
      recap.cues.filter(cue => cue.spoken).length === voiced,
    () => `spokenCount ${recap.spokenCount} ≠ voiced speak() calls ${voiced}`,
  );
  violations.check(
    'C7',
    canonicalJson(actor.hud) === canonicalJson(recap.cues),
    () =>
      `HUD observer saw ${actor.hud.length} cues, recap has ${recap.cues.length}`,
  );
  violations.check(
    'C8',
    eventCues.every(cue => actor.deliveredClocks.has(cue.atMs)),
    () => `a cue carries atMs not from any delivered snapshot`,
  );
  const indexes = cuedIds.map(eventIndexOf);
  violations.check(
    'C10',
    indexes.every((index, i) => i === 0 || index > (indexes[i - 1] as number)),
    () => `cue order by event: [${cuedIds.join(', ')}]`,
  );
}

// ─── Part A: synthetic snapshot streams ─────────────────────────────────────

type PlannedKind =
  | 'scored'
  | 'low'
  | 'abstained'
  | 'never'
  | 'ready_null_analysis'
  | 'scored_null_score';

interface SyntheticEvent {
  index: number;
  eventId: string;
  kind: PlannedKind;
  analysis: AnalysisRecord | null;
}

function planEvent(rng: Rng, index: number): SyntheticEvent {
  const roll = rng.next();
  const kind: PlannedKind =
    roll < 0.55
      ? 'scored'
      : roll < 0.67
        ? 'low'
        : roll < 0.77
          ? 'abstained'
          : roll < 0.87
            ? 'never'
            : roll < 0.93
              ? 'ready_null_analysis'
              : 'scored_null_score';
  const analysis =
    kind === 'scored'
      ? scoredAnalysis(rng, randomScore(rng))
      : kind === 'low'
        ? lowConfidenceAnalysis(rng)
        : kind === 'scored_null_score'
          ? scoredAnalysis(rng, null)
          : null;
  return { index, eventId: `E${index + 1}`, kind, analysis };
}

function viewFor(event: SyntheticEvent, stage: 0 | 1 | 2): SessionEventView {
  const state =
    stage === 0
      ? 'pending'
      : stage === 1
        ? 'processing'
        : event.kind === 'abstained'
          ? 'abstained'
          : event.kind === 'never'
            ? 'processing'
            : 'ready';
  return {
    eventId: event.eventId,
    index: event.index,
    startMs: event.index * 1000,
    endMs: event.index * 1000 + 400,
    peakMs: event.index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: event.index * 1000 + 600,
    state,
    pendingReason: null,
    abstainReason: state === 'abstained' ? 'POSE_TOO_SPARSE' : null,
    analysis: state === 'ready' ? event.analysis : null,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
  };
}

interface SyntheticTrace {
  recapA: string;
  recapB: string | null;
  registry: string;
  eventViewsDelivered: number;
  snapshotsDelivered: number;
  events: number;
}

function runSyntheticStream(
  seed: number,
  violations: Violations,
): SyntheticTrace {
  const rng = mulberry32(seed);
  const sessionId = `syn-${seed}`;
  const eventCount = rng.int(6, 40);
  const events = Array.from({ length: eventCount }, (_, i) =>
    planEvent(rng, i),
  );

  // Three lifecycle tokens per event (close → processing → terminal), shuffled;
  // the k-th appearance of an event is its k-th stage, so order is always legal
  // per event while the interleaving across events is arbitrary.
  const tokens = rng.shuffle(
    events.flatMap(event => [event.index, event.index, event.index]),
  );
  const stage = new Map<number, 0 | 1 | 2>();
  const closed: SyntheticEvent[] = [];
  const snapshots: LiveSessionSnapshot[] = [];
  let clock = 0;
  for (const index of tokens) {
    const current = stage.get(index);
    const nextStage: 0 | 1 | 2 =
      current === undefined ? 0 : current === 0 ? 1 : 2;
    stage.set(index, nextStage);
    if (nextStage === 0) closed.push(events[index] as SyntheticEvent);
    // Session clock: mostly monotonic, occasionally skewed backwards.
    clock = rng.chance(0.1)
      ? Math.max(0, clock - rng.int(1, 500))
      : clock + rng.int(30, 400);
    const views = closed.map(event =>
      viewFor(event, stage.get(event.index) as 0 | 1 | 2),
    );
    snapshots.push({
      sessionId,
      phase: 'running',
      source: 'live',
      startedAtIso: '2026-09-05T00:00:00.000Z',
      durationMs: clock,
      strokeCount: views.length,
      events: rng.chance(0.25) ? rng.shuffle(views) : views,
      distribution: [],
      qualityNotes: [],
      droppedLateSamples: 0,
      onUpdateFailures: 0,
      engineVersion: 'stress-engine',
      analysisProviderId: 'stress-provider',
    });
  }

  const endAt = rng.chance(0.5)
    ? snapshots.length
    : rng.int(Math.ceil(snapshots.length * 0.3), snapshots.length);
  const endMode = rng.pick([
    'sessionEnded',
    'sessionEnded',
    'sessionEnded',
    'dispose_then_end',
    'end_twice',
  ] as const);
  const actorA = makeActor('A', 'live');
  const secondActorAt = rng.chance(0.3)
    ? rng.int(0, Math.max(0, endAt - 1))
    : null;
  let actorB: Actor | null = null;

  let eventViewsDelivered = 0;
  let snapshotsDelivered = 0;
  const deliverAll = (snapshot: LiveSessionSnapshot): void => {
    snapshotsDelivered += 1;
    eventViewsDelivered += snapshot.events.length;
    deliver(actorA, snapshot);
    if (actorB) deliver(actorB, snapshot);
  };

  for (let step = 0; step < snapshots.length; step += 1) {
    if (step === endAt) {
      const finalSnapshot = snapshots[step - 1] ?? snapshots[0];
      endAll(finalSnapshot as LiveSessionSnapshot);
    }
    if (secondActorAt === step) actorB = makeActor('B', 'live');
    // Actor-side perturbations between deliveries.
    if (rng.chance(0.05)) actorA.voice.available = !actorA.voice.available;
    if (rng.chance(0.05)) actorA.coach.setMuted(!actorA.coach.isMuted());
    if (rng.chance(0.1)) actorA.voice.suppressNext = true;

    const snapshot = snapshots[step] as LiveSessionSnapshot;
    deliverAll(snapshot);
    if (rng.chance(0.2)) deliverAll(snapshot); // duplicate delivery
    if (rng.chance(0.15) && step > 0)
      deliverAll(snapshots[rng.int(0, step - 1)] as LiveSessionSnapshot); // stale re-delivery
  }
  if (endAt >= snapshots.length)
    endAll(snapshots.at(-1) as LiveSessionSnapshot);
  // Late settlement after the end: a few more snapshots must be ignored.
  for (let i = 0; i < 3; i += 1)
    deliverAll(
      snapshots[rng.int(0, snapshots.length - 1)] as LiveSessionSnapshot,
    );

  function endAll(finalSnapshot: LiveSessionSnapshot): void {
    if (endMode === 'dispose_then_end') {
      endActor(actorA, finalSnapshot, 'dispose');
      actorA.coach.sessionEnded(finalSnapshot);
    } else {
      endActor(actorA, finalSnapshot, 'sessionEnded');
      if (endMode === 'end_twice') actorA.coach.sessionEnded(finalSnapshot);
    }
    if (actorB) endActor(actorB, finalSnapshot, 'sessionEnded');
  }

  checkActor(actorA, violations, '');
  if (actorB) checkActor(actorB, violations, 'C12');

  // C9 — registry holds the recap of the last coach that ended via sessionEnded().
  const registry = getCompletedCoachRecap(sessionId);
  const expectedRegistry: LiveCoachRecap | null = actorB
    ? actorB.coach.recap()
    : actorA.endedVia === 'sessionEnded'
      ? actorA.coach.recap()
      : null;
  violations.check(
    'C9',
    canonicalJson(registry) === canonicalJson(expectedRegistry),
    () =>
      `registry recap ${registry ? `${registry.cues.length} cues` : 'null'} ≠ expected ` +
      `${expectedRegistry ? `${expectedRegistry.cues.length} cues` : 'null'} (endMode=${endMode})`,
  );
  if (endMode === 'dispose_then_end' && !actorB) {
    // Observation (not an invariant): dispose() before sessionEnded() leaves
    // no recap in the registry — LiveSummary would read null.
    violations.check(
      'OBS-dispose-first-registry',
      registry !== null,
      () =>
        `dispose() then sessionEnded(): getCompletedCoachRecap('${sessionId}') is null; recap has ${actorA.coach.recap().cues.length} cues`,
    );
  }

  return {
    recapA: canonicalJson(actorA.coach.recap()),
    recapB: actorB ? canonicalJson(actorB.coach.recap()) : null,
    registry: canonicalJson(registry),
    eventViewsDelivered,
    snapshotsDelivered,
    events: eventCount,
  };
}

// ─── Part B: real LiveSessionFlow + seeded settlement ───────────────────────

type FlowPlan = 'scored' | 'low' | 'abstained' | 'pending' | 'throw';

interface FlowTrace {
  snapshot: string;
  recap: string;
  schedulerTrace: string[];
  strokeEvents: number;
  samplesPushed: number;
  snapshotsDelivered: number;
}

function planFor(rng: Rng): FlowPlan {
  const roll = rng.next();
  return roll < 0.6
    ? 'scored'
    : roll < 0.7
      ? 'low'
      : roll < 0.8
        ? 'abstained'
        : roll < 0.9
          ? 'pending'
          : 'throw';
}

async function runRealFlow(
  seed: number,
  violations: Violations,
): Promise<FlowTrace> {
  const rng = mulberry32(seed);
  const scheduler = new SeededScheduler(rng);
  const sessionId = `flow-${seed}`;
  const rallies = rng.int(1, 4);
  const rallyMs =
    (DEV_REPLAY_RALLY.samples.at(-1) as { tMs: number }).tMs + 700;
  const plans = new Map<string, FlowPlan>();
  const planOf = (eventId: string): FlowPlan => {
    let plan = plans.get(eventId);
    if (!plan) {
      plan = planFor(rng);
      plans.set(eventId, plan);
    }
    return plan;
  };
  const outcomeRng = mulberry32(seed ^ 0x9e3779b9);

  const provider: SessionEventAnalysisProvider = {
    providerId: 'stress-seeded-provider',
    availability: () => ({ status: 'available' }),
    analyzeEvent: request =>
      scheduler.gate(
        `analyze:${request.eventId}`,
        (): SessionEventAnalysisOutcome => {
          const plan = planOf(request.eventId);
          switch (plan) {
            case 'scored':
              return {
                status: 'ready',
                analysis: scoredAnalysis(outcomeRng, randomScore(outcomeRng)),
              };
            case 'low':
              return {
                status: 'ready',
                analysis: lowConfidenceAnalysis(outcomeRng),
              };
            case 'abstained':
              return { status: 'abstained', abstainReason: 'POSE_TOO_SPARSE' };
            case 'pending':
              return { status: 'pending', pendingReason: 'CLIP_NOT_READY' };
            case 'throw':
              throw new Error(`provider crashed on ${request.eventId}`);
          }
        },
      ),
  };

  const actor = makeActor('flow', 'replay');
  let snapshotsDelivered = 0;
  let subscriberThrows = 0;
  let previous: LiveSessionSnapshot | null = null;
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'replay',
    provider,
    onUpdate: next => {
      snapshotsDelivered += 1;
      // F10 — append-only, monotone settlement across successive snapshots.
      if (previous) {
        const prev = previous;
        violations.check(
          'F10',
          next.events.length >= prev.events.length,
          () => `events shrank ${prev.events.length} → ${next.events.length}`,
        );
        prev.events.forEach((before, i) => {
          const after = next.events[i];
          violations.check(
            'F10',
            after !== undefined &&
              after.eventId === before.eventId &&
              after.index === before.index,
            () =>
              `event #${i} changed identity ${before.eventId} → ${after?.eventId}`,
          );
          if (after && isTerminalView(before)) {
            violations.check(
              'F10',
              after.state === before.state &&
                canonicalJson(after.analysis) ===
                  canonicalJson(before.analysis) &&
                after.abstainReason === before.abstainReason,
              () =>
                `${before.eventId} rewritten after terminal: ${before.state} → ${after.state}`,
            );
          }
        });
        violations.check(
          'F10',
          prev.phase !== 'ended' || next.phase === 'ended',
          () => `phase left 'ended': ${next.phase}`,
        );
      }
      previous = next;
      deliver(actor, next);
      if (rng.chance(0.1)) {
        subscriberThrows += 1;
        throw new Error('UI subscriber failed');
      }
    },
  });

  const stopEarlyAt = rng.chance(0.2)
    ? rng.int(10, rallies * DEV_REPLAY_RALLY.samples.length - 1)
    : null;
  const coachEndsBeforeSettle = rng.chance(0.4);
  let samplesPushed = 0;
  let endedEarly = false;
  let lateSampleThrew = 0;
  let lateSampleAttempts = 0;
  let strokeCountAtEnd = -1;

  outer: for (let r = 0; r < rallies; r += 1) {
    for (const sample of DEV_REPLAY_RALLY.samples) {
      const shifted = { tMs: sample.tMs + r * rallyMs, v: sample.v };
      if (stopEarlyAt !== null && samplesPushed === stopEarlyAt) {
        // Pause/stop mid-rally: end() now, then late native emissions arrive.
        strokeCountAtEnd = flow.end().strokeCount;
        endedEarly = true;
        for (let k = 0; k < 3; k += 1) {
          lateSampleAttempts += 1;
          try {
            flow.pushSample(shifted);
          } catch {
            lateSampleThrew += 1;
          }
        }
        break outer;
      }
      flow.pushSample(shifted);
      samplesPushed += 1;
      // Some analyses settle while strokes are still closing (call-during-call).
      if (rng.chance(0.05) && scheduler.pendingCount() > 0)
        await scheduler.drain();
    }
  }
  const endSnapshot = flow.end();
  if (!endedEarly) strokeCountAtEnd = endSnapshot.strokeCount;
  const secondEnd = flow.end();
  violations.check(
    'F7',
    secondEnd.phase === 'ended' &&
      canonicalJson(secondEnd) === canonicalJson(flow.snapshot()),
    () => `second end() returned a different snapshot`,
  );
  violations.check(
    'F7',
    lateSampleThrew === lateSampleAttempts,
    () =>
      `${lateSampleAttempts - lateSampleThrew} late pushSample() call(s) accepted after end()`,
  );

  if (coachEndsBeforeSettle) endActor(actor, flow.snapshot(), 'sessionEnded');

  // Settle everything under a wall-time bound.
  const drainAll = (async () => {
    do {
      await scheduler.drain();
      await flushMicrotasks();
    } while (scheduler.pendingCount() > 0);
  })();
  try {
    await withDeadline(
      `seed ${seed} flow settle`,
      DEADLINE_MS,
      Promise.all([drainAll, flow.settled()]),
    );
  } catch (error) {
    violations.fail(
      'F1',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!coachEndsBeforeSettle) endActor(actor, flow.snapshot(), 'sessionEnded');

  const final = flow.snapshot();

  // F2 — every event landed where its plan says; nothing stuck processing.
  violations.check(
    'F2',
    final.strokeCount === strokeCountAtEnd,
    () =>
      `strokeCount moved after end(): ${strokeCountAtEnd} → ${final.strokeCount}`,
  );
  for (const event of final.events) {
    const plan = plans.get(event.eventId) ?? null;
    const expectedState =
      plan === null
        ? 'never-dispatched'
        : plan === 'scored' || plan === 'low'
          ? 'ready'
          : plan === 'pending'
            ? 'pending'
            : 'abstained';
    violations.check(
      'F2',
      expectedState === 'never-dispatched'
        ? false
        : event.state === expectedState,
      () =>
        `${event.eventId} plan=${plan} state=${event.state} (expected ${expectedState})`,
    );
    if (plan === 'throw') {
      violations.check(
        'F2',
        (event.abstainReason ?? '').startsWith('ANALYSIS_DISPATCH_FAILED'),
        () => `${event.eventId} threw but abstainReason=${event.abstainReason}`,
      );
    }
    if (plan === 'pending') {
      violations.check(
        'F2',
        event.pendingReason === 'CLIP_NOT_READY',
        () => `${event.eventId} pendingReason=${event.pendingReason}`,
      );
    }
    if (event.state === 'ready') {
      violations.check(
        'F2',
        event.analysis !== null,
        () => `${event.eventId} ready without analysis`,
      );
    }
  }
  violations.check(
    'F2',
    final.onUpdateFailures === subscriberThrows,
    () =>
      `onUpdateFailures ${final.onUpdateFailures} ≠ subscriber throws ${subscriberThrows}`,
  );

  // F3 — registry mirrors the live snapshot after late settlement.
  const registrySnapshot = getCompletedSession(sessionId);
  violations.check(
    'F3',
    registrySnapshot !== null &&
      registrySnapshot.phase === 'ended' &&
      registrySnapshot.strokeCount === final.strokeCount &&
      canonicalJson(registrySnapshot.events) === canonicalJson(final.events),
    () =>
      `getCompletedSession events differ from flow.snapshot(): ${firstDifference(canonicalJson(registrySnapshot?.events), canonicalJson(final.events))}`,
  );
  violations.check(
    'F3b',
    canonicalJson(registrySnapshot) === canonicalJson(final),
    () =>
      `getCompletedSession differs from flow.snapshot(): ${firstDifference(canonicalJson(registrySnapshot), canonicalJson(final))}`,
  );

  // F4 — coach ≡ terminal events.
  const recap = actor.coach.recap();
  const cuedIds = recap.cues
    .filter(cue => cue.eventId !== null)
    .map(cue => cue.eventId as string);
  violations.check(
    'F4',
    new Set(cuedIds).size === cuedIds.length,
    () => `duplicate cue: ${cuedIds.join(',')}`,
  );
  const fabricated = cuedIds.filter(
    eventId => !actor.terminalBeforeEnd.has(eventId),
  );
  violations.check(
    'F4',
    fabricated.length === 0,
    () => `cued before terminal: ${fabricated.join(',')}`,
  );
  const lost = [...actor.terminalBeforeEnd].filter(
    eventId => !cuedIds.includes(eventId),
  );
  violations.check(
    'F4',
    lost.length === 0,
    () => `terminal but never cued: ${lost.join(',')}`,
  );
  violations.check(
    'F4',
    recap.cues.length === actor.cuesAtEnd,
    () => `${recap.cues.length - actor.cuesAtEnd} cue(s) after sessionEnded()`,
  );
  const cuedIndexes = cuedIds.map(eventIndexOf);
  violations.check(
    'F9',
    cuedIndexes.every(
      (index, i) => i === 0 || index > (cuedIndexes[i - 1] as number),
    ),
    () => `real-engine cue order by event: [${cuedIds.join(', ')}]`,
  );
  if (!coachEndsBeforeSettle) {
    const terminal = final.events
      .filter(isTerminalView)
      .map(event => event.eventId)
      .sort();
    violations.check(
      'F4',
      canonicalJson([...cuedIds].sort()) === canonicalJson(terminal),
      () => `cued ${cuedIds.length} ≠ terminal ${terminal.length}`,
    );
  }

  // F5 — progression counts and order independence.
  const progression = sessionScoreProgression(final.events);
  const scoredEvents = final.events.filter(
    event =>
      event.state === 'ready' &&
      event.analysis?.result?.resultKind === 'scored',
  ).length;
  const lowEvents = final.events.filter(
    event =>
      event.state === 'ready' &&
      event.analysis?.result?.resultKind === 'low_confidence',
  ).length;
  const abstained = final.events.filter(
    event => event.state === 'abstained',
  ).length;
  const pending = final.events.filter(
    event => event.state === 'pending' || event.state === 'processing',
  ).length;
  violations.check(
    'F5',
    progression.scoredCount === scoredEvents &&
      progression.noReadCount === lowEvents + abstained &&
      progression.pendingCount === pending,
    () =>
      `progression ${progression.scoredCount}/${progression.noReadCount}/${progression.pendingCount} ≠ ` +
      `${scoredEvents}/${lowEvents + abstained}/${pending}`,
  );
  violations.check(
    'F5',
    progression.points.every(
      (p, i) =>
        i === 0 ||
        p.eventIndex >
          (progression.points[i - 1] as { eventIndex: number }).eventIndex,
    ),
    () => `points not in event order`,
  );
  violations.check(
    'F5',
    canonicalJson(sessionScoreProgression(rng.shuffle(final.events))) ===
      canonicalJson(progression),
    () => `progression depends on event array order`,
  );

  // F6 — durable summary round trip.
  const record = buildLiveSessionSummaryRecord(final, progression, recap);
  const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
  violations.check(
    'F6',
    canonicalJson(parsed) === canonicalJson(record),
    () =>
      `summary round-trip changed: ${canonicalJson(parsed)} vs ${canonicalJson(record)}`,
  );
  violations.check(
    'F6',
    record.cuesSpoken === recap.spokenCount &&
      record.strokeCount === final.strokeCount,
    () => `record cuesSpoken/strokeCount mismatch`,
  );

  return {
    snapshot: canonicalJson(final),
    recap: canonicalJson(recap),
    schedulerTrace: scheduler.trace,
    strokeEvents: final.strokeCount,
    samplesPushed,
    snapshotsDelivered,
  };
}

// ─── Campaigns ──────────────────────────────────────────────────────────────

const seeds = campaignSeeds(DEFAULT_ITERATIONS);
const syntheticTable = new ResultsTable('liveSessionCoach.syntheticStream');
const flowTable = new ResultsTable('liveSessionFlow.realEngine');

beforeAll(async () => {
  for (const seed of seeds) {
    // Part A
    {
      const started = Date.now();
      const violations = new Violations();
      let counters: Record<string, number> = {};
      try {
        const first = runSyntheticStream(seed, violations);
        const second = runSyntheticStream(seed, new Violations());
        violations.check(
          'C11',
          first.recapA === second.recapA && first.recapB === second.recapB,
          () => `replay diverged`,
        );
        counters = {
          events: first.events,
          eventViewsDelivered: first.eventViewsDelivered,
          snapshotsDelivered: first.snapshotsDelivered,
          iterations: 2,
        };
      } catch (error) {
        violations.fail(
          'C0',
          `harness threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
      syntheticTable.record({
        seed,
        outcome:
          violations.ids().filter(id => !id.startsWith('OBS')).length === 0
            ? 'HELD'
            : 'BROKEN',
        violated: violations.ids(),
        details: violations.messages(),
        counters,
        durationMs: Date.now() - started,
      });
    }
    // Part B
    {
      const started = Date.now();
      const violations = new Violations();
      let counters: Record<string, number> = {};
      let trace: string[] | undefined;
      try {
        const first = await runRealFlow(seed, violations);
        const second = await runRealFlow(seed, new Violations());
        violations.check(
          'F8',
          first.snapshot === second.snapshot &&
            first.recap === second.recap &&
            canonicalJson(first.schedulerTrace) ===
              canonicalJson(second.schedulerTrace),
          () => `replay diverged`,
        );
        trace = first.schedulerTrace;
        counters = {
          strokeEvents: first.strokeEvents,
          samplesPushed: first.samplesPushed,
          snapshotsDelivered: first.snapshotsDelivered,
          interleavingSteps: first.schedulerTrace.length,
          iterations: 2,
        };
      } catch (error) {
        violations.fail(
          'F0',
          `harness threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
      flowTable.record({
        seed,
        outcome: violations.ids().length === 0 ? 'HELD' : 'BROKEN',
        violated: violations.ids(),
        details: violations.messages(),
        counters,
        trace,
        durationMs: Date.now() - started,
      });
    }
  }
}, 900_000);

afterAll(() => {
  for (const table of [syntheticTable, flowTable]) {
    const path = table.write();
    const summary = table.summary();
    console.info(
      `[${summary.campaign}] seeds=${summary.seeds} held=${summary.held} broken=${summary.broken} ` +
        `totals=${JSON.stringify(summary.totals)}` +
        (path ? ` table=${path}` : ''),
    );
  }
});

describe(`LiveSessionCoach synthetic snapshot streams (${seeds.length} seeds)`, () => {
  it('ran every planned seed (harness itself never threw)', () => {
    expect(syntheticTable.summary().seeds).toBe(seeds.length);
    expect(describeViolations(syntheticTable, 'C0')).toBe(
      'C0: held on every seed',
    );
  });
  it('C1 each event is cued at most once (idempotent under duplicate / stale / shuffled snapshots)', () => {
    expect(describeViolations(syntheticTable, 'C1')).toBe(
      'C1: held on every seed',
    );
  });
  it('C2 no cue for an event that was not terminal before the end', () => {
    expect(describeViolations(syntheticTable, 'C2')).toBe(
      'C2: held on every seed',
    );
  });
  it('C3 every event terminal before the end was cued (no lost update)', () => {
    expect(describeViolations(syntheticTable, 'C3')).toBe(
      'C3: held on every seed',
    );
  });
  it('C4 the coach is quiet after sessionEnded()/dispose() and the recap is frozen', () => {
    expect(describeViolations(syntheticTable, 'C4')).toBe(
      'C4: held on every seed',
    );
  });
  it('C5 SESSION_START first, exactly one SESSION_END last (sessionEnded() twice is idempotent)', () => {
    expect(describeViolations(syntheticTable, 'C5')).toBe(
      'C5: held on every seed',
    );
  });
  it('C6 spokenCount equals the cues the port actually voiced', () => {
    expect(describeViolations(syntheticTable, 'C6')).toBe(
      'C6: held on every seed',
    );
  });
  it('C7 the onCue observer sees exactly the recap cues', () => {
    expect(describeViolations(syntheticTable, 'C7')).toBe(
      'C7: held on every seed',
    );
  });
  it('C8 every cue clock comes from a delivered snapshot (skewed clocks pass through unchanged)', () => {
    expect(describeViolations(syntheticTable, 'C8')).toBe(
      'C8: held on every seed',
    );
  });
  it('C9 getCompletedCoachRecap holds the recap of the last coach that ended', () => {
    expect(describeViolations(syntheticTable, 'C9')).toBe(
      'C9: held on every seed',
    );
  });
  it('C10 documented contract: events are spoken about "in event order"', () => {
    expect(describeViolations(syntheticTable, 'C10')).toBe(
      'C10: held on every seed',
    );
  });
  it('C11 every seed replays to the identical recap', () => {
    expect(describeViolations(syntheticTable, 'C11')).toBe(
      'C11: held on every seed',
    );
  });
  it('C12 a second coach on the same session id obeys C1–C4 for its own window', () => {
    expect(describeViolations(syntheticTable, 'C12')).toBe(
      'C12: held on every seed',
    );
  });
});

describe(`LiveSessionFlow + LiveSessionCoach real engine (${seeds.length} seeds)`, () => {
  it('ran every planned seed (harness itself never threw)', () => {
    expect(flowTable.summary().seeds).toBe(seeds.length);
    expect(describeViolations(flowTable, 'F0')).toBe('F0: held on every seed');
  });
  it('F1 every session settles inside the wall-time bound (no deadlock)', () => {
    expect(describeViolations(flowTable, 'F1')).toBe('F1: held on every seed');
  });
  it('F2 final event states match the provider plan; nothing left processing; subscriber failures counted', () => {
    expect(describeViolations(flowTable, 'F2')).toBe('F2: held on every seed');
  });
  it('F3 the completed-session registry holds the same events/strokeCount as the snapshot after late settlement', () => {
    expect(describeViolations(flowTable, 'F3')).toBe('F3: held on every seed');
  });
  it('F3b the completed-session registry is byte-identical to the snapshot (incl. onUpdateFailures)', () => {
    expect(describeViolations(flowTable, 'F3b')).toBe(
      'F3b: held on every seed',
    );
  });
  it('F4 coach cues ≡ terminal events: no duplicates, no losses, nothing after sessionEnded()', () => {
    expect(describeViolations(flowTable, 'F4')).toBe('F4: held on every seed');
  });
  it('F5 progression counts match event states and ignore array order', () => {
    expect(describeViolations(flowTable, 'F5')).toBe('F5: held on every seed');
  });
  it('F6 the durable summary record survives a JSON round trip losslessly', () => {
    expect(describeViolations(flowTable, 'F6')).toBe('F6: held on every seed');
  });
  it('F7 end() is idempotent and pushSample() after end() throws', () => {
    expect(describeViolations(flowTable, 'F7')).toBe('F7: held on every seed');
  });
  it('F8 every seed replays to the identical snapshot, recap and interleaving', () => {
    expect(describeViolations(flowTable, 'F8')).toBe('F8: held on every seed');
  });
  it('F9 documented contract on the real engine: events are spoken about "in event order"', () => {
    expect(describeViolations(flowTable, 'F9')).toBe('F9: held on every seed');
  });
  it('F10 successive snapshots are append-only and never rewrite a terminal event (no lost update)', () => {
    expect(describeViolations(flowTable, 'F10')).toBe(
      'F10: held on every seed',
    );
  });
});

// ─── Minimized, seed-free repros of the campaign findings ───────────────────

describe('minimal repros (deterministic, no RNG)', () => {
  function minimalSnapshot(
    sessionId: string,
    events: SessionEventView[],
    durationMs: number,
  ): LiveSessionSnapshot {
    return {
      sessionId,
      phase: 'running',
      source: 'live',
      startedAtIso: '2026-09-05T00:00:00.000Z',
      durationMs,
      strokeCount: events.length,
      events,
      distribution: [],
      qualityNotes: [],
      droppedLateSamples: 0,
      onUpdateFailures: 0,
      engineVersion: 'stress-engine',
      analysisProviderId: 'stress-provider',
    };
  }

  it('C10/F9 minimal: E2 settling before E1 is spoken about before E1 (documented "in event order")', () => {
    const rng = mulberry32(1);
    const e1: SyntheticEvent = {
      index: 0,
      eventId: 'E1',
      kind: 'scored',
      analysis: scoredAnalysis(rng, 6.5),
    };
    const e2: SyntheticEvent = {
      index: 1,
      eventId: 'E2',
      kind: 'scored',
      analysis: scoredAnalysis(rng, 7.5),
    };
    const actor = makeActor('min', 'live');
    // Snapshot 1: both closed, only E2 has settled (E1 still processing).
    deliver(
      actor,
      minimalSnapshot('min-c10', [viewFor(e1, 1), viewFor(e2, 2)], 1000),
    );
    // Snapshot 2: E1 settles late.
    deliver(
      actor,
      minimalSnapshot('min-c10', [viewFor(e1, 2), viewFor(e2, 2)], 2000),
    );
    endActor(
      actor,
      minimalSnapshot('min-c10', [viewFor(e1, 2), viewFor(e2, 2)], 2000),
      'sessionEnded',
    );
    const spokenOrder = actor.coach
      .recap()
      .cues.filter(cue => cue.eventId !== null)
      .map(cue => cue.eventId);
    expect(spokenOrder).toEqual(['E1', 'E2']);
  });

  it('F3b minimal: registry lags the snapshot by one onUpdateFailures when the last subscriber call throws', async () => {
    const resolvers: Array<(outcome: SessionEventAnalysisOutcome) => void> = [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'min-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: () =>
        new Promise<SessionEventAnalysisOutcome>(resolve => {
          resolvers.push(resolve);
        }),
    };
    const sessionId = 'min-f3b';
    const flow = new LiveSessionFlow({
      sessionId,
      source: 'replay',
      provider,
      onUpdate: () => {
        throw new Error('subscriber crashed');
      },
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flushMicrotasks(); // extractClip() → analyzeEvent() hand-off
    expect(resolvers.length).toBeGreaterThan(0);
    // Late settlement after end(): each notify() writes the registry, then the
    // subscriber throws and onUpdateFailures advances on the flow only.
    for (const resolve of resolvers)
      resolve({ status: 'abstained', abstainReason: 'POSE_TOO_SPARSE' });
    await withDeadline('F3b minimal settled()', 5_000, flow.settled());
    const registry = getCompletedSession(sessionId);
    expect(registry).not.toBeNull();
    expect(registry!.events.map(e => e.state)).toEqual(
      flow.snapshot().events.map(e => e.state),
    );
    expect(registry!.onUpdateFailures).toBe(flow.snapshot().onUpdateFailures);
  });
});
