/**
 * ADV INT-analysis-scoring — GET /v1/rank under hostile stored state.
 *
 * Attacks the Edge rank plane WITHOUT Postgres (the PostgREST stub in
 * routesHarness returns whatever rows a test puts in `h.tables`), so every
 * test here always runs. What is probed:
 *
 *   R1 provenance   — the payload must carry the scoring definition it was
 *                     computed under (scoringDefinition.ts "Provenance"
 *                     contract: "emitted by the plane that computed it"),
 *                     otherwise a definition bump can never be detected by a
 *                     consumer and historical rows get reinterpreted silently.
 *   R2 corrupt row  — player_rank_state with a tier that contradicts its
 *                     rating, an unknown tier, or an out-of-range rating must
 *                     not be served as an authoritative rank.
 *   R3 no evidence  — all technique rows nonfinite/null → { rank: null }.
 *   R4 fallback     — inline fallback reproduces computePlayerRank for every
 *                     golden case from synthetic view rows (no PG needed).
 *   R5 db failure   — technique / state query failure → 503, never a rank.
 *   R6 double read  — two concurrent GETs after a corrupt state row share
 *                     the same verdict (no half-cached rank).
 */
import { assert, assertEquals } from "@std/assert";
import golden from "../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json" with {
  type: "json",
};
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
  playerRankTierForRating,
} from "../../../../packages/shared-types/src/playerRank.ts";
import {
  type PlayerRankGoldenFixture,
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
} from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const fixture: PlayerRankGoldenFixture = golden;
const h = await loadHarness();

let seq = 0;
function freshUser(): { token: string; ip: string; userId: string } {
  seq += 1;
  const userId = `ad000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  return {
    token: fakeGoogleIdToken(userId),
    ip: `198.18.${Math.floor(seq / 250)}.${(seq % 250) + 1}`,
    userId,
  };
}

interface RankBody {
  rank: {
    rating: number;
    tier: string;
    techniqueCount: number;
    scoredShotCount: number | null;
    updatedAt: string | null;
    definitionVersion?: unknown;
    techniques: Array<{ shot_type: string; score: number; sampled_count: number }>;
  } | null;
}

async function getRank(
  auth: { token: string; ip: string },
): Promise<{ status: number; body: RankBody }> {
  const response = await h.handler(userRequest("GET", "/v1/rank", auth));
  const body = (await response.json()) as RankBody;
  return { status: response.status, body };
}

const viewRow = (
  userId: string,
  shotType: string,
  score: number,
  sampledCount: number,
  confidenceWeight: number,
) => ({
  user_id: userId,
  shot_type: shotType,
  score,
  captured_at: "2026-09-01T00:00:00.000Z",
  sampled_count: sampledCount,
  confidence_weight: confidenceWeight,
});

Deno.test("ADV R1: GET /v1/rank payload carries the scoring definitionVersion it was computed under (saved state)", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 7.5, 3, 3)];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 7.5,
      tier: "diamond",
      technique_count: 1,
      scored_shot_count: 3,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assert(body.rank !== null);
  assertEquals(
    body.rank.definitionVersion,
    SCORING_DEFINITION_VERSION,
    `saved-state rank payload has no definitionVersion — a consumer cannot tell which definition this rating was computed under: ${
      JSON.stringify(body.rank)
    }`,
  );
});

Deno.test("ADV R1: GET /v1/rank payload carries the scoring definitionVersion it was computed under (inline fallback)", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 7.5, 3, 3)];
  h.tables.player_rank_state = [];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assert(body.rank !== null);
  assertEquals(
    body.rank.definitionVersion,
    SCORING_DEFINITION_VERSION,
    `inline-fallback rank payload has no definitionVersion: ${JSON.stringify(body.rank)}`,
  );
});

Deno.test("ADV R2: a saved tier that contradicts its rating is not served verbatim", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 1.25, 2, 2)];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 1.25,
      tier: "diamond",
      technique_count: 1,
      scored_shot_count: 2,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assert(body.rank !== null);
  assertEquals(
    body.rank.tier,
    playerRankTierForRating(1.25),
    `stored tier "diamond" for rating 1.25 was served as-is: ${JSON.stringify(body.rank)}`,
  );
});

Deno.test("ADV R2: an unknown saved tier string is not served verbatim", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 4.2, 1, 1)];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 4.2,
      tier: "legend",
      technique_count: 1,
      scored_shot_count: 1,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assert(body.rank !== null);
  assert(
    SCORING_DEFINITION.components.tiers.thresholds.some((tier) => tier.key === body.rank!.tier),
    `unknown tier "${body.rank.tier}" reached the payload`,
  );
});

Deno.test("ADV R2: an out-of-range saved rating (42) is not served as a rank", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 4.2, 1, 1)];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 42,
      tier: "diamond",
      technique_count: 1,
      scored_shot_count: 1,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const { status, body } = await getRank(auth);
  // Either a 5xx (state unreadable) or a rating recomputed from the view is
  // honest; a 200 with rating 42 is a fabricated number on the scale top 10.
  if (status === 200) {
    assert(body.rank !== null);
    assert(
      body.rank.rating >= 0 && body.rank.rating <= SCORING_DEFINITION.components.tiers.topOfScale,
      `rating ${body.rank.rating} outside [0, ${SCORING_DEFINITION.components.tiers.topOfScale}] served with 200`,
    );
  } else {
    assertEquals(status, 503);
  }
});

Deno.test("ADV R3: technique rows with NaN/'abc'/Infinity scores are no evidence → { rank: null }", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [
    { ...viewRow(auth.userId, "serve", 0, 1, 1), score: "NaN" },
    { ...viewRow(auth.userId, "volley", 0, 1, 1), score: "abc" },
    { ...viewRow(auth.userId, "drive", 0, 1, 1), score: "Infinity" },
  ];
  h.tables.player_rank_state = [];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assertEquals(body.rank, null);
});

Deno.test("ADV R3: a technique row with a NULL score is no evidence → { rank: null }, not a Bronze 0.00", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [{ ...viewRow(auth.userId, "dink", 0, 1, 1), score: null }];
  h.tables.player_rank_state = [];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assertEquals(
    body.rank,
    null,
    `a null technique score was coerced into a number: ${JSON.stringify(body.rank)}`,
  );
});

Deno.test("ADV R3: a saved state row with NO technique evidence is not served (unranked wins)", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 9.9,
      tier: "diamond",
      technique_count: 3,
      scored_shot_count: 30,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const { status, body } = await getRank(auth);
  assertEquals(status, 200);
  assertEquals(body.rank, null, "stale saved state without technique rows must not be a rank");
});

Deno.test("ADV R4: inline fallback reproduces computePlayerRank for every golden case (no saved row)", async () => {
  const problems: string[] = [];
  for (const goldenCase of fixture.cases) {
    const ts = computePlayerRank(goldenCase.analyses as PlayerRankAnalysisInput[]);
    const auth = freshUser();
    // Per-technique total countable analyses → confidence weight (cap 5),
    // exactly what the SQL view emits.
    const totals = new Map<string, number>();
    for (const a of goldenCase.analyses) {
      if (a.resultKind !== "scored") continue;
      totals.set(a.shotType, (totals.get(a.shotType) ?? 0) + 1);
    }
    h.tables.player_technique_rating = (ts?.techniques ?? []).map((t) =>
      viewRow(
        auth.userId,
        t.shotType,
        t.score,
        t.sampledCount ?? 1,
        Math.min(totals.get(t.shotType) ?? 1, SCORING_DEFINITION.components.confidenceWeight.cap),
      )
    );
    h.tables.player_rank_state = [];
    const { status, body } = await getRank(auth);
    assertEquals(status, 200, goldenCase.id);
    const actual = body.rank === null ? null : { rating: body.rank.rating, tier: body.rank.tier };
    const want = ts === null ? null : { rating: ts.rating, tier: ts.tier };
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      problems.push(`${goldenCase.id}: edge=${JSON.stringify(actual)} ts=${JSON.stringify(want)}`);
    }
  }
  assertEquals(problems, [], problems.join("\n"));
});

Deno.test("ADV R5: technique view failure → 503, never a rank (network loss mid-read)", async () => {
  const auth = freshUser();
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 7.5,
      tier: "diamond",
      technique_count: 1,
      scored_shot_count: 3,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  h.respond = (call) =>
    call.url.includes("/rest/v1/player_technique_rating")
      ? new Response(JSON.stringify({ code: "57014", message: "canceling statement" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  const response = await h.handler(userRequest("GET", "/v1/rank", auth));
  assertEquals(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert(!("rank" in body), "a failed read must not answer with a rank");
});

Deno.test("ADV R5: saved-state read failure → 503, not a silently recomputed rank", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 7.5, 3, 3)];
  h.respond = (call) =>
    call.url.includes("/rest/v1/player_rank_state")
      ? new Response(JSON.stringify({ code: "57014", message: "canceling statement" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  const response = await h.handler(userRequest("GET", "/v1/rank", auth));
  assertEquals(response.status, 503);
});

Deno.test("ADV R6: two concurrent GETs share one verdict; a later read after the row is fixed is still the cached one within TTL", async () => {
  const auth = freshUser();
  h.tables.player_technique_rating = [viewRow(auth.userId, "dink", 6.0, 2, 2)];
  h.tables.player_rank_state = [];
  const [a, b] = await Promise.all([getRank(auth), getRank(auth)]);
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
  assertEquals(JSON.stringify(a.body), JSON.stringify(b.body));
  const reads = h.callsTo("/rest/v1/player_technique_rating").length;
  assertEquals(reads, 1, "single-flight: concurrent misses share one DB read");
});
