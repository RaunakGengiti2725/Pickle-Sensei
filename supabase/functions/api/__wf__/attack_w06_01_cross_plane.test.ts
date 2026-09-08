/**
 * W06-01 ADVERSARY — cross-plane attacks on the canonical scoring definition
 * (candidate devin/pp/w06-01/impl-r2 @ 9c47cf07): TS computePlayerRank vs
 * Edge POST /v1/shots:sync ingress vs SQL public.shots → player_rank_state /
 * player_technique_rating vs GET /v1/rank.
 *
 * Every test asserts the promise "identical inputs rank identically on every
 * plane, and every row the TS plane abstains on is refused by ingress (and
 * vice versa)".  A failing test is a confirmed break; a passing test is an
 * attack that did not break anything.  Nothing here modifies the candidate's
 * code, fixtures or tests.
 *
 * Postgres setup (same as w06_01_golden_parity.test.ts):
 *   docker run -d --name pickle-audit -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-audit:/tests && docker cp supabase/migrations pickle-audit:/migrations
 *   docker exec pickle-audit bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
 *     deno test -A --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/attack_w06_01_cross_plane.test.ts
 *
 * SQL-backed tests are skipped (ignore: true) without PICKLE_AUDIT_PG_URL —
 * a skipped run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
  type PlayerRankSummary,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION } from "../../../../packages/shared-types/src/scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

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

interface Row {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: "scored" | "low_confidence";
}

function scored(id: string, shotType: string, capturedAt: string, overallScore: number): Row {
  return { id, shotType, capturedAt, overallScore, resultKind: "scored" };
}

function tsInput(row: Row): PlayerRankAnalysisInput {
  return { ...row, source: "real" };
}

/** Owner insert with score + timestamp bound as their JSON text (what the
 * sync payload carries through apply_synced_shot's `->>` casts).  Returns the
 * constraint / sqlstate that refused the row or null when stored. */
async function insertRow(tx: Sql, userId: string, row: Row): Promise<string | null> {
  await tx.unsafe(`savepoint row_insert`);
  try {
    await tx.unsafe(
      `insert into public.shots
         (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
          overall_score, analysis_confidence, result_kind, source,
          app_version, model_bundle_version, pose_model_version, paddle_model_version,
          stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values ($1, $2, $3, 'side', $4::text::timestamptz, 0, 100, 200, $5::numeric, 0.9, $6, 'real',
               '1', '1', '1', '1', '1', '1', '1', '1')`,
      [
        row.id,
        userId,
        row.shotType,
        row.capturedAt,
        row.overallScore === null ? null : String(row.overallScore),
        row.resultKind,
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

interface SqlRank {
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: Array<{ shotType: string; score: number; sampledCount: number }>;
}

async function readSqlRank(tx: Sql, userId: string): Promise<SqlRank | null> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = $1`,
    [userId],
  );
  const view = await tx.unsafe(
    `select shot_type, score::text as score, sampled_count
       from public.player_technique_rating where user_id = $1
       order by score desc, shot_type asc`,
    [userId],
  );
  if (state.length === 0) return null;
  return {
    rating: Number(state[0].rating),
    tier: String(state[0].tier),
    techniqueCount: Number(state[0].technique_count),
    scoredAnalysisCount: Number(state[0].scored_shot_count),
    techniques: view.map((r) => ({
      shotType: String(r.shot_type),
      score: Number(r.score),
      sampledCount: Number(r.sampled_count),
    })),
  };
}

function tsProjection(summary: PlayerRankSummary | null): SqlRank | null {
  if (summary === null) return null;
  return {
    rating: summary.rating,
    tier: summary.tier,
    techniqueCount: summary.techniqueCount,
    scoredAnalysisCount: summary.scoredAnalysisCount,
    techniques: summary.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      sampledCount: t.sampledCount ?? 0,
    })),
  };
}

async function seedUser(tx: Sql): Promise<string> {
  const userId = crypto.randomUUID();
  await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    `${userId}@example.com`,
  ]);
  return userId;
}

// ─── Edge ingress (real handler, fake PostgREST) ────────────────────────────

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

function syncPayload(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    source: "real",
    analysisPermitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    sessionId: null,
    shotType: row.shotType,
    cameraView: "side",
    capturedAt: row.capturedAt,
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind: row.resultKind,
    overallScore: row.overallScore,
    confidence: 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

let ipCounter = 0;
let userCounter = 0;
function edgeUser(): { userId: string; token: string; ip: string } {
  ipCounter += 1;
  userCounter += 1;
  const userId = `a7000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  return {
    userId,
    token: fakeGoogleIdToken(userId),
    ip: `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
  };
}

/** Sends one row through POST /v1/shots:sync; returns the ingress verdict and
 * the exact `shot` object the Edge forwarded to apply_synced_shot (null when
 * the parser refused it before the database). */
async function syncOne(
  row: Row,
): Promise<{ accepted: boolean; code: string | null; rpcShot: Record<string, unknown> | null }> {
  const auth = edgeUser();
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { ...auth, body: { shots: [syncPayload(row)] } }),
  );
  assertEquals(response.status, 200, `${row.id}: batch processed`);
  const body = (await response.json()) as {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string }>;
  };
  const rpcCall = h.callsTo("rpc/apply_synced_shot")[0];
  const rpcBody = rpcCall?.body as { shot?: Record<string, unknown> } | undefined;
  return {
    accepted: (body.acceptedIds ?? []).includes(row.id),
    code: body.rejected?.find((r) => r.id === row.id)?.code ?? null,
    rpcShot: rpcBody?.shot ?? null,
  };
}

const AT = "2026-08-01T10:00:00.000Z";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ─── Attack 1: clock boundary — sub-microsecond instant at the 2100 ceiling ──

Deno.test({
  name:
    "W06-01 attack: an ingress-admitted capturedAt just under 2100 must be storable by SQL or abstained by TS",
  ignore,
  async fn() {
    const row = scored(ID_A, "drive", "2099-12-31T23:59:59.9999995Z", 6);
    const edge = await syncOne(row);
    assertEquals(edge.accepted, true, "Edge parseSyncShot admits 7 fractional digits");
    assertEquals(edge.rpcShot?.capturedAt, row.capturedAt, "forwarded verbatim to the RPC");
    const ts = computePlayerRank([tsInput(row)]);

    const sql = postgres(PG_URL);
    let refusedBy: string | null = null;
    let sqlRank: SqlRank | null = null;
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        refusedBy = await insertRow(tx, userId, row);
        sqlRank = await readSqlRank(tx, userId);
      });
    } finally {
      await sql.end();
    }
    console.log(
      `edge=${JSON.stringify(edge.code)} sql=${refusedBy} ts=${JSON.stringify(ts?.rating)}`,
    );
    // Parity: either every plane holds the row, or none does.
    assertEquals(
      { sqlStored: refusedBy === null, tsRanked: ts !== null },
      { sqlStored: ts !== null, tsRanked: ts !== null },
      `SQL refused by ${refusedBy} while TS rated ${ts?.rating}; sqlRank=${
        JSON.stringify(sqlRank)
      }`,
    );
  },
});

// ─── Attack 2: microsecond ordering inside one millisecond ──────────────────

Deno.test({
  name:
    "W06-01 attack: same-millisecond rows ordered by microseconds rank identically in SQL and TS",
  ignore,
  async fn() {
    // Both rows pass ingress (1..9 fractional digits are admitted).  SQL
    // orders by captured_at (µs) desc; the SQL-newest row has the SMALLER id.
    const newerByMicros = scored(ID_A, "drive", "2026-08-01T10:00:00.000900Z", 3);
    const olderByMicros = scored(ID_B, "drive", "2026-08-01T10:00:00.000001Z", 9);
    for (const row of [newerByMicros, olderByMicros]) {
      assertEquals((await syncOne(row)).accepted, true, `${row.id} admitted by ingress`);
    }
    const ts = tsProjection(computePlayerRank([tsInput(olderByMicros), tsInput(newerByMicros)]));

    const sql = postgres(PG_URL);
    let sqlRank: SqlRank | null = null;
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        assertEquals(await insertRow(tx, userId, newerByMicros), null);
        assertEquals(await insertRow(tx, userId, olderByMicros), null);
        sqlRank = await readSqlRank(tx, userId);
      });
    } finally {
      await sql.end();
    }
    console.log(`sql=${JSON.stringify(sqlRank)}\nts =${JSON.stringify(ts)}`);
    assertEquals(ts, sqlRank, "identical stored inputs must rank identically");
  },
});

// ─── Attack 3: corrupt text — NUL byte inside shotType ──────────────────────

Deno.test({
  name:
    "W06-01 attack: a shotType with an embedded NUL is refused by ingress or abstained by TS (SQL can never hold it)",
  ignore,
  async fn() {
    const row = scored(ID_A, "drive\u0000", AT, 6);
    const edge = await syncOne(row);
    const ts = computePlayerRank([tsInput(row)]);

    const sql = postgres(PG_URL);
    let rpcCastError: string | null = null;
    let directInsert: string | null = null;
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        directInsert = await insertRow(tx, userId, row);
        if (edge.rpcShot) {
          // The exact jsonb apply_synced_shot(shot jsonb) would receive.
          try {
            await tx.unsafe(`select ($1::jsonb) ->> 'shotType'`, [JSON.stringify(edge.rpcShot)]);
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            rpcCastError = typeof code === "string" ? code : String(error);
          }
        }
      });
    } finally {
      await sql.end();
    }
    console.log(
      `edge accepted=${edge.accepted} code=${edge.code} rpcJsonbCast=${rpcCastError} directInsert=${directInsert} ts=${
        JSON.stringify(ts?.rating)
      }`,
    );
    assert(rpcCastError !== null || directInsert !== null, "Postgres refuses the NUL byte");
    // Parity: a row SQL can never store must be refused at ingress AND
    // abstained on the TS plane.
    assertEquals(
      { edgeAccepted: edge.accepted, tsRanked: ts !== null },
      { edgeAccepted: false, tsRanked: false },
    );
  },
});

// ─── Attack 4: presentation order of equal-score techniques across planes ───

Deno.test({
  name:
    "W06-01 attack: equal-score techniques appear in the same order on TS, SQL and GET /v1/rank",
  ignore,
  async fn() {
    const rows = [
      scored(ID_A, "backhand", AT, 6),
      scored(ID_B, "Dink", AT, 6),
      scored(ID_C, "_serve", AT, 6),
    ];
    const tsOrder = computePlayerRank(rows.map(tsInput))?.techniques.map((t) => t.shotType);

    const sql = postgres(PG_URL);
    let sqlOrder: string[] = [];
    let viewRows: unknown[] = [];
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        for (const row of rows) assertEquals(await insertRow(tx, userId, row), null);
        const view = await tx.unsafe(
          `select shot_type, score, captured_at, sampled_count, confidence_weight
             from public.player_technique_rating where user_id = $1
             order by score desc, shot_type asc`,
          [userId],
        );
        sqlOrder = view.map((r) => String(r.shot_type));
        viewRows = view.map((r) => ({
          user_id: userId,
          shot_type: r.shot_type,
          score: Number(r.score),
          captured_at: new Date(r.captured_at as string).toISOString(),
          sampled_count: Number(r.sampled_count),
          confidence_weight: Number(r.confidence_weight),
        }));
      });
    } finally {
      await sql.end();
    }

    const auth = edgeUser();
    h.tables.player_technique_rating = viewRows;
    h.tables.player_rank_state = [];
    const response = await h.handler(userRequest("GET", "/v1/rank", auth));
    assertEquals(response.status, 200);
    const body = (await response.json()) as {
      rank: { techniques: Array<{ shot_type: string }> } | null;
    };
    const edgeOrder = body.rank?.techniques.map((t) => t.shot_type);
    console.log(
      `ts=${JSON.stringify(tsOrder)} sql=${JSON.stringify(sqlOrder)} edge=${
        JSON.stringify(edgeOrder)
      }`,
    );
    assertEquals(tsOrder, sqlOrder, "TS vs SQL technique order");
    assertEquals(edgeOrder, sqlOrder, "GET /v1/rank vs SQL technique order");
  },
});

// ─── Attack 5: randomized parity fuzz over the storable domain ──────────────

/** Deterministic xorshift32 so a failure reproduces from the printed seed. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

Deno.test({
  name:
    "W06-01 attack: 60 random in-domain histories (2-decimal scores, ms instants, ties, window overflow) rank identically in SQL and TS",
  ignore,
  async fn() {
    const seed = Number(Deno.env.get("W06_ATTACK_SEED") ?? "20260908");
    const next = rng(seed);
    const techniques = ["drive", "dink", "serve", "volley", "third_shot_drop", "lob", "overhead"];
    const sql = postgres(PG_URL);
    const mismatches: string[] = [];
    try {
      for (let round = 0; round < 60; round++) {
        const count = 1 + Math.floor(next() * 14);
        const rows: Row[] = [];
        for (let i = 0; i < count; i++) {
          // Cluster instants so ties (same ms) and window overflow both occur.
          const ms = Date.UTC(2026, 7, 1) + Math.floor(next() * 6) * 3_600_000 +
            Math.floor(next() * 3);
          const score = Math.round(next() * 1000) / 100; // 0.00..10.00
          rows.push(
            scored(
              crypto.randomUUID(),
              techniques[Math.floor(next() * (round < 30 ? 2 : techniques.length))]!,
              new Date(ms).toISOString(),
              score,
            ),
          );
        }
        await withRollback(sql, async (tx) => {
          const userId = await seedUser(tx);
          for (const row of rows) assertEquals(await insertRow(tx, userId, row), null, row.id);
          const sqlRank = await readSqlRank(tx, userId);
          const tsRank = tsProjection(computePlayerRank(rows.map(tsInput)));
          if (JSON.stringify(sqlRank) !== JSON.stringify(tsRank)) {
            mismatches.push(
              `round ${round} (seed ${seed}) rows=${JSON.stringify(rows)}\n  sql=${
                JSON.stringify(sqlRank)
              }\n  ts =${JSON.stringify(tsRank)}`,
            );
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(mismatches, [], mismatches.join("\n"));
  },
});

// ─── Attack 6: replay with conflicting content across planes ────────────────

Deno.test({
  name:
    "W06-01 attack: a replayed id with conflicting content ranks like the SQL primary key (first stored row wins) in any input order",
  ignore,
  async fn() {
    const first = scored(ID_A, "drive", "2026-08-01T10:00:00.000Z", 9);
    const replay = scored(ID_A, "drive", "2026-08-01T11:00:00.000Z", 3);
    const sql = postgres(PG_URL);
    let sqlRank: SqlRank | null = null;
    let replayRefusedBy: string | null = null;
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        assertEquals(await insertRow(tx, userId, first), null);
        replayRefusedBy = await insertRow(tx, userId, replay);
        sqlRank = await readSqlRank(tx, userId);
      });
    } finally {
      await sql.end();
    }
    assertEquals(replayRefusedBy, "shots_pkey");
    const forward = tsProjection(computePlayerRank([tsInput(first), tsInput(replay)]));
    const reversed = tsProjection(computePlayerRank([tsInput(replay), tsInput(first)]));
    console.log(
      `sql=${JSON.stringify(sqlRank)}\nfwd=${JSON.stringify(forward)}\nrev=${
        JSON.stringify(reversed)
      }`,
    );
    assertEquals(forward, sqlRank, "TS (arrival order) vs SQL");
    assertEquals(reversed, sqlRank, "TS (reversed order) vs SQL");
  },
});

// ─── Attack 7: unauthorised roles on the rank surfaces (allowed AND denied) ─

Deno.test({
  name:
    "W06-01 attack: player_rank_state / player_technique_rating are owner-only through the API gate and invisible to anon, other users and direct clients",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      await withRollback(sql, async (tx) => {
        const alice = await seedUser(tx);
        const bob = await seedUser(tx);
        assertEquals(await insertRow(tx, alice, scored(ID_A, "drive", AT, 8)), null);
        assertEquals(await insertRow(tx, bob, scored(ID_B, "drive", AT, 2)), null);
        const [{ key }] = await tx.unsafe(`select public.get_api_request_key() as key`);

        const asRole = async (role: string, sub: string | null, apiKey: string | null) => {
          await tx.unsafe(`savepoint role_switch`);
          await tx.unsafe(`set local role ${role}`);
          if (sub) await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          await tx.unsafe(`select set_config('request.headers', $1, true)`, [
            JSON.stringify(apiKey ? { "x-pickle-api-key": apiKey } : {}),
          ]);
        };
        const restore = async () => {
          await tx.unsafe(`rollback to savepoint role_switch`);
          await tx.unsafe(`reset role`);
        };
        const readAll = async () => {
          const state = await tx.unsafe(
            `select user_id, rating::text as rating from public.player_rank_state`,
          );
          const view = await tx.unsafe(
            `select user_id, shot_type from public.player_technique_rating`,
          );
          return {
            state: state.map((r) => String(r.user_id)),
            view: view.map((r) => String(r.user_id)),
          };
        };
        const denied = async (run: () => Promise<unknown>): Promise<string> => {
          await tx.unsafe(`savepoint denied_probe`);
          try {
            await run();
            await tx.unsafe(`release savepoint denied_probe`);
            return "allowed";
          } catch (error) {
            await tx.unsafe(`rollback to savepoint denied_probe`);
            const code = (error as { code?: unknown }).code;
            return typeof code === "string" ? code : "error";
          }
        };

        // Allowed path: the owner, through the Edge API gate, sees exactly her rows.
        await asRole("authenticated", alice, String(key));
        assertEquals(await readAll(), { state: [alice], view: [alice] });
        await restore();

        // Denied: another user through the gate never sees Alice.
        await asRole("authenticated", bob, String(key));
        assertEquals(await readAll(), { state: [bob], view: [bob] });
        // Denied: the saved rank is not client-writable even for its owner.
        assertEquals(
          await denied(() => tx.unsafe(`update public.player_rank_state set rating = 10`)),
          "42501",
        );
        await restore();

        // Denied: a direct client (valid JWT, no API key) sees nothing.
        await asRole("authenticated", alice, null);
        assertEquals(await readAll(), { state: [], view: [] });
        await restore();

        // Denied: anon has no grant at all.
        await asRole("anon", null, null);
        assertEquals(
          await denied(() => tx.unsafe(`select 1 from public.player_rank_state`)),
          "42501",
        );
        assertEquals(
          await denied(() => tx.unsafe(`select 1 from public.player_technique_rating`)),
          "42501",
        );
        await restore();
      });
    } finally {
      await sql.end();
    }
  },
});

// ─── Attack 8: definition version on the Edge plane ─────────────────────────

Deno.test("W06-01 attack: GET /v1/rank tags its payload with the definition version the fixture pins", async () => {
  const auth = edgeUser();
  h.tables.player_technique_rating = [
    {
      user_id: auth.userId,
      shot_type: "drive",
      score: 6,
      captured_at: AT,
      sampled_count: 1,
      confidence_weight: 1,
    },
  ];
  h.tables.player_rank_state = [
    {
      user_id: auth.userId,
      rating: 6,
      tier: "gold",
      technique_count: 1,
      scored_shot_count: 1,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
  ];
  const response = await h.handler(userRequest("GET", "/v1/rank", auth));
  assertEquals(response.status, 200);
  const body = (await response.json()) as { rank: Record<string, unknown> | null };
  assertNotEquals(body.rank, null);
  console.log(`payload keys=${JSON.stringify(Object.keys(body.rank ?? {}))}`);
  assertEquals(body.rank?.definitionVersion, SCORING_DEFINITION.version);
});

// ─── Attack 9: decimal-text score through the real ingress ──────────────────

Deno.test({
  name:
    "W06-01 attack: a many-decimal wire score quantizes identically after Edge JSON parsing, in SQL and in TS",
  ignore,
  async fn() {
    // Raw wire text: 6.00499999999999999 — as decimal text numeric(4,2) would
    // round it to 6.00; JS parses it to 6.005 and re-serialises "6.005".
    const rawWire = `{"shots":[${
      JSON.stringify(syncPayload(scored(ID_A, "drive", AT, 0))).replace(
        '"overallScore":0',
        '"overallScore":6.00499999999999999',
      )
    }]}`;
    const auth = edgeUser();
    const request = userRequest("POST", "/v1/shots:sync", auth);
    const response = await h.handler(
      new Request(request.url, {
        method: "POST",
        headers: { ...Object.fromEntries(request.headers), "Content-Type": "application/json" },
        body: rawWire,
      }),
    );
    assertEquals(response.status, 200);
    const forwarded =
      (h.callsTo("rpc/apply_synced_shot")[0]?.body as { shot?: { overallScore?: number } })
        ?.shot?.overallScore;
    assertEquals(forwarded, 6.005, "Edge forwards the parsed JS number");

    const stored = scored(ID_A, "drive", AT, forwarded ?? Number.NaN);
    const sql = postgres(PG_URL);
    let sqlRank: SqlRank | null = null;
    try {
      await withRollback(sql, async (tx) => {
        const userId = await seedUser(tx);
        assertEquals(await insertRow(tx, userId, stored), null);
        sqlRank = await readSqlRank(tx, userId);
      });
    } finally {
      await sql.end();
    }
    const ts = tsProjection(computePlayerRank([tsInput(stored)]));
    console.log(`sql=${JSON.stringify(sqlRank)} ts=${JSON.stringify(ts)}`);
    assertEquals(ts, sqlRank);
    assertEquals(ts?.rating, 6.01);
  },
});
