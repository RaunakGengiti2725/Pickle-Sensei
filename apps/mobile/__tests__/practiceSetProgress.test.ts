import type { RealAnalysisFact } from '../src/data/repository';
import {
  DEFAULT_LATEST_SET_MAX_AGE_MS,
  fixedCheckpointsBetween,
  formatTenthsDelta,
  latestPracticeSet,
  practiceSetHeadline,
  practiceSetInsight,
  practiceSetTrend,
  scoreTenths,
  summarizePracticeSet,
} from '../src/progress/practiceSetProgress';

/**
 * Practice set arithmetic: chronological ordering, exact integer-tenths
 * deltas, the held/improved/slipped thresholds, the comparability rule
 * (never mix scoring models or strokes), fixed-checkpoint detection, and the
 * headline/insight copy with a real minus sign.
 */

const SET = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_SET = 'aaaaaaaa-0000-4000-8000-000000000002';
const T0 = '2026-09-02T17:00:00.000Z';
const MINUS = '\u2212';

function at(minutes: number, from = T0): string {
  return new Date(Date.parse(from) + minutes * 60_000).toISOString();
}

let sequence = 0;

function fact(overrides: Partial<RealAnalysisFact> = {}): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${String(sequence).padStart(3, '0')}`,
    shotType: 'forehand_drive',
    capturedAt: at(sequence),
    overallScore: 7,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'sm-v2',
    shotConfigVersion: 'forehand_drive@1',
    sessionId: SET,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

beforeEach(() => {
  sequence = 0;
});

describe('scoreTenths / practiceSetTrend / formatTenthsDelta', () => {
  it('converts one-decimal scores to exact integer tenths', () => {
    expect(scoreTenths(7.4)).toBe(74);
    expect(scoreTenths(6.6)).toBe(66);
    expect(scoreTenths(10)).toBe(100);
    expect(scoreTenths(0)).toBe(0);
    // Float-noisy inputs still land on the exact tenth.
    expect(scoreTenths(7.15)).toBe(72);
    expect(scoreTenths(0.1 + 0.2)).toBe(3);
  });

  it('applies the three-tenths threshold on both sides', () => {
    expect(practiceSetTrend(3)).toBe('improved');
    expect(practiceSetTrend(2)).toBe('held');
    expect(practiceSetTrend(0)).toBe('held');
    expect(practiceSetTrend(-2)).toBe('held');
    expect(practiceSetTrend(-3)).toBe('slipped');
    expect(practiceSetTrend(15)).toBe('improved');
  });

  it('formats signed one-decimal deltas with a real minus sign', () => {
    expect(formatTenthsDelta(8)).toBe('+0.8');
    expect(formatTenthsDelta(-3)).toBe(`${MINUS}0.3`);
    expect(formatTenthsDelta(0)).toBe('+0.0');
    expect(formatTenthsDelta(15)).toBe('+1.5');
    expect(formatTenthsDelta(-3)).not.toContain('-');
  });
});

describe('summarizePracticeSet', () => {
  it('orders attempts chronologically regardless of input order and measures latest − first exactly', () => {
    const summary = summarizePracticeSet(
      [
        fact({ id: 'c', capturedAt: at(30), overallScore: 7.4 }),
        fact({ id: 'a', capturedAt: at(10), overallScore: 6.6 }),
        fact({ id: 'b', capturedAt: at(20), overallScore: 6.9 }),
      ],
      SET,
    );
    expect(summary).not.toBeNull();
    expect(summary!.attempts.map(attempt => attempt.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(summary!.first.id).toBe('a');
    expect(summary!.latest.id).toBe('c');
    expect(summary!.best.id).toBe('c');
    // 7.4 − 6.6 in floats is 0.8000000000000007; in tenths it is exactly 8.
    expect(summary!.deltaTenths).toBe(8);
    expect(summary!.trend).toBe('improved');
    expect(summary!.startedAt).toBe(at(10));
    expect(summary!.endedAt).toBe(at(30));
    expect(summary!.shotType).toBe('forehand_drive');
    expect(summary!.sessionId).toBe(SET);
    expect(summary!.excludedCount).toBe(0);
  });

  it('breaks same-instant ties by id so the order never depends on row order', () => {
    const rows = [
      fact({ id: 'b', capturedAt: T0, overallScore: 7 }),
      fact({ id: 'a', capturedAt: T0, overallScore: 6 }),
    ];
    const forward = summarizePracticeSet(rows, SET)!;
    const reversed = summarizePracticeSet([...rows].reverse(), SET)!;
    expect(forward.attempts.map(a => a.id)).toEqual(['a', 'b']);
    expect(reversed.attempts.map(a => a.id)).toEqual(['a', 'b']);
    expect(forward.deltaTenths).toBe(10);
    expect(reversed.deltaTenths).toBe(10);
  });

  it('marks a slip and a hold by the same threshold', () => {
    const slipped = summarizePracticeSet(
      [
        fact({ capturedAt: at(1), overallScore: 7.2 }),
        fact({ capturedAt: at(2), overallScore: 6.9 }),
      ],
      SET,
    )!;
    expect(slipped.deltaTenths).toBe(-3);
    expect(slipped.trend).toBe('slipped');

    const held = summarizePracticeSet(
      [
        fact({ capturedAt: at(1), overallScore: 7.2 }),
        fact({ capturedAt: at(2), overallScore: 7.4 }),
      ],
      SET,
    )!;
    expect(held.deltaTenths).toBe(2);
    expect(held.trend).toBe('held');
  });

  it('best is the highest score; a tie goes to the most recent attempt', () => {
    const summary = summarizePracticeSet(
      [
        fact({ id: 'a', capturedAt: at(1), overallScore: 7.4 }),
        fact({ id: 'b', capturedAt: at(2), overallScore: 6.1 }),
        fact({ id: 'c', capturedAt: at(3), overallScore: 7.4 }),
      ],
      SET,
    )!;
    expect(summary.best.id).toBe('c');
    expect(summary.deltaTenths).toBe(0);
    expect(summary.trend).toBe('held');
  });

  it('returns null for a single attempt, an unknown set, or an empty id', () => {
    expect(summarizePracticeSet([fact()], SET)).toBeNull();
    expect(summarizePracticeSet([fact(), fact()], OTHER_SET)).toBeNull();
    expect(summarizePracticeSet([fact(), fact()], '')).toBeNull();
    expect(summarizePracticeSet([], SET)).toBeNull();
  });

  it('never counts abstentions, null scores, other sets, or corrupt timestamps as attempts', () => {
    const summary = summarizePracticeSet(
      [
        fact({ id: 'a', capturedAt: at(1), overallScore: 6 }),
        fact({
          id: 'abstained',
          capturedAt: at(2),
          overallScore: null,
          resultKind: 'low_confidence',
        }),
        fact({ id: 'other-set', capturedAt: at(3), sessionId: OTHER_SET }),
        fact({ id: 'no-set', capturedAt: at(4), sessionId: null }),
        fact({ id: 'corrupt', capturedAt: 'not a timestamp', overallScore: 9 }),
        fact({ id: 'b', capturedAt: at(5), overallScore: 6.5 }),
      ],
      SET,
    )!;
    expect(summary.attempts.map(a => a.id)).toEqual(['a', 'b']);
    expect(summary.excludedCount).toBe(0);
  });

  it('compares only attempts on the LATEST attempt’s scoring model + shot config and counts the rest', () => {
    const summary = summarizePracticeSet(
      [
        fact({
          id: 'old-model',
          capturedAt: at(1),
          overallScore: 5,
          scoringModelVersion: 'sm-v1',
        }),
        fact({ id: 'a', capturedAt: at(2), overallScore: 6.5 }),
        fact({
          id: 'old-config',
          capturedAt: at(3),
          overallScore: 9.9,
          shotConfigVersion: 'forehand_drive@0',
        }),
        fact({ id: 'b', capturedAt: at(4), overallScore: 7.1 }),
      ],
      SET,
    )!;
    expect(summary.attempts.map(a => a.id)).toEqual(['a', 'b']);
    expect(summary.excludedCount).toBe(2);
    expect(summary.deltaTenths).toBe(6);
    // The 9.9 on the other config never becomes "best".
    expect(summary.best.id).toBe('b');
  });

  it('a model change on the LATEST attempt makes the older reads the excluded ones', () => {
    const summary = summarizePracticeSet(
      [
        fact({ id: 'a', capturedAt: at(1), overallScore: 6 }),
        fact({ id: 'b', capturedAt: at(2), overallScore: 6.5 }),
        fact({
          id: 'c',
          capturedAt: at(3),
          overallScore: 7,
          scoringModelVersion: 'sm-v3',
        }),
      ],
      SET,
    );
    // Only one attempt on sm-v3 → no comparison is possible.
    expect(summary).toBeNull();
    const withTwo = summarizePracticeSet(
      [
        fact({ id: 'a', capturedAt: at(1), overallScore: 6 }),
        fact({ id: 'b', capturedAt: at(2), overallScore: 6.5 }),
        fact({
          id: 'c',
          capturedAt: at(3),
          overallScore: 7,
          scoringModelVersion: 'sm-v3',
        }),
        fact({
          id: 'd',
          capturedAt: at(4),
          overallScore: 7.5,
          scoringModelVersion: 'sm-v3',
        }),
      ],
      SET,
    )!;
    expect(withTwo.attempts.map(a => a.id)).toEqual(['c', 'd']);
    expect(withTwo.excludedCount).toBe(2);
  });

  it('uses the latest attempt’s stroke and drops other strokes from the comparison', () => {
    const summary = summarizePracticeSet(
      [
        fact({ id: 'fh-1', capturedAt: at(1), overallScore: 6 }),
        fact({
          id: 'bh',
          capturedAt: at(2),
          overallScore: 9,
          shotType: 'backhand_drive',
          shotConfigVersion: 'backhand_drive@1',
        }),
        fact({ id: 'fh-2', capturedAt: at(3), overallScore: 6.4 }),
      ],
      SET,
    )!;
    expect(summary.shotType).toBe('forehand_drive');
    expect(summary.attempts.map(a => a.id)).toEqual(['fh-1', 'fh-2']);
    expect(summary.best.id).toBe('fh-2');
    // A different stroke is not "a different scoring model" — it is simply
    // not this stroke's set.
    expect(summary.excludedCount).toBe(0);

    // Latest attempt is the backhand → a backhand-only set, and one backhand
    // is not comparable to anything.
    expect(
      summarizePracticeSet(
        [
          fact({ id: 'fh-1', capturedAt: at(1), overallScore: 6 }),
          fact({ id: 'fh-2', capturedAt: at(2), overallScore: 6.4 }),
          fact({
            id: 'bh',
            capturedAt: at(3),
            overallScore: 9,
            shotType: 'backhand_drive',
            shotConfigVersion: 'backhand_drive@1',
          }),
        ],
        SET,
      ),
    ).toBeNull();
  });

  it('detects fixed checkpoints (< 65 first → ≥ 80 latest) and keeps the still-open priority', () => {
    const summary = summarizePracticeSet(
      [
        fact({
          id: 'a',
          capturedAt: at(1),
          overallScore: 6.2,
          priorityCheckpoint: 'contact_position',
          checkpointScores: {
            contact_position: 48,
            follow_through: 64,
            paddle_set: 70,
            recovery: 40,
          },
        }),
        fact({
          id: 'b',
          capturedAt: at(2),
          overallScore: 7.4,
          priorityCheckpoint: 'recovery',
          checkpointScores: {
            contact_position: 81,
            follow_through: 80,
            paddle_set: 95, // was not below 65 → not "fixed"
            recovery: 79, // did not reach 80 → not "fixed"
            // athletic_base absent in first → never inferred
            athletic_base: 90,
          },
        }),
      ],
      SET,
    )!;
    expect(summary.fixedCheckpoints).toEqual([
      'contact_position',
      'follow_through',
    ]);
    expect(summary.stillOpen).toBe('recovery');
  });

  it('fixedCheckpointsBetween ignores checkpoints missing from either attempt', () => {
    expect(
      fixedCheckpointsBetween(
        {
          id: 'a',
          capturedAt: T0,
          overallScore: 6,
          priorityCheckpoint: null,
          checkpointScores: { contact_position: 40, recovery: 50 },
        },
        {
          id: 'b',
          capturedAt: T0,
          overallScore: 7,
          priorityCheckpoint: null,
          checkpointScores: { contact_position: 80 },
        },
      ),
    ).toEqual(['contact_position']);
  });

  it('tolerates facts from an older reader without a checkpoint map', () => {
    const legacy = {
      ...fact({ id: 'a', capturedAt: at(1), overallScore: 6 }),
      checkpointScores: undefined,
      priorityCheckpoint: undefined,
    } as unknown as RealAnalysisFact;
    const summary = summarizePracticeSet(
      [legacy, fact({ id: 'b', capturedAt: at(2), overallScore: 6.5 })],
      SET,
    )!;
    expect(summary.first.checkpointScores).toEqual({});
    expect(summary.first.priorityCheckpoint).toBeNull();
    expect(summary.fixedCheckpoints).toEqual([]);
  });
});

describe('latestPracticeSet', () => {
  it('picks the most recent set with a summary inside the window', () => {
    const facts = [
      // Older set, two comparable attempts, 3h ago.
      fact({
        id: 'o1',
        capturedAt: at(-190),
        overallScore: 6,
        sessionId: OTHER_SET,
      }),
      fact({
        id: 'o2',
        capturedAt: at(-180),
        overallScore: 6.5,
        sessionId: OTHER_SET,
      }),
      // Newer set, two comparable attempts, 20 minutes ago.
      fact({ id: 'n1', capturedAt: at(-30), overallScore: 7 }),
      fact({ id: 'n2', capturedAt: at(-20), overallScore: 7.3 }),
    ];
    const summary = latestPracticeSet(facts, { asOfIso: T0 });
    expect(summary?.sessionId).toBe(SET);
    expect(summary?.attempts.map(a => a.id)).toEqual(['n1', 'n2']);
  });

  it('a newer single-attempt set does not hide an older comparable one still in the window', () => {
    const facts = [
      fact({
        id: 'o1',
        capturedAt: at(-190),
        overallScore: 6,
        sessionId: OTHER_SET,
      }),
      fact({
        id: 'o2',
        capturedAt: at(-180),
        overallScore: 6.5,
        sessionId: OTHER_SET,
      }),
      fact({ id: 'n1', capturedAt: at(-5), overallScore: 7 }),
    ];
    expect(latestPracticeSet(facts, { asOfIso: T0 })?.sessionId).toBe(
      OTHER_SET,
    );
  });

  it('honors the max age (24h default) and never looks past asOf', () => {
    const facts = [
      fact({ id: 'a', capturedAt: at(-24 * 60 - 10), overallScore: 6 }),
      fact({ id: 'b', capturedAt: at(-24 * 60 - 1), overallScore: 6.5 }),
    ];
    expect(DEFAULT_LATEST_SET_MAX_AGE_MS).toBe(24 * 60 * 60_000);
    expect(latestPracticeSet(facts, { asOfIso: T0 })).toBeNull();
    expect(
      latestPracticeSet(facts, { asOfIso: T0, maxAgeMs: 25 * 60 * 60_000 })
        ?.sessionId,
    ).toBe(SET);

    // An attempt after asOf is invisible: the set falls back to one attempt.
    const straddling = [
      fact({ id: 'a', capturedAt: at(-10), overallScore: 6 }),
      fact({ id: 'future', capturedAt: at(+10), overallScore: 9 }),
    ];
    expect(latestPracticeSet(straddling, { asOfIso: T0 })).toBeNull();
    expect(
      latestPracticeSet(straddling, { asOfIso: at(+11) })?.attempts.map(
        a => a.id,
      ),
    ).toEqual(['a', 'future']);
  });

  it('returns null with no sets, and rejects an unparseable asOf', () => {
    expect(
      latestPracticeSet(
        [fact({ sessionId: null }), fact({ sessionId: null })],
        {
          asOfIso: T0,
        },
      ),
    ).toBeNull();
    expect(latestPracticeSet([], { asOfIso: T0 })).toBeNull();
    expect(() => latestPracticeSet([], { asOfIso: 'noon' })).toThrow(
      'parseable ISO timestamp',
    );
    expect(() => latestPracticeSet([], { asOfIso: T0, maxAgeMs: -1 })).toThrow(
      'non-negative',
    );
  });
});

describe('practiceSetHeadline / practiceSetInsight', () => {
  function summaryWith(
    scores: number[],
    extra: Partial<
      Pick<
        NonNullable<ReturnType<typeof summarizePracticeSet>>,
        'fixedCheckpoints' | 'stillOpen' | 'excludedCount'
      >
    > = {},
  ) {
    const summary = summarizePracticeSet(
      scores.map((overallScore, index) =>
        fact({ id: `s${index}`, capturedAt: at(index + 1), overallScore }),
      ),
      SET,
    )!;
    return { ...summary, ...extra };
  }

  it('headline states the exact tenths delta with a real minus sign, or a hold', () => {
    expect(practiceSetHeadline(summaryWith([6.6, 7.4]))).toBe(
      '+0.8 in this set',
    );
    expect(practiceSetHeadline(summaryWith([7.2, 6.9]))).toBe(
      `${MINUS}0.3 in this set`,
    );
    expect(practiceSetHeadline(summaryWith([7.2, 7.4]))).toBe(
      'Held steady in this set',
    );
    expect(practiceSetHeadline(summaryWith([7.4, 7.4]))).toBe(
      'Held steady in this set',
    );
    expect(practiceSetHeadline(summaryWith([5, 6.5]))).toBe('+1.5 in this set');
  });

  it('insight reports count, best, and a fixed checkpoint’s measured before → after', () => {
    const summary = summarizePracticeSet(
      [
        fact({
          id: 'a',
          capturedAt: at(1),
          overallScore: 6.2,
          checkpointScores: { contact_position: 48 },
        }),
        fact({ id: 'b', capturedAt: at(2), overallScore: 7.4 }),
        fact({
          id: 'c',
          capturedAt: at(3),
          overallScore: 7.1,
          priorityCheckpoint: 'recovery',
          checkpointScores: { contact_position: 81 },
        }),
      ],
      SET,
    )!;
    expect(practiceSetInsight(summary)).toBe(
      '3 attempts · best 7.4 · contact position improved from 48 to 81',
    );
  });

  it('insight falls back to the still-open priority checkpoint and names excluded attempts', () => {
    expect(
      practiceSetInsight(
        summaryWith([6.6, 7.4], { stillOpen: 'face_wrist_stability' }),
      ),
    ).toBe('2 attempts · best 7.4 · face / wrist stability still open');
    expect(
      practiceSetInsight(summaryWith([6.6, 7.4], { excludedCount: 1 })),
    ).toBe(
      '2 attempts · best 7.4 · 1 attempt on a different scoring model not compared',
    );
    expect(
      practiceSetInsight(summaryWith([6.6, 7.4, 7.0], { excludedCount: 2 })),
    ).toBe(
      '3 attempts · best 7.4 · 2 attempts on a different scoring model not compared',
    );
    // Unknown checkpoint keys are humanized, never rendered raw.
    expect(
      practiceSetInsight(summaryWith([6.6, 7.4], { stillOpen: 'hip_turn' })),
    ).toBe('2 attempts · best 7.4 · hip turn still open');
  });

  it('insight never mentions checkpoints when neither a fix nor a priority was measured', () => {
    expect(practiceSetInsight(summaryWith([6.6, 7.4]))).toBe(
      '2 attempts · best 7.4',
    );
  });
});
