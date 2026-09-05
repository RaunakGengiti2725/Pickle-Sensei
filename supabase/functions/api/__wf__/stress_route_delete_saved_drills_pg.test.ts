// FUZZ/BOUNDARY campaign — DELETE /v1/me/saved-drills/:slug through the REAL
// handler, the REAL PostgREST and a REAL postgres:16 with every migration
// applied (./stress_pg_up.sh). Only Supabase Auth stays stubbed: provider
// tokens and session bearers are turned into HS256 JWTs signed with the
// disposable stack's secret, so PostgREST runs the DELETE as `authenticated`
// with auth.uid() = the caller — RLS, grants and the slug check constraint
// are the production ones.
//
// Each iteration is checked against a model of the whole table: an accepted
// request removes exactly (caller, decoded slug) — never another tenant's
// row, never more than one row, never a row on a rejection — and the
// deleted row is restored so every seed sees the same fixture.
//
//   eval "$(./stress_pg_up.sh)" && STRESS_ITER=1000 deno test -A --no-check \
//     --config deno.json stress_route_delete_saved_drills_pg.test.ts
//
// Without STRESS_PG_URL + STRESS_POSTGREST_URL every test is `ignore`d — an
// ignored test is NOT a pass.

import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import {
  b64url,
  buildRequest,
  checkInvariants,
  envInt,
  expectation,
  generateCase,
  type IterationRow,
  iterationSeed,
  type Observed,
  type OracleContext,
  outDir,
  type PoolUser,
  Prng,
  providerIdToken,
  STRESS_REPLAY,
  STRESS_SEED,
  summarize,
  truncateHeaders,
  truncateUrl,
  writeJson,
} from "./stress_saved_drills_shared.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const POSTGREST_URL = (Deno.env.get("STRESS_POSTGREST_URL") ?? "").replace(/\/+$/, "");
const JWT_SECRET =
  Deno.env.get("STRESS_PGRST_JWT_SECRET") ?? "stress-saved-drills-disposable-jwt-secret-0123456789";
const ignore = PG_URL === "" || POSTGREST_URL === "";
const STRESS_ITER = envInt("STRESS_ITER", 120);
const USER_POOL = 24;
const IP_POOL = Array.from({ length: 16 }, (_, i) => `203.0.113.${140 + i}`);

// Slugs every pool user starts with. Shared across tenants on purpose: a
// DELETE by one caller must leave the same slug of every other caller alone.
// All satisfy the table's check constraint (the only rows that can exist).
const FIXTURE_SLUGS = [
  "dink-basics",
  "third-shot-drop",
  "x",
  "Reset-Volley",
  "a_b",
  "0start",
  "eq",
  "in",
  "not",
  "is",
  "like",
  "a".repeat(120),
  "A-Z_09",
];

type Sql = ReturnType<typeof postgres>;

/** Above this many slug characters the real PostgREST refuses the request
 * line (400 "Bad Request" from its HTTP layer) and the route answers the
 * generic 503 — a recorded boundary finding; the campaign tolerates and
 * counts it (summary.uninjected5xx) instead of failing on every such seed. */
const OVERSIZED_SLUG_CHARS = 32_000;

async function signHs256(payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signingInput = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${signingInput}.${b64url(binary)}`;
}

async function sessionJwt(userId: string, exp: number): Promise<string> {
  return await signHs256({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    exp,
    session_id: crypto.randomUUID(),
  });
}

async function buildUsers(seed: number): Promise<PoolUser[]> {
  const rng = new Prng(seed ^ 0x2545f491);
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const users: PoolUser[] = [];
  for (let i = 0; i < USER_POOL; i += 1) {
    const id = rng.uuid();
    const sessionToken = await sessionJwt(id, exp);
    users.push({
      id,
      googleToken: providerIdToken("https://accounts.google.com", id, exp),
      appleToken: providerIdToken("https://appleid.apple.com", id, exp),
      sessionToken,
      accessTokenForProvider: await sessionJwt(id, exp),
    });
  }
  return users;
}

async function seedFixture(sql: Sql, users: PoolUser[]): Promise<Set<string>> {
  const model = new Set<string>();
  for (const user of users) {
    await sql.unsafe(`delete from auth.users where id = '${user.id}'`);
    await sql`insert into auth.users (id, email, raw_app_meta_data)
      values (${user.id}, ${`${user.id.slice(0, 8)}@stress.test`}, ${sql.json({ provider: "google", providers: ["google"] })})`;
    await sql`insert into auth.identities (provider_id, user_id, identity_data, provider)
      values (${`google-${user.id}`}, ${user.id}, ${sql.json({ sub: `google-${user.id}` })}, 'google')`;
    for (const slug of FIXTURE_SLUGS) {
      await sql`insert into public.user_saved_drills (user_id, slug) values (${user.id}, ${slug})`;
      model.add(`${user.id}|${slug}`);
    }
  }
  return model;
}

async function snapshot(sql: Sql, users: PoolUser[]): Promise<Set<string>> {
  const ids = users.map((u) => u.id);
  const rows = await sql<{ user_id: string; slug: string }[]>`
    select user_id, slug from public.user_saved_drills where user_id = any(${ids}::uuid[])`;
  return new Set(rows.map((r) => `${r.user_id}|${r.slug}`));
}

function diff(expected: Set<string>, actual: Set<string>): { missing: string[]; extra: string[] } {
  return {
    missing: [...expected].filter((k) => !actual.has(k)),
    extra: [...actual].filter((k) => !expected.has(k)),
  };
}

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | null;
  apikey: string | null;
}

/** Auth stays stubbed (signed JWTs for the disposable secret); every
 * PostgREST call is forwarded verbatim to the real PostgREST. */
function installUpstream(
  harnessFetch: typeof fetch,
  realFetch: typeof fetch,
  ctx: OracleContext,
  state: { calls: UpstreamCall[]; accessTokens: Map<string, string> },
): void {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    state.calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      apikey: request.headers.get("apikey"),
    });
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const forwarded = new URL(
        `${POSTGREST_URL}${url.pathname.slice("/rest/v1".length)}${url.search}`,
      );
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("apikey");
      return await realFetch(forwarded, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
      const body = (await request.json()) as { id_token?: string };
      const segments = (body.id_token ?? "").split(".");
      let sub = "";
      try {
        sub = String(JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? "");
      } catch {
        sub = "";
      }
      const accessToken = state.accessTokens.get(sub);
      if (!accessToken) {
        return json(400, {
          error: "invalid_grant",
          error_description: "unknown subject for this disposable stack",
        });
      }
      return json(200, {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `refresh-${sub}`,
        user: {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          app_metadata: { provider: "google", providers: ["google"] },
        },
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      const bearer = request.headers.get("authorization") ?? "";
      const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
      const session = ctx.sessionUsers.get(token);
      if (!session) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      return json(200, {
        id: session.id,
        aud: "authenticated",
        role: "authenticated",
        app_metadata: session.provider
          ? { provider: session.provider, providers: [session.provider] }
          : {},
      });
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
}

async function observe(response: Response, calls: UpstreamCall[]): Promise<Observed> {
  const bodyText = await response.text();
  let bodyJson: unknown = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    bodyText,
    bodyJson,
    retryAfter: response.headers.get("retry-after"),
    dbWrites: calls.filter(
      (c) => c.url.includes("/rest/v1/") && !["GET", "HEAD"].includes(c.method),
    ),
  };
}

Deno.test({
  name: `stress fuzz-boundary [postgres:16 + PostgREST]: DELETE /v1/me/saved-drills/:slug × ${STRESS_REPLAY ? "replay" : STRESS_ITER} (seed ${STRESS_SEED})`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    const h = await loadHarness();
    const harnessFetch = globalThis.fetch;
    const users = await buildUsers(STRESS_SEED);
    const ctx: OracleContext = {
      users,
      sessionUsers: new Map(
        users.map((u) => [u.sessionToken, { id: u.id, provider: "google" as const }]),
      ),
      providerAccessToken: (sub) =>
        users.find((u) => u.id === sub)?.accessTokenForProvider ?? `unknown-${sub}`,
      defaultProviderSub: users[0].id,
      oversizedSlugMayFail: OVERSIZED_SLUG_CHARS,
    };
    const upstream = {
      calls: [] as UpstreamCall[],
      accessTokens: new Map(users.map((u) => [u.id, u.accessTokenForProvider])),
    };
    installUpstream(harnessFetch, h.realFetch, ctx, upstream);
    const restoreAccessLog = captureAccessLog(() => undefined);
    const realError = console.error;
    const realWarn = console.warn;
    const upstreamLog: string[] = [];
    console.error = (...args: unknown[]) => {
      upstreamLog.push(args.map(String).join(" ").slice(0, 300));
    };
    console.warn = () => undefined;

    const rows: IterationRow[] = [];
    const tableViolations: Array<{ iteration: number; seed: number; detail: string }> = [];
    const iterations = STRESS_REPLAY
      ? [Number(STRESS_REPLAY)]
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
    const startedAt = performance.now();
    let deletions = 0;
    try {
      const model = await seedFixture(sql, users);
      for (let i = 0; i < iterations.length; i += 1) {
        const seed = iterations[i];
        const fuzz = generateCase(i, seed, {
          users,
          ipPool: IP_POOL,
          faults: false,
          pgSafe: true,
          slugVocabulary: FIXTURE_SLUGS,
        });
        const built = buildRequest(fuzz);
        const base = {
          iteration: i,
          seed,
          family: fuzz.family,
          method: fuzz.method,
          headers: truncateHeaders(fuzz.headers),
          bodyKind: fuzz.bodyKind,
          authKind: fuzz.auth.kind,
          fault: fuzz.fault,
        };
        if ("error" in built) {
          rows.push({
            ...base,
            url: truncateUrl(`${fuzz.base}${fuzz.rawPath}`),
            expected: { kind: "n/a", statuses: [], reason: "unconstructible" },
            status: null,
            requestId: null,
            bodyPreview: "",
            dbWrites: 0,
            durationMs: 0,
            violations: [],
            unconstructible: built.error,
          });
          continue;
        }
        const expect = expectation(fuzz, built.url, ctx);
        upstream.calls = [];
        const t0 = performance.now();
        let seen: Observed;
        try {
          const response = await h.handler(built.request);
          seen = await observe(response, upstream.calls);
        } catch (error) {
          seen = {
            status: -1,
            requestId: null,
            contentType: null,
            bodyText: `HANDLER THREW: ${error instanceof Error ? error.message : String(error)}`,
            bodyJson: null,
            retryAfter: null,
            dbWrites: [],
          };
        }
        const durationMs = performance.now() - t0;
        const violations = checkInvariants(fuzz, expect, seen);
        if (seen.status === -1) violations.unshift(seen.bodyText);

        // Table model: an accepted DELETE removes exactly (caller, slug) — if
        // that row existed — and nothing else; every other outcome leaves the
        // table untouched.
        const expectedTable = new Set(model);
        const removedKey = `${expect.userId}|${expect.slug}`;
        if (seen.status === 204 && expect.kind === "ok" && expectedTable.has(removedKey)) {
          expectedTable.delete(removedKey);
        }
        const actual = await snapshot(sql, users);
        const d = diff(expectedTable, actual);
        if (d.missing.length > 0 || d.extra.length > 0) {
          const detail = `table drift after ${seen.status}: missing=${JSON.stringify(d.missing.slice(0, 5))} extra=${JSON.stringify(d.extra.slice(0, 5))} (expected removal: ${expect.kind === "ok" ? removedKey.slice(0, 80) : "none"})`;
          violations.push(detail);
          tableViolations.push({ iteration: i, seed, detail });
        }
        if (seen.status === 204 && expect.kind === "ok" && model.has(removedKey)) {
          deletions += 1;
          const [userId, slug] = [expect.userId as string, expect.slug as string];
          await sql`insert into public.user_saved_drills (user_id, slug) values (${userId}, ${slug}) on conflict do nothing`;
        } else if (d.missing.length > 0) {
          for (const key of d.missing) {
            const [userId, slug] = key.split("|");
            await sql`insert into public.user_saved_drills (user_id, slug) values (${userId}, ${slug}) on conflict do nothing`;
          }
        }
        rows.push({
          ...base,
          url: truncateUrl(built.request.url),
          expected: { kind: expect.kind, statuses: expect.statuses, reason: expect.reason },
          status: seen.status,
          requestId: seen.requestId,
          bodyPreview: seen.bodyText.slice(0, 200),
          dbWrites: seen.dbWrites.length,
          durationMs: Math.round(durationMs * 100) / 100,
          violations,
        });
      }
    } finally {
      globalThis.fetch = harnessFetch;
      console.error = realError;
      console.warn = realWarn;
      restoreAccessLog();
      h.reset();
      for (const user of users) await sql.unsafe(`delete from auth.users where id = '${user.id}'`);
      await sql.end();
    }

    const summary = summarize(rows);
    const report = {
      unit: "route-delete-v1-me-saved-drills-slug",
      lens: "fuzz-boundary",
      mode: "in-process handler → real PostgREST → postgres:16 with every migration; Supabase Auth stubbed with signed HS256 JWTs",
      campaignSeed: STRESS_SEED,
      requestedIterations: STRESS_REPLAY ? 1 : STRESS_ITER,
      replay: STRESS_REPLAY || null,
      wallMs: Math.round(performance.now() - startedAt),
      realDeletions: deletions,
      fixtureSlugs: FIXTURE_SLUGS,
      tableViolations,
      upstreamLog,
      replayCommand: `eval "$(./stress_pg_up.sh)" && STRESS_SEED=${STRESS_SEED} STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_route_delete_saved_drills_pg.test.ts`,
      summary,
      rows,
    };
    const file = `${outDir()}/pg_${STRESS_SEED}${STRESS_REPLAY ? `_replay_${STRESS_REPLAY}` : ""}.json`;
    await writeJson(file, report);
    const failing = rows.filter((r) => r.violations.length > 0);
    if (STRESS_REPLAY || failing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            file,
            summary: { ...summary, byFamily: undefined },
            failing: failing.slice(0, 20),
            upstreamLog: upstreamLog.slice(0, 20),
          },
          null,
          2,
        ),
      );
    }
    assertEquals(
      failing.map(
        (r) =>
          `#${r.iteration} seed=${r.seed} [${r.family}] → ${r.status}: ${r.violations.join(" | ")}`,
      ),
      [],
      `${failing.length}/${summary.executed} iterations violated an invariant; table: ${file}`,
    );
    if ((summary.executed as number) < (STRESS_REPLAY ? 1 : STRESS_ITER) * 0.97) {
      throw new Error(
        `only ${summary.executed} of ${STRESS_ITER} iterations were constructible; table: ${file}`,
      );
    }
    if (!STRESS_REPLAY && deletions === 0) {
      throw new Error(
        `campaign never deleted a real row — fixture/vocabulary mismatch; table: ${file}`,
      );
    }
  },
});

// Pinned Postgres-backed probes: idempotent redelivery, tenant isolation and
// the PostgREST-operator / traversal / NUL payloads against the real table.
Deno.test({
  name: "stress fuzz-boundary [postgres:16 + PostgREST]: idempotent redelivery + tenant isolation probes",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    const h = await loadHarness();
    const harnessFetch = globalThis.fetch;
    const users = await buildUsers(STRESS_SEED ^ 0x77);
    const ctx: OracleContext = {
      users,
      sessionUsers: new Map(
        users.map((u) => [u.sessionToken, { id: u.id, provider: "google" as const }]),
      ),
      providerAccessToken: (sub) =>
        users.find((u) => u.id === sub)?.accessTokenForProvider ?? `unknown-${sub}`,
      defaultProviderSub: users[0].id,
    };
    const upstream = {
      calls: [] as UpstreamCall[],
      accessTokens: new Map(users.map((u) => [u.id, u.accessTokenForProvider])),
    };
    installUpstream(harnessFetch, h.realFetch, ctx, upstream);
    const restoreAccessLog = captureAccessLog(() => undefined);
    const realError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const [a, b] = users;
    const del = async (user: PoolUser, rawSlug: string, token = user.sessionToken) => {
      const response = await h.handler(
        new Request(`http://edge.test/functions/v1/api/v1/me/saved-drills/${rawSlug}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.180" },
        }),
      );
      return { status: response.status, text: await response.text() };
    };
    const has = async (user: PoolUser, slug: string) =>
      (
        await sql`select 1 from public.user_saved_drills where user_id = ${user.id} and slug = ${slug}`
      ).length === 1;
    try {
      await seedFixture(sql, users);
      // Idempotent redelivery: first DELETE removes, replay is a 204 no-op.
      assertEquals(await has(a, "dink-basics"), true);
      assertEquals((await del(a, "dink-basics")).status, 204);
      assertEquals(await has(a, "dink-basics"), false);
      assertEquals((await del(a, "dink-basics")).status, 204);
      assertEquals((await del(a, "dink-basics")).status, 204);
      assertEquals(await has(b, "dink-basics"), true, "other tenant's identical slug survives");
      // Tenant isolation through every provider/session bearer shape.
      assertEquals((await del(a, "third-shot-drop", a.googleToken)).status, 204);
      assertEquals(await has(a, "third-shot-drop"), false);
      assertEquals(await has(b, "third-shot-drop"), true);
      assertEquals((await del(b, "x", b.appleToken)).status, 204);
      assertEquals(await has(b, "x"), false);
      assertEquals(await has(a, "x"), true);
      // Filter-injection / operator / wildcard payloads: 204, no row moves.
      const before = await snapshot(sql, users);
      for (const raw of [
        `x%26user_id%3Deq.${b.id}`,
        `Reset-Volley%26user_id%3Din.(${a.id},${b.id})`,
        "*",
        "%2A",
        "in.(a_b,0start)",
        "eq.a_b",
        "not.eq.zzz",
        "is.null",
        "like.%2A",
        "a_b,0start",
        "%00",
        "a%00b",
        "%C3%A9",
        "%F0%9F%8F%93",
        "'%20OR%20'1'%3D'1",
        "a".repeat(8_000),
      ]) {
        const r = await del(a, raw);
        assertEquals(r.status, 204, `${raw.slice(0, 60)} → ${r.status} ${r.text}`);
        assertEquals(
          diff(before, await snapshot(sql, users)),
          { missing: [], extra: [] },
          `${raw.slice(0, 60)} moved rows`,
        );
      }
      // Dot segments (raw or %2E-encoded) are collapsed by the URL layer before
      // routing: they never reach the route, let alone PostgREST.
      for (const raw of ["..", "%2E%2E", "%2e%2e", "."]) {
        const r = await del(a, raw);
        assertEquals(r.status, 404, `${raw} → ${r.status} ${r.text}`);
        assertEquals(diff(before, await snapshot(sql, users)), { missing: [], extra: [] });
      }
      // Case sensitivity is exact: the lowercase spelling of a mixed-case
      // fixture slug is a different key and deletes nothing.
      assertEquals((await del(a, "reset-volley")).status, 204);
      assertEquals(await has(a, "Reset-Volley"), true);
      assertEquals((await del(a, "Reset-Volley")).status, 204);
      assertEquals(await has(a, "Reset-Volley"), false);
      assertEquals(logged, [], "no upstream error was logged during accepted deletes");
    } finally {
      globalThis.fetch = harnessFetch;
      console.error = realError;
      restoreAccessLog();
      h.reset();
      for (const user of users) await sql.unsafe(`delete from auth.users where id = '${user.id}'`);
      await sql.end();
    }
  },
});

// PostgREST's own limits are part of the boundary: a slug the URL layer
// accepts but PostgREST/Postgres refuse must surface as the generic 503, with
// the detail only in the function log and no row touched.
Deno.test({
  name: "stress fuzz-boundary [postgres:16 + PostgREST]: oversized slug boundary",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    const h = await loadHarness();
    const harnessFetch = globalThis.fetch;
    const users = await buildUsers(STRESS_SEED ^ 0x99);
    const ctx: OracleContext = {
      users,
      sessionUsers: new Map(
        users.map((u) => [u.sessionToken, { id: u.id, provider: "google" as const }]),
      ),
      providerAccessToken: (sub) =>
        users.find((u) => u.id === sub)?.accessTokenForProvider ?? `unknown-${sub}`,
      defaultProviderSub: users[0].id,
    };
    const upstream = {
      calls: [] as UpstreamCall[],
      accessTokens: new Map(users.map((u) => [u.id, u.accessTokenForProvider])),
    };
    installUpstream(harnessFetch, h.realFetch, ctx, upstream);
    const restoreAccessLog = captureAccessLog(() => undefined);
    const realError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const outcomes: Array<{ length: number; status: number; body: string; logged: string[] }> = [];
    const probe = async (length: number) => {
      const logStart = logged.length;
      const response = await h.handler(
        new Request(`http://edge.test/functions/v1/api/v1/me/saved-drills/${"a".repeat(length)}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${users[0].sessionToken}`,
            "x-forwarded-for": "203.0.113.181",
          },
        }),
      );
      const body = await response.text();
      outcomes.push({
        length,
        status: response.status,
        body: body.slice(0, 200),
        logged: logged.slice(logStart).map((l) => l.slice(0, 160)),
      });
      if (response.status !== 204) {
        assertEquals(response.status, 503, `slug of ${length} chars → ${response.status} ${body}`);
        assertEquals(JSON.parse(body), {
          error: { message: "Drill unsave is temporarily unavailable. Please try again." },
        });
      }
      return response.status;
    };
    try {
      await seedFixture(sql, users);
      const before = await snapshot(sql, users);
      // 120 chars is the check-constraint maximum and a fixture row: it is the
      // one oversized-family probe that must actually delete (and only that row).
      assertEquals(await probe(120), 204);
      assertEquals(diff(before, await snapshot(sql, users)), {
        missing: [`${users[0].id}|${"a".repeat(120)}`],
        extra: [],
      });
      await sql`insert into public.user_saved_drills (user_id, slug) values (${users[0].id}, ${"a".repeat(120)})`;
      for (const length of [121, 1_000, 8_000, 16_000, 32_000, 64_000, 200_000]) {
        await probe(length);
        assertEquals(diff(before, await snapshot(sql, users)), { missing: [], extra: [] });
      }
      // Bisect the first slug length the stack no longer answers 204 for.
      let ok = 32_000;
      let bad = 64_000;
      if ((await probe(ok)) === 204 && (await probe(bad)) !== 204) {
        while (bad - ok > 256) {
          const mid = Math.floor((ok + bad) / 2);
          if ((await probe(mid)) === 204) ok = mid;
          else bad = mid;
        }
      }
      assertEquals(diff(before, await snapshot(sql, users)), { missing: [], extra: [] });
      await writeJson(`${outDir()}/pg_oversized_slug_${STRESS_SEED}.json`, {
        lastOkSlugChars: ok,
        firstFailingSlugChars: bad,
        dbSlugCheckConstraintMaxChars: 120,
        outcomes,
      });
    } finally {
      globalThis.fetch = harnessFetch;
      console.error = realError;
      restoreAccessLog();
      h.reset();
      for (const user of users) await sql.unsafe(`delete from auth.users where id = '${user.id}'`);
      await sql.end();
    }
  },
});
