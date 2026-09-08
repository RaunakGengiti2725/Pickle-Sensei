/**
 * W06-01 adversarial attack — boundary values, replayed identities, clock
 * skew and tie-break identities at the edges the SQL plane cannot represent.
 *
 * Each `it` is one attack. Passing attacks document a boundary the candidate
 * holds; failing attacks are the reported breaks.
 */
import { describe, expect, it } from "vitest";
import {
  computePlayerRank,
  playerRankDivisionForRating,
  type PlayerRankAnalysisInput,
} from "../../playerRank.js";
import { SHOT_TYPES } from "../../domain.js";
import { SCORING_DEFINITION } from "../../scoringDefinition.js";

const AT = "2026-08-05T10:00:00.000Z";

function scored(
  overrides: Partial<PlayerRankAnalysisInput> & { overallScore: number | null },
): PlayerRankAnalysisInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    shotType: "dink",
    resultKind: "scored",
    capturedAt: AT,
    source: "real",
    ...overrides,
  };
}

describe("W06-01 attack: countability boundaries", () => {
  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["10 + epsilon", 10 + Number.EPSILON * 16],
    ["-0.01", -0.01],
  ])("abstains on %s (no invented Bronze)", (_label, score) => {
    expect(computePlayerRank([scored({ overallScore: score })])).toBeNull();
  });

  it("counts the inclusive floor 0 as a real Bronze III (and -0 identically)", () => {
    const zero = computePlayerRank([scored({ overallScore: 0 })]);
    const negativeZero = computePlayerRank([scored({ overallScore: -0 })]);
    expect(zero).not.toBeNull();
    expect(zero!.rating).toBe(0);
    expect(zero!.tier).toBe("bronze");
    expect(zero!.division).toBe(3);
    expect(Object.is(zero!.rating, 0)).toBe(true);
    expect(negativeZero).toEqual(zero);
    expect(Object.is(negativeZero!.rating, -0)).toBe(false);
  });

  it("counts the inclusive ceiling 10 as Diamond I with no next tier", () => {
    const top = computePlayerRank([scored({ overallScore: 10 })]);
    expect(top).toMatchObject({ rating: 10, tier: "diamond", division: 1, nextTier: null });
  });

  it("abstains on an empty shotType but NOT on a whitespace-only one", () => {
    expect(computePlayerRank([scored({ overallScore: 7, shotType: "" })])).toBeNull();
    // The definition says shotType is "non-empty"; a whitespace technique is
    // therefore a legal technique on every plane (SQL has no trim check).
    const spaces = computePlayerRank([scored({ overallScore: 7, shotType: "   " })]);
    expect(spaces?.techniques.map((t) => t.shotType)).toEqual(["   "]);
  });

  it("does not let a scored row with resultKind 'low_confidence' count even when it carries a score", () => {
    expect(
      computePlayerRank([scored({ overallScore: 9.9, resultKind: "low_confidence" })]),
    ).toBeNull();
    expect(computePlayerRank([scored({ overallScore: 9.9, resultKind: "SCORED" })])).toBeNull();
  });

  it("treats an absent source as real (the mobile RealAnalysisFact shape) and rejects every other string", () => {
    const withoutSource: PlayerRankAnalysisInput = {
      id: "00000000-0000-4000-8000-000000000001",
      shotType: "dink",
      resultKind: "scored",
      capturedAt: AT,
      overallScore: 6.3,
    };
    expect(computePlayerRank([withoutSource])?.rating).toBe(6.3);
    for (const source of ["fixture", "REAL", "Real", " real", "", "synthetic"]) {
      expect(computePlayerRank([scored({ overallScore: 6.3, source })]), source).toBeNull();
    }
  });
});

describe("W06-01 attack: clock skew and unparseable timestamps", () => {
  it("still ranks analyses stamped outside the SQL captured_at bounds (year 1999 / year 2150) — local half of the SQL parity attack", () => {
    // SQL: check shots_captured_at_bounds (>= 2000-01-01 and < 2100-01-01).
    // A device with a wildly wrong clock produces rows the local plane ranks
    // and the server plane can never ingest. The definition declares no
    // timestamp rule; the cross-plane assertion lives in
    // supabase/functions/api/__wf__/attack_w06_01_sql_golden_parity.test.ts.
    const skewed = computePlayerRank([
      scored({ overallScore: 8, capturedAt: "2150-01-01T00:00:00.000Z" }),
      scored({
        overallScore: 2,
        id: "00000000-0000-4000-8000-000000000002",
        capturedAt: "1999-12-31T23:59:59.000Z",
      }),
    ]);
    // (8·800 + 7·200) / 15 = 520 → both rows counted locally.
    expect(skewed?.rating).toBe(5.2);
    expect(skewed?.scoredAnalysisCount).toBe(2);
    expect(JSON.stringify(SCORING_DEFINITION.components.countability)).not.toContain("capturedAt");
  });

  it("treats an unparseable capturedAt as the OLDEST analysis, not as an abstention", () => {
    const garbage = computePlayerRank([
      scored({
        overallScore: 2,
        id: "00000000-0000-4000-8000-000000000009",
        capturedAt: "not-a-date",
      }),
      scored({ overallScore: 8, id: "00000000-0000-4000-8000-000000000001", capturedAt: AT }),
    ]);
    // Garbage sorts as -Infinity → weight 7; the valid row gets weight 8.
    expect(garbage?.rating).toBe(5.2);
    expect(garbage?.scoredAnalysisCount).toBe(2);
    // ...and the reported technique capturedAt is the valid one.
    expect(garbage?.techniques[0]?.capturedAt).toBe(AT);
    // A single garbage row still ranks and reports the garbage string.
    const only = computePlayerRank([scored({ overallScore: 2, capturedAt: "not-a-date" })]);
    expect(only?.techniques[0]?.capturedAt).toBe("not-a-date");
  });
});

describe("W06-01 attack: replayed / duplicate identities", () => {
  it("a replayed analysis (same id twice) must not count as two pieces of evidence", () => {
    // SQL: shots.id is the primary key — a replay is ONE row. The definition's
    // countability has no id-uniqueness rule, so the local plane counts both.
    const once = computePlayerRank([scored({ overallScore: 6.3 })]);
    const replayed = computePlayerRank([
      scored({ overallScore: 6.3 }),
      scored({ overallScore: 6.3 }),
    ]);
    expect(replayed?.rating).toBe(once?.rating);
    expect(replayed?.scoredAnalysisCount).toBe(once?.scoredAnalysisCount);
  });

  it("a replayed analysis inflates the confidence weight of its technique", () => {
    // Two techniques: dink 8.0 analysed once, serve 2.0 analysed once → 5.00.
    // Replaying the dink row once more makes dink weigh 2 → 6.00.
    const base = [
      scored({ overallScore: 8 }),
      scored({ overallScore: 2, shotType: "serve", id: "00000000-0000-4000-8000-000000000002" }),
    ];
    expect(computePlayerRank(base)?.rating).toBe(5);
    expect(computePlayerRank([...base, scored({ overallScore: 8 })])?.rating).toBe(5);
  });
});

describe("W06-01 attack: tie-break identity vs SQL uuid byte order", () => {
  it("orders same-instant ties by uuid BYTE order when ids are not canonical lowercase", () => {
    // Postgres orders uuid by bytes: F0.. > e0.. so the 'F0' row is newest.
    // JS string order: 'F' (0x46) < 'e' (0x65) so the 'e0' row is newest.
    const upper = scored({
      overallScore: 8,
      id: "F0000000-0000-4000-8000-000000000001",
    });
    const lower = scored({
      overallScore: 2,
      id: "e0000000-0000-4000-8000-000000000002",
    });
    // Byte order → F0 (8.0) newest weight 8, e0 (2.0) weight 7 → 5.20.
    expect(computePlayerRank([upper, lower])?.rating).toBe(5.2);
  });

  it("orders techniques identically under localeCompare (shared/mobile) and code-point order (Edge fallback) for every SHOT_TYPES pair (holds)", () => {
    const locale = [...SHOT_TYPES].sort((a, b) => a.localeCompare(b));
    const codePoint = [...SHOT_TYPES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(locale).toEqual(codePoint);
  });

  it("orders same-instant ties identically for canonical lowercase ids (holds)", () => {
    const a = scored({ overallScore: 8, id: "f0000000-0000-4000-8000-000000000001" });
    const b = scored({ overallScore: 2, id: "e0000000-0000-4000-8000-000000000002" });
    expect(computePlayerRank([a, b])?.rating).toBe(5.2);
    expect(computePlayerRank([b, a])?.rating).toBe(5.2);
  });
});

describe("W06-01 attack: division thirds at exact rational boundaries", () => {
  it("assigns divisions identically to exact rational thirds for every hundredth 0.00..10.00", () => {
    const tiers = SCORING_DEFINITION.components.tiers;
    const mismatches: string[] = [];
    for (let hundredths = 0; hundredths <= 1000; hundredths++) {
      const rating = hundredths / 100;
      let index = 0;
      tiers.thresholds.forEach((t, i) => {
        if (hundredths >= Math.round(t.minRating * 100)) index = i;
      });
      const floor = Math.round(tiers.thresholds[index]!.minRating * 100);
      const ceiling = Math.round(
        (tiers.thresholds[index + 1]?.minRating ?? tiers.topOfScale) * 100,
      );
      const span = ceiling - floor;
      // Exact integer thirds: fraction >= 2/3 ⇔ 3*(r - floor) >= 2*span.
      const expected =
        3 * (hundredths - floor) >= 2 * span ? 1 : 3 * (hundredths - floor) >= span ? 2 : 3;
      const actual = playerRankDivisionForRating(rating).division;
      if (actual !== expected) mismatches.push(`${rating}: TS ${actual} exact ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });
});
