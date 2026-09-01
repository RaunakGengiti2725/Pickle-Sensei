/**
 * Live session coach tests: the voice layer between LiveSessionFlow and TTS.
 * Every scenario a session can produce must yield honest, spoken (or
 * captioned) feedback exactly once per event — scored corrections/praise,
 * low-confidence no-reads, abstentions, setup guidance, session start/end.
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

function lowConfidenceAnalysis(): AnalysisRecord {
  return {
    strokeResolution: { kind: 'unresolved' },
    result: {
      resultKind: 'low_confidence',
      overallScore: null,
      checkpoints: [],
    },
  } as unknown as AnalysisRecord;
}

let eventCounter = 0;

function view(partial: Partial<SessionEventView>): SessionEventView {
  eventCounter += 1;
  const index = partial.index ?? eventCounter - 1;
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
    engineVersion: 'test-engine-1',
    analysisProviderId: 'test-provider',
    ...overrides,
  };
}

function makeVoice(available = true) {
  const spoken: string[] = [];
  const voice: CoachVoicePort = {
    available: () => available,
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

const cleanCheckpoints: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

beforeEach(() => {
  eventCounter = 0;
});

describe('LiveSessionCoach', () => {
  it('speaks an audible start line immediately so the player can confirm audio', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    expect(spoken).toEqual(["Live coaching on. I'll call out every swing."]);
  });

  it('labels the replay start line as a demo, never as live coaching', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('replay');
    expect(spoken[0]).toContain('Demo rally replay');
  });

  it('speaks a knee-bend correction (with the score) when the worst checkpoint is athletic_base low', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [
            {
              key: 'contact_position',
              score: 80,
              direction: 'none',
              severity: 0.1,
            },
            kneeFault,
          ]),
        }),
      ]),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('6.4');
    expect(spoken[0]).toContain('Bend the knees more.');
    expect(coach.lastCue()?.category).toBe('CORRECTION');
    expect(coach.lastCue()?.targetCheckpoint).toBe('athletic_base');
  });

  it('never speaks twice for the same event, no matter how many snapshots arrive', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
    ];
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap(events));
    expect(spoken).toHaveLength(1);
  });

  it('hands the cue CATEGORY to the voice port so urgency/queueing policy applies', () => {
    const categories: Array<string | undefined> = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: (_text, options) => {
        categories.push(options?.category);
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    expect(categories).toEqual(['SESSION_START', 'CORRECTION']);
  });

  it('records spoken=false when the port suppresses a cue (reduced feedback level)', () => {
    const voice: CoachVoicePort = {
      available: () => true,
      // A reduced feedback level: the port refuses non-essential cues.
      speak: (_text, options) => options?.category !== 'PRAISE',
      stop: jest.fn(),
    };
    const cues: Array<{ category: string; spoken: boolean }> = [];
    const coach = new LiveSessionCoach({
      voice,
      onCue: cue => cues.push({ category: cue.category, spoken: cue.spoken }),
    });
    coach.consumeSnapshot(
      snap([
        // High score with no faults → praise → suppressed by the port.
        view({ index: 0, state: 'ready', analysis: scoredAnalysis(9.1, []) }),
      ]),
    );
    expect(cues).toEqual([{ category: 'PRAISE', spoken: false }]);
  });

  it('stays quiet for pending events and speaks the moment one turns terminal', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([view({ index: 0, state: 'pending' })]));
    expect(spoken).toHaveLength(0);
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(7.1, cleanCheckpoints),
        }),
      ]),
    );
    expect(spoken).toHaveLength(1);
  });

  it('gives honest feedback for EVERY terminal scenario: scored, low-confidence, abstained', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
        view({ index: 1, state: 'ready', analysis: lowConfidenceAnalysis() }),
        view({
          index: 2,
          state: 'abstained',
          abstainReason: 'POSE_TOO_SPARSE',
        }),
      ]),
    );
    expect(spoken).toHaveLength(3);
    const categories = coach.recap().cues.map(cue => cue.category);
    expect(categories).toEqual(['CORRECTION', 'NO_READ', 'NO_READ']);
    // Every cue is non-empty text — the coach never goes silent on a swing.
    for (const cue of coach.recap().cues) {
      expect(cue.text.length).toBeGreaterThan(0);
    }
  });

  it('escalates to setup guidance after three consecutive unreadable swings', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({ index: 0, state: 'ready', analysis: lowConfidenceAnalysis() }),
        view({ index: 1, state: 'abstained', abstainReason: 'NO_POSE' }),
        view({ index: 2, state: 'ready', analysis: lowConfidenceAnalysis() }),
      ]),
    );
    expect(spoken).toHaveLength(3);
    expect(coach.recap().cues[2]?.category).toBe('SETUP_GUIDANCE');
    expect(spoken[2]).toMatch(/framing/i);
  });

  it('praises clean swings and announces personal bests', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.0, cleanCheckpoints),
        }),
        view({
          index: 1,
          state: 'ready',
          analysis: scoredAnalysis(6.2, cleanCheckpoints),
        }),
        view({
          index: 2,
          state: 'ready',
          analysis: scoredAnalysis(7.4, cleanCheckpoints),
        }),
      ]),
    );
    expect(spoken).toHaveLength(3);
    const categories = coach.recap().cues.map(cue => cue.category);
    expect(categories[0]).toBe('PRAISE');
    expect(categories[2]).toBe('PERSONAL_BEST');
    expect(spoken[2]).toContain('New best');
    expect(spoken[2]).toContain('7.4');
  });

  it('muting logs captions without speaking, and stops any current utterance', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.setMuted(true);
    expect(voice.stop).toHaveBeenCalled();
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    expect(spoken).toHaveLength(0);
    expect(coach.lastCue()?.text).toContain('Bend the knees more.');
    expect(coach.lastCue()?.spoken).toBe(false);
    coach.setMuted(false);
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
        view({
          index: 1,
          state: 'ready',
          analysis: scoredAnalysis(6.5, [kneeFault]),
        }),
      ]),
    );
    expect(spoken).toHaveLength(1);
    expect(coach.lastCue()?.spoken).toBe(true);
  });

  it('is caption-only (spoken: false) when the build has no voice, still logging every cue', () => {
    const { voice, spoken } = makeVoice(false);
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    expect(spoken).toHaveLength(0);
    expect(coach.recap().cues).toHaveLength(2);
    expect(coach.recap().cues.every(cue => !cue.spoken)).toBe(true);
    expect(coach.recap().spokenCount).toBe(0);
  });

  it('mirrors every cue to the HUD observer as it happens', () => {
    const { voice } = makeVoice();
    const seen: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => seen.push(cue) });
    coach.sessionStarted('live');
    coach.consumeSnapshot(
      snap([
        view({
          index: 0,
          state: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        }),
      ]),
    );
    expect(seen.map(cue => cue.category)).toEqual([
      'SESSION_START',
      'CORRECTION',
    ]);
  });

  it('speaks an honest wrap-up with the start→end movement and registers the recap', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = [
      view({
        index: 0,
        state: 'ready',
        analysis: scoredAnalysis(6.0, [kneeFault]),
      }),
      view({
        index: 1,
        state: 'ready',
        analysis: scoredAnalysis(7.0, cleanCheckpoints),
      }),
    ];
    const finalSnapshot = snap(events, {
      sessionId: 'session-wrap',
      phase: 'ended',
    });
    coach.consumeSnapshot(finalSnapshot);
    const recap = coach.sessionEnded(finalSnapshot);
    expect(spoken.at(-1)).toContain('Session over.');
    expect(spoken.at(-1)).toContain('6.0');
    expect(spoken.at(-1)).toContain('7.0');
    expect(spoken.at(-1)).toContain('up 1.0');
    expect(recap.correctionsByCheckpoint.athletic_base).toBe(1);
    expect(recap.topCorrection).toBe('athletic_base');
    expect(getCompletedCoachRecap('session-wrap')).toEqual(recap);
    // After the wrap-up the coach never speaks again.
    coach.consumeSnapshot(
      snap([
        ...events,
        view({
          index: 2,
          state: 'ready',
          analysis: scoredAnalysis(8.0, cleanCheckpoints),
        }),
      ]),
    );
    expect(spoken.filter(text => text.includes('8.0'))).toHaveLength(0);
  });

  it('wraps up honestly when nothing could be scored', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const finalSnapshot = snap(
      [view({ index: 0, state: 'abstained', abstainReason: 'NO_POSE' })],
      { sessionId: 'session-none', phase: 'ended' },
    );
    coach.consumeSnapshot(finalSnapshot);
    coach.sessionEnded(finalSnapshot);
    expect(spoken.at(-1)).toBe(
      'Session over. No swings could be scored this time.',
    );
  });

  it('produces identical cue sequences for identical sessions (deterministic)', () => {
    const run = () => {
      const { voice, spoken } = makeVoice();
      eventCounter = 0;
      const coach = new LiveSessionCoach({ voice });
      coach.sessionStarted('live');
      coach.consumeSnapshot(
        snap([
          view({
            index: 0,
            state: 'ready',
            analysis: scoredAnalysis(5.8, [kneeFault]),
          }),
          view({
            index: 1,
            state: 'ready',
            analysis: scoredAnalysis(6.1, [kneeFault]),
          }),
          view({ index: 2, state: 'ready', analysis: lowConfidenceAnalysis() }),
          view({
            index: 3,
            state: 'ready',
            analysis: scoredAnalysis(6.9, cleanCheckpoints),
          }),
        ]),
      );
      return spoken;
    };
    expect(run()).toEqual(run());
  });
});

describe('LiveSessionCoach + real LiveSessionFlow (end-to-end)', () => {
  it('speaks once per engine-closed event across scored, low-confidence and abstained outcomes', async () => {
    const outcomesByEvent: Record<string, 'scored' | 'low' | 'abstain'> = {
      E1: 'scored',
      E2: 'low',
      E3: 'abstain',
    };
    const provider: SessionEventAnalysisProvider = {
      providerId: 'coach-e2e-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async request => {
        const outcome = outcomesByEvent[request.eventId] ?? 'scored';
        if (outcome === 'abstain') {
          return { status: 'abstained', abstainReason: 'POSE_TOO_SPARSE' };
        }
        if (outcome === 'low') {
          return { status: 'ready', analysis: lowConfidenceAnalysis() };
        }
        return {
          status: 'ready',
          analysis: scoredAnalysis(6.4, [kneeFault]),
        };
      },
    };
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'e2e-session',
      source: 'live',
      provider,
      onUpdate: next => coach.consumeSnapshot(next),
    });
    coach.sessionStarted('live');
    for (const sample of DEV_REPLAY_RALLY.samples) {
      flow.pushSample(sample);
    }
    const final = flow.end();
    await flow.settled();
    // The recorded rally closes exactly three events: E1, E2, E3.
    expect(final.strokeCount).toBe(3);
    coach.sessionEnded(flow.snapshot());
    const categories = coach.recap().cues.map(cue => cue.category);
    expect(categories[0]).toBe('SESSION_START');
    expect(categories).toContain('CORRECTION');
    expect(categories).toContain('NO_READ');
    expect(categories.at(-1)).toBe('SESSION_END');
    // One cue per closed event + start + end, every one spoken aloud.
    expect(coach.recap().cues).toHaveLength(5);
    expect(coach.recap().spokenCount).toBe(5);
    expect(spoken).toHaveLength(5);
  });
});
