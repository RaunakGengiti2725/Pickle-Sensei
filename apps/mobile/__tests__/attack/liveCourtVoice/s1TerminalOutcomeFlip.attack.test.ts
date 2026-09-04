/**
 * ADVERSARIAL S1 (mobile-live-court-voice, pass 3) — terminal-outcome flip.
 *
 * Attack: the analysis provider first reports an event as terminal
 * `low_confidence` (state 'ready', no scored result) and a LATER snapshot
 * reports the SAME eventId as terminal `scored`. A coach that keyed dedupe on
 * (eventId, kind) would speak twice; one that reset on the new result would
 * re-cue. Contract (liveSessionCoach.ts L158-166): each event speaks once —
 * the FIRST terminal outcome wins and the later flip is ignored.
 *
 * Also covered: abstained→scored flip, scored→low_confidence flip, duplicate
 * eventIds inside ONE snapshot, rapid repeats of the flipped snapshot, event
 * reordering between snapshots, and clock skew (durationMs going backwards).
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CheckpointKey, FaultDirection } from '@pickle/shared-types';
import {
  LiveSessionCoach,
  type CoachVoicePort,
  type SpokenCue,
} from '../../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../../src/flow/session';

interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
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
        applicable: true,
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

function view(
  eventId: string,
  index: number,
  partial: Partial<SessionEventView>,
): SessionEventView {
  return {
    eventId,
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
    sessionId: 'attack-s1',
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

const lowConfidenceE1 = view('E1', 0, {
  state: 'ready',
  analysis: lowConfidenceAnalysis(),
});
const scoredE1 = view('E1', 0, {
  state: 'ready',
  analysis: scoredAnalysis(6.2, [kneeFault]),
});
const abstainedE1 = view('E1', 0, {
  state: 'abstained',
  abstainReason: 'unresolved_stroke',
});

describe('ADVERSARIAL S1: same eventId, terminal outcome flips between snapshots', () => {
  it('low_confidence → scored: first terminal outcome wins, exactly one cue', () => {
    const { voice, spoken } = makeVoice();
    const hud: SpokenCue[] = [];
    const coach = new LiveSessionCoach({ voice, onCue: cue => hud.push(cue) });

    coach.consumeSnapshot(snap([lowConfidenceE1]));
    expect(spoken).toHaveLength(1);
    expect(hud[0]?.category).toBe('NO_READ');

    coach.consumeSnapshot(snap([scoredE1]));
    // A second cue for E1 would be a double-speak; a re-cue as CORRECTION
    // would be the "later result wins" failure mode. Neither may happen.
    expect(spoken).toHaveLength(1);
    expect(hud).toHaveLength(1);
    expect(hud[0]?.eventId).toBe('E1');
    expect(hud[0]?.category).toBe('NO_READ');

    const recap = coach.recap();
    expect(recap.cues.filter(cue => cue.eventId === 'E1')).toHaveLength(1);
    expect(recap.correctionsByCheckpoint).toEqual({});
    expect(recap.topCorrection).toBeNull();
  });

  it('abstained → scored: the abstention stands, no correction is spoken later', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([abstainedE1]));
    coach.consumeSnapshot(snap([scoredE1]));
    expect(spoken).toHaveLength(1);
    expect(coach.recap().cues.map(cue => cue.category)).toEqual(['NO_READ']);
  });

  it('scored → low_confidence: the correction stands, no no-read is spoken later', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([scoredE1]));
    coach.consumeSnapshot(snap([lowConfidenceE1]));
    expect(spoken).toHaveLength(1);
    expect(coach.recap().cues.map(cue => cue.category)).toEqual(['CORRECTION']);
    expect(coach.recap().correctionsByCheckpoint).toEqual({ athletic_base: 1 });
  });

  it('rapid repeats: 500 flipped snapshots never add a cue', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([lowConfidenceE1]));
    for (let i = 0; i < 500; i += 1) {
      coach.consumeSnapshot(snap([i % 2 === 0 ? scoredE1 : lowConfidenceE1]));
    }
    expect(spoken).toHaveLength(1);
    expect(coach.recap().cues).toHaveLength(1);
  });

  it('duplicate eventId inside ONE snapshot (low_confidence then scored) speaks once', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([lowConfidenceE1, scoredE1]));
    expect(spoken).toHaveLength(1);
    expect(coach.recap().cues[0]?.category).toBe('NO_READ');
  });

  it('flip does not perturb the cue-engine state for the NEXT event', () => {
    // Two coaches: one sees the flip, the other never does. Event E2 must
    // get the identical decision from both — the ignored flip must not
    // have advanced rep counters or streaks.
    const flipped = makeVoice();
    const clean = makeVoice();
    const a = new LiveSessionCoach({ voice: flipped.voice });
    const b = new LiveSessionCoach({ voice: clean.voice });
    a.consumeSnapshot(snap([lowConfidenceE1]));
    a.consumeSnapshot(snap([scoredE1]));
    b.consumeSnapshot(snap([lowConfidenceE1]));
    const e2 = view('E2', 1, {
      state: 'ready',
      analysis: scoredAnalysis(6.2, [kneeFault]),
    });
    a.consumeSnapshot(snap([scoredE1, e2]));
    b.consumeSnapshot(snap([lowConfidenceE1, e2]));
    expect(flipped.spoken).toEqual(clean.spoken);
    expect(a.recap().cues.map(c => [c.eventId, c.category])).toEqual(
      b.recap().cues.map(c => [c.eventId, c.category]),
    );
  });

  it('event reordering between snapshots does not create a second cue', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const e2 = view('E2', 1, {
      state: 'ready',
      analysis: scoredAnalysis(7.4, []),
    });
    coach.consumeSnapshot(snap([lowConfidenceE1, e2]));
    coach.consumeSnapshot(snap([e2, scoredE1]));
    coach.consumeSnapshot(snap([scoredE1, e2]));
    expect(spoken).toHaveLength(2);
    expect(coach.recap().cues.map(c => c.eventId)).toEqual(['E1', 'E2']);
  });

  it('clock skew: a snapshot whose durationMs went backwards still dedupes and logs the given clock', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([lowConfidenceE1], { durationMs: 5000 }));
    coach.consumeSnapshot(snap([scoredE1], { durationMs: 100 }));
    const e2 = view('E2', 1, {
      state: 'ready',
      analysis: scoredAnalysis(7.4, []),
    });
    coach.consumeSnapshot(snap([scoredE1, e2], { durationMs: 50 }));
    expect(spoken).toHaveLength(2);
    expect(coach.recap().cues.map(c => c.atMs)).toEqual([5000, 50]);
  });

  it('unicode / huge eventIds dedupe by exact string identity', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const id = '🥒'.repeat(10_000) + '\u0000\uFEFF';
    const low = view(id, 0, {
      state: 'ready',
      analysis: lowConfidenceAnalysis(),
    });
    const scored = view(id, 0, {
      state: 'ready',
      analysis: scoredAnalysis(6.2, [kneeFault]),
    });
    coach.consumeSnapshot(snap([low]));
    coach.consumeSnapshot(snap([scored]));
    // NFC-different but visually identical id is a DIFFERENT event.
    const other = view(id + '\u0301', 1, {
      state: 'ready',
      analysis: scoredAnalysis(6.2, [kneeFault]),
    });
    coach.consumeSnapshot(snap([scored, other]));
    expect(spoken).toHaveLength(2);
  });

  it('EVIDENCE: the session-end line is computed from the FINAL snapshot, so a flipped event counts as scored in the wrap-up even though the coach called it a no-read', () => {
    // Not a dedupe failure — documents the one place the later result
    // surfaces. The wrap-up is honest about the final data set.
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([lowConfidenceE1]));
    coach.consumeSnapshot(snap([scoredE1]));
    coach.sessionEnded(snap([scoredE1]));
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatch(/No read|Couldn't read|Missed/);
    expect(spoken[1]).toBe('Session over. One scored swing at 6.2.');
  });
});
