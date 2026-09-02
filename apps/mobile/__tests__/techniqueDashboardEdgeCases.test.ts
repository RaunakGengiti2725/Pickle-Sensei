/**
 * Torture tests for the Progress dashboard math: timezone boundaries, DST,
 * exact window edges, model-version changes, corrupt input, volume, and
 * cross-checked invariants. The page must track progress no matter what the
 * local history looks like.
 */
import {
  buildTechniqueDashboard,
  formatSignedDelta,
  type TechniqueDashboard,
} from '../src/progress/techniqueDashboard';
import type { RealAnalysisFact } from '../src/data/repository';

let sequence = 0;

function fact(overrides: Partial<RealAnalysisFact> = {}): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: '2026-08-30T12:00:00.000Z',
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

const UTC_7D = {
  asOfIso: '2026-08-31T18:00:00.000Z',
  timeZone: 'UTC',
  range: '7d' as const,
};

describe('window boundary exactness (UTC)', () => {
  // asOf 2026-08-31 → current window Aug 25–31, prior window Aug 18–24.
  const facts = [
    fact({ capturedAt: '2026-08-25T00:00:00.000Z', overallScore: 8 }),
    fact({ capturedAt: '2026-08-24T23:59:59.000Z', overallScore: 6 }),
    fact({ capturedAt: '2026-08-18T00:00:00.000Z', overallScore: 5 }),
    fact({ capturedAt: '2026-08-17T23:59:59.000Z', overallScore: 9 }),
  ];
  const dashboard = buildTechniqueDashboard(facts, UTC_7D);

  it('assigns instants at the exact day edges to the correct windows', () => {
    expect(dashboard.scoredReps).toEqual({ current: 1, previous: 2 });
    expect(dashboard.buckets[0]!.count).toBe(1); // Aug 25 opens the window.
    expect(dashboard.avgScore.previous).toBeCloseTo(5.5); // 6 and 5 only.
  });

  it('keeps pre-window history out of prior stats but in the PB baseline', () => {
    // The Aug 17 read (9) is history, not "previous", and it blocks a PB.
    expect(dashboard.bestScore.previous).toBe(6);
    expect(dashboard.personalBest).toBeNull();
  });
});

describe('timezone correctness', () => {
  it('splits reads around local midnight in America/Los_Angeles', () => {
    // 06:59Z is Aug 30 23:59 PDT; 07:01Z is Aug 31 00:01 PDT.
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-31T06:59:00.000Z', overallScore: 4 }),
        fact({ capturedAt: '2026-08-31T07:01:00.000Z', overallScore: 8 }),
      ],
      { ...UTC_7D, timeZone: 'America/Los_Angeles' },
    );
    expect(dashboard.buckets).toHaveLength(7);
    expect(dashboard.buckets[5]!.avg).toBe(4); // Aug 30 PDT
    expect(dashboard.buckets[6]!.avg).toBe(8); // Aug 31 PDT
  });

  it('handles the 45-minute offset of Asia/Kathmandu', () => {
    // 18:20Z on Aug 30 is already Aug 31 00:05 in Kathmandu (+05:45).
    const dashboard = buildTechniqueDashboard(
      [fact({ capturedAt: '2026-08-30T18:20:00.000Z', overallScore: 6.5 })],
      { ...UTC_7D, timeZone: 'Asia/Kathmandu' },
    );
    expect(dashboard.buckets.at(-1)!.avg).toBe(6.5);
    expect(dashboard.buckets.at(-1)!.count).toBe(1);
  });

  it('handles UTC+14 (Pacific/Kiritimati) where "today" is tomorrow in UTC', () => {
    const dashboard = buildTechniqueDashboard(
      [
        // Sep 1 02:00 local — the as-of day there.
        fact({ capturedAt: '2026-08-31T12:00:00.000Z', overallScore: 7 }),
        // Aug 31 23:00 local — the day before.
        fact({ capturedAt: '2026-08-31T09:00:00.000Z', overallScore: 5 }),
      ],
      { ...UTC_7D, timeZone: 'Pacific/Kiritimati' },
    );
    expect(dashboard.buckets.at(-1)!.avg).toBe(7);
    expect(dashboard.buckets.at(-2)!.avg).toBe(5);
  });

  it('keeps a 7-day window at exactly 7 buckets across a DST jump', () => {
    // US spring-forward: Mar 8 2026. Window Mar 4–10, America/Los_Angeles.
    const dashboard = buildTechniqueDashboard(
      [
        // 01:30 PST (before the jump) and 04:00 PDT (after) — same local day.
        fact({ capturedAt: '2026-03-08T09:30:00.000Z', overallScore: 6 }),
        fact({ capturedAt: '2026-03-08T11:00:00.000Z', overallScore: 8 }),
      ],
      {
        asOfIso: '2026-03-10T20:00:00.000Z',
        timeZone: 'America/Los_Angeles',
        range: '7d',
      },
    );
    expect(dashboard.buckets).toHaveLength(7);
    expect(dashboard.buckets[0]!.label).toBe('Mar 4');
    const dstDay = dashboard.buckets[4]!; // Mar 8
    expect(dstDay.count).toBe(2);
    expect(dstDay.avg).toBeCloseTo(7);
  });
});

describe('model-version changes', () => {
  it('keeps old-model reads out of stats, buckets, and bests', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T12:00:00.000Z', overallScore: 8 }),
        fact({
          capturedAt: '2026-08-27T12:00:00.000Z',
          overallScore: 2,
          scoringModelVersion: 'model-1',
        }),
      ],
      UTC_7D,
    );
    expect(dashboard.scoredReps.current).toBe(1);
    const aug27 = dashboard.buckets[2]!;
    expect(aug27.count).toBe(0);
    expect(aug27.avg).toBeNull();
    expect(dashboard.bestScore.current).toBe(8);
  });

  it('never claims a PB or a comparison against an incomparable old model', () => {
    // The old model once read 9.9 — but after a model change that history
    // is not comparable, so the window is honestly a fresh baseline.
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-29T12:00:00.000Z', overallScore: 8 }),
        fact({
          capturedAt: '2026-08-10T12:00:00.000Z',
          overallScore: 9.9,
          scoringModelVersion: 'model-1',
        }),
      ],
      UTC_7D,
    );
    expect(dashboard.personalBest).toBeNull();
    expect(dashboard.scoredReps.previous).toBeNull();
    expect(dashboard.insight).toBe(
      'First scored window on this device — this baseline is yours to beat.',
    );
  });

  it('tracks version comparability per stroke, not globally', () => {
    // The dink moved to model-2; the serve still scores on model-1. Each
    // stroke compares within its own newest versions.
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: '2026-08-30T12:00:00.000Z', overallScore: 8 }),
        fact({
          shotType: 'serve',
          capturedAt: '2026-08-29T12:00:00.000Z',
          overallScore: 6,
          scoringModelVersion: 'model-1',
        }),
        fact({
          shotType: 'serve',
          capturedAt: '2026-08-20T12:00:00.000Z',
          overallScore: 5,
          scoringModelVersion: 'model-1',
        }),
      ],
      UTC_7D,
    );
    expect(dashboard.scoredReps).toEqual({ current: 2, previous: 1 });
    expect(dashboard.personalBest).toEqual({
      shotType: 'serve',
      score: 6,
      previousBest: 5,
      day: '2026-08-29',
    });
  });
});

describe('hostile input', () => {
  it('survives corrupt timestamps, boundary scores, and future clock skew', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: 'not a timestamp', overallScore: 9 }),
        fact({ capturedAt: '', overallScore: 9 }),
        fact({ capturedAt: '2026-09-15T00:00:00.000Z', overallScore: 9 }),
        fact({ capturedAt: '2026-08-30T12:00:00.000Z', overallScore: 0 }),
        fact({ capturedAt: '2026-08-30T13:00:00.000Z', overallScore: 10 }),
      ],
      UTC_7D,
    );
    expect(dashboard.scoredReps.current).toBe(2);
    expect(dashboard.bestScore.current).toBe(10);
    expect(dashboard.avgScore.current).toBeCloseTo(5);
    expect(dashboard.buckets[5]!.avg).toBeCloseTo(5);
  });

  it('returns an empty-but-shaped dashboard when every read is unusable', () => {
    const dashboard = buildTechniqueDashboard(
      [
        fact({ capturedAt: 'garbage' }),
        fact({ resultKind: 'low_confidence', overallScore: null }),
        fact({ capturedAt: '2026-09-15T00:00:00.000Z' }),
      ],
      UTC_7D,
    );
    expect(dashboard.scoredReps).toEqual({ current: 0, previous: null });
    expect(dashboard.buckets).toHaveLength(7);
    expect(dashboard.insight).toBeNull();
    expect(dashboard.personalBest).toBeNull();
  });

  it('rejects unusable options loudly instead of guessing', () => {
    expect(() =>
      buildTechniqueDashboard([], { ...UTC_7D, asOfIso: 'garbage' }),
    ).toThrow('asOfIso must be a parseable ISO timestamp.');
    expect(() =>
      buildTechniqueDashboard([], {
        ...UTC_7D,
        range: '365d' as never,
      }),
    ).toThrow('Unsupported technique dashboard range.');
    expect(() =>
      buildTechniqueDashboard([], { ...UTC_7D, timeZone: 'Not/AZone' }),
    ).toThrow('timeZone must be a supported IANA timezone.');
  });

  it('keeps identical-instant reads deterministic', () => {
    const facts = [
      fact({ capturedAt: '2026-08-30T12:00:00.000Z', overallScore: 6 }),
      fact({ capturedAt: '2026-08-30T12:00:00.000Z', overallScore: 8 }),
    ];
    const first = buildTechniqueDashboard(facts, UTC_7D);
    const second = buildTechniqueDashboard([...facts].reverse(), UTC_7D);
    expect(first.avgScore.current).toBeCloseTo(7);
    expect(second.avgScore.current).toBeCloseTo(7);
    expect(first.bestScore.current).toBe(8);
    expect(second.bestScore.current).toBe(8);
  });
});

describe('bucket compaction', () => {
  it('compacts a 28-day window into 3-day groups with true read-weighted averages', () => {
    const dashboard = buildTechniqueDashboard(
      [
        // Aug 4 and Aug 6 fall in the window's first 3-day group.
        fact({ capturedAt: '2026-08-04T12:00:00.000Z', overallScore: 9 }),
        fact({ capturedAt: '2026-08-04T13:00:00.000Z', overallScore: 9 }),
        fact({ capturedAt: '2026-08-06T12:00:00.000Z', overallScore: 3 }),
      ],
      { ...UTC_7D, range: '28d' },
    );
    // 28 days ÷ ceil(28/13)=3 → 10 groups, first labeled at the window start.
    expect(dashboard.buckets).toHaveLength(10);
    expect(dashboard.buckets[0]!.label).toBe('Aug 4');
    expect(dashboard.buckets[0]!.count).toBe(3);
    expect(dashboard.buckets[0]!.avg).toBeCloseTo(7); // (9+9+3)/3, not 6.
  });

  it('never exceeds 13 bars for the 90-day window', () => {
    const dashboard = buildTechniqueDashboard(
      [fact({ capturedAt: '2026-08-30T12:00:00.000Z' })],
      { ...UTC_7D, range: '90d' },
    );
    expect(dashboard.buckets.length).toBeLessThanOrEqual(13);
    const coveredDays = dashboard.buckets.reduce((days, bucket) => {
      const [first, last] = bucket.key.split(':');
      return (
        days +
        (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
          86_400_000 +
        1
      );
    }, 0);
    expect(coveredDays).toBe(90);
  });
});

describe('cross-checked invariants under pseudo-random history', () => {
  /** Deterministic PRNG so failures reproduce exactly. */
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomFacts(seed: number, count: number): RealAnalysisFact[] {
    const random = mulberry32(seed);
    const shots = ['dink', 'serve', 'volley', 'third_shot_drop'];
    const asOfMs = Date.parse(UTC_7D.asOfIso);
    return Array.from({ length: count }, (_, index) => {
      const daysBack = Math.floor(random() * 200);
      const withinDayMs = Math.floor(random() * 86_400_000);
      const scored = random() > 0.2;
      return fact({
        id: `random-${seed}-${index}`,
        shotType: shots[Math.floor(random() * shots.length)]!,
        capturedAt: new Date(
          asOfMs - daysBack * 86_400_000 - withinDayMs,
        ).toISOString(),
        resultKind: scored ? 'scored' : 'low_confidence',
        overallScore: scored ? Math.round(random() * 100) / 10 : null,
        scoringModelVersion: random() > 0.15 ? 'model-2' : 'model-1',
        shotConfigVersion: random() > 0.1 ? 'config-1' : 'config-0',
      });
    });
  }

  function checkInvariants(dashboard: TechniqueDashboard, windowDays: number) {
    // Reps shown in KEY STATISTICS must equal the reps drawn in the chart.
    const bucketReps = dashboard.buckets.reduce(
      (sum, bucket) => sum + bucket.count,
      0,
    );
    expect(bucketReps).toBe(dashboard.scoredReps.current);
    expect(dashboard.buckets.length).toBeLessThanOrEqual(13);
    expect(dashboard.windowDays).toBe(windowDays);
    // Scored days can never exceed reps or the window length.
    expect(dashboard.scoredDays.current).toBeLessThanOrEqual(
      Math.min(dashboard.scoredReps.current, windowDays),
    );
    // Averages and bests stay inside the observed bucket range.
    const bucketAvgs = dashboard.buckets
      .map(bucket => bucket.avg)
      .filter((avg): avg is number => avg !== null);
    if (dashboard.avgScore.current !== null) {
      expect(dashboard.avgScore.current).toBeGreaterThanOrEqual(0);
      expect(dashboard.avgScore.current).toBeLessThanOrEqual(10);
      expect(dashboard.bestScore.current).not.toBeNull();
      expect(dashboard.bestScore.current!).toBeGreaterThanOrEqual(
        Math.max(...bucketAvgs),
      );
    } else {
      expect(dashboard.scoredReps.current).toBe(0);
      expect(dashboard.bestScore.current).toBeNull();
    }
    // A personal best must strictly beat its recorded previous best.
    if (dashboard.personalBest) {
      expect(dashboard.personalBest.score).toBeGreaterThan(
        dashboard.personalBest.previousBest,
      );
    }
    // No comparison may exist without history.
    if (dashboard.scoredReps.previous === null) {
      expect(dashboard.scoredDays.previous).toBeNull();
      expect(dashboard.avgScore.previous).toBeNull();
      expect(dashboard.bestScore.previous).toBeNull();
      expect(dashboard.personalBest).toBeNull();
    }
  }

  it.each([1, 2, 3, 4, 5])('holds for seed %i across all ranges', seed => {
    const facts = randomFacts(seed, 400);
    for (const range of ['7d', '28d', '90d'] as const) {
      const days = range === '7d' ? 7 : range === '28d' ? 28 : 90;
      const dashboard = buildTechniqueDashboard(facts, { ...UTC_7D, range });
      checkInvariants(dashboard, days);
      // Determinism: same input, same output — every time.
      expect(buildTechniqueDashboard(facts, { ...UTC_7D, range })).toEqual(
        dashboard,
      );
      // Input order must never matter.
      expect(
        buildTechniqueDashboard([...facts].reverse(), { ...UTC_7D, range }),
      ).toEqual(dashboard);
    }
  });

  it('stays correct at 5,000 facts', () => {
    const facts = randomFacts(99, 5_000);
    const dashboard = buildTechniqueDashboard(facts, {
      ...UTC_7D,
      range: '90d',
    });
    checkInvariants(dashboard, 90);
    expect(dashboard.scoredReps.current).toBeGreaterThan(0);
  });
});

describe('formatSignedDelta decimals', () => {
  it('respects the decimals parameter', () => {
    expect(formatSignedDelta(1.256, 2)).toBe('+1.26');
    expect(formatSignedDelta(-1.256, 0)).toBe('-1');
    // A negative that rounds to zero must not render as "-0.00".
    expect(formatSignedDelta(-0.004, 2)).toBe('+0.00');
  });
});
