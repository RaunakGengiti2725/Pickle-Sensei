import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  playerRankTierForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import type { ApiSession } from '../account/apiSession';

/**
 * Personal player rank (Bronze → Diamond) — client side.
 *
 * The formula itself lives in @pickle/shared-types (computePlayerRank):
 * average of each technique's LATEST scored analysis, mapped to a tier.
 * This module resolves the two honest sources for it:
 *   - the account rank saved on Supabase (player_rank_state, kept current
 *     by a database trigger on every synced shot), fetched via GET /v1/rank;
 *   - the same formula computed locally from this device's analysis history,
 *     which keeps the rank working offline and covers not-yet-synced shots.
 * Whichever source has seen MORE scored analyses wins, so the rank never
 * moves backwards just because one side is briefly behind the other.
 */

export interface ServerPlayerRank {
  rating: number;
  tier: string;
  techniqueCount: number;
  /** Null when the server had to fall back to inline compute (no saved row). */
  scoredShotCount: number | null;
  updatedAt: string | null;
  techniques: Array<{ shotType: string; score: number; capturedAt: string }>;
}

export interface ResolvedPlayerRank {
  summary: PlayerRankSummary;
  /** 'account' = Supabase saved state; 'device' = computed from local rows. */
  source: 'account' | 'device';
}

export type PlayerRankFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class PlayerRankApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerRankApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePlayerRank(payload: unknown): ServerPlayerRank | null {
  if (!isRecord(payload) || !('rank' in payload)) {
    throw new PlayerRankApiError(
      'The rank server returned an invalid response.',
    );
  }
  const rank = payload['rank'];
  if (rank === null) return null;
  if (!isRecord(rank) || !Array.isArray(rank['techniques'])) {
    throw new PlayerRankApiError(
      'The rank server returned an invalid response.',
    );
  }
  const rating = finiteNumber(rank['rating']);
  const techniqueCount = finiteNumber(rank['techniqueCount']);
  const tier = rank['tier'];
  if (
    rating === null ||
    rating < 0 ||
    rating > 10 ||
    techniqueCount === null ||
    typeof tier !== 'string'
  ) {
    throw new PlayerRankApiError(
      'The rank server returned an invalid response.',
    );
  }
  const techniques = rank['techniques'].map(row => {
    if (!isRecord(row)) {
      throw new PlayerRankApiError('Invalid rank technique row.');
    }
    const shotType = row['shot_type'];
    const score = finiteNumber(row['score']);
    const capturedAt = row['captured_at'];
    if (
      typeof shotType !== 'string' ||
      score === null ||
      typeof capturedAt !== 'string'
    ) {
      throw new PlayerRankApiError('Invalid rank technique row.');
    }
    return { shotType, score, capturedAt };
  });
  const scoredShotCount = finiteNumber(rank['scoredShotCount']);
  const updatedAt = rank['updatedAt'];
  return {
    rating,
    tier,
    techniqueCount,
    scoredShotCount,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    techniques,
  };
}

/** GET /v1/rank — null means honestly unranked (no scored analyses synced). */
export async function fetchPlayerRank(
  session: ApiSession,
  fetchFn: PlayerRankFetch = globalThis.fetch,
): Promise<ServerPlayerRank | null> {
  let response: Response;
  try {
    response = await fetchFn(`${session.apiBaseUrl}/v1/rank`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
        'X-Client-Version': '0.1.0',
      },
    });
  } catch {
    throw new PlayerRankApiError(
      'Your account rank is temporarily unavailable.',
    );
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new PlayerRankApiError(
      'Your account rank is temporarily unavailable.',
    );
  }
  return parsePlayerRank(payload);
}

/** Minimal structural shape the local rank needs — satisfied by both
 * RealAnalysisFact (Progress) and LocalShotRow (Home). */
export interface PlayerRankFactLike {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
  source?: string;
}

/** The shared formula over this device's real analysis history. */
export function rankFromFacts(
  facts: readonly PlayerRankFactLike[],
): PlayerRankSummary | null {
  return computePlayerRank(
    facts.map(fact => ({
      id: fact.id,
      shotType: fact.shotType,
      overallScore: fact.overallScore,
      resultKind: fact.resultKind,
      capturedAt: fact.capturedAt,
      ...(fact.source !== undefined ? { source: fact.source } : {}),
    })),
  );
}

function tierByKey(key: string) {
  return PLAYER_RANK_TIERS.find(tier => tier.key === key) ?? null;
}

/** Rebuild a full summary (labels, next-tier math) from the saved account
 * rank, using the same shared thresholds. An unknown stored tier string is
 * never invented into a label — the rating re-derives it. */
export function summaryFromServer(server: ServerPlayerRank): PlayerRankSummary {
  const tier = tierByKey(server.tier) ?? playerRankTierForRating(server.rating);
  const tierIndex = PLAYER_RANK_TIERS.findIndex(t => t.key === tier.key);
  const next = PLAYER_RANK_TIERS[tierIndex + 1] ?? null;
  const techniques = [...server.techniques].sort(
    (a, b) => b.score - a.score || a.shotType.localeCompare(b.shotType),
  );
  return {
    rating: server.rating,
    tier: tier.key,
    tierLabel: tier.label,
    techniqueCount: server.techniqueCount,
    scoredAnalysisCount: server.scoredShotCount ?? techniques.length,
    techniques,
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded:
            Math.round(next.minRating * 100 - server.rating * 100) / 100,
        }
      : null,
  };
}

/**
 * Picks between the saved account rank and the locally computed one: the
 * source that has seen more scored analyses is the more complete evidence
 * (local leads while shots wait in the sync outbox; account leads after a
 * reinstall, when local history is empty). Ties go to the account — it is
 * the durable copy.
 */
export function resolvePlayerRank(
  facts: readonly PlayerRankFactLike[],
  serverRank: ServerPlayerRank | null,
): ResolvedPlayerRank | null {
  const local = rankFromFacts(facts);
  const account = serverRank ? summaryFromServer(serverRank) : null;
  if (account && local) {
    return account.scoredAnalysisCount >= local.scoredAnalysisCount
      ? { summary: account, source: 'account' }
      : { summary: local, source: 'device' };
  }
  if (account) return { summary: account, source: 'account' };
  if (local) return { summary: local, source: 'device' };
  return null;
}
