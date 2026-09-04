/**
 * Adversarial pass 3 — TypeScript vs Postgres parity for computePlayerRank.
 *
 * The SQL side is produced by infra/postgres/attack3/run_player_rank_crosscheck.sh
 * (throwaway postgres:16 + every supabase migration). Point ATTACK3_PG_JSON at
 * its output; without it this file reports the cross-check as NOT RUN (it
 * fails rather than skipping so a missing artifact can never read as a pass).
 *
 *   infra/postgres/attack3/run_player_rank_crosscheck.sh /tmp/pg.json
 *   ATTACK3_PG_JSON=/tmp/pg.json pnpm --filter @pickle/shared-types exec vitest run test/attack3.playerRank.postgres
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePlayerRank,
  playerRankTierForRating,
  type PlayerRankAnalysisInput,
} from "../src/playerRank.js";

interface PgRank {
  rating: number;
  tier: string;
  technique_count: number;
  scored_shot_count: number;
}
interface PgResults {
  A_stored_score: number;
  A_rank: PgRank | null;
  A2_rpc_result: string;
  A2_stored_score: number | null;
  A2_rank: PgRank | null;
  B_rank: PgRank | null;
  C_duplicate_id: string;
  D_rank: PgRank | null;
  F_tier: Record<string, string>;
  [k: `E_${string}`]: { stored: number | "check_violation"; rank?: PgRank | null };
}

const jsonPath = process.env.ATTACK3_PG_JSON;

const base = (over: Partial<PlayerRankAnalysisInput>): PlayerRankAnalysisInput => ({
  shotType: "dink",
  overallScore: 5,
  resultKind: "scored",
  capturedAt: "2026-01-01T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  source: "real",
  ...over,
});

describe("attack3: computePlayerRank vs Postgres recompute_player_rank / player_rank_tier", () => {
  it("cross-check artifact is present (ATTACK3_PG_JSON)", () => {
    expect(
      jsonPath,
      "set ATTACK3_PG_JSON to the output of run_player_rank_crosscheck.sh",
    ).toBeTruthy();
  });

  const pg: PgResults | null = jsonPath
    ? (JSON.parse(readFileSync(jsonPath, "utf8")) as PgResults)
    : null;

  it("player_rank_tier() agrees with playerRankTierForRating at every threshold ± 0.01", () => {
    if (!pg) return expect.fail("no artifact");
    for (const [rating, tier] of Object.entries(pg.F_tier)) {
      expect(playerRankTierForRating(Number(rating)).key, `rating=${rating}`).toBe(tier);
    }
  });

  it("same captured_at, distinct ids → id desc is newest on both sides (B: 5.73, D: 5.27)", () => {
    if (!pg) return expect.fail("no artifact");
    const b = computePlayerRank([
      base({ overallScore: 2, id: "00000000-0000-4000-8000-000000000001" }),
      base({ overallScore: 9, id: "00000000-0000-4000-8000-000000000002" }),
    ])!;
    expect({ rating: b.rating, tier: b.tier, n: b.scoredAnalysisCount }).toEqual({
      rating: pg.B_rank!.rating,
      tier: pg.B_rank!.tier,
      n: pg.B_rank!.scored_shot_count,
    });
    const d = computePlayerRank([
      base({ overallScore: 2, id: "00000000-0000-4000-8000-00000000000a" }),
      base({ overallScore: 9, id: "00000000-0000-4000-8000-000000000009" }),
    ])!;
    expect({ rating: d.rating, tier: d.tier }).toEqual({
      rating: pg.D_rank!.rating,
      tier: pg.D_rank!.tier,
    });
  });

  it("duplicate id is a unique_violation at the storage layer (TS-side duplicates are corrupt input)", () => {
    if (!pg) return expect.fail("no artifact");
    expect(pg.C_duplicate_id).toBe("unique_violation");
  });

  it("overallScore 10.0000001: TS excludes it — Postgres must not silently rank it as 10.00", () => {
    if (!pg) return expect.fail("no artifact");
    const ts = computePlayerRank([base({ overallScore: 10.0000001 })]);
    expect(ts).toBeNull();
    // Parity: if TS says "unranked", SQL must too (or reject the row).
    expect(
      {
        direct_insert: pg.A_rank,
        rpc: pg.A2_rpc_result,
        rpc_stored: pg.A2_stored_score,
        rpc_rank: pg.A2_rank,
      },
      "SQL accepted an out-of-contract score TS excludes",
    ).toEqual({
      direct_insert: null,
      rpc: expect.not.stringMatching(/^accepted$/),
      rpc_stored: null,
      rpc_rank: null,
    });
  });

  it("numeric(4,2) rounding at the 10 boundary matches TS hundredths rounding for in-contract scores", () => {
    if (!pg) return expect.fail("no artifact");
    const mismatches: Record<string, { ts: number; sql: number | undefined }> = {};
    for (const s of [9.994, 9.995, 9.999]) {
      const row = pg[`E_${s}`];
      const ts = computePlayerRank([base({ overallScore: s })])!;
      if (row.rank?.rating !== ts.rating)
        mismatches[String(s)] = { ts: ts.rating, sql: row.rank?.rating };
    }
    // Math.round(9.995 * 100) === 999 (binary float 999.4999…) while numeric(4,2) stores 10.00.
    expect(mismatches, "TS hundredths rounding diverges from numeric(4,2)").toEqual({});
    // 10.004 is out of contract in TS (excluded) but rounds INTO contract in SQL.
    expect(computePlayerRank([base({ overallScore: 10.004 })])).toBeNull();
    expect(pg["E_10.004"].rank, "SQL ranked 10.004 as 10.00 while TS excludes it").toBeNull();
    expect(pg["E_10.005"].stored).toBe("check_violation");
  });
});
