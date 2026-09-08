/**
 * Canonical scoring definition — the ONE place the player-rank formula is
 * defined as data. `computePlayerRank` (mobile + any TS consumer) reads its
 * parameters from here; the Supabase Edge fallback and the SQL
 * `recompute_player_rank` port must reproduce these exact nine components and
 * prove it against `fixtures/scoring/player-rank.golden.json`, whose
 * `definitionVersion` equals `SCORING_DEFINITION_VERSION`.
 *
 * Bumping the version means the score MEANING changed (a new window, weight
 * shape, rounding rule, tier ladder, …). Historical rank rows computed under
 * an older version are never reinterpreted under a new one; parity checks
 * compare only summaries carrying the same `definitionVersion`.
 *
 * The nine components, in evaluation order:
 *   1. countability      — abstention rules: which analyses may count at all
 *   2. scoreQuantization — 0-10 scores become integer hundredths
 *   3. recencyOrder      — newest-first ordering incl. deterministic tie-break
 *   4. formWindow        — how many recent analyses define a technique
 *   5. recencyWeights    — the linear newest-heaviest weights over the window
 *   6. techniqueScore    — weighted mean + one rounding to 2 decimals
 *   7. confidenceWeight  — evidence-capped weight of a technique in the rating
 *   8. rating            — weighted mean of rounded technique scores + rounding
 *   9. tiers             — inclusive tier floors, thirds divisions, scale top
 */

export const SCORING_DEFINITION_VERSION = "rank-form-weighted-v2";

export const SCORING_DEFINITION_COMPONENT_KEYS = [
  "countability",
  "scoreQuantization",
  "recencyOrder",
  "formWindow",
  "recencyWeights",
  "techniqueScore",
  "confidenceWeight",
  "rating",
  "tiers",
] as const;

export type ScoringDefinitionComponentKey = (typeof SCORING_DEFINITION_COMPONENT_KEYS)[number];

/** Half away from zero == Postgres `round(numeric, n)` == JS `Math.round` for
 * the non-negative values this formula produces. */
export type ScoringRoundingMode = "half-away-from-zero";

export interface ScoringRounding {
  readonly mode: ScoringRoundingMode;
  readonly decimals: number;
}

export interface ScoringOrderKey {
  readonly field: "capturedAt" | "id" | "capturedAtText";
  readonly direction: "desc";
}

export interface ScoringTierThreshold {
  readonly key: string;
  readonly label: string;
  /** Inclusive lower bound of the tier on the 0-10 rating scale. */
  readonly minRating: number;
}

export interface ScoringDefinitionComponents {
  /** 1. Abstention rules. An analysis counts only when ALL hold; when nothing
   * counts, the rank is null — never a fabricated tier. */
  readonly countability: {
    readonly resultKind: string;
    readonly overallScore: { readonly finite: true; readonly min: number; readonly max: number };
    readonly shotType: "non-empty";
    readonly source: string;
    /** Mobile RealAnalysisFact rows carry no `source`; they are real by construction. */
    readonly absentSourceCountsAs: string;
    readonly noEvidence: "null";
  };
  /** 2. Scores are accumulated as exact integers so TS and Postgres numeric
   * math stay bit-identical. */
  readonly scoreQuantization: {
    readonly unit: "hundredths";
    readonly perPoint: number;
    readonly rounding: ScoringRounding;
  };
  /** 3. Newest first; ties on the capture instant break by id (uuid text ==
   * Postgres uuid byte order), then by the raw timestamp text. */
  readonly recencyOrder: { readonly keys: readonly ScoringOrderKey[] };
  /** 4. Only the newest `size` countable analyses define a technique. */
  readonly formWindow: { readonly size: number };
  /** 5. `weights[i]` multiplies the i-th newest analysis in the window. */
  readonly recencyWeights: {
    readonly shape: "linear-descending";
    readonly weights: readonly number[];
  };
  /** 6. Technique score = weighted mean of hundredths over the window, rounded once. */
  readonly techniqueScore: {
    readonly aggregate: "weighted-mean";
    readonly of: "hundredths";
    readonly weights: "recencyWeights";
    readonly rounding: ScoringRounding;
  };
  /** 7. A technique's weight in the rating = min(countable analyses, cap). */
  readonly confidenceWeight: { readonly basis: "countable-analyses"; readonly cap: number };
  /** 8. Rating = confidence-weighted mean of the ROUNDED technique scores
   * (in hundredths), rounded once more — two rounding stages, never one. */
  readonly rating: {
    readonly aggregate: "weighted-mean";
    readonly of: "rounded-technique-hundredths";
    readonly weights: "confidenceWeight";
    readonly rounding: ScoringRounding;
  };
  /** 9. Tier = highest threshold with `minRating <= rating`; divisions split
   * the tier band into thirds (III at the floor, I at the top). */
  readonly tiers: {
    readonly thresholds: readonly ScoringTierThreshold[];
    readonly topOfScale: number;
    readonly divisions: { readonly count: 3; readonly order: "III-at-floor" };
  };
}

export interface ScoringDefinition {
  readonly version: string;
  readonly scale: { readonly min: number; readonly max: number };
  readonly components: ScoringDefinitionComponents;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const FORM_WINDOW = 8;

export const SCORING_DEFINITION = deepFreeze({
  version: SCORING_DEFINITION_VERSION,
  scale: { min: 0, max: 10 },
  components: {
    countability: {
      resultKind: "scored",
      overallScore: { finite: true, min: 0, max: 10 },
      shotType: "non-empty",
      source: "real",
      absentSourceCountsAs: "real",
      noEvidence: "null",
    },
    scoreQuantization: {
      unit: "hundredths",
      perPoint: 100,
      rounding: { mode: "half-away-from-zero", decimals: 0 },
    },
    recencyOrder: {
      keys: [
        { field: "capturedAt", direction: "desc" },
        { field: "id", direction: "desc" },
        { field: "capturedAtText", direction: "desc" },
      ],
    },
    formWindow: { size: FORM_WINDOW },
    recencyWeights: {
      shape: "linear-descending",
      weights: Array.from({ length: FORM_WINDOW }, (_, index) => FORM_WINDOW - index),
    },
    techniqueScore: {
      aggregate: "weighted-mean",
      of: "hundredths",
      weights: "recencyWeights",
      rounding: { mode: "half-away-from-zero", decimals: 2 },
    },
    confidenceWeight: { basis: "countable-analyses", cap: 5 },
    rating: {
      aggregate: "weighted-mean",
      of: "rounded-technique-hundredths",
      weights: "confidenceWeight",
      rounding: { mode: "half-away-from-zero", decimals: 2 },
    },
    tiers: {
      thresholds: [
        { key: "bronze", label: "Bronze", minRating: 0 },
        { key: "silver", label: "Silver", minRating: 3.5 },
        { key: "gold", label: "Gold", minRating: 5 },
        { key: "platinum", label: "Platinum", minRating: 6.5 },
        { key: "diamond", label: "Diamond", minRating: 7.5 },
      ],
      topOfScale: 10,
      divisions: { count: 3, order: "III-at-floor" },
    },
  },
} as const satisfies ScoringDefinition);

/**
 * Golden fixture contract — `fixtures/scoring/player-rank.golden.json`.
 * Every plane (mobile/TS via `computePlayerRank`, Edge fallback, SQL
 * `recompute_player_rank`) feeds each case's `analyses` through its own
 * implementation and must reproduce `expected` exactly (or the subset of
 * fields it produces). `expected: null` means "no rank".
 */
export const PLAYER_RANK_GOLDEN_SCHEMA_VERSION = "player-rank-golden-v1";

export const PLAYER_RANK_GOLDEN_FIXTURE_PATH =
  "packages/shared-types/fixtures/scoring/player-rank.golden.json";

export interface PlayerRankGoldenAnalysis {
  readonly id: string;
  readonly shotType: string;
  readonly overallScore: number | null;
  readonly resultKind: string;
  readonly capturedAt: string;
  readonly source: string;
}

/** `PlayerRankSummary` with JSON-wide primitive types, so the fixture stays
 * loadable by planes that do not share the TS literal unions. */
export interface PlayerRankGoldenExpected {
  readonly definitionVersion: string;
  readonly rating: number;
  readonly tier: string;
  readonly tierLabel: string;
  readonly division: number;
  readonly divisionLabel: string;
  readonly techniqueCount: number;
  readonly scoredAnalysisCount: number;
  readonly techniques: ReadonlyArray<{
    readonly shotType: string;
    readonly score: number;
    readonly capturedAt: string;
    readonly sampledCount: number;
  }>;
  readonly nextTier: {
    readonly key: string;
    readonly label: string;
    readonly minRating: number;
    readonly pointsNeeded: number;
  } | null;
}

export interface PlayerRankGoldenCase {
  readonly id: string;
  readonly description: string;
  readonly analyses: readonly PlayerRankGoldenAnalysis[];
  readonly expected: PlayerRankGoldenExpected | null;
}

export interface PlayerRankGoldenFixture {
  readonly schemaVersion: string;
  readonly definitionVersion: string;
  readonly cases: readonly PlayerRankGoldenCase[];
}
