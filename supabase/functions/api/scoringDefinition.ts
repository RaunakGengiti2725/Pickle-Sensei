/**
 * The Edge plane's view of the canonical scoring definition.
 *
 * `SCORING_DEFINITION` (packages/shared-types/src/scoringDefinition.ts) is the
 * one source of truth for the rank formula; this module re-exports it and
 * derives everything GET /v1/rank needs from it — tier ladder, technique
 * order, confidence cap, score quantization, rounding — so index.ts carries no
 * second copy of any parameter. The SQL plane (public.recompute_player_rank)
 * already materialises components 1–7 in public.player_technique_rating; the
 * Edge applies components 8 (rating) and 9 (tiers) to those rows when the saved
 * player_rank_state row is missing, and orders the summary's techniques by
 * `rating.techniqueOrder`. Every response built from these rows is tagged with
 * `SCORING_DEFINITION_VERSION`.
 *
 * Fixture parity: supabase/functions/api/__wf__/scoring_parity.test.ts.
 */
import {
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
} from "../../../packages/shared-types/src/scoringDefinition.ts";

export { SCORING_DEFINITION, SCORING_DEFINITION_VERSION };

const COMPONENTS = SCORING_DEFINITION.components;

/** Component 9 — highest threshold with `minRating <= rating` wins. */
export const PLAYER_RANK_TIERS = COMPONENTS.tiers.thresholds;

export type PlayerRankTierKey = (typeof PLAYER_RANK_TIERS)[number]["key"];

/** Component 7 — a technique weighs min(countable analyses, cap) in the rating. */
export const RANK_CONFIDENCE_CAP = COMPONENTS.confidenceWeight.cap;

/** Component 2 — integer hundredths keep TS and Postgres numeric math identical. */
export const RANK_HUNDREDTHS_PER_POINT = COMPONENTS.scoreQuantization.perPoint;

/** A public.player_technique_rating row as the Edge reads it. */
export interface TechniqueRatingRow {
  shot_type: string;
  score: number;
  sampled_count: number;
  confidence_weight: number;
}

export function playerRankTierForRating(rating: number): PlayerRankTierKey {
  let current: PlayerRankTierKey = PLAYER_RANK_TIERS[0].key;
  for (const tier of PLAYER_RANK_TIERS) {
    if (rating >= tier.minRating) current = tier.key;
  }
  return current;
}

/** UTF-16 code-unit order (`collation: "code-unit"`), never a locale collation. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `rating.techniqueOrder` — the order GET /v1/rank lists techniques in. */
export function compareTechniqueOrder(
  a: Pick<TechniqueRatingRow, "shot_type" | "score">,
  b: Pick<TechniqueRatingRow, "shot_type" | "score">,
): number {
  for (const key of COMPONENTS.rating.techniqueOrder.keys) {
    let order: number;
    switch (key.field) {
      case "score":
        order = a.score - b.score;
        break;
      case "shotType":
        order = compareCodeUnits(a.shot_type, b.shot_type);
        break;
    }
    if (order !== 0) return key.direction === "desc" ? -order : order;
  }
  return 0;
}

/** `rating.rounding` — half away from zero to `decimals` places. In hundredths
 * that is a whole-number round (10^decimals == RANK_HUNDREDTHS_PER_POINT, pinned
 * by scoring_parity.test.ts), and `Math.round` IS half-away-from-zero on the
 * non-negative 0–10 domain — the same expression computePlayerRank uses, so the
 * two planes agree bit for bit. */
export const RANK_RATING_DECIMALS = COMPONENTS.rating.rounding.decimals;

/**
 * Component 7 for a view row: `confidence_weight` when the view supplies it;
 * else min(sampled_count, cap) — equal by construction, since the form window
 * (8) is at least the cap (5); else 1, because a technique row proves at
 * least one countable analysis.
 */
export function techniqueConfidenceWeight(
  row: Pick<TechniqueRatingRow, "sampled_count" | "confidence_weight">,
): number {
  if (Number.isFinite(row.confidence_weight) && row.confidence_weight >= 1) {
    return row.confidence_weight;
  }
  if (Number.isFinite(row.sampled_count) && row.sampled_count >= 1) {
    return Math.min(row.sampled_count, RANK_CONFIDENCE_CAP);
  }
  return 1;
}

/**
 * Component 8 — the confidence-weighted mean of the ROUNDED technique scores
 * in integer hundredths, rounded once more (`rating.rounding`); identical to
 * public.recompute_player_rank and computePlayerRank. Null when there are no
 * technique rows: no scored evidence is "unranked", never a fabricated tier.
 */
export function ratingFromTechniques(
  rows: ReadonlyArray<Pick<TechniqueRatingRow, "score" | "sampled_count" | "confidence_weight">>,
): number | null {
  let confidenceSum = 0;
  let weightedHundredths = 0;
  for (const row of rows) {
    const weight = techniqueConfidenceWeight(row);
    confidenceSum += weight;
    weightedHundredths += weight * Math.round(row.score * RANK_HUNDREDTHS_PER_POINT);
  }
  if (confidenceSum === 0) return null;
  return Math.round(weightedHundredths / confidenceSum) / RANK_HUNDREDTHS_PER_POINT;
}
