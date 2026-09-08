/**
 * W06-02 adversary — replay / duplicate identities and clock attacks on the
 * SQL plane, cross-checked against the shared TS definition and the REAL Edge
 * handler (routesHarness fed the exact view/state rows Postgres produced).
 *
 *   • replayed shot id (same client-generated id inserted twice) is refused by
 *     the primary key and counts ONCE in rank state — SQL, TS (dedupe by id)
 *     and Edge agree;
 *   • a byte-identical copy under a fresh id is a NEW analysis on every plane
 *     (the definition dedupes by id, not by content) — all three agree;
 *   • clock rollback: a row that arrives LATER with an EARLIER captured_at must
 *     land in form-window order by captured_at, not by insertion;
 *   • far-past / far-future captured_at (year 0001 / 9999) and same-instant
 *     ties across the whole window;
 *   • unscored rows (low_confidence, null score, 'demo' source) never enter the
 *     rating and a user with ONLY such rows is unranked on every plane
 *     ({ rank: null }, no fabricated Bronze, no definition tag);
 *   • a scored row that is deleted (definer cleanup) recomputes the state
 *     rather than leaving a stale rating behind.
 *
 * Requires a disposable Postgres with every migration applied (XC_PG_URL).
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json attack_w06_02_replay_clock_sql.test.ts
 * Without XC_PG_URL the SQL tests are `ignore`d — an ignored run is NOT a pass.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION_VERSION } from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

interface Analysis extends PlayerRankAnalysisInput {
  id: string;
  capturedAt: string;
  source: string;
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

async function newUser(tx: Sql): Promise<string> {
  const userId = crypto.randomUUID();
  await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    `${userId}@example.com`,
  ]);
  return userId;
}

async function insertRow(tx: Sql, userId: string, a: Analysis): Promise<void> {
  await tx.unsafe(
    `insert into public.shots
       (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
        overall_score, analysis_confidence, result_kind, source,
        app_version, model_bundle_version, pose_model_version, paddle_model_version,
        stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
     values ($1, $2, $3, 'side', $4::text::timestamptz, 0, 100, 200, $5::numeric, 0.9, $6, $7,
             '1', '1', '1', '1', '1', '1', '1', '1')`,
    [
      a.id,
      userId,
      a.shotType,
      a.capturedAt,
      a.overallScore === null || a.overallScore === undefined ? null : String(a.overallScore),
      a.resultKind,
      a.source,
    ],
  );
}

interface Projection {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredShotCount: number | null;
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

async function readSql(
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
       from public.player_technique_rating where user_id = $1`,
    [userId],
  );
  const rows: ViewRow[] = view.map((row) => ({
    user_id: userId,
    shot_type: String(row.shot_type),
    score: Number(row.score),
    captured_at: new Date(row.captured_at as string).toISOString(),
    sampled_count: Number(row.sampled_count),
    confidence_weight: Number(row.confidence_weight),
  }));
  if (state.length === 0) return { state: null, view: rows, projection: null };
  const s: StateRow = {
    user_id: userId,
    rating: Number(state[0].rating),
    tier: String(state[0].tier),
    technique_count: Number(state[0].technique_count),
    scored_shot_count: Number(state[0].scored_shot_count),
    updated_at: new Date(state[0].updated_at as string).toISOString(),
  };
  const ordered = [...rows].sort(
    (a, b) =>
      b.score - a.score || (a.shot_type < b.shot_type ? -1 : a.shot_type > b.shot_type ? 1 : 0),
  );
  return {
    state: s,
    view: rows,
    projection: {
      rating: s.rating,
      tier: s.tier,
      techniqueCount: s.technique_count,
      scoredShotCount: s.scored_shot_count,
      techniques: ordered.map((t) => ({
        shotType: t.shot_type,
        score: t.score,
        capturedAtMs: Date.parse(t.captured_at),
        sampledCount: t.sampled_count,
      })),
    },
  };
}

function tsProjection(analyses: Analysis[]): Projection | null {
  const summary = computePlayerRank(analyses);
  if (summary === null) return null;
  return {
    rating: summary.rating,
    tier: summary.tier,
    techniqueCount: summary.techniqueCount,
    scoredShotCount: summary.scoredAnalysisCount,
    techniques: summary.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAtMs: Date.parse(t.capturedAt),
      sampledCount: t.sampledCount ?? -1,
    })),
  };
}

interface EdgeRank {
  rank: {
    definitionVersion?: unknown;
    rating: number;
    tier: string;
    techniqueCount: number;
    scoredShotCount: number | null;
    techniques: Array<
      { shot_type: string; score: number; captured_at: string; sampled_count: number }
    >;
  } | null;
}

const h = await loadHarness();
let userSeq = 0;

async function edge(
  view: ViewRow[],
  state: StateRow | null,
): Promise<{ raw: string; body: EdgeRank; projection: Projection | null }> {
  userSeq += 1;
  const userId = `fb000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.player_technique_rating = view.map((row) => ({ ...row, user_id: userId }));
  h.tables.player_rank_state = state === null ? [] : [{ ...state, user_id: userId }];
  const response = await h.handler(
    userRequest("GET", "/v1/rank", {
      token: fakeGoogleIdToken(userId),
      ip: `198.51.${140 + Math.floor(userSeq / 250)}.${(userSeq % 250) + 1}`,
    }),
  );
  assertEquals(response.status, 200);
  const raw = await response.text();
  const body = JSON.parse(raw) as EdgeRank;
  if (body.rank === null) return { raw, body, projection: null };
  return {
    raw,
    body,
    projection: {
      rating: body.rank.rating,
      tier: body.rank.tier,
      techniqueCount: body.rank.techniqueCount,
      // the inline fallback has no persisted count; compare the rest
      scoredShotCount: state === null ? null : body.rank.scoredShotCount,
      techniques: body.rank.techniques.map((t) => ({
        shotType: t.shot_type,
        score: t.score,
        capturedAtMs: Date.parse(t.captured_at),
        sampledCount: t.sampled_count,
      })),
    },
  };
}

/** SQL == TS == Edge(saved) == Edge(inline, minus scoredShotCount); both Edge
 * payloads tagged when ranked, exactly { rank: null } when not. */
async function assertAllPlanes(tx: Sql, userId: string, analyses: Analysis[], label: string) {
  const sqlPlane = await readSql(tx, userId);
  const ts = tsProjection(analyses);
  const saved = await edge(sqlPlane.view, sqlPlane.state);
  const inline = await edge(sqlPlane.view, null);
  assertEquals(JSON.stringify(sqlPlane.projection), JSON.stringify(ts), `${label}: SQL vs TS`);
  assertEquals(JSON.stringify(saved.projection), JSON.stringify(ts), `${label}: Edge/saved vs TS`);
  assertEquals(
    JSON.stringify(inline.projection),
    JSON.stringify(ts === null ? null : { ...ts, scoredShotCount: null }),
    `${label}: Edge/inline vs TS`,
  );
  if (ts === null) {
    assertEquals(saved.raw, JSON.stringify({ rank: null }), `${label}: unranked saved`);
    assertEquals(inline.raw, JSON.stringify({ rank: null }), `${label}: unranked inline`);
  } else {
    assertEquals(saved.body.rank?.definitionVersion, SCORING_DEFINITION_VERSION, label);
    assertEquals(inline.body.rank?.definitionVersion, SCORING_DEFINITION_VERSION, label);
  }
  return { sqlPlane, ts };
}

const scored = (id: string, shotType: string, score: number, capturedAt: string): Analysis => ({
  id,
  shotType,
  overallScore: score,
  resultKind: "scored",
  capturedAt,
  source: "real",
});

Deno.test({
  name:
    "ATTACK W06-02 replay: the same shot id inserted twice is refused and counts once on every plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        const first = scored(crypto.randomUUID(), "dink", 7.5, "2026-09-01T10:00:00.000Z");
        await insertRow(tx, userId, first);
        await tx.unsafe("savepoint replay");
        await assertRejects(
          () => insertRow(tx, userId, { ...first, overallScore: 9.99 }),
          Error,
          "duplicate key",
        );
        await tx.unsafe("rollback to savepoint replay");
        // TS receives the replayed copy too; dedupe-by-id keeps the first
        const { sqlPlane } = await assertAllPlanes(
          tx,
          userId,
          [first, { ...first, overallScore: 9.99 }],
          "replayed id",
        );
        assertEquals(sqlPlane.state?.scored_shot_count, 1);
        assertEquals(sqlPlane.state?.rating, 7.5);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W06-02 replay: a byte-identical copy under a fresh id is a second analysis on every plane (no content dedupe anywhere)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        const a = scored(crypto.randomUUID(), "drive", 4.25, "2026-09-01T10:00:00.000Z");
        const copy = { ...a, id: crypto.randomUUID() };
        await insertRow(tx, userId, a);
        await insertRow(tx, userId, copy);
        const { sqlPlane } = await assertAllPlanes(tx, userId, [a, copy], "content copy");
        assertEquals(sqlPlane.state?.scored_shot_count, 2);
        assertEquals(sqlPlane.view[0]?.sampled_count, 2);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W06-02 clock: rollback (later insert, earlier captured_at), far-past and far-future instants and same-instant ties agree on every plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        // 7 newest fill the form window; the rolled-back row (inserted last,
        // captured first) must fall OUT of the window, not displace the newest.
        const analyses: Analysis[] = [];
        for (let i = 0; i < 7; i += 1) {
          analyses.push(
            scored(crypto.randomUUID(), "serve", 6 + i * 0.5, `2026-09-0${i + 1}T12:00:00.000Z`),
          );
        }
        for (const a of analyses) await insertRow(tx, userId, a);
        const rolledBack = scored(crypto.randomUUID(), "serve", 0, "2026-08-01T00:00:00.000Z");
        await insertRow(tx, userId, rolledBack);
        analyses.push(rolledBack);
        const windowed = await assertAllPlanes(tx, userId, analyses, "clock rollback");
        assert(
          windowed.sqlPlane.projection !== null && windowed.sqlPlane.projection.rating > 6,
          "the 0.00 rolled-back capture must not enter the form window",
        );

        // outside shots_captured_at_bounds ([2000-01-01, 2100-01-01)) the table
        // refuses the row — the definition never sees year-0001/9999 evidence
        for (
          const iso of [
            "0001-01-01T00:00:00.000Z",
            "9999-12-31T23:59:59.000Z",
            "2100-01-01T00:00:00.000Z",
          ]
        ) {
          await tx.unsafe("savepoint clock");
          await assertRejects(
            () => insertRow(tx, userId, scored(crypto.randomUUID(), "lob", 3, iso)),
            Error,
            "shots_captured_at_bounds",
          );
          await tx.unsafe("rollback to savepoint clock");
        }
        // the extreme ADMISSIBLE instants + a same-instant tie on a second technique
        const tieInstant = "2099-12-31T23:59:59.999Z";
        const extra = [
          scored(crypto.randomUUID(), "lob", 3, "2000-01-01T00:00:00.000Z"),
          scored("00000000-0000-4000-8000-000000000001", "lob", 9, tieInstant),
          scored("00000000-0000-4000-8000-000000000002", "lob", 1, tieInstant),
        ];
        for (const a of extra) await insertRow(tx, userId, a);
        await assertAllPlanes(tx, userId, [...analyses, ...extra], "far clocks + tie");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W06-02 unscored evidence: low_confidence / null-score / demo rows never rank and never fabricate Bronze on any plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        const unscored: Analysis[] = [
          {
            id: crypto.randomUUID(),
            shotType: "dink",
            overallScore: null,
            resultKind: "low_confidence",
            capturedAt: "2026-09-01T00:00:00.000Z",
            source: "real",
          },
          {
            id: crypto.randomUUID(),
            shotType: "drive",
            overallScore: null,
            resultKind: "low_confidence",
            capturedAt: "2026-09-02T00:00:00.000Z",
            source: "real",
          },
        ];
        for (const a of unscored) await insertRow(tx, userId, a);
        // a fixture/demo analysis is refused by the table (source = 'real' check)
        // and by the definition alike
        const demo: Analysis = {
          id: crypto.randomUUID(),
          shotType: "dink",
          overallScore: 8,
          resultKind: "scored",
          capturedAt: "2026-09-02T00:00:00.000Z",
          source: "demo",
        };
        await tx.unsafe("savepoint demo");
        await assertRejects(() => insertRow(tx, userId, demo), Error, "shots_source_check");
        await tx.unsafe("rollback to savepoint demo");
        assertEquals(computePlayerRank([demo]), null, "demo evidence must not rank");
        const { sqlPlane } = await assertAllPlanes(tx, userId, unscored, "unscored only");
        assertEquals(sqlPlane.state, null);
        assertEquals(sqlPlane.view, []);

        // one real scored row ranks; the unscored rows still contribute nothing
        const real = scored(crypto.randomUUID(), "dink", 2, "2026-09-03T00:00:00.000Z");
        await insertRow(tx, userId, real);
        const ranked = await assertAllPlanes(tx, userId, [...unscored, real], "one scored");
        assertEquals(ranked.sqlPlane.state?.scored_shot_count, 1);
        assertEquals(ranked.sqlPlane.state?.rating, 2);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W06-02 partial state: deleting the only scored shot recomputes rank state to unranked on every plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        const a = scored(crypto.randomUUID(), "dink", 5, "2026-09-01T00:00:00.000Z");
        const b = scored(crypto.randomUUID(), "drive", 9, "2026-09-02T00:00:00.000Z");
        await insertRow(tx, userId, a);
        await insertRow(tx, userId, b);
        await assertAllPlanes(tx, userId, [a, b], "two techniques");
        await tx.unsafe(`delete from public.shots where id = $1`, [b.id]);
        const one = await assertAllPlanes(tx, userId, [a], "one left");
        assertEquals(one.sqlPlane.state?.technique_count, 1);
        await tx.unsafe(`delete from public.shots where id = $1`, [a.id]);
        const none = await assertAllPlanes(tx, userId, [], "none left");
        assertEquals(none.sqlPlane.state, null, "stale rank state must not survive its evidence");
      });
    } finally {
      await sql.end();
    }
  },
});
