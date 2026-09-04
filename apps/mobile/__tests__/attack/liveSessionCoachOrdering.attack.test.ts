/**
 * ADVERSARIAL PASS 3 / tester #4 — scenarios S4, S5, S6, S7 (+ extras).
 * LiveSessionCoach event ordering, dedupe, mute interruptions and the live
 * cue policy across unreadable swings, driven through consumeSnapshot().
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import {
  LiveSessionCoach,
  type CoachVoicePort,
  type SpokenCue,
} from '../../src/flow/liveSessionCoach';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';

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

function view(
  index: number,
  partial: Partial<SessionEventView>,
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
    sessionId: 'attack-session',
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
    engineVersion: 'attack-engine-1',
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

const kneeLow = (score: number, severity = 0.5): CheckpointSpec => ({
  key: 'athletic_base',
  score,
  direction: 'low',
  severity,
});

const ready = (index: number, analysis: AnalysisRecord): SessionEventView =>
  view(index, { state: 'ready', analysis });
const abstained = (index: number): SessionEventView =>
  view(index, { state: 'abstained', abstainReason: 'POSE_TOO_SPARSE' });
const processing = (index: number): SessionEventView =>
  view(index, { state: 'processing' });

function eventCues(coach: LiveSessionCoach): SpokenCue[] {
  return coach.recap().cues.filter(cue => cue.eventId !== null);
}

describe('S4 — CORRECTION(athletic_base) → NO_READ → athletic_base improved by ≥ 8', () => {
  it('acknowledges the improvement on the corrected checkpoint despite the intervening no-read', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    // Rep 1: knee bend fault (score 40) → CORRECTION(athletic_base).
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(6.0, [kneeLow(40)]))]));
    // Rep 2: analyzer could not read the swing.
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeLow(40)])),
        ready(1, lowConfidenceAnalysis()),
      ]),
    );
    // Rep 3: athletic_base 40 → 52 (+12 ≥ improvementDelta 8), still the
    // worst checkpoint but clearly better. Overall 5.9 < 6.0 so this is NOT
    // a personal best — the improvement branch is the only candidate.
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeLow(40)])),
        ready(1, lowConfidenceAnalysis()),
        ready(2, scoredAnalysis(5.9, [kneeLow(52, 0.35)])),
      ]),
    );
    const cues = eventCues(coach);
    expect(cues.map(cue => cue.category)).toEqual([
      'CORRECTION',
      'NO_READ',
      'IMPROVEMENT',
    ]);
    expect(cues[2]!.targetCheckpoint).toBe('athletic_base');
  });

  it('control: the same improvement WITHOUT the no-read is acknowledged', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(6.0, [kneeLow(40)]))]));
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeLow(40)])),
        ready(1, scoredAnalysis(5.9, [kneeLow(52, 0.35)])),
      ]),
    );
    expect(eventCues(coach).map(cue => cue.category)).toEqual([
      'CORRECTION',
      'IMPROVEMENT',
    ]);
  });

  it('observed today: after the no-read the better knee bend is re-corrected as a FRESH correction', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, [kneeLow(40)])),
        ready(1, lowConfidenceAnalysis()),
        ready(2, scoredAnalysis(5.9, [kneeLow(52, 0.35)])),
      ]),
    );
    const third = eventCues(coach)[2]!;
    // Pins the OBSERVED behavior so the artifact shows exactly what the
    // player hears on rep 3: the NO_READ overwrote lastSpoken, so neither the
    // improvement nor the repeat wording can fire.
    expect(third.category).toBe('CORRECTION');
    expect(third.targetCheckpoint).toBe('athletic_base');
    expect(third.text).not.toMatch(/^\d\.\d\. Still there/);
  });
});

describe('S5 — [abstained, abstained, scored 6.0, scored 6.5] personal best gating', () => {
  it('does not call a PERSONAL_BEST on only the second SCORED swing (no-reads must not count toward personalBestMinRep)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const clean: CheckpointSpec[] = [
      { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
    ];
    coach.consumeSnapshot(
      snap([
        abstained(0),
        abstained(1),
        ready(2, scoredAnalysis(6.0, clean)),
        ready(3, scoredAnalysis(6.5, clean)),
      ]),
    );
    const categories = eventCues(coach).map(cue => cue.category);
    expect(categories.slice(0, 3)).toEqual(['NO_READ', 'NO_READ', 'PRAISE']);
    expect(categories[3]).not.toBe('PERSONAL_BEST');
  });

  it('control: the same two scored swings with NO preceding no-reads are not a personal best', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const clean: CheckpointSpec[] = [
      { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
    ];
    coach.consumeSnapshot(
      snap([
        ready(0, scoredAnalysis(6.0, clean)),
        ready(1, scoredAnalysis(6.5, clean)),
      ]),
    );
    expect(eventCues(coach).map(cue => cue.category)).toEqual([
      'PRAISE',
      'PRAISE',
    ]);
  });
});

describe('S6 — out-of-order terminal outcomes across snapshots', () => {
  const e1Fault = scoredAnalysis(6.0, [kneeLow(40)]);
  const e2Fault = scoredAnalysis(6.2, [kneeLow(42)]);

  it('snapshot [E1 processing, E2 ready] then [E1 ready, E2 ready]: cue order, repIndex and categories', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([processing(0), ready(1, e2Fault)]));
    coach.consumeSnapshot(snap([ready(0, e1Fault), ready(1, e2Fault)]));
    const cues = eventCues(coach);
    expect(cues).toHaveLength(2);
    // Resolution order is the only order the coach can speak in (E2's
    // analysis existed first) — pinned so any change is deliberate.
    expect(cues.map(cue => cue.eventId)).toEqual(['E2', 'E1']);
    // E2 was the first thing said about the knee; E1 (the EARLIER swing)
    // repeats the same fault → the coach says "Still there" about a swing
    // that happened BEFORE the one it just corrected.
    expect(cues.map(cue => cue.category)).toEqual([
      'CORRECTION',
      'REPEAT_CORRECTION',
    ]);
    // Each event spoken exactly once, never re-spoken on later snapshots.
    coach.consumeSnapshot(snap([ready(0, e1Fault), ready(1, e2Fault)]));
    expect(eventCues(coach)).toHaveLength(2);
  });

  it('later cue for an earlier event is never a REPEAT_CORRECTION of a later event (chronology)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([processing(0), ready(1, e2Fault)]));
    coach.consumeSnapshot(snap([ready(0, e1Fault), ready(1, e2Fault)]));
    const e1Cue = eventCues(coach).find(cue => cue.eventId === 'E1')!;
    expect(e1Cue.category).not.toBe('REPEAT_CORRECTION');
  });

  it('a snapshot whose events array arrives reversed speaks each event once, in ARRAY order (index is not consulted)', () => {
    // buildEventViews always emits index order, so this cannot come from a
    // LiveSessionFlow today — pinned so the assumption is visible.
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(1, e2Fault), ready(0, e1Fault)]));
    const cues = eventCues(coach);
    expect(cues).toHaveLength(2);
    expect(cues.map(cue => cue.eventId)).toEqual(['E2', 'E1']);
  });

  it('three events resolving in [E3, E1, E2] order: personal-best/no-read streak math follows resolution order', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const clean: CheckpointSpec[] = [
      { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
    ];
    const s1 = scoredAnalysis(5.0, clean);
    const s2 = scoredAnalysis(7.0, clean);
    const s3 = scoredAnalysis(6.0, clean);
    coach.consumeSnapshot(snap([processing(0), processing(1), ready(2, s3)]));
    coach.consumeSnapshot(snap([ready(0, s1), processing(1), ready(2, s3)]));
    coach.consumeSnapshot(snap([ready(0, s1), ready(1, s2), ready(2, s3)]));
    const cues = eventCues(coach);
    expect(cues.map(cue => cue.eventId)).toEqual(['E3', 'E1', 'E2']);
    // Chronologically E2 (7.0) is the session's best AND the last scored
    // swing before E3 — a PERSONAL_BEST call on E2 is legitimate whichever
    // way it is ordered; E1 (5.0) must never be praised as a best.
    expect(cues.find(cue => cue.eventId === 'E1')!.category).not.toBe(
      'PERSONAL_BEST',
    );
  });
});

describe('S7 — mute toggled between consecutive snapshots', () => {
  const fault = scoredAnalysis(6.0, [kneeLow(40)]);
  const fault2 = scoredAnalysis(6.1, [kneeLow(41)]);
  const fault3 = scoredAnalysis(6.2, [kneeLow(42)]);

  it('stop() fires once per mute, muted cues are captioned (spoken:false), later cues resume spoken:true', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, fault)]));
    expect(stop).toHaveBeenCalledTimes(0);

    coach.setMuted(true);
    expect(stop).toHaveBeenCalledTimes(1);
    coach.consumeSnapshot(snap([ready(0, fault), ready(1, fault2)]));
    coach.setMuted(false);
    expect(stop).toHaveBeenCalledTimes(1);
    coach.consumeSnapshot(
      snap([ready(0, fault), ready(1, fault2), ready(2, fault3)]),
    );

    const cues = eventCues(coach);
    expect(cues.map(cue => cue.eventId)).toEqual(['E1', 'E2', 'E3']);
    expect(cues.map(cue => cue.spoken)).toEqual([true, false, true]);
    expect(spoken).toHaveLength(2);
    expect(coach.recap().spokenCount).toBe(2);
  });

  it('rapid mute/unmute/mute toggling: stop() once per mute transition, unmute never stops', () => {
    const { voice, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.setMuted(true);
    coach.setMuted(false);
    coach.setMuted(true);
    coach.setMuted(false);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(coach.isMuted()).toBe(false);
  });

  it('muting twice in a row (UI double-tap) calls stop() per setMuted(true) call — harmless on an idle synthesizer', () => {
    const { voice, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.setMuted(true);
    coach.setMuted(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(coach.isMuted()).toBe(true);
  });

  it('mute flipped INSIDE the onCue observer mid-snapshot applies to the very next cue', () => {
    const { voice, spoken } = makeVoice();
    let coach: LiveSessionCoach | null = null;
    coach = new LiveSessionCoach({
      voice,
      onCue: cue => {
        if (cue.eventId === 'E1') coach?.setMuted(true);
      },
    });
    coach.consumeSnapshot(snap([ready(0, fault), ready(1, fault2)]));
    expect(eventCues(coach).map(cue => cue.spoken)).toEqual([true, false]);
    expect(spoken).toHaveLength(1);
  });

  it('a session that starts muted still logs every cue and speaks nothing until unmuted', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice, muted: true });
    coach.sessionStarted('live');
    coach.consumeSnapshot(snap([ready(0, fault)]));
    expect(spoken).toHaveLength(0);
    expect(coach.recap().cues).toHaveLength(2);
    expect(stop).toHaveBeenCalledTimes(0);
    coach.setMuted(false);
    coach.consumeSnapshot(snap([ready(0, fault), ready(1, fault2)]));
    expect(spoken).toHaveLength(1);
    expect(coach.lastCue()?.spoken).toBe(true);
  });
});

describe('extras — dispose mid-flight, ended-coach late snapshots, hostile text', () => {
  const fault = scoredAnalysis(6.0, [kneeLow(40)]);

  it('dispose() mid-session stops the voice once and silences later snapshots without losing the log', () => {
    const { voice, spoken, stop } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.sessionStarted('live');
    coach.consumeSnapshot(snap([ready(0, fault)]));
    coach.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    coach.consumeSnapshot(snap([ready(0, fault), ready(1, fault)]));
    expect(eventCues(coach)).toHaveLength(1);
    expect(spoken).toHaveLength(2);
    // sessionEnded after dispose must not speak a wrap-up to an empty court.
    coach.sessionEnded(snap([ready(0, fault), ready(1, fault)]));
    expect(spoken).toHaveLength(2);
    expect(coach.recap().cues.map(cue => cue.category)).not.toContain(
      'SESSION_END',
    );
  });

  it('sessionEnded() twice speaks the wrap-up once', () => {
    const { voice, spoken } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const final = snap([ready(0, fault)], { phase: 'ended' });
    coach.consumeSnapshot(final);
    coach.sessionEnded(final);
    coach.sessionEnded(final);
    expect(
      coach.recap().cues.filter(cue => cue.category === 'SESSION_END'),
    ).toHaveLength(1);
    expect(spoken).toHaveLength(2);
  });

  it('a snapshot with 2,000 terminal events is consumed in one pass with one cue each', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const events = Array.from({ length: 2000 }, (_, i) =>
      i % 5 === 0 ? abstained(i) : ready(i, fault),
    );
    coach.consumeSnapshot(snap(events));
    const cues = eventCues(coach);
    expect(cues).toHaveLength(2000);
    expect(new Set(cues.map(cue => cue.eventId)).size).toBe(2000);
    coach.consumeSnapshot(snap(events));
    expect(eventCues(coach)).toHaveLength(2000);
  });

  it('a duplicate eventId with a DIFFERENT outcome later is never re-spoken (append-only)', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    coach.consumeSnapshot(snap([ready(0, fault)]));
    coach.consumeSnapshot(snap([abstained(0)]));
    coach.consumeSnapshot(snap([ready(0, scoredAnalysis(9.9, []))]));
    const cues = eventCues(coach);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.category).toBe('CORRECTION');
  });

  it('unicode / pathological eventIds are tracked verbatim for dedupe', () => {
    const { voice } = makeVoice();
    const coach = new LiveSessionCoach({ voice });
    const weird = ['', ' ', '🏓', 'E1\u0000', '__proto__', 'constructor'];
    const events = weird.map((id, i) =>
      view(i, { eventId: id, state: 'ready', analysis: fault }),
    );
    coach.consumeSnapshot(snap(events));
    coach.consumeSnapshot(snap(events));
    const cues = eventCues(coach);
    expect(cues).toHaveLength(weird.length);
    expect(cues.map(cue => cue.eventId)).toEqual(weird);
  });
});
