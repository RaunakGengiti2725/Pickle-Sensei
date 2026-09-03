import type { RealAnalysisFact } from '../src/data/repository';
import type { ApiSession } from '../src/account/apiSession';
import {
  fetchPlayerRank,
  parsePlayerRank,
  PlayerRankApiError,
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type PlayerRankFetch,
  type ServerPlayerRank,
} from '../src/progress/playerRank';

function fact(
  shotType: string,
  overallScore: number | null,
  capturedAt: string,
  resultKind: 'scored' | 'low_confidence' = 'scored',
): RealAnalysisFact {
  return {
    id: `${shotType}-${capturedAt}`,
    shotType,
    capturedAt,
    overallScore,
    confidence: 0.9,
    resultKind,
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: `${shotType}@1`,
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

const SESSION: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token',
  canonicalAppUserId: 'user-1',
  provider: 'google',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SERVER_RANK_PAYLOAD = {
  rank: {
    rating: 7.25,
    tier: 'platinum',
    techniqueCount: 2,
    scoredShotCount: 2,
    updatedAt: '2026-08-02T10:00:01.000Z',
    techniques: [
      {
        shot_type: 'forehand_drive',
        score: 8,
        captured_at: '2026-08-01T10:00:00.000Z',
      },
      {
        shot_type: 'overhead',
        score: 6.5,
        captured_at: '2026-08-02T10:00:00.000Z',
      },
    ],
  },
};

describe('rankFromFacts', () => {
  it('averages each technique’s latest score into a tier', () => {
    const rank = rankFromFacts([
      fact('forehand_drive', 8, '2026-08-01T10:00:00.000Z'),
      fact('overhead', 6.5, '2026-08-02T10:00:00.000Z'),
      fact('backhand_drive', 9, '2026-08-03T10:00:00.000Z'),
    ])!;
    expect(rank.rating).toBe(7.83);
    expect(rank.tier).toBe('diamond');
    expect(rank.nextTier).toBeNull();
  });

  it('returns null with no scored history — unranked is honest', () => {
    expect(rankFromFacts([])).toBeNull();
    expect(
      rankFromFacts([
        fact('dink', null, '2026-08-01T10:00:00.000Z', 'low_confidence'),
      ]),
    ).toBeNull();
  });

  it('accepts LocalShotRow-shaped inputs (Home banner) and skips non-real rows', () => {
    const rows = [
      {
        id: 'a',
        sessionId: null,
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        overallScore: 7.5,
        confidence: 0.9,
        resultKind: 'scored',
        source: 'real',
        favorite: false,
      },
      {
        id: 'b',
        sessionId: null,
        shotType: 'serve',
        capturedAt: '2026-08-02T10:00:00.000Z',
        overallScore: 9,
        confidence: 0.9,
        resultKind: 'scored',
        source: 'fixture',
        favorite: false,
      },
    ];
    const rank = rankFromFacts(rows)!;
    expect(rank.rating).toBe(7.5);
    expect(rank.tier).toBe('diamond');
    expect(rank.techniqueCount).toBe(1);
  });
});

describe('fetchPlayerRank + parsePlayerRank', () => {
  it('parses the server rank payload', async () => {
    const calls: string[] = [];
    const fetchFn: PlayerRankFetch = async input => {
      calls.push(input);
      return jsonResponse(200, SERVER_RANK_PAYLOAD);
    };
    const rank = (await fetchPlayerRank(SESSION, fetchFn))!;
    expect(calls).toEqual(['https://api.test/v1/rank']);
    expect(rank.rating).toBe(7.25);
    expect(rank.tier).toBe('platinum');
    expect(rank.techniques).toHaveLength(2);
  });

  it('maps rank:null to an unranked account', async () => {
    const fetchFn: PlayerRankFetch = async () =>
      jsonResponse(200, { rank: null });
    expect(await fetchPlayerRank(SESSION, fetchFn)).toBeNull();
  });

  it('rejects malformed payloads instead of guessing', () => {
    expect(() => parsePlayerRank({})).toThrow(PlayerRankApiError);
    expect(() => parsePlayerRank({ rank: { rating: 99 } })).toThrow(
      PlayerRankApiError,
    );
    expect(() =>
      parsePlayerRank({
        rank: { rating: 5, tier: 'gold', techniqueCount: 1, techniques: [{}] },
      }),
    ).toThrow(PlayerRankApiError);
  });

  it('surfaces server errors as PlayerRankApiError', async () => {
    const fetchFn: PlayerRankFetch = async () => jsonResponse(503, {});
    await expect(fetchPlayerRank(SESSION, fetchFn)).rejects.toThrow(
      PlayerRankApiError,
    );
  });
});

describe('summaryFromServer', () => {
  it('rebuilds labels and next-tier math from shared thresholds', () => {
    const summary = summaryFromServer(
      parsePlayerRank(SERVER_RANK_PAYLOAD) as ServerPlayerRank,
    );
    expect(summary.tierLabel).toBe('Platinum');
    expect(summary.nextTier).toEqual({
      key: 'diamond',
      label: 'Diamond',
      minRating: 7.5,
      pointsNeeded: 0.25,
    });
  });

  it('re-derives the tier from the rating when the stored tier is unknown', () => {
    const summary = summaryFromServer({
      rating: 8,
      tier: 'grandmaster-9000',
      techniqueCount: 1,
      scoredShotCount: 1,
      updatedAt: null,
      techniques: [
        {
          shotType: 'serve',
          score: 8,
          capturedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
    expect(summary.tier).toBe('diamond');
  });
});

describe('resolvePlayerRank', () => {
  const localFacts = [
    fact('forehand_drive', 8, '2026-08-01T10:00:00.000Z'),
    fact('overhead', 6.5, '2026-08-02T10:00:00.000Z'),
    fact('dink', 5, '2026-08-03T10:00:00.000Z'),
  ];

  it('prefers the account rank when it has seen at least as much evidence', () => {
    const server = parsePlayerRank(SERVER_RANK_PAYLOAD) as ServerPlayerRank;
    const resolved = resolvePlayerRank(localFacts.slice(0, 2), server)!;
    expect(resolved.source).toBe('account');
    expect(resolved.summary.rating).toBe(7.25);
  });

  it('prefers the device rank while unsynced analyses lead the account', () => {
    const server = parsePlayerRank(SERVER_RANK_PAYLOAD) as ServerPlayerRank;
    const resolved = resolvePlayerRank(localFacts, server)!;
    expect(resolved.source).toBe('device');
    expect(resolved.summary.rating).toBe(6.5);
    expect(resolved.summary.tier).toBe('platinum');
  });

  it('falls back across missing sources and stays null when neither exists', () => {
    const server = parsePlayerRank(SERVER_RANK_PAYLOAD) as ServerPlayerRank;
    expect(resolvePlayerRank([], server)!.source).toBe('account');
    expect(resolvePlayerRank(localFacts, null)!.source).toBe('device');
    expect(resolvePlayerRank([], null)).toBeNull();
  });
});
