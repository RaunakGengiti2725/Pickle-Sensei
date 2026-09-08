/**
 * W06-01 ADVERSARY (round 4, candidate devin/pp/w06-01/impl-r4 @ 61206685)
 * — SQL-plane attacks on "identical inputs rank identically".
 *
 *   1. Seeded random histories that the Edge ingress admits (mirror of
 *      parseSyncShot) are inserted into public.shots exactly as the sync
 *      payload carries them (score and instant as text, Postgres casts),
 *      including replayed ids with conflicting content, same-second ties,
 *      1–9 fraction digits, half-way microseconds, three-decimal scores and
 *      the production iOS capture shape (`…SSZ`).  player_rank_state /
 *      player_technique_rating must equal computePlayerRank on the SQL
 *      projection.
 *   2. Identity: id spellings the TS plane counts as distinct analyses vs
 *      what the Edge ingress admits and what Postgres collapses onto one
 *      shots_pkey (the id domain the definition leaves unspecified).
 *   3. Text: a lone UTF-16 surrogate shotType passes POST /v1/shots:sync
 *      (the real handler) and is then refused by jsonb input (SQLSTATE
 *      22P02) — the shape apply_synced_shot(jsonb) receives — while the TS
 *      plane ranks it: a row TS counts that no server plane can store.
 *   4. Tier thresholds: public.player_rank_tier vs playerRankTierForRating
 *      on every hundredth of the scale.
 *   5. Timestamp rounding: rint(strtod) on random 7–9 digit fractions vs
 *      the TS plane's half-even model.
 *
 * Setup: identical to w06_01_golden_parity.test.ts (PICKLE_AUDIT_PG_URL).
 * The SQL tests are `ignore`d without it — a skipped run is NOT a pass.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
  type PlayerRankSummary,
  playerRankTierForRating,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION } from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

async function withRollback(fn: (tx: Sql) => Promise<void>): Promise<void> {
  const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    try {
      await sql.begin(async (tx) => {
        await fn(tx as unknown as Sql);
        throw new Error("__rollback__");
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
    }
  } finally {
    await sql.end();
  }
}

async function ownerUser(tx: Sql, seed: number): Promise<string> {
  const rows = await tx.unsafe(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`w06-01-r4-attack-${seed}@example.test`],
  );
  return String(rows[0]?.id);
}

/** Same insert the candidate's parity test performs: owner write, no permit
 * gate, score and instant as their JSON text so Postgres does the casts. */
async function insertAnalysis(
  tx: Sql,
  userId: string,
  a: PlayerRankAnalysisInput,
): Promise<string | null> {
  await tx.unsafe(`savepoint row_insert`);
  try {
    await tx.unsafe(
      `insert into public.shots
         (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
          overall_score, analysis_confidence, result_kind, source,
          app_version, model_bundle_version, pose_model_version, paddle_model_version,
          stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values ($1, $2, $3, 'side', $4::text::timestamptz, 0, 100, 200, $5::numeric, 0.9, $6, $7,
               '1', '1', '1', '1', '1', '1', '1', '1')`,
      [
        a.id ?? null,
        userId,
        a.shotType,
        a.capturedAt,
        a.overallScore === null ? null : String(a.overallScore),
        a.resultKind,
        a.source ?? SCORING_DEFINITION.components.countability.absentSourceCountsAs,
      ],
    );
    await tx.unsafe(`release savepoint row_insert`);
    return null;
  } catch (error) {
    await tx.unsafe(`rollback to savepoint row_insert`);
    const message = error instanceof Error ? error.message : String(error);
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    if (constraint) return constraint;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `sqlstate ${code}` : message;
  }
}

interface Projection {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: Array<
    { shotType: string; score: number; capturedAtMs: number; sampledCount: number }
  >;
}

async function readSqlRank(tx: Sql, userId: string): Promise<Projection | null> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = $1`,
    [userId],
  );
  const view = await tx.unsafe(
    `select t.shot_type, t.score::text as score,
            to_char(t.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as captured_at,
            t.sampled_count
       from public.player_technique_rating t where t.user_id = $1
       order by t.score desc, t.shot_type collate "C" asc`,
    [userId],
  );
  if (state.length === 0) {
    assertEquals(view.length, 0, "technique rows without saved rank state");
    return null;
  }
  return {
    rating: Number(state[0].rating),
    tier: String(state[0].tier),
    techniqueCount: Number(state[0].technique_count),
    scoredAnalysisCount: Number(state[0].scored_shot_count),
    techniques: view.map((row) => ({
      shotType: String(row.shot_type),
      score: Number(row.score),
      capturedAtMs: microsOf(String(row.captured_at)),
      sampledCount: Number(row.sampled_count),
    })),
  };
}

/** Whole microseconds of a `…Z` instant, with the SQL half-even fraction model. */
function microsOf(text: string): number {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!m) throw new Error(`not an instant: ${text}`);
  const whole = Date.parse(`${m[1]}Z`);
  const frac = m[2] === undefined ? 0 : rint(Number(`0.${m[2]}`) * 1e6);
  return whole * 1000 + frac;
}

function rint(x: number): number {
  const f = Math.floor(x);
  const r = x - f;
  if (r < 0.5) return f;
  if (r > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function project(summary: PlayerRankSummary | null): Projection | null {
  if (summary === null) return null;
  return {
    rating: summary.rating,
    tier: summary.tier,
    techniqueCount: summary.techniqueCount,
    scoredAnalysisCount: summary.scoredAnalysisCount,
    techniques: summary.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAtMs: microsOf(t.capturedAt),
      sampledCount: t.sampledCount ?? -1,
    })),
  };
}

// ─── Edge ingress mirror (supabase/functions/api/index.ts parseSyncShot) ────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const MIN_MS = Date.parse("2000-01-01T00:00:00.000Z");
const MAX_MS = Date.parse("2100-01-01T00:00:00.000Z");

function edgeAdmits(a: PlayerRankAnalysisInput): boolean {
  if (!UUID_RE.test(a.id ?? "")) return false;
  if (a.shotType.trim().length === 0 || a.shotType.length > 64) return false;
  if (a.source !== undefined && a.source !== "real") return false;
  if (!ISO_RE.test(a.capturedAt)) return false;
  const ms = Date.parse(a.capturedAt);
  if (Number.isNaN(ms) || ms < MIN_MS || ms >= MAX_MS) return false;
  const d = new Date(ms);
  if (d.toISOString().slice(0, 19) !== a.capturedAt.slice(0, 19)) return false;
  if (a.resultKind === "scored") {
    return typeof a.overallScore === "number" && Number.isFinite(a.overallScore) &&
      a.overallScore >= 0 && a.overallScore <= 10;
  }
  if (a.resultKind === "low_confidence") return a.overallScore === null;
  return false;
}

// ─── Seeded generator (same distribution family as the vitest oracle) ────────

function rng(seed: number): () => number {
  let s = (Math.imul(seed, 0x9e3779b9) ^ 0x85ebca6b) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  for (let i = 0; i < 16; i += 1) next(); // xorshift32 warm-up: small seeds start tiny
  return next;
}

function pick<T>(r: () => number, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("empty pick");
  return item;
}

function uuidFrom(r: () => number): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(r() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${
    out.slice(20)
  }`;
}

const SHOT_TYPES = ["dink", "drive", "Dink", "serve", "_lob", "é", "e\u0301", "x".repeat(64)];

function randomInstant(r: () => number): string {
  const roll = r();
  if (roll < 0.03) return pick(r, ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00.0000004Z"]);
  if (roll < 0.06) return pick(r, ["2099-12-31T23:59:59.999Z", "2099-12-31T23:59:59.9999995Z"]);
  const base = Date.UTC(2026, 7, 1, 10, 0, 0);
  const whole = new Date(base + Math.floor(r() * 4) * 1000).toISOString().slice(0, 19);
  const shape = r();
  if (shape < 0.25) return `${whole}Z`;
  if (shape < 0.5) return `${whole}.${String(Math.floor(r() * 1000)).padStart(3, "0")}Z`;
  const digits = 1 + Math.floor(r() * 9);
  let frac = "";
  for (let i = 0; i < digits; i += 1) frac += String(Math.floor(r() * 10));
  if (r() < 0.3 && digits >= 7) frac = `${frac.slice(0, 6)}5${frac.slice(7)}`;
  return `${whole}.${frac}Z`;
}

function randomScore(r: () => number): number {
  const roll = r();
  if (roll < 0.35) return Math.floor(r() * 1001) / 100;
  if (roll < 0.6) return Math.floor(r() * 10001) / 1000;
  if (roll < 0.8) return r() * 10;
  if (roll < 0.88) return pick(r, [0, 10, 1e-7, 5e-7, 9.995, 6.005, 0.1 + 0.2]);
  return Math.floor(r() * 11);
}

function randomRows(seed: number): PlayerRankAnalysisInput[] {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 14);
  const rows: PlayerRankAnalysisInput[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let id = uuidFrom(r);
    if (ids.length > 0 && r() < 0.25) id = pick(r, ids);
    if (r() < 0.15) id = id.toUpperCase();
    ids.push(id);
    const kind = r() < 0.85 ? "scored" : "low_confidence";
    const row: PlayerRankAnalysisInput = {
      id,
      shotType: pick(r, SHOT_TYPES),
      overallScore: kind === "scored" ? randomScore(r) : null,
      resultKind: kind,
      capturedAt: randomInstant(r),
    };
    if (r() < 0.6) row.source = "real";
    rows.push(row);
  }
  return rows;
}

// ─── Attacks ─────────────────────────────────────────────────────────────────

Deno.test({
  name: "W06-01 r4 attack: 120 random Edge-admitted histories rank identically in SQL and TS",
  ignore,
  fn: async () => {
    const mismatches: string[] = [];
    let ranked = 0;
    let replayed = 0;
    await withRollback(async (tx) => {
      for (let seed = 1; seed <= 120; seed += 1) {
        const rows = randomRows(seed).filter(edgeAdmits);
        const userId = await ownerUser(tx, seed);
        const refusals: string[] = [];
        for (const row of rows) {
          const refused = await insertAnalysis(tx, userId, row);
          if (refused !== null) refusals.push(refused);
        }
        if (refusals.includes("shots_pkey")) replayed += 1;
        const sqlRank = await readSqlRank(tx, userId);
        const tsRank = project(computePlayerRank(rows));
        if (tsRank !== null) ranked += 1;
        if (JSON.stringify(sqlRank) !== JSON.stringify(tsRank)) {
          mismatches.push(
            `seed ${seed} refusals=${JSON.stringify(refusals)}\n  rows=${
              JSON.stringify(rows)
            }\n  sql=${JSON.stringify(sqlRank)}\n  ts =${JSON.stringify(tsRank)}`,
          );
        }
      }
    });
    assertEquals(mismatches, [], mismatches.slice(0, 3).join("\n"));
    // non-vacuity
    assertEquals(ranked > 80, true, `only ${ranked} ranked histories`);
    assertEquals(replayed > 10, true, `only ${replayed} replayed histories`);
  },
});

// ─── Edge ingress (real handler, PostgREST stubbed by the routes harness) ───

const h = await loadHarness();
let ipCounter = 0;

async function edgeSync(
  userId: string,
  shot: Record<string, unknown>,
): Promise<{ accepted: boolean; code: string | null; rpcBodies: unknown[] }> {
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  ipCounter += 1;
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: fakeGoogleIdToken(userId),
      ip: `198.51.200.${(ipCounter % 250) + 1}`,
      body: { shots: [shot] },
    }),
  );
  assertEquals(response.status, 200, "batch processed");
  const body = (await response.json()) as {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string }>;
  };
  const id = String(shot.id);
  return {
    accepted: (body.acceptedIds ?? []).includes(id),
    code: body.rejected?.find((r) => r.id === id)?.code ?? null,
    rpcBodies: h.callsTo("apply_synced_shot").map((call) => call.body),
  };
}

function syncPayload(a: PlayerRankAnalysisInput): Record<string, unknown> {
  return {
    id: a.id,
    source: a.source ?? "real",
    analysisPermitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    sessionId: null,
    shotType: a.shotType,
    cameraView: "side",
    capturedAt: a.capturedAt,
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind: a.resultKind,
    overallScore: a.overallScore,
    confidence: 0.9,
    phases: [],
    checkpoints: [],
    versionVector: {
      appVersion: "1",
      modelBundleVersion: "1",
      poseModelVersion: "1",
      paddleModelVersion: "1",
      strokeDetectorVersion: "1",
      phaseModelVersion: "1",
      scoringModelVersion: "1",
      shotConfigVersion: "1",
    },
  };
}

const EDGE_USER = "e4000000-0000-4000-8000-000000000001";

Deno.test({
  name:
    "W06-01 r4 attack: id spellings — Edge refuses what Postgres would collapse, TS counts them as distinct",
  ignore,
  fn: async () => {
    await withRollback(async (tx) => {
      const rows = await tx.unsafe(
        `select '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}'::uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid as braced,
                'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'::uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid as bare`,
      );
      assertEquals(rows[0]?.braced, true);
      assertEquals(rows[0]?.bare, true);
      const userId = await ownerUser(tx, 9001);
      const at = "2026-08-01T10:00:00Z";
      const first: PlayerRankAnalysisInput = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        shotType: "dink",
        overallScore: 9,
        resultKind: "scored",
        capturedAt: at,
        source: "real",
      };
      const braced: PlayerRankAnalysisInput = {
        ...first,
        id: "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
        overallScore: 3,
      };
      const bare: PlayerRankAnalysisInput = {
        ...first,
        id: "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
        overallScore: 1,
      };
      const empty: PlayerRankAnalysisInput = { ...first, id: "", overallScore: 2 };
      assertEquals(await insertAnalysis(tx, userId, first), null);
      assertEquals(await insertAnalysis(tx, userId, braced), "shots_pkey");
      assertEquals(await insertAnalysis(tx, userId, bare), "shots_pkey");
      assertEquals(await insertAnalysis(tx, userId, empty), "sqlstate 22P02");
      const sqlRank = await readSqlRank(tx, userId);
      assertEquals(sqlRank?.scoredAnalysisCount, 1);
      // The sync ingress never lets these spellings reach the table …
      assertEquals((await edgeSync(EDGE_USER, syncPayload(first))).accepted, true);
      for (const a of [braced, bare, empty]) {
        const outcome = await edgeSync(EDGE_USER, syncPayload(a));
        assertEquals(outcome.accepted, false, `edge admitted id ${JSON.stringify(a.id)}`);
        assertEquals(outcome.code?.startsWith("shot."), true, `code ${outcome.code}`);
      }
      // … so the TS plane, whose countability filter the definition calls
      // "the complete rule set", must not count them either: one analysis.
      const tsRank = computePlayerRank([first, braced, bare, empty]);
      assertEquals(
        tsRank?.scoredAnalysisCount,
        1,
        `TS counted ${tsRank?.scoredAnalysisCount} analyses for one storable id`,
      );
    });
  },
});

Deno.test({
  name:
    "W06-01 r4 attack: a lone UTF-16 surrogate shotType passes the Edge ingress, cannot enter jsonb (22P02), yet TS ranks it",
  ignore,
  fn: async () => {
    const row: PlayerRankAnalysisInput = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      shotType: "\ud800",
      overallScore: 6,
      resultKind: "scored",
      capturedAt: "2026-08-01T10:00:00Z",
      source: "real",
    };
    // Real handler: parseSyncShot admits the row and calls apply_synced_shot.
    const outcome = await edgeSync(EDGE_USER, syncPayload(row));
    assertEquals(outcome.accepted, true, `edge code ${outcome.code}`);
    assertEquals(outcome.rpcBodies.length, 1, "one apply_synced_shot call");
    // postgrest-js serialises the RPC params with JSON.stringify — the wire
    // text carries the lone surrogate as the \ud800 escape.
    const wire = JSON.stringify(outcome.rpcBodies[0]);
    assertEquals(wire.includes("\\ud800"), true, wire);
    await withRollback(async (tx) => {
      let code: unknown = null;
      await tx.unsafe(`savepoint jsonb_parse`);
      try {
        // ($1::text)::jsonb — hand Postgres the JSON TEXT the RPC receives
        // (a bare $1::jsonb makes postgres.js re-serialise the string).
        await tx.unsafe(`select ($1::text)::jsonb`, [wire]);
      } catch (error) {
        code = (error as { code?: unknown }).code;
        await tx.unsafe(`rollback to savepoint jsonb_parse`);
      }
      assertEquals(code, "22P02", "jsonb refused the lone surrogate");
      // Even a direct owner insert (client encodes UTF-8) cannot carry the
      // row as given: the lone surrogate reaches the text column as U+FFFD,
      // a DIFFERENT technique key than the one the TS plane ranked.
      const userId = await ownerUser(tx, 9002);
      assertEquals(await insertAnalysis(tx, userId, row), null);
      const stored = await tx.unsafe(`select shot_type from public.shots where user_id = $1`, [
        userId,
      ]);
      assertEquals(String(stored[0]?.shot_type), "\ufffd");
    });
    // No server plane can store the row, so the definition's countability
    // ("the complete rule set") must exclude it: no evidence, null.
    assertEquals(computePlayerRank([row]), null, "TS ranked a shotType no server plane can carry");
  },
});

Deno.test({
  name:
    "W06-01 r4 attack: public.player_rank_tier agrees with the shared thresholds on every hundredth",
  ignore,
  fn: async () => {
    await withRollback(async (tx) => {
      const rows = await tx.unsafe(
        `select (g / 100.0)::numeric(4,2)::text as rating, public.player_rank_tier((g / 100.0)::numeric) as tier
           from generate_series(0, 1000) as g`,
      );
      assertEquals(rows.length, 1001);
      const mismatches = rows
        .map((row) => ({
          rating: Number(row.rating),
          sql: String(row.tier),
          ts: playerRankTierForRating(Number(row.rating)).key,
        }))
        .filter((row) => row.sql !== row.ts);
      assertEquals(mismatches, []);
    });
  },
});

Deno.test({
  name:
    "W06-01 r4 attack: timestamptz rounding of random 7–9 digit fractions matches the half-even model",
  ignore,
  fn: async () => {
    const r = rng(2026);
    const texts: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const digits = 7 + Math.floor(r() * 3);
      let frac = "";
      for (let k = 0; k < digits; k += 1) frac += String(Math.floor(r() * 10));
      if (i % 3 === 0) frac = `${frac.slice(0, 6)}5${"0".repeat(digits - 7)}`; // exact half
      texts.push(`2026-08-01T10:00:00.${frac}Z`);
    }
    await withRollback(async (tx) => {
      const rows = await tx.unsafe(
        `select t, to_char(t::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stored
           from unnest($1::text[]) as t`,
        [texts],
      );
      const mismatches = rows
        .map((row) => ({
          text: String(row.t),
          sql: microsOf(String(row.stored)),
          model: microsOf(String(row.t)),
        }))
        .filter((row) => row.sql !== row.model);
      assertEquals(mismatches, []);
    });
  },
});
