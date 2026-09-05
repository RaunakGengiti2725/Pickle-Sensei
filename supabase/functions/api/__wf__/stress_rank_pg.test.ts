// stress-route-get-v1-rank — POSTGRES-BACKED run of the REAL GET /v1/rank
// handler against docker postgres:16 with every migration applied.
//
// The in-process handler (stressRankHarness.ts) still sees fake Auth and
// (memory-only) cache, but every PostgREST GET the route issues is answered
// from the real database: the harness's `restBackend` runs the equivalent
// SQL as role `authenticated` with `request.jwt.claim.sub` = the bearer's
// `sub` — i.e. through RLS and the security_invoker view, exactly like the
// hosted Data API — and serialises rows the way PostgREST does (numeric →
// JSON number, timestamptz → ISO string, `.maybeSingle()` → object/406).
//
// Per seeded history (STRESS_PG_USERS, default 25; the campaign scale is
// 200) the run asserts:
//   trigger-state   handler payload == the row the definer trigger persisted
//                   (rating/tier/technique_count/scored_shot_count) and its
//                   technique rows == public.player_technique_rating.
//   fallback        with the saved state row deleted, the handler's inline
//                   confidence-weighted fallback == public.recompute_player_rank
//                   (the "bit-identical" claim in index.ts) == shared-types
//                   computePlayerRank.
//   isolation       another user's bearer reads 0 rows of this user's view /
//                   state through RLS and is served `{ rank: null }`.
//   unranked        a low_confidence-only history → no state row, view empty,
//                   `{ rank: null }`.
//
// Skipped (ignore: true — NOT a pass) unless STRESS_PG_URL / XC_PG_URL /
// PICKLE_AUDIT_PG_URL points at a disposable database, e.g.
//   XC_PG_CONTAINER=pickle-stress-rank-pg XC_PG_PORT=55434 ./xc_pg_up.sh
//   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres \
//     deno test -A --no-check --config deno.json stress_rank_pg.test.ts
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
} from "../../../../packages/shared-types/src/playerRank.ts";
import {
  caseSeed,
  envInt,
  histogram,
  isRecord,
  loadStressHarness,
  Prng,
  rankRequest,
  readJson,
  SHOT_TYPES,
  STRESS_SEED,
  summarize,
  writeArtifact,
} from "./stressRankHarness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const USERS = envInt("STRESS_PG_USERS", 25);
const FILE = "stress_rank_pg.test.ts";

type Sql = ReturnType<typeof postgres>;

const SELECTABLE: Record<string, Set<string>> = {
  player_technique_rating: new Set([
    "user_id",
    "shot_type",
    "score",
    "captured_at",
    "sampled_count",
    "confidence_weight",
  ]),
  player_rank_state: new Set([
    "user_id",
    "rating",
    "tier",
    "technique_count",
    "scored_shot_count",
    "updated_at",
  ]),
};

function bearerSub(bearer: string): string | null {
  const parts = bearer.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as unknown;
    return isRecord(payload) && typeof payload.sub === "string"
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/** PostgREST-shaped JSON for a postgres.js row: numeric/int8 arrive as
 * strings (→ number), timestamptz as Date (→ ISO string). */
function pgrstRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (
      typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && k !== "user_id" &&
      k !== "tier" && k !== "shot_type"
    ) {
      out[k] = Number(v);
    } else out[k] = v;
  }
  return out;
}

/** Answers the two PostgREST reads GET /v1/rank issues from the real DB, as
 * the bearer's user (RLS + security_invoker view). */
function pgBackend(sql: Sql, log: { queries: number; rlsQueries: number }) {
  return async (
    input: {
      table: string;
      url: URL;
      headers: Record<string, string>;
      bearer: string;
    },
  ) => {
    const allowed = SELECTABLE[input.table];
    if (!allowed) return null;
    const sub = bearerSub(input.bearer);
    if (!sub) {
      return new Response(JSON.stringify({ message: "JWSError" }), {
        status: 401,
      });
    }
    const select = (input.url.searchParams.get("select") ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cols = select.length === 1 && select[0] === "*"
      ? [...allowed]
      : select;
    for (const c of cols) {
      if (!allowed.has(c)) {
        return new Response(JSON.stringify({ message: `column ${c}` }), {
          status: 400,
        });
      }
    }
    const eq = input.url.searchParams.get("user_id");
    if (!eq || !eq.startsWith("eq.") || !/^[0-9a-f-]{36}$/.test(eq.slice(3))) {
      return new Response(JSON.stringify({ message: "unsupported filter" }), {
        status: 400,
      });
    }
    const wanted = eq.slice(3);
    const order = input.url.searchParams.get("order");
    let orderSql = "";
    if (order) {
      const [col, dir] = order.split(".");
      if (!allowed.has(col) || (dir !== "asc" && dir !== "desc")) {
        return new Response(JSON.stringify({ message: "unsupported order" }), {
          status: 400,
        });
      }
      orderSql = ` order by ${col} ${dir}`;
    }
    log.queries++;
    if (wanted !== sub) log.rlsQueries++;
    let rows: Array<Record<string, unknown>> = [];
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(
        `select set_config('request.jwt.claim.sub', '${sub}', true)`,
      );
      rows = (await tx.unsafe(
        `select ${
          cols.join(", ")
        } from public.${input.table} where user_id = '${wanted}'${orderSql}`,
      )) as unknown as Array<Record<string, unknown>>;
    });
    const shaped = rows.map(pgrstRow);
    const accept = input.headers["accept"] ?? "";
    const headers = { "Content-Type": "application/json" };
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (shaped.length === 0) {
        return new Response(
          JSON.stringify({
            code: "PGRST116",
            message: "0 rows",
            details: "The result contains 0 rows",
            hint: null,
          }),
          { status: 406, headers },
        );
      }
      return new Response(JSON.stringify(shaped[0]), { status: 200, headers });
    }
    return new Response(JSON.stringify(shaped), { status: 200, headers });
  };
}

interface SeedShot {
  id: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: "scored" | "low_confidence";
}

function seededShots(
  prng: Prng,
  n: number,
  lowConfidenceOnly = false,
): SeedShot[] {
  const instants: string[] = [];
  const out: SeedShot[] = [];
  for (let i = 0; i < n; i++) {
    let capturedAt: string;
    if (instants.length > 0 && prng.next() < 0.25) {
      capturedAt = instants[prng.int(0, instants.length - 1)];
    } else {
      capturedAt = new Date(
        Date.UTC(2026, 0, 1) + prng.int(0, 240 * 24 * 3600 * 1000),
      ).toISOString();
      instants.push(capturedAt);
    }
    const lowConfidence = lowConfidenceOnly || prng.next() < 0.12;
    const score = prng.next() < 0.5
      ? prng.int(0, 100) / 10
      : prng.int(0, 1000) / 100;
    out.push({
      id: prng.uuid(),
      shotType: SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)],
      capturedAt,
      overallScore: lowConfidence ? null : score,
      resultKind: lowConfidence ? "low_confidence" : "scored",
    });
  }
  return out;
}

async function insertHistory(
  sql: Sql,
  userId: string,
  shots: SeedShot[],
): Promise<void> {
  await sql.unsafe(
    `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
  );
  for (const s of shots) {
    await sql.unsafe(
      `insert into public.shots
         (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
          overall_score, analysis_confidence, result_kind,
          app_version, model_bundle_version, pose_model_version, paddle_model_version,
          stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values ($1, $2, $3, 'side', $4, 0, 100, 200, $5, 0.9, $6, '1', '1', '1', '1', '1', '1', '1', '1')`,
      [s.id, userId, s.shotType, s.capturedAt, s.overallScore, s.resultKind],
    );
  }
}

async function readState(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count
       from public.player_rank_state where user_id = '${userId}'`,
  );
  return rows.length === 0 ? null : {
    rating: Number(rows[0].rating),
    tier: String(rows[0].tier),
    techniqueCount: Number(rows[0].technique_count),
    scoredShotCount: Number(rows[0].scored_shot_count),
  };
}

async function readView(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select shot_type, score::text as score, sampled_count
       from public.player_technique_rating where user_id = '${userId}'`,
  );
  return rows
    .map((r) => ({
      shot_type: String(r.shot_type),
      score: Number(r.score),
      sampled_count: Number(r.sampled_count),
    }))
    .sort((a, b) => b.score - a.score || (a.shot_type < b.shot_type ? -1 : 1));
}

interface Row {
  i: number;
  seed: number;
  userId: string;
  shots: number;
  scored: number;
  checks: Record<string, "HELD" | string>;
  handler: {
    status: number;
    rating: unknown;
    tier: unknown;
    techniqueCount: unknown;
    latencyMs: number;
  };
  fallback: { status: number; rating: unknown; tier: unknown } | null;
  trigger: { rating: number; tier: string } | null;
  recompute: { rating: number; tier: string } | null;
  shared: { rating: number; tier: string } | null;
  replay: string;
}

Deno.test({
  name:
    `stress-rank-pg ${USERS} seeded histories against postgres:16 (all migrations)`,
  ignore,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const sql = postgres(PG_URL, { max: 4 });
    const log = { queries: 0, rlsQueries: 0 };
    h.restBackend = pgBackend(sql, log);
    const rows: Row[] = [];
    const created: string[] = [];
    try {
      const migrations = await sql.unsafe(
        `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'recompute_player_rank'`,
      );
      assertEquals(
        migrations[0].n,
        1,
        "recompute_player_rank must exist (migrations applied?)",
      );

      for (let i = 0; i < USERS; i++) {
        const seed = caseSeed(STRESS_SEED, `pg-${i}`);
        const prng = new Prng(seed);
        const checks: Record<string, string> = {};
        const lowOnly = i % 10 === 9;
        const shots = seededShots(prng, prng.int(1, 40), lowOnly);
        const scored = shots.filter((s) => s.resultKind === "scored").length;

        // ── user A: trigger-persisted state, handler reads through RLS ──
        const a = prng.uuid();
        created.push(a);
        await insertHistory(sql, a, shots);
        h.registerUser(a);
        const sessionA = h.mintSession(a);
        const ipA = prng.ip();
        const trigger = await readState(sql, a);
        const view = await readView(sql, a);
        const t0 = performance.now();
        const resA = await h.handler(rankRequest(sessionA.accessToken, ipA));
        const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
        const bodyA = await readJson(resA);
        const rankA = isRecord(bodyA.rank) ? bodyA.rank : null;
        const shared = computePlayerRank(
          shots.map<PlayerRankAnalysisInput>((s) => ({
            id: s.id,
            shotType: s.shotType,
            capturedAt: s.capturedAt,
            overallScore: s.overallScore,
            resultKind: s.resultKind,
            source: "real",
          })),
        );

        if (resA.status !== 200) {
          checks["trigger-state"] = `status ${resA.status}`;
        } else if (scored === 0) {
          checks["unranked"] =
            bodyA.rank === null && trigger === null && view.length === 0
              ? "HELD"
              : `rank=${JSON.stringify(bodyA.rank)} state=${
                JSON.stringify(trigger)
              } view=${view.length}`;
        } else if (!rankA || !trigger) {
          checks["trigger-state"] = `rank=${JSON.stringify(bodyA.rank)} state=${
            JSON.stringify(trigger)
          }`;
        } else {
          const problems: string[] = [];
          if (rankA.rating !== trigger.rating) {
            problems.push(
              `rating ${String(rankA.rating)} != trigger ${trigger.rating}`,
            );
          }
          if (rankA.tier !== trigger.tier) {
            problems.push(`tier ${String(rankA.tier)} != ${trigger.tier}`);
          }
          if (rankA.techniqueCount !== trigger.techniqueCount) {
            problems.push(
              `techniqueCount ${
                String(rankA.techniqueCount)
              } != ${trigger.techniqueCount}`,
            );
          }
          if (rankA.scoredShotCount !== trigger.scoredShotCount) {
            problems.push(
              `scoredShotCount ${
                String(rankA.scoredShotCount)
              } != ${trigger.scoredShotCount}`,
            );
          }
          if (
            shared &&
            (shared.rating !== trigger.rating || shared.tier !== trigger.tier)
          ) {
            problems.push(
              `shared-types ${shared.rating}/${shared.tier} != trigger ${trigger.rating}/${trigger.tier}`,
            );
          }
          const techniques = Array.isArray(rankA.techniques)
            ? (rankA.techniques as Array<Record<string, unknown>>)
            : [];
          if (techniques.length !== view.length) {
            problems.push(
              `techniques ${techniques.length} != view ${view.length}`,
            );
          }
          techniques.forEach((t, idx) => {
            const v = view[idx];
            if (
              !v || t.shot_type !== v.shot_type || t.score !== v.score ||
              t.sampled_count !== v.sampled_count
            ) {
              problems.push(
                `technique[${idx}] ${JSON.stringify(t)} != view ${
                  JSON.stringify(v)
                }`,
              );
            }
            if ("confidence_weight" in t) {
              problems.push("confidence_weight leaked into payload");
            }
          });
          checks["trigger-state"] = problems.length === 0
            ? "HELD"
            : problems.join("; ");
        }

        // ── user B: same history, state row deleted → inline fallback vs recompute ──
        let fallback: Row["fallback"] = null;
        let recompute: Row["recompute"] = null;
        if (scored > 0) {
          const b = prng.uuid();
          created.push(b);
          const shotsB = shots.map((s) => ({ ...s, id: prng.uuid() }));
          await insertHistory(sql, b, shotsB);
          await sql.unsafe(
            `delete from public.player_rank_state where user_id = '${b}'`,
          );
          h.registerUser(b);
          const sessionB = h.mintSession(b);
          const resB = await h.handler(
            rankRequest(sessionB.accessToken, prng.ip()),
          );
          const bodyB = await readJson(resB);
          const rankB = isRecord(bodyB.rank) ? bodyB.rank : null;
          fallback = {
            status: resB.status,
            rating: rankB?.rating,
            tier: rankB?.tier,
          };
          await sql.unsafe(`select public.recompute_player_rank('${b}')`);
          const rebuilt = await readState(sql, b);
          recompute = rebuilt
            ? { rating: rebuilt.rating, tier: rebuilt.tier }
            : null;
          const sharedB = computePlayerRank(
            shotsB.map<PlayerRankAnalysisInput>((s) => ({
              id: s.id,
              shotType: s.shotType,
              capturedAt: s.capturedAt,
              overallScore: s.overallScore,
              resultKind: s.resultKind,
              source: "real",
            })),
          );
          if (resB.status !== 200 || !rankB || !rebuilt) {
            checks["fallback"] = `status ${resB.status} rank=${
              JSON.stringify(bodyB.rank)
            } recompute=${JSON.stringify(rebuilt)}`;
          } else {
            const problems: string[] = [];
            if (rankB.rating !== rebuilt.rating) {
              problems.push(
                `fallback rating ${
                  String(rankB.rating)
                } != recompute ${rebuilt.rating}`,
              );
            }
            if (rankB.tier !== rebuilt.tier) {
              problems.push(
                `fallback tier ${String(rankB.tier)} != ${rebuilt.tier}`,
              );
            }
            if (rankB.scoredShotCount !== null || rankB.updatedAt !== null) {
              problems.push(
                "fallback must report scoredShotCount/updatedAt as null",
              );
            }
            if (sharedB && sharedB.rating !== rebuilt.rating) {
              problems.push(
                `shared-types ${sharedB.rating} != recompute ${rebuilt.rating}`,
              );
            }
            checks["fallback"] = problems.length === 0
              ? "HELD"
              : problems.join("; ");
          }
        }

        // ── user C: a stranger's bearer sees none of A through RLS ──
        const c = prng.uuid();
        created.push(c);
        await sql.unsafe(
          `insert into auth.users (id, email) values ('${c}', '${c}@example.com')`,
        );
        h.registerUser(c);
        const sessionC = h.mintSession(c);
        const resC = await h.handler(
          rankRequest(sessionC.accessToken, prng.ip()),
        );
        const bodyC = await readJson(resC);
        let crossView = -1;
        let crossState = -1;
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(
            `select set_config('request.jwt.claim.sub', '${c}', true)`,
          );
          crossView = Number(
            (await tx.unsafe(
              `select count(*)::int as n from public.player_technique_rating where user_id = '${a}'`,
            ))[0].n,
          );
          crossState = Number(
            (await tx.unsafe(
              `select count(*)::int as n from public.player_rank_state where user_id = '${a}'`,
            ))[0].n,
          );
        });
        checks["isolation"] =
          resC.status === 200 && bodyC.rank === null && crossView === 0 &&
            crossState === 0
            ? "HELD"
            : `stranger status ${resC.status} rank=${
              JSON.stringify(bodyC.rank)
            } view=${crossView} state=${crossState}`;

        rows.push({
          i,
          seed,
          userId: a,
          shots: shots.length,
          scored,
          checks,
          handler: {
            status: resA.status,
            rating: rankA?.rating ?? null,
            tier: rankA?.tier ?? null,
            techniqueCount: rankA?.techniqueCount ?? null,
            latencyMs,
          },
          fallback,
          trigger: trigger
            ? { rating: trigger.rating, tier: trigger.tier }
            : null,
          recompute,
          shared: shared ? { rating: shared.rating, tier: shared.tier } : null,
          replay: `STRESS_SEED=${STRESS_SEED} STRESS_PG_USERS=${
            i + 1
          } STRESS_PG_URL=<disposable pg> deno test -A --no-check --config deno.json ${FILE}`,
        });
      }
    } finally {
      for (const id of created) {
        await sql.unsafe(`delete from auth.users where id = '${id}'`).catch(
          () => undefined,
        );
      }
      h.restBackend = null;
      await sql.end();
    }

    const failures = rows.filter((r) =>
      Object.values(r.checks).some((v) => v !== "HELD")
    );
    const report = {
      file: FILE,
      seed: STRESS_SEED,
      users: USERS,
      pg: PG_URL.replace(/\/\/.*@/, "//<redacted>@"),
      sqlQueriesServedToHandler: log.queries,
      checks: histogram(
        rows.flatMap((r) =>
          Object.entries(r.checks).map(([k, v]) =>
            `${k}:${v === "HELD" ? "HELD" : "BROKEN"}`
          )
        ),
      ),
      handlerLatencyMs: summarize(rows.map((r) => r.handler.latencyMs)),
      failures: failures.map((r) => ({
        i: r.i,
        seed: r.seed,
        checks: r.checks,
        replay: r.replay,
      })),
      rows,
    };
    const path = await writeArtifact(`pg_${STRESS_SEED}`, report);
    console.log(`[stress-rank-pg] wrote ${path}`);
    console.log(`[stress-rank-pg] checks: ${JSON.stringify(report.checks)}`);
    assert(
      rows.some((r) => r.scored > 0 && r.fallback),
      "campaign must include ranked histories",
    );
    assert(
      rows.some((r) => r.scored === 0),
      "campaign must include an unranked history",
    );
    assertEquals(
      failures.length,
      0,
      `postgres-backed failures: ${
        JSON.stringify(report.failures.slice(0, 3))
      }`,
    );
  },
});
