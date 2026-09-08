/**
 * W06-01 — the golden fixture (packages/shared-types/fixtures/scoring/
 * player-rank.golden.json) checked on every plane that ranks a player:
 *
 *   TS    computePlayerRank (mobile + shared-types), run under Deno here;
 *   Edge  POST /v1/shots:sync ingress (parseSyncShot) must accept every case
 *         row and refuse every `rejectedInputs` row, and GET /v1/rank must
 *         reproduce `expected` from the SQL view rows (saved state present or
 *         absent → inline fallback);
 *   SQL   public.shots insert trigger → player_rank_state /
 *         player_technique_rating (20260831130000_form_weighted_rank.sql)
 *         must store EVERY case row and reproduce `expected`; every
 *         `rejectedInputs` row whose `refusedBy.layer` is `sql` must be
 *         refused by exactly the named check.
 *
 * Postgres setup (same as be-edge-routes-shots-rank.test.ts):
 *   docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
 *   docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/w06_01_golden_parity.test.ts
 *
 * The TS-plane and Edge-ingress tests always run; the SQL and GET /v1/rank
 * tests are skipped (ignore: true) without PICKLE_AUDIT_PG_URL — a skipped
 * run is NOT a pass.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import golden from "../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import {
  PLAYER_RANK_GOLDEN_SCHEMA_VERSION,
  SCORING_DEFINITION,
  type PlayerRankGoldenAnalysis,
  type PlayerRankGoldenExpected,
  type PlayerRankGoldenFixture,
} from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const fixture: PlayerRankGoldenFixture = golden;

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

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

/** Inserts one fixture row as the owner (no permit gate, no free limit) with
 * the score and the timestamp bound as their JSON text — what the sync
 * payload carries — so Postgres, not the driver, performs both casts.
 * Returns the constraint (or `sqlstate <code>`) that refused the row, or
 * null when it was stored. */
async function insertAnalysis(
  tx: Sql,
  userId: string,
  a: PlayerRankGoldenAnalysis,
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
        a.id,
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

interface SqlTechnique {
  shotType: string;
  score: number;
  capturedAt: string;
  sampledCount: number;
  confidenceWeight: number;
}

interface SqlRank {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: SqlTechnique[];
}

async function readSqlRank(tx: Sql, userId: string): Promise<SqlRank | null> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = $1`,
    [userId],
  );
  const view = await tx.unsafe(
    `select shot_type, score::text as score, captured_at, sampled_count, confidence_weight
       from public.player_technique_rating where user_id = $1
       order by score desc, shot_type asc`,
    [userId],
  );
  if (state.length === 0) {
    assertEquals(view.length, 0, "a technique row without saved rank state");
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
      capturedAt: new Date(row.captured_at as string).toISOString(),
      sampledCount: Number(row.sampled_count),
      confidenceWeight: Number(row.confidence_weight),
    })),
  };
}

/** The subset of `expected` the SQL plane materialises. */
function sqlProjection(expected: PlayerRankGoldenExpected | null):
  | (Omit<SqlRank, "techniques"> & {
      techniques: Omit<SqlTechnique, "confidenceWeight">[];
    })
  | null {
  if (expected === null) return null;
  return {
    rating: expected.rating,
    tier: expected.tier,
    techniqueCount: expected.techniqueCount,
    scoredAnalysisCount: expected.scoredAnalysisCount,
    techniques: expected.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAt: t.capturedAt,
      sampledCount: t.sampledCount,
    })),
  };
}

function stripWeights(rank: SqlRank | null): ReturnType<typeof sqlProjection> {
  if (rank === null) return null;
  return {
    ...rank,
    techniques: rank.techniques.map(({ confidenceWeight: _w, ...t }) => t),
  };
}

// ─── TS plane (Deno runtime) ─────────────────────────────────────────────────

Deno.test("W06-01 golden: fixture pins the canonical definition version and schema", () => {
  assertEquals(fixture.schemaVersion, PLAYER_RANK_GOLDEN_SCHEMA_VERSION);
  assertEquals(fixture.definitionVersion, SCORING_DEFINITION.version);
  assertEquals(SCORING_DEFINITION.version, "rank-form-weighted-v2");
});

Deno.test("W06-01 golden: every case reproduces through computePlayerRank under Deno", () => {
  for (const goldenCase of fixture.cases) {
    const actual = computePlayerRank(goldenCase.analyses as PlayerRankAnalysisInput[]);
    assertEquals(JSON.parse(JSON.stringify(actual)), goldenCase.expected, goldenCase.id);
  }
  for (const rejected of fixture.rejectedInputs) {
    assertEquals(
      computePlayerRank([rejected.analysis as PlayerRankAnalysisInput]),
      null,
      `${rejected.id} must abstain on the TS plane`,
    );
  }
});

// ─── Edge ingress (parseSyncShot, real handler via routesHarness) ───────────

const h = await loadHarness();

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

/** The wire shape apps/mobile/src/data/sync.ts toSyncPayload builds for one
 * analysis; the fixture's optional `source` maps to the definition's
 * `absentSourceCountsAs` because the client always sends it. */
function syncPayload(a: PlayerRankGoldenAnalysis): Record<string, unknown> {
  return {
    id: a.id,
    source: a.source ?? SCORING_DEFINITION.components.countability.absentSourceCountsAs,
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
    versionVector: VERSION_VECTOR,
  };
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function edgeUser(userId: string): { token: string; ip: string } {
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: freshIp() };
}

async function syncOne(
  userId: string,
  a: PlayerRankGoldenAnalysis,
): Promise<{ accepted: boolean; code: string | null }> {
  const auth = edgeUser(userId);
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { ...auth, body: { shots: [syncPayload(a)] } }),
  );
  assertEquals(response.status, 200, `${a.id}: batch processed`);
  const body = (await response.json()) as {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string }>;
  };
  const accepted = (body.acceptedIds ?? []).includes(a.id);
  const code = body.rejected?.find((r) => r.id === a.id)?.code ?? null;
  return { accepted, code };
}

Deno.test(
  "W06-01 golden: POST /v1/shots:sync admits every case row (identical inputs reach SQL)",
  async () => {
    const refused: string[] = [];
    let userSeq = 0;
    for (const goldenCase of fixture.cases) {
      for (const a of goldenCase.analyses) {
        userSeq += 1;
        const userId = `e0000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
        const { accepted, code } = await syncOne(userId, a);
        if (!accepted) refused.push(`${goldenCase.id}/${a.id}: ${code}`);
      }
    }
    assertEquals(refused, [], `case rows the Edge ingress refused:\n${refused.join("\n")}`);
  },
);

Deno.test(
  "W06-01 golden: POST /v1/shots:sync refuses every rejected input before the database",
  async () => {
    const admitted: string[] = [];
    let userSeq = 0;
    for (const rejected of fixture.rejectedInputs) {
      userSeq += 1;
      const userId = `e1000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
      const { accepted, code } = await syncOne(userId, rejected.analysis);
      if (accepted || code === null || !code.startsWith("shot.")) {
        admitted.push(`${rejected.id}: accepted=${accepted} code=${code}`);
      }
      if (rejected.refusedBy.layer === "edge") {
        assertEquals(code, "shot.invalid_payload", `${rejected.id} is an Edge-layer rule`);
      }
    }
    assertEquals(
      admitted,
      [],
      `rejected inputs the Edge ingress admitted:\n${admitted.join("\n")}`,
    );
  },
);

// ─── SQL plane + Edge GET /v1/rank over the SQL view ────────────────────────

Deno.test({
  name: "W06-01 golden: every case stores all rows and reproduces on the SQL plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const problems: string[] = [];
    try {
      for (const goldenCase of fixture.cases) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
            userId,
            `${userId}@example.com`,
          ]);
          const refused: string[] = [];
          for (const a of goldenCase.analyses) {
            const constraint = await insertAnalysis(tx, userId, a);
            if (constraint) refused.push(`${a.id}:${constraint}`);
          }
          const actual = stripWeights(await readSqlRank(tx, userId));
          const expected = sqlProjection(goldenCase.expected);
          const same = JSON.stringify(actual) === JSON.stringify(expected);
          const line = `${goldenCase.id}: ${same ? "MATCH" : "MISMATCH"} refused=[${refused.join(", ")}]`;
          console.log(line);
          if (!same || refused.length > 0) {
            problems.push(
              `${line}\n  sql      = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`,
            );
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(
      problems,
      [],
      `golden cases the SQL plane does not reproduce:\n${problems.join("\n")}`,
    );
  },
});

Deno.test({
  name: "W06-01 golden: every SQL-layer rejected input is refused by exactly the named check",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const problems: string[] = [];
    try {
      for (const rejected of fixture.rejectedInputs) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
            userId,
            `${userId}@example.com`,
          ]);
          const refusedBy = await insertAnalysis(tx, userId, rejected.analysis);
          const rank = await readSqlRank(tx, userId);
          console.log(
            `${rejected.id}: layer=${rejected.refusedBy.layer} sql=${refusedBy} rank=${JSON.stringify(rank)}`,
          );
          if (rejected.refusedBy.layer === "sql") {
            if (refusedBy !== rejected.refusedBy.check) {
              problems.push(
                `${rejected.id}: expected ${rejected.refusedBy.check}, got ${refusedBy}`,
              );
            }
            if (rank !== null) problems.push(`${rejected.id}: SQL ranked a refused row`);
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(problems, [], problems.join("\n"));
  },
});

Deno.test({
  name: "W06-01 golden: GET /v1/rank reproduces every ranked case from the SQL view (saved state and inline fallback)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const problems: string[] = [];
    try {
      let userSeq = 0;
      for (const goldenCase of fixture.cases) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
            userId,
            `${userId}@example.com`,
          ]);
          for (const a of goldenCase.analyses) {
            assertEquals(await insertAnalysis(tx, userId, a), null, `${goldenCase.id}/${a.id}`);
          }
          const rank = await readSqlRank(tx, userId);
          const viewRows = (rank?.techniques ?? []).map((t) => ({
            user_id: userId,
            shot_type: t.shotType,
            score: t.score,
            captured_at: t.capturedAt,
            sampled_count: t.sampledCount,
            confidence_weight: t.confidenceWeight,
          }));
          const stateRows =
            rank === null
              ? []
              : [
                  {
                    user_id: userId,
                    rating: rank.rating,
                    tier: rank.tier,
                    technique_count: rank.techniqueCount,
                    scored_shot_count: rank.scoredAnalysisCount,
                    updated_at: "2026-09-01T00:00:00.000Z",
                  },
                ];
          for (const mode of ["saved-state", "inline-fallback"] as const) {
            userSeq += 1;
            const edgeUserId = `e2000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
            const auth = edgeUser(edgeUserId);
            h.tables.player_technique_rating = viewRows;
            h.tables.player_rank_state = mode === "saved-state" ? stateRows : [];
            const response = await h.handler(userRequest("GET", "/v1/rank", auth));
            assertEquals(response.status, 200, `${goldenCase.id} ${mode}`);
            const body = (await response.json()) as {
              rank: {
                rating: number;
                tier: string;
                techniqueCount: number;
                techniques: Array<{ shot_type: string; score: number; sampled_count: number }>;
              } | null;
            };
            const expected = goldenCase.expected;
            const actual =
              body.rank === null
                ? null
                : {
                    rating: body.rank.rating,
                    tier: body.rank.tier,
                    techniqueCount: body.rank.techniqueCount,
                    techniques: body.rank.techniques.map((t) => ({
                      shotType: t.shot_type,
                      score: t.score,
                      sampledCount: t.sampled_count,
                    })),
                  };
            const want =
              expected === null
                ? null
                : {
                    rating: expected.rating,
                    tier: expected.tier,
                    techniqueCount: expected.techniqueCount,
                    techniques: expected.techniques.map((t) => ({
                      shotType: t.shotType,
                      score: t.score,
                      sampledCount: t.sampledCount,
                    })),
                  };
            const same = JSON.stringify(actual) === JSON.stringify(want);
            console.log(`${goldenCase.id} [${mode}]: ${same ? "MATCH" : "MISMATCH"}`);
            if (!same) {
              problems.push(
                `${goldenCase.id} [${mode}]\n  edge     = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(want)}`,
              );
            }
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(problems, [], `cases GET /v1/rank does not reproduce:\n${problems.join("\n")}`);
  },
});

// ─── Boundary probes the r1 adversary raised: TS must agree with SQL ────────

const AT = "2026-08-05T10:00:00.000Z";

function row(
  id: string,
  shotType: string,
  overallScore: number,
  capturedAt = AT,
): PlayerRankGoldenAnalysis {
  return { id, shotType, overallScore, resultKind: "scored", capturedAt, source: "real" };
}

Deno.test({
  name: "W06-01 golden: half-tie three-decimal scores rank identically in SQL and TS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const divergences: string[] = [];
    try {
      for (const text of ["0.145", "1.005", "4.475", "6.005", "8.075", "9.995", "0.005", "9.999"]) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
            userId,
            `${userId}@example.com`,
          ]);
          const a = row("00000000-0000-4000-8000-000000000001", "dink", Number(text));
          assertEquals(await insertAnalysis(tx, userId, a), null, `${text} must be storable`);
          const sqlRank = await readSqlRank(tx, userId);
          const tsRank = computePlayerRank([a as PlayerRankAnalysisInput]);
          if (sqlRank?.rating !== tsRank?.rating) {
            divergences.push(`${text}: sql=${sqlRank?.rating} ts=${tsRank?.rating}`);
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(divergences, [], `SQL vs TS on half ties:\n${divergences.join("\n")}`);
  },
});

Deno.test({
  name: "W06-01 golden: an uppercase uuid breaks a same-instant tie the same way in SQL and TS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const rows = [
        row("F0000000-0000-4000-8000-000000000001", "dink", 8),
        row("e0000000-0000-4000-8000-000000000002", "dink", 2),
      ];
      await withRollback(sql, async (tx) => {
        await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
          userId,
          `${userId}@example.com`,
        ]);
        for (const a of rows) assertEquals(await insertAnalysis(tx, userId, a), null);
        const sqlRank = await readSqlRank(tx, userId);
        const tsRank = computePlayerRank(rows as PlayerRankAnalysisInput[]);
        assertEquals(sqlRank?.rating, 5.2, "SQL uuid byte order: f0… is newest");
        assertEquals(tsRank?.rating, sqlRank?.rating);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W06-01 golden: a replayed analysis (same id twice) is one row in SQL and one analysis in TS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const dink = row("00000000-0000-4000-8000-000000000001", "dink", 8);
      const serve = row("00000000-0000-4000-8000-000000000002", "serve", 2);
      await withRollback(sql, async (tx) => {
        await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
          userId,
          `${userId}@example.com`,
        ]);
        assertEquals(await insertAnalysis(tx, userId, dink), null);
        assertEquals(await insertAnalysis(tx, userId, serve), null);
        assertEquals(await insertAnalysis(tx, userId, dink), "shots_pkey");
        const sqlRank = await readSqlRank(tx, userId);
        const tsRank = computePlayerRank([dink, serve, dink] as PlayerRankAnalysisInput[]);
        assertEquals(sqlRank?.rating, 5);
        assertEquals(sqlRank?.scoredAnalysisCount, 2);
        assertEquals(tsRank?.scoredAnalysisCount, sqlRank?.scoredAnalysisCount);
        assertEquals(tsRank?.rating, sqlRank?.rating);
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W06-01 golden: captured_at outside the shots bounds is no evidence on SQL and TS alike",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const rows = [
        row("00000000-0000-4000-8000-000000000001", "dink", 8, "2150-01-01T00:00:00.000Z"),
        row("00000000-0000-4000-8000-000000000002", "dink", 2, "1999-12-31T23:59:59.000Z"),
      ];
      await withRollback(sql, async (tx) => {
        await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
          userId,
          `${userId}@example.com`,
        ]);
        for (const a of rows) {
          assertEquals(await insertAnalysis(tx, userId, a), "shots_captured_at_bounds");
        }
        assertEquals(await readSqlRank(tx, userId), null);
        assertEquals(computePlayerRank(rows as PlayerRankAnalysisInput[]), null);
      });
    } finally {
      await sql.end();
    }
  },
});
