/**
 * STRESS · failure-injection · LiveSessionCoach (src/flow/liveSessionCoach.ts)
 *
 * The coach consumes LiveSessionSnapshot values and speaks through a
 * CoachVoicePort (TTS). Injected here:
 *   tts.available  → false | throw | garbage (non-boolean)
 *   tts.speak      → throw | false | garbage (non-boolean truthy)
 *   tts.stop       → throw
 *   onCue observer → throw
 *   analysis payload (Vision provider result) → 13 named malformations
 *     (NaN / Infinity / negative / >10 / string overall, empty / NaN /
 *     unknown-key / out-of-range checkpoints, ready-with-null-result,
 *     unknown resultKind, scored-without-overall)
 *   event stream   → duplicate eventIds (re-delivered snapshots), shuffled
 *                    (out-of-order) event arrays, state regressions
 *                    (ready → pending), snapshots after end, snapshots after
 *                    a pause/resume (app background) gap, mute toggles.
 *
 * Invariants:
 *   C1 no fake success: `spoken:true` only when the port was reachable and
 *      speak() did not return false / throw; a cue is never recorded twice
 *      for one eventId; every terminal event gets exactly one cue.
 *   C2 no silent failure: a TTS throw must surface — either as
 *      spoken:false with the caption still logged, or as a thrown error
 *      to the caller. It must NOT be swallowed leaving neither.
 *   C3 no leak: cue text never contains NaN/undefined/null/Infinity; the
 *      recap's spokenCount equals the number of spoken:true cues.
 *   C4 recoverable: after a fault the next healthy event is still cued; a
 *      snapshot after sessionEnded() is ignored (no cues after SESSION_END).
 *   C5 replayable: same seed ⇒ same canonical cue log.
 *
 * Scale: STRESS_ITER seeds (default 8) × 1 250 events = 10 000 events.
 *        STRESS_SEED=<n> replays one seed.
 * Output: artifacts/stress/live-court/liveSessionCoachFaults.json
 */
import {
  LiveSessionCoach,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';
import {
  MALFORMED_ANALYSES,
  TTS_FAULTS,
  assertKnownBrokenStillReproduce,
  assertSeedOutcome,
  buildTable,
  campaignSeeds,
  canonicalJson,
  eventView,
  leaksRuntimeArtifact,
  lowConfidenceAnalysis,
  malformedAnalysis,
  mulberry32,
  randomScoredAnalysis,
  snapshotOf,
  writeArtifact,
  scoredAnalysis,
  type KnownBroken,
  type MalformedAnalysis,
  type Rng,
  type SeedOutcome,
  type TtsFault,
} from '../../test-support/stress/liveCourtStressKit';

const EVENTS_PER_SEED = 1_250;
const SUITE = 'liveSessionCoachFaults';

/** Reproduced production defects (see the MINIMIZED tests below). */
const KNOWN_BROKEN: readonly KnownBroken[] = [
  {
    finding: 'LSC-1',
    violationClass: 'C1:terminal_event_never_cued',
    observed:
      'consumeSnapshot adds the eventId to consumedEventIds BEFORE selectLiveCue/emit; when the TTS port ' +
      '(available()/speak()) or the cue selection throws, the event is never cued again — silent loss.',
  },
  {
    finding: 'LSC-2',
    violationClass: 'C2:consumeSnapshot_TypeError_toFixed',
    observed:
      'A non-number result.overallScore (e.g. a string) reaches formatSpokenScore → ' +
      "TypeError 'score.toFixed is not a function' escapes consumeSnapshot.",
  },
  {
    finding: 'LSC-3',
    violationClass: 'C3:cue_text_leaks',
    observed:
      'A NaN/Infinity result.overallScore is spoken verbatim ("NaN. …", "Infinity. …", "New best — NaN.").',
  },
  {
    finding: 'LSC-3',
    violationClass: 'C3:session_end_text_leaks',
    observed:
      'A NaN result.overallScore inside the start/end window of sessionScoreProgression poisons the ' +
      'averages, so sessionEnded speaks "You started around NaN and finished around 7.0 — down NaN."',
  },
];

type EventOutcome =
  'scored' | 'low_confidence' | 'abstained' | 'malformed' | 'nonterminal';

interface EventPlan {
  index: number;
  outcome: EventOutcome;
  malformed: MalformedAnalysis | null;
  /** snapshot batch this event is first delivered in */
  batch: number;
}

interface BatchPlan {
  batch: number;
  /** Deliver this batch's snapshot twice (duplicate delivery). */
  duplicate: boolean;
  /** Shuffle the event array (out-of-order delivery). */
  shuffle: boolean;
  /** Regress one already-terminal event back to 'pending' in this snapshot. */
  regressOne: boolean;
  /** Include stale copies of already-consumed events (always true in real
   * snapshots — the flow snapshot carries every event). */
  ttsFault: TtsFault;
  observerThrows: boolean;
  muteToggle: boolean;
  /** Simulated app background: a long durationMs gap before this batch. */
  backgroundGapMs: number;
}

/**
 * `full` injects everything. `residual` removes ONLY the triggers already
 * reduced to findings LSC-1..3 (throwing TTS ports, non-finite / non-numeric
 * overall scores) so the remaining invariants can be shown to HOLD on their
 * own instead of being buried under known violations. Both profiles are run
 * and both tables are written.
 */
type Profile = 'full' | 'residual';

const KNOWN_TRIGGER_TTS: ReadonlySet<TtsFault> = new Set([
  'available_throws',
  'speak_throws',
]);
const KNOWN_TRIGGER_MALFORMED: ReadonlySet<MalformedAnalysis> = new Set([
  'overall_nan',
  'overall_infinity',
  'overall_string',
]);

function planEvents(
  rng: Rng,
  batches: number,
  profile: Profile = 'full',
): EventPlan[] {
  const plans: EventPlan[] = [];
  for (let i = 0; i < EVENTS_PER_SEED; i += 1) {
    const roll = rng.next();
    let outcome: EventOutcome;
    let malformed: MalformedAnalysis | null = null;
    if (roll < 0.55) outcome = 'scored';
    else if (roll < 0.7) outcome = 'low_confidence';
    else if (roll < 0.8) outcome = 'abstained';
    else if (roll < 0.9) {
      outcome = 'malformed';
      malformed = rng.pick(MALFORMED_ANALYSES);
      if (profile === 'residual' && KNOWN_TRIGGER_MALFORMED.has(malformed)) {
        outcome = 'scored';
        malformed = null;
      }
    } else outcome = 'nonterminal';
    plans.push({
      index: i,
      outcome,
      malformed,
      batch: Math.floor((i / EVENTS_PER_SEED) * batches),
    });
  }
  return plans;
}

function planBatches(
  rng: Rng,
  batches: number,
  profile: Profile = 'full',
): BatchPlan[] {
  const plans: BatchPlan[] = [];
  for (let b = 0; b < batches; b += 1) {
    let ttsFault: TtsFault = rng.chance(0.5) ? rng.pick(TTS_FAULTS) : 'none';
    if (profile === 'residual' && KNOWN_TRIGGER_TTS.has(ttsFault))
      ttsFault = 'available_false';
    plans.push({
      batch: b,
      duplicate: rng.chance(0.25),
      shuffle: rng.chance(0.3),
      regressOne: rng.chance(0.15),
      ttsFault,
      observerThrows: rng.chance(0.1),
      muteToggle: rng.chance(0.1),
      backgroundGapMs: rng.chance(0.1) ? rng.int(30_000, 600_000) : 0,
    });
  }
  return plans;
}

function viewFor(plan: EventPlan, rng: Rng): SessionEventView {
  switch (plan.outcome) {
    case 'scored':
      return eventView(plan.index, {
        state: 'ready',
        analysis: randomScoredAnalysis(rng),
      });
    case 'low_confidence':
      return eventView(plan.index, {
        state: 'ready',
        analysis: lowConfidenceAnalysis(),
      });
    case 'abstained':
      return eventView(plan.index, {
        state: 'abstained',
        abstainReason: 'STRESS_ABSTAIN',
      });
    case 'malformed':
      return eventView(plan.index, {
        state: 'ready',
        analysis: malformedAnalysis(plan.malformed!),
      });
    case 'nonterminal':
      return eventView(plan.index, {
        state: rng.chance(0.5) ? 'pending' : 'processing',
        pendingReason: 'STRESS_PENDING',
      });
  }
}

interface CueRecord {
  eventId: string | null;
  category: string;
  spoken: boolean;
  textLeak: string | null;
}

interface SeedRun {
  outcome: SeedOutcome;
  cues: CueRecord[];
}

function runSeed(seed: number, profile: Profile = 'full'): SeedRun {
  const rng = mulberry32(seed);
  const batches = 50;
  const eventPlans = planEvents(rng, batches, profile);
  const batchPlans = planBatches(rng, batches, profile);
  const views = eventPlans.map(plan => viewFor(plan, rng));

  const violations: string[] = [];
  const faultsInjected = new Set<string>();
  const cues: CueRecord[] = [];
  let currentFault: TtsFault = 'none';
  let observerShouldThrow = false;
  let observerThrows = 0;
  let speakThrows = 0;
  let speakThrowsSurfaced = 0;
  let stopCalls = 0;
  const voiceCalls = { available: 0, speak: 0, speakReturnedFalse: 0 };

  const voice = {
    available(): boolean {
      voiceCalls.available += 1;
      if (currentFault === 'available_false') return false;
      if (currentFault === 'available_throws')
        throw new Error('INJECTED_THROW:tts.available');
      if (currentFault === 'available_garbage')
        return 'yes' as unknown as boolean;
      return true;
    },
    speak(_text: string): boolean {
      voiceCalls.speak += 1;
      if (currentFault === 'speak_throws') {
        speakThrows += 1;
        throw new Error('INJECTED_THROW:tts.speak');
      }
      if (currentFault === 'speak_false') {
        voiceCalls.speakReturnedFalse += 1;
        return false;
      }
      if (currentFault === 'speak_garbage')
        return { queued: true } as unknown as boolean;
      return true;
    },
    stop(): void {
      stopCalls += 1;
      if (currentFault === 'stop_throws')
        throw new Error('INJECTED_THROW:tts.stop');
    },
  };

  const coach = new LiveSessionCoach({
    voice,
    onCue: (cue: SpokenCue) => {
      cues.push({
        eventId: cue.eventId,
        category: cue.category,
        spoken: cue.spoken,
        textLeak: leaksRuntimeArtifact(cue.text),
      });
      if (observerShouldThrow) {
        observerThrows += 1;
        throw new Error('INJECTED_THROW:onCue_observer');
      }
    },
  });

  const sessionId = `coach-stress-${seed}`;
  const startedCall = () => coach.sessionStarted('live');
  try {
    startedCall();
  } catch (error) {
    violations.push(`C2:sessionStarted_threw_without_fault(${String(error)})`);
  }

  const delivered: SessionEventView[] = [];
  const terminalIds = new Set<string>();
  let durationMs = 0;
  let muted = false;
  let consumeThrows = 0;
  let consumeThrowsWithFault = 0;

  const deliver = (
    events: SessionEventView[],
    plan: BatchPlan,
    tag: string,
  ) => {
    const snapshot = snapshotOf(sessionId, events, { durationMs });
    try {
      coach.consumeSnapshot(snapshot);
    } catch (error) {
      consumeThrows += 1;
      const message = error instanceof Error ? error.message : String(error);
      const injected =
        plan.ttsFault === 'available_throws' ||
        plan.ttsFault === 'speak_throws' ||
        plan.observerThrows;
      if (injected && message.startsWith('INJECTED_THROW')) {
        consumeThrowsWithFault += 1;
        if (message.includes('tts.speak')) speakThrowsSurfaced += 1;
      } else {
        const cls = message.includes('toFixed')
          ? 'C2:consumeSnapshot_TypeError_toFixed'
          : 'C2:consumeSnapshot_threw_unexpectedly';
        violations.push(`${cls} batch=${plan.batch} ${tag}: ${message}`);
      }
    }
  };

  for (const plan of batchPlans) {
    currentFault = plan.ttsFault;
    observerShouldThrow = plan.observerThrows;
    if (plan.ttsFault !== 'none') faultsInjected.add(`tts:${plan.ttsFault}`);
    if (plan.observerThrows) faultsInjected.add('onCue_observer:throw');
    if (plan.duplicate) faultsInjected.add('event_stream:duplicate_delivery');
    if (plan.shuffle) faultsInjected.add('event_stream:out_of_order');
    if (plan.regressOne) faultsInjected.add('event_stream:state_regression');
    if (plan.backgroundGapMs > 0)
      faultsInjected.add('lifecycle:background_gap');
    if (plan.muteToggle) faultsInjected.add('tts:mute_toggle');

    durationMs += plan.backgroundGapMs;
    if (plan.muteToggle) {
      muted = !muted;
      try {
        coach.setMuted(muted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(
          plan.ttsFault === 'stop_throws' && message.includes('tts.stop')
        )) {
          violations.push(
            `C2:setMuted_threw_unexpectedly batch=${plan.batch}: ${message}`,
          );
        }
      }
    }

    const fresh = views.filter((_, i) => eventPlans[i]!.batch === plan.batch);
    for (const view of fresh) {
      delivered.push(view);
      durationMs = Math.max(durationMs, view.closedAtMs);
    }
    let events = [...delivered];
    if (plan.regressOne && delivered.length > 1) {
      // A stale snapshot that shows an already-terminal event as pending.
      const target = delivered.findIndex(
        view => view.state === 'ready' || view.state === 'abstained',
      );
      if (target >= 0) {
        events = events.map((view, i) =>
          i === target
            ? {
                ...view,
                state: 'pending' as const,
                analysis: null,
                abstainReason: null,
              }
            : view,
        );
      }
    }
    if (plan.shuffle) events = rng.shuffle(events);
    deliver(events, plan, 'primary');
    if (plan.duplicate) deliver(events, plan, 'duplicate');

    // C1: every terminal event delivered so far has exactly one cue, unless
    // its delivery threw (an injected TTS/observer throw mid-batch aborts the
    // rest of the loop in consumeSnapshot — that is a recorded behaviour).
    for (const view of fresh) {
      const terminal = view.state === 'ready' || view.state === 'abstained';
      if (terminal) terminalIds.add(view.eventId);
    }
  }

  // Recovery batch: healthy TTS, no observer fault — everything not yet cued
  // must now be cued exactly once (C4).
  currentFault = 'none';
  observerShouldThrow = false;
  if (muted) coach.setMuted(false);
  deliver([...delivered], batchPlans[0]!, 'recovery');
  deliver([...delivered], batchPlans[0]!, 'recovery-duplicate');

  const cuesByEvent = new Map<string, number>();
  for (const cue of cues) {
    if (cue.eventId === null) continue;
    cuesByEvent.set(cue.eventId, (cuesByEvent.get(cue.eventId) ?? 0) + 1);
  }
  for (const id of terminalIds) {
    const count = cuesByEvent.get(id) ?? 0;
    if (count === 0) violations.push(`C1:terminal_event_never_cued(${id})`);
    if (count > 1) violations.push(`C1:event_cued_${count}_times(${id})`);
  }
  for (const [id] of cuesByEvent) {
    if (!terminalIds.has(id))
      violations.push(`C1:nonterminal_event_cued(${id})`);
  }
  for (const cue of cues) {
    if (cue.textLeak)
      violations.push(
        `C3:cue_text_leaks(${cue.textLeak}) event=${cue.eventId} cat=${cue.category}`,
      );
  }

  // Ending + post-end snapshots (C4).
  const finalSnapshot: LiveSessionSnapshot = snapshotOf(sessionId, delivered, {
    phase: 'ended',
    durationMs,
  });
  const cuesBeforeEnd = cues.length;
  const recap = coach.sessionEnded(finalSnapshot);
  if (
    cues.length !== cuesBeforeEnd + 1 ||
    cues.at(-1)?.category !== 'SESSION_END'
  ) {
    violations.push('C4:session_end_cue_missing');
  }
  const endText = recap.cues.at(-1)?.text ?? '';
  const endLeak = leaksRuntimeArtifact(endText);
  if (endLeak) violations.push(`C3:session_end_text_leaks(${endLeak})`);
  coach.consumeSnapshot(
    snapshotOf(
      sessionId,
      [
        ...delivered,
        eventView(EVENTS_PER_SEED + 1, {
          state: 'ready',
          analysis: lowConfidenceAnalysis(),
        }),
      ],
      { durationMs },
    ),
  );
  coach.sessionEnded(finalSnapshot);
  if (cues.length !== cuesBeforeEnd + 1)
    violations.push('C4:cues_emitted_after_session_end');

  const spokenTrue = recap.cues.filter(cue => cue.spoken).length;
  if (recap.spokenCount !== spokenTrue)
    violations.push('C3:recap_spokenCount_mismatch');
  const uniqueEventIds = new Set(
    recap.cues.map(cue => cue.eventId).filter(id => id !== null),
  );
  if (
    uniqueEventIds.size !==
    recap.cues.filter(cue => cue.eventId !== null).length
  ) {
    violations.push('C1:recap_contains_duplicate_event_cues');
  }
  // C2: a speak() throw must be surfaced (thrown to the caller) — never
  // swallowed with the cue silently missing.
  if (speakThrows > 0 && speakThrowsSurfaced === 0) {
    violations.push(`C2:speak_throws_swallowed(${speakThrows})`);
  }

  return {
    cues,
    outcome: {
      seed,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: EVENTS_PER_SEED,
      faultsInjected: [...faultsInjected].sort(),
      violations,
      detail: {
        profile,
        terminalEvents: terminalIds.size,
        cues: cues.length,
        spoken: spokenTrue,
        consumeThrows,
        consumeThrowsWithFault,
        observerThrows,
        speakThrows,
        stopCalls,
        voiceCalls,
        malformedEvents: eventPlans.filter(plan => plan.outcome === 'malformed')
          .length,
        recapTopCorrection: recap.topCorrection,
      },
    },
  };
}

describe('STRESS · LiveSessionCoach × TTS / observer / payload / event-stream faults', () => {
  const seeds = campaignSeeds(8);
  const outcomes: SeedOutcome[] = [];
  const residualOutcomes: SeedOutcome[] = [];

  afterAll(() => {
    writeArtifact(`${SUITE}.json`, buildTable(SUITE, outcomes));
    writeArtifact(
      `${SUITE}.residual.json`,
      buildTable(`${SUITE}.residual`, residualOutcomes),
    );
  });

  it.each(seeds.map(seed => [seed] as const))(
    'seed=%i holds the coach invariants over 1 250 events (outside KNOWN_BROKEN)',
    seed => {
      const run = runSeed(seed);
      outcomes.push(run.outcome);
      assertSeedOutcome(SUITE, run.outcome, KNOWN_BROKEN);
    },
  );

  // Surfaced by the scaled campaign (STRESS_ITER=40, seeds 9-11, 29, 32-35);
  // pinned deterministically so the default run also carries the class.
  it.failing(
    'MINIMIZED (LSC-3, expected-fail): a NaN overallScore among the scored events must not make the session-end line say "NaN"',
    () => {
      const spoken: string[] = [];
      const coach = new LiveSessionCoach({
        voice: {
          available: () => true,
          speak: text => {
            spoken.push(text);
            return true;
          },
          stop: () => undefined,
        },
      });
      const events = [
        eventView(0, { state: 'ready', analysis: scoredAnalysis(NaN, []) }),
        eventView(1, { state: 'ready', analysis: scoredAnalysis(6.0, []) }),
        eventView(2, { state: 'ready', analysis: scoredAnalysis(7.0, []) }),
      ];
      const snapshot = snapshotOf('min-nan-session-end', events, {
        phase: 'ended',
      });
      coach.consumeSnapshot(snapshot);
      const recap = coach.sessionEnded(snapshot);
      const endText = recap.cues.at(-1)?.text ?? '';
      const leak = leaksRuntimeArtifact(endText);
      outcomes.push({
        seed: -3,
        outcome: leak === null ? 'HELD' : 'BROKEN',
        iterations: events.length,
        faultsInjected: ['payload:overall_nan'],
        violations: leak === null ? [] : [`C3:session_end_text_leaks(${leak})`],
        detail: { endText },
      });
      expect(leak).toBeNull();
    },
  );

  it('KNOWN_BROKEN classes still reproduce (delete the entry + close the finding when this fails)', () => {
    assertKnownBrokenStillReproduce(SUITE, outcomes, KNOWN_BROKEN);
  });

  it.each(seeds.map(seed => [seed] as const))(
    'seed=%i RESIDUAL profile (known triggers removed) holds every coach invariant — HELD',
    seed => {
      const run = runSeed(seed, 'residual');
      residualOutcomes.push(run.outcome);
      assertSeedOutcome(
        SUITE,
        run.outcome,
        [],
        `STRESS_SEED=${seed} npx jest --ci ${SUITE} -t RESIDUAL`,
      );
      expect(run.outcome.outcome).toBe('HELD');
    },
  );

  it('is replayable: same seed ⇒ same canonical cue log (C5)', () => {
    const a = runSeed(seeds[0]!);
    const b = runSeed(seeds[0]!);
    expect(canonicalJson(b.cues)).toBe(canonicalJson(a.cues));
    expect(canonicalJson(b.outcome.detail)).toBe(
      canonicalJson(a.outcome.detail),
    );
  });

  // it.failing pins: each body asserts the CORRECT behaviour and is expected
  // to throw today; Jest turns it red the moment the defect is fixed.
  it.failing(
    'MINIMIZED (LSC-1, expected-fail): a throwing TTS speak() on E1 must not lose E1 — every terminal event is cued exactly once',
    () => {
      let throwOnce = true;
      const voice = {
        available: () => true,
        speak: () => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('INJECTED_THROW:tts.speak');
          }
          return true;
        },
        stop: () => undefined,
      };
      const coach = new LiveSessionCoach({ voice });
      const events = [
        eventView(0, { state: 'ready', analysis: lowConfidenceAnalysis() }),
        eventView(1, { state: 'ready', analysis: lowConfidenceAnalysis() }),
        eventView(2, { state: 'abstained', abstainReason: 'x' }),
      ];
      let thrown: unknown = null;
      try {
        coach.consumeSnapshot(snapshotOf('min-tts', events));
      } catch (error) {
        thrown = error;
      }
      // Either behaviour is acceptable ONLY if no event is lost afterwards:
      // the coach must cue E2/E3 on the next snapshot (recoverable), and E1
      // must not be marked consumed without a cue (silent loss).
      coach.consumeSnapshot(snapshotOf('min-tts', events));
      const cuedIds = coach.recap().cues.map(cue => cue.eventId);
      expect({ thrown: thrown !== null, cuedIds }).toEqual({
        thrown: true,
        cuedIds: ['E1', 'E2', 'E3'],
      });
    },
  );

  it.failing(
    'MINIMIZED (LSC-2, expected-fail): a string overallScore must not crash consumeSnapshot with a TypeError',
    () => {
      const coach = new LiveSessionCoach({
        voice: {
          available: () => true,
          speak: () => true,
          stop: () => undefined,
        },
      });
      const events = [
        eventView(0, {
          state: 'ready',
          analysis: malformedAnalysis('overall_string'),
        }),
        eventView(1, { state: 'ready', analysis: lowConfidenceAnalysis() }),
      ];
      expect(() =>
        coach.consumeSnapshot(snapshotOf('min-string-score', events)),
      ).not.toThrow();
      expect(coach.recap().cues.map(cue => cue.eventId)).toEqual(['E1', 'E2']);
    },
  );

  it.failing(
    'MINIMIZED (LSC-3, expected-fail): a NaN overallScore must not be spoken as "NaN"',
    () => {
      const spoken: string[] = [];
      const coach = new LiveSessionCoach({
        voice: {
          available: () => true,
          speak: text => {
            spoken.push(text);
            return true;
          },
          stop: () => undefined,
        },
      });
      // A scored rep with a severe checkpoint fault → CORRECTION cue, which
      // announces the overall score first.
      const events = [
        eventView(0, {
          state: 'ready',
          analysis: scoredAnalysis(NaN, [
            {
              key: 'contact_position',
              score: 20,
              severity: 3,
              direction: 'late',
              applicable: true,
            },
          ]),
        }),
      ];
      coach.consumeSnapshot(snapshotOf('min-nan-score', events));
      expect(
        spoken.filter(text => leaksRuntimeArtifact(text) !== null),
      ).toEqual([]);
    },
  );

  it('MINIMIZED: a throwing onCue observer must not desynchronise the coach (cue logged, later events still cued)', () => {
    let calls = 0;
    const coach = new LiveSessionCoach({
      voice: {
        available: () => true,
        speak: () => true,
        stop: () => undefined,
      },
      onCue: () => {
        calls += 1;
        if (calls === 1) throw new Error('INJECTED_THROW:onCue_observer');
      },
    });
    const events = [
      eventView(0, { state: 'abstained', abstainReason: 'x' }),
      eventView(1, { state: 'abstained', abstainReason: 'x' }),
    ];
    expect(() =>
      coach.consumeSnapshot(snapshotOf('min-observer', events)),
    ).toThrow('INJECTED_THROW');
    coach.consumeSnapshot(snapshotOf('min-observer', events));
    expect(coach.recap().cues.map(cue => cue.eventId)).toEqual(['E1', 'E2']);
  });

  it('exercises every TTS fault mode and every named payload malformation across the campaign', () => {
    const injected = new Set(outcomes.flatMap(o => o.faultsInjected));
    const missing = TTS_FAULTS.filter(
      fault => fault !== 'none' && !injected.has(`tts:${fault}`),
    );
    expect(missing).toEqual([]);
    // Payload malformations are chosen per event with p=0.1 over 10 000
    // events — verify the plan actually covered all 13 names.
    const seen = new Set<MalformedAnalysis>();
    for (const seed of seeds) {
      const rng = mulberry32(seed);
      for (const plan of planEvents(rng, 50))
        if (plan.malformed) seen.add(plan.malformed);
    }
    expect([...MALFORMED_ANALYSES].filter(kind => !seen.has(kind))).toEqual([]);
  });
});
