/**
 * One multiset of DISTINCT analyses → one rating, whatever order the rows
 * are handed in. `recencyOrder` must be a total order over the content the
 * definition can see, so a stable sort's input order never decides which
 * row gets the heavier recency weight — including for un-synced or legacy
 * rows that carry no id.
 */
import { describe, expect, it } from "vitest";
import { computePlayerRank, type PlayerRankAnalysisInput } from "../playerRank.js";

const AT = "2026-08-01T10:00:00.000Z";

function idless(shotType: string, overallScore: number, capturedAt = AT): PlayerRankAnalysisInput {
  return { shotType, overallScore, resultKind: "scored", capturedAt, source: "real" };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

function ratings(rows: readonly PlayerRankAnalysisInput[]): number[] {
  return permutations(rows).map((permutation) => {
    const summary = computePlayerRank(permutation);
    expect(summary).not.toBeNull();
    return summary!.rating;
  });
}

describe("input-order independence for distinct id-less analyses", () => {
  it("rates two same-instant id-less rows identically from both orders", () => {
    const rows = [idless("drive", 9), idless("drive", 3)];
    expect(new Set(ratings(rows)).size).toBe(1);
  });

  it("rates three same-instant id-less rows identically from all six permutations", () => {
    const rows = [idless("drive", 9), idless("drive", 3), idless("drive", 6)];
    expect(new Set(ratings(rows)).size).toBe(1);
  });

  it("rates same-instant id-less rows with equal timestamp text and distinct scores by score", () => {
    // Higher score is 'newest' — the declared last recency key (scoreHundredths desc).
    const summary = computePlayerRank([idless("drive", 3), idless("drive", 9)]);
    expect(summary?.techniques[0]?.score).toBe(Math.round((9 * 800 + 3 * 700) / 15) / 100);
    expect(computePlayerRank([idless("drive", 9), idless("drive", 3)])).toEqual(summary);
  });

  it("keeps id-less same-instant rows of several techniques order-free", () => {
    const rows = [
      idless("drive", 9),
      idless("drive", 3),
      idless("dink", 7.25),
      idless("dink", 2.5),
      idless("serve", 5, "2026-08-01T10:00:00Z"),
      idless("serve", 8),
    ];
    const summaries = permutations(rows.slice(0, 4)).map((head) =>
      computePlayerRank([...head, ...rows.slice(4)]),
    );
    for (const summary of summaries) expect(summary).toEqual(summaries[0]);
    expect(computePlayerRank([...rows].reverse())).toEqual(summaries[0]);
  });

  it("mixes id-less and id-bearing rows at one instant without depending on input order", () => {
    const rows = [
      idless("drive", 9),
      idless("drive", 3),
      { ...idless("drive", 6), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ];
    expect(new Set(ratings(rows)).size).toBe(1);
  });
});
