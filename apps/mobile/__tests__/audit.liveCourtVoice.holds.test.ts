/**
 * STRUCTURAL AUDIT — behaviours VERIFIED TO HOLD on 4d812e1a for the dormant
 * Live Court voice layer (pass 1, auditor #2). Every test here PASSES on the
 * audited commit; they pin edge cases the existing suites did not cover.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit.liveCourtVoice.holds.test.ts
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
    engineVersion: 'test-engine-1',
    analysisProviderId: 'test-provider',
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

const readyScored = (index: number, score: number, cps: CheckpointSpec[]) =>
  view(index, { state: 'ready', analysis: scoredAnalysis(score, cps) });

describe('HOLDS: LiveSessionCoach dedupe & idempotence', () => {
  it('a duplicate eventId with a CONFLICTING payload in a later snapshot is ignored — first terminal outcome wins, exactly one cue', () => {
    const { voice } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    coach.consumeSnapshot(snap([readyScored(0, 6.4, [kneeFault])]));
    coach.consumeSnapshot(snap([readyScored(0, 9.9, clean)]));
    coach.consumeSnapshot(
      snap([view(0, { state: 'abstained', abstainReason: 'late rewrite' })]),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('6.4. Bend the knees more.');
  });

  it('sessionEnded() twice speaks ONE end line, returns the same recap, and registers once', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([readyScored(0, 6.4, [kneeFault])], {
      phase: 'ended',
      sessionId: 'audit-end-twice',
    });
    coach.consumeSnapshot(final);
    const first = coach.sessionEnded(final);
    const second = coach.sessionEnded(final);
    expect(spoken.filter(text => text.startsWith('Session over'))).toHaveLength(
      1,
    );
    expect(second).toEqual(first);
    expect(getCompletedCoachRecap('audit-end-twice')).toEqual(first);
    // Nothing speaks after the end, even for new terminal events.
    coach.consumeSnapshot(
      snap([readyScored(0, 6.4, [kneeFault]), readyScored(1, 7.0, clean)], {
        phase: 'ended',
      }),
    );
    expect(spoken).toHaveLength(2);
  });

  it('pending → processing → ready settles to exactly one cue at the terminal snapshot', () => {
    const { voice } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    coach.consumeSnapshot(snap([view(0, { state: 'pending' })]));
    coach.consumeSnapshot(snap([view(0, { state: 'processing' })]));
    expect(cues).toHaveLength(0);
    coach.consumeSnapshot(snap([readyScored(0, 6.4, [kneeFault])]));
    coach.consumeSnapshot(snap([readyScored(0, 6.4, [kneeFault])]));
    expect(cues).toHaveLength(1);
  });
});

describe('HOLDS: LiveSessionCoach mute toggling', () => {
  it('rapid setMuted toggling between snapshots: spoken follows the CURRENT mute state, stop() fires on each mute, log is complete', () => {
    const { voice, spoken, stop } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    coach.setMuted(true);
    coach.consumeSnapshot(snap([readyScored(0, 6.4, [kneeFault])]));
    coach.setMuted(false);
    coach.consumeSnapshot(
      snap([readyScored(0, 6.4, [kneeFault]), readyScored(1, 7.0, clean)]),
    );
    coach.setMuted(true);
    coach.setMuted(false);
    coach.setMuted(true);
    coach.consumeSnapshot(
      snap([
        readyScored(0, 6.4, [kneeFault]),
        readyScored(1, 7.0, clean),
        readyScored(2, 7.1, clean),
      ]),
    );
    expect(cues.map(cue => cue.spoken)).toEqual([false, true, false]);
    expect(spoken).toHaveLength(1);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(coach.recap().spokenCount).toBe(1);
    expect(coach.isMuted()).toBe(true);
  });
});

describe('HOLDS: LiveSessionCoach degenerate checkpoint payloads', () => {
  it('empty checkpoints → PRAISE with the score prefix, no crash', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([readyScored(0, 7.3, [])]));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.startsWith('7.3. ')).toBe(true);
    expect(coach.lastCue()?.category).toBe('PRAISE');
  });

  it('all-inapplicable checkpoints with high severity → PRAISE (inapplicable never corrects)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        readyScored(0, 7.3, [
          { ...kneeFault, severity: 0.95, applicable: false },
          {
            key: 'recovery',
            score: 10,
            direction: 'short',
            severity: 0.9,
            applicable: false,
          },
        ]),
      ]),
    );
    expect(coach.lastCue()?.category).toBe('PRAISE');
    expect(coach.lastCue()?.targetCheckpoint).toBeNull();
  });

  it('a ready event with a null analysis record is voiced as an honest no-read', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([view(0, { state: 'ready', analysis: null })]));
    expect(coach.lastCue()?.category).toBe('NO_READ');
  });
});

describe('HOLDS: LiveSessionCoach observer failure', () => {
  it('a throwing onCue observer escapes consumeSnapshot but the cue is already logged and the remaining events are picked up by the next snapshot', () => {
    const { voice } = makeVoice();
    let throwOnce = true;
    const coach = new LiveSessionCoach({
      voice,
      onCue: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('HUD unmounted');
        }
      },
    });
    const both = snap([
      readyScored(0, 6.4, [kneeFault]),
      readyScored(1, 7.0, clean),
    ]);
    expect(() => coach.consumeSnapshot(both)).toThrow('HUD unmounted');
    expect(coach.recap().cues.map(cue => cue.eventId)).toEqual(['E1']);
    coach.consumeSnapshot(both);
    expect(coach.recap().cues.map(cue => cue.eventId)).toEqual(['E1', 'E2']);
  });
});

describe('HOLDS: LiveSessionFlow contains a throwing voice port', () => {
  it('a voice port that throws inside onUpdate is isolated by the flow (counted in onUpdateFailures) and the session keeps running', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'audit-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'ready',
        analysis: scoredAnalysis(6.4, [kneeFault]),
      }),
    };
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        throw new Error('AVSpeechSynthesizer bridge failure');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    const flow = new LiveSessionFlow({
      sessionId: 'audit-flow-throwing-voice',
      source: 'replay',
      provider,
      onUpdate: snapshot => coach.consumeSnapshot(snapshot),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const final = flow.end();
    await flow.settled();
    const settled = flow.snapshot();
    expect(final.phase).toBe('ended');
    expect(settled.events.length).toBeGreaterThan(0);
    expect(settled.events.every(event => event.state === 'ready')).toBe(true);
    expect(settled.onUpdateFailures).toBeGreaterThan(0);
    // Cost of the escape: every stroke cue is lost from the coach log.
    expect(coach.recap().cues).toHaveLength(0);
  });
});
