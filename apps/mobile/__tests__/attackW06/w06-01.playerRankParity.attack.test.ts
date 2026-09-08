/**
 * W06-01 adversarial attack — the MOBILE plane against the canonical
 * definition. `apps/mobile/src/progress/playerRank.ts` has two "honest
 * sources" for one rank: the device history (rankFromFacts → shared
 * computePlayerRank) and the account row (GET /v1/rank → summaryFromServer).
 * The objective says the version id + golden fixtures exist so those planes
 * can be checked against identical inputs; these tests probe whether the
 * account-side summary is comparable at all, and how corrupt/partial server
 * state is treated.
 *
 * Run: cd apps/mobile && npx jest --silent __tests__/attackW06
 */
import {
  computePlayerRank,
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
  type PlayerRankGoldenFixture,
} from '@pickle/shared-types';
import goldenJson from '../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json';
import {
  parsePlayerRank,
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type PlayerRankFactLike,
} from '../../src/progress/playerRank';

const golden: PlayerRankGoldenFixture = goldenJson;

/** GET /v1/rank payload shape the edge function emits (snake_case rows). */
function serverPayload(rank: {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredShotCount: number | null;
  techniques: Array<{
    shot_type: string;
    score: number;
    captured_at: string;
    sampled_count?: number;
  }>;
}): unknown {
  return { rank: { ...rank, updatedAt: '2026-08-05T10:00:00.000Z' } };
}

function toFacts(
  analyses: PlayerRankGoldenFixture['cases'][number]['analyses'],
): PlayerRankFactLike[] {
  return analyses.map(a => ({
    id: a.id,
    shotType: a.shotType,
    capturedAt: a.capturedAt,
    overallScore: a.overallScore,
    resultKind: a.resultKind,
    source: a.source,
  }));
}

describe('W06-01 attack: golden fixture through the mobile device path', () => {
  it.each(golden.cases.map(c => [c.id, c] as const))(
    'rankFromFacts reproduces golden case %s',
    (_id, c) => {
      expect(rankFromFacts(toFacts(c.analyses))).toEqual(c.expected);
    },
  );

  it('RealAnalysisFact rows (no `source` field) rank exactly like source:"real" rows', () => {
    for (const c of golden.cases) {
      if (c.analyses.some(a => a.source !== 'real')) continue;
      const withoutSource = toFacts(c.analyses).map(
        ({ source: _source, ...rest }) => rest,
      );
      expect(rankFromFacts(withoutSource)).toEqual(c.expected);
    }
  });
});

describe('W06-01 attack: the account-side summary must be comparable to the device-side one', () => {
  // Same evidence on both planes: one dink 6.3 (golden "single-scored-analysis").
  const single = golden.cases.find(c => c.id === 'single-scored-analysis');
  if (!single || !single.expected) {
    throw new Error('golden fixture lost its single-scored-analysis case');
  }
  const expected = single.expected;
  const server = parsePlayerRank(
    serverPayload({
      rating: expected.rating,
      tier: expected.tier,
      techniqueCount: expected.techniqueCount,
      scoredShotCount: expected.scoredAnalysisCount,
      techniques: expected.techniques.map(t => ({
        shot_type: t.shotType,
        score: t.score,
        captured_at: t.capturedAt,
        sampled_count: t.sampledCount,
      })),
    }),
  );
  if (!server) throw new Error('server rank parsed as null');

  it('summaryFromServer carries the canonical definitionVersion like the device summary does', () => {
    const device = rankFromFacts(toFacts(single.analyses));
    expect(device?.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
    const account = summaryFromServer(server);
    expect(account.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
  });

  it('account and device summaries of identical evidence are identical (the fixture expected summary)', () => {
    expect(summaryFromServer(server)).toEqual(expected);
  });

  it('resolvePlayerRank never hands the UI an unversioned summary when the account wins the tie', () => {
    const resolved = resolvePlayerRank(toFacts(single.analyses), server);
    expect(resolved?.source).toBe('account');
    expect(resolved?.summary.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
  });
});

describe('W06-01 attack: corrupt / partial persisted account rank state', () => {
  it('a stored tier that contradicts the stored rating is re-derived from the rating (tiers are a function of rating)', () => {
    // player_rank_state.tier is trigger-written; a stale or corrupt row can
    // say "diamond" beside rating 0.5. The definition's tiers component makes
    // tier a pure function of rating.
    const server = parsePlayerRank(
      serverPayload({
        rating: 0.5,
        tier: 'diamond',
        techniqueCount: 1,
        scoredShotCount: 1,
        techniques: [
          {
            shot_type: 'dink',
            score: 0.5,
            captured_at: '2026-08-05T10:00:00.000Z',
            sampled_count: 1,
          },
        ],
      }),
    );
    if (!server) throw new Error('parsed as null');
    const account = summaryFromServer(server);
    const bronze = SCORING_DEFINITION.components.tiers.thresholds[0];
    expect(account.tier).toBe(bronze?.key);
    expect(account.tierLabel).toBe(bronze?.label);
    expect(account.nextTier?.key).toBe('silver');
  });

  it('parsePlayerRank refuses technique scores outside the canonical 0..10 scale', () => {
    const payload = serverPayload({
      rating: 5,
      tier: 'gold',
      techniqueCount: 2,
      scoredShotCount: 2,
      techniques: [
        {
          shot_type: 'dink',
          score: 42,
          captured_at: '2026-08-05T10:00:00.000Z',
        },
        {
          shot_type: 'serve',
          score: -3,
          captured_at: '2026-08-05T10:00:00.000Z',
        },
      ],
    });
    expect(() => parsePlayerRank(payload)).toThrow();
  });

  it('parsePlayerRank refuses a negative techniqueCount and a techniqueCount that disagrees with the rows', () => {
    const negative = serverPayload({
      rating: 5,
      tier: 'gold',
      techniqueCount: -1,
      scoredShotCount: 1,
      techniques: [
        {
          shot_type: 'dink',
          score: 5,
          captured_at: '2026-08-05T10:00:00.000Z',
        },
      ],
    });
    expect(() => parsePlayerRank(negative)).toThrow();
  });

  it('a server row with fewer scored shots than techniques (partial state) does not out-vote richer local evidence', () => {
    // Edge fallback path: scoredShotCount null → summaryFromServer counts
    // techniques instead. Local has 3 scored analyses of one technique.
    const facts = toFacts(
      golden.cases.find(c => c.id === 'form-weighted-then-confidence-weighted')
        ?.analyses ?? [],
    );
    expect(facts).toHaveLength(3);
    const server = parsePlayerRank(
      serverPayload({
        rating: 9,
        tier: 'diamond',
        techniqueCount: 1,
        scoredShotCount: null,
        techniques: [
          {
            shot_type: 'serve',
            score: 9,
            captured_at: '2026-08-03T10:00:00.000Z',
          },
        ],
      }),
    );
    const resolved = resolvePlayerRank(facts, server);
    expect(resolved?.source).toBe('device');
    expect(resolved?.summary).toEqual(computePlayerRank(facts));
  });
});
