/**
 * W06-01 ADVERSARY (round 3, candidate devin/pp/w06-01/impl-r3 @ e4fda763) —
 * the account plane: the mobile app rebuilds a full PlayerRankSummary from
 * GET /v1/rank. Corrupt or stale persisted rank state and an untagged server
 * payload must never become a fabricated definition version or tier.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parsePlayerRank,
  PlayerRankApiError,
  summaryFromServer,
  type ServerPlayerRank,
} from '../src/progress/playerRank';
import {
  playerRankTierForRating,
  SCORING_DEFINITION_VERSION,
} from '@pickle/shared-types';

const AT = '2026-08-01T10:00:00.000Z';

function serverRank(
  overrides: Partial<ServerPlayerRank> &
    Pick<ServerPlayerRank, 'rating' | 'tier'>,
): ServerPlayerRank {
  return {
    techniqueCount: 1,
    scoredShotCount: 1,
    updatedAt: null,
    techniques: [{ shotType: 'dink', score: overrides.rating, capturedAt: AT }],
    ...overrides,
  };
}

/** The wire shape GET /v1/rank actually emits (see supabase/functions/api/index.ts). */
const UNTAGGED_WIRE_PAYLOAD = {
  rank: {
    rating: 7.25,
    tier: 'platinum',
    techniqueCount: 1,
    scoredShotCount: 1,
    updatedAt: '2026-08-02T10:00:01.000Z',
    techniques: [
      { shot_type: 'dink', score: 7.25, captured_at: AT, sampled_count: 1 },
    ],
  },
};

describe('W06-01 r3 attack: definition version on the account plane', () => {
  it('GET /v1/rank carries a definition version the app can compare against its own', () => {
    // The objective is a version id so mobile, Edge and SQL rank
    // computations can be checked against each other. If the server never
    // emits one, the app cannot tell which definition produced the rating it
    // is about to label.
    const edgeSource = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'supabase',
        'functions',
        'api',
        'index.ts',
      ),
      'utf8',
    );
    expect(edgeSource).toMatch(/definitionVersion/);
  });

  it('does not stamp the current definition version on a payload that carries none', () => {
    // PlayerRankSummary.definitionVersion is documented as "Absent when
    // rebuilt from a server payload that predates definition tagging". The
    // production payload has never been tagged, yet the account summary is
    // labelled with whatever version THIS app build happens to ship.
    const parsed = parsePlayerRank(UNTAGGED_WIRE_PAYLOAD);
    expect(parsed).not.toBeNull();
    const summary = summaryFromServer(parsed as ServerPlayerRank);
    expect(summary.definitionVersion).toBeUndefined();
  });

  it('a stale server rating is never labelled with the newer definition version', () => {
    // Simulates the deploy window: SQL still ranks under the previous
    // definition (no version on the wire) while the app already ships v2.
    const summary = summaryFromServer(
      parsePlayerRank(UNTAGGED_WIRE_PAYLOAD) as ServerPlayerRank,
    );
    expect(summary.definitionVersion).not.toBe(SCORING_DEFINITION_VERSION);
  });
});

describe('W06-01 r3 attack: corrupt or stale persisted rank state', () => {
  it('re-derives the tier from the rating when the stored tier contradicts the shared thresholds', () => {
    // player_rank_state stores tier beside rating; a stale row (tier from an
    // older threshold table) or a corrupt one names a KNOWN tier the rating
    // does not reach. Only unknown strings are re-derived today.
    const summary = summaryFromServer(
      serverRank({ rating: 1, tier: 'diamond' }),
    );
    expect(summary.tier).toBe(playerRankTierForRating(1).key);
    expect(summary.tierLabel).toBe(playerRankTierForRating(1).label);
  });

  it('never reports negative points to the next tier', () => {
    // rating 7.5 is Diamond; a stale 'gold' tier string makes nextTier
    // Platinum (6.5) and pointsNeeded = 6.5 - 7.5 = -1.
    const summary = summaryFromServer(
      serverRank({ rating: 7.5, tier: 'gold' }),
    );
    expect(summary.nextTier === null || summary.nextTier.pointsNeeded > 0).toBe(
      true,
    );
  });

  it('keeps tier and division consistent (division is computed from the rating, tier from the string)', () => {
    const summary = summaryFromServer(
      serverRank({ rating: 9.9, tier: 'bronze' }),
    );
    const fromRating = playerRankTierForRating(9.9);
    expect(summary.tier).toBe(fromRating.key);
  });

  it('refuses technique scores outside the 0–10 scale', () => {
    expect(() =>
      parsePlayerRank({
        rank: {
          rating: 5,
          tier: 'gold',
          techniqueCount: 1,
          techniques: [{ shot_type: 'dink', score: 42, captured_at: AT }],
        },
      }),
    ).toThrow(PlayerRankApiError);
  });

  it('refuses negative or fractional analysis counts', () => {
    for (const bad of [-1, 2.5, -0.5]) {
      expect(() =>
        parsePlayerRank({
          rank: {
            rating: 5,
            tier: 'gold',
            techniqueCount: bad,
            scoredShotCount: 1,
            techniques: [{ shot_type: 'dink', score: 5, captured_at: AT }],
          },
        }),
      ).toThrow(PlayerRankApiError);
    }
  });

  it('refuses a technique row whose capturedAt is not an instant', () => {
    expect(() =>
      parsePlayerRank({
        rank: {
          rating: 5,
          tier: 'gold',
          techniqueCount: 1,
          techniques: [
            { shot_type: 'dink', score: 5, captured_at: 'not-a-date' },
          ],
        },
      }),
    ).toThrow(PlayerRankApiError);
  });
});
