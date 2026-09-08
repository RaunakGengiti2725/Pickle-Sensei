/**
 * W06-02 adversary — corrupt / partial persisted state through the REAL
 * handler (routesHarness stubs PostgREST; the route code is the candidate's).
 *
 * The objective says GET /v1/rank computes "through the shared definition"
 * and tags the response with the definition version. The invariant under
 * attack: any payload tagged `definitionVersion = rank-form-weighted-v2` MUST
 * be a summary that definition can produce —
 *   • rating finite, quantised to hundredths, inside [tiers[0].minRating, 10]
 *   • tier == the ladder's tier for that rating, and a KNOWN tier key
 *   • techniqueCount == techniques.length, one row per shot_type
 *   • no technique row survives with an impossible score / sampledCount
 *   • no NaN / "undefined" / "null" strings smuggled into typed fields
 *
 * Reality on the wire: the harness's `player_rank_state` / view rows stand
 * in for rows a stale trigger, a partially applied migration, a manual
 * repair or a different definition version left behind.
 *
 *   deno test -A --no-check --config deno.json attack_w06_02_corrupt_state.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { SCORING_DEFINITION, SCORING_DEFINITION_VERSION } from "../scoringDefinition.ts";
import { playerRankTierForRating } from "../../../../packages/shared-types/src/playerRank.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const TIERS = SCORING_DEFINITION.components.tiers.thresholds;
const TIER_KEYS = new Set<string>(TIERS.map((t) => t.key));
const MIN_RATING = TIERS[0].minRating;
const MAX_RATING = 10;
const PER_POINT = SCORING_DEFINITION.components.scoreQuantization.perPoint;

const h = await loadHarness();
let userSeq = 0;

interface RankBody {
  rank: {
    definitionVersion?: unknown;
    rating: unknown;
    tier: unknown;
    techniqueCount: unknown;
    scoredShotCount: unknown;
    updatedAt: unknown;
    techniques: Array<Record<string, unknown>>;
  } | null;
}

async function rankFor(
  viewRows: Array<Record<string, unknown>>,
  state: Record<string, unknown> | null,
): Promise<{ status: number; body: RankBody }> {
  userSeq += 1;
  const userId = `fb000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.player_technique_rating = viewRows.map((row) => ({ ...row, user_id: userId }));
  h.tables.player_rank_state = state === null ? [] : [{ ...state, user_id: userId }];
  const response = await h.handler(
    userRequest("GET", "/v1/rank", {
      token: fakeGoogleIdToken(userId),
      ip: `198.51.${140 + Math.floor(userSeq / 250)}.${(userSeq % 250) + 1}`,
    }),
  );
  return { status: response.status, body: (await response.json()) as RankBody };
}

const goodRow = (shot_type: string, score: number, sampled_count = 3) => ({
  shot_type,
  score,
  captured_at: "2026-09-01T00:00:00.000Z",
  sampled_count,
  confidence_weight: Math.min(sampled_count, SCORING_DEFINITION.components.confidenceWeight.cap),
});

const goodState = (rating: number, extra: Record<string, unknown> = {}) => ({
  rating,
  tier: playerRankTierForRating(rating).key,
  technique_count: 1,
  scored_shot_count: 3,
  updated_at: "2026-09-01T00:00:00.000Z",
  ...extra,
});

/** Assert that a payload TAGGED with the definition version satisfies it. */
function assertSatisfiesDefinition(label: string, body: RankBody): void {
  assert(body.rank !== null, `${label}: expected a ranked summary`);
  const rank = body.rank;
  if (rank.definitionVersion !== SCORING_DEFINITION_VERSION) return; // untagged: out of scope here
  const rating = rank.rating;
  assert(
    typeof rating === "number" && Number.isFinite(rating),
    `${label}: rating finite, got ${String(rating)}`,
  );
  assert(
    rating >= MIN_RATING && rating <= MAX_RATING,
    `${label}: rating ${rating} outside [${MIN_RATING}, ${MAX_RATING}]`,
  );
  assertEquals(
    Math.round(rating * PER_POINT) / PER_POINT,
    rating,
    `${label}: rating not quantised to 1/${PER_POINT}`,
  );
  assert(
    typeof rank.tier === "string" && TIER_KEYS.has(rank.tier),
    `${label}: unknown tier ${String(rank.tier)}`,
  );
  assertEquals(
    rank.tier,
    playerRankTierForRating(rating).key,
    `${label}: tier disagrees with rating`,
  );
  assertEquals(rank.techniqueCount, rank.techniques.length, `${label}: techniqueCount`);
  const types = rank.techniques.map((t) => t.shot_type);
  assertEquals(new Set(types).size, types.length, `${label}: duplicate technique rows`);
  for (const t of rank.techniques) {
    const score = t.score;
    assert(
      typeof score === "number" && score >= 0 && score <= 10,
      `${label}: technique score ${String(score)}`,
    );
    const sampled = t.sampled_count;
    assert(
      typeof sampled === "number" && Number.isInteger(sampled) && sampled >= 1,
      `${label}: sampled_count ${String(sampled)}`,
    );
    assert(
      typeof t.captured_at === "string" && Number.isFinite(Date.parse(t.captured_at)),
      `${label}: captured_at ${String(t.captured_at)}`,
    );
  }
  if (rank.scoredShotCount !== null) {
    assert(
      typeof rank.scoredShotCount === "number" && Number.isInteger(rank.scoredShotCount),
      `${label}: scoredShotCount ${String(rank.scoredShotCount)}`,
    );
  }
  if (rank.updatedAt !== null) {
    assert(
      typeof rank.updatedAt === "string" && Number.isFinite(Date.parse(rank.updatedAt)),
      `${label}: updatedAt ${String(rank.updatedAt)}`,
    );
  }
}

// ─── saved-state corruption ─────────────────────────────────────────────────

Deno.test("ATTACK W06-02 corrupt state: saved rating above 10 is served under the v2 tag", async () => {
  const { status, body } = await rankFor([goodRow("dink", 7.1)], goodState(7.1, { rating: 42.5 }));
  assertEquals(status, 200);
  assertSatisfiesDefinition("rating=42.5", body);
});

Deno.test("ATTACK W06-02 corrupt state: negative saved rating is served under the v2 tag", async () => {
  const { status, body } = await rankFor([goodRow("dink", 7.1)], goodState(7.1, { rating: -3 }));
  assertEquals(status, 200);
  assertSatisfiesDefinition("rating=-3", body);
});

Deno.test("ATTACK W06-02 corrupt state: saved tier contradicting the saved rating is served verbatim", async () => {
  const { status, body } = await rankFor(
    [goodRow("dink", 7.9)],
    goodState(7.9, { tier: "bronze" }),
  );
  assertEquals(status, 200);
  assertSatisfiesDefinition("tier=bronze@7.9", body);
});

Deno.test("ATTACK W06-02 corrupt state: unknown tier key from another definition version is served under the v2 tag", async () => {
  const { status, body } = await rankFor(
    [goodRow("dink", 7.9)],
    goodState(7.9, { tier: "grandmaster" }),
  );
  assertEquals(status, 200);
  assertSatisfiesDefinition("tier=grandmaster", body);
});

Deno.test("ATTACK W06-02 corrupt state: null tier / null counts / null updated_at become 'null' strings and NaN", async () => {
  const { status, body } = await rankFor(
    [goodRow("dink", 7.9)],
    goodState(7.9, { tier: null, scored_shot_count: null, updated_at: null }),
  );
  assertEquals(status, 200);
  assertSatisfiesDefinition("nulls", body);
});

Deno.test("ATTACK W06-02 corrupt state: saved rating with three decimals (foreign quantisation) is served under the v2 tag", async () => {
  const { status, body } = await rankFor([goodRow("dink", 7.1)], goodState(7.1, { rating: 7.105 }));
  assertEquals(status, 200);
  assertSatisfiesDefinition("rating=7.105", body);
});

Deno.test("ATTACK W06-02 corrupt state: saved rating that no technique evidence supports (0 techniques stored, 1 in view)", async () => {
  // state says 2 techniques and rating 9.5; the view has one technique at 3.0
  const { status, body } = await rankFor(
    [goodRow("dink", 3.0)],
    goodState(9.5, { technique_count: 2, scored_shot_count: 40 }),
  );
  assertEquals(status, 200);
  assertSatisfiesDefinition("state-vs-view", body);
  // The tag promises the definition; under it the rating IS the
  // confidence-weighted mean of the served technique scores.
  assert(body.rank !== null);
  assertEquals(
    body.rank.rating,
    3.0,
    "tagged rating must be what the definition yields for the served rows",
  );
});

// ─── view-row corruption (inline-fallback path) ─────────────────────────────

Deno.test("ATTACK W06-02 corrupt view: technique score 55 (0-100 legacy scale) drives the inline fallback", async () => {
  const { status, body } = await rankFor([goodRow("dink", 55)], null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("score=55", body);
});

Deno.test("ATTACK W06-02 corrupt view: negative technique score drives the inline fallback", async () => {
  const { status, body } = await rankFor([goodRow("dink", -2.5)], null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("score=-2.5", body);
});

Deno.test("ATTACK W06-02 corrupt view: confidence_weight far above the cap dominates the rating", async () => {
  // Definition: weight = min(count, cap). A stored weight of 1e6 must not
  // outrank the other technique 200000:1.
  const rows = [
    { ...goodRow("dink", 10, 5), confidence_weight: 1_000_000 },
    goodRow("drive", 0, 5),
  ];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("weight=1e6", body);
  assert(body.rank !== null);
  // both techniques at cap → plain mean = 5.00
  assertEquals(body.rank.rating, 5, "cap must bound every technique weight");
});

Deno.test("ATTACK W06-02 corrupt view: null confidence_weight (Infinity on the wire) becomes weight 0, not min(sampled_count, cap)", async () => {
  // JSON cannot carry Infinity: the stub (like PostgREST) serialises it as
  // null. The definition says weight = min(sampled_count, cap) = 5 for BOTH
  // rows, so the tagged rating must be the plain mean 5.00 — not the
  // drive-only 3.00 a zero weight produces.
  const rows = [{ ...goodRow("dink", 7, 5), confidence_weight: Infinity }, goodRow("drive", 3, 5)];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("weight=null", body);
  assert(body.rank !== null);
  assertEquals(body.rank.techniqueCount, 2);
  assertEquals(body.rank.rating, 5, "weight must follow the definition, not a corrupt column");
});

Deno.test("ATTACK W06-02 corrupt view: duplicate rows for one shot_type are counted twice", async () => {
  const rows = [goodRow("dink", 9), goodRow("dink", 9), goodRow("drive", 1)];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("dup shot_type", body);
});

Deno.test("ATTACK W06-02 corrupt view: sampled_count 0 / negative / null survive into the payload", async () => {
  const rows = [
    { ...goodRow("dink", 7), sampled_count: 0 },
    { ...goodRow("drive", 6), sampled_count: -4 },
    { ...goodRow("serve", 5), sampled_count: null },
  ];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("sampled_count junk", body);
});

Deno.test("ATTACK W06-02 corrupt view: null shot_type / null captured_at become the strings 'null'", async () => {
  const rows = [{ ...goodRow("dink", 7), shot_type: null, captured_at: null }];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("null text columns", body);
});

Deno.test("ATTACK W06-02 corrupt view: a score that is a non-numeric string is dropped, others still rank (no version-less half state)", async () => {
  const rows = [{ ...goodRow("dink", 7), score: "seven" }, goodRow("drive", 4)];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertSatisfiesDefinition("score='seven'", body);
  assert(body.rank !== null);
  assertEquals(body.rank.techniques.map((t) => t.shot_type), ["drive"]);
  assertEquals(body.rank.rating, 4);
});

Deno.test("ATTACK W06-02 corrupt view: every row unscorable ⇒ { rank: null } exactly, never a fabricated bronze", async () => {
  const rows = [{ ...goodRow("dink", 7), score: null }, { ...goodRow("drive", 4), score: "NaN" }];
  const { status, body } = await rankFor(rows, null);
  assertEquals(status, 200);
  assertEquals(body, { rank: null });
});

Deno.test("ATTACK W06-02 corrupt view: empty view but a stale saved state ⇒ { rank: null } (no evidence, no summary)", async () => {
  const { status, body } = await rankFor(
    [],
    goodState(8.2, { technique_count: 3, scored_shot_count: 12 }),
  );
  assertEquals(status, 200);
  assertEquals(body, { rank: null });
});
