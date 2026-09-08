/**
 * W06-01 ADVERSARY (round 3, candidate devin/pp/w06-01/impl-r3 @ e4fda763) —
 * cross-plane attacks: the same rows through computePlayerRank (TS), the real
 * POST /v1/shots:sync parser (Edge, routesHarness) and PostgreSQL 16 with
 * every migration applied (SQL). Postgres tests are `ignore`d without
 * PICKLE_AUDIT_PG_URL (a skipped test is NOT a pass).
 *
 * Run: PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *      deno test -A --config supabase/functions/api/__wf__/deno.json \
 *        supabase/functions/api/__wf__/attack_w06_01_r3_planes.test.ts
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION } from "../../../../packages/shared-types/src/scoringDefinition.js";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

interface Row {
  id: string;
  shotType: string;
  overallScore: number | null;
  resultKind: string;
  capturedAt: string;
  source?: string;
}

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ID_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

function row(id: string, shotType: string, capturedAt: string, overallScore: number): Row {
  return { id, shotType, overallScore, resultKind: "scored", capturedAt, source: "real" };
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

/** Owner insert, score and timestamp bound as JSON text (Postgres casts). */
async function insertRow(tx: Sql, userId: string, a: Row): Promise<string | null> {
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
        a.source ?? "real",
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

async function sqlRating(tx: Sql, userId: string): Promise<number | null> {
  const state = await tx.unsafe(
    `select rating::text as rating from public.player_rank_state where user_id = $1`,
    [userId],
  );
  return state.length === 0 ? null : Number(state[0].rating);
}

async function sqlCapturedAt(tx: Sql, userId: string, id: string): Promise<string | null> {
  const rows = await tx.unsafe(
    `select to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
       from public.shots where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows.length === 0 ? null : String(rows[0].at);
}

function tsRating(rows: Row[]): number | null {
  return computePlayerRank(rows as PlayerRankAnalysisInput[])?.rating ?? null;
}

// ─── Edge ingress (real handler, RPC stubbed to "accepted") ─────────────────

const h = await loadHarness();

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function edgeAdmits(a: Row): Promise<{ accepted: boolean; code: string | null }> {
  const userId = "e1111111-1111-4111-8111-111111111111";
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: fakeGoogleIdToken(userId),
      ip: freshIp(),
      body: {
        shots: [
          {
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
              appVersion: "1.0.0",
              modelBundleVersion: "bundle-1",
              poseModelVersion: "pose-1",
              paddleModelVersion: "paddle-1",
              strokeDetectorVersion: "stroke-1",
              phaseModelVersion: "phase-1",
              scoringModelVersion: "scoring-1",
              shotConfigVersion: "config-1",
            },
          },
        ],
      },
    }),
  );
  assertEquals(response.status, 200, "batch processed");
  const body = (await response.json()) as {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string }>;
  };
  return {
    accepted: (body.acceptedIds ?? []).includes(a.id),
    code: body.rejected?.find((r) => r.id === a.id)?.code ?? null,
  };
}

// ─── Attack A: replay survivor rule vs SQL arrival order ────────────────────

Deno.test({
  name:
    "W06-01 r3 attack A: a conflicting replay arriving newest-first ranks the same on SQL as on TS",
  ignore,
  async fn() {
    // The definition's identity.survivor rule is capturedAt ASC — TS keeps
    // {A,10:00,9} whatever the input order. SQL keeps whichever row ARRIVES
    // first (shots_pkey refuses the rest). Same multiset, newest-first
    // arrival: TS says 9/Diamond, SQL says 3/Bronze.
    const early = row(ID_A, "drive", "2026-08-01T10:00:00.000Z", 9);
    const late = row(ID_A, "drive", "2026-08-01T11:00:00.000Z", 3);
    assertEquals(tsRating([early, late]), tsRating([late, early]), "TS is order independent");
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        assertEquals(await insertRow(tx, userId, late), null, "first arrival stored");
        assertEquals(await insertRow(tx, userId, early), "shots_pkey", "replay refused");
        const sqlSide = await sqlRating(tx, userId);
        const tsSide = tsRating([late, early]);
        console.log(`attack A: sql=${sqlSide} ts=${tsSide}`);
        assertEquals(sqlSide, tsSide, "SQL and TS rank the identical multiset identically");
      });
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack B: sub-microsecond rounding at the LOWER bound ──────────────────

const MIN_ROUND_UP = "1999-12-31T23:59:59.9999995Z";
const MAX_ROUND_UP = "2099-12-31T23:59:59.9999995Z";

Deno.test("W06-01 r3 attack B1: TS counts a timestamp that rounds up to 2000-01-01 exactly like the ingress", async () => {
  // TS applies half-even microsecond rounding BEFORE the bounds check and
  // counts this row. The Edge parser checks the bounds on Date.parse
  // milliseconds (…59.999 < 2000-01-01) and refuses it — so the row the
  // definition calls countable never reaches SQL from a device.
  const r = row(ID_A, "drive", MIN_ROUND_UP, 6);
  const ts = tsRating([r]);
  const edge = await edgeAdmits(r);
  console.log(`attack B1: ts=${ts} edge=${JSON.stringify(edge)}`);
  assertEquals(ts !== null, edge.accepted, "TS countability == Edge admission");
});

Deno.test({
  name:
    "W06-01 r3 attack B2: SQL stores the lower-bound round-up row TS counts (so all three planes must agree)",
  ignore,
  async fn() {
    const r = row(ID_A, "drive", MIN_ROUND_UP, 6);
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        const refused = await insertRow(tx, userId, r);
        const stored = await sqlCapturedAt(tx, userId, ID_A);
        console.log(`attack B2: sql refused=${refused} stored=${stored} ts=${tsRating([r])}`);
        assertEquals(refused, null, "SQL stores it (rounds to 2000-01-01T00:00:00.000000Z)");
        assertEquals(stored, "2000-01-01T00:00:00.000000Z");
        assertEquals(await sqlRating(tx, userId), tsRating([r]), "SQL == TS");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test("W06-01 r3 attack B3: the ingress refuses what SQL refuses at the UPPER bound (no Edge-admitted, SQL-refused row)", async () => {
  // A row the Edge admits but shots_captured_at_bounds refuses reaches the
  // client as shot.write_failed — a TRANSIENT code the outbox retries
  // forever with its attempt budget intact.
  const r = row(ID_A, "drive", MAX_ROUND_UP, 6);
  const edge = await edgeAdmits(r);
  console.log(`attack B3: edge=${JSON.stringify(edge)} ts=${tsRating([r])}`);
  assertEquals(tsRating([r]), null, "TS abstains (rounds to 2100-01-01)");
  assertEquals(edge.accepted, false, "Edge refuses a row SQL can never store");
});

Deno.test({
  name: "W06-01 r3 attack B4: SQL refuses the upper-bound round-up row (shots_captured_at_bounds)",
  ignore,
  async fn() {
    const r = row(ID_A, "drive", MAX_ROUND_UP, 6);
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        assertEquals(await insertRow(tx, userId, r), "shots_captured_at_bounds");
      });
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack C: embedded NUL through the production write path ───────────────

Deno.test("W06-01 r3 attack C1: the ingress refuses a shot type Postgres text can never hold", async () => {
  const r = row(ID_A, "drive\u0000", "2026-08-01T10:00:00.000Z", 6);
  const edge = await edgeAdmits(r);
  console.log(`attack C1: edge=${JSON.stringify(edge)} ts=${tsRating([r])}`);
  assertEquals(tsRating([r]), null, "TS abstains on embedded NUL");
  assertEquals(edge.accepted, false, "Edge refuses embedded NUL before the RPC");
});

Deno.test({
  name:
    "W06-01 r3 attack C2: the named SQL check (sqlstate 22021) is what refuses an embedded NUL on the RPC path (jsonb)",
  ignore,
  async fn() {
    // apply_synced_shot takes jsonb; PostgREST parses the request body into
    // jsonb, where "\u0000" is refused by the JSON parser (22P05), not by the
    // text encoder (22021) the definition names.
    const named = SCORING_DEFINITION.components.countability.serverIngress.shotType.find(
      (c) => c.layer === "sql",
    )?.check;
    const sql = postgres(PG_URL);
    try {
      let viaText: string | null = null;
      let viaJsonb: string | null = null;
      await withRollback(sql, async (tx) => {
        const userId = await newUser(tx);
        viaText = await insertRow(
          tx,
          userId,
          row(ID_A, "drive\u0000", "2026-08-01T10:00:00.000Z", 6),
        );
      });
      try {
        await sql.unsafe(`select ($1::text)::jsonb`, ['{"shotType":"drive\\u0000"}']);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        viaJsonb = typeof code === "string" ? `sqlstate ${code}` : String(error);
      }
      console.log(`attack C2: named=${named} viaText=${viaText} viaJsonb=${viaJsonb}`);
      assertEquals(viaText, named, "direct text insert is refused by the named check");
      assertEquals(viaJsonb, named, "the RPC (jsonb) path is refused by the named check");
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack D: score quantization TS (decimal text) vs SQL numeric(4,2) ─────

Deno.test({
  name: "W06-01 r3 attack D: toHundredths agrees with numeric(4,2) for 400 adversarial doubles",
  ignore,
  async fn() {
    // Ties at the third decimal, binary-unrepresentable decimals, values a
    // hair under 10 and over 0, and shortest-round-trip strings with 17 digits.
    const candidates: number[] = [
      0.005,
      0.015,
      0.025,
      0.035,
      0.045,
      0.055,
      0.065,
      0.075,
      0.085,
      0.095,
      1.005,
      1.015,
      1.045,
      2.675,
      4.185,
      5.005,
      5.015,
      6.255,
      7.125,
      8.345,
      9.995,
      9.994999,
      9.9949999999999999,
      9.999999999999998,
      0.0049999999999999,
      1.0000000000000002,
      0.1 + 0.2,
      0.7 + 0.1,
      1.1 * 3,
      4.35 * 100 / 100,
      9.995000000000001,
      9.994999999999999,
      0.004999999999999999,
      0.005000000000000001,
    ];
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    while (candidates.length < 400) {
      const raw = rnd() * 10;
      const decimals = Math.floor(rnd() * 6) + 1;
      candidates.push(Number(raw.toFixed(decimals)));
      candidates.push(raw);
    }
    const sql = postgres(PG_URL);
    const divergent: string[] = [];
    try {
      for (const score of candidates.filter((s) => s >= 0 && s <= 10)) {
        const text = String(score);
        const pg = await sql.unsafe(`select ((($1::text)::numeric(4,2)) * 100)::int as h`, [text]);
        const sqlHundredths = Number(pg[0].h);
        const ts = computePlayerRank([
          { ...row(ID_A, "drive", "2026-08-01T10:00:00.000Z", 0), overallScore: score },
        ]);
        const tsHundredths = ts === null ? null : Math.round(ts.rating * 100);
        if (tsHundredths !== sqlHundredths) {
          divergent.push(`${text}: ts=${tsHundredths} sql=${sqlHundredths}`);
        }
      }
    } finally {
      await sql.end();
    }
    console.log(`attack D: ${candidates.length} scores, divergent=${divergent.length}`);
    assertEquals(divergent, [], `TS/SQL score quantization diverges:\n${divergent.join("\n")}`);
  },
});

// ─── Attack F: roles against the SQL rank surfaces (allowed AND denied) ─────

Deno.test({
  name:
    "W06-01 r3 attack F: rank state and technique view are owner-only; anon and direct recompute are refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const owner = await newUser(tx);
        const other = await newUser(tx);
        assertEquals(
          await insertRow(tx, owner, row(ID_A, "drive", "2026-08-01T10:00:00.000Z", 8)),
          null,
        );
        assertEquals(
          await insertRow(tx, other, row(ID_B, "drive", "2026-08-01T10:00:00.000Z", 2)),
          null,
        );
        const key = await tx.unsafe(`select public.get_api_request_key() as k`);
        const headers = JSON.stringify({ "x-pickle-api-key": String(key[0].k) });

        const asUser = async (userId: string, withKey: boolean) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
          await tx.unsafe(`select set_config('request.headers', $1, true)`, [
            withKey ? headers : "",
          ]);
        };

        // allowed: the owner, through the API gate, sees exactly their own rank.
        await asUser(owner, true);
        const own = await tx.unsafe(
          `select user_id, rating::text as rating from public.player_rank_state`,
        );
        assertEquals(own.map((r) => `${r.user_id}:${r.rating}`), [`${owner}:8.00`]);
        const view = await tx.unsafe(`select user_id from public.player_technique_rating`);
        assertEquals(view.map((r) => String(r.user_id)), [owner]);

        // denied: the same bearer without the server header sees nothing.
        await asUser(owner, false);
        assertEquals((await tx.unsafe(`select 1 from public.player_rank_state`)).length, 0);
        assertEquals((await tx.unsafe(`select 1 from public.player_technique_rating`)).length, 0);

        // denied: a client may not recompute or write rank state directly.
        await asUser(owner, true);
        for (
          const statement of [
            `select public.recompute_player_rank($1::uuid)`,
            `update public.player_rank_state set rating = 10 where user_id = $1::uuid`,
            `delete from public.player_rank_state where user_id = $1::uuid`,
            `insert into public.player_rank_state (user_id, rating, tier, technique_count, scored_shot_count)
             values ($1::uuid, 10, 'diamond', 1, 1)`,
          ]
        ) {
          await tx.unsafe(`savepoint denied`);
          let code = "";
          try {
            await tx.unsafe(statement, [other]);
          } catch (error) {
            code = String((error as { code?: unknown }).code ?? "");
          }
          await tx.unsafe(`rollback to savepoint denied`);
          assertEquals(code, "42501", `refused: ${statement}`);
        }

        // denied: anon has no path to rank state at all.
        await tx.unsafe(`reset role`);
        await tx.unsafe(`set local role anon`);
        for (const relation of ["public.player_rank_state", "public.player_technique_rating"]) {
          await tx.unsafe(`savepoint anon_read`);
          let code = "";
          try {
            await tx.unsafe(`select 1 from ${relation}`);
          } catch (error) {
            code = String((error as { code?: unknown }).code ?? "");
          }
          await tx.unsafe(`rollback to savepoint anon_read`);
          assertEquals(code, "42501", `anon refused: ${relation}`);
        }
        await tx.unsafe(`reset role`);
      });
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack E: calendar edge instants the grammar admits ────────────────────

Deno.test({
  name:
    "W06-01 r3 attack E: 24:00:00, leap second and Feb-29 rows are treated identically by TS, Edge and SQL",
  ignore,
  async fn() {
    const instants = [
      "2026-08-01T24:00:00.000Z",
      "2026-06-30T23:59:60.000Z",
      "2028-02-29T10:00:00.000Z",
      "2100-02-29T10:00:00.000Z",
      "2026-02-29T10:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ];
    const sql = postgres(PG_URL);
    const disagreements: string[] = [];
    try {
      for (const at of instants) {
        const r = row(ID_B, "serve", at, 6);
        const ts = tsRating([r]) !== null;
        const edge = (await edgeAdmits(r)).accepted;
        let stored = false;
        await withRollback(sql, async (tx) => {
          const userId = await newUser(tx);
          stored = (await insertRow(tx, userId, r)) === null;
        });
        console.log(`attack E: ${at} ts=${ts} edge=${edge} sql=${stored}`);
        if (ts !== edge || stored !== edge) {
          disagreements.push(`${at}: ts=${ts} edge=${edge} sql=${stored}`);
        }
      }
    } finally {
      await sql.end();
    }
    assert(disagreements.length === 0, `plane disagreements:\n${disagreements.join("\n")}`);
  },
});
