// Auth session lifecycle against the REAL edge handler: bootstrap → refresh →
// logout must revoke EVERY bearer of the Supabase session — the pre-refresh
// sibling, a bearer re-cached by a request racing the logout, and a row still
// held in another isolate's L1 — within one request, without waiting for the
// ~10 min auth-cache window. The fakes below (stateful Supabase Auth with
// sessions + refresh rotation + scope=local logout + getUser, and an Upstash
// pipeline emulating L2) are installed at the fetch layer; nothing hosted is
// touched and nothing here is a secret.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json be-auth-session-lifecycle.test.ts

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";

const SUPABASE_URL = "http://supabase.lifecycle.test";
const REDIS_URL = "http://redis.lifecycle.test";
const PROBE_ROUTE = "/v1/me/saved-drills"; // authenticated, PostgREST list → 200 []
const USER = "11111111-1111-4111-8111-111111111111";
/** Mirrors AUTH_CACHE_MAX_TTL_SECONDS in index.ts: a tombstone must outlive
 * any cached verification of the session. */
const AUTH_CACHE_MAX_TTL_SECONDS = 600;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const authCacheKey = async (token: string) => `auth:${await sha256Hex(token)}`;
const sessionIdOf = (token: string): string =>
  String(JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).session_id);

// ─── fake Supabase Auth ─────────────────────────────────────────────────────

interface Session {
  id: string;
  userId: string;
  accessTokens: string[];
  refreshToken: string;
  revoked: boolean;
}
const sessions = new Map<string, Session>();
let counter = 0;
/** Every upstream interaction in order: auth:* for Supabase Auth, redis:<CMD>
 * per pipeline command, rest:* for PostgREST. */
const timeline: string[] = [];
let logoutGate: Promise<void> | null = null;
let logoutStarted: (() => void) | null = null;

function mintAccessToken(session: Session): string {
  counter += 1;
  const now = Math.floor(Date.now() / 1000);
  const token = jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: session.userId,
    aud: "authenticated",
    role: "authenticated",
    session_id: session.id,
    jti: `jti-${counter}`,
    exp: now + 3600,
    iat: now,
  });
  session.accessTokens.push(token);
  return token;
}
function newSession(userId: string): Session {
  counter += 1;
  const session: Session = {
    id: `sess-${counter}`,
    userId,
    accessTokens: [],
    refreshToken: `rt-${counter}`,
    revoked: false,
  };
  sessions.set(session.id, session);
  return session;
}
function liveSessionForToken(token: string): Session | null {
  for (const session of sessions.values()) {
    if (!session.revoked && session.accessTokens.includes(token)) return session;
  }
  return null;
}
const userJson = (userId: string) => ({
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
});
const sessionJson = (session: Session, accessToken: string) => ({
  access_token: accessToken,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: session.refreshToken,
  user: userJson(session.userId),
});
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ─── fake Upstash (L2) ──────────────────────────────────────────────────────

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}
const redisStore = new Map<string, RedisEntry>();
function redisLive(key: string): RedisEntry | null {
  const entry = redisStore.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    redisStore.delete(key);
    return null;
  }
  return entry;
}
function redisCommand(command: Array<string | number>): { result: unknown } {
  const [op, ...args] = command.map(String);
  timeline.push(`redis:${op}:${args[0] ?? ""}`);
  switch (op) {
    case "GET":
      return { result: redisLive(args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : null;
      redisStore.set(args[0], { value: args[1], expiresAtMs: ttl ? Date.now() + ttl * 1000 : null });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (redisStore.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      redisStore.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(args[0]);
      if (!entry) return { result: 0 };
      if (args[2] === "NX" && entry.expiresAtMs !== null) return { result: 0 };
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { result: null };
  }
}

// ─── fetch layer ────────────────────────────────────────────────────────────

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const text = await request.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }

  if (url.origin === REDIS_URL) {
    const commands = JSON.parse(text) as Array<Array<string | number>>;
    return json(200, commands.map(redisCommand));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    timeline.push(`auth:token:${grant}`);
    if (grant === "id_token") {
      const idToken = String(body.id_token ?? "");
      const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      const session = newSession(String(payload.sub));
      return json(200, sessionJson(session, mintAccessToken(session)));
    }
    if (grant === "refresh_token") {
      const presented = String(body.refresh_token ?? "");
      for (const session of sessions.values()) {
        if (!session.revoked && session.refreshToken === presented) {
          counter += 1;
          session.refreshToken = `rt-${counter}`;
          return json(200, sessionJson(session, mintAccessToken(session)));
        }
      }
      return json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    }
    return json(400, { code: 400, msg: "unsupported grant" });
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    timeline.push("auth:getUser");
    const session = liveSessionForToken(bearer);
    if (!session) {
      return json(401, { code: 401, error_code: "session_not_found", msg: "Session does not exist" });
    }
    return json(200, userJson(session.userId));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
    timeline.push("auth:logout");
    logoutStarted?.();
    if (logoutGate) await logoutGate;
    const session = liveSessionForToken(bearer);
    if (!session) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    session.revoked = true;
    return new Response(null, { status: 204 });
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    timeline.push(`rest:${request.method}`);
    const table = url.pathname.slice("/rest/v1/".length);
    if (request.method === "GET" && table === "profiles") {
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      return json(200, [
        {
          id,
          email: null,
          onboarding_state: "complete",
          provider: "google",
          skill_level: null,
          handedness: null,
          primary_goal: null,
          biggest_problem: null,
          focus_checkpoint: null,
          first_name: null,
          gender: null,
        },
      ]);
    }
    if (request.method !== "GET") return new Response(null, { status: 201 });
    const single = (request.headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
    return json(200, single ? {} : []);
  }
  return new Response(`unexpected fetch in lifecycle test: ${request.method} ${request.url}`, {
    status: 599,
  });
}

// ─── handler boot ───────────────────────────────────────────────────────────

let handler: ((request: Request) => Promise<Response>) | null = null;

async function boot(): Promise<(request: Request) => Promise<Response>> {
  if (handler) return handler;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-lifecycle-key");
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-lifecycle-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "lifecycle-webhook-secret");
  for (const key of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
    "REVENUECAT_SECRET_API_KEY",
    "REVENUECAT_PUBLIC_SDK_KEY",
  ]) {
    Deno.env.delete(key);
  }
  Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-lifecycle-token");

  globalThis.fetch = fakeFetch as typeof fetch;
  captureAccessLog(() => undefined);
  Deno.serve = ((...args: unknown[]) => {
    const found = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!found) throw new Error("Deno.serve called without a handler");
    handler = found;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;
  await import("../index.ts");
  if (!handler) throw new Error("index.ts did not call Deno.serve");
  return handler;
}

let ipCounter = 0;
/** Fresh client IP per test so the per-IP budgets never couple tests. */
const freshIp = (): string => `198.51.100.${(ipCounter += 1)}`;

async function call(
  method: string,
  path: string,
  options: { token?: string; ip: string; body?: unknown },
): Promise<Response> {
  const h = await boot();
  const headers = new Headers({ "x-forwarded-for": options.ip });
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  const response = await h(
    new Request(`http://edge.lifecycle.test/functions/v1/api${path}`, { method, headers, body }),
  );
  await response.text().catch(() => undefined);
  return response;
}

async function bootstrap(ip: string): Promise<{ accessToken: string; refreshToken: string }> {
  const now = Math.floor(Date.now() / 1000);
  const idToken = jwt({
    iss: "https://accounts.google.com",
    sub: USER,
    aud: "com.picklesensei",
    exp: now + 3600,
    iat: now,
  });
  const h = await boot();
  const response = await h(
    new Request("http://edge.lifecycle.test/functions/v1/api/v1/account/bootstrap", {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }),
  );
  const payload = (await response.json()) as {
    session?: { accessToken: string; refreshToken: string };
  };
  assert(
    response.status === 200 && payload.session,
    `bootstrap should return a session (status ${response.status})`,
  );
  return payload.session;
}

async function refresh(ip: string, refreshToken: string): Promise<string> {
  const h = await boot();
  const response = await h(
    new Request("http://edge.lifecycle.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }),
  );
  const payload = (await response.json()) as { session?: { accessToken: string } };
  assert(response.status === 200 && payload.session, `refresh should rotate (status ${response.status})`);
  return payload.session.accessToken;
}

const getUserCalls = () => timeline.filter((entry) => entry === "auth:getUser").length;
const tombstoneKeyOf = (token: string) => `auth:revoked:${sessionIdOf(token)}`;

// ─── tests ──────────────────────────────────────────────────────────────────

Deno.test(
  "lifecycle: bootstrap → refresh → logout(new token) → the OLD token is refused with 401 without consulting Supabase Auth (session tombstone)",
  async () => {
    const ip = freshIp();
    const { accessToken: oldToken, refreshToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: oldToken, ip })).status, 200, "old token cached");
    const newToken = await refresh(ip, refreshToken);
    assert(newToken !== oldToken, "refresh minted a second access token");
    assertEquals(sessionIdOf(newToken), sessionIdOf(oldToken), "…in the same Supabase session");
    assertEquals((await call("GET", PROBE_ROUTE, { token: newToken, ip })).status, 200, "new token cached");

    assertEquals((await call("POST", "/v1/auth/logout", { token: newToken, ip })).status, 204, "logout");
    assertEquals(liveSessionForToken(oldToken), null, "upstream session revoked");

    timeline.length = 0;
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: oldToken, ip })).status,
      401,
      "the pre-refresh sibling of the logged-out session is refused",
    );
    assertEquals(getUserCalls(), 0, "…from the session tombstone, not from Supabase Auth");
    assertEquals(
      timeline.filter((entry) => entry.startsWith("rest:")).length,
      0,
      "…and nothing reaches PostgREST with the revoked session's JWT",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: newToken, ip })).status,
      401,
      "the logged-out bearer itself is refused",
    );
  },
);

Deno.test(
  "logout: upstream /auth/v1/logout completes BEFORE any cache eviction, and a request racing the logout that re-populates the cache is refused once logout completes",
  async () => {
    const ip = freshIp();
    const { accessToken: bearer, refreshToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: bearer, ip })).status, 200, "bearer cached");
    // A second bearer of the SAME session that nothing has cached yet: the
    // request racing the logout will verify it upstream (still live) and write
    // it into L1 + L2 inside the revocation window.
    const sibling = await refresh(ip, refreshToken);
    assertEquals(sessionIdOf(sibling), sessionIdOf(bearer), "same session");

    let releaseLogout!: () => void;
    logoutGate = new Promise<void>((resolve) => (releaseLogout = resolve));
    const started = new Promise<void>((resolve) => (logoutStarted = resolve));
    timeline.length = 0;
    const logoutPending = call("POST", "/v1/auth/logout", { token: bearer, ip });
    await started; // upstream /auth/v1/logout is in flight and held open

    const evictionsBeforeRevocation = timeline.filter(
      (entry) => entry.startsWith("redis:DEL:") || entry.startsWith("redis:SET:auth:revoked:"),
    );
    assertEquals(
      evictionsBeforeRevocation,
      [],
      "no cache eviction / tombstone is issued before upstream revocation started",
    );

    const raced = await call("GET", PROBE_ROUTE, { token: sibling, ip });
    assertEquals(raced.status, 200, "racing request verifies upstream (session still live) and caches");
    assert(redisStore.has(await authCacheKey(sibling)), "…the racing request re-populated L2");

    releaseLogout();
    logoutGate = null;
    logoutStarted = null;
    assertEquals((await logoutPending).status, 204, "logout completes");
    assertEquals(liveSessionForToken(bearer), null, "upstream: session revoked");

    const revocationAt = timeline.indexOf("auth:logout");
    const firstEviction = timeline.findIndex(
      (entry) => entry.startsWith("redis:DEL:") || entry.startsWith("redis:SET:auth:revoked:"),
    );
    assert(revocationAt >= 0, "upstream logout was called");
    assert(
      firstEviction > revocationAt,
      `cache eviction (${timeline[firstEviction]}) must follow upstream revocation; timeline: ${timeline.join(" → ")}`,
    );

    const tombstone = redisStore.get(tombstoneKeyOf(bearer));
    assert(tombstone, "a session-level tombstone was written to L2");
    assert(
      tombstone.expiresAtMs !== null &&
        tombstone.expiresAtMs - Date.now() >= (AUTH_CACHE_MAX_TTL_SECONDS - 5) * 1000,
      "tombstone TTL is at least the auth-cache cap",
    );

    timeline.length = 0;
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: sibling, ip })).status,
      401,
      "the bearer re-cached during the race is refused after logout completed",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: bearer, ip })).status,
      401,
      "the logged-out bearer is refused",
    );
    assertEquals(getUserCalls(), 0, "…both from the tombstone, without Supabase Auth");
  },
);

Deno.test(
  "L1/L2: a row present in this isolate's L1 whose session has a tombstone in L2 is refused with 401 and is not re-cached",
  async () => {
    const ip = freshIp();
    const { accessToken: bearer } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: bearer, ip })).status, 200, "bearer in L1 + L2");
    const key = await authCacheKey(bearer);
    assert(redisStore.has(key), "L2 row present");

    // Another isolate handled POST /v1/auth/logout: upstream revoked, L2 row
    // gone, session tombstone in L2 — but it cannot reach THIS isolate's L1.
    liveSessionForToken(bearer)!.revoked = true;
    redisStore.delete(key);
    redisStore.set(tombstoneKeyOf(bearer), {
      value: "1",
      expiresAtMs: Date.now() + AUTH_CACHE_MAX_TTL_SECONDS * 1000,
    });

    timeline.length = 0;
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: bearer, ip })).status,
      401,
      "L1 row is refused because its session is tombstoned in L2",
    );
    assertEquals(getUserCalls(), 0, "…without consulting Supabase Auth");
    assertEquals(
      timeline.filter((entry) => entry === `redis:SET:${key}`),
      [],
      "…and without re-caching the row in L2",
    );
    assertEquals(redisStore.has(key), false, "L2 row stays gone");

    // The tombstone is now known locally too: the next request is refused the
    // same way, and still nothing is re-verified or re-cached.
    timeline.length = 0;
    assertEquals((await call("GET", PROBE_ROUTE, { token: bearer, ip })).status, 401, "still refused");
    assertEquals(getUserCalls(), 0, "no Supabase Auth call on the repeat either");
    assertEquals(timeline.filter((entry) => entry === `redis:SET:${key}`), [], "still not re-cached");
  },
);
