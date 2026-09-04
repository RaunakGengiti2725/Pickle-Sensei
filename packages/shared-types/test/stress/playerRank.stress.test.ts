import { describe, it } from "vitest";
import {
  PLAYER_RANK_TIERS,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
  SHOT_TYPES,
  computePlayerRank,
  playerRankDivisionForRating,
  playerRankTierForRating,
  type PlayerRankAnalysisInput,
  type PlayerRankSummary,
} from "../../src/index.js";
import {
  bump,
  check,
  checkEqual,
  expectCampaignHeld,
  makeRng,
  runStressCampaign,
  stable,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "./harness.js";

/**
 * Seeded stress of computePlayerRank (playerRank.ts) against an exact
 * BigInt re-implementation of the documented formula:
 *  - only real, scored, finite, in-range analyses count (abstentions,
 *    fixtures, NaN/Infinity/out-of-range never contribute; nothing countable
 *    → null, never an invented Bronze);
 *  - per technique: form window of the RANK_FORM_WINDOW newest analyses
 *    (capture instant desc, id desc, raw string desc), linear weights,
 *    rounded half away from zero once to hundredths;
 *  - rating: confidence-weighted (min(count, RANK_CONFIDENCE_CAP)) average of
 *    the ROUNDED technique scores, rounded once more;
 *  - tier/division/nextTier derived from the rating; output finite, bounded,
 *    sorted, order-independent and deterministic.
 */

type Action =
  | {
      kind: "scored";
      shotType: string;
      hundredths: number;
      atOffsetMs: number;
      tsForm: "z" | "offset" | "nomillis";
      idSeed: number;
    }
  | { kind: "abstained"; shotType: string; atOffsetMs: number; idSeed: number }
  | { kind: "fixture"; shotType: string; hundredths: number; atOffsetMs: number; idSeed: number }
  | {
      kind: "junk";
      shotType: string;
      score: "nan" | "inf" | "neg" | "over" | "empty_shot_type" | "unparseable_ts";
      atOffsetMs: number;
      idSeed: number;
    }
  | { kind: "shuffle"; permutationSeed: number }
  | { kind: "remove"; index: number };

interface Model {
  inputs: PlayerRankAnalysisInput[];
  /** Countable hundredths keyed by input id (ids are unique in this domain). */
  countable: Map<
    string,
    { shotType: string; hundredths: bigint; at: number; capturedAt: string; id: string }
  >;
}

const BASE_MS = Date.parse("2026-06-01T00:00:00.000Z");
const EXTRA_SHOT_TYPES = ["lob", "erne", "backhand_dink"];

function uuidFrom(n: number): string {
  return `${(n >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function isoFor(offsetMs: number, form: "z" | "offset" | "nomillis"): string {
  const date = new Date(BASE_MS + offsetMs);
  if (form === "z") return date.toISOString();
  if (form === "nomillis") return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return date.toISOString().replace(/Z$/, "+00:00");
}

function genAction(rng: Rng, index: number): Action {
  const roll = rng.next();
  const shotType = rng.chance(0.9) ? rng.pick(SHOT_TYPES) : rng.pick(EXTRA_SHOT_TYPES);
  // Repeated offsets make same-instant ties common; the id then decides.
  const atOffsetMs = rng.chance(0.25)
    ? rng.int(0, 5) * 60_000
    : rng.int(0, 90) * 86_400_000 + rng.int(0, 86_399_999);
  const idSeed = index + 1;
  if (roll < 0.55) {
    const hundredths = rng.chance(0.2)
      ? rng.int(0, 10) * 100
      : rng.chance(0.5)
        ? rng.int(0, 100) * 10
        : rng.int(0, 1000);
    return {
      kind: "scored",
      shotType,
      hundredths,
      atOffsetMs,
      tsForm: rng.chance(0.8) ? "z" : rng.chance(0.5) ? "offset" : "nomillis",
      idSeed,
    };
  }
  if (roll < 0.65) return { kind: "abstained", shotType, atOffsetMs, idSeed };
  if (roll < 0.72)
    return { kind: "fixture", shotType, hundredths: rng.int(0, 1000), atOffsetMs, idSeed };
  if (roll < 0.82) {
    return {
      kind: "junk",
      shotType,
      score: rng.pick(["nan", "inf", "neg", "over", "empty_shot_type", "unparseable_ts"] as const),
      atOffsetMs,
      idSeed,
    };
  }
  if (roll < 0.92) return { kind: "shuffle", permutationSeed: rng.int(0, 0xffffffff) };
  return { kind: "remove", index: rng.int(0, 1_000_000) };
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function compareNewest(
  a: { at: number; id: string; capturedAt: string },
  b: { at: number; id: string; capturedAt: string },
): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  if (a.capturedAt !== b.capturedAt) return a.capturedAt > b.capturedAt ? -1 : 1;
  return 0;
}

interface ExpectedTechnique {
  shotType: string;
  hundredths: bigint;
  capturedAt: string;
  sampledCount: number;
  confidence: bigint;
}

function expectedSummary(
  model: Model,
): { rating: bigint; techniques: ExpectedTechnique[]; scoredAnalysisCount: number } | null {
  const buckets = new Map<
    string,
    Array<{ hundredths: bigint; at: number; capturedAt: string; id: string }>
  >();
  for (const entry of model.countable.values()) {
    const bucket = buckets.get(entry.shotType) ?? [];
    bucket.push(entry);
    buckets.set(entry.shotType, bucket);
  }
  if (buckets.size === 0) return null;
  const techniques: ExpectedTechnique[] = [];
  for (const [shotType, bucket] of buckets) {
    bucket.sort(compareNewest);
    const window = bucket.slice(0, RANK_FORM_WINDOW);
    let weighted = 0n;
    let weights = 0n;
    window.forEach((entry, i) => {
      const weight = BigInt(RANK_FORM_WINDOW - i);
      weighted += weight * entry.hundredths;
      weights += weight;
    });
    let latest = bucket[0]!;
    for (const entry of bucket) {
      if (entry.at > latest.at || (entry.at === latest.at && entry.capturedAt > latest.capturedAt))
        latest = entry;
    }
    techniques.push({
      shotType,
      hundredths: roundHalfUp(weighted, weights),
      capturedAt: latest.capturedAt,
      sampledCount: window.length,
      confidence: BigInt(Math.min(bucket.length, RANK_CONFIDENCE_CAP)),
    });
  }
  techniques.sort((a, b) =>
    a.hundredths === b.hundredths
      ? a.shotType.localeCompare(b.shotType)
      : a.hundredths > b.hundredths
        ? -1
        : 1,
  );
  let confidenceSum = 0n;
  let weightedSum = 0n;
  for (const technique of techniques) {
    confidenceSum += technique.confidence;
    weightedSum += technique.confidence * technique.hundredths;
  }
  return {
    rating: roundHalfUp(weightedSum, confidenceSum),
    techniques,
    scoredAnalysisCount: model.countable.size,
  };
}

function toHundredths(value: number, invariant: string): bigint {
  check(Number.isFinite(value), invariant, () => `non-finite ${String(value)}`);
  const scaled = value * 100;
  check(
    Math.abs(scaled - Math.round(scaled)) < 1e-6,
    invariant,
    () => `${value} is not a 2-decimal value`,
  );
  return BigInt(Math.round(scaled));
}

function checkSummary(summary: PlayerRankSummary | null, model: Model): void {
  const expected = expectedSummary(model);
  if (expected === null) {
    check(summary === null, "no-countable-analyses-means-null-rank", () => stable(summary));
    return;
  }
  check(summary !== null, "countable-analyses-produce-a-rank", () => "null");
  const rank = summary!;
  const rating = toHundredths(rank.rating, "rating-finite-two-decimals");
  check(rating >= 0n && rating <= 1000n, "rating-within-0-10", () => rank.rating.toString());
  checkEqual(rating, expected.rating, "rating-matches-exact-bigint-model");
  checkEqual(
    rank.scoredAnalysisCount,
    expected.scoredAnalysisCount,
    "scored-count-counts-every-countable-analysis",
  );
  checkEqual(
    rank.techniqueCount,
    expected.techniques.length,
    "technique-count-matches-distinct-countable-shot-types",
  );
  checkEqual(rank.techniques.length, expected.techniques.length, "technique-list-length");
  rank.techniques.forEach((technique, i) => {
    const want = expected.techniques[i]!;
    const score = toHundredths(technique.score, "technique-score-finite-two-decimals");
    check(score >= 0n && score <= 1000n, "technique-score-within-0-10", () =>
      technique.score.toString(),
    );
    checkEqual(
      {
        shotType: technique.shotType,
        score,
        capturedAt: technique.capturedAt,
        sampledCount: technique.sampledCount,
      },
      {
        shotType: want.shotType,
        score: want.hundredths,
        capturedAt: want.capturedAt,
        sampledCount: want.sampledCount,
      },
      "technique-form-window-score-latest-capture-and-order",
    );
    check(technique.sampledCount! <= RANK_FORM_WINDOW, "sampled-count-bounded-by-form-window", () =>
      String(technique.sampledCount),
    );
  });
  const scores = expected.techniques.map((t) => t.hundredths);
  const min = scores.reduce((a, b) => (a < b ? a : b));
  const max = scores.reduce((a, b) => (a > b ? a : b));
  check(
    rating >= min && rating <= max,
    "rating-lies-between-technique-extremes",
    () => `${rating} not in [${min}, ${max}]`,
  );

  const tier = playerRankTierForRating(rank.rating);
  let tierIndex = 0;
  PLAYER_RANK_TIERS.forEach((t, i) => {
    if (rank.rating >= t.minRating) tierIndex = i;
  });
  const expectedTier = PLAYER_RANK_TIERS[tierIndex]!;
  checkEqual(
    { key: rank.tier, label: rank.tierLabel },
    { key: expectedTier.key, label: expectedTier.label },
    "tier-matches-threshold-table",
  );
  checkEqual(tier.key, expectedTier.key, "tier-helper-matches-threshold-table");
  const floor = expectedTier.minRating;
  const ceiling = PLAYER_RANK_TIERS[tierIndex + 1]?.minRating ?? 10;
  const fraction = (rank.rating - floor) / (ceiling - floor);
  const expectedDivision = fraction >= 2 / 3 ? 1 : fraction >= 1 / 3 ? 2 : 3;
  checkEqual(rank.division, expectedDivision, "division-splits-tier-band-in-thirds");
  checkEqual(
    rank.divisionLabel,
    { 1: "I", 2: "II", 3: "III" }[expectedDivision],
    "division-label-matches-division",
  );
  checkEqual(
    playerRankDivisionForRating(rank.rating),
    { division: rank.division, label: rank.divisionLabel },
    "division-helper-matches-summary",
  );
  const next = PLAYER_RANK_TIERS[tierIndex + 1];
  if (next === undefined) {
    check(rank.nextTier === null, "top-tier-has-no-next-tier", () => stable(rank.nextTier));
  } else {
    check(rank.nextTier !== null, "next-tier-present-below-top", () => "null");
    const pointsNeeded = toHundredths(
      rank.nextTier!.pointsNeeded,
      "points-needed-finite-two-decimals",
    );
    checkEqual(
      {
        key: rank.nextTier!.key,
        label: rank.nextTier!.label,
        minRating: rank.nextTier!.minRating,
        pointsNeeded,
      },
      {
        key: next.key,
        label: next.label,
        minRating: next.minRating,
        pointsNeeded: BigInt(Math.round(next.minRating * 100)) - rating,
      },
      "next-tier-distance-exact",
    );
    check(pointsNeeded > 0n, "points-needed-positive", () => pointsNeeded.toString());
  }
  check(!stable(rank).includes("__nonfinite"), "no-nan-or-infinity-anywhere-in-summary", () =>
    stable(rank),
  );
}

function makeCampaign(): StressCampaign<Action, Model> {
  const stats: Record<string, number> = {};
  return {
    name: "player-rank",
    stats,
    init: () => ({ inputs: [], countable: new Map() }),
    genAction: (rng, index) => genAction(rng, index),
    step(model, action) {
      if (action.kind === "shuffle") {
        const order = makeRng(action.permutationSeed).permutation(model.inputs.length);
        model.inputs = order.map((i) => model.inputs[i]!);
        bump(stats, "shuffle");
      } else if (action.kind === "remove") {
        if (model.inputs.length > 0) {
          const [removed] = model.inputs.splice(action.index % model.inputs.length, 1);
          if (removed?.id !== undefined) model.countable.delete(removed.id);
        }
        bump(stats, "remove");
      } else {
        const id = uuidFrom(action.idSeed);
        let input: PlayerRankAnalysisInput;
        if (action.kind === "scored") {
          const capturedAt = isoFor(action.atOffsetMs, action.tsForm);
          input = {
            id,
            shotType: action.shotType,
            overallScore: action.hundredths / 100,
            resultKind: "scored",
            capturedAt,
          };
          model.countable.set(id, {
            shotType: action.shotType,
            hundredths: BigInt(action.hundredths),
            at: Date.parse(capturedAt),
            capturedAt,
            id,
          });
        } else if (action.kind === "abstained") {
          input = {
            id,
            shotType: action.shotType,
            overallScore: null,
            resultKind: "low_confidence",
            capturedAt: isoFor(action.atOffsetMs, "z"),
          };
        } else if (action.kind === "fixture") {
          input = {
            id,
            shotType: action.shotType,
            overallScore: action.hundredths / 100,
            resultKind: "scored",
            capturedAt: isoFor(action.atOffsetMs, "z"),
            source: "fixture",
          };
        } else {
          const capturedAt =
            action.score === "unparseable_ts" ? "not-a-timestamp" : isoFor(action.atOffsetMs, "z");
          const score =
            action.score === "nan"
              ? Number.NaN
              : action.score === "inf"
                ? Number.POSITIVE_INFINITY
                : action.score === "neg"
                  ? -0.5
                  : action.score === "over"
                    ? 10.01
                    : 7.25;
          input = {
            id,
            shotType: action.score === "empty_shot_type" ? "" : action.shotType,
            overallScore: score,
            resultKind: "scored",
            capturedAt,
            source: "real",
          };
          if (action.score === "unparseable_ts") {
            // Unparseable timestamps still count (documented: they sort as
            // oldest, -Infinity) — the score is legal.
            model.countable.set(id, {
              shotType: action.shotType,
              hundredths: 725n,
              at: Number.NEGATIVE_INFINITY,
              capturedAt,
              id,
            });
          }
        }
        model.inputs.push(input);
        bump(stats, action.kind === "junk" ? `junk_${action.score}` : action.kind);
      }

      const summary = computePlayerRank(model.inputs);
      checkSummary(summary, model);
      checkEqual(computePlayerRank(model.inputs), summary, "rank-is-deterministic-for-same-input");
      checkEqual(
        computePlayerRank([...model.inputs].reverse()),
        summary,
        "rank-is-input-order-independent",
      );
      if (summary) bump(stats, `tier_${summary.tier}`);
      else bump(stats, "unranked");
      return summary === null
        ? "null"
        : `${summary.rating}:${summary.tier}:${summary.division}:${summary.techniqueCount}:${summary.scoredAnalysisCount}`;
    },
  };
}

describe("player rank — seeded randomized long-run", () => {
  it(
    "matches the exact integer-hundredths model and stays bounded, sorted, order-independent",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign()));
    },
    stressTestTimeoutMs(),
  );
});
