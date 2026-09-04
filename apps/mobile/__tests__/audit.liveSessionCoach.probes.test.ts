/**
 * STRUCTURAL AUDIT PROBES — LiveSessionCoach (dormant Live Court voice layer).
 *
 * Each test encodes the contract the coach documents (one honest cue per
 * terminal event, in event order; nothing spoken after the session is over;
 * recap registered for LiveSummary; no fabricated speech). A test that FAILS
 * on the audited commit is a reproduced defect, not a broken test. These
 * probes intentionally do not weaken any assertion to pass.
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
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventView,
} from '../src/flow/session';

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

function snap(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'session-1',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-08-31T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'audit-engine-1',
    analysisProviderId: 'audit-provider',
    ...overrides,
  };
}

function makeVoice() {
  const spoken: string[] = [];
  const voice: CoachVoicePort = {
    available: () => true,
    speak: (text: string) => {
      spoken.push(text);
    },
    stop: jest.fn(),
  };
  return { voice, spoken };
}

const kneeFault: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};

const scoredKnee = (index: number, score: number) =>
  view(index, { state: 'ready', analysis: scoredAnalysis(score, [kneeFault]) });

const abstained = (index: number) =>
  view(index, { state: 'abstained', abstainReason: 'NO_POSE' });

describe('AUDIT liveSessionCoach — error handling', () => {
  it('a throwing voice port must not lose the cue: consumeSnapshot does not throw, the cue is logged spoken:false', () => {
    const cues: SpokenCue[] = [];
    let attempts = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        attempts += 1;
        throw new Error('AVSpeechSynthesizer bridge rejected');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    const snapshot = snap([scoredKnee(0, 6.2)]);

    let thrown: unknown = null;
    try {
      coach.consumeSnapshot(snapshot);
    } catch (error) {
      thrown = error;
    }

    expect(attempts).toBe(1);
    // Contract (emit() comment): dispatch failure → `spoken:false`, cue kept.
    expect(thrown).toBeNull();
    expect(coach.recap().cues).toHaveLength(1);
    expect(coach.recap().cues[0]?.spoken).toBe(false);
    expect(cues).toHaveLength(1);
  });

  it('a voice failure on one event must not swallow the next event in the same snapshot', () => {
    let calls = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        calls += 1;
        if (calls === 1) throw new Error('first utterance failed');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    try {
      coach.consumeSnapshot(snap([scoredKnee(0, 6.2), scoredKnee(1, 6.4)]));
    } catch {
      // the probe above already pins the throw; here we check the aftermath
    }
    const eventIds = coach.recap().cues.map(cue => cue.eventId);
    expect(eventIds).toEqual(['E1', 'E2']);
  });

  it('with the real flow, a throwing port must not silently drop an event from the coach log', async () => {
    let speakCalls = 0;
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        speakCalls += 1;
        if (speakCalls === 2) throw new Error('bridge failure');
      },
      stop: jest.fn(),
    };
    const provider: SessionEventAnalysisProvider = {
      providerId: 'audit-throwing-port',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
    };
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'audit-throwing-port-session',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    coach.sessionStarted('live');
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await flow.settled();
    expect(final.strokeCount).toBe(3);
    // The flow isolates the throw (counted), but the coach must still hold a
    // cue for every closed event — a lost cue is a lost swing for the player.
    const eventCues = coach
      .recap()
      .cues.filter(cue => cue.eventId !== null)
      .map(cue => cue.eventId);
    expect(eventCues.sort()).toEqual(['E1', 'E2', 'E3']);
  });
});

describe('AUDIT liveSessionCoach — dedupe scope', () => {
  it('dedupe must be scoped to the session: the same eventId in a second session is a new event', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([scoredKnee(0, 6.2)], { sessionId: 'session-A' }),
    );
    coach.consumeSnapshot(
      snap([scoredKnee(0, 7.4)], { sessionId: 'session-B' }),
    );
    // Two distinct swings from two distinct sessions — two cues.
    expect(spoken).toHaveLength(2);
    expect(spoken.some(text => text.startsWith('7.4'))).toBe(true);
  });
});

describe('AUDIT liveSessionCoach — event ordering', () => {
  it('speaks terminal events in EVENT order even when analyses settle out of order (documented contract)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    // E1 still processing, E2 already ready.
    coach.consumeSnapshot(
      snap([view(0, { state: 'processing' }), scoredKnee(1, 6.4)]),
    );
    // E1 settles later.
    coach.consumeSnapshot(snap([scoredKnee(0, 6.0), scoredKnee(1, 6.4)]));
    const cues = coach.recap().cues;
    expect(cues.map(cue => cue.eventId)).toEqual(['E1', 'E2']);
    // The first swing chronologically must be the CORRECTION, the second the
    // REPEAT — never "Still there" for the swing that happened first.
    const e1 = cues.find(cue => cue.eventId === 'E1');
    expect(e1?.category).toBe('CORRECTION');
  });
});

describe('AUDIT liveSessionCoach — lifecycle guards', () => {
  it('sessionStarted() after dispose() must not speak', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.dispose();
    coach.sessionStarted('live');
    expect(spoken).toHaveLength(0);
  });

  it('sessionStarted() after sessionEnded() must not speak', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionEnded(snap([], { phase: 'ended', sessionId: 's-end' }));
    const before = spoken.length;
    coach.sessionStarted('live');
    expect(spoken.length).toBe(before);
  });

  it('sessionStarted() is idempotent — the opening line is spoken once', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.sessionStarted('live');
    expect(
      coach.recap().cues.filter(cue => cue.category === 'SESSION_START'),
    ).toHaveLength(1);
    expect(spoken).toHaveLength(1);
  });

  it('sessionEnded() after dispose() must not return a recap it did not register', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([scoredKnee(0, 6.2)], {
      phase: 'ended',
      sessionId: 'disposed-then-ended',
    });
    coach.consumeSnapshot(final);
    coach.dispose();
    const recap = coach.sessionEnded(final);
    // Either the registry holds exactly what was returned, or nothing is
    // returned — a recap that LiveSummary can never find is a lost summary.
    expect(getCompletedCoachRecap('disposed-then-ended')).toEqual(recap);
  });
});

describe('AUDIT liveSessionCoach — honest speech', () => {
  it('never speaks "NaN" — a non-finite score is not a scored swing', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredKnee(0, Number.NaN)]));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toContain('NaN');
    expect(coach.recap().cues[0]?.category).not.toBe('CORRECTION');
  });

  it('personalBestMinRep counts SCORED swings — no "New best" on the 2nd scored swing after two no-reads', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        abstained(0),
        abstained(1),
        view(2, { state: 'ready', analysis: scoredAnalysis(6.0, []) }),
        view(3, { state: 'ready', analysis: scoredAnalysis(6.5, []) }),
      ]),
    );
    const categories = coach.recap().cues.map(cue => cue.category);
    expect(categories.slice(0, 2)).toEqual(['NO_READ', 'NO_READ']);
    expect(categories[3]).not.toBe('PERSONAL_BEST');
  });

  it('the closing line must not claim "No swings could be scored" while analyses are still pending', async () => {
    const pendingResolvers: Array<(o: SessionEventAnalysisOutcome) => void> =
      [];
    const provider: SessionEventAnalysisProvider = {
      providerId: 'audit-slow-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: () =>
        new Promise<SessionEventAnalysisOutcome>(resolve => {
          pendingResolvers.push(resolve);
        }),
    };
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'audit-slow-session',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    expect(final.strokeCount).toBe(3);
    expect(
      final.events.filter(event => event.state === 'processing'),
    ).toHaveLength(3);

    coach.sessionEnded(final);
    const endLine = spoken.at(-1) ?? '';
    expect(endLine).not.toBe(
      'Session over. No swings could be scored this time.',
    );

    // Those swings DO score afterwards — the "could not be scored" claim
    // would have been false.
    for (const resolve of pendingResolvers) {
      resolve({ status: 'ready', analysis: scoredAnalysis(6.4, [kneeFault]) });
    }
    await flow.settled();
    expect(
      flow.snapshot().events.filter(event => event.state === 'ready'),
    ).toHaveLength(3);
  });
});
