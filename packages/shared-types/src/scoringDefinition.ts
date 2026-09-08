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
 *
 * Planes and identical inputs. The TS plane ranks whatever rows it is handed,
 * so its countability filter is the complete rule set. The server planes
 * (Edge fallback + SQL) rank ONLY rows that passed the sync ingress:
 * `parseSyncShot` in supabase/functions/api/index.ts and the `public.shots`
 * column checks. Every countability rule therefore names the server layer
 * that keeps violating rows out of the stored history
 * (`countability.serverIngress`), and the golden fixture separates
 *   - `cases`          — rows inside the input domain, storable on every
 *                        plane, so all planes rank IDENTICAL inputs; from
 *   - `rejectedInputs` — rows outside the domain: TS excludes them, and each
 *                        named server layer refuses them before storage (a
 *                        layer not named ADMITS the row on its own — the
 *                        other layer is what keeps it out).
 * A rule that only the TS plane enforced would make a fixture unreproducible
 * on SQL — exactly the shotType:"" gap this layout closes.
 *
 * Arrival order. The server planes keep the FIRST storable row that arrives
 * under an id (`shots_pkey`; `apply_synced_shot` acknowledges every later
 * copy as a replay without reading its content). The TS plane therefore
 * treats its input order as arrival order for rows that share an id, and
 * only for those: distinct analyses rank identically from every permutation
 * because `recencyOrder` is a total order over the content the definition
 * sees (instant, id, timestamp text, score).
 *
 * Provenance. A summary's `definitionVersion` states the definition it was
 * computed under and is emitted by the plane that computed it; a plane that
 * rebuilds a summary from another plane's payload copies the version the
 * payload carries and never substitutes its own.
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

/** Half away from zero == Postgres `round(numeric, n)` for the non-negative
 * values this formula produces. */
export type ScoringRoundingMode = "half-away-from-zero";

/** Which server layer keeps a violating row out of the stored history. */
export type ScoringServerIngressLayer = "edge" | "sql";

export interface ScoringRounding {
  readonly mode: ScoringRoundingMode;
  readonly decimals: number;
}

export interface ScoringOrderKey {
  readonly field: "capturedAt" | "id" | "capturedAtText" | "scoreHundredths" | "shotType" | "score";
  readonly direction: "asc" | "desc";
  /** Text keys are compared in this form so TS text order == SQL byte order. */
  readonly normalize?: "lowercase";
  /** Text keys compare by UTF-16 code unit — never a locale collation, so
   * every runtime (Hermes, V8, Deno) and a `C`-collated SQL sort agree. */
  readonly collation?: "code-unit";
}

/** The capturedAt text grammar every plane admits: `Date#toISOString` shape,
 * UTC `Z` only, 1-9 fractional digits, calendar-valid (no 2026-02-30). */
export type ScoringInstantGrammar = "iso-8601-utc-instant";

/** `half-even` == C `rint()` — how Postgres rounds a fraction beyond
 * microseconds when it parses a timestamptz. `truncate` — how `Date.parse`
 * drops digits beyond milliseconds. */
export type ScoringInstantFractionRounding = "half-even" | "truncate";

export type ScoringInstantUnit = "milliseconds" | "microseconds";

/** The precision at which a plane materialises an instant. */
export interface ScoringInstantPrecision {
  readonly unit: ScoringInstantUnit;
  readonly fractionRounding: ScoringInstantFractionRounding;
}

/** One plane's bounds check on the capture instant, at that plane's own
 * precision. */
export interface ScoringInstantBoundCheck extends ScoringInstantPrecision {
  readonly layer: ScoringServerIngressLayer;
  readonly check: string;
}

export interface ScoringServerIngressCheck {
  readonly layer: ScoringServerIngressLayer;
  readonly check: string;
}

export interface ScoringTierThreshold {
  readonly key: string;
  readonly label: string;
  /** Inclusive lower bound of the tier on the 0-10 rating scale. */
  readonly minRating: number;
}

/** The countability rules, each of which the server ingress enforces
 * somewhere before a row reaches SQL rank state. */
export const SCORING_COUNTABILITY_RULE_KEYS = [
  "resultKind",
  "overallScore",
  "shotType",
  "source",
  "capturedAt",
  "identity",
] as const;

export type ScoringCountabilityRuleKey = (typeof SCORING_COUNTABILITY_RULE_KEYS)[number];

export interface ScoringDefinitionComponents {
  /** 1. Abstention rules. An analysis counts only when ALL hold; when nothing
   * counts, the rank is null — never a fabricated tier. */
  readonly countability: {
    readonly resultKind: string;
    readonly overallScore: { readonly finite: true; readonly min: number; readonly max: number };
    /** Non-empty after trimming, at most `maxLength` characters. */
    readonly shotType: {
      readonly trimmedNonEmpty: true;
      readonly maxLength: number;
      /** `maxLength` counts what `String#length` counts (the Edge parser's unit). */
      readonly lengthUnit: "utf16-code-units";
      /** Code points Postgres `text` cannot hold; a row carrying one is never stored. */
      readonly excludedCodePoints: readonly string[];
    };
    readonly source: string;
    /** Mobile RealAnalysisFact rows carry no `source`; they are real by construction. */
    readonly absentSourceCountsAs: string;
    /** ISO-8601 instant inside [min, maxExclusive). */
    readonly capturedAt: {
      readonly grammar: ScoringInstantGrammar;
      readonly fractionDigits: { readonly min: number; readonly max: number };
      /** The stored instant (timestamptz): fractional digits beyond
       * microseconds are rounded half-even. Recency ordering uses it. */
      readonly stored: ScoringInstantPrecision;
      readonly min: string;
      readonly maxExclusive: string;
      /** Every plane checks [min, maxExclusive) at its OWN precision and a
       * row counts only when EVERY check admits it: the Edge parser compares
       * `Date.parse` milliseconds (so 1999-12-31T23:59:59.9999995Z is
       * refused although it stores as 2000-01-01), the SQL constraint
       * compares the stored microseconds (so 2099-12-31T23:59:59.9999995Z
       * is refused although its milliseconds are inside 2099). */
      readonly boundChecks: readonly ScoringInstantBoundCheck[];
    };
    /** `id` identifies one analysis on every plane (SQL primary key); a row
     * replayed under an id already seen counts once, never twice. */
    readonly identity: {
      readonly field: "id";
      readonly normalize: "lowercase";
      readonly duplicates: "count-once";
      /** Which of several rows sharing an id is THE analysis: the first
       * STORABLE row to arrive (input order == arrival order). The server
       * never reads a later copy's content — `apply_synced_shot` answers
       * `accepted` for an id the user already owns and `shots_pkey` refuses
       * a second insert — so an abstaining (`low_confidence`) row that
       * arrives first holds the id and a scored copy behind it never counts.
       * Rows that no plane stores (`rejectedInputs`) hold nothing. */
      readonly survivor: "first-storable-arrival";
      /** The rows that can hold an id: everything the sync ingress admits —
       * these result kinds with a score iff scored, plus every other
       * countability rule (shotType, source, capturedAt). The table also
       * admits `partial` (`shots_result_kind_check`), which the sync parser
       * refuses and no client sends; it is not part of this contract. */
      readonly storableResultKinds: readonly string[];
    };
    readonly noEvidence: "null";
    /** Every server-side check that keeps a row violating the rule out of
     * the stored history; a golden `rejectedInputs` entry names the ones
     * that refuse its row. */
    readonly serverIngress: {
      readonly [Rule in ScoringCountabilityRuleKey]: readonly ScoringServerIngressCheck[];
    };
  };
  /** 2. Scores are accumulated as exact integers so TS and Postgres numeric
   * math stay bit-identical. Quantization applies to the score's shortest
   * round-trip DECIMAL TEXT (what JSON carries to the server, and what
   * `numeric(4,2)` rounds on storage), not to the binary float. */
  readonly scoreQuantization: {
    readonly unit: "hundredths";
    readonly perPoint: number;
    readonly of: "decimal-text";
    readonly rounding: ScoringRounding;
  };
  /** 3. Newest first; ties on the capture instant break by id (lowercase uuid
   * text == Postgres uuid byte order — total for stored rows), then, for
   * rows without an id, by the raw timestamp text and the score, so the
   * order is total over everything the definition can see and no plane's
   * sort stability (input order) leaks into the weights. */
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
    /** How the summary lists its techniques (Edge `GET /v1/rank` order). */
    readonly techniqueOrder: { readonly keys: readonly ScoringOrderKey[] };
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
      shotType: {
        trimmedNonEmpty: true,
        maxLength: 64,
        lengthUnit: "utf16-code-units",
        excludedCodePoints: ["\u0000"],
      },
      source: "real",
      absentSourceCountsAs: "real",
      capturedAt: {
        grammar: "iso-8601-utc-instant",
        fractionDigits: { min: 1, max: 9 },
        stored: { unit: "microseconds", fractionRounding: "half-even" },
        min: "2000-01-01T00:00:00.000Z",
        maxExclusive: "2100-01-01T00:00:00.000Z",
        boundChecks: [
          {
            layer: "edge",
            check: "parseSyncShot capturedAt",
            unit: "milliseconds",
            fractionRounding: "truncate",
          },
          {
            layer: "sql",
            check: "shots_captured_at_bounds",
            unit: "microseconds",
            fractionRounding: "half-even",
          },
        ],
      },
      identity: {
        field: "id",
        normalize: "lowercase",
        duplicates: "count-once",
        survivor: "first-storable-arrival",
        storableResultKinds: ["scored", "low_confidence"],
      },
      noEvidence: "null",
      serverIngress: {
        resultKind: [
          { layer: "edge", check: "parseSyncShot resultKind" },
          { layer: "sql", check: "shots_result_kind_check" },
          { layer: "sql", check: "shots_low_confidence_unscored" },
        ],
        overallScore: [
          { layer: "edge", check: "parseSyncShot overallScore" },
          { layer: "sql", check: "shots_overall_score_check" },
          { layer: "sql", check: "scored_shots_have_scores" },
        ],
        shotType: [
          { layer: "edge", check: "parseSyncShot shotType" },
          { layer: "sql", check: "shots_text_bounds" },
          { layer: "sql", check: "sqlstate 22021" },
        ],
        source: [
          { layer: "edge", check: "parseSyncShot source" },
          { layer: "sql", check: "shots_source_check" },
        ],
        capturedAt: [
          { layer: "edge", check: "parseSyncShot capturedAt" },
          { layer: "sql", check: "shots_captured_at_bounds" },
          { layer: "sql", check: "sqlstate 22007" },
          { layer: "sql", check: "sqlstate 22008" },
        ],
        identity: [
          { layer: "edge", check: "apply_synced_shot replay acknowledgement" },
          { layer: "sql", check: "shots_pkey" },
        ],
      },
    },
    scoreQuantization: {
      unit: "hundredths",
      perPoint: 100,
      of: "decimal-text",
      rounding: { mode: "half-away-from-zero", decimals: 0 },
    },
    recencyOrder: {
      keys: [
        { field: "capturedAt", direction: "desc" },
        { field: "id", direction: "desc", normalize: "lowercase", collation: "code-unit" },
        { field: "capturedAtText", direction: "desc", collation: "code-unit" },
        { field: "scoreHundredths", direction: "desc" },
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
      techniqueOrder: {
        keys: [
          { field: "score", direction: "desc" },
          { field: "shotType", direction: "asc", collation: "code-unit" },
        ],
      },
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
export const PLAYER_RANK_GOLDEN_SCHEMA_VERSION = "player-rank-golden-v4";

export const PLAYER_RANK_GOLDEN_FIXTURE_PATH =
  "packages/shared-types/fixtures/scoring/player-rank.golden.json";

export interface PlayerRankGoldenAnalysis {
  readonly id: string;
  readonly shotType: string;
  readonly overallScore: number | null;
  readonly resultKind: string;
  readonly capturedAt: string;
  /** Absent rows model the mobile RealAnalysisFact shape (real by construction). */
  readonly source?: string;
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

/** Rows inside the input domain: every plane can store AND rank them. */
export interface PlayerRankGoldenCase {
  readonly id: string;
  readonly description: string;
  readonly analyses: readonly PlayerRankGoldenAnalysis[];
  readonly expected: PlayerRankGoldenExpected | null;
}

/** In-domain rows where one id occurs more than once, listed in ARRIVAL
 * order. A server receiving the rows in this order stores the first row of
 * each id (`shots_pkey` refuses the rest) and reproduces `expected`; the TS
 * plane reproduces `expected` from this order. When `conflicting` is false
 * the copies are byte-identical and every permutation reproduces `expected`
 * on every plane; when true, at least one other arrival order yields a
 * different outcome — on every plane alike. */
export interface PlayerRankGoldenReplayCase {
  readonly id: string;
  readonly description: string;
  readonly conflicting: boolean;
  readonly analyses: readonly PlayerRankGoldenAnalysis[];
  readonly expected: PlayerRankGoldenExpected | null;
}

/** A row outside the input domain. TS excludes it from every rank; the named
 * server layers refuse it before it reaches SQL rank state, so it never
 * becomes evidence on any plane. */
export interface PlayerRankGoldenRejectedInput {
  readonly id: string;
  readonly description: string;
  /** A `ScoringCountabilityRuleKey` (JSON-wide string; the golden test narrows it). */
  readonly rule: string;
  readonly analysis: PlayerRankGoldenAnalysis;
  /** The rule's `countability.serverIngress` checks that refuse this row, in
   * ingress order (`edge` before `sql`), at least one. A layer that is NOT
   * listed admits the row when it is handed the row directly — e.g. the SQL
   * column checks store `shotType: ""`, only the Edge parser refuses it —
   * so the entry states exactly which plane keeps the row out. */
  readonly refusedBy: ReadonlyArray<{ readonly layer: string; readonly check: string }>;
}

export interface PlayerRankGoldenFixture {
  readonly schemaVersion: string;
  readonly definitionVersion: string;
  readonly cases: readonly PlayerRankGoldenCase[];
  readonly replays: readonly PlayerRankGoldenReplayCase[];
  readonly rejectedInputs: readonly PlayerRankGoldenRejectedInput[];
}
