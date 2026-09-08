/**
 * W06-02 — the Edge rank/progress path computes through the canonical scoring
 * definition (packages/shared-types/src/scoringDefinition.ts) and tags what it
 * serves with the definition version.
 *
 *   GET /v1/rank      over the SQL view rows of every golden case (saved state
 *                     present → pass-through; absent → inline fallback) must
 *                     reproduce `expected` (rating, tier, technique order,
 *                     scores, sampled counts) and carry
 *                     `rank.definitionVersion === SCORING_DEFINITION.version`;
 *                     `{ rank: null }` stays the honest unranked answer.
 *   GET /v1/progress  carries `definitionVersion` beside series/streak.
 *   scoringDefinition.ts (Edge) re-exports the ONE canonical definition object
 *                     (same module instance, not a copy) and its rating port
 *                     reproduces every golden case from the view rows.
 *   index.ts          derives tiers/cap/quantization from that module — no
 *                     second copy of the ladder or the formula constants.
 *
 * Runs against the real handler (routesHarness) with no database: the golden
 * fixture already pins the SQL view for these rows (w06_01_golden_parity.test.ts),
 * so this file only has to pin what the Edge does WITH those rows.
 */
import { assert, assertEquals } from "@std/assert";
import golden from "../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import {
  PLAYER_RANK_GOLDEN_SCHEMA_VERSION,
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
  type PlayerRankGoldenExpected,
  type PlayerRankGoldenFixture,
} from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const fixture: PlayerRankGoldenFixture = golden;
const DEFINITION = SCORING_DEFINITION.components;

/** Path of the Edge port relative to this file; imported lazily so a checkout
 * without it fails ONLY the tests that need it, with a module-not-found. */
const EDGE_SCORING_MODULE = "../scoringDefinition.ts";

interface EdgeTechniqueRow {
  shot_type: string;
  score: number;
  captured_at: string;
  sampled_count: number;
  confidence_weight: number;
}

interface EdgeRankPayload {
  rank: {
    definitionVersion?: unknown;
    rating: number;
    tier: string;
    techniqueCount: number;
    scoredShotCount: number | null;
    updatedAt: string | null;
    techniques: Array<{
      shot_type: string;
      score: number;
      captured_at: string;
      sampled_count: number;
    }>;
  } | null;
}

/** The rows public.player_technique_rating yields for a ranked `expected`,
 * in the order the Edge query asks for them (`shot_type asc`), so the
 * summary order is the Edge's doing. confidence_weight = min(countable
 * analyses, cap); inside the window (sampledCount ≤ formWindow) the window
 * count IS the countable count whenever it is below the cap, and any count
 * ≥ cap clamps to cap — so min(sampledCount, cap) is exact. */
function viewRowsFor(expected: PlayerRankGoldenExpected): EdgeTechniqueRow[] {
  return expected.techniques
    .map((t) => ({
      shot_type: t.shotType,
      score: t.score,
      captured_at: t.capturedAt,
      sampled_count: t.sampledCount,
      confidence_weight: Math.min(t.sampledCount, DEFINITION.confidenceWeight.cap),
    }))
    .sort((a, b) => (a.shot_type < b.shot_type ? -1 : a.shot_type > b.shot_type ? 1 : 0));
}

function stateRowFor(userId: string, expected: PlayerRankGoldenExpected) {
  return {
    user_id: userId,
    rating: expected.rating,
    tier: expected.tier,
    technique_count: expected.techniqueCount,
    scored_shot_count: expected.scoredAnalysisCount,
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

/** Every ranked (non-null) expectation the fixture carries, cases and replays. */
const rankedExpectations: Array<{ id: string; expected: PlayerRankGoldenExpected }> = [
  ...fixture.cases,
  ...fixture.replays,
].flatMap((c) => (c.expected === null ? [] : [{ id: c.id, expected: c.expected }]));

const unrankedIds = [...fixture.cases, ...fixture.replays]
  .filter((c) => c.expected === null)
  .map((c) => c.id);

Deno.test("W06-02 parity: the golden fixture pins the definition the Edge must serve", () => {
  assertEquals(fixture.schemaVersion, PLAYER_RANK_GOLDEN_SCHEMA_VERSION);
  assertEquals(fixture.definitionVersion, SCORING_DEFINITION_VERSION);
  assertEquals(SCORING_DEFINITION.version, SCORING_DEFINITION_VERSION);
  assert(rankedExpectations.length >= 20, "fixture carries ranked cases");
  assert(unrankedIds.length >= 1, "fixture carries an unranked case");
  for (const { id, expected } of rankedExpectations) {
    assertEquals(expected.definitionVersion, SCORING_DEFINITION_VERSION, id);
  }
});

// ─── Real handler ────────────────────────────────────────────────────────────

const h = await loadHarness();

let ipCounter = 0;
let userCounter = 0;

function edgeUser(): { token: string; ip: string; userId: string } {
  userCounter += 1;
  ipCounter += 1;
  const userId = `f0000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  return {
    token: fakeGoogleIdToken(userId),
    ip: `198.51.${100 + Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
    userId,
  };
}

async function getRank(
  viewRows: EdgeTechniqueRow[],
  state: "saved-state" | "inline-fallback",
  expected: PlayerRankGoldenExpected | null,
): Promise<EdgeRankPayload> {
  const auth = edgeUser();
  h.tables.player_technique_rating = viewRows.map((row) => ({ user_id: auth.userId, ...row }));
  h.tables.player_rank_state =
    state === "saved-state" && expected !== null ? [stateRowFor(auth.userId, expected)] : [];
  const response = await h.handler(userRequest("GET", "/v1/rank", auth));
  assertEquals(response.status, 200);
  return (await response.json()) as EdgeRankPayload;
}

/** The fixture's view of an Edge payload: the fields both planes produce. */
function projection(body: EdgeRankPayload) {
  if (body.rank === null) return null;
  return {
    rating: body.rank.rating,
    tier: body.rank.tier,
    techniqueCount: body.rank.techniqueCount,
    techniques: body.rank.techniques.map((t) => ({
      shotType: t.shot_type,
      score: t.score,
      capturedAt: t.captured_at,
      sampledCount: t.sampled_count,
    })),
  };
}

function goldenProjection(expected: PlayerRankGoldenExpected) {
  return {
    rating: expected.rating,
    tier: expected.tier,
    techniqueCount: expected.techniqueCount,
    techniques: expected.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAt: t.capturedAt,
      sampledCount: t.sampledCount,
    })),
  };
}

for (const mode of ["saved-state", "inline-fallback"] as const) {
  Deno.test(
    `W06-02 parity: GET /v1/rank [${mode}] reproduces every golden case and carries the definition version`,
    async () => {
      const problems: string[] = [];
      for (const { id, expected } of rankedExpectations) {
        const body = await getRank(viewRowsFor(expected), mode, expected);
        const actual = projection(body);
        const want = goldenProjection(expected);
        if (JSON.stringify(actual) !== JSON.stringify(want)) {
          problems.push(
            `${id}: summary\n  edge     = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(want)}`,
          );
        }
        if (body.rank === null) continue;
        if (body.rank.definitionVersion !== expected.definitionVersion) {
          problems.push(
            `${id}: rank.definitionVersion = ${JSON.stringify(body.rank.definitionVersion)}, expected ${JSON.stringify(expected.definitionVersion)}`,
          );
        }
        if (mode === "saved-state") {
          if (body.rank.scoredShotCount !== expected.scoredAnalysisCount) {
            problems.push(`${id}: saved scoredShotCount ${body.rank.scoredShotCount}`);
          }
        } else if (body.rank.scoredShotCount !== null || body.rank.updatedAt !== null) {
          problems.push(`${id}: inline fallback must not invent scoredShotCount/updatedAt`);
        }
      }
      assertEquals(problems, [], `GET /v1/rank [${mode}] diverges:\n${problems.join("\n")}`);
    },
  );
}

Deno.test(
  "W06-02 parity: GET /v1/rank answers { rank: null } for every unranked golden case (no version on no summary)",
  async () => {
    for (const id of unrankedIds) {
      for (const mode of ["saved-state", "inline-fallback"] as const) {
        const body = await getRank([], mode, null);
        assertEquals(body, { rank: null }, `${id} [${mode}]`);
      }
    }
  },
);

Deno.test(
  "W06-02 parity: the inline fallback rating follows confidenceWeight.cap and scoreQuantization, not literals",
  async () => {
    const cap = DEFINITION.confidenceWeight.cap;
    const perPoint = DEFINITION.scoreQuantization.perPoint;
    // Two techniques, one far past the cap: rating = round((cap·800 + 2·200) / (cap + 2)) / 100.
    const rows: EdgeTechniqueRow[] = [
      {
        shot_type: "serve",
        score: 2,
        captured_at: "2026-08-05T10:00:00+00:00",
        sampled_count: 2,
        confidence_weight: 2,
      },
      {
        shot_type: "dink",
        score: 8,
        captured_at: "2026-08-06T10:00:00+00:00",
        sampled_count: DEFINITION.formWindow.size,
        confidence_weight: cap,
      },
    ];
    const wantRating = Math.round((cap * 8 * perPoint + 2 * 2 * perPoint) / (cap + 2)) / perPoint;
    const body = await getRank(rows, "inline-fallback", null);
    assert(body.rank !== null);
    assertEquals(body.rank.rating, wantRating);
    assertEquals(
      body.rank.tier,
      [...DEFINITION.tiers.thresholds].reverse().find((t) => wantRating >= t.minRating)!.key,
    );
    assertEquals(body.rank.definitionVersion, SCORING_DEFINITION_VERSION);
    assertEquals(
      body.rank.techniques.map((t) => t.shot_type),
      ["dink", "serve"],
      "rating.techniqueOrder: score desc",
    );

    // A view without confidence_weight (older deployment) falls back to
    // min(sampled_count, cap) — the definition's cap, not a literal 5.
    const legacy = rows.map(({ confidence_weight: _w, ...row }) => ({
      ...row,
      confidence_weight: Number.NaN,
    }));
    const legacyBody = await getRank(legacy, "inline-fallback", null);
    assert(legacyBody.rank !== null);
    assertEquals(legacyBody.rank.rating, wantRating);
    assertEquals(legacyBody.rank.definitionVersion, SCORING_DEFINITION_VERSION);
  },
);

Deno.test(
  "W06-02 parity: GET /v1/rank lists techniques in rating.techniqueOrder (score desc, shotType code-unit asc)",
  async () => {
    const at = "2026-08-05T10:00:00+00:00";
    const rows: EdgeTechniqueRow[] = [
      { shot_type: "apple", score: 5, captured_at: at, sampled_count: 1, confidence_weight: 1 },
      { shot_type: "Zed", score: 5, captured_at: at, sampled_count: 1, confidence_weight: 1 },
      { shot_type: "b", score: 7, captured_at: at, sampled_count: 1, confidence_weight: 1 },
      { shot_type: "ä", score: 5, captured_at: at, sampled_count: 1, confidence_weight: 1 },
    ];
    const body = await getRank(rows, "inline-fallback", null);
    assert(body.rank !== null);
    assertEquals(
      body.rank.techniques.map((t) => t.shot_type),
      ["b", "Zed", "apple", "ä"],
    );
  },
);

Deno.test(
  "W06-02 parity: GET /v1/progress carries the definition version beside series and streak",
  async () => {
    const auth = edgeUser();
    h.tables.progress_daily = [
      {
        user_id: auth.userId,
        day: "2026-09-01",
        shot_type: "dink",
        scoring_model_version: "scoring-1",
        shot_count: 3,
        avg_score: 6.5,
      },
    ];
    h.tables.practice_days = [{ user_id: auth.userId, day: "2026-09-01" }];
    const response = await h.handler(userRequest("GET", "/v1/progress", auth));
    assertEquals(response.status, 200);
    const body = (await response.json()) as {
      definitionVersion?: unknown;
      series: unknown[];
      improving: unknown[];
      needsAttention: unknown[];
      streak: { practicedToday: boolean };
    };
    assertEquals(body.definitionVersion, SCORING_DEFINITION_VERSION);
    assertEquals(body.series.length, 1);
    assertEquals(body.improving, []);
    assertEquals(body.needsAttention, []);
    assertEquals(typeof body.streak.practicedToday, "boolean");
  },
);

// ─── The Edge scoring module ─────────────────────────────────────────────────

interface EdgeScoringModule {
  SCORING_DEFINITION: typeof SCORING_DEFINITION;
  SCORING_DEFINITION_VERSION: string;
  PLAYER_RANK_TIERS: typeof SCORING_DEFINITION.components.tiers.thresholds;
  RANK_CONFIDENCE_CAP: number;
  RANK_HUNDREDTHS_PER_POINT: number;
  RANK_RATING_DECIMALS: number;
  playerRankTierForRating(rating: number): string;
  compareTechniqueOrder(
    a: { shot_type: string; score: number },
    b: { shot_type: string; score: number },
  ): number;
  ratingFromTechniques(
    rows: ReadonlyArray<{ score: number; sampled_count: number; confidence_weight: number }>,
  ): number | null;
}

async function loadEdgeScoring(): Promise<EdgeScoringModule> {
  return (await import(EDGE_SCORING_MODULE)) as EdgeScoringModule;
}

Deno.test(
  "W06-02 parity: the Edge scoring module serves the ONE canonical definition object, not a copy",
  async () => {
    const edge = await loadEdgeScoring();
    assert(edge.SCORING_DEFINITION === SCORING_DEFINITION, "same module instance");
    assertEquals(edge.SCORING_DEFINITION_VERSION, SCORING_DEFINITION_VERSION);
    assert(edge.PLAYER_RANK_TIERS === DEFINITION.tiers.thresholds, "tier ladder by reference");
    assertEquals(edge.RANK_CONFIDENCE_CAP, DEFINITION.confidenceWeight.cap);
    assertEquals(edge.RANK_HUNDREDTHS_PER_POINT, DEFINITION.scoreQuantization.perPoint);
    assertEquals(edge.RANK_RATING_DECIMALS, DEFINITION.rating.rounding.decimals);
    // The port rounds the hundredths mean to a whole number; that IS the
    // definition's `rating.rounding` only while one point holds 10^decimals
    // hundredths. A definition change that breaks this must fail here.
    assertEquals(10 ** edge.RANK_RATING_DECIMALS, edge.RANK_HUNDREDTHS_PER_POINT);
    assertEquals(DEFINITION.rating.rounding.mode, "half-away-from-zero");
    for (const tier of DEFINITION.tiers.thresholds) {
      assertEquals(edge.playerRankTierForRating(tier.minRating), tier.key, tier.key);
      assertEquals(
        edge.playerRankTierForRating(tier.minRating - 0.01),
        [...DEFINITION.tiers.thresholds].reverse().find((t) => tier.minRating - 0.01 >= t.minRating)
          ?.key ?? DEFINITION.tiers.thresholds[0].key,
        `${tier.key} - 0.01`,
      );
    }
    assertEquals(edge.playerRankTierForRating(SCORING_DEFINITION.scale.max), "diamond");
    assertEquals(edge.ratingFromTechniques([]), null, "no technique rows → no rating");
  },
);

Deno.test(
  "W06-02 parity: the Edge rating port reproduces every golden case from its view rows",
  async () => {
    const edge = await loadEdgeScoring();
    const problems: string[] = [];
    for (const { id, expected } of rankedExpectations) {
      const rows = viewRowsFor(expected);
      const rating = edge.ratingFromTechniques(rows);
      const ordered = [...rows].sort(edge.compareTechniqueOrder).map((r) => r.shot_type);
      if (rating !== expected.rating) problems.push(`${id}: rating ${rating} ≠ ${expected.rating}`);
      if (rating !== null && edge.playerRankTierForRating(rating) !== expected.tier) {
        problems.push(`${id}: tier ${edge.playerRankTierForRating(rating)} ≠ ${expected.tier}`);
      }
      const wantOrder = expected.techniques.map((t) => t.shotType);
      if (JSON.stringify(ordered) !== JSON.stringify(wantOrder)) {
        problems.push(`${id}: order ${JSON.stringify(ordered)} ≠ ${JSON.stringify(wantOrder)}`);
      }
    }
    // And against the shared computation directly, for every case's analyses.
    for (const goldenCase of fixture.cases) {
      const summary = computePlayerRank(goldenCase.analyses as PlayerRankAnalysisInput[]);
      if (summary === null) continue;
      const rows = summary.techniques.map((t) => ({
        shot_type: t.shotType,
        score: t.score,
        sampled_count: t.sampledCount ?? 0,
        confidence_weight: Math.min(t.sampledCount ?? 0, DEFINITION.confidenceWeight.cap),
      }));
      if (edge.ratingFromTechniques(rows) !== summary.rating) {
        problems.push(`${goldenCase.id}: port ≠ computePlayerRank (${summary.rating})`);
      }
    }
    assertEquals(problems, [], problems.join("\n"));
  },
);

Deno.test(
  "W06-02 parity: index.ts derives the rank ladder and formula constants from the Edge scoring module",
  async () => {
    const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
    assertEquals(
      source.includes(`from "./scoringDefinition.ts"`),
      true,
      "index.ts must import the Edge scoring module",
    );
    assertEquals(
      /minRating:\s*[0-9]/.test(source),
      false,
      "index.ts must not carry a second copy of the tier ladder",
    );
    assertEquals(
      /Math\.min\([^)]*,\s*5\)/.test(source),
      false,
      "index.ts must not hard-code the confidence cap",
    );
  },
);
