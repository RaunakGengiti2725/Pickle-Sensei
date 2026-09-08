/**
 * W06-01 adversarial attack — does the golden fixture actually PIN every rule
 * the definition declares?
 *
 * AC2 says "golden fixtures pin the definition version". A fixture pins a
 * rule only if some case would change its `expected` when that rule is
 * mutated. Each assertion below names one declared rule and requires at
 * least one case that exercises it. Failures were confirmed by mutation
 * (see attack report): the mutated implementation passes all 34 candidate
 * tests when the corresponding assertion here fails.
 */
import { describe, expect, it } from "vitest";
import golden from "../../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import { SCORING_DEFINITION, type PlayerRankGoldenFixture } from "../../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const D = SCORING_DEFINITION.components;

const allAnalyses = fixture.cases.flatMap((c) => c.analyses.map((a) => ({ caseId: c.id, ...a })));
const rankedCases = fixture.cases.filter((c) => c.expected !== null);

function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe("W06-01 attack: golden fixture coverage of declared rules", () => {
  it("countability.absentSourceCountsAs: some RANKED case has an analysis with no `source` (the mobile RealAnalysisFact shape)", () => {
    expect(D.countability.absentSourceCountsAs).toBe("real");
    const absent = rankedCases.filter((c) => c.analyses.some((a) => !("source" in a)));
    expect(absent.map((c) => c.id)).not.toEqual([]);
  });

  it("countability.overallScore.min is inclusive: some ranked case scores exactly 0", () => {
    expect(D.countability.overallScore.min).toBe(0);
    const zero = allAnalyses.filter((a) => a.overallScore === 0 && a.resultKind === "scored");
    expect(zero.map((a) => a.caseId)).not.toEqual([]);
  });

  it("countability.resultKind beats the score: some case has a non-scored resultKind WITH a numeric score", () => {
    const scoredButAbstained = allAnalyses.filter(
      (a) => a.resultKind !== D.countability.resultKind && typeof a.overallScore === "number",
    );
    expect(scoredButAbstained.map((a) => a.caseId)).not.toEqual([]);
  });

  it("scoreQuantization.rounding is exercised: some countable score has more decimals than the hundredths unit", () => {
    const needsRounding = allAnalyses.filter(
      (a) => typeof a.overallScore === "number" && decimals(a.overallScore) > 2,
    );
    expect(needsRounding.map((a) => `${a.caseId}:${a.overallScore}`)).not.toEqual([]);
  });

  it("recencyOrder key #3 (capturedAtText) is exercised: some case has same-instant rows without ids", () => {
    const thirdKey = D.recencyOrder.keys[2];
    expect(thirdKey?.field).toBe("capturedAtText");
    const withoutIds = rankedCases.filter((c) => c.analyses.some((a) => !("id" in a)));
    expect(withoutIds.map((c) => c.id)).not.toEqual([]);
  });

  it("recencyOrder key #1 vs #3: some case has two DIFFERENT capturedAt strings for the same instant", () => {
    const sameInstantDifferentText = rankedCases.filter((c) => {
      const byInstant = new Map<number, Set<string>>();
      for (const a of c.analyses) {
        const t = Date.parse(a.capturedAt);
        const set = byInstant.get(t) ?? new Set<string>();
        set.add(a.capturedAt);
        byInstant.set(t, set);
      }
      return [...byInstant.values()].some((set) => set.size > 1);
    });
    expect(sameInstantDifferentText.map((c) => c.id)).not.toEqual([]);
  });

  it("tiers.divisions: every division boundary (1/3 and 2/3 of a band) is pinned on both sides", () => {
    // A division mutation (e.g. 2/3 → 0.7) is caught only if some ranked
    // case has a within-band fraction in (2/3, 0.7]; likewise for 1/3.
    const fractions = rankedCases.map((c) => {
      const rating = c.expected!.rating;
      let index = 0;
      D.tiers.thresholds.forEach((t, i) => {
        if (rating >= t.minRating) index = i;
      });
      const floor = D.tiers.thresholds[index]!.minRating;
      const ceiling = D.tiers.thresholds[index + 1]?.minRating ?? D.tiers.topOfScale;
      return (rating - floor) / (ceiling - floor);
    });
    const near = (target: number) => fractions.some((f) => f >= target && f < target + 0.05);
    expect({ nearOneThird: near(1 / 3), nearTwoThirds: near(2 / 3) }).toEqual({
      nearOneThird: true,
      nearTwoThirds: true,
    });
  });

  it("the implementer summary's 'NaN abstention' case exists in the fixture", () => {
    // JSON cannot encode NaN; the summary claims the fixture covers it.
    const nanRows = golden.cases.flatMap((c) =>
      c.analyses.filter((a) => typeof a.overallScore === "number" && Number.isNaN(a.overallScore)),
    );
    expect(nanRows.length, "fixture rows whose overallScore is NaN").toBeGreaterThan(0);
  });
});
