// stress-route-get-v1-me / lens failure-load — REAL Postgres half.
//
// GET /v1/me reads `public.profiles` through PostgREST (no RPC). Here the
// harness's PostgREST fake is pointed at a disposable postgres:16 with
// supabase/tests/shim_auth.sql + EVERY migration applied (./xc_pg_up.sh): the
// route's exact `select=` column list and `id=eq.<uuid>` filter are executed
// as role `authenticated` with the bearer's `sub` as the RLS claim, so the
// migrated schema, the owner-only policy, the signup trigger
// (`handle_new_user` on auth.users) and real SQL errors are what the handler
// sees — the in-process handler and its Auth/Upstash fakes are unchanged.
//
//   ./xc_pg_up.sh                      # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json stress_me_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
// STRESS_PG_REQ (default 300) sizes the latency campaign; STRESS_PG_USERS
// (default 50) the number of real auth.users rows created.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  callMe,
  envInt,
  freshIp,
  latencySummary,
  leaksDetail,
  loadStressHarness,
  meBodyProblems,
  meRequest,
  Prng,
  replayCommand,
  type RestRequest,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_me_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_REQ = envInt("STRESS_PG_REQ", 300);
const PG_USERS = envInt("STRESS_PG_USERS", 50);
const CONCURRENCY = Math.max(1, envInt("STRESS_CONCURRENCY", 8));

type Sql = ReturnType<typeof postgres>;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pgrst = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Translate the one PostgREST shape the route uses into SQL under RLS.
 * Anything else is answered like PostgREST would (400 with a PGRST code)
 * so an unexpected query shows up as a failure, not a silent pass. */
function pgBackend(
  sql: Sql,
  hooks: { sqlErrorOnce?: string | null; delayMs?: number } = {},
) {
  return async (request: RestRequest): Promise<Response> => {
    if (request.method !== "GET") {
      return pgrst(405, {
        code: "PGRST103",
        message: `stress pg backend: ${request.method}`,
      });
    }
    if (!IDENT.test(request.table)) {
      return pgrst(400, { code: "PGRST100", message: "bad table" });
    }
    const columns = request.select.split(",").map((c) => c.trim());
    if (columns.some((c) => !IDENT.test(c))) {
      return pgrst(400, {
        code: "PGRST100",
        message: `bad select ${request.select}`,
      });
    }
    const where: string[] = [];
    const params: string[] = [];
    for (const [column, expr] of Object.entries(request.filters)) {
      if (!IDENT.test(column) || !expr.startsWith("eq.")) {
        return pgrst(400, {
          code: "PGRST100",
          message: `unsupported filter ${column}=${expr}`,
        });
      }
      params.push(expr.slice(3));
      where.push(`${column} = $${params.length}`);
    }
    if (!request.sub || !UUID.test(request.sub)) {
      return pgrst(401, { code: "PGRST301", message: "JWT sub missing" });
    }
    if (hooks.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, hooks.delayMs));
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${request.sub}'`);
        if (hooks.sqlErrorOnce) {
          const statement = hooks.sqlErrorOnce;
          hooks.sqlErrorOnce = null;
          await tx.unsafe(statement);
        }
        return await tx.unsafe(
          `select ${columns.join(", ")} from public.${request.table}${
            where.length ? ` where ${where.join(" and ")}` : ""
          }`,
          params,
        );
      });
      const list = Array.from(rows as Iterable<Record<string, unknown>>);
      if (request.wantsObject) {
        if (list.length !== 1) {
          return pgrst(406, {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
          });
        }
        return pgrst(200, list[0]);
      }
      return pgrst(200, list);
    } catch (error) {
      const e = error as {
        code?: string;
        message?: string;
        detail?: string;
        hint?: string;
      };
      // PostgREST maps SQLSTATE classes to HTTP: 42501 → 403, 42xxx → 400, other → 500.
      const status = e.code === "42501"
        ? 403
        : e.code?.startsWith("42")
        ? 400
        : 500;
      return pgrst(status, {
        code: e.code ?? "XX000",
        message: e.message ?? String(error),
        details: e.detail ?? null,
        hint: e.hint ?? null,
      });
    }
  };
}

async function createRealUser(
  sql: Sql,
  userId: string,
  complete: boolean,
): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  // Real signup path: the auth.users insert fires handle_new_user() → profile row.
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${
      userId.slice(0, 8)
    }@example.com', '{"provider":"google"}')`,
  );
  if (complete) {
    await sql.unsafe(
      `update public.profiles set onboarding_state = 'complete', skill_level = 'intermediate', handedness = 'right',
         primary_goal = 'consistency', biggest_problem = 'pop-ups', focus_checkpoint = 'paddle_face', first_name = 'Pat'
       where id = '${userId}'`,
    );
  }
}

async function setup(): Promise<{ sql: Sql; h: StressHarness }> {
  const sql = postgres(PG_URL, { max: CONCURRENCY + 2, onnotice: () => {} });
  const h = await loadStressHarness({ redis: true });
  h.reset();
  h.recordCalls = false;
  return { sql, h };
}

Deno.test({
  name:
    "stress-me-pg schema: the route's exact profiles SELECT runs against every migration; trigger-created row → 200 (complete + pending)",
  ignore,
  async fn() {
    const { sql, h } = await setup();
    try {
      h.restBackend = pgBackend(sql);
      const prng = new Prng(STRESS_SEED ^ 0x9d);
      const results: Array<Record<string, unknown>> = [];
      for (const complete of [true, false]) {
        const userId = prng.uuid();
        await createRealUser(sql, userId, complete);
        h.registerUser(userId);
        const token = h.mintSession(userId).accessToken;
        const observed = await callMe(h, meRequest({ token }));
        const problems = observed.status === 200
          ? meBodyProblems(observed.body, userId)
          : [`status ${observed.status}`];
        const body = observed.body as {
          onboardingState?: string;
          profile?: Record<string, unknown>;
          user?: Record<string, unknown>;
        } | null;
        if (body?.onboardingState !== (complete ? "complete" : "pending")) {
          problems.push(`onboardingState ${String(body?.onboardingState)}`);
        }
        if (complete && body?.profile?.first_name !== "Pat") {
          problems.push("profile.first_name not from the real row");
        }
        if (!complete && body?.profile?.skill_level !== null) {
          problems.push("pending profile should have null skill_level");
        }
        results.push({
          userId,
          complete,
          status: observed.status,
          counts: observed.counts,
          durationMs: observed.durationMs,
          body: observed.body,
          problems,
        });
        assertEquals(problems, [], JSON.stringify(observed.body));
        assertEquals(observed.counts.rest, 1);
      }
      const path = await writeArtifact("pg_schema.json", {
        unit: "route-get-v1-me",
        lens: "failure-load",
        pg: "postgres:16 + shim_auth + all migrations",
        results,
      });
      console.log(
        `[stress-me-pg] schema: ${results.length} real rows served → ${path}`,
      );
    } finally {
      h.restBackend = null;
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-me-pg rls: a bearer whose sub is another user reads 0 rows → 503 after the 400 ms retry (no cross-user profile), owner still 200",
  ignore,
  async fn() {
    const { sql, h } = await setup();
    try {
      h.restBackend = pgBackend(sql);
      const prng = new Prng(STRESS_SEED ^ 0x715);
      const victim = prng.uuid();
      const other = prng.uuid();
      await createRealUser(sql, victim, true);
      await createRealUser(sql, other, true);
      // Direct RLS probe through the same backend the handler uses.
      const cross = await pgBackend(sql)({
        method: "GET",
        table: "profiles",
        select: "id, email",
        filters: { id: `eq.${victim}` },
        sub: other,
        wantsObject: false,
      });
      const crossRows = (await cross.json()) as unknown[];
      assertEquals(cross.status, 200);
      assertEquals(crossRows, []);
      // Through the handler: the row exists but is NOT the caller's → the route
      // sees "no row", retries once after 400 ms, then fails retryably.
      h.registerUser(victim);
      const token = h.mintSession(victim).accessToken;
      // Point the backend's RLS claim at a different user for this bearer only.
      const backend = pgBackend(sql);
      h.restBackend = (request) => backend({ ...request, sub: other });
      const denied = await callMe(h, meRequest({ token }));
      h.restBackend = pgBackend(sql);
      const owner = await callMe(h, meRequest({ token }));
      const path = await writeArtifact("pg_rls.json", {
        unit: "route-get-v1-me",
        lens: "failure-load",
        crossUserDirectRows: crossRows.length,
        deniedThroughRoute: {
          status: denied.status,
          message: denied.message,
          retryAfter: denied.retryAfter,
          restCalls: denied.counts.rest,
          durationMs: denied.durationMs,
          leaks: leaksDetail(denied),
        },
        ownerThroughRoute: {
          status: owner.status,
          restCalls: owner.counts.rest,
        },
      });
      console.log(
        `[stress-me-pg] rls: cross-user rows ${crossRows.length}, route ${denied.status} after ${denied.counts.rest} selects / ${denied.durationMs} ms, owner ${owner.status} → ${path}`,
      );
      assertEquals(denied.status, 503);
      assertEquals(denied.counts.rest, 2);
      assert(denied.durationMs >= 400, `retry gap ${denied.durationMs} ms`);
      assert(!leaksDetail(denied));
      assertEquals(owner.status, 200);
    } finally {
      h.restBackend = null;
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-me-pg sql errors: real SQLSTATE failures (division_by_zero 22012, statement_timeout 57014, undefined_column 42703) → generic 503, no detail leaks, next request recovers",
  ignore,
  async fn() {
    const { sql, h } = await setup();
    try {
      const prng = new Prng(STRESS_SEED ^ 0x5e);
      const userId = prng.uuid();
      await createRealUser(sql, userId, true);
      h.registerUser(userId);
      const token = h.mintSession(userId).accessToken;
      h.restBackend = pgBackend(sql);
      const warm = await callMe(h, meRequest({ token }));
      assertEquals(warm.status, 200);
      const cases = [
        { id: "PG-E1", sqlstate: "22012", statement: "select 1/0" },
        {
          id: "PG-E2",
          sqlstate: "57014",
          statement:
            "set local statement_timeout = '5ms'; select pg_sleep(0.2)",
        },
        {
          id: "PG-E3",
          sqlstate: "42703",
          statement: "select no_such_column from public.profiles",
        },
        {
          id: "PG-E4",
          sqlstate: "42501",
          statement:
            "insert into public.profiles (id) values (gen_random_uuid())",
        },
      ];
      const rows: Array<Record<string, unknown>> = [];
      for (const c of cases) {
        const hooks = { sqlErrorOnce: c.statement };
        h.restBackend = pgBackend(sql, hooks);
        h.errorLog = [];
        const observed = await callMe(h, meRequest({ token }));
        const logged = h.errorLog.join("\n");
        h.restBackend = pgBackend(sql);
        const recovery = await callMe(h, meRequest({ token }));
        const problems: string[] = [];
        if (observed.status !== 503) problems.push(`status ${observed.status}`);
        if (leaksDetail(observed) || observed.text.includes(c.sqlstate)) {
          problems.push("detail leaked to the client");
        }
        if (!logged.includes("[api] Your account:")) {
          problems.push("operator log lacks the SQL detail");
        }
        if (recovery.status !== 200) {
          problems.push(`recovery ${recovery.status}`);
        }
        rows.push({
          ...c,
          status: observed.status,
          message: observed.message,
          restCalls: observed.counts.rest,
          durationMs: observed.durationMs,
          recovery: recovery.status,
          loggedSqlstate: logged.includes(c.sqlstate),
          problems,
        });
        assertEquals(
          problems,
          [],
          `${c.id}: ${observed.text} / log: ${logged.slice(0, 300)}`,
        );
      }
      const path = await writeArtifact("pg_sql_errors.json", {
        unit: "route-get-v1-me",
        lens: "failure-load",
        rows,
      });
      console.log(
        `[stress-me-pg] sql errors: ${rows.length} SQLSTATEs → generic 503 each → ${path}`,
      );
    } finally {
      h.restBackend = null;
      await sql.end();
    }
  },
});

Deno.test({
  name:
    `stress-me-pg load: ${PG_REQ} requests over ${PG_USERS} real users, concurrency ${CONCURRENCY} — p50/p95 with a real SELECT per request`,
  ignore,
  async fn() {
    const { sql, h } = await setup();
    try {
      h.captureLogs = false;
      h.restBackend = pgBackend(sql);
      const prng = new Prng(STRESS_SEED ^ 0x10ad);
      const users: Array<{ userId: string; token: string; ip: string }> = [];
      for (let i = 0; i < PG_USERS; i += 1) {
        const userId = prng.uuid();
        await createRealUser(sql, userId, i % 3 !== 2);
        h.registerUser(userId);
        users.push({
          userId,
          token: h.mintSession(userId).accessToken,
          ip: freshIp(),
        });
      }
      const durations: number[] = [];
      const statusCounts: Record<string, number> = {};
      const problems: string[] = [];
      let rest = 0;
      let auth = 0;
      let stampede = 0;
      const served = new Set<string>();
      for (let start = 0; start < PG_REQ; start += CONCURRENCY) {
        const size = Math.min(CONCURRENCY, PG_REQ - start);
        const picks = Array.from(
          { length: size },
          (_, k) =>
            users[
              new Prng((STRESS_SEED + (start + k) * 0x9e3779b1) >>> 0).int(
                0,
                users.length - 1,
              )
            ],
        );
        // Parallel first requests of one bearer each verify upstream (no
        // single-flight) — counted so the Auth total can be bounded exactly.
        const inBatch = new Set<string>();
        for (const u of picks) {
          if (!served.has(u.userId) && inBatch.has(u.userId)) stampede += 1;
          inBatch.add(u.userId);
        }
        for (const u of picks) served.add(u.userId);
        h.mark();
        const results = await Promise.all(
          picks.map(async (u) => {
            const t0 = performance.now();
            const response = await h.handler(
              meRequest({ token: u.token, ip: u.ip }),
            );
            const text = await response.text();
            return {
              status: response.status,
              ms: performance.now() - t0,
              text,
              u,
            };
          }),
        );
        const counts = h.snapshot();
        rest += counts.rest;
        auth += counts.auth;
        if (counts.rest !== size) {
          problems.push(
            `batch@${start}: ${counts.rest} selects for ${size} requests`,
          );
        }
        for (const r of results) {
          durations.push(r.ms);
          statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
          if (r.status !== 200) {
            problems.push(`${r.u.userId.slice(0, 8)} → ${r.status}`);
          } else {
            const bodyProblems = meBodyProblems(JSON.parse(r.text), r.u.userId);
            if (bodyProblems.length) problems.push(bodyProblems.join("; "));
          }
        }
      }
      const path = await writeArtifact("pg_load.json", {
        unit: "route-get-v1-me",
        lens: "failure-load",
        seed: STRESS_SEED,
        requests: durations.length,
        users: PG_USERS,
        concurrency: CONCURRENCY,
        statusCounts,
        upstream: {
          auth,
          rest,
          selectsPerRequest: rest / durations.length,
          stampedeDuplicates: stampede,
        },
        latencyMs: latencySummary(durations),
        replay: replayCommand(
          "stress-me-pg load",
          STRESS_SEED,
          `XC_PG_URL=$XC_PG_URL STRESS_PG_REQ=${PG_REQ} STRESS_PG_USERS=${PG_USERS} `,
        ),
        problems,
      });
      const summary = latencySummary(durations);
      console.log(
        `[stress-me-pg] load: ${durations.length} requests p50 ${summary.p50} ms p95 ${summary.p95} ms, ${rest} real selects, ${auth} auth verifies → ${path}`,
      );
      assertEquals(problems, []);
      assertEquals(rest, durations.length);
      assert(
        auth >= PG_USERS && auth <= PG_USERS + stampede,
        `auth verifies ${auth} for ${PG_USERS} users (+${stampede} parallel duplicates)`,
      );
    } finally {
      h.restBackend = null;
      h.captureLogs = true;
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-me-pg deletion race: the user's row cascades away (account deleted) while the bearer is still cached → 503 retryable, never another user's data",
  ignore,
  async fn() {
    const { sql, h } = await setup();
    try {
      h.restBackend = pgBackend(sql);
      const prng = new Prng(STRESS_SEED ^ 0xdead);
      const userId = prng.uuid();
      await createRealUser(sql, userId, true);
      h.registerUser(userId);
      const token = h.mintSession(userId).accessToken;
      const before = await callMe(h, meRequest({ token }));
      assertEquals(before.status, 200);
      await sql.unsafe(`delete from auth.users where id = '${userId}'`);
      const gone = await callMe(h, meRequest({ token }));
      const path = await writeArtifact("pg_deletion_race.json", {
        unit: "route-get-v1-me",
        lens: "failure-load",
        before: { status: before.status },
        afterCascade: {
          status: gone.status,
          message: gone.message,
          retryAfter: gone.retryAfter,
          restCalls: gone.counts.rest,
          authCalls: gone.counts.auth,
          durationMs: gone.durationMs,
          leaks: leaksDetail(gone),
        },
      });
      console.log(
        `[stress-me-pg] deletion race: cached bearer after cascade → ${gone.status} (${gone.counts.rest} selects, ${gone.durationMs} ms) → ${path}`,
      );
      // Either verdict keeps the user's data private; 503 (row gone, bearer
      // still cached) is what the current code answers until the cache expires.
      assert(
        gone.status === 503 || gone.status === 401,
        `status ${gone.status}`,
      );
      assertEquals(gone.counts.auth, 0);
      assert(!leaksDetail(gone));
    } finally {
      h.restBackend = null;
      await sql.end();
    }
  },
});
