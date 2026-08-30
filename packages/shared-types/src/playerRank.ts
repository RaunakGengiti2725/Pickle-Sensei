/**
 * Player rank — the user's personal standing computed from their own scored
 * technique analyses. This is NOT a leaderboard: nothing here compares users.
 *
 * The formula (kept deliberately simple and explainable):
 *   1. For every technique (shot type) the player has at least one SCORED
 *      analysis for, take the LATEST scored analysis's overall score (0-10).
 *      A new analysis of the same technique replaces the old one — every
 *      analysis therefore moves the rank.
 *   2. The player rating is the plain average of those per-technique scores,
 *      rounded to 2 decimals (half away from zero, matching Postgres
 *      `round(numeric, 2)`).
 *   3. The rating maps to a tier via PLAYER_RANK_TIERS thresholds.
 *
 * Example: Forehand Drive 8.0 → rating 8.00 (Diamond). Add Overhead 6.5 →
 * rating 7.25 (Platinum). Add Backhand Drive 9.0 → rating 7.83 (Diamond).
 *
 * The same formula lives in three places that MUST stay in agreement:
 *   - here (client/local, offline-first),
 *   - supabase/migrations/*_player_rank.sql (`public.player_rank_tier` +
 *     `public.recompute_player_rank`, the durable saved state),
 *   - supabase/functions/api/index.ts (`GET /v1/rank` fallback compute).
 *
 * Honesty rules carried over from the rest of the app:
 *   - Low-confidence (abstained) analyses NEVER contribute — they carry no
 *     score. No scored analyses → no rank (null), never an invented Bronze.
 *   - Only source='real' analyses count; fixtures cannot rank a player.
 */

export const PLAYER_RANK_TIERS = [
  { key: "bronze", label: "Bronze", minRating: 0 },
  { key: "silver", label: "Silver", minRating: 3.5 },
  { key: "gold", label: "Gold", minRating: 5 },
  { key: "platinum", label: "Platinum", minRating: 6.5 },
  { key: "diamond", label: "Diamond", minRating: 7.5 },
] as const;

export type PlayerRankTierKey = (typeof PLAYER_RANK_TIERS)[number]["key"];

export interface PlayerRankTier {
  key: PlayerRankTierKey;
  label: string;
  /** Inclusive lower bound of the tier on the 0-10 rating scale. */
  minRating: number;
}

/** One analysis, in the shape both RealAnalysisFact (mobile) and the shots
 * table (Supabase) can provide. Extra fields are ignored. */
export interface PlayerRankAnalysisInput {
  shotType: string;
  /** 0-10 overall score; null exactly when the analysis abstained. */
  overallScore: number | null;
  /** Only 'scored' analyses contribute. */
  resultKind: string;
  /** ISO-8601 capture timestamp; the latest per technique wins. */
  capturedAt: string;
  /** Optional deterministic tie-breaker for identical timestamps (uuid). */
  id?: string;
  /** Optional provenance guard; anything other than 'real' is skipped. */
  source?: string;
}

export interface PlayerRankTechnique {
  shotType: string;
  /** The technique's current (latest) 0-10 score. */
  score: number;
  capturedAt: string;
}

export interface PlayerRankSummary {
  /** Average of per-technique current scores, 0-10, 2 decimals. */
  rating: number;
  tier: PlayerRankTierKey;
  tierLabel: string;
  /** How many techniques currently contribute to the rating. */
  techniqueCount: number;
  /** Total scored analyses seen (context, not part of the formula). */
  scoredAnalysisCount: number;
  /** Per-technique contributions, highest score first. */
  techniques: PlayerRankTechnique[];
  /** The next tier up and how far away it is; null at the top tier. */
  nextTier: {
    key: PlayerRankTierKey;
    label: string;
    minRating: number;
    pointsNeeded: number;
  } | null;
}

export function playerRankTierForRating(rating: number): PlayerRankTier {
  let current: PlayerRankTier = PLAYER_RANK_TIERS[0];
  for (const tier of PLAYER_RANK_TIERS) {
    if (rating >= tier.minRating) current = tier;
  }
  return current;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isCountable(input: PlayerRankAnalysisInput): boolean {
  return (
    input.resultKind === "scored" &&
    typeof input.overallScore === "number" &&
    Number.isFinite(input.overallScore) &&
    input.overallScore >= 0 &&
    input.overallScore <= 10 &&
    typeof input.shotType === "string" &&
    input.shotType.length > 0 &&
    (input.source === undefined || input.source === "real")
  );
}

/**
 * Computes the player's rank from their analysis history. Input order does
 * not matter. Returns null when nothing scored exists — an honest "unranked",
 * never a fabricated tier.
 */
export function computePlayerRank(
  analyses: readonly PlayerRankAnalysisInput[],
): PlayerRankSummary | null {
  const latestByTechnique = new Map<string, { input: PlayerRankAnalysisInput; at: number }>();
  let scoredAnalysisCount = 0;
  for (const input of analyses) {
    if (!isCountable(input)) continue;
    scoredAnalysisCount += 1;
    const at = parseTimestamp(input.capturedAt);
    const current = latestByTechnique.get(input.shotType);
    const wins =
      !current ||
      at > current.at ||
      // Deterministic tie-break mirroring the SQL view's `id desc`.
      (at === current.at && (input.id ?? "") > (current.input.id ?? ""));
    if (wins) latestByTechnique.set(input.shotType, { input, at });
  }
  if (latestByTechnique.size === 0) return null;

  const techniques: PlayerRankTechnique[] = [...latestByTechnique.values()]
    .map(({ input }) => ({
      shotType: input.shotType,
      score: input.overallScore as number,
      capturedAt: input.capturedAt,
    }))
    .sort((a, b) => b.score - a.score || a.shotType.localeCompare(b.shotType));

  // Average in integer hundredths so one/two-decimal scores stay exact and
  // the result matches Postgres `round(avg(overall_score), 2)`.
  const sumHundredths = techniques.reduce(
    (sum, technique) => sum + Math.round(technique.score * 100),
    0,
  );
  const rating = Math.round(sumHundredths / techniques.length) / 100;
  const tier = playerRankTierForRating(rating);
  const tierIndex = PLAYER_RANK_TIERS.findIndex((t) => t.key === tier.key);
  const next = PLAYER_RANK_TIERS[tierIndex + 1] ?? null;

  return {
    rating,
    tier: tier.key,
    tierLabel: tier.label,
    techniqueCount: techniques.length,
    scoredAnalysisCount,
    techniques,
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded: Math.round(next.minRating * 100 - rating * 100) / 100,
        }
      : null,
  };
}
