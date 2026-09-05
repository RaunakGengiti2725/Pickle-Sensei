/**
 * stress — DELETE /v1/me/saved-drills/:slug — CONCURRENCY lens, REAL database.
 *
 * Same real edge handler as stress_saved_drill_delete_concurrency.test.ts,
 * but every /rest/v1/* call is forwarded to a real PostgREST (v12) in front of
 * a disposable docker postgres:16 with EVERY migration applied. GoTrue stays
 * faked (deterministic auth gates); the PostgREST calls race for real, so the
 * database-level properties — PK (user_id, slug), owner-only RLS, one-statement
 * DELETE — are exercised by Postgres itself, not by the in-memory model.
 * Ground truth for every invariant is read back with superuser SQL.
 *
 *   ./stress_pg_up.sh            # postgres:16 + migrations + PostgREST; prints env
 *   eval "$(./stress_pg_up.sh)" && deno test -A --no-check --config deno.json \
 *     stress_saved_drill_delete_postgrest.test.ts
 *   ./stress_pg_up.sh down
 *
 * Without STRESS_POSTGREST_URL + XC_PG_URL every test is `ignore`d — an ignored
 * run is NOT a pass.
 *
 * Scenarios (seeded burst composition and auth interleaving; DB race real):
 *   P1 dup-delete      N identical DELETEs → all 204, exactly one statement
 *                      removed a row, DB row gone, siblings intact.
 *   P2 put-delete      PUT/DELETE of the same (user, slug) → DELETE always 204,
 *                      PUT 200|503, DB holds 0 or 1 row (PK), GET agrees.
 *   P3 two-actors      A's DELETE burst on slug X vs B's identical row → B's
 *                      row intact under real RLS; A cannot delete B's row
 *                      even when asking for it by user_id.
 *   P4 logout-during   POST /v1/auth/logout racing DELETEs → 204|401, none
 *                      after the logout reaches PostgREST.
 *   P5 rotation        POST /v1/auth/refresh mid-burst → all 204, all gone.
 *   SQL1 barrier       N transactions DELETE the same row from a barrier →
 *                      affected rows sum to exactly 1, no deadlock/timeout.
 */
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  callEdge,
  edgeRequest,
  inv,
  type Invariant,
  type IterationContext,
  type IterationOutcome,
  type RequestRow,
  runScenario,
  type ScenarioReport,
  STRESS_ITER,
  STRESS_MAX_BURST,
  STRESS_SEED,
  writeJson,
} from "./stress_saved_drill_delete_harness.ts";
import { Prng } from "./xc_concurrency_harness.ts";

const FILE = "stress_saved_drill_delete_postgrest.test.ts";
const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
const POSTGREST_URL = Deno.env.get("STRESS_POSTGREST_URL") ?? "";
const ignore = PG_URL === "" || POSTGREST_URL === "";
const SLUGS = ["third-shot-drop", "dink-crosscourt", "reset-from-transition", "serve-deep-target"];

type Sql = ReturnType<typeof postgres>;
let sqlSingleton: Sql | null = null;
function db(): Sql {
  if (!sqlSingleton) sqlSingleton = postgres(PG_URL, { max: 8, onnotice: () => {} });
  return sqlSingleton;
}

const reports: ScenarioReport[] = [];

async function seedUser(sql: Sql, userId: string): Promise<void> {
  await sql`insert into auth.users (id, email, raw_app_meta_data)
    values (${userId}::uuid, ${`${userId}@stress.test`}, '{"provider":"apple"}'::jsonb)
    on conflict (id) do nothing`;
  await sql`insert into public.profiles (id) values (${userId}::uuid) on conflict (id) do nothing`;
}
async function seedRow(sql: Sql, userId: string, slug: string): Promise<void> {
  await sql`insert into public.user_saved_drills (user_id, slug) values (${userId}::uuid, ${slug})
    on conflict do nothing`;
}
async function dbHas(sql: Sql, userId: string, slug: string): Promise<boolean> {
  const rows =
    await sql`select 1 from public.user_saved_drills where user_id = ${userId}::uuid and slug = ${slug}`;
  return rows.length > 0;
}
async function dbSlugs(sql: Sql, userId: string): Promise<string[]> {
  const rows = await sql<
    { slug: string }[]
  >`select slug from public.user_saved_drills where user_id = ${userId}::uuid order by slug`;
  return rows.map((r) => r.slug);
}
async function dropUsers(sql: Sql, ids: string[]): Promise<void> {
  for (const id of ids) await sql`delete from auth.users where id = ${id}::uuid`;
}

function del(ctx: IterationContext, lane: number, bearer: string, slug: string) {
  return () =>
    callEdge(
      ctx.harness,
      lane,
      `DELETE ${slug}`,
      edgeRequest("DELETE", `/v1/me/saved-drills/${encodeURIComponent(slug)}`, {
        bearer,
        ip: ctx.ip,
      }),
      ctx.t0,
    );
}
function put(ctx: IterationContext, lane: number, bearer: string, slug: string) {
  return () =>
    callEdge(
      ctx.harness,
      lane,
      `PUT ${slug}`,
      edgeRequest("PUT", `/v1/me/saved-drills/${encodeURIComponent(slug)}`, {
        bearer,
        ip: ctx.ip,
        body: { slug, saved: true },
      }),
      ctx.t0,
    );
}
async function listSlugs(ctx: IterationContext, bearer: string): Promise<string[]> {
  const row = await ctx.one(async () => {
    const res = await ctx.harness.handler(
      edgeRequest("GET", "/v1/me/saved-drills", { bearer, ip: ctx.ip }),
    );
    const body = (await res.json()) as { items?: Array<{ slug: string }> };
    return {
      lane: -1,
      op: "GET list",
      status: res.status,
      code: null,
      startedAt: 0,
      endedAt: 0,
      note: JSON.stringify((body.items ?? []).map((i) => i.slug)),
    };
  });
  assertEquals(row.status, 200, "GET /v1/me/saved-drills must answer 200");
  return JSON.parse(row.note ?? "[]") as string[];
}
const burstSize = (ctx: IterationContext, min = 4) =>
  ctx.prng.int(min, Math.max(min, STRESS_MAX_BURST));
const all = (values: number[], want: number) => values.every((v) => v === want);
const no5xx = (rows: RequestRow[]): Invariant =>
  inv(
    "no_5xx",
    rows.every((r) => r.status < 500),
    `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
  );
const passthrough = { postgrestUrl: POSTGREST_URL };
const failingSeeds = (r: ScenarioReport) =>
  JSON.stringify(r.iterations.filter((it) => it.outcome !== "HELD").map((it) => it.seed));

// ── P1 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress p1-dup-delete (real PostgREST): N identical DELETEs → all 204, one row removed, siblings intact",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const report = await runScenario(
      FILE,
      "p1-dup-delete",
      "duplicate DELETE burst against real PostgREST",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const siblings = SLUGS.filter((s) => s !== target).slice(0, ctx.prng.int(0, 2));
        await seedUser(sql, user);
        await seedRow(sql, user, target);
        for (const s of siblings) await seedRow(sql, user, s);
        const n = burstSize(ctx);
        try {
          const rows = await ctx.burst(
            Array.from({ length: n }, (_, lane) => del(ctx, lane, session.accessToken, target)),
          );
          const after = await listSlugs(ctx, session.accessToken);
          const dbAfter = await dbSlugs(sql, user);
          const invariants: Invariant[] = [
            inv(
              "all_204",
              all(
                rows.map((r) => r.status),
                204,
              ),
              `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
            ),
            inv("db_row_deleted", !(await dbHas(sql, user, target)), `db has ${target}`),
            inv(
              "db_siblings_intact",
              siblings.every((s) => dbAfter.includes(s)),
              `db ${JSON.stringify(dbAfter)} siblings ${JSON.stringify(siblings)}`,
            ),
            inv(
              "list_agrees_with_db",
              JSON.stringify([...after].sort()) === JSON.stringify(dbAfter),
              `GET ${JSON.stringify(after)} db ${JSON.stringify(dbAfter)}`,
            ),
            inv(
              "every_call_reached_postgrest",
              ctx.fake.counters["rest.delete"] === n,
              `rest.delete=${ctx.fake.counters["rest.delete"]} n=${n}`,
            ),
            inv(
              "exactly_one_statement_removed_a_row",
              ctx.fake.counters["rest.delete.removed"] === 1,
              `removed=${ctx.fake.counters["rest.delete.removed"] ?? 0} noop=${ctx.fake.counters["rest.delete.noop"] ?? 0}`,
            ),
            no5xx(rows),
          ];
          return {
            burst: n,
            inputs: { user, target, siblings },
            requests: rows,
            invariants,
            observations: { noop: ctx.fake.counters["rest.delete.noop"] ?? 0 },
          };
        } finally {
          await dropUsers(sql, [user]);
        }
      },
      { passthrough },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `P1 failing seeds: ${failingSeeds(report)}`);
  },
});

// ── P2 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress p2-put-delete-race (real PostgREST): PUT/DELETE of one (user, slug) → DELETE 204, PUT 200|503, PK holds ≤1 row, GET agrees with DB",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const report = await runScenario(
      FILE,
      "p2-put-delete-race",
      "PUT/DELETE race against real PostgREST",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const initiallySaved = ctx.prng.next() < 0.5;
        await seedUser(sql, user);
        if (initiallySaved) await seedRow(sql, user, target);
        const n = burstSize(ctx);
        const ops = Array.from({ length: n }, () => (ctx.prng.next() < 0.5 ? "PUT" : "DELETE"));
        try {
          const rows = await ctx.burst(
            ops.map((op, lane) =>
              op === "PUT"
                ? put(ctx, lane, session.accessToken, target)
                : del(ctx, lane, session.accessToken, target),
            ),
          );
          const after = await listSlugs(ctx, session.accessToken);
          const count = Number(
            (
              await sql`select count(*)::int as c from public.user_saved_drills where user_id = ${user}::uuid and slug = ${target}`
            )[0].c,
          );
          const deleteStatuses = rows.filter((r) => r.op.startsWith("DELETE")).map((r) => r.status);
          const putStatuses = rows.filter((r) => r.op.startsWith("PUT")).map((r) => r.status);
          const invariants: Invariant[] = [
            inv(
              "delete_all_204",
              all(deleteStatuses, 204),
              `DELETE statuses ${JSON.stringify(deleteStatuses)}`,
            ),
            inv(
              "put_200_or_503",
              putStatuses.every((s) => s === 200 || s === 503),
              `PUT statuses ${JSON.stringify(putStatuses)}`,
            ),
            inv("pk_holds_at_most_one_row", count <= 1, `count=${count}`),
            inv(
              "list_agrees_with_db",
              after.includes(target) === (count === 1),
              `GET has ${target}: ${after.includes(target)} db count=${count}`,
            ),
            inv(
              "no_500",
              rows.every((r) => r.status !== 500),
              `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
            ),
          ];
          return {
            burst: n,
            inputs: { user, target, initiallySaved, ops },
            requests: rows,
            invariants,
            observations: {
              put503: putStatuses.filter((s) => s === 503).length,
              finalCount: count,
            },
          };
        } finally {
          await dropUsers(sql, [user]);
        }
      },
      { passthrough },
    );
    reports.push(report);
    const put503 = report.iterations.filter((it) => Number(it.observations.put503 ?? 0) > 0);
    console.log(
      `[stress] p2 observation: PUT answered 503 in ${put503.length}/${report.executed} iterations against the real database (seeds ${JSON.stringify(put503.map((it) => it.seed).slice(0, 10))})`,
    );
    assertEquals(report.broken + report.errored, 0, `P2 failing seeds: ${failingSeeds(report)}`);
  },
});

// ── P3 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress p3-two-actors (real RLS): A's DELETE burst never removes B's identical slug, even when addressed by B's user_id",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const report = await runScenario(
      FILE,
      "p3-two-actors",
      "two users, same slug, real RLS",
      async (ctx): Promise<IterationOutcome> => {
        const a = ctx.fake.newUser("apple");
        const b = ctx.fake.newUser("google");
        const sa = ctx.fake.mintSession(a);
        const sb = ctx.fake.mintSession(b);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        await seedUser(sql, a);
        await seedUser(sql, b);
        await seedRow(sql, a, target);
        await seedRow(sql, b, target);
        const nA = burstSize(ctx, 2);
        const nB = ctx.prng.int(0, 4);
        try {
          const rows = await ctx.burst(
            ctx.prng.shuffle([
              ...Array.from({ length: nA }, (_, lane) => del(ctx, lane, sa.accessToken, target)),
              ...Array.from({ length: nB }, (_, i) => put(ctx, nA + i, sb.accessToken, target)),
            ]),
          );
          // Direct PostgREST probe with A's bearer addressing B's row by user_id:
          // RLS must filter it to nothing (204, 0 rows).
          const probe = await ctx.harness.realFetch(
            `${POSTGREST_URL}/user_saved_drills?user_id=eq.${b}&slug=eq.${encodeURIComponent(target)}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${sa.accessToken}`, Prefer: "count=exact" },
            },
          );
          await probe.text();
          const probeRange = probe.headers.get("content-range");
          const aHas = await dbHas(sql, a, target);
          const bHas = await dbHas(sql, b, target);
          const bList = await listSlugs(ctx, sb.accessToken);
          const invariants: Invariant[] = [
            inv(
              "a_deletes_all_204",
              all(
                rows.filter((r) => r.lane < nA).map((r) => r.status),
                204,
              ),
              `A statuses ${JSON.stringify(rows.filter((r) => r.lane < nA).map((r) => r.status))}`,
            ),
            inv("a_row_deleted", !aHas, `db A has ${target}: ${aHas}`),
            inv("b_row_survives", bHas, `db B has ${target}: ${bHas}`),
            inv("b_list_has_target", bList.includes(target), `B GET ${JSON.stringify(bList)}`),
            inv(
              "cross_user_delete_filtered_by_rls",
              probe.status === 204 && probeRange === "*/0",
              `probe status ${probe.status} content-range ${probeRange}`,
            ),
            inv(
              "exactly_one_row_removed",
              (ctx.fake.counters["rest.delete.removed"] ?? 0) === 1,
              `removed=${ctx.fake.counters["rest.delete.removed"] ?? 0}`,
            ),
            no5xx(rows),
          ];
          return {
            burst: nA + nB,
            inputs: { a, b, target, nA, nB },
            requests: rows,
            invariants,
            observations: { probeStatus: probe.status, probeRange },
          };
        } finally {
          await dropUsers(sql, [a, b]);
        }
      },
      { passthrough },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `P3 failing seeds: ${failingSeeds(report)}`);
  },
});

// ── P4 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress p4-logout-during-delete (real PostgREST): DELETE racing logout → 204|401, nothing after the logout reaches PostgREST",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const report = await runScenario(
      FILE,
      "p4-logout-during-delete",
      "logout racing DELETEs against real PostgREST",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[0];
        const other = SLUGS[1];
        await seedUser(sql, user);
        await seedRow(sql, user, target);
        await seedRow(sql, user, other);
        const n = burstSize(ctx, 3);
        const logoutLane = ctx.prng.int(0, n - 1);
        try {
          const rows = await ctx.burst(
            Array.from({ length: n }, (_, lane) =>
              lane === logoutLane
                ? () =>
                    callEdge(
                      ctx.harness,
                      lane,
                      "POST logout",
                      edgeRequest("POST", "/v1/auth/logout", {
                        bearer: session.accessToken,
                        ip: ctx.ip,
                      }),
                      ctx.t0,
                    )
                : del(ctx, lane, session.accessToken, lane % 3 === 0 ? other : target),
            ),
          );
          const before = ctx.fake.counters["rest.delete"] ?? 0;
          const post = await ctx.burst(
            Array.from({ length: 2 }, (_, i) => del(ctx, n + i, session.accessToken, target)),
          );
          const afterCount = ctx.fake.counters["rest.delete"] ?? 0;
          const deletes = rows.filter((r) => r.op.startsWith("DELETE"));
          const targetHas = await dbHas(sql, user, target);
          const invariants: Invariant[] = [
            inv("logout_204", rows[logoutLane].status === 204, `logout ${rows[logoutLane].status}`),
            inv(
              "deletes_204_or_401",
              deletes.every((r) => r.status === 204 || r.status === 401),
              `statuses ${JSON.stringify(deletes.map((r) => r.status))}`,
            ),
            inv(
              "after_logout_all_401",
              post.every((r) => r.status === 401),
              `post ${JSON.stringify(post.map((r) => r.status))}`,
            ),
            inv(
              "after_logout_no_postgrest",
              afterCount === before,
              `rest.delete before=${before} after=${afterCount}`,
            ),
            inv(
              "204_implies_deleted",
              deletes.filter((r) => r.status === 204 && r.op === `DELETE ${target}`).length === 0 ||
                !targetHas,
              `204s for target ${deletes.filter((r) => r.status === 204 && r.op === `DELETE ${target}`).length} db has=${targetHas}`,
            ),
            inv(
              "401_means_no_effect",
              (ctx.fake.counters["rest.delete"] ?? 0) ===
                deletes.filter((r) => r.status === 204).length,
              `rest.delete=${ctx.fake.counters["rest.delete"] ?? 0} 204s=${deletes.filter((r) => r.status === 204).length}`,
            ),
            no5xx([...rows, ...post]),
          ];
          return {
            burst: n + 2,
            inputs: { user, logoutLane },
            requests: [...rows, ...post],
            invariants,
            observations: { deletes401: deletes.filter((r) => r.status === 401).length },
          };
        } finally {
          await dropUsers(sql, [user]);
        }
      },
      { passthrough },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `P4 failing seeds: ${failingSeeds(report)}`);
  },
});

// ── P5 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress p5-rotation-during-delete (real PostgREST): refresh mid-burst → old and new bearers delete, all 204, all rows gone",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const report = await runScenario(
      FILE,
      "p5-rotation-during-delete",
      "refresh racing DELETEs against real PostgREST",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const oldAccess = session.accessToken;
        const refreshToken = session.refreshToken;
        const targets = ctx.prng.shuffle(SLUGS).slice(0, ctx.prng.int(2, 3));
        await seedUser(sql, user);
        for (const s of targets) await seedRow(sql, user, s);
        const n = burstSize(ctx, 3);
        const refreshLane = ctx.prng.int(0, n - 1);
        try {
          const rows = await ctx.burst(
            Array.from({ length: n }, (_, lane) =>
              lane === refreshLane
                ? () =>
                    callEdge(
                      ctx.harness,
                      lane,
                      "POST refresh",
                      edgeRequest("POST", "/v1/auth/refresh", {
                        ip: ctx.ip,
                        body: { refreshToken },
                      }),
                      ctx.t0,
                    )
                : del(ctx, lane, oldAccess, targets[0]),
            ),
          );
          const newAccess = ctx.fake.sessions.get(session.sessionId)!.accessToken;
          const phase2 = await ctx.burst([
            ...targets.slice(1).map((s, i) => del(ctx, n + i, newAccess, s)),
            del(ctx, n + targets.length, oldAccess, targets[0]),
          ]);
          const remaining = await dbSlugs(sql, user);
          const deletes = [...rows.filter((r) => r.op.startsWith("DELETE")), ...phase2];
          const invariants: Invariant[] = [
            inv(
              "refresh_200",
              rows[refreshLane].status === 200,
              `refresh ${rows[refreshLane].status}`,
            ),
            inv("session_rotated", newAccess !== oldAccess, `rotated=${newAccess !== oldAccess}`),
            inv(
              "all_deletes_204",
              all(
                deletes.map((r) => r.status),
                204,
              ),
              `statuses ${JSON.stringify(deletes.map((r) => r.status))}`,
            ),
            inv(
              "db_all_targets_gone",
              remaining.length === 0,
              `remaining ${JSON.stringify(remaining)}`,
            ),
            inv(
              "removed_once_per_target",
              (ctx.fake.counters["rest.delete.removed"] ?? 0) === targets.length,
              `removed=${ctx.fake.counters["rest.delete.removed"] ?? 0} targets=${targets.length}`,
            ),
            no5xx([...rows, ...phase2]),
          ];
          return {
            burst: n + phase2.length,
            inputs: { user, targets, refreshLane },
            requests: [...rows, ...phase2],
            invariants,
            observations: {},
          };
        } finally {
          await dropUsers(sql, [user]);
        }
      },
      { passthrough },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `P5 failing seeds: ${failingSeeds(report)}`);
  },
});

// ── SQL1: barrier DELETE from N open transactions ────────────────────────────

Deno.test({
  name: "stress sql1-barrier-delete (postgres:16): N transactions delete the same (user, slug) from a barrier → affected rows sum to 1, bounded time",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = db();
    const iterations = Deno.env.get("STRESS_ONLY_SEED") ? 1 : STRESS_ITER;
    const lanes = Math.min(STRESS_MAX_BURST, 16);
    const table: Array<Record<string, unknown>> = [];
    for (let i = 0; i < iterations; i++) {
      const seed = (STRESS_SEED * 31 + i * 7919 + 0x51) >>> 0;
      const prng = new Prng(seed);
      const user = prng.uuid();
      const slug = SLUGS[prng.int(0, SLUGS.length - 1)];
      const other = SLUGS.find((s) => s !== slug)!;
      await seedUser(sql, user);
      await seedRow(sql, user, slug);
      await seedRow(sql, user, other);
      const n = prng.int(2, lanes);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let arrived = 0;
      const started = performance.now();
      const pool = postgres(PG_URL, { max: n, onnotice: () => {} });
      const results = await Promise.all(
        Array.from({ length: n }, async (_, lane) => {
          try {
            return await pool.begin(async (tx) => {
              await tx.unsafe(`set local statement_timeout = '10s'`);
              await tx.unsafe(`set local lock_timeout = '10s'`);
              await tx.unsafe(`set local role authenticated`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${user}'`);
              if (++arrived === n) open();
              await gate;
              const rows = await tx.unsafe(
                `delete from public.user_saved_drills where user_id = '${user}' and slug = '${slug}' returning slug`,
              );
              return { lane, affected: rows.length, error: null as string | null };
            });
          } catch (error) {
            return {
              lane,
              affected: 0,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      await pool.end();
      const elapsed = performance.now() - started;
      const affected = results.reduce((s, r) => s + r.affected, 0);
      const errors = results.filter((r) => r.error).map((r) => r.error);
      const remaining = await dbSlugs(sql, user);
      await dropUsers(sql, [user]);
      const holds =
        affected === 1 &&
        errors.length === 0 &&
        remaining.length === 1 &&
        remaining[0] === other &&
        elapsed < 10_000;
      table.push({
        seed,
        lanes: n,
        affected,
        errors,
        remaining,
        elapsedMs: Math.round(elapsed),
        outcome: holds ? "HELD" : "BROKEN",
      });
    }
    const path = await writeJson("sql1-barrier-delete", {
      scenario: "sql1-barrier-delete",
      executed: table.length,
      table,
    });
    const broken = table.filter((t) => t.outcome !== "HELD");
    console.log(
      `[stress] sql1-barrier-delete: executed=${table.length} held=${table.length - broken.length} broken=${broken.length} → ${path}`,
    );
    assertEquals(broken.length, 0, `SQL1 broken: ${JSON.stringify(broken)}`);
    reports.push({
      scenario: "sql1-barrier-delete",
      label: "barrier DELETE",
      campaignSeed: STRESS_SEED,
      scale: { iterations: table.length, maxBurst: lanes },
      iterations: [],
      executed: table.length,
      held: table.length - broken.length,
      broken: broken.length,
      errored: 0,
      heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
      durationMs: 0,
    });
  },
});

Deno.test({
  name: "stress (real PostgREST): write seeds_postgrest.json and close the pool",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const table = reports.flatMap((report) =>
      report.iterations.map((it) => ({
        scenario: report.scenario,
        seed: it.seed,
        outcome: it.outcome,
        burst: it.burst,
        statuses: it.statusHistogram,
        failing: it.invariants.filter((i) => !i.holds).map((i) => i.name),
        error: it.error ?? null,
        durationMs: it.durationMs,
        replay: it.replay,
      })),
    );
    const summary = {
      file: FILE,
      campaignSeed: STRESS_SEED,
      iterPerScenario: STRESS_ITER,
      maxBurst: STRESS_MAX_BURST,
      postgrest: POSTGREST_URL,
      scenarios: reports.map((r) => ({
        scenario: r.scenario,
        executed: r.executed,
        held: r.held,
        broken: r.broken,
        errored: r.errored,
      })),
      executed: reports.reduce((s, r) => s + r.executed, 0),
      requests: reports.reduce(
        (s, r) => s + r.iterations.reduce((x, it) => x + it.requests.length, 0),
        0,
      ),
      held: reports.reduce((s, r) => s + r.held, 0),
      broken: reports.reduce((s, r) => s + r.broken, 0),
      errored: reports.reduce((s, r) => s + r.errored, 0),
      table,
    };
    const path = await writeJson("seeds_postgrest", summary);
    console.log(
      `[stress] postgrest seeds table: executed=${summary.executed} held=${summary.held} broken=${summary.broken} errored=${summary.errored} requests=${summary.requests} → ${path}`,
    );
    await sqlSingleton?.end();
    assert(summary.executed > 0, "no iterations executed");
  },
});
