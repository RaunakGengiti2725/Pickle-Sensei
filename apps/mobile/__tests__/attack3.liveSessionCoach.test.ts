/**
 * ADVERSARIAL PASS #3 — subsystem mobile-live-court-voice (LiveSessionCoach).
 *
 * Every test here PINS THE MEASURED BEHAVIOUR of the code at 4d812e1a. Tests
 * whose name starts with `BROKEN` pin a behaviour that contradicts the
 * module's own honesty rules (see the header comment of liveSessionCoach.ts)
 * and are reported as findings; tests whose name starts with `HELD` pin a
 * defence that survived the attack. The comment above each BROKEN test says
 * what the expected behaviour is, so the pin can be flipped deliberately
 * when the production code is fixed.
 *
 * Attack surface: sessionStarted/sessionEnded/dispose ordering, a throwing
 * voice port, NaN/Infinity scores and severities, cross-session eventId
 * collisions, zero/inapplicable checkpoints, resolution-order interleavings
 * with the REAL LiveSessionFlow + DEV_REPLAY_RALLY, and rapid repeats.
 *
 * Note: Live Court screens were removed for v1 (commit 9c93f7c "Live Court
 * removal"); the coach is dormant library code, so nothing here is reachable
 * by a shipping user today. Severities in the report reflect that.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
  type SpokenCue,
} from '../src/flow/liveSessionCoach';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../src/flow/session';
import { sessionScoreProgression } from '../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../src/flow/liveSessionSummary';

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable?: boolean;
}

function scoredAnalysis(
  overallScore: number,
  checkpoints: CheckpointSpec[],
  shotType: ShotTypeSlug = 'forehand_drive',
): AnalysisRecord {
  return {
    strokeResolution: { kind: 'declared', shotType },
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
        applicable: spec.applicable ?? true,
      })),
    },
  } as unknown as AnalysisRecord;
}

function view(
  partial: Partial<SessionEventView> & { index: number },
): SessionEventView {
  const index = partial.index;
  return {
    eventId: `E${index + 1}`,
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

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'attack-session',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-09-04T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'attack-engine',
    analysisProviderId: 'attack-provider',
    ...overrides,
  };
}

function makeVoice(available = true) {
  const spoken: string[] = [];
  const stop = jest.fn();
  const voice: CoachVoicePort = {
    available: () => available,
    speak: (text: string) => {
      spoken.push(text);
    },
    stop,
  };
  return { voice, spoken, stop };
}

const kneeFault: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};

const clean: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

const ready = (index: number, analysis: AnalysisRecord) =>
  view({ index, state: 'ready', analysis });

// ─── Scenario 1: sessionStarted after sessionEnded / dispose ───────────────

describe('S1 sessionStarted after the coach has gone quiet', () => {
  // EXPECTED: the header promises "after the session ends the coach goes
  // quiet"; `ended` must gate sessionStarted exactly like consumeSnapshot.
  it('BROKEN: sessionStarted("live") after sessionEnded() still speaks the opening line', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([ready(0, scoredAnalysis(6.4, [kneeFault]))], {
      phase: 'ended',
    });
    coach.consumeSnapshot(final);
    coach.sessionEnded(final);
    expect(spoken.at(-1)).toContain('Session over.');
    coach.sessionStarted('live');
    // Measured: the coach speaks "Live coaching on…" AFTER "Session over."
    expect(spoken.at(-1)).toBe("Live coaching on. I'll call out every swing.");
    expect(coach.lastCue()?.category).toBe('SESSION_START');
    expect(coach.lastCue()?.spoken).toBe(true);
    // …and the registered recap (what LiveSummary reads) does NOT include it —
    // the spoken log and the registry now disagree.
    expect(getCompletedCoachRecap('attack-session')?.cues).toHaveLength(2);
    expect(coach.recap().cues).toHaveLength(3);
  });

  // EXPECTED: dispose() is "unmount/teardown: cut any in-flight utterance";
  // a late sessionStarted must not restart audio on an unmounted screen.
  it('BROKEN: sessionStarted after dispose() speaks (voice.stop() then speak)', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    coach.sessionStarted('live');
    coach.sessionStarted('replay');
    expect(spoken).toEqual([
      "Live coaching on. I'll call out every swing.",
      'Demo rally replay. In a live session I call out every swing.',
    ]);
  });

  it('BROKEN: rapid repeated sessionStarted() speaks the opening line every time (no idempotence)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    for (let i = 0; i < 25; i += 1) coach.sessionStarted('live');
    expect(spoken).toHaveLength(25);
    expect(coach.recap().cues.every(c => c.category === 'SESSION_START')).toBe(
      true,
    );
  });

  it('HELD: consumeSnapshot after sessionEnded() and after dispose() never speaks', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([], { phase: 'ended' });
    coach.sessionEnded(final);
    const before = spoken.length;
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(9.9, clean))]));
    expect(spoken).toHaveLength(before);

    const { voice: v2, spoken: s2 } = makeVoice();
    const disposed = new LiveSessionCoach({ voice: v2 });
    disposed.dispose();
    disposed.consumeSnapshot(snap([ready(0, scoredAnalysis(9.9, clean))]));
    expect(s2).toHaveLength(0);
  });

  // EXPECTED (debatable): a screen that unmounts (dispose) before its stop
  // handler runs loses the wrap-up AND the registry entry LiveSummary reads.
  it('BROKEN(P3): dispose() before sessionEnded() suppresses the end line and never registers the recap', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([ready(0, scoredAnalysis(6.4, [kneeFault]))], {
      sessionId: 'disposed-first',
      phase: 'ended',
    });
    coach.consumeSnapshot(final);
    coach.dispose();
    const recap = coach.sessionEnded(final);
    expect(spoken.some(t => t.includes('Session over.'))).toBe(false);
    expect(recap.cues).toHaveLength(1);
    expect(getCompletedCoachRecap('disposed-first')).toBeNull();
  });
});

// ─── Scenario 2: late-settling E1 vs. the wrap-up line ─────────────────────

const flushMicrotasks = () => new Promise<void>(r => setImmediate(r));

describe('S2 LiveSessionFlow + coach: analysis resolving AFTER end()', () => {
  function deferredProvider(): {
    provider: SessionEventAnalysisProvider;
    release: (eventId: string, outcome: SessionEventAnalysisOutcome) => void;
    pending: () => string[];
  } {
    const resolvers = new Map<
      string,
      (outcome: SessionEventAnalysisOutcome) => void
    >();
    const provider: SessionEventAnalysisProvider = {
      providerId: 'deferred-attack-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: request =>
        new Promise<SessionEventAnalysisOutcome>(resolve => {
          resolvers.set(request.eventId, resolve);
        }),
    };
    return {
      provider,
      release: (eventId, outcome) => {
        const resolve = resolvers.get(eventId);
        if (!resolve) throw new Error(`no in-flight dispatch for ${eventId}`);
        resolvers.delete(eventId);
        resolve(outcome);
      },
      pending: () => [...resolvers.keys()],
    };
  }

  it('BROKEN: wrap-up says "No swings could be scored" while E1 lands scored 1 tick later; summary record disagrees with what was spoken', async () => {
    const { provider, release, pending } = deferredProvider();
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'late-e1',
      source: 'replay',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    coach.sessionStarted('replay');
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const atStop = flow.end();
    expect(atStop.strokeCount).toBe(3);
    // dispatchAnalysis awaits extractClip before analyzeEvent is called.
    await flushMicrotasks();
    expect(pending().sort()).toEqual(['E1', 'E2', 'E3']);
    // The screen's stop handler: coach wraps up on the snapshot it has.
    const recapAtStop = coach.sessionEnded(atStop);
    expect(spoken.at(-1)).toBe(
      'Session over. No swings could be scored this time.',
    );
    expect(recapAtStop.cues.map(c => c.category)).toEqual([
      'SESSION_START',
      'SESSION_END',
    ]);

    // Analyses settle after stop (realistic: scoring takes seconds).
    release('E1', {
      status: 'ready',
      analysis: scoredAnalysis(6.4, [kneeFault]),
    });
    release('E2', { status: 'ready', analysis: scoredAnalysis(8.0, clean) });
    release('E3', { status: 'abstained', abstainReason: 'POSE_TOO_SPARSE' });
    await flow.settled();

    // The completed-session registry (what LiveSummary reads) now has 2 scored
    // swings; the coach recap registered at stop still says 2 cues, 0 per-swing.
    const completed = getCompletedSession('late-e1');
    expect(completed).not.toBeNull();
    const progression = sessionScoreProgression(completed!.events);
    expect(progression.scoredCount).toBe(2);
    expect(progression.noReadCount).toBe(1);
    const recap = getCompletedCoachRecap('late-e1');
    expect(recap?.spokenCount).toBe(2);
    expect(recap?.cues.filter(c => c.eventId !== null)).toHaveLength(0);
    // Nothing spoken after end() — HELD part of the invariant.
    expect(spoken).toHaveLength(2);

    // The durable summary: scoredCount 2, cuesSpoken 2 — but those two "cues"
    // are the start and end lines. No field records that 0 of 2 scored swings
    // were coached, and the spoken end line ("No swings could be scored") is
    // contradicted by the record it sits next to.
    const record = buildLiveSessionSummaryRecord(
      completed!,
      progression,
      recap,
    );
    expect(record.scoredCount).toBe(2);
    expect(record.cuesSpoken).toBe(2);
    expect(record.bestScore).toBe(8.0);
    expect(spoken[1]).toContain('No swings could be scored');
  });

  it('BROKEN(P3): cuesSpoken counts the SESSION_START/SESSION_END lines, unlike LiveCourtEngine.summary().cuesSpoken which counts per-rep cues only', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([], { phase: 'ended', sessionId: 'count-lines' });
    coach.sessionStarted('live');
    const recap = coach.sessionEnded(final);
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(final.events),
      recap,
    );
    expect(record.strokeCount).toBe(0);
    expect(record.cuesSpoken).toBe(2);
  });

  it('HELD: a snapshot arriving in the same tick as end() (E1 ready before sessionEnded) is coached and counted in the wrap-up', async () => {
    const { provider, release } = deferredProvider();
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'same-tick',
      source: 'replay',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flushMicrotasks();
    release('E1', {
      status: 'ready',
      analysis: scoredAnalysis(6.4, [kneeFault]),
    });
    release('E2', { status: 'ready', analysis: scoredAnalysis(7.0, clean) });
    release('E3', { status: 'abstained', abstainReason: 'NO_POSE' });
    await flow.settled();
    coach.sessionEnded(flow.snapshot());
    expect(spoken.at(-1)).toContain('up 0.6');
    expect(coach.recap().cues.map(c => c.eventId)).toEqual([
      'E1',
      'E2',
      'E3',
      null,
    ]);
  });

  it('HELD: pushSample after end() throws (documented) and the coach stays silent', () => {
    const { provider } = deferredProvider();
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'late-sample',
      source: 'replay',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    flow.end();
    expect(() => flow.pushSample({ tMs: 10, v: 3 })).toThrow(/already ended/);
    expect(spoken).toHaveLength(0);
  });
});

// ─── Scenario 3: voice port that throws ─────────────────────────────────────

describe('S3 CoachVoicePort.speak throws', () => {
  function throwingOnceVoice() {
    const spoken: string[] = [];
    let armed = true;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: text => {
        if (armed) {
          armed = false;
          throw new Error('AVSpeechSynthesizer bridge rejected');
        }
        spoken.push(text);
      },
      stop: jest.fn(),
    };
    return { voice, spoken };
  }

  // EXPECTED: cue logged with spoken:false, onCue fires (HUD caption still
  // shows it), nothing escapes consumeSnapshot.
  it('BROKEN: the exception escapes consumeSnapshot, the cue is never logged, onCue never fires, and the event is marked consumed (lost forever)', () => {
    const { voice, spoken } = throwingOnceVoice();
    const seen: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: c => seen.push(c) });
    const events = [
      ready(0, scoredAnalysis(6.4, [kneeFault])),
      ready(1, scoredAnalysis(7.0, clean)),
    ];
    expect(() => coach.consumeSnapshot(snap(events))).toThrow(
      'AVSpeechSynthesizer bridge rejected',
    );
    expect(seen).toHaveLength(0);
    expect(coach.recap().cues).toHaveLength(0);
    // Re-delivering the same snapshot: E1 is in consumedEventIds → skipped;
    // only E2 speaks. E1's cue (and its caption) is gone.
    coach.consumeSnapshot(snap(events));
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E2']);
    expect(spoken).toHaveLength(1);
    // The cue policy state advanced for E1 anyway (repIndex 1 consumed).
    expect(seen.map(c => c.eventId)).toEqual(['E2']);
  });

  it('BROKEN: the same throw from sessionStarted / sessionEnded escapes to the caller; sessionEnded is then marked ended without a registered recap', () => {
    const { voice } = throwingOnceVoice();
    const coach = new LiveSessionCoach({ voice });
    expect(() => coach.sessionStarted('live')).toThrow();

    const { voice: v2 } = throwingOnceVoice();
    const coach2 = new LiveSessionCoach({ voice: v2 });
    const final = snap([], { phase: 'ended', sessionId: 'throw-at-end' });
    expect(() => coach2.sessionEnded(final)).toThrow();
    expect(getCompletedCoachRecap('throw-at-end')).toBeNull();
    // A retry is a no-op: `ended` was set before emit() threw.
    const recap = coach2.sessionEnded(final);
    expect(recap.cues).toHaveLength(0);
  });

  it('HELD (by LiveSessionFlow, not the coach): inside the real flow the throw is swallowed by notify(), counted in onUpdateFailures, and event state is intact', async () => {
    const { voice } = throwingOnceVoice();
    const coach = new LiveSessionCoach({ voice });
    const provider: SessionEventAnalysisProvider = {
      providerId: 'instant',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'throw-in-flow',
      source: 'replay',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const final = flow.snapshot();
    expect(final.onUpdateFailures).toBe(1);
    expect(final.events.map(e => e.state)).toEqual(['ready', 'ready', 'ready']);
    // The event whose cue threw is silently absent from the coach log.
    expect(
      coach
        .recap()
        .cues.map(c => c.eventId)
        .sort(),
    ).toHaveLength(2);
  });

  it('HELD: a port whose available() throws is NOT guarded either — documented as measured', () => {
    const voice: CoachVoicePort = {
      available: () => {
        throw new Error('native module crashed');
      },
      speak: jest.fn(),
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    expect(() => coach.sessionStarted('live')).toThrow('native module crashed');
  });
});

// ─── Scenario 4: NaN / Infinity overall score ───────────────────────────────

describe('S4 overallScore NaN / Infinity', () => {
  // EXPECTED: a non-finite score is not a score; treat as low_confidence
  // (NO_READ) or at least never voice "NaN." / "Infinity.".
  it('BROKEN: NaN is spoken as "NaN. Great rep. Repeat that." and classified as a scored PRAISE', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(Number.NaN, clean))]));
    expect(spoken).toEqual(['NaN. Great rep. Repeat that.']);
    expect(coach.lastCue()?.category).toBe('PRAISE');
  });

  it('BROKEN: Infinity is spoken as "Infinity. …", -Infinity as "-Infinity. …"', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(Number.POSITIVE_INFINITY, clean)),
        ready(1, scoredAnalysis(Number.NEGATIVE_INFINITY, [kneeFault])),
      ]),
    );
    expect(spoken[0]).toBe('Infinity. Great rep. Repeat that.');
    expect(spoken[1]).toBe('-Infinity. Bend the knees more.');
  });

  it('BROKEN: one NaN score poisons bestOverall so no PERSONAL_BEST is ever announced again this session', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, clean)),
        ready(1, scoredAnalysis(Number.NaN, clean)),
        ready(2, scoredAnalysis(9.9, clean)),
        ready(3, scoredAnalysis(10, clean)),
      ]),
    );
    const categories = coach.recap().cues.map(c => c.category);
    expect(categories).toEqual(['PRAISE', 'PRAISE', 'PRAISE', 'PRAISE']);
    expect(categories).not.toContain('PERSONAL_BEST');
  });

  it('BROKEN: an Infinity score makes every later genuine best unannounceable, and the wrap-up says "up Infinity"', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      ready(0, scoredAnalysis(6.0, clean)),
      ready(1, scoredAnalysis(6.5, clean)),
      ready(2, scoredAnalysis(9.9, clean)),
      ready(3, scoredAnalysis(Number.POSITIVE_INFINITY, clean)),
      ready(4, scoredAnalysis(10, clean)),
    ];
    const final = snap(events, { phase: 'ended', sessionId: 'inf' });
    coach.consumeSnapshot(final);
    coach.sessionEnded(final);
    expect(coach.recap().cues.map(c => c.category)).toEqual([
      'PRAISE',
      'PRAISE',
      'PERSONAL_BEST',
      'PERSONAL_BEST',
      'PRAISE', // a perfect 10 after Infinity can never be a best again
      'SESSION_END',
    ]);
    expect(spoken[3]).toBe('New best — Infinity.');
    // scoredCount 5 → window 2: end window = mean(Infinity, 10) = Infinity.
    expect(spoken.at(-1)).toBe(
      'Session over. You started around 6.3 and finished around Infinity — up Infinity.',
    );
  });

  it('BROKEN: NaN reaches the wrap-up line ("started around NaN … down NaN") and the summary record (sessionAverage NaN → JSON null)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      ready(0, scoredAnalysis(Number.NaN, clean)),
      ready(1, scoredAnalysis(7.0, clean)),
    ];
    const final = snap(events, { phase: 'ended', sessionId: 'nan-wrap' });
    coach.consumeSnapshot(final);
    const recap = coach.sessionEnded(final);
    expect(spoken.at(-1)).toBe(
      'Session over. You started around NaN and finished around 7.0 — down NaN.',
    );
    const progression = sessionScoreProgression(events);
    expect(progression.scoredCount).toBe(2);
    expect(Number.isNaN(progression.startAverage)).toBe(true);
    const record = buildLiveSessionSummaryRecord(final, progression, recap);
    expect(Number.isNaN(record.startAverage)).toBe(true);
    expect(Number.isNaN(record.sessionAverage)).toBe(true);
    // HELD downstream: the strict parser refuses the non-finite fields.
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
    expect(parsed?.startAverage).toBeNull();
    expect(parsed?.sessionAverage).toBeNull();
    expect(parsed?.scoredCount).toBe(2);
  });
});

// ─── Scenario 5: worst checkpoint severity NaN ──────────────────────────────

describe('S5 checkpoint severity NaN', () => {
  // EXPECTED: an unmeasurable severity must not be praised; either drop the
  // checkpoint or fall back to NO_READ.
  it('BROKEN: a single checkpoint with severity NaN yields PRAISE', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.4, [{ ...kneeFault, severity: Number.NaN }])),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('PRAISE');
    expect(spoken[0]).toBe('6.4. Great rep. Repeat that.');
  });

  it('BROKEN: a NaN-severity checkpoint listed FIRST masks a real 0.5 fault behind it (order-dependent PRAISE)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(
          0,
          scoredAnalysis(6.4, [
            {
              key: 'paddle_set',
              score: 70,
              direction: 'none',
              severity: Number.NaN,
            },
            kneeFault,
          ]),
        ),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('PRAISE');

    // Same checkpoints, real fault first → CORRECTION. Order decides.
    const { voice: v2 } = makeVoice();
    const coach2 = new LiveSessionCoach({ voice: v2 });
    coach2.consumeSnapshot(
      snap([
        ready(
          0,
          scoredAnalysis(6.4, [
            kneeFault,
            {
              key: 'paddle_set',
              score: 70,
              direction: 'none',
              severity: Number.NaN,
            },
          ]),
        ),
      ]),
    );
    expect(coach2.lastCue()?.category).toBe('CORRECTION');
    expect(coach2.lastCue()?.targetCheckpoint).toBe('athletic_base');
  });

  it('BROKEN: severity Infinity is a CORRECTION (fine) but -Infinity/negative severities are praised', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(
          0,
          scoredAnalysis(6.4, [
            { ...kneeFault, severity: Number.POSITIVE_INFINITY },
          ]),
        ),
        ready(
          1,
          scoredAnalysis(6.4, [
            { ...kneeFault, severity: Number.NEGATIVE_INFINITY },
          ]),
        ),
        ready(2, scoredAnalysis(6.4, [{ ...kneeFault, severity: -1 }])),
      ]),
    );
    expect(coach.recap().cues.map(c => c.category)).toEqual([
      'CORRECTION',
      'PRAISE',
      'PRAISE',
    ]);
  });
});

// ─── Scenario 6: two sessions, one coach, both emit E1 ──────────────────────

describe('S6 eventId collision across sessions', () => {
  // EXPECTED: dedupe keyed by (sessionId, eventId), or the coach refuses a
  // snapshot from a different sessionId than the one it started with.
  it("BROKEN: the second session's E1 is silently deduped by the first session's E1", () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([ready(0, scoredAnalysis(6.4, [kneeFault]))], { sessionId: 'A' }),
    );
    coach.consumeSnapshot(
      snap([ready(0, scoredAnalysis(9.0, clean))], { sessionId: 'B' }),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Bend the knees more');
    // Session B's second swing IS coached — so B gets E2 without E1.
    coach.consumeSnapshot(
      snap(
        [
          ready(0, scoredAnalysis(9.0, clean)),
          ready(1, scoredAnalysis(9.1, clean)),
        ],
        { sessionId: 'B' },
      ),
    );
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E1', 'E2']);
  });

  it('BROKEN: the SAME holds with two REAL LiveSessionFlows (engine always numbers E1, E2, …)', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'instant',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
    };
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const run = async (sessionId: string) => {
      const flow = new LiveSessionFlow({
        sessionId,
        source: 'replay',
        provider,
        onUpdate: next => coach.consumeSnapshot(next),
      });
      for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
      flow.end();
      await flow.settled();
      return flow.snapshot();
    };
    const a = await run('rally-A');
    const b = await run('rally-B');
    expect(a.events.map(e => e.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(b.events.map(e => e.eventId)).toEqual(['E1', 'E2', 'E3']);
    // 6 terminal events, 3 cues.
    expect(coach.recap().cues).toHaveLength(3);
  });

  it('BROKEN(P3): sessionEnded registers the recap under whatever sessionId the final snapshot carries, not the one that was coached', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([ready(0, scoredAnalysis(6.4, [kneeFault]))], {
        sessionId: 'coached',
      }),
    );
    coach.sessionEnded(snap([], { sessionId: 'other', phase: 'ended' }));
    expect(getCompletedCoachRecap('coached')).toBeNull();
    expect(getCompletedCoachRecap('other')?.correctionsByCheckpoint).toEqual({
      athletic_base: 1,
    });
  });
});

// ─── Scenario 7: checkpoints [] and all applicable:false ────────────────────

describe('S7 zero-evidence scored reps', () => {
  it('MEASURED: checkpoints [] → PRAISE with score prefix (pinned by the existing suite; treated as intentional)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(7.0, []))]));
    expect(coach.lastCue()?.category).toBe('PRAISE');
    expect(spoken[0]).toBe('7.0. Great rep. Repeat that.');
  });

  // EXPECTED (open question for product): praising a rep where every
  // checkpoint was inapplicable — nothing was measured. Not pinned anywhere
  // before this test; the vitest suite only pins that inapplicable
  // checkpoints are ignored for `worstCheckpoint`.
  it('BROKEN(P3): every checkpoint applicable:false (with real 0.9 severities) → PRAISE, not NO_READ', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(
          0,
          scoredAnalysis(5.0, [
            {
              key: 'athletic_base',
              score: 20,
              direction: 'low',
              severity: 0.9,
              applicable: false,
            },
            {
              key: 'paddle_set',
              score: 10,
              direction: 'short',
              severity: 0.9,
              applicable: false,
            },
          ]),
        ),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('PRAISE');
    expect(spoken[0]).toBe('5.0. Great rep. Repeat that.');
  });

  it('HELD: a low_confidence result with checkpoints [] is a NO_READ, never praise', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, {
          strokeResolution: { kind: 'unresolved' },
          result: {
            resultKind: 'low_confidence',
            overallScore: null,
            checkpoints: [],
          },
        } as unknown as AnalysisRecord),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('NO_READ');
  });

  it('HELD: ready with analysis.result === null and ready with analysis === null are NO_READ; "scored" with overallScore null is NO_READ', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, {
          strokeResolution: { kind: 'unresolved' },
          result: null,
        } as unknown as AnalysisRecord),
        view({ index: 1, state: 'ready', analysis: null }),
        ready(2, {
          strokeResolution: { kind: 'unresolved' },
          result: { resultKind: 'scored', overallScore: null, checkpoints: [] },
        } as unknown as AnalysisRecord),
      ]),
    );
    expect(coach.recap().cues.map(c => c.category)).toEqual([
      'NO_READ',
      'NO_READ',
      'SETUP_GUIDANCE',
    ]);
  });
});

// ─── Extra: ordering, interleavings, repeats, scale ─────────────────────────

describe('Extra: resolution-order interleavings and scale', () => {
  it('MEASURED: events are coached in RESOLUTION order, not event order (E2 before E1), so repIndex/personal-best gating follows arrival', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    // E1 still processing, E2 already ready.
    coach.consumeSnapshot(
      snap([
        view({ index: 0, state: 'processing' }),
        ready(1, scoredAnalysis(9.0, clean)),
      ]),
    );
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(9.5, clean)),
        ready(1, scoredAnalysis(9.0, clean)),
      ]),
    );
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E2', 'E1']);
    // The header says "in event order"; the measured order is arrival order.
  });

  it('MEASURED: an IMPROVEMENT can be attributed across non-adjacent swings when resolution order interleaves', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    // E1 corrected (knees 40). E3 resolves before E2 with knees 80 → IMPROVEMENT
    // credited to E3 though E2 (the very next swing) may have been worse.
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(6.0, [kneeFault]))]));
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeFault])),
        view({ index: 1, state: 'processing' }),
        ready(
          2,
          scoredAnalysis(6.5, [{ ...kneeFault, score: 80, severity: 0.1 }]),
        ),
      ]),
    );
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeFault])),
        ready(
          1,
          scoredAnalysis(5.0, [{ ...kneeFault, score: 20, severity: 0.9 }]),
        ),
        ready(
          2,
          scoredAnalysis(6.5, [{ ...kneeFault, score: 80, severity: 0.1 }]),
        ),
      ]),
    );
    expect(coach.recap().cues.map(c => [c.eventId, c.category])).toEqual([
      ['E1', 'CORRECTION'],
      ['E3', 'IMPROVEMENT'],
      ['E2', 'CORRECTION'],
    ]);
  });

  it('HELD: an event flipping ready→abstained (contract violation) is never re-coached; first terminal outcome wins', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(6.4, [kneeFault]))]));
    coach.consumeSnapshot(
      snap([view({ index: 0, state: 'abstained', abstainReason: 'LATE' })]),
    );
    expect(spoken).toHaveLength(1);
  });

  it('HELD: 5,000 terminal events in one snapshot are each coached exactly once, deterministically, in < 2s', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    let seed = 0x9e3779b9; // recorded seed
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const events: SessionEventView[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const r = rand();
      events.push(
        r < 0.2
          ? view({ index: i, state: 'abstained', abstainReason: 'NO_POSE' })
          : ready(
              i,
              scoredAnalysis(
                Math.round(r * 100) / 10,
                r < 0.6 ? [kneeFault] : clean,
              ),
            ),
      );
    }
    const t0 = Date.now();
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap(events));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(spoken).toHaveLength(5000);
    expect(new Set(coach.recap().cues.map(c => c.eventId)).size).toBe(5000);
  });

  it('HELD: mute toggled between two snapshots flips spoken truthfully and stop() is called on every mute', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    for (let i = 0; i < 10; i += 1) {
      coach.setMuted(i % 2 === 0);
      coach.consumeSnapshot(
        snap(
          Array.from({ length: i + 1 }, (_, k) =>
            ready(k, scoredAnalysis(6.4, [kneeFault])),
          ),
        ),
      );
    }
    expect(stop).toHaveBeenCalledTimes(5);
    expect(spoken).toHaveLength(5);
    expect(coach.recap().cues.map(c => c.spoken)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(coach.recap().spokenCount).toBe(5);
  });

  it('HELD: sessionEnded twice (different snapshots) speaks once and keeps the first registration', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const a = snap([ready(0, scoredAnalysis(6.4, [kneeFault]))], {
      sessionId: 'twice',
      phase: 'ended',
    });
    coach.consumeSnapshot(a);
    coach.sessionEnded(a);
    coach.sessionEnded(snap([], { sessionId: 'twice-b', phase: 'ended' }));
    expect(spoken.filter(t => t.startsWith('Session over.'))).toHaveLength(1);
    expect(getCompletedCoachRecap('twice-b')).toBeNull();
  });

  it('HELD: an onCue observer that throws does not break the coach state (cue is logged, exception escapes — measured)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({
      voice,
      onCue: () => {
        throw new Error('HUD crashed');
      },
    });
    expect(() =>
      coach.consumeSnapshot(snap([ready(0, scoredAnalysis(6.4, [kneeFault]))])),
    ).toThrow('HUD crashed');
    expect(coach.recap().cues).toHaveLength(1);
    expect(coach.recap().cues[0]?.spoken).toBe(true);
  });
});

// ─── Extra: summary record parsing hardening ────────────────────────────────

describe('Extra: parseLiveSessionSummaryRecord attacks', () => {
  const base = {
    version: 1,
    engineVersion: 'e',
    source: 'live',
    durationMs: 1000,
    strokeCount: 3,
    scoredCount: 2,
    noReadCount: 1,
    pendingCount: 0,
    startAverage: 6,
    endAverage: 7,
    delta: 1,
    bestScore: 7,
    sessionAverage: 6.5,
    cuesSpoken: 4,
    topCorrection: 'athletic_base',
    correctionsByCheckpoint: { athletic_base: 2 },
  };

  it('HELD: corrupt / foreign payloads return null (bad JSON, arrays, version "1", source "android")', () => {
    expect(parseLiveSessionSummaryRecord('{')).toBeNull();
    expect(parseLiveSessionSummaryRecord('[]')).toBeNull();
    expect(parseLiveSessionSummaryRecord('null')).toBeNull();
    expect(
      parseLiveSessionSummaryRecord(JSON.stringify({ ...base, version: '1' })),
    ).toBeNull();
    expect(
      parseLiveSessionSummaryRecord(
        JSON.stringify({ ...base, source: 'android' }),
      ),
    ).toBeNull();
  });

  it('HELD: non-integer, negative, huge and non-numeric counts collapse to 0; non-finite averages to null', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify({
        ...base,
        durationMs: -5,
        strokeCount: 1.5,
        scoredCount: 1e300,
        cuesSpoken: '4',
        startAverage: 'NaN',
        delta: null,
      }),
    );
    expect(parsed).toMatchObject({
      durationMs: 0,
      strokeCount: 0,
      scoredCount: 0,
      cuesSpoken: 0,
      startAverage: null,
      delta: null,
    });
  });

  // EXPECTED: same non-negative rule as the other counts.
  it('BROKEN(P3): correctionsByCheckpoint accepts NEGATIVE counts and arbitrary keys (incl. "__proto__") that the record builder can never produce', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify({
        ...base,
        correctionsByCheckpoint: {
          athletic_base: -7,
          ['__proto__']: 3,
          '<b>x</b>': 1,
        },
      }),
    );
    expect(parsed?.correctionsByCheckpoint).toEqual({
      athletic_base: -7,
      ['__proto__']: 3,
      '<b>x</b>': 1,
    });
    // No prototype pollution though (own property, not the prototype).
    expect(Object.getPrototypeOf(parsed?.correctionsByCheckpoint)).toBe(
      Object.prototype,
    );
    expect(({} as Record<string, unknown>).athletic_base).toBeUndefined();
  });

  it('HELD: topCorrection of any string is accepted verbatim (renders as text; not validated against CheckpointKey — measured)', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify({ ...base, topCorrection: 'not_a_checkpoint_\u{1F3D3}' }),
    );
    expect(parsed?.topCorrection).toBe('not_a_checkpoint_\u{1F3D3}');
  });

  it('HELD: a record built from a real recap round-trips exactly', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      ready(0, scoredAnalysis(6.0, [kneeFault])),
      ready(1, scoredAnalysis(7.0, clean)),
      view({ index: 2, state: 'abstained', abstainReason: 'NO_POSE' }),
    ];
    const final = snap(events, { phase: 'ended', sessionId: 'rt' });
    coach.sessionStarted('live');
    coach.consumeSnapshot(final);
    const recap = coach.sessionEnded(final);
    const record = buildLiveSessionSummaryRecord(
      final,
      sessionScoreProgression(events),
      recap,
    );
    expect(parseLiveSessionSummaryRecord(JSON.stringify(record))).toEqual(
      record,
    );
    expect(record).toMatchObject({
      strokeCount: 3,
      scoredCount: 2,
      noReadCount: 1,
      cuesSpoken: 5,
      topCorrection: 'athletic_base',
    });
  });
});
