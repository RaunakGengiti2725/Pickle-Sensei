/**
 * ADV INT-analysis-scoring — mobile rank parity against the frozen scoring
 * definition (`rank-form-weighted-v2`) and the Edge `GET /v1/rank` contract.
 *
 *   M1 collation   — account-rank technique order must be code-unit (the
 *                    definition's declared collation and what Edge emits),
 *                    not a locale collation; golden case
 *                    `equal-scores-order-techniques-by-code-unit`.
 *   M2 stored tier — a saved tier that contradicts its rating is not shown
 *                    verbatim (tier is a pure function of rating, component 9).
 *   M3 parser      — hostile server payloads (string rating, NaN, -0,
 *                    fractional counts, negative counts) are rejected or
 *                    normalised, never rendered.
 *   M4 provenance  — an account summary carries the definition version it
 *                    was computed under (historical results are never
 *                    reinterpreted silently).
 *   M5 golden      — resolvePlayerRank(local facts) reproduces every golden
 *                    case; low_confidence rows never rank; NaN/Infinity/>10
 *                    scored facts are rejected as evidence.
 *   M6 no rescale  — a stored overallScore is used verbatim regardless of
 *                    the scoring-model version that produced it.
 */
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  playerRankTierForRating,
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
} from '@pickle/shared-types';
import golden from '../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json';
import {
  parsePlayerRank,
  resolvePlayerRank,
  summaryFromServer,
  type PlayerRankFactLike,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';

type GoldenAnalysis = {
  id: string;
  shotType: string;
  overallScore: number | null;
  resultKind: string;
  capturedAt: string;
  source?: string;
};
type GoldenCase = {
  id: string;
  analyses: GoldenAnalysis[];
  expected: {
    rating: number;
    tier: string;
    techniqueCount: number;
    scoredAnalysisCount: number;
    techniques: { shotType: string; score: number }[];
  } | null;
};

const cases = golden.cases as GoldenCase[];
const codeUnitCase = cases.find(
  c => c.id === 'equal-scores-order-techniques-by-code-unit',
);

function serverRankFor(analyses: GoldenAnalysis[]): ServerPlayerRank {
  const local = computePlayerRank(
    analyses.map(a => ({
      id: a.id,
      shotType: a.shotType,
      overallScore: a.overallScore,
      resultKind: a.resultKind,
      capturedAt: a.capturedAt,
      ...(a.source !== undefined ? { source: a.source } : {}),
    })),
  );
  if (!local) throw new Error('expected a ranked golden case');
  return {
    rating: local.rating,
    tier: local.tier,
    techniqueCount: local.techniqueCount,
    scoredShotCount: local.scoredAnalysisCount,
    updatedAt: '2026-08-01T10:00:00.000Z',
    techniques: local.techniques.map(t => ({
      shotType: t.shotType,
      score: t.score,
      capturedAt: t.capturedAt,
      sampledCount: t.sampledCount,
    })),
  };
}

const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe('ADV M1: technique ordering collation', () => {
  test('definition declares code-unit collation for the shotType tiebreak', () => {
    const keys = SCORING_DEFINITION.components.rating.techniqueOrder.keys;
    expect(keys[1]).toEqual({
      field: 'shotType',
      direction: 'asc',
      collation: 'code-unit',
    });
  });

  test('summaryFromServer orders equal-score techniques exactly as computePlayerRank (golden code-unit case)', () => {
    if (!codeUnitCase) throw new Error('golden case missing');
    const server = serverRankFor(codeUnitCase.analyses);
    // Server rows arrive in Edge order (code-unit); shuffle so the mobile
    // sort — not the arrival order — decides.
    const shuffled = {
      ...server,
      techniques: [...server.techniques].reverse(),
    };
    const account = summaryFromServer(shuffled);
    const expected = codeUnitCase.expected!.techniques.map(t => t.shotType);
    expect(account.techniques.map(t => t.shotType)).toEqual(expected);
  });

  test('device and account summaries for the SAME evidence list techniques in the same order', () => {
    const facts: PlayerRankFactLike[] = [
      {
        id: 'a',
        shotType: 'Zed',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 6,
        resultKind: 'scored',
      },
      {
        id: 'b',
        shotType: 'apple',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 6,
        resultKind: 'scored',
      },
      {
        id: 'c',
        shotType: '_underscore',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 6,
        resultKind: 'scored',
      },
      {
        id: 'd',
        shotType: 'Ébauche',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 6,
        resultKind: 'scored',
      },
    ];
    const device = resolvePlayerRank(facts, null);
    const account = resolvePlayerRank(
      [],
      serverRankFor(
        facts.map(f => ({
          id: `00000000-0000-4000-8000-00000000000${f.id === 'a' ? 1 : f.id === 'b' ? 2 : f.id === 'c' ? 3 : 4}`,
          shotType: f.shotType,
          overallScore: f.overallScore,
          resultKind: f.resultKind,
          capturedAt: f.capturedAt,
        })),
      ),
    );
    expect(device?.source).toBe('device');
    expect(account?.source).toBe('account');
    const deviceOrder = device!.summary.techniques.map(t => t.shotType);
    expect(deviceOrder).toEqual([...deviceOrder].sort(codeUnitOrder));
    expect(account!.summary.techniques.map(t => t.shotType)).toEqual(
      deviceOrder,
    );
  });
});

describe('ADV M2: stored tier vs rating', () => {
  const base: ServerPlayerRank = {
    rating: 1.25,
    tier: 'bronze',
    techniqueCount: 1,
    scoredShotCount: 1,
    updatedAt: null,
    techniques: [
      { shotType: 'dink', score: 1.25, capturedAt: '2026-08-01T10:00:00.000Z' },
    ],
  };

  test('a known tier key that contradicts the rating (diamond @ 1.25) is re-derived from the rating', () => {
    const summary = summaryFromServer({ ...base, tier: 'diamond' });
    expect(summary.tier).toBe(playerRankTierForRating(1.25).key);
    expect(summary.tier).toBe('bronze');
  });

  test('a contradictory stored tier never yields a negative next-tier gap', () => {
    const summary = summaryFromServer({ ...base, tier: 'diamond' });
    expect(summary.nextTier).not.toBeNull();
    expect(summary.nextTier!.pointsNeeded).toBeGreaterThan(0);
  });

  test('an unknown tier string is re-derived, never surfaced', () => {
    const summary = summaryFromServer({ ...base, tier: 'legend' });
    expect(summary.tier).toBe('bronze');
    expect(PLAYER_RANK_TIERS.some(t => t.key === summary.tier)).toBe(true);
  });
});

describe('ADV M3: hostile /v1/rank payloads', () => {
  const okRank = {
    rating: 7.5,
    tier: 'diamond',
    techniqueCount: 1,
    scoredShotCount: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
    techniques: [
      {
        shot_type: 'dink',
        score: 7.5,
        captured_at: '2026-08-01T10:00:00.000Z',
      },
    ],
  };

  test('precondition: the well-formed payload parses', () => {
    expect(parsePlayerRank({ rank: okRank })?.rating).toBe(7.5);
  });

  test('a string rating ("7.5") is not accepted as a number', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, rating: '7.5' } }),
    ).toThrow();
  });

  test('a string technique score ("7.5") is not accepted as a number', () => {
    expect(() =>
      parsePlayerRank({
        rank: {
          ...okRank,
          techniques: [{ ...okRank.techniques[0], score: '7.5' }],
        },
      }),
    ).toThrow();
  });

  test('an empty-string rating is rejected (Number("") === 0 must not become Bronze 0.00)', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, rating: '' } }),
    ).toThrow();
  });

  test('a boolean rating is rejected (Number(true) === 1 must not become a rank)', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, rating: true } }),
    ).toThrow();
  });

  test('a technique score outside 0..10 (42) is rejected', () => {
    expect(() =>
      parsePlayerRank({
        rank: {
          ...okRank,
          techniques: [{ ...okRank.techniques[0], score: 42 }],
        },
      }),
    ).toThrow();
  });

  test('a fractional or negative techniqueCount is rejected', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, techniqueCount: 1.5 } }),
    ).toThrow();
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, techniqueCount: -1 } }),
    ).toThrow();
  });

  test('a negative scoredShotCount is rejected', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, scoredShotCount: -1 } }),
    ).toThrow();
  });

  test('a null rating is rejected (Number(null) === 0 must not become Bronze 0.00)', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, rating: null } }),
    ).toThrow();
  });

  test('an array rating ([]) is rejected (Number([]) === 0)', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, rating: [] } }),
    ).toThrow();
  });

  test.each([
    ['"NaN"', 'NaN'],
    ['10.01', 10.01],
    ['-0.01', -0.01],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rating %s is rejected', (_label, rating) => {
    expect(() => parsePlayerRank({ rank: { ...okRank, rating } })).toThrow();
  });

  test('a technique count that disagrees with the technique rows is rejected', () => {
    expect(() =>
      parsePlayerRank({ rank: { ...okRank, techniqueCount: 99 } }),
    ).toThrow();
  });
});

describe('ADV M4: definition provenance on the account summary', () => {
  test('the account summary carries the definitionVersion it was computed under', () => {
    const server: ServerPlayerRank = {
      rating: 7.5,
      tier: 'diamond',
      techniqueCount: 1,
      scoredShotCount: 1,
      updatedAt: null,
      techniques: [
        {
          shotType: 'dink',
          score: 7.5,
          capturedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    };
    const resolved = resolvePlayerRank([], server);
    expect(resolved?.source).toBe('account');
    expect(resolved?.summary.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
  });

  test('the device summary carries the definitionVersion', () => {
    const resolved = resolvePlayerRank(
      [
        {
          id: 'a',
          shotType: 'dink',
          capturedAt: '2026-08-01T10:00:00.000Z',
          overallScore: 7.5,
          resultKind: 'scored',
        },
      ],
      null,
    );
    expect(resolved?.summary.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
  });
});

describe('ADV M5: golden parity through the mobile entry point', () => {
  test('golden fixture is the frozen definition', () => {
    expect(golden.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
    expect(SCORING_DEFINITION_VERSION).toBe('rank-form-weighted-v2');
  });

  test.each(cases.map(c => [c.id, c] as const))(
    'resolvePlayerRank(local) reproduces golden case %s',
    (_id, goldenCase) => {
      const facts: PlayerRankFactLike[] = goldenCase.analyses.map(a => ({
        id: a.id,
        shotType: a.shotType,
        capturedAt: a.capturedAt,
        overallScore: a.overallScore,
        resultKind: a.resultKind,
        ...(a.source !== undefined ? { source: a.source } : {}),
      }));
      const resolved = resolvePlayerRank(facts, null);
      if (goldenCase.expected === null) {
        expect(resolved).toBeNull();
        return;
      }
      expect(resolved?.source).toBe('device');
      expect(resolved!.summary.rating).toBe(goldenCase.expected.rating);
      expect(resolved!.summary.tier).toBe(goldenCase.expected.tier);
      expect(resolved!.summary.techniqueCount).toBe(
        goldenCase.expected.techniqueCount,
      );
      expect(resolved!.summary.scoredAnalysisCount).toBe(
        goldenCase.expected.scoredAnalysisCount,
      );
      expect(
        resolved!.summary.techniques.map(t => [t.shotType, t.score]),
      ).toEqual(goldenCase.expected.techniques.map(t => [t.shotType, t.score]));
    },
  );

  test('low_confidence facts carrying a stray numeric score never rank', () => {
    const facts: PlayerRankFactLike[] = [
      {
        id: 'a',
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 9.9,
        resultKind: 'low_confidence',
      },
    ];
    expect(resolvePlayerRank(facts, null)).toBeNull();
  });

  test('NaN / Infinity / 10.5 / -1 scored facts are not evidence', () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, 10.5, -1]) {
      const facts: PlayerRankFactLike[] = [
        {
          id: 'a',
          shotType: 'dink',
          capturedAt: '2026-08-01T10:00:00.000Z',
          overallScore: score,
          resultKind: 'scored',
        },
      ];
      expect(resolvePlayerRank(facts, null)).toBeNull();
    }
  });

  test('a scored fact with a null score is not evidence (no Bronze 0.00 from nothing)', () => {
    const facts: PlayerRankFactLike[] = [
      {
        id: 'a',
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: null,
        resultKind: 'scored',
      },
    ];
    expect(resolvePlayerRank(facts, null)).toBeNull();
  });

  test('a fixture-sourced fact is not evidence', () => {
    const facts: PlayerRankFactLike[] = [
      {
        id: 'a',
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 8,
        resultKind: 'scored',
        source: 'fixture',
      },
    ];
    expect(resolvePlayerRank(facts, null)).toBeNull();
  });
});

describe('ADV M6: historical scores are never rescaled', () => {
  test('a stored score is used verbatim whatever produced it; only the rank definition version is stamped', () => {
    const facts: PlayerRankFactLike[] = [
      {
        id: 'a',
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 6.4,
        resultKind: 'scored',
      },
    ];
    const resolved = resolvePlayerRank(facts, null);
    expect(resolved!.summary.techniques[0]!.score).toBe(6.4);
    // one technique → its rounded score IS the rating (golden `single-scored-analysis`)
    expect(resolved!.summary.rating).toBe(6.4);
    expect(resolved!.summary.definitionVersion).toBe('rank-form-weighted-v2');
  });
});
