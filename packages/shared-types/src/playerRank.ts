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

import {
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
  type ScoringInstantPrecision,
} from "./scoringDefinition.js";

const DEFINITION = SCORING_DEFINITION.components;

export const PLAYER_RANK_TIERS = DEFINITION.tiers.thresholds;

/** Top of the 0-10 rating scale (the ceiling of the last tier's band). */
const TOP_OF_SCALE = DEFINITION.tiers.topOfScale;

/** Per technique, only the most recent N scored analyses define its score. */
export const RANK_FORM_WINDOW = DEFINITION.formWindow.size;

/** A technique's rating weight grows with evidence, capped here. */
export const RANK_CONFIDENCE_CAP = DEFINITION.confidenceWeight.cap;

const RANK_RECENCY_WEIGHTS = DEFINITION.recencyWeights.weights;

const HUNDREDTHS_PER_POINT = DEFINITION.scoreQuantization.perPoint;

const MILLIS_PER_SECOND = 1_000;
const FRACTION_DIGITS: Record<ScoringInstantPrecision["unit"], number> = {
  milliseconds: 3,
  microseconds: 6,
};

/** `countability.capturedAt.grammar`: the `Date#toISOString` shape the sync
 * ingress admits (supabase/functions/api/index.ts ISO_UTC_INSTANT_RE). */
const ISO_UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** C `rint()` in the default rounding mode — what Postgres applies to a
 * parsed fraction of a second (`rint(frac * 1e6)`). */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const remainder = value - floor;
  if (remainder < 0.5) return floor;
  if (remainder > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** A capture timestamp split into its whole-second instant and the fraction
 * text, so each plane's precision can be materialised from the same fields. */
interface ParsedInstant {
  /** Whole seconds since the epoch, in milliseconds. */
  readonly secondsMs: number;
  /** The fractional-second digits as written ("" when absent). */
  readonly fraction: string;
}

/**
 * Splits a capture timestamp into whole seconds and fraction text, or null
 * when the text is outside the ingress grammar (a zone offset, a missing
 * `Z`, a rolled-over calendar date, free-form text). Built from the matched
 * fields rather than `Date.parse` so every runtime (Hermes, V8, Deno) reads
 * the same instant.
 */
function parseCaptureInstant(value: string): ParsedInstant | null {
  const match = ISO_UTC_INSTANT_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { secondsMs: date.getTime(), fraction: match[7] ?? "" };
}

/**
 * The instant at one plane's precision, as an integer count of that unit
 * since the epoch. `half-even` parses the fraction the way Postgres does (a
 * double, `* 1e6`, `rint`); `truncate` keeps the leading digits the way
 * `Date.parse` does (milliseconds, extra digits dropped).
 */
function instantIn(parsed: ParsedInstant, precision: ScoringInstantPrecision): number {
  const digits = FRACTION_DIGITS[precision.unit];
  const perSecond = 10 ** digits;
  const fractionUnits =
    precision.fractionRounding === "half-even"
      ? parsed.fraction === ""
        ? 0
        : roundHalfEven(Number(`0.${parsed.fraction}`) * perSecond)
      : Number(parsed.fraction.slice(0, digits).padEnd(digits, "0"));
  return (parsed.secondsMs / MILLIS_PER_SECOND) * perSecond + fractionUnits;
}

/** `countability.capturedAt.stored`: timestamptz precision, so two rows
 * inside one millisecond order the way SQL orders them. */
function storedInstantMicros(parsed: ParsedInstant): number {
  return instantIn(parsed, DEFINITION.countability.capturedAt.stored);
}

function definitionInstant(text: string): ParsedInstant {
  const parsed = parseCaptureInstant(text);
  if (parsed === null) throw new Error(`Scoring definition instant is not an instant: ${text}`);
  return parsed;
}

/** `countability.capturedAt.boundChecks`, each materialised at its own
 * precision: a row counts only when every plane's check admits it. */
const CAPTURED_AT_BOUND_CHECKS = DEFINITION.countability.capturedAt.boundChecks.map((check) => {
  const precision: ScoringInstantPrecision = {
    unit: check.unit,
    fractionRounding: check.fractionRounding,
  };
  return {
    precision,
    min: instantIn(definitionInstant(DEFINITION.countability.capturedAt.min), precision),
    maxExclusive: instantIn(
      definitionInstant(DEFINITION.countability.capturedAt.maxExclusive),
      precision,
    ),
  };
});

function everyPlaneAdmitsInstant(parsed: ParsedInstant): boolean {
  return CAPTURED_AT_BOUND_CHECKS.every(({ precision, min, maxExclusive }) => {
    const at = instantIn(parsed, precision);
    return at >= min && at < maxExclusive;
  });
}

const SHOT_TYPE_EXCLUDED_CODE_POINTS = DEFINITION.countability.shotType.excludedCodePoints;

/** UTF-16 code-unit order (`recencyOrder` / `rating.techniqueOrder`
 * `collation: "code-unit"`), never a locale collation. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  /** `SCORING_DEFINITION_VERSION` the summary was computed under. Absent when
   * rebuilt from a server payload that predates definition tagging. */
  definitionVersion?: string;
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
  const fraction = span <= 0 ? 1 : Math.max(0, Math.min(1, (rating - floor) / span));
  const division: PlayerRankDivision = fraction >= 2 / 3 ? 1 : fraction >= 1 / 3 ? 2 : 3;
  return { division, label: DIVISION_LABELS[division] };
}

function hasValidScore(input: PlayerRankAnalysisInput): boolean {
  const rule = DEFINITION.countability.overallScore;
  return (
    typeof input.overallScore === "number" &&
    Number.isFinite(input.overallScore) &&
    input.overallScore >= rule.min &&
    input.overallScore <= rule.max
  );
}

/**
 * The stored capture instant (microseconds) when the row is STORABLE — it
 * passes every rule the sync ingress and the `public.shots` checks apply, so
 * a server plane would hold it under its id — else null. A storable row
 * counts only when it is also `scored` (`countability.resultKind`); an
 * abstention is stored, holds its id, and contributes nothing.
 */
function storableInstantMicros(input: PlayerRankAnalysisInput): number | null {
  const rule = DEFINITION.countability;
  if (
    !(rule.identity.storableResultKinds as readonly string[]).includes(input.resultKind) ||
    (input.resultKind === rule.resultKind ? !hasValidScore(input) : input.overallScore !== null) ||
    typeof input.shotType !== "string" ||
    input.shotType.trim().length === 0 ||
    input.shotType.length > rule.shotType.maxLength ||
    SHOT_TYPE_EXCLUDED_CODE_POINTS.some((codePoint) => input.shotType.includes(codePoint)) ||
    (input.source ?? rule.absentSourceCountsAs) !== rule.source ||
    typeof input.capturedAt !== "string"
  ) {
    return null;
  }
  const parsed = parseCaptureInstant(input.capturedAt);
  if (parsed === null || !everyPlaneAdmitsInstant(parsed)) return null;
  return storedInstantMicros(parsed);
}

/**
 * Quantizes a 0-10 score to integer hundredths on its shortest round-trip
 * decimal text — the text JSON carries to the server and `numeric(4,2)`
 * rounds half away from zero on storage. `Math.round(score * 100)` would
 * read the binary float instead (6.005 * 100 = 600.4999… → 600, SQL → 601).
 */
function toHundredths(score: number): number {
  const text = String(score);
  if (text.includes("e")) {
    // Only sub-1e-6 magnitudes print exponentially inside the 0-10 domain.
    return Math.round(score * HUNDREDTHS_PER_POINT);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  const kept = fraction.slice(0, 2).padEnd(2, "0");
  const roundUp = fraction.charCodeAt(2) >= 53; // '5'
  return Number(whole) * HUNDREDTHS_PER_POINT + Number(kept) + (roundUp ? 1 : 0);
}

interface CountableAnalysis {
  hundredths: number;
  /** Capture instant in microseconds since the epoch. */
  at: number;
  capturedAt: string;
  id: string;
  shotType: string;
}

/** Newest first: capture instant desc, then id desc (Postgres
 * `order by captured_at desc, id desc`), then raw string desc so inputs
 * without ids still order deterministically. */
function compareNewestFirst(a: CountableAnalysis, b: CountableAnalysis): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.id !== b.id) return compareCodeUnits(b.id, a.id);
  if (a.capturedAt !== b.capturedAt) return compareCodeUnits(b.capturedAt, a.capturedAt);
  // `recencyOrder` last key: rows without an id that share instant and text
  // still order by content, never by the (stable) sort's input order.
  return b.hundredths - a.hundredths;
}

/**
 * Computes the player's rank from their analysis history. Input order does
 * not matter. Returns null when nothing scored exists — an honest "unranked",
 * never a fabricated tier.
 */
export function computePlayerRank(
  analyses: readonly PlayerRankAnalysisInput[],
): PlayerRankSummary | null {
  // `countability.identity.survivor` = first-storable-arrival: the input
  // order is the arrival order for rows that share an id (the server keeps
  // the first stored copy and acknowledges the rest as replays); for
  // distinct analyses it plays no part.
  const held = new Set<string>();
  const byTechnique = new Map<string, CountableAnalysis[]>();
  let scoredAnalysisCount = 0;
  for (const input of analyses) {
    const at = storableInstantMicros(input);
    if (at === null) continue;
    // One analysis per id, like the SQL primary key: a replayed row is the
    // same evidence, not more of it. Lowercase so text order == uuid byte order.
    const id = input.id === undefined ? "" : input.id.toLowerCase();
    if (id !== "") {
      if (held.has(id)) continue;
      held.add(id);
    }
    if (input.resultKind !== DEFINITION.countability.resultKind) continue;
    const entry: CountableAnalysis = {
      // Integer hundredths keep one/two-decimal scores exact so the result
      // matches Postgres numeric math bit for bit.
      hundredths: toHundredths(input.overallScore as number),
      at,
      capturedAt: input.capturedAt,
      id,
      shotType: input.shotType,
    };
    scoredAnalysisCount += 1;
    const bucket = byTechnique.get(entry.shotType);
    if (bucket) bucket.push(entry);
    else byTechnique.set(entry.shotType, [entry]);
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
      const weight = RANK_RECENCY_WEIGHTS[index];
      if (weight === undefined) {
        throw new Error(`Recency weight missing for window index ${index}.`);
      }
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
        (analysis.at === latest.at && compareCodeUnits(analysis.capturedAt, latest.capturedAt) > 0)
      ) {
        latest = analysis;
      }
    }
    techniques.push({
      shotType,
      // Rounded half away from zero to 2 decimals — Postgres round(numeric).
      score: Math.round(weightedSum / weightTotal) / HUNDREDTHS_PER_POINT,
      capturedAt: latest.capturedAt,
      sampledCount: window.length,
      confidence: Math.min(bucket.length, RANK_CONFIDENCE_CAP),
    });
  }
  techniques.sort((a, b) => b.score - a.score || compareCodeUnits(a.shotType, b.shotType));

  // Rating: confidence-weighted average of the per-technique ROUNDED scores,
  // rounded to 2 decimals again — the same two-stage rounding the SQL
  // performs, so both sides stay bit-identical.
  let confidenceSum = 0;
  let weightedScoreSum = 0;
  for (const technique of techniques) {
    confidenceSum += technique.confidence;
    weightedScoreSum += technique.confidence * Math.round(technique.score * HUNDREDTHS_PER_POINT);
  }
  const rating = Math.round(weightedScoreSum / confidenceSum) / HUNDREDTHS_PER_POINT;
  const tier = playerRankTierForRating(rating);
  const tierIndex = PLAYER_RANK_TIERS.findIndex((t) => t.key === tier.key);
  const next = PLAYER_RANK_TIERS[tierIndex + 1] ?? null;
  const { division, label: divisionLabel } = playerRankDivisionForRating(rating);

  return {
    definitionVersion: SCORING_DEFINITION_VERSION,
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
            Math.round(next.minRating * HUNDREDTHS_PER_POINT - rating * HUNDREDTHS_PER_POINT) /
            HUNDREDTHS_PER_POINT,
        }
      : null,
  };
}
