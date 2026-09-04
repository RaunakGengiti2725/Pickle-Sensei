/**
 * Adversarial pass 3 — player rank tie-breaks and boundary exclusion.
 *
 * (1) Two analyses sharing capturedAt AND id (a corrupt/duplicated row) must
 *     still produce a deterministic, order-independent rank.
 * (2) overallScore 10.0000001 is out of the 0-10 contract and must be
 *     excluded from the rank (never rounded into a 10.00).
 * (3) TS vs Postgres parity for scores near the numeric(4,2) boundary is
 *     cross-checked separately in attack3.playerRank.postgres.mjs.
 */
import { describe, expect, it } from "vitest";
import { computePlayerRank, type PlayerRankAnalysisInput } from "../src/playerRank.js";

const base = (over: Partial<PlayerRankAnalysisInput>): PlayerRankAnalysisInput => ({
  shotType: "dink",
  overallScore: 5,
  resultKind: "scored",
  capturedAt: "2026-01-01T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  source: "real",
  ...over,
});

describe("attack3: computePlayerRank duplicate (capturedAt, id) pairs", () => {
  it("two analyses with identical capturedAt and id but different scores rank order-independently", () => {
    const a = base({ overallScore: 2 });
    const b = base({ overallScore: 9 });
    const forward = computePlayerRank([a, b])!;
    const reversed = computePlayerRank([b, a])!;
    expect(forward).toEqual(reversed);
  });

  it("fully identical duplicates count twice (scoredAnalysisCount) and average to themselves", () => {
    const a = base({ overallScore: 7 });
    const rank = computePlayerRank([a, { ...a }])!;
    expect(rank.scoredAnalysisCount).toBe(2);
    expect(rank.techniques[0]!.score).toBe(7);
    expect(rank.techniques[0]!.sampledCount).toBe(2);
  });

  it("three-way identical (capturedAt,id) with different scores is order-independent across all permutations", () => {
    const xs = [base({ overallScore: 1 }), base({ overallScore: 5 }), base({ overallScore: 9 })];
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((p) => computePlayerRank(p.map((i) => xs[i]!))!.rating);
    expect(new Set(perms).size, `ratings per permutation: ${JSON.stringify(perms)}`).toBe(1);
  });
});

describe("attack3: overallScore 10.0000001 boundary", () => {
  it("is excluded (not rounded to 10.00)", () => {
    const rank = computePlayerRank([base({ overallScore: 10.0000001 })]);
    expect(rank).toBeNull();
  });

  it("excluded row does not inflate scoredAnalysisCount beside a valid one", () => {
    const rank = computePlayerRank([
      base({ overallScore: 10.0000001, id: "00000000-0000-4000-8000-000000000002" }),
      base({ overallScore: 6 }),
    ])!;
    expect(rank.scoredAnalysisCount).toBe(1);
    expect(rank.rating).toBe(6);
  });

  it("-0.0000001 is excluded; exactly 10 and exactly 0 are included", () => {
    expect(computePlayerRank([base({ overallScore: -0.0000001 })])).toBeNull();
    expect(computePlayerRank([base({ overallScore: 10 })])!.rating).toBe(10);
    expect(computePlayerRank([base({ overallScore: 0 })])!.rating).toBe(0);
  });

  it("id tie-break: identical capturedAt, distinct ids → id desc is newest (matches SQL order by id desc)", () => {
    const older = base({ overallScore: 2, id: "00000000-0000-4000-8000-000000000001" });
    const newer = base({ overallScore: 9, id: "00000000-0000-4000-8000-000000000002" });
    // newest weight 8, older 7 → (8*900 + 7*200)/15 = 573.33 → 5.73
    const rank = computePlayerRank([older, newer])!;
    expect(rank.techniques[0]!.score).toBe(5.73);
    expect(computePlayerRank([newer, older])!).toEqual(rank);
  });

  it("uppercase vs lowercase uuid text tie-break is NOT byte-order equivalent (documenting the assumption)", () => {
    // Postgres uuid ordering is byte order; TS compares strings. Canonical
    // lowercase ids are assumed. Mixed case would diverge: 'A' < 'a'.
    const a = base({ overallScore: 2, id: "00000000-0000-4000-8000-00000000000A" });
    const b = base({ overallScore: 9, id: "00000000-0000-4000-8000-000000000009" });
    const rank = computePlayerRank([a, b])!;
    // Byte order: 0x0a > 0x09 → 'A' row is newest → (8*200 + 7*900)/15 = 526.67 → 5.27
    expect(rank.techniques[0]!.score).toBe(5.27);
  });
});
