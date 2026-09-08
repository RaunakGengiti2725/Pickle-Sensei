/**
 * W06-01 adversarial attack — feed the candidate's golden fixture (the
 * "identical inputs" it promises for the SQL plane) through the ACTUAL SQL
 * rank implementation (20260831130000_form_weighted_rank.sql, via the shots
 * insert trigger) and compare `player_rank_state` / `player_technique_rating`
 * with each case's `expected`. Then probe the boundaries where the Edge
 * parser (parseSyncShot) admits an input the definition does not pin.
 *
 * Setup (same as be-edge-routes-shots-rank.test.ts):
 *   docker run -d --name pickle-attack-pg -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker exec pickle-attack-pg psql -U postgres -c 'create database w06'
 *   docker cp supabase/tests pickle-attack-pg:/tests && docker cp supabase/migrations pickle-attack-pg:/migrations
 *   docker exec pickle-attack-pg bash -c 'psql -U postgres -d w06 -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -d w06 -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/w06 \
 *     deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/attack_w06_01_sql_golden_parity.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true) — a
 * skipped run is NOT a pass.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import golden from "../../../../packages/shared-types/fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION } from "../../../../packages/shared-types/src/scoringDefinition.ts";

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

interface FixtureAnalysis {
  id?: string;
  shotType: string;
  overallScore: number | null;
  resultKind: string;
  capturedAt: string;
  source?: string;
}

/** Inserts one analysis as the owner (superuser: no permit gate, no free
 * limit — exactly like the candidate's own parity harness). Returns the SQL
 * constraint that refused the row, or null when it was stored. */
async function insertAnalysis(
  tx: Sql,
  userId: string,
  a: FixtureAnalysis,
  scoreText: string | null = a.overallScore === null ? null : String(a.overallScore),
): Promise<string | null> {
  await tx.unsafe(`savepoint row_insert`);
  try {
    await tx.unsafe(
      `insert into public.shots
         (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
          overall_score, analysis_confidence, result_kind, source,
          app_version, model_bundle_version, pose_model_version, paddle_model_version,
          stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values ($1, $2, $3, 'side', $4, 0, 100, 200, $5::numeric, 0.9, $6, $7,
               '1', '1', '1', '1', '1', '1', '1', '1')`,
      [
        a.id ?? crypto.randomUUID(),
        userId,
        a.shotType,
        a.capturedAt,
        scoreText,
        a.resultKind,
        a.source ?? "real",
      ],
    );
    await tx.unsafe(`release savepoint row_insert`);
    return null;
  } catch (error) {
    await tx.unsafe(`rollback to savepoint row_insert`);
    const message = error instanceof Error ? error.message : String(error);
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    return constraint ?? message;
  }
}

interface SqlRank {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: Array<{ shotType: string; score: number; capturedAt: string; sampledCount: number }>;
}

async function readSqlRank(tx: Sql, userId: string): Promise<SqlRank | null> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = '${userId}'`,
  );
  if (state.length === 0) return null;
  const view = await tx.unsafe(
    `select shot_type, score::text as score, captured_at, sampled_count
       from public.player_technique_rating where user_id = '${userId}'
       order by score desc, shot_type asc`,
  );
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
    })),
  };
}

function projectExpected(expected: (typeof golden.cases)[number]["expected"]): SqlRank | null {
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

Deno.test({
  name: "W06-01 attack: every golden case reproduces on the SQL plane (player_rank_state/player_technique_rating)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const mismatches: string[] = [];
    try {
      assertEquals(golden.definitionVersion, SCORING_DEFINITION.version);
      for (const goldenCase of golden.cases) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(
            `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
          );
          const refused: string[] = [];
          for (const a of goldenCase.analyses as FixtureAnalysis[]) {
            const constraint = await insertAnalysis(tx, userId, a);
            if (constraint) refused.push(`${a.id ?? "?"}:${constraint}`);
          }
          const actual = await readSqlRank(tx, userId);
          const expected = projectExpected(goldenCase.expected);
          const same = JSON.stringify(actual) === JSON.stringify(expected);
          const line =
            `${goldenCase.id}: ${same ? "MATCH" : "MISMATCH"} refused=[${refused.join(", ")}]` +
            (same
              ? ""
              : `\n  sql      = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`);
          console.log(line);
          if (!same) mismatches.push(line);
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(
      mismatches,
      [],
      `golden cases the SQL plane does not reproduce:\n${mismatches.join("\n")}`,
    );
  },
});

const AT = "2026-08-05T10:00:00.000Z";

Deno.test({
  name: "W06-01 attack: three-decimal half-tie scores (admitted by parseSyncShot) rank differently in SQL and TS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const divergences: string[] = [];
    try {
      // parseSyncShot accepts ANY finite 0..10 number. numeric(4,2) rounds
      // 1.005 → 1.01 on insert; computePlayerRank does Math.round(100.4999…) = 100.
      for (const text of ["0.145", "1.005", "4.475", "6.005", "8.075", "9.995"]) {
        const userId = crypto.randomUUID();
        await withRollback(sql, async (tx) => {
          await tx.unsafe(
            `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
          );
          const a: FixtureAnalysis = {
            id: "00000000-0000-4000-8000-000000000001",
            shotType: "dink",
            overallScore: Number(text),
            resultKind: "scored",
            capturedAt: AT,
            source: "real",
          };
          const refused = await insertAnalysis(tx, userId, a, text);
          assertEquals(refused, null, `${text} must be storable`);
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
  name: "W06-01 attack: an uppercase uuid (admitted by parseSyncShot's /i regex) breaks the same-instant tie differently in SQL and TS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const rows: FixtureAnalysis[] = [
        {
          id: "F0000000-0000-4000-8000-000000000001",
          shotType: "dink",
          overallScore: 8,
          resultKind: "scored",
          capturedAt: AT,
          source: "real",
        },
        {
          id: "e0000000-0000-4000-8000-000000000002",
          shotType: "dink",
          overallScore: 2,
          resultKind: "scored",
          capturedAt: AT,
          source: "real",
        },
      ];
      await withRollback(sql, async (tx) => {
        await tx.unsafe(
          `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
        );
        for (const a of rows) assertEquals(await insertAnalysis(tx, userId, a), null);
        const sqlRank = await readSqlRank(tx, userId);
        const tsRank = computePlayerRank(rows as PlayerRankAnalysisInput[]);
        // Postgres orders uuid by bytes (f0… > e0…): 8.0 is newest → 5.20.
        assertEquals(sqlRank?.rating, 5.2, "SQL byte order");
        assertEquals(tsRank?.rating, sqlRank?.rating, "TS must agree with SQL on the tie-break");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W06-01 attack: a replayed analysis (same id twice) is ONE row in SQL but TWO in computePlayerRank",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const dink: FixtureAnalysis = {
        id: "00000000-0000-4000-8000-000000000001",
        shotType: "dink",
        overallScore: 8,
        resultKind: "scored",
        capturedAt: AT,
        source: "real",
      };
      const serve: FixtureAnalysis = {
        id: "00000000-0000-4000-8000-000000000002",
        shotType: "serve",
        overallScore: 2,
        resultKind: "scored",
        capturedAt: AT,
        source: "real",
      };
      await withRollback(sql, async (tx) => {
        await tx.unsafe(
          `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
        );
        assertEquals(await insertAnalysis(tx, userId, dink), null);
        assertEquals(await insertAnalysis(tx, userId, serve), null);
        assertEquals(await insertAnalysis(tx, userId, dink), "shots_pkey");
        const sqlRank = await readSqlRank(tx, userId);
        assertEquals(sqlRank?.rating, 5, "SQL: replay is a no-op");
        assertEquals(sqlRank?.scoredAnalysisCount, 2);
        const tsRank = computePlayerRank([dink, serve, dink] as PlayerRankAnalysisInput[]);
        assertEquals(
          tsRank?.scoredAnalysisCount,
          sqlRank?.scoredAnalysisCount,
          "TS counts the replay",
        );
        assertEquals(tsRank?.rating, sqlRank?.rating, "TS rating inflated by the replay");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W06-01 attack: captured_at outside SQL bounds — SQL refuses the row, TS ranks it, definition says nothing",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const userId = crypto.randomUUID();
      const rows: FixtureAnalysis[] = [
        {
          id: "00000000-0000-4000-8000-000000000001",
          shotType: "dink",
          overallScore: 8,
          resultKind: "scored",
          capturedAt: "2150-01-01T00:00:00.000Z",
          source: "real",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          shotType: "dink",
          overallScore: 2,
          resultKind: "scored",
          capturedAt: "1999-12-31T23:59:59.000Z",
          source: "real",
        },
      ];
      await withRollback(sql, async (tx) => {
        await tx.unsafe(
          `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
        );
        for (const a of rows) {
          assertEquals(await insertAnalysis(tx, userId, a), "shots_captured_at_bounds");
        }
        const sqlRank = await readSqlRank(tx, userId);
        const tsRank = computePlayerRank(rows as PlayerRankAnalysisInput[]);
        assertEquals(sqlRank, null, "SQL has no evidence");
        assertEquals(tsRank, sqlRank, "TS must agree with SQL: no evidence → null");
      });
    } finally {
      await sql.end();
    }
  },
});
