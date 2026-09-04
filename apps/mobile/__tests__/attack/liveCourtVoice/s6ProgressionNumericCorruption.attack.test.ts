/**
 * ADVERSARIAL S6 (mobile-live-court-voice, pass 3) — numerically corrupt
 * stored summaries reaching buildGameplayProgression.
 *
 * Scores are 0–10 (RepObservation "0–10 overall"), counts are consistent
 * (scoredCount ≤ strokeCount), correction tallies are ≥ 0, and deltas are
 * bounded by the score range. parseLiveSessionSummaryRecord
 * (liveSessionSummary.ts L74-76 finiteOrNull, L119-129) accepts ANY finite
 * number, and buildGameplayProgression (gameplayProgression.ts L71-84) charts
 * whatever it gets. A single corrupt row therefore rewrites the trend,
 * bestSession, overallDelta and the swing totals for the whole history.
 */
import type { LiveSessionHistoryRow } from '../../../src/data/repository';
import {
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../../../src/flow/liveSessionSummary';
import { buildGameplayProgression } from '../../../src/progress/gameplayProgression';

function record(
  overrides: Partial<LiveSessionSummaryRecordV1> = {},
): LiveSessionSummaryRecordV1 {
  return {
    version: 1,
    engineVersion: 'attack-engine',
    source: 'live',
    durationMs: 60_000,
    strokeCount: 6,
    scoredCount: 5,
    noReadCount: 1,
    pendingCount: 0,
    startAverage: 6.0,
    endAverage: 6.4,
    delta: 0.4,
    bestScore: 7.0,
    sessionAverage: 6.2,
    cuesSpoken: 5,
    topCorrection: 'athletic_base',
    correctionsByCheckpoint: { athletic_base: 3 },
    ...overrides,
  };
}

function row(
  id: string,
  summary: LiveSessionSummaryRecordV1,
  startedAt = '2026-09-04T10:00:00.000Z',
): LiveSessionHistoryRow {
  return {
    id,
    startedAt,
    endedAt: '2026-09-04T10:05:00.000Z',
    summary: JSON.stringify(summary),
  };
}

const healthy = [
  row(
    'h1',
    record({ sessionAverage: 6.0, bestScore: 6.8, delta: 0.2 }),
    '2026-09-01T10:00:00Z',
  ),
  row(
    'h2',
    record({ sessionAverage: 6.4, bestScore: 7.1, delta: 0.3 }),
    '2026-09-02T10:00:00Z',
  ),
  row(
    'h3',
    record({ sessionAverage: 6.6, bestScore: 7.4, delta: 0.1 }),
    '2026-09-03T10:00:00Z',
  ),
];

function inRange(value: number | null): boolean {
  return value === null || (value >= 0 && value <= 10);
}

describe('ADVERSARIAL S6: out-of-range numbers in stored summaries', () => {
  it('sessionAverage 999 is excluded or clamped — never a trend point / bestSession', () => {
    const rows = [
      ...healthy,
      row('bad', record({ sessionAverage: 999 }), '2026-09-04T10:00:00Z'),
    ];
    const progression = buildGameplayProgression(rows);
    expect(
      progression.trendPoints.every(point => point >= 0 && point <= 10),
    ).toBe(true);
    expect(inRange(progression.latestAverage)).toBe(true);
    expect(progression.bestSession?.sessionId).not.toBe('bad');
    expect(
      progression.overallDelta === null ||
        Math.abs(progression.overallDelta) <= 10,
    ).toBe(true);
  });

  it('negative sessionAverage / bestScore are excluded or clamped', () => {
    const rows = [
      ...healthy,
      row(
        'neg',
        record({ sessionAverage: -3.5, bestScore: -1 }),
        '2026-09-04T10:00:00Z',
      ),
    ];
    const progression = buildGameplayProgression(rows);
    expect(progression.trendPoints.every(point => point >= 0)).toBe(true);
    expect(progression.sessions.every(session => inRange(session.best))).toBe(
      true,
    );
  });

  it('scoredCount > strokeCount is rejected or clamped so swing totals stay consistent', () => {
    const rows = [
      ...healthy,
      row(
        'counts',
        record({ scoredCount: 50_000, strokeCount: 3 }),
        '2026-09-04T10:00:00Z',
      ),
    ];
    const progression = buildGameplayProgression(rows);
    expect(progression.totalScoredSwings).toBeLessThanOrEqual(
      progression.totalStrokeEvents,
    );
    for (const session of progression.sessions) {
      expect(session.scoredCount).toBeLessThanOrEqual(session.strokeCount);
    }
  });

  it('negative correctionsByCheckpoint values are dropped by the parser', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(
        record({
          correctionsByCheckpoint: { athletic_base: -5, paddle_set: 2 },
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(
      Object.values(parsed!.correctionsByCheckpoint).every(value => value >= 0),
    ).toBe(true);
    expect(parsed!.correctionsByCheckpoint).toEqual({ paddle_set: 2 });
  });

  it('delta -1e308 / +1e308 is excluded or clamped to the score range', () => {
    const rows = [
      ...healthy,
      row('d1', record({ delta: -1e308 }), '2026-09-04T10:00:00Z'),
      row('d2', record({ delta: 1e308 }), '2026-09-05T10:00:00Z'),
    ];
    const progression = buildGameplayProgression(rows);
    for (const session of progression.sessions) {
      expect(session.delta === null || Math.abs(session.delta) <= 10).toBe(
        true,
      );
    }
    // A +1e308 "delta" must not be counted as an improved session.
    expect(progression.improvedSessions).toBe(3);
  });

  it('two extreme averages must not drive overallDelta to ±Infinity', () => {
    const rows = [
      row('lo', record({ sessionAverage: -1e308 }), '2026-09-01T10:00:00Z'),
      row('hi', record({ sessionAverage: 1e308 }), '2026-09-02T10:00:00Z'),
    ];
    const progression = buildGameplayProgression(rows);
    expect(
      progression.overallDelta === null ||
        Number.isFinite(progression.overallDelta),
    ).toBe(true);
  });

  it('startAverage/endAverage/delta must be mutually consistent (delta = end - start)', () => {
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(
        record({ startAverage: 6.0, endAverage: 6.4, delta: 9.9 }),
      ),
    );
    expect(parsed).not.toBeNull();
    // Either the parser recomputes/nulls the inconsistent delta or rejects the row.
    expect(parsed!.delta === null || Math.abs(parsed!.delta - 0.4) < 1e-9).toBe(
      true,
    );
  });

  it('sessionAverage present with scoredCount 0 is contradictory and must not chart', () => {
    const rows = [
      ...healthy,
      row(
        'zero',
        record({ scoredCount: 0, sessionAverage: 9.9, bestScore: 9.9 }),
      ),
    ];
    const progression = buildGameplayProgression(rows);
    // buildGameplayProgression already filters scoredCount > 0 for the trend
    // (L79-81) — pinning that this HOLDS.
    expect(progression.trendPoints).toEqual([6.0, 6.4, 6.6]);
    expect(progression.bestSession?.sessionId).toBe('h3');
  });

  it('EVIDENCE: on 4d812e1a one row with sessionAverage 999 becomes the latest trend point, bestSession and a +993 overallDelta', () => {
    const rows = [
      ...healthy,
      row('bad', record({ sessionAverage: 999 }), '2026-09-04T10:00:00Z'),
    ];
    const progression = buildGameplayProgression(rows);
    expect(progression.trendPoints).toEqual([6.0, 6.4, 6.6, 999]);
    expect(progression.latestAverage).toBe(999);
    expect(progression.bestSession?.sessionId).toBe('bad');
    expect(progression.overallDelta).toBe(993);
  });

  it('EVIDENCE: on 4d812e1a scoredCount 50000 / strokeCount 3 inflates totalScoredSwings past totalStrokeEvents', () => {
    const rows = [
      ...healthy,
      row(
        'counts',
        record({ scoredCount: 50_000, strokeCount: 3 }),
        '2026-09-04T10:00:00Z',
      ),
    ];
    const progression = buildGameplayProgression(rows);
    expect(progression.totalScoredSwings).toBe(15 + 50_000);
    expect(progression.totalStrokeEvents).toBe(18 + 3);
  });

  it('EVIDENCE: on 4d812e1a ±1e308 averages give overallDelta = Infinity and a negative correction tally survives the parser', () => {
    const progression = buildGameplayProgression([
      row('lo', record({ sessionAverage: -1e308 }), '2026-09-01T10:00:00Z'),
      row('hi', record({ sessionAverage: 1e308 }), '2026-09-02T10:00:00Z'),
    ]);
    expect(progression.overallDelta).toBe(Infinity);
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(
        record({ correctionsByCheckpoint: { athletic_base: -5 } }),
      ),
    );
    expect(parsed!.correctionsByCheckpoint).toEqual({ athletic_base: -5 });
  });
});
