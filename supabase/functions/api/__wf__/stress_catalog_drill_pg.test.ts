// stress-catalog-drill / failure-load lens — the route's ONE database read
// (`user_saved_drills` via PostgREST, RLS-scoped) against a REAL postgres:16
// with shim_auth.sql + every migration applied (./xc_pg_up.sh).
//
// The real handler still runs in-process with the stubbed Supabase Auth, but
// the PostgREST stub is replaced by a backend that executes the query the
// route issued (`user_id=eq.<uid>&slug=eq.<slug>&select=slug`) inside a
// transaction as role `authenticated` with the BEARER's sub — so the answer
// comes from the migrated schema, its RLS policies and its grants, not from a
// model. Alongside: a direct RLS probe per user (`select count(*)` without any
// filter must only ever see the caller's own rows) and a concurrent burst.
//
//   ./xc_pg_up.sh
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json stress_catalog_drill_pg.test.ts
//
// Without XC_PG_URL the test is `ignore`d — and an ignored run is NOT a pass.
// Seeded (STRESS_SEED); STRESS_PG_USERS users (default 24), each requesting
// every catalog slug once → STRESS_PG_USERS × |catalog| requests.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  envInt,
  isRecord,
  latencySummary,
  loadStressHarness,
  Prng,
  type RestQuery,
  userRequest,
  writeArtifact,
} from "./stress_catalog_drill_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
type Sql = ReturnType<typeof postgres>;

const pgrstError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST for exactly the request shape this route issues, over Postgres. */
function postgrestOverPg(sql: Sql, stats: { queries: number }) {
  return async (query: RestQuery): Promise<Response> => {
    if (query.table !== "user_saved_drills" || query.method !== "GET") {
      return pgrstError(
        404,
        "PGRST205",
        `Could not find the table 'public.${query.table}' in the schema cache`,
      );
    }
    if (!query.bearerUser) return pgrstError(401, "PGRST301", "JWT expired");
    let userId: string | null = null;
    let slug: string | null = null;
    let select = "*";
    for (const [key, value] of query.params) {
      if (key === "select") {
        select = value;
        continue;
      }
      if (!value.startsWith("eq."))
        return pgrstError(400, "PGRST100", `unsupported filter ${key}=${value}`);
      if (key === "user_id") userId = value.slice(3);
      else if (key === "slug") slug = value.slice(3);
      else return pgrstError(400, "PGRST204", `Could not find the '${key}' column`);
    }
    if (select !== "slug") return pgrstError(400, "PGRST204", `unsupported select ${select}`);
    if (userId !== null && !UUID.test(userId)) {
      return pgrstError(400, "22P02", `invalid input syntax for type uuid: "${userId}"`);
    }
    stats.queries += 1;
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local request.jwt.claim.sub = '${query.bearerUser!.id}'`);
      await tx.unsafe(`set local request.jwt.claim.role = 'authenticated'`);
      const conditions: string[] = [];
      const args: string[] = [];
      if (userId !== null) {
        args.push(userId);
        conditions.push(`user_id = $${args.length}::uuid`);
      }
      if (slug !== null) {
        args.push(slug);
        conditions.push(`slug = $${args.length}`);
      }
      const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
      return await tx.unsafe(`select slug from public.user_saved_drills ${where}`, args);
    });
    const list = [...rows].map((r) => ({ slug: String(r.slug) }));
    if (query.accept.includes("application/vnd.pgrst.object+json")) {
      if (list.length !== 1) {
        return pgrstError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
      }
      return new Response(JSON.stringify(list[0]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

Deno.test({
  name: "stress/catalog-drill: user_saved_drills read over a migrated postgres:16 (RLS, saved truth, burst)",
  ignore: PG_URL === "",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 8, onnotice: () => {} });
    const h = await loadStressHarness({ redis: false });
    const stats = { queries: 0 };
    h.restBackend = postgrestOverPg(sql, stats);
    const slugs = (await drillCatalog()).map((d) => d.slug);
    const seed = envInt("STRESS_SEED", 20260905) + 4242;
    const userCount = envInt("STRESS_PG_USERS", 24);
    const rng = new Prng(seed);
    const migrations = Number(
      (await sql.unsafe(`select count(*)::int as n from pg_tables where schemaname = 'public'`))[0]
        .n,
    );
    try {
      // ── seed users + saved rows (owner role; the route never writes here) ──
      const users: Array<{ id: string; token: string; ip: string; saved: Set<string> }> = [];
      for (let u = 0; u < userCount; u += 1) {
        const id = rng.uuid();
        await sql.unsafe(`delete from auth.users where id = '${id}'`);
        await sql.unsafe(
          `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
        );
        const saved = new Set<string>();
        for (const slug of slugs) if (rng.chance(0.4)) saved.add(slug);
        for (const slug of saved) {
          await sql.unsafe(
            `insert into public.user_saved_drills (user_id, slug) values ('${id}', '${slug}')`,
          );
        }
        users.push({ id, token: h.mintSession(id), ip: rng.ip(), saved });
      }
      const totalSaved = users.reduce((n, u) => n + u.saved.size, 0);

      // ── direct RLS probe: unfiltered count as each user sees only its rows ──
      const rlsViolations: string[] = [];
      for (const user of users) {
        const seen = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${user.id}'`);
          return await tx.unsafe(`select user_id, slug from public.user_saved_drills`);
        });
        const foreign = [...seen].filter((r) => String(r.user_id) !== user.id);
        if (foreign.length) rlsViolations.push(`${user.id} sees ${foreign.length} foreign rows`);
        if (seen.length !== user.saved.size)
          rlsViolations.push(`${user.id} sees ${seen.length} rows, owns ${user.saved.size}`);
      }
      assertEquals(rlsViolations, [], "RLS probe");

      // ── every user × every slug through the REAL handler ────────────────────
      const rows: Array<Record<string, unknown>> = [];
      const latencies: number[] = [];
      const violations: string[] = [];
      const trips: Record<string, number> = {};
      for (const user of users) {
        for (const slug of slugs) {
          const res = await h.run(
            userRequest(`/v1/catalog/drills/${encodeURIComponent(slug)}`, {
              token: user.token,
              ip: user.ip,
            }),
          );
          latencies.push(res.latencyMs);
          trips[String(res.roundTrips.supabase)] =
            (trips[String(res.roundTrips.supabase)] ?? 0) + 1;
          const drill = isRecord(res.body) && isRecord(res.body.drill) ? res.body.drill : null;
          const truth = user.saved.has(slug);
          if (res.status !== 200)
            violations.push(`${user.id} ${slug} → ${res.status} ${res.bodyText.slice(0, 120)}`);
          else if (!drill || drill.slug !== slug || drill.saved !== truth) {
            violations.push(`${user.id} ${slug} saved=${String(drill?.saved)} truth=${truth}`);
          }
          if (res.roundTrips.supabase > 3)
            violations.push(`${user.id} ${slug} ${res.roundTrips.supabase} round trips`);
          rows.push({
            user: user.id,
            slug,
            status: res.status,
            saved: drill?.saved ?? null,
            truth,
            latencyMs: Math.round(res.latencyMs * 100) / 100,
            roundTrips: res.roundTrips,
          });
        }
      }
      assertEquals(violations, [], "sequential over postgres");

      // ── a mixed-user burst: nobody may observe another user's row ─────────
      const burstRng = new Prng(seed + 1);
      const plan = Array.from({ length: Math.min(200, userCount * slugs.length) }, () => ({
        user: burstRng.pick(users),
        slug: burstRng.pick(slugs),
      }));
      const t0 = performance.now();
      const answers = await Promise.all(
        plan.map(async (p) => {
          const response = await h.handler(
            userRequest(`/v1/catalog/drills/${encodeURIComponent(p.slug)}`, {
              token: p.user.token,
              ip: p.user.ip,
            }),
          );
          const body = JSON.parse(await response.text());
          return {
            p,
            status: response.status,
            saved: isRecord(body) && isRecord(body.drill) ? body.drill.saved : null,
          };
        }),
      );
      const burstWallMs = performance.now() - t0;
      const burstViolations = answers
        .filter((a) => a.status !== 200 || a.saved !== a.p.user.saved.has(a.p.slug))
        .map((a) => `${a.p.user.id} ${a.p.slug} status=${a.status} saved=${String(a.saved)}`);
      assertEquals(burstViolations, [], "burst over postgres");

      const report = {
        lens: "failure-load/postgres",
        route: "GET /v1/catalog/drills/:slug",
        seed,
        pg: { url: PG_URL.replace(/\/\/.*@/, "//<redacted>@"), publicTables: migrations },
        users: userCount,
        slugs: slugs.length,
        savedRowsSeeded: totalSaved,
        sequential: {
          requests: rows.length,
          supabaseRoundTripsPerRequest: trips,
          latencyMs: latencySummary(latencies),
          violations,
        },
        burst: {
          requests: answers.length,
          wallMs: Math.round(burstWallMs),
          violations: burstViolations,
        },
        rlsProbe: { users: users.length, violations: rlsViolations },
        pgQueriesIssued: stats.queries,
        rows,
      };
      const artifact = await writeArtifact("postgres.json", report);
      console.log(`stress/catalog-drill postgres report → ${artifact}`);
      assert(rows.length === userCount * slugs.length);
    } finally {
      await sql.end({ timeout: 5 });
      h.restore();
    }
  },
});
