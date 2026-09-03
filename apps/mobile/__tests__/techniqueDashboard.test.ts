import {
  buildTechniqueDashboard,
  formatSignedDelta,
  vsPriorLabel,
} from '../src/progress/techniqueDashboard';
import type { RealAnalysisFact } from '../src/data/repository';

const AS_OF = '2026-08-31T18:00:00.000Z';
const OPTIONS = { asOfIso: AS_OF, timeZone: 'UTC', range: '7d' as const };

let sequence = 0;

function fact(overrides: Partial<RealAnalysisFact> = {}): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: '2026-08-31T12:00:00.000Z',
    overallScore: 7,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

describe('vsPriorLabel', () => {
  it('names the comparison window for each range', () => {
    expect(vsPriorLabel('7d')).toBe('VS. PRIOR 7 DAYS');
    expect(vsPriorLabel('28d')).toBe('VS. PRIOR 4 WEEKS');
    expect(vsPriorLabel('90d')).toBe('VS. PRIOR 90 DAYS');
  });
});

describe('formatSignedDelta', () => {
  it('signs both directions and never renders -0.0', () => {
    expect(formatSignedDelta(0.42)).toBe('+0.4');
    expect(formatSignedDelta(-0.42)).toBe('-0.4');
    expect(formatSignedDelta(0)).toBe('+0.0');
    expect(formatSignedDelta(-0.001)).toBe('+0.0');
  });
});

describe('buildTechniqueDashboard', () => {
  it('splits key statistics between the current and prior windows', () => {
    const dashboard = buildTechniqueDashboard(
      [
        // Current window (Aug 25 – Aug 31).
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 8 }),
        fact({ capturedAt: '2026-08-30T11:00:00.000Z', overallScore: 6 }),
        fact({ capturedAt: '2026-08-26T10:00:00.000Z', overallScore: 7 }),
        // Prior window (Aug 18 – Aug 24).
        fact({ capturedAt: '2026-08-20T10:00:00.000Z', overallScore: 5 }),
        fact({ capturedAt: '2026-08-21T10:00:00.000Z', overallScore: 6 }),
      ],
      OPTIONS,
    );
    expect(dashboard.windowDays).toBe(7);
    expect(dashboard.scoredReps).toEqual({ current: 3, previous: 2 });
    expect(dashboard.scoredDays).toEqual({ current: 2, previous: 2 });
    expect(dashboard.avgScore.current).toBeCloseTo(7);
    expect(dashboard.avgScore.previous).toBeCloseTo(5.5);
    expect(dashboard.bestScore).toEqual({ current: 8, previous: 6 });
    expect(dashboard.insight).toBe('Average score +1.5 vs the prior 7 days.');
  });

  it('never invents a prior side for a first measured window', () => {
    const dashboard = buildTechniqueDashboard(
      [fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 7.5 })],
      OPTIONS,
    );
    expect(dashboard.scoredReps).toEqual({ current: 1, previous: null });
    expect(dashboard.scoredDays.previous).toBeNull();
    expect(dashboard.avgScore.previous).toBeNull();
    expect(dashboard.bestScore.previous).toBeNull();
    expect(dashboard.personalBest).toBeNull();
    expect(dashboard.insight).toBe(
      'First scored window on this device — this baseline is yours to beat.',
    );
  });

  it('keeps history honest when the prior window is empty but older reads exist', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 7 }),
        // History exists, but it predates the prior window entirely.
        fact({ capturedAt: '2026-07-01T10:00:00.000Z', overallScore: 6 }),
      ],
      OPTIONS,
    );
    expect(dashboard.scoredReps).toEqual({ current: 1, previous: 0 });
    expect(dashboard.avgScore.previous).toBeNull();
    expect(dashboard.insight).toBe(
      'No comparable reads landed in the prior 7 days.',
    );
  });

  it('drops reads from older model or config versions before comparing', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 8 }),
        fact({
          capturedAt: '2026-08-29T10:00:00.000Z',
          overallScore: 2,
          scoringModelVersion: 'model-1',
        }),
        fact({
          capturedAt: '2026-08-20T10:00:00.000Z',
          overallScore: 9.9,
          shotConfigVersion: 'config-0',
        }),
      ],
      OPTIONS,
    );
    expect(dashboard.scoredReps).toEqual({ current: 1, previous: null });
    expect(dashboard.bestScore.current).toBe(8);
    expect(dashboard.personalBest).toBeNull();
  });

  it('ignores abstentions, null scores, unparseable and future timestamps', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 7 }),
        fact({ resultKind: 'low_confidence', overallScore: null }),
        fact({ overallScore: null }),
        fact({ capturedAt: 'not-a-date', overallScore: 9 }),
        fact({ capturedAt: '2026-09-02T10:00:00.000Z', overallScore: 9 }),
      ],
      OPTIONS,
    );
    expect(dashboard.scoredReps.current).toBe(1);
    expect(dashboard.bestScore.current).toBe(7);
  });

  it('zero-fills day buckets and averages raw reads per day', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-31T10:00:00.000Z', overallScore: 8 }),
        fact({ capturedAt: '2026-08-31T11:00:00.000Z', overallScore: 6 }),
        fact({ capturedAt: '2026-08-27T10:00:00.000Z', overallScore: 5 }),
      ],
      OPTIONS,
    );
    expect(dashboard.buckets).toHaveLength(7);
    expect(dashboard.buckets[0]!.label).toBe('Aug 25');
    expect(dashboard.buckets.at(-1)!.avg).toBeCloseTo(7);
    expect(dashboard.buckets.at(-1)!.count).toBe(2);
    expect(dashboard.buckets[2]!.avg).toBe(5);
    expect(dashboard.buckets[1]!.avg).toBeNull();
    expect(dashboard.buckets[1]!.count).toBe(0);
  });

  it('compacts long ranges to at most 13 bars with read-weighted averages', () => {
    const dashboard = buildTechniqueDashboard(
      [
        // Two reads on one day and one read six days later inside one group
        // of a 90-day window (group size 7): weighted mean, not day mean.
        fact({ capturedAt: '2026-08-26T10:00:00.000Z', overallScore: 9 }),
        fact({ capturedAt: '2026-08-26T11:00:00.000Z', overallScore: 9 }),
        fact({ capturedAt: '2026-08-31T10:00:00.000Z', overallScore: 3 }),
      ],
      { ...OPTIONS, range: '90d' },
    );
    expect(dashboard.buckets.length).toBeLessThanOrEqual(13);
    const scored = dashboard.buckets.filter(bucket => bucket.count > 0);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.avg).toBeCloseTo(7); // (9 + 9 + 3) / 3
  });

  it('celebrates a personal best only when a prior best is strictly beaten', () => {
    const beaten = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 8.2 }),
        fact({ capturedAt: '2026-08-10T10:00:00.000Z', overallScore: 8.1 }),
      ],
      OPTIONS,
    );
    expect(beaten.personalBest).toEqual({
      shotType: 'dink',
      score: 8.2,
      previousBest: 8.1,
      day: '2026-08-30',
    });

    const tied = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T10:00:00.000Z', overallScore: 8.1 }),
        fact({ capturedAt: '2026-08-10T10:00:00.000Z', overallScore: 8.1 }),
      ],
      OPTIONS,
    );
    expect(tied.personalBest).toBeNull();
  });

  it('picks the most recent personal best when several strokes qualify', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({
          shotType: 'dink',
          capturedAt: '2026-08-28T10:00:00.000Z',
          overallScore: 9,
        }),
        fact({
          shotType: 'dink',
          capturedAt: '2026-08-01T10:00:00.000Z',
          overallScore: 7,
        }),
        fact({
          shotType: 'serve',
          capturedAt: '2026-08-30T10:00:00.000Z',
          overallScore: 6,
        }),
        fact({
          shotType: 'serve',
          capturedAt: '2026-08-02T10:00:00.000Z',
          overallScore: 5,
        }),
      ],
      OPTIONS,
    );
    expect(dashboard.personalBest?.shotType).toBe('serve');
    expect(dashboard.personalBest?.previousBest).toBe(5);
  });

  it('returns an empty dashboard shape when nothing is scored', () => {
    const dashboard = buildTechniqueDashboard([], OPTIONS);
    expect(dashboard.scoredReps).toEqual({ current: 0, previous: null });
    expect(dashboard.avgScore).toEqual({ current: null, previous: null });
    expect(dashboard.buckets).toHaveLength(7);
    expect(dashboard.personalBest).toBeNull();
    expect(dashboard.insight).toBeNull();
  });
});
