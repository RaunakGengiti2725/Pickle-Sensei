/**
 * W06-01 adversarial attack — independent reference implementation.
 *
 * The candidate says SCORING_DEFINITION is "the ONE place the player-rank
 * formula is defined as data" and that every plane must reproduce the golden
 * fixture. This attack re-implements the nine components from the DEFINITION
 * OBJECT ONLY (no reuse of playerRank.ts internals) in exact rational
 * arithmetic (BigInt), then:
 *   1. checks the fixture's `expected` values against the reference,
 *   2. differential-fuzzes computePlayerRank against the reference on the
 *      score scales the product produces (one and two decimals),
 *   3. probes the scale boundary the definition does NOT exclude (three
 *      decimals, exact half ties) where float Math.round and the declared
 *      "half-away-from-zero" mode disagree.
 */
import { describe, expect, it } from "vitest";
import golden from "../../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import { computePlayerRank, type PlayerRankAnalysisInput } from "../../playerRank.js";
import { SCORING_DEFINITION, type PlayerRankGoldenFixture } from "../../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const D = SCORING_DEFINITION.components;

/** Exact non-negative rational p/q. */
interface Rational {
  p: bigint;
  q: bigint;
}

/** Half away from zero for a non-negative rational (== Postgres round(numeric)). */
function roundHalfAwayFromZero({ p, q }: Rational): bigint {
  return (2n * p + q) / (2n * q);
}

/** A decimal string like "6.005" → exact rational. */
function decimalToRational(text: string): Rational {
  const [whole, frac = ""] = text.split(".");
  const digits = `${whole}${frac}`;
  return { p: BigInt(digits), q: 10n ** BigInt(frac.length) };
}

interface ReferenceInput {
  id: string;
  shotType: string;
  /** Exact decimal score text, or null for abstentions. */
  score: string | null;
  resultKind: string;
  capturedAt: string;
  source?: string;
}

interface ReferenceTechnique {
  shotType: string;
  scoreHundredths: bigint;
  confidence: bigint;
  sampledCount: number;
  capturedAt: string;
}

interface ReferenceSummary {
  ratingHundredths: bigint;
  tier: string;
  techniques: ReferenceTechnique[];
  scoredAnalysisCount: number;
}

function decimalInRange(text: string): boolean {
  const { p, q } = decimalToRational(text);
  const min = BigInt(D.countability.overallScore.min) * q;
  const max = BigInt(D.countability.overallScore.max) * q;
  return p >= min && p <= max;
}

/** Component 1 — countability, read from the definition. */
function referenceCountable(input: ReferenceInput): boolean {
  if (input.resultKind !== D.countability.resultKind) return false;
  if (input.score === null) return false;
  if (!/^\d+(\.\d+)?$/.test(input.score)) return false;
  if (!decimalInRange(input.score)) return false;
  if (input.shotType.length === 0) return false;
  return (input.source ?? D.countability.absentSourceCountsAs) === D.countability.source;
}

/** Component 2 — hundredths quantization with the declared rounding mode. */
function referenceHundredths(score: string): bigint {
  const r = decimalToRational(score);
  return roundHalfAwayFromZero({ p: r.p * BigInt(D.scoreQuantization.perPoint), q: r.q });
}

/** Component 3 — recency order keys, read from the definition. Byte order
 * of a canonical lowercase uuid equals its text order, which is what the
 * definition claims for `id`. */
function referenceNewestFirst(a: ReferenceInput, b: ReferenceInput): number {
  for (const key of D.recencyOrder.keys) {
    let cmp = 0;
    if (key.field === "capturedAt") {
      const ta = Date.parse(a.capturedAt);
      const tb = Date.parse(b.capturedAt);
      cmp = ta === tb ? 0 : ta < tb ? -1 : 1;
    } else if (key.field === "id") {
      cmp = a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    } else {
      cmp = a.capturedAt === b.capturedAt ? 0 : a.capturedAt < b.capturedAt ? -1 : 1;
    }
    if (cmp !== 0) return key.direction === "desc" ? -cmp : cmp;
  }
  return 0;
}

function referenceTier(ratingHundredths: bigint): string {
  let tier: string = D.tiers.thresholds[0]!.key;
  for (const t of D.tiers.thresholds) {
    const floor = decimalToRational(String(t.minRating));
    if (ratingHundredths * floor.q >= floor.p * BigInt(D.scoreQuantization.perPoint)) {
      tier = t.key;
    }
  }
  return tier;
}

export function referenceRank(inputs: readonly ReferenceInput[]): ReferenceSummary | null {
  const countable = inputs.filter(referenceCountable);
  if (countable.length === 0) return null;
  const buckets = new Map<string, ReferenceInput[]>();
  for (const row of countable) {
    const list = buckets.get(row.shotType) ?? [];
    list.push(row);
    buckets.set(row.shotType, list);
  }
  const techniques: ReferenceTechnique[] = [];
  for (const [shotType, rows] of buckets) {
    rows.sort(referenceNewestFirst);
    const window = rows.slice(0, D.formWindow.size);
    let num = 0n;
    let den = 0n;
    window.forEach((row, i) => {
      const w = BigInt(D.recencyWeights.weights[i]!);
      num += w * referenceHundredths(row.score as string);
      den += w;
    });
    techniques.push({
      shotType,
      scoreHundredths: roundHalfAwayFromZero({ p: num, q: den }),
      confidence: BigInt(Math.min(rows.length, D.confidenceWeight.cap)),
      sampledCount: window.length,
      capturedAt: rows[0]!.capturedAt,
    });
  }
  let num = 0n;
  let den = 0n;
  for (const t of techniques) {
    num += t.confidence * t.scoreHundredths;
    den += t.confidence;
  }
  const ratingHundredths = roundHalfAwayFromZero({ p: num, q: den });
  techniques.sort((a, b) =>
    a.scoreHundredths === b.scoreHundredths
      ? a.shotType.localeCompare(b.shotType)
      : a.scoreHundredths > b.scoreHundredths
        ? -1
        : 1,
  );
  return {
    ratingHundredths,
    tier: referenceTier(ratingHundredths),
    techniques,
    scoredAnalysisCount: countable.length,
  };
}

function toReferenceInput(a: PlayerRankAnalysisInput, scoreText: string | null): ReferenceInput {
  return {
    id: a.id ?? "",
    shotType: a.shotType,
    score: scoreText,
    resultKind: a.resultKind,
    capturedAt: a.capturedAt,
    ...(a.source !== undefined ? { source: a.source } : {}),
  };
}

function hundredthsOf(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

function assertMatchesReference(
  analyses: readonly PlayerRankAnalysisInput[],
  scoreTexts: readonly (string | null)[],
  context: string,
) {
  const actual = computePlayerRank(analyses);
  const expected = referenceRank(analyses.map((a, i) => toReferenceInput(a, scoreTexts[i]!)));
  if (expected === null) {
    expect(actual, context).toBeNull();
    return;
  }
  expect(actual, context).not.toBeNull();
  const summary = actual!;
  expect(hundredthsOf(summary.rating), `${context} rating`).toBe(expected.ratingHundredths);
  expect(summary.tier, `${context} tier`).toBe(expected.tier);
  expect(summary.scoredAnalysisCount, `${context} scoredAnalysisCount`).toBe(
    expected.scoredAnalysisCount,
  );
  expect(summary.techniqueCount, `${context} techniqueCount`).toBe(expected.techniques.length);
  expect(
    summary.techniques.map((t) => ({
      shotType: t.shotType,
      hundredths: hundredthsOf(t.score),
      sampledCount: t.sampledCount,
    })),
    `${context} techniques`,
  ).toEqual(
    expected.techniques.map((t) => ({
      shotType: t.shotType,
      hundredths: t.scoreHundredths,
      sampledCount: t.sampledCount,
    })),
  );
}

/** Deterministic PRNG so every failure is reproducible from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHOT_TYPES = ["dink", "drive", "serve", "volley", "drop"];

function uuidFrom(rand: () => number): string {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join("");
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
}

function randomHistory(
  rand: () => number,
  decimals: number,
  count: number,
): { analyses: PlayerRankAnalysisInput[]; scoreTexts: (string | null)[] } {
  const analyses: PlayerRankAnalysisInput[] = [];
  const scoreTexts: (string | null)[] = [];
  const scale = 10 ** decimals;
  const base = Date.UTC(2026, 7, 1);
  for (let i = 0; i < count; i++) {
    const abstain = rand() < 0.15;
    const units = Math.floor(rand() * (10 * scale + 1));
    const text = abstain ? null : (units / scale).toFixed(decimals);
    const sameInstant = rand() < 0.2;
    const at = new Date(base + (sameInstant ? 0 : Math.floor(rand() * 90) * 86_400_000));
    analyses.push({
      id: uuidFrom(rand),
      shotType: SHOT_TYPES[Math.floor(rand() * SHOT_TYPES.length)]!,
      overallScore: text === null ? null : Number(text),
      resultKind: abstain ? "low_confidence" : "scored",
      capturedAt: at.toISOString(),
      source: "real",
    });
    scoreTexts.push(text);
  }
  return { analyses, scoreTexts };
}

describe("W06-01 attack: definition-derived reference vs computePlayerRank", () => {
  it("every golden case's expected summary is reproduced by the reference implementation", () => {
    for (const goldenCase of fixture.cases) {
      const analyses = goldenCase.analyses as PlayerRankAnalysisInput[];
      const texts = analyses.map((a) =>
        typeof a.overallScore === "number" ? String(a.overallScore) : null,
      );
      const ref = referenceRank(analyses.map((a, i) => toReferenceInput(a, texts[i]!)));
      if (goldenCase.expected === null) {
        expect(ref, goldenCase.id).toBeNull();
        continue;
      }
      expect(ref, goldenCase.id).not.toBeNull();
      expect(hundredthsOf(goldenCase.expected.rating), goldenCase.id).toBe(ref!.ratingHundredths);
      expect(goldenCase.expected.tier, goldenCase.id).toBe(ref!.tier);
      expect(goldenCase.expected.scoredAnalysisCount, goldenCase.id).toBe(ref!.scoredAnalysisCount);
      expect(
        goldenCase.expected.techniques.map((t) => [t.shotType, hundredthsOf(t.score)]),
        goldenCase.id,
      ).toEqual(ref!.techniques.map((t) => [t.shotType, t.scoreHundredths]));
    }
  });

  it("agrees with the reference on 2000 seeded one-decimal histories (the scorer's output scale)", () => {
    const rand = mulberry32(0x5706_0101);
    for (let round = 0; round < 2000; round++) {
      const { analyses, scoreTexts } = randomHistory(rand, 1, 1 + Math.floor(rand() * 30));
      assertMatchesReference(analyses, scoreTexts, `seed=0x57060101 round=${round}`);
    }
  });

  it("agrees with the reference on 2000 seeded two-decimal histories (the SQL numeric(4,2) scale)", () => {
    const rand = mulberry32(0x5706_0102);
    for (let round = 0; round < 2000; round++) {
      const { analyses, scoreTexts } = randomHistory(rand, 2, 1 + Math.floor(rand() * 30));
      assertMatchesReference(analyses, scoreTexts, `seed=0x57060102 round=${round}`);
    }
  });

  it("quantizes an exact three-decimal half tie the way the definition declares (half away from zero)", () => {
    // The definition's countability admits ANY finite 0..10 score and its
    // scoreQuantization declares half-away-from-zero. Postgres numeric(4,2)
    // stores 6.005 as 6.01 (601 hundredths). The TS implementation computes
    // Math.round(6.005 * 100) = Math.round(600.4999999999999) = 600.
    const failures: string[] = [];
    for (let units = 5; units <= 10_000; units += 10) {
      const text = (units / 1000).toFixed(3);
      const analyses: PlayerRankAnalysisInput[] = [
        {
          id: "00000000-0000-4000-8000-000000000001",
          shotType: "dink",
          overallScore: Number(text),
          resultKind: "scored",
          capturedAt: "2026-08-01T00:00:00.000Z",
          source: "real",
        },
      ];
      const actual = computePlayerRank(analyses);
      const expected = referenceHundredths(text);
      if (actual === null || hundredthsOf(actual.rating) !== expected) {
        failures.push(
          `${text} -> TS ${actual?.rating ?? "null"} (definition: ${expected} hundredths)`,
        );
      }
    }
    expect(
      failures,
      `three-decimal half ties where TS != declared rounding:\n${failures.join("\n")}`,
    ).toEqual([]);
  });
});
