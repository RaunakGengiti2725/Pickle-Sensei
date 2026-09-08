/**
 * W06-02 adversary — boundary values / randomised cross-plane parity.
 *
 * The golden fixture is a hand-picked set. This attack throws seeded random
 * evidence at all three planes and demands byte-identical rank summaries:
 *
 *   SQL   : public.shots → trigger → public.player_rank_state + the
 *           public.player_technique_rating view (disposable Postgres)
 *   Edge  : GET /v1/rank through the REAL handler (routesHarness) fed the
 *           view rows PostgREST would return, in BOTH saved-state and
 *           inline-fallback modes
 *   TS    : computePlayerRank over the same analyses
 *
 * Every summary must agree on rating, tier, techniqueCount, technique order,
 * technique scores and sampled counts, and every Edge payload must carry the
 * canonical definition version. Half-tie hundredths, single-analysis
 * techniques, over-window histories (> formWindow) and same-instant capture
 * ties are all reachable from the generator.
 *
 * Requires a disposable Postgres with every migration applied:
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json attack_w06_02_fuzz_cross_plane.test.ts
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) the SQL-backed test is
 * `ignore`d — an ignored run is NOT a pass.
 */
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import {
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
} from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const CASES = Number(Deno.env.get("W06_02_FUZZ_CASES") ?? "160");
const SEED = Number(Deno.env.get("W06_02_FUZZ_SEED") ?? "20260908");

type Sql = ReturnType<typeof postgres>;

/** Deterministic PRNG (mulberry32) so a failing case is reproducible by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHOT_TYPES = ["dink", "drive", "serve", "return", "third_shot_drop", "Volley", "lob", "ä"];

interface FuzzAnalysis extends PlayerRankAnalysisInput {
  id: string;
  overallScore: number;
  capturedAt: string;
  source: string;
}

function uuidFrom(random: () => number): string {
  const hex = () => Math.floor(random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-8${s(3)}-${s(12)}`;
}

/** One random evidence set: 1..4 techniques, 1..12 analyses each, scores with
 * exactly two decimals (numeric(4,2)), distinct millisecond instants except a
 * deliberate fraction of same-instant ties (id order decides those). */
function generateCase(random: () => number): FuzzAnalysis[] {
  const techniqueCount = 1 + Math.floor(random() * 4);
  const types = [...SHOT_TYPES].sort(() => random() - 0.5).slice(0, techniqueCount);
  const analyses: FuzzAnalysis[] = [];
  let instant = Date.UTC(2026, 0, 1) + Math.floor(random() * 1_000_000) * 1000;
  for (const shotType of types) {
    const n = 1 + Math.floor(random() * 12);
    for (let i = 0; i < n; i += 1) {
      const tie = analyses.length > 0 && random() < 0.08;
      if (!tie) instant += 1000 + Math.floor(random() * 3_600_000);
      const score = Math.floor(random() * 1001) / 100;
      analyses.push({
        id: uuidFrom(random),
        shotType,
        overallScore: score,
        resultKind: "scored",
        capturedAt: new Date(instant).toISOString(),
        source: "real",
      });
    }
  }
  return analyses.sort(() => random() - 0.5);
}

async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
  }
}

async function insertAnalysis(tx: Sql, userId: string, a: FuzzAnalysis): Promise<void> {
  await tx.unsafe(
    `insert into public.shots
       (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
        overall_score, analysis_confidence, result_kind, source,
        app_version, model_bundle_version, pose_model_version, paddle_model_version,
        stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
     values ($1, $2, $3, 'side', $4::text::timestamptz, 0, 100, 200, $5::numeric, 0.9, $6, $7,
             '1', '1', '1', '1', '1', '1', '1', '1')`,
    [a.id, userId, a.shotType, a.capturedAt, String(a.overallScore), a.resultKind, a.source],
  );
}

interface Projection {
  rating: number;
  tier: string;
  techniqueCount: number;
  techniques: Array<
    { shotType: string; score: number; capturedAtMs: number; sampledCount: number }
  >;
}

interface ViewRow {
  user_id: string;
  shot_type: string;
  score: number;
  captured_at: string;
  sampled_count: number;
  confidence_weight: number;
}

interface StateRow {
  user_id: string;
  rating: number;
  tier: string;
  technique_count: number;
  scored_shot_count: number;
  updated_at: string;
}

async function readSqlPlane(
  tx: Sql,
  userId: string,
): Promise<{ state: StateRow | null; view: ViewRow[]; projection: Projection | null }> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count, updated_at
       from public.player_rank_state where user_id = $1`,
    [userId],
  );
  const view = await tx.unsafe(
    `select shot_type, score::text as score, captured_at, sampled_count, confidence_weight
       from public.player_technique_rating where user_id = $1
       order by shot_type collate "C" asc`,
    [userId],
  );
  // PostgREST renders numeric as a JSON number and timestamptz as ISO text;
  // reproduce that wire shape for the Edge stub.
  const viewRows: ViewRow[] = view.map((row) => ({
    user_id: userId,
    shot_type: String(row.shot_type),
    score: Number(row.score),
    captured_at: new Date(row.captured_at as string).toISOString(),
    sampled_count: Number(row.sampled_count),
    confidence_weight: Number(row.confidence_weight),
  }));
  if (state.length === 0) {
    return { state: null, view: viewRows, projection: null };
  }
  const stateRow: StateRow = {
    user_id: userId,
    rating: Number(state[0].rating),
    tier: String(state[0].tier),
    technique_count: Number(state[0].technique_count),
    scored_shot_count: Number(state[0].scored_shot_count),
    updated_at: new Date(state[0].updated_at as string).toISOString(),
  };
  const ordered = [...viewRows].sort(
    (a, b) =>
      b.score - a.score || (a.shot_type < b.shot_type ? -1 : a.shot_type > b.shot_type ? 1 : 0),
  );
  return {
    state: stateRow,
    view: viewRows,
    projection: {
      rating: stateRow.rating,
      tier: stateRow.tier,
      techniqueCount: stateRow.technique_count,
      techniques: ordered.map((t) => ({
        shotType: t.shot_type,
        score: t.score,
        capturedAtMs: Date.parse(t.captured_at),
        sampledCount: t.sampled_count,
      })),
    },
  };
}

function tsProjection(analyses: FuzzAnalysis[]): Projection | null {
  const summary = computePlayerRank(analyses);
  if (summary === null) return null;
  return {
    rating: summary.rating,
    tier: summary.tier,
    techniqueCount: summary.techniqueCount,
    techniques: summary.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAtMs: Date.parse(t.capturedAt),
      sampledCount: t.sampledCount ?? -1,
    })),
  };
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

const h = await loadHarness();
let userSeq = 0;

async function edgeRank(
  viewRows: ViewRow[],
  state: StateRow | null,
): Promise<{ body: EdgeRankPayload; projection: Projection | null }> {
  userSeq += 1;
  const userId = `fa000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.player_technique_rating = viewRows.map((row) => ({ ...row, user_id: userId }));
  h.tables.player_rank_state = state === null ? [] : [{ ...state, user_id: userId }];
  const response = await h.handler(
    userRequest("GET", "/v1/rank", {
      token: fakeGoogleIdToken(userId),
      ip: `198.51.${120 + Math.floor(userSeq / 250)}.${(userSeq % 250) + 1}`,
    }),
  );
  assertEquals(response.status, 200);
  const body = (await response.json()) as EdgeRankPayload;
  if (body.rank === null) return { body, projection: null };
  return {
    body,
    projection: {
      rating: body.rank.rating,
      tier: body.rank.tier,
      techniqueCount: body.rank.techniqueCount,
      techniques: body.rank.techniques.map((t) => ({
        shotType: t.shot_type,
        score: t.score,
        capturedAtMs: Date.parse(t.captured_at),
        sampledCount: t.sampled_count,
      })),
    },
  };
}

Deno.test({
  name:
    `ATTACK W06-02 fuzz: ${CASES} seeded random evidence sets rank identically on SQL, Edge (saved-state + inline-fallback) and TS, and every Edge summary carries the definition version`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const random = rng(SEED);
    const problems: string[] = [];
    let halfTies = 0;
    let overWindow = 0;
    try {
      for (let i = 0; i < CASES; i += 1) {
        const analyses = generateCase(random);
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
            userId,
            `${userId}@example.com`,
          ]);
          for (const a of analyses) await insertAnalysis(tx, userId, a);
          const sqlPlane = await readSqlPlane(tx, userId);
          const ts = tsProjection(analyses);
          const saved = await edgeRank(sqlPlane.view, sqlPlane.state);
          const inline = await edgeRank(sqlPlane.view, null);

          const perTechnique = new Map<string, number>();
          for (const a of analyses) {
            perTechnique.set(a.shotType, (perTechnique.get(a.shotType) ?? 0) + 1);
          }
          if (
            [...perTechnique.values()].some((n) =>
              n > SCORING_DEFINITION.components.formWindow.size
            )
          ) {
            overWindow += 1;
          }
          if (ts !== null) {
            const hundredths = ts.techniques.map((t) => Math.round(t.score * 100));
            const weights = sqlPlane.view.map((v) => v.confidence_weight);
            const num = hundredths.reduce((acc, hv, idx) => {
              const w = weights[
                sqlPlane.view.findIndex((v) => v.shot_type === ts.techniques[idx].shotType)
              ];
              return acc + hv * w;
            }, 0);
            const den = weights.reduce((a, b) => a + b, 0);
            if (Math.abs((num / den) % 1) === 0.5) halfTies += 1;
          }

          const sqlJson = JSON.stringify(sqlPlane.projection);
          const tsJson = JSON.stringify(ts);
          const savedJson = JSON.stringify(saved.projection);
          const inlineJson = JSON.stringify(inline.projection);
          const versionOk = (saved.body.rank === null ||
            saved.body.rank.definitionVersion === SCORING_DEFINITION_VERSION) &&
            (inline.body.rank === null ||
              inline.body.rank.definitionVersion === SCORING_DEFINITION_VERSION);
          if (
            sqlJson !== tsJson ||
            sqlJson !== savedJson ||
            sqlJson !== inlineJson ||
            !versionOk ||
            sqlPlane.projection === null
          ) {
            problems.push(
              `case ${i} (seed ${SEED}) user ${userId}\n  analyses = ${
                JSON.stringify(analyses)
              }\n  sql      = ${sqlJson}\n  ts       = ${tsJson}\n  edge/s   = ${savedJson}\n  edge/i   = ${inlineJson}\n  version  = ${
                JSON.stringify([
                  saved.body.rank?.definitionVersion,
                  inline.body.rank?.definitionVersion,
                ])
              }`,
            );
          }
        });
      }
    } finally {
      await sql.end();
    }
    console.log(
      `[attack w06-02 fuzz] cases=${CASES} seed=${SEED} halfTieRatings=${halfTies} overWindowCases=${overWindow} mismatches=${problems.length}`,
    );
    assert(overWindow > 0, "generator must exercise histories longer than the form window");
    assertEquals(problems, [], `cross-plane divergence:\n${problems.join("\n")}`);
  },
});
