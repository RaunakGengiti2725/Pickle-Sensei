import { describe, expect, it } from "vitest";
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  playerRankDivisionForRating,
  playerRankTierForRating,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
  type PlayerRankAnalysisInput,
} from "../src/playerRank.js";

function scored(
  shotType: string,
  overallScore: number,
  capturedAt: string,
  extra: Partial<PlayerRankAnalysisInput> = {},
): PlayerRankAnalysisInput {
  return { shotType, overallScore, resultKind: "scored", capturedAt, ...extra };
}

function day(n: number): string {
  return `2026-08-${String(n).padStart(2, "0")}T10:00:00.000Z`;
}

describe("playerRankTierForRating", () => {
  it("maps thresholds inclusively at each tier floor", () => {
    expect(playerRankTierForRating(0).key).toBe("bronze");
    expect(playerRankTierForRating(3.49).key).toBe("bronze");
    expect(playerRankTierForRating(3.5).key).toBe("silver");
    expect(playerRankTierForRating(4.99).key).toBe("silver");
    expect(playerRankTierForRating(5).key).toBe("gold");
    expect(playerRankTierForRating(6.49).key).toBe("gold");
    expect(playerRankTierForRating(6.5).key).toBe("platinum");
    expect(playerRankTierForRating(7.49).key).toBe("platinum");
    expect(playerRankTierForRating(7.5).key).toBe("diamond");
    expect(playerRankTierForRating(10).key).toBe("diamond");
  });

  it("tiers ascend monotonically and start at 0", () => {
    expect(PLAYER_RANK_TIERS[0].minRating).toBe(0);
    for (let i = 1; i < PLAYER_RANK_TIERS.length; i++) {
      expect(PLAYER_RANK_TIERS[i].minRating).toBeGreaterThan(PLAYER_RANK_TIERS[i - 1].minRating);
    }
  });
});

describe("playerRankDivisionForRating", () => {
  it("splits each tier band into thirds: III at the floor, I at the top", () => {
    expect(playerRankDivisionForRating(0.5)).toEqual({
      division: 3,
      label: "III",
    });
    expect(playerRankDivisionForRating(1.75)).toEqual({
      division: 2,
      label: "II",
    });
    expect(playerRankDivisionForRating(3.0)).toEqual({
      division: 1,
      label: "I",
    });
    // Gold band 5-6.5.
    expect(playerRankDivisionForRating(5.1).label).toBe("III");
    expect(playerRankDivisionForRating(5.6).label).toBe("II");
    expect(playerRankDivisionForRating(6.2).label).toBe("I");
    // Diamond band 7.5-10, including the perfect 10.
    expect(playerRankDivisionForRating(7.6).label).toBe("III");
    expect(playerRankDivisionForRating(8.4).label).toBe("II");
    expect(playerRankDivisionForRating(9.2).label).toBe("I");
    expect(playerRankDivisionForRating(10).label).toBe("I");
  });
});

describe("computePlayerRank", () => {
  it("returns null when nothing scored exists — never a fabricated rank", () => {
    expect(computePlayerRank([])).toBeNull();
    expect(
      computePlayerRank([
        {
          shotType: "dink",
          overallScore: null,
          resultKind: "low_confidence",
          capturedAt: day(1),
        },
      ]),
    ).toBeNull();
  });

  it("single-analysis techniques behave like plain averages (placement walk)", () => {
    const forehand = scored("forehand_drive", 8, day(1));
    const first = computePlayerRank([forehand])!;
    expect(first.rating).toBe(8);
    expect(first.tier).toBe("diamond");

    const overhead = scored("overhead", 6.5, day(2));
    const second = computePlayerRank([forehand, overhead])!;
    // Both techniques have one analysis → equal confidence 1 each.
    expect(second.rating).toBe(7.25);
    expect(second.tier).toBe("platinum");

    const backhand = scored("backhand_drive", 9, day(3));
    const third = computePlayerRank([forehand, overhead, backhand])!;
    expect(third.rating).toBe(7.83);
    expect(third.tier).toBe("diamond");
    expect(third.division).toBe(3);
    expect(third.divisionLabel).toBe("III");
  });

  it("weights a technique's recent analyses highest (current form)", () => {
    const rank = computePlayerRank([
      scored("dink", 3, day(1)),
      scored("dink", 6, day(5)),
      scored("dink", 4.5, day(3)),
    ])!;
    // Newest first: 6 (w8), 4.5 (w7), 3 (w6) →
    // (8·600 + 7·450 + 6·300) / 21 = 9750 / 21 = 464.28… → 4.64.
    expect(rank.rating).toBe(4.64);
    expect(rank.techniqueCount).toBe(1);
    expect(rank.scoredAnalysisCount).toBe(3);
    expect(rank.techniques).toEqual([
      {
        shotType: "dink",
        score: 4.64,
        capturedAt: day(5),
        sampledCount: 3,
      },
    ]);
  });

  it("lets recent improvement lead without erasing history", () => {
    const rank = computePlayerRank([
      scored("dink", 4, day(1)),
      scored("dink", 4, day(2)),
      scored("dink", 4, day(3)),
      scored("dink", 8, day(4)),
      scored("dink", 8, day(5)),
    ])!;
    // (8·800 + 7·800 + 6·400 + 5·400 + 4·400) / 30 = 18000 / 30 = 6.00 —
    // ahead of the lifetime average (5.6) because current form leads, but
    // the older 4s still hold it under a straight recent-two average (8).
    expect(rank.rating).toBe(6);
    const lifetimeAverage = (4 + 4 + 4 + 8 + 8) / 5;
    expect(rank.rating).toBeGreaterThan(lifetimeAverage);
    expect(rank.rating).toBeLessThan(8);
  });

  it("keeps only the freshest RANK_FORM_WINDOW analyses in a technique's form", () => {
    const inputs = Array.from({ length: 9 }, (_, i) => scored("dink", i + 1, day(i + 1)));
    const rank = computePlayerRank(inputs)!;
    // Newest first 9..2 (the oldest score, 1, falls outside the window):
    // (8·900+7·800+6·700+5·600+4·500+3·400+2·300+1·200)/36 = 24000/36 → 6.67.
    expect(rank.rating).toBe(6.67);
    expect(rank.techniques[0].sampledCount).toBe(RANK_FORM_WINDOW);
    expect(rank.scoredAnalysisCount).toBe(9);
  });

  it("caps a technique's rating influence by evidence (confidence weight)", () => {
    const provenDink = Array.from({ length: RANK_CONFIDENCE_CAP }, (_, i) =>
      scored("dink", 6, day(i + 1)),
    );
    const luckyServe = scored("serve", 10, day(6));
    const rank = computePlayerRank([...provenDink, luckyServe])!;
    // dink 6.00 with confidence 5, serve 10.00 with confidence 1 →
    // (5·600 + 1·1000) / 6 = 666.67 → 6.67, not the naive (6+10)/2 = 8.
    expect(rank.rating).toBe(6.67);
    expect(rank.tier).toBe("platinum");
  });

  it("is order-independent", () => {
    const inputs = [
      scored("serve", 5.2, day(1)),
      scored("dink", 7.8, day(2)),
      scored("serve", 6.1, day(3)),
    ];
    const forward = computePlayerRank(inputs)!;
    const reversed = computePlayerRank([...inputs].reverse())!;
    expect(forward).toEqual(reversed);
    // serve: (8·610 + 7·520) / 15 = 8520 / 15 = 568 → 5.68 (confidence 2);
    // dink 7.80 (confidence 1); rating (2·568 + 1·780) / 3 = 638.67 → 6.39.
    expect(forward.techniques.map((t) => t.score)).toEqual([7.8, 5.68]);
    expect(forward.rating).toBe(6.39);
  });

  it("skips abstentions, fixtures, and out-of-range scores", () => {
    const rank = computePlayerRank([
      scored("dink", 6, day(1)),
      {
        shotType: "dink",
        overallScore: null,
        resultKind: "low_confidence",
        capturedAt: day(9),
      },
      scored("serve", 9, day(2), { source: "fixture" }),
      scored("volley", 42, day(2)),
      scored("overhead", Number.NaN, day(2)),
    ])!;
    expect(rank.techniqueCount).toBe(1);
    expect(rank.rating).toBe(6);
    expect(rank.scoredAnalysisCount).toBe(1);
  });

  it("rounds each technique score to 2 decimals BEFORE the rating stage", () => {
    const rank = computePlayerRank([
      scored("serve", 7.9, day(1)),
      scored("serve", 7.9, day(2)),
      scored("serve", 7.8, day(3)),
      scored("dink", 6, day(4)),
    ])!;
    // serve newest first 7.8, 7.9, 7.9 → (8·780+7·790+6·790)/21 =
    // 16510/21 = 786.19 → 7.86 (confidence 3); dink 6.00 (confidence 1);
    // rating (3·786 + 1·600)/4 = 2958/4 = 739.5 → half away from zero → 7.40.
    expect(rank.techniques.map((t) => t.score)).toEqual([7.86, 6]);
    expect(rank.rating).toBe(7.4);
    expect(rank.tier).toBe("platinum");
    expect(rank.nextTier).toEqual({
      key: "diamond",
      label: "Diamond",
      minRating: 7.5,
      pointsNeeded: 0.1,
    });
  });

  it("rounds half away from zero to 2 decimals, matching Postgres round()", () => {
    const rank = computePlayerRank([
      scored("serve", 8, day(1)),
      scored("return", 7.9, day(1)),
      scored("dink", 7.6, day(1)),
      scored("volley", 7, day(1)),
    ])!;
    // Four single-analysis techniques → (800+790+760+700)/4 = 762.5 → 7.63.
    expect(rank.rating).toBe(7.63);
    expect(rank.tier).toBe("diamond");
  });

  it("breaks identical-timestamp recency ties by id, order-independently", () => {
    const at = day(1);
    const inputs = [
      scored("dink", 4, at, { id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      scored("dink", 9, at, { id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ];
    const rank = computePlayerRank(inputs)!;
    // id desc → the 9 is "newest": (8·900 + 7·400)/15 = 10000/15 → 6.67.
    expect(rank.rating).toBe(6.67);
    expect(rank.techniques[0].capturedAt).toBe(at);
    expect(computePlayerRank([...inputs].reverse())!).toEqual(rank);
  });

  it("reports the next tier with the points needed to reach it", () => {
    const rank = computePlayerRank([scored("dink", 7, day(1))])!;
    expect(rank.tier).toBe("platinum");
    expect(rank.nextTier).toEqual({
      key: "diamond",
      label: "Diamond",
      minRating: 7.5,
      pointsNeeded: 0.5,
    });

    const top = computePlayerRank([scored("dink", 9.5, day(1))])!;
    expect(top.tier).toBe("diamond");
    expect(top.division).toBe(1);
    expect(top.nextTier).toBeNull();
  });

  it("orders technique contributions by score, then shot type", () => {
    const rank = computePlayerRank([
      scored("serve", 6, day(1)),
      scored("dink", 8, day(1)),
      scored("volley", 6, day(1)),
    ])!;
    expect(rank.techniques.map((t) => t.shotType)).toEqual(["dink", "serve", "volley"]);
  });
});
