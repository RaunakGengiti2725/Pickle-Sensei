/**
 * STRUCTURAL AUDIT — invariants that were suspected weak and found to HOLD on
 * the audited commit (LiveSessionCoach). Kept as regression pins.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import {
  LiveSessionCoach,
  getCompletedCoachRecap,
  type CoachVoicePort,
} from '../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
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
    sessionId: 'holds-session',
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
  const stop = jest.fn();
  const voice: CoachVoicePort = {
    available: () => true,
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

describe('AUDIT liveSessionCoach — invariants that hold', () => {
  it('a duplicate eventId with a conflicting payload in a later snapshot is ignored (first terminal outcome wins, spoken once)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) }),
      ]),
    );
    coach.consumeSnapshot(
      snap([view(0, { state: 'ready', analysis: scoredAnalysis(9.9, []) })]),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.startsWith('6.2')).toBe(true);
  });

  it('rapid setMuted toggling between snapshots: muted cues logged spoken:false, unmuted spoken:true, stop() called on mute only', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.setMuted(true);
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) }),
      ]),
    );
    coach.setMuted(false);
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) }),
        view(1, { state: 'ready', analysis: scoredAnalysis(6.3, [kneeFault]) }),
      ]),
    );
    coach.setMuted(true);
    coach.setMuted(false);
    const cues = coach.recap().cues;
    expect(cues.map(cue => cue.spoken)).toEqual([false, true]);
    expect(spoken).toHaveLength(1);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(coach.recap().spokenCount).toBe(1);
  });

  it('sessionEnded() twice speaks the closing line once and returns the same recap', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap(
      [view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) })],
      { phase: 'ended', sessionId: 'ended-twice' },
    );
    coach.consumeSnapshot(final);
    const first = coach.sessionEnded(final);
    const second = coach.sessionEnded(final);
    expect(spoken.filter(text => text.startsWith('Session over'))).toHaveLength(
      1,
    );
    expect(second).toEqual(first);
    expect(getCompletedCoachRecap('ended-twice')).toEqual(first);
  });

  it('no cue is spoken for events that settle after sessionEnded()', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const running = snap([view(0, { state: 'processing' })]);
    coach.consumeSnapshot(running);
    coach.sessionEnded(
      snap([view(0, { state: 'processing' })], { phase: 'ended' }),
    );
    coach.consumeSnapshot(
      snap(
        [
          view(0, {
            state: 'ready',
            analysis: scoredAnalysis(6.2, [kneeFault]),
          }),
        ],
        {
          phase: 'ended',
        },
      ),
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.startsWith('Session over')).toBe(true);
  });

  it('a scored swing with no checkpoints, or only inapplicable ones, still gets a non-empty line and no CORRECTION', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(7.0, []) }),
        view(1, {
          state: 'ready',
          analysis: scoredAnalysis(6.9, [{ ...kneeFault, applicable: false }]),
        }),
      ]),
    );
    const cues = coach.recap().cues;
    expect(cues).toHaveLength(2);
    for (const cue of cues) {
      expect(cue.text.length).toBeGreaterThan(0);
      expect(cue.category).not.toBe('CORRECTION');
      expect(cue.category).not.toBe('REPEAT_CORRECTION');
    }
    expect(spoken).toHaveLength(2);
  });

  it('a "ready" event whose analysis is missing is treated as a no-read, never as a score', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([view(0, { state: 'ready', analysis: null })]));
    expect(coach.recap().cues[0]?.category).toBe('NO_READ');
  });

  it('dispose() stops the voice and blocks further event cues', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.dispose();
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) }),
      ]),
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(spoken).toHaveLength(0);
  });

  it('a port returning false records spoken:false without throwing', () => {
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => false,
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'ready', analysis: scoredAnalysis(6.2, [kneeFault]) }),
      ]),
    );
    expect(coach.recap().cues[0]?.spoken).toBe(false);
    expect(coach.recap().spokenCount).toBe(0);
  });
});
