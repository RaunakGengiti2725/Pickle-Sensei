import { describe, expect, it } from "vitest";
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  playerRankTierForRating,
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
      expect(PLAYER_RANK_TIERS[i].minRating).toBeGreaterThan(
        PLAYER_RANK_TIERS[i - 1].minRating,
      );
    }
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
          capturedAt: "2026-08-01T10:00:00.000Z",
        },
      ]),
    ).toBeNull();
  });

  it("walks the user's own example: 8.0 → Diamond, +6.5 → averages down, +9.0 → Diamond again", () => {
    const forehand = scored("forehand_drive", 8, "2026-08-01T10:00:00.000Z");
    const first = computePlayerRank([forehand])!;
    expect(first.rating).toBe(8);
    expect(first.tier).toBe("diamond");

    const overhead = scored("overhead", 6.5, "2026-08-02T10:00:00.000Z");
    const second = computePlayerRank([forehand, overhead])!;
    expect(second.rating).toBe(7.25);
    expect(second.tier).toBe("platinum");

    const backhand = scored("backhand_drive", 9, "2026-08-03T10:00:00.000Z");
    const third = computePlayerRank([forehand, overhead, backhand])!;
    expect(third.rating).toBe(7.83);
    expect(third.tier).toBe("diamond");
  });

  it("uses only the LATEST scored analysis per technique", () => {
    const rank = computePlayerRank([
      scored("dink", 3, "2026-08-01T10:00:00.000Z"),
      scored("dink", 6, "2026-08-05T10:00:00.000Z"),
      scored("dink", 4.5, "2026-08-03T10:00:00.000Z"),
    ])!;
    expect(rank.rating).toBe(6);
    expect(rank.techniqueCount).toBe(1);
    expect(rank.scoredAnalysisCount).toBe(3);
    expect(rank.techniques).toEqual([
      {
        shotType: "dink",
        score: 6,
        capturedAt: "2026-08-05T10:00:00.000Z",
      },
    ]);
  });

  it("is order-independent", () => {
    const inputs = [
      scored("serve", 5.2, "2026-08-01T10:00:00.000Z"),
      scored("dink", 7.8, "2026-08-02T10:00:00.000Z"),
      scored("serve", 6.1, "2026-08-03T10:00:00.000Z"),
    ];
    const forward = computePlayerRank(inputs)!;
    const reversed = computePlayerRank([...inputs].reverse())!;
    expect(forward).toEqual(reversed);
    expect(forward.rating).toBe(6.95);
  });

  it("skips abstentions, fixtures, and out-of-range scores", () => {
    const rank = computePlayerRank([
      scored("dink", 6, "2026-08-01T10:00:00.000Z"),
      {
        shotType: "dink",
        overallScore: null,
        resultKind: "low_confidence",
        capturedAt: "2026-08-09T10:00:00.000Z",
      },
      scored("serve", 9, "2026-08-02T10:00:00.000Z", { source: "fixture" }),
      scored("volley", 42, "2026-08-02T10:00:00.000Z"),
      scored("overhead", Number.NaN, "2026-08-02T10:00:00.000Z"),
    ])!;
    expect(rank.techniqueCount).toBe(1);
    expect(rank.rating).toBe(6);
    expect(rank.scoredAnalysisCount).toBe(1);
  });

  it("rounds half away from zero to 2 decimals, matching Postgres round()", () => {
    const rank = computePlayerRank([
      scored("serve", 8, "2026-08-01T10:00:00.000Z"),
      scored("return", 7.9, "2026-08-01T11:00:00.000Z"),
      scored("dink", 7.6, "2026-08-01T12:00:00.000Z"),
      scored("volley", 7, "2026-08-01T13:00:00.000Z"),
    ])!;
    // (8 + 7.9 + 7.6 + 7) / 4 = 7.625 → 7.63
    expect(rank.rating).toBe(7.63);
    expect(rank.tier).toBe("diamond");
  });

  it("breaks identical timestamps deterministically by id, matching the SQL view", () => {
    const at = "2026-08-01T10:00:00.000Z";
    const rank = computePlayerRank([
      scored("dink", 4, at, { id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      scored("dink", 9, at, { id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ])!;
    expect(rank.rating).toBe(9);
  });

  it("reports the next tier with the points needed to reach it", () => {
    const rank = computePlayerRank([
      scored("dink", 7, "2026-08-01T10:00:00.000Z"),
    ])!;
    expect(rank.tier).toBe("platinum");
    expect(rank.nextTier).toEqual({
      key: "diamond",
      label: "Diamond",
      minRating: 7.5,
      pointsNeeded: 0.5,
    });

    const top = computePlayerRank([
      scored("dink", 9.5, "2026-08-01T10:00:00.000Z"),
    ])!;
    expect(top.tier).toBe("diamond");
    expect(top.nextTier).toBeNull();
  });

  it("orders technique contributions by score, then shot type", () => {
    const rank = computePlayerRank([
      scored("serve", 6, "2026-08-01T10:00:00.000Z"),
      scored("dink", 8, "2026-08-01T11:00:00.000Z"),
      scored("volley", 6, "2026-08-01T12:00:00.000Z"),
    ])!;
    expect(rank.techniques.map((t) => t.shotType)).toEqual([
      "dink",
      "serve",
      "volley",
    ]);
  });
});
