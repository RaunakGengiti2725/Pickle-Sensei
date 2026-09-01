/**
 * Session score progression math (src/flow/sessionProgress.ts): honest
 * bucket counts, index-ordered points, start/end window averages and the
 * unclamped start→end delta. Pure functions — no rendering.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { SessionEventView } from '../src/flow/session';
import {
  sessionScoreProgression,
  type SessionScorePoint,
} from '../src/flow/sessionProgress';

const scored = (overallScore: number) =>
  ({
    result: { resultKind: 'scored', overallScore },
  } as unknown as AnalysisRecord);
const lowConf = () =>
  ({
    result: { resultKind: 'low_confidence', overallScore: null },
  } as unknown as AnalysisRecord);
const resultless = () => ({ result: null } as unknown as AnalysisRecord);

function view(partial: Partial<SessionEventView>): SessionEventView {
  return {
    eventId: 'E1',
    index: 0,
    startMs: 0,
    endMs: 500,
    peakMs: 250,
    durationMs: 500,
    peakSpeed: 1,
    paddleConfirmed: false,
    closeReason: 'settle',
    closedAtMs: 600,
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

/** A ready event with a REAL scored result at the given emission index. */
function rep(index: number, score: number): SessionEventView {
  return view({
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 500,
    state: 'ready',
    analysis: scored(score),
  });
}

describe('sessionScoreProgression', () => {
  it('handles an empty session: all zeros/nulls, windowSize 1', () => {
    const progression = sessionScoreProgression([]);
    expect(progression.points).toEqual([]);
    expect(progression.scoredCount).toBe(0);
    expect(progression.noReadCount).toBe(0);
    expect(progression.pendingCount).toBe(0);
    expect(progression.startAverage).toBeNull();
    expect(progression.endAverage).toBeNull();
    expect(progression.delta).toBeNull();
    expect(progression.best).toBeNull();
    expect(progression.windowSize).toBe(1);
  });

  it('counts pending AND processing events as pending — no points, no averages', () => {
    const progression = sessionScoreProgression([
      view({ eventId: 'E1', index: 0, state: 'pending' }),
      view({ eventId: 'E2', index: 1, state: 'processing' }),
    ]);
    expect(progression.pendingCount).toBe(2);
    expect(progression.scoredCount).toBe(0);
    expect(progression.noReadCount).toBe(0);
    expect(progression.points).toEqual([]);
    expect(progression.startAverage).toBeNull();
    expect(progression.endAverage).toBeNull();
    expect(progression.delta).toBeNull();
    expect(progression.best).toBeNull();
  });

  it('a single scored rep: start === end === score, delta null, best set', () => {
    const progression = sessionScoreProgression([rep(0, 6.4)]);
    expect(progression.scoredCount).toBe(1);
    expect(progression.windowSize).toBe(1);
    expect(progression.startAverage).toBe(6.4);
    expect(progression.endAverage).toBe(6.4);
    // One swing has no movement to report — never a fake 0 delta.
    expect(progression.delta).toBeNull();
    expect(progression.best).toEqual({
      eventId: 'E1',
      eventIndex: 0,
      endMs: 500,
      score: 6.4,
    });
  });

  it('an improving 8-rep session: window 3, start 5.2 → end 6.7, delta +1.5', () => {
    const scores = [5.0, 5.2, 5.4, 5.8, 6.0, 6.4, 6.6, 7.0];
    const progression = sessionScoreProgression(
      scores.map((score, index) => rep(index, score)),
    );
    expect(progression.scoredCount).toBe(8);
    expect(progression.windowSize).toBe(3);
    expect(progression.points.map(point => point.score)).toEqual(scores);
    // start = round1((5.0 + 5.2 + 5.4) / 3) = round1(15.6 / 3) = 5.2
    expect(progression.startAverage).toBe(5.2);
    // end = round1((6.4 + 6.6 + 7.0) / 3) = round1(20 / 3 = 6.666…) = 6.7
    expect(progression.endAverage).toBe(6.7);
    // delta = round1(6.7 - 5.2) = 1.5
    expect(progression.delta).toBe(1.5);
    expect(progression.delta).toBeGreaterThan(0);
    expect(progression.best).toEqual({
      eventId: 'E8',
      eventIndex: 7,
      endMs: 7500,
      score: 7.0,
    });
  });

  it('a declining session reports the negative delta honestly — never clamped', () => {
    const progression = sessionScoreProgression([
      rep(0, 7.0),
      rep(1, 6.8),
      rep(2, 6.2),
      rep(3, 5.6),
    ]);
    expect(progression.windowSize).toBe(2);
    // start = round1((7.0 + 6.8) / 2) = 6.9; end = round1((6.2 + 5.6) / 2) = 5.9
    expect(progression.startAverage).toBe(6.9);
    expect(progression.endAverage).toBe(5.9);
    expect(progression.delta).toBe(-1);
    expect(progression.delta).toBeLessThan(0);
  });

  it('splits a mixed session into the right buckets', () => {
    const progression = sessionScoreProgression([
      rep(0, 6.0),
      view({
        eventId: 'E2',
        index: 1,
        state: 'abstained',
        abstainReason: 'NO_POSE',
      }),
      view({ eventId: 'E3', index: 2, state: 'ready', analysis: lowConf() }),
      view({ eventId: 'E4', index: 3, state: 'pending' }),
      view({ eventId: 'E5', index: 4, state: 'processing' }),
      rep(5, 7.2),
    ]);
    expect(progression.scoredCount).toBe(2);
    expect(progression.noReadCount).toBe(2); // abstained + low_confidence
    expect(progression.pendingCount).toBe(2); // pending + processing
    expect(progression.points.map(point => point.eventId)).toEqual([
      'E1',
      'E6',
    ]);
    expect(progression.best?.eventId).toBe('E6');
  });

  it('re-sorts shuffled input by event index — points and windows follow event order', () => {
    // Emission order E1..E4 scores 5.0, 5.5, 6.0, 6.5 — fed shuffled.
    const progression = sessionScoreProgression([
      rep(3, 6.5),
      rep(0, 5.0),
      rep(2, 6.0),
      rep(1, 5.5),
    ]);
    expect(progression.points.map(point => point.eventIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(progression.points.map(point => point.score)).toEqual([
      5.0, 5.5, 6.0, 6.5,
    ]);
    expect(progression.points.map(point => point.endMs)).toEqual([
      500, 1500, 2500, 3500,
    ]);
    expect(progression.windowSize).toBe(2);
    // Windows use event order, not input order:
    // start = round1((5.0 + 5.5) / 2 = 5.25) = 5.3; end = round1((6.0 + 6.5) / 2 = 6.25) = 6.3
    expect(progression.startAverage).toBe(5.3);
    expect(progression.endAverage).toBe(6.3);
    expect(progression.delta).toBe(1);
  });

  it('two scored reps (window 1): start = first, end = second, delta = difference', () => {
    const progression = sessionScoreProgression([rep(0, 4.5), rep(1, 6.1)]);
    expect(progression.windowSize).toBe(1);
    expect(progression.startAverage).toBe(4.5);
    expect(progression.endAverage).toBe(6.1);
    // delta = round1(6.1 - 4.5) = 1.6
    expect(progression.delta).toBe(1.6);
  });

  it('best-score ties go to the earliest event, whatever the input order', () => {
    const progression = sessionScoreProgression([
      rep(4, 6.5),
      rep(1, 6.5),
      rep(2, 5.0),
    ]);
    const best = progression.best as SessionScorePoint;
    expect(best.eventId).toBe('E2');
    expect(best.eventIndex).toBe(1);
    expect(best.score).toBe(6.5);
  });

  it('a ready event whose analysis has no result is a no-read, never a point', () => {
    const progression = sessionScoreProgression([
      view({ eventId: 'E1', index: 0, state: 'ready', analysis: resultless() }),
      rep(1, 5.5),
    ]);
    expect(progression.noReadCount).toBe(1);
    expect(progression.scoredCount).toBe(1);
    expect(progression.points.map(point => point.eventId)).toEqual(['E2']);
  });
});
