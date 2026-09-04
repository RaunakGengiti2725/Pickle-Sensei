/**
 * STRUCTURAL AUDIT PROBES — mobile-live-court-voice (pass 1, auditor #2).
 *
 * Each test here asserts the behaviour the module's OWN doc comments promise.
 * A FAILING test in this file is a reproduced defect on the audited commit
 * (4d812e1a); it is intentionally NOT a regression pin of current behaviour.
 * Behaviours that hold are pinned in audit.liveCourtVoice.holds.test.ts.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit.liveCourtVoice.defects.test.ts
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
import type {
  LiveSessionSnapshot,
  SessionEventView,
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

const clean: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

const readyScored = (index: number, score: number, cps: CheckpointSpec[]) =>
  view(index, { state: 'ready', analysis: scoredAnalysis(score, cps) });

describe('DEFECT PROBE: LiveSessionCoach — voice port failure isolation', () => {
  it('a throwing voice port must not lose the cue nor escape consumeSnapshot (header: "spoken records the truth")', () => {
    const cues: SpokenCue[] = [];
    const voice: CoachVoicePort = {
      available: () => true,
      speak: () => {
        throw new Error('native bridge rejected utterance');
      },
      stop: jest.fn(),
    };
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    const snapshot = snap([readyScored(0, 6.4, [kneeFault])]);

    // Expected: the failure is recorded as spoken:false, never thrown.
    expect(() => coach.consumeSnapshot(snapshot)).not.toThrow();
    expect(cues).toHaveLength(1);
    expect(cues[0]?.spoken).toBe(false);
    expect(coach.recap().cues).toHaveLength(1);
  });
});

describe('DEFECT PROBE: LiveSessionCoach — lifecycle guards', () => {
  it('sessionStarted() after sessionEnded() stays quiet (header: "after the session ends the coach goes quiet")', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionEnded(snap([]));
    const afterEnd = spoken.length;
    coach.sessionStarted('live');
    expect(spoken.length).toBe(afterEnd);
  });

  it('sessionStarted() after dispose() stays quiet (dispose = teardown)', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.dispose();
    coach.sessionStarted('live');
    expect(spoken).toHaveLength(0);
  });

  it('dispose() then sessionEnded() still registers the recap for LiveSummary (doc: "The recap is registered so LiveSummary can show what the coach said")', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([readyScored(0, 6.4, [kneeFault])]));
    coach.dispose();
    const recap = coach.sessionEnded(
      snap([readyScored(0, 6.4, [kneeFault])], {
        phase: 'ended',
        sessionId: 'audit-dispose-then-end',
      }),
    );
    expect(recap.cues).toHaveLength(1);
    expect(getCompletedCoachRecap('audit-dispose-then-end')).toEqual(recap);
  });
});

describe('DEFECT PROBE: LiveSessionCoach — event identity & ordering', () => {
  it('dedupe is keyed per session: a second session reusing E1.. must be spoken (doc: "each event speaks once")', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([readyScored(0, 6.4, [kneeFault])], { sessionId: 'session-A' }),
    );
    expect(spoken).toHaveLength(1);
    coach.consumeSnapshot(
      snap([readyScored(0, 7.9, clean)], { sessionId: 'session-B' }),
    );
    expect(spoken).toHaveLength(2);
  });

  it('speaks in EVENT order (header: "at most ONCE, in event order"), not settlement order', () => {
    const { voice } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    // E1 still processing, E2 already settled.
    coach.consumeSnapshot(
      snap([view(0, { state: 'processing' }), readyScored(1, 7.9, clean)]),
    );
    // E1 settles later.
    coach.consumeSnapshot(
      snap([readyScored(0, 6.4, [kneeFault]), readyScored(1, 7.9, clean)]),
    );
    expect(cues.map(cue => cue.eventId)).toEqual(['E1', 'E2']);
  });
});

describe('DEFECT PROBE: LiveSessionCoach — score validity', () => {
  it('a NaN overallScore is not "scored" and must never be voiced as "NaN."', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([readyScored(0, Number.NaN, [kneeFault])]));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toContain('NaN');
  });

  it('a NaN overallScore must not poison personal-best tracking for the rest of the session', () => {
    const { voice } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    coach.consumeSnapshot(
      snap([
        readyScored(0, 6.0, clean),
        readyScored(1, Number.NaN, clean),
        readyScored(2, 6.5, clean),
        readyScored(3, 9.5, clean),
      ]),
    );
    expect(cues.map(cue => cue.category)).toContain('PERSONAL_BEST');
  });

  it('personalBestMinRep counts SCORED reps, not no-reads (doc: "avoids rep-1 spam")', () => {
    const { voice } = makeVoice();
    const cues: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => cues.push(cue) });
    coach.consumeSnapshot(
      snap([
        view(0, { state: 'abstained', abstainReason: 'x' }),
        view(1, { state: 'abstained', abstainReason: 'x' }),
        readyScored(2, 6.0, clean),
        readyScored(3, 6.5, clean),
      ]),
    );
    // Second scored swing ever: must not be announced as a personal best.
    expect(cues[3]?.category).not.toBe('PERSONAL_BEST');
  });
});

describe('DEFECT PROBE: liveSessionSummary — strict parse', () => {
  it('a fractional durationMs survives build → parse (not coerced to 0)', () => {
    const snapshot = snap([], { durationMs: 3871.5, phase: 'ended' });
    const built = buildLiveSessionSummaryRecord(
      snapshot,
      sessionScoreProgression([]),
      null,
    );
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(built));
    expect(parsed?.durationMs).toBe(3871.5);
  });

  it('rejects out-of-range and self-inconsistent records instead of admitting them to progression ("strict parse … never coerced into fake history")', () => {
    const corrupt = {
      version: 1,
      engineVersion: 'x',
      source: 'live',
      durationMs: 1000,
      strokeCount: 1,
      scoredCount: 50,
      noReadCount: 0,
      pendingCount: 0,
      startAverage: 999,
      endAverage: 999,
      delta: 0,
      bestScore: 999,
      sessionAverage: 999,
      cuesSpoken: 0,
      topCorrection: null,
      correctionsByCheckpoint: { athletic_base: -7 },
    };
    const parsed = parseLiveSessionSummaryRecord(JSON.stringify(corrupt));
    if (parsed !== null) {
      // If accepted at all, at least the impossible values must be dropped.
      expect(
        parsed.sessionAverage === null || parsed.sessionAverage <= 10,
      ).toBe(true);
      expect(parsed.scoredCount).toBeLessThanOrEqual(parsed.strokeCount);
      expect(parsed.correctionsByCheckpoint.athletic_base).toBeUndefined();
    }
  });
});
