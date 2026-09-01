/**
 * Player rank — the user's personal standing computed from their own scored
 * technique analyses. This is NOT a leaderboard: nothing here compares users.
 *
 * THE FORM-WEIGHTED FORMULA (v2 — replaces the lifetime average, which let
 * months-old scores drag a genuinely improved player down forever and let a
 * single lucky analysis of a brand-new technique swing the whole rating):
 *
 *   1. PER TECHNIQUE — CURRENT FORM. Take the technique's most recent
 *      RANK_FORM_WINDOW (8) scored analyses, newest first, and weight them
 *      linearly: the newest counts 8×, the next 7×, … the oldest in the
 *      window 1×. The technique score is that weighted average (0-10,
 *      2 decimals). Improving recent swings visibly moves the score, while
 *      one bad (or great) rep is still smoothed by the window.
 *
 *   2. RATING — EVIDENCE-WEIGHTED BREADTH. Each technique contributes with
 *      confidence weight min(analysisCount, RANK_CONFIDENCE_CAP=5): a stroke
 *      you have analyzed once cannot move the rating as hard as one you have
 *      proven five times. The rating is the confidence-weighted average of
 *      the per-technique (already-rounded) scores, rounded to 2 decimals.
 *
 *   3. The rating maps to a tier via PLAYER_RANK_TIERS thresholds, and to a
 *      division (III → II → I, thirds of the tier band) for finer-grained,
 *      more reachable progression between tier jumps.
 *
 * Example: dink analyses 5.0 (old) then 7.0 (new) → (8·700 + 7·500)/15 =
 * 6.07 — the newer swing leads but history still counts. Add one serve at
 * 9.0: serve weight is 1 (one analysis) vs dink weight 2 →
 * round((2·607 + 1·900)/3)/100 = 7.05 — strong, but not an instant Diamond
 * from a single lucky serve.
 *
 * Determinism rules (the TS integer-hundredths math and Postgres numeric
 * math MUST stay bit-identical):
 *   - Scores are accumulated in integer hundredths; every division is
 *     rounded half away from zero exactly once per stage (technique first,
 *     then rating over the rounded technique scores).
 *   - Recency ordering ties (identical capture instants) break by id
 *     descending (uuid text order == Postgres uuid byte order for canonical
 *     lowercase ids), then by the raw capturedAt string descending.
 *
 * The same formula lives in three places that MUST stay in agreement:
 *   - here (client/local, offline-first),
 *   - supabase/migrations/20260831130000_form_weighted_rank.sql
 *     (`public.player_technique_rating` + `public.recompute_player_rank`,
 *     the durable saved state; supersedes 20260830120000_production_launch),
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

/** Top of the 0-10 rating scale (the ceiling of the last tier's band). */
const TOP_OF_SCALE = 10;

/** Per technique, only the most recent N scored analyses define its score. */
export const RANK_FORM_WINDOW = 8;

/** A technique's rating weight grows with evidence, capped here. */
export const RANK_CONFIDENCE_CAP = 5;

export type PlayerRankTierKey = (typeof PLAYER_RANK_TIERS)[number]["key"];

export type PlayerRankDivision = 1 | 2 | 3;

export type PlayerRankDivisionLabel = "I" | "II" | "III";

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
  /** ISO-8601 capture timestamp; recency ordering and the technique's
   * reported LATEST capture both come from this. */
  capturedAt: string;
  /** Row id (uuid). Breaks recency ties deterministically; optional for
   * input-shape compatibility (absent ids tie-break on the raw string). */
  id?: string;
  /** Optional provenance guard; anything other than 'real' is skipped. */
  source?: string;
}

export interface PlayerRankTechnique {
  shotType: string;
  /** Form-weighted average of the technique's most recent scored analyses
   * (window RANK_FORM_WINDOW, newest weighted highest), 0-10, 2 decimals. */
  score: number;
  /** The LATEST capture timestamp among the technique's scored analyses. */
  capturedAt: string;
  /** How many analyses are inside the form window (≤ RANK_FORM_WINDOW).
   * Absent when rebuilt from an older server payload. */
  sampledCount?: number;
}

export interface PlayerRankSummary {
  /** Confidence-weighted average of per-technique scores, 0-10, 2 decimals. */
  rating: number;
  tier: PlayerRankTierKey;
  tierLabel: string;
  /** Position inside the tier band, thirds: III (entry) → II → I (top). */
  division: PlayerRankDivision;
  divisionLabel: PlayerRankDivisionLabel;
  /** How many techniques currently contribute to the rating. */
  techniqueCount: number;
  /** Total countable scored analyses — window-excluded history included,
   * because it still proves evidence volume. */
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

const DIVISION_LABELS: Record<PlayerRankDivision, PlayerRankDivisionLabel> = {
  1: "I",
  2: "II",
  3: "III",
};

/** Divisions split a tier band into thirds: III at the floor, I at the top.
 * Presentation-only — derived from the rating, never stored. */
export function playerRankDivisionForRating(rating: number): {
  division: PlayerRankDivision;
  label: PlayerRankDivisionLabel;
} {
  const tier = playerRankTierForRating(rating);
  const index = PLAYER_RANK_TIERS.findIndex((t) => t.key === tier.key);
  const floor = tier.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? TOP_OF_SCALE;
  const span = ceiling - floor;
  const fraction =
    span <= 0 ? 1 : Math.max(0, Math.min(1, (rating - floor) / span));
  const division: PlayerRankDivision =
    fraction >= 2 / 3 ? 1 : fraction >= 1 / 3 ? 2 : 3;
  return { division, label: DIVISION_LABELS[division] };
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

interface CountableAnalysis {
  hundredths: number;
  at: number;
  capturedAt: string;
  id: string;
}

/** Newest first: capture instant desc, then id desc (Postgres
 * `order by captured_at desc, id desc`), then raw string desc so inputs
 * without ids still order deterministically. */
function compareNewestFirst(a: CountableAnalysis, b: CountableAnalysis): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  if (a.capturedAt !== b.capturedAt) return a.capturedAt > b.capturedAt ? -1 : 1;
  return 0;
}

/**
 * Computes the player's rank from their analysis history. Input order does
 * not matter. Returns null when nothing scored exists — an honest "unranked",
 * never a fabricated tier.
 */
export function computePlayerRank(
  analyses: readonly PlayerRankAnalysisInput[],
): PlayerRankSummary | null {
  const byTechnique = new Map<string, CountableAnalysis[]>();
  let scoredAnalysisCount = 0;
  for (const input of analyses) {
    if (!isCountable(input)) continue;
    scoredAnalysisCount += 1;
    const entry: CountableAnalysis = {
      // Integer hundredths keep one/two-decimal scores exact so the result
      // matches Postgres numeric math bit for bit.
      hundredths: Math.round((input.overallScore as number) * 100),
      at: parseTimestamp(input.capturedAt),
      capturedAt: input.capturedAt,
      id: input.id ?? "",
    };
    const bucket = byTechnique.get(input.shotType);
    if (bucket) bucket.push(entry);
    else byTechnique.set(input.shotType, [entry]);
  }
  if (byTechnique.size === 0) return null;

  const techniques: Array<PlayerRankTechnique & { confidence: number }> = [];
  for (const [shotType, bucket] of byTechnique) {
    bucket.sort(compareNewestFirst);
    const window = bucket.slice(0, RANK_FORM_WINDOW);
    // Linear recency weights: newest = RANK_FORM_WINDOW … oldest-in-window = down to 1.
    let weightedSum = 0;
    let weightTotal = 0;
    window.forEach((analysis, index) => {
      const weight = RANK_FORM_WINDOW - index;
      weightedSum += weight * analysis.hundredths;
      weightTotal += weight;
    });
    // The technique reports its LATEST capture (SQL max(captured_at)); the
    // lexicographic tie-break keeps the summary order-independent when two
    // distinct strings parse to the same instant.
    let latest = bucket[0]!;
    for (const analysis of bucket) {
      if (
        analysis.at > latest.at ||
        (analysis.at === latest.at && analysis.capturedAt > latest.capturedAt)
      ) {
        latest = analysis;
      }
    }
    techniques.push({
      shotType,
      // Rounded half away from zero to 2 decimals — Postgres round(numeric).
      score: Math.round(weightedSum / weightTotal) / 100,
      capturedAt: latest.capturedAt,
      sampledCount: window.length,
      confidence: Math.min(bucket.length, RANK_CONFIDENCE_CAP),
    });
  }
  techniques.sort(
    (a, b) => b.score - a.score || a.shotType.localeCompare(b.shotType),
  );

  // Rating: confidence-weighted average of the per-technique ROUNDED scores,
  // rounded to 2 decimals again — the same two-stage rounding the SQL
  // performs, so both sides stay bit-identical.
  let confidenceSum = 0;
  let weightedScoreSum = 0;
  for (const technique of techniques) {
    confidenceSum += technique.confidence;
    weightedScoreSum += technique.confidence * Math.round(technique.score * 100);
  }
  const rating = Math.round(weightedScoreSum / confidenceSum) / 100;
  const tier = playerRankTierForRating(rating);
  const tierIndex = PLAYER_RANK_TIERS.findIndex((t) => t.key === tier.key);
  const next = PLAYER_RANK_TIERS[tierIndex + 1] ?? null;
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);

  return {
    rating,
    tier: tier.key,
    tierLabel: tier.label,
    division,
    divisionLabel,
    techniqueCount: techniques.length,
    scoredAnalysisCount,
    techniques: techniques.map(({ confidence: _confidence, ...technique }) => technique),
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded:
            Math.round(next.minRating * 100 - rating * 100) / 100,
        }
      : null,
  };
}
