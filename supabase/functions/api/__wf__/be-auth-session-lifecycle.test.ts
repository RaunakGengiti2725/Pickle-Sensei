// Session lifecycle against the REAL edge handler: bootstrap → refresh →
// logout must leave EVERY access token of that Supabase session refused —
// the logged-out bearer, its pre-refresh siblings, a copy re-cached by a
// request racing the logout, and a row another isolate still holds in L1 —
// within one request, without a Supabase Auth round trip (the session-level
// revocation tombstone is consulted on every cache hit, L1 and L2 alike).
//
// Supabase Auth (id_token / refresh grants, getUser, scope=local logout) and
// the Upstash pipeline are small stateful fakes at the fetch layer; every
// upstream call is recorded so ORDER can be asserted. cache.ts reads the
// Upstash env at import time, so ../index.ts is imported after boot() sets it.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json be-auth-session-lifecycle.test.ts

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";

const SUPABASE_URL = "http://supabase.lifecycle.test";
const REDIS_URL = "http://redis.lifecycle.test";
const PROBE_ROUTE = "/v1/me/saved-drills"; // authenticated PostgREST list → 200 []
const USER = "11111111-1111-4111-8111-111111111111";
/** Mirrors AUTH_CACHE_MAX_TTL_SECONDS in ../index.ts. */
const AUTH_CACHE_MAX_TTL_SECONDS = 600;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const authCacheKey = async (token: string) => `auth:${await sha256Hex(token)}`;
const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(JSON.stringify(payload))
  }.${b64url("sig")}`;
const decodePayload = (token: string): Record<string, unknown> =>
  JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

function googleIdToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    aud: "com.picklesensei",
    exp: now + 3600,
    iat: now,
  });
}

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
/** Every upstream call, in order: auth:*, redis:<OP> <key>, rest:* */
const calls: string[] = [];
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
    if (!session.revoked && session.accessTokens.includes(token)) {
      return session;
    }
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ─── fake Upstash (pipeline REST) ───────────────────────────────────────────

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
function runRedis(command: Array<string | number>): { result: unknown } {
  const [op, ...args] = command.map(String);
  calls.push(`redis:${op} ${args[0] ?? ""}`.trim());
  switch (op) {
    case "GET":
      return { result: redisLive(args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : null;
      redisStore.set(args[0], {
        value: args[1],
        expiresAtMs: ttl ? Date.now() + ttl * 1000 : null,
      });
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
      redisStore.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? null,
      });
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

async function fakeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") ?? "").replace(
    /^Bearer /,
    "",
  );
  const text = await request.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }

  if (url.origin === REDIS_URL) {
    const commands = JSON.parse(text) as Array<Array<string | number>>;
    return json(200, commands.map(runRedis));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    calls.push(`auth:token:${grant}`);
    if (grant === "id_token") {
      const session = newSession(
        String(decodePayload(String(body.id_token ?? "")).sub),
      );
      return json(200, sessionJson(session, mintAccessToken(session)));
    }
    if (grant === "refresh_token") {
      for (const session of sessions.values()) {
        if (
          !session.revoked &&
          session.refreshToken === String(body.refresh_token ?? "")
        ) {
          counter += 1;
          session.refreshToken = `rt-${counter}`;
          return json(200, sessionJson(session, mintAccessToken(session)));
        }
      }
      return json(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token",
      });
    }
    return json(400, { code: 400, msg: "unsupported grant" });
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    calls.push("auth:getUser");
    const session = liveSessionForToken(bearer);
    if (!session) {
      return json(401, {
        code: 401,
        error_code: "session_not_found",
        msg: "Session not found",
      });
    }
    return json(200, userJson(session.userId));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
    calls.push(`auth:logout:${url.searchParams.get("scope")}`);
    logoutStarted?.();
    if (logoutGate) await logoutGate;
    const session = liveSessionForToken(bearer);
    if (!session) {
      return json(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT",
      });
    }
    session.revoked = true;
    return new Response(null, { status: 204 });
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.slice("/rest/v1/".length);
    calls.push(`rest:${request.method}:${table}`);
    if (request.method === "GET" && table === "profiles") {
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      return json(200, [{
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
      }]);
    }
    if (request.method !== "GET") return new Response(null, { status: 201 });
    const single = (request.headers.get("accept") ?? "").includes(
      "vnd.pgrst.object+json",
    );
    return json(200, single ? {} : []);
  }
  return new Response(
    `unexpected fetch in lifecycle test: ${request.method} ${request.url}`,
    { status: 599 },
  );
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
  for (
    const key of [
      "APPLE_SIGN_IN_CLIENT_ID",
      "APPLE_SIGN_IN_TEAM_ID",
      "APPLE_SIGN_IN_KEY_ID",
      "APPLE_SIGN_IN_PRIVATE_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY",
      "REVENUECAT_SECRET_API_KEY",
      "REVENUECAT_PUBLIC_SDK_KEY",
    ]
  ) {
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
const freshIp = () => `198.51.100.${++ipCounter}`;

async function call(
  method: string,
  path: string,
  options: { token?: string; ip: string; body?: unknown },
): Promise<Response> {
  const h = await boot();
  const headers = new Headers({ "x-forwarded-for": options.ip });
  if (options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  const response = await h(
    new Request(`http://edge.lifecycle.test/functions/v1/api${path}`, {
      method,
      headers,
      body,
    }),
  );
  await response.text().catch(() => undefined);
  return response;
}

async function bootstrap(
  ip: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const h = await boot();
  const response = await h(
    new Request(
      "http://edge.lifecycle.test/functions/v1/api/v1/account/bootstrap",
      {
        method: "POST",
        headers: {
          "x-forwarded-for": ip,
          Authorization: `Bearer ${googleIdToken(USER)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ),
  );
  const payload = (await response.json()) as {
    session?: { accessToken: string; refreshToken: string };
  };
  assert(
    response.status === 200 && payload.session,
    `bootstrap → session (status ${response.status})`,
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
  const payload = (await response.json()) as {
    session?: { accessToken: string };
  };
  assert(
    response.status === 200 && payload.session,
    `refresh → session (status ${response.status})`,
  );
  return payload.session.accessToken;
}

const getUserCalls = () => calls.filter((c) => c === "auth:getUser").length;
const sessionIdOf = (token: string) => String(decodePayload(token).session_id);

// ─── tests ──────────────────────────────────────────────────────────────────

Deno.test(
  "lifecycle: bootstrap → refresh → logout(new token) → the OLD token is refused with 401 from the session tombstone, without auth.getUser",
  async () => {
    const ip = freshIp();
    const { accessToken: oldToken, refreshToken } = await bootstrap(ip);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: oldToken, ip })).status,
      200,
      "old token cached",
    );

    const newToken = await refresh(ip, refreshToken);
    assert(newToken !== oldToken, "refresh minted a new access token");
    assertEquals(
      sessionIdOf(newToken),
      sessionIdOf(oldToken),
      "…in the SAME Supabase session",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: newToken, ip })).status,
      200,
      "new token cached",
    );

    assertEquals(
      (await call("POST", "/v1/auth/logout", { token: newToken, ip })).status,
      204,
      "logout",
    );
    assertEquals(
      liveSessionForToken(oldToken),
      null,
      "upstream: the whole session is revoked",
    );

    calls.length = 0;
    const stale = await call("GET", PROBE_ROUTE, { token: oldToken, ip });
    assertEquals(stale.status, 401, "old (sibling) token refused after logout");
    assertEquals(
      getUserCalls(),
      0,
      "…decided by the tombstone, not by Supabase Auth",
    );
    assert(
      !calls.some((c) => c.startsWith("rest:")),
      "…and nothing reached PostgREST",
    );
    assertEquals(
      redisStore.has(await authCacheKey(oldToken)),
      false,
      "stale L2 row dropped",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: newToken, ip })).status,
      401,
      "new token dead too",
    );
  },
);

Deno.test(
  "lifecycle: logout revokes upstream BEFORE any cache DEL, tombstones the session for ≥ AUTH_CACHE_MAX_TTL, and a request racing the logout that re-populates the cache is 401 afterwards",
  async () => {
    const ip = freshIp();
    const { accessToken: at1, refreshToken } = await bootstrap(ip);
    const at2 = await refresh(ip, refreshToken);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: at2, ip })).status,
      200,
      "AT2 cached",
    );
    // AT1 has never been verified at this edge: it is cold in L1 and L2.
    assertEquals(redisStore.has(await authCacheKey(at1)), false, "AT1 cold");

    let releaseLogout!: () => void;
    logoutGate = new Promise<void>((resolve) => (releaseLogout = resolve));
    const started = new Promise<void>((resolve) => (logoutStarted = resolve));
    calls.length = 0;
    const logoutPending = call("POST", "/v1/auth/logout", { token: at2, ip });
    await started; // upstream /auth/v1/logout is in flight and held open

    const beforeRevocation = calls.slice();
    assert(
      !beforeRevocation.some((c) =>
        c.startsWith("redis:DEL") || c.startsWith("redis:SET auth:revoked:")
      ),
      `nothing may be evicted or tombstoned before upstream revocation completes; saw ${
        beforeRevocation.join(", ")
      }`,
    );

    // A sibling request inside the window verifies upstream (the session is
    // still live there) and re-populates the cache with a row for AT1.
    const raced = await call("GET", PROBE_ROUTE, { token: at1, ip });
    assertEquals(
      raced.status,
      200,
      "racing sibling verifies upstream and is served",
    );
    assert(
      redisStore.has(await authCacheKey(at1)),
      "…and re-populated L2 for AT1",
    );

    releaseLogout();
    logoutGate = null;
    logoutStarted = null;
    assertEquals((await logoutPending).status, 204, "logout completes");
    assertEquals(liveSessionForToken(at2), null, "upstream: session revoked");

    const logoutAt = calls.indexOf("auth:logout:local");
    const firstDel = calls.findIndex((c) => c.startsWith("redis:DEL"));
    const tombstoneAt = calls.findIndex((c) =>
      c === `redis:SET ${revokedKey(sessionIdOf(at2))}`
    );
    assert(logoutAt >= 0, "upstream logout was called");
    assert(
      firstDel > logoutAt,
      `cache DEL (${firstDel}) must follow upstream logout (${logoutAt})`,
    );
    assert(
      tombstoneAt > logoutAt,
      `tombstone SET (${tombstoneAt}) must follow upstream logout (${logoutAt})`,
    );
    const tombstone = redisStore.get(revokedKey(sessionIdOf(at2)));
    assert(
      tombstone && tombstone.expiresAtMs !== null,
      "tombstone stored in L2 with a TTL",
    );
    assert(
      tombstone.expiresAtMs - Date.now() >=
        AUTH_CACHE_MAX_TTL_SECONDS * 1000 - 5_000,
      "tombstone outlives the longest auth-cache row",
    );

    calls.length = 0;
    for (const token of [at1, at2]) {
      const after = await call("GET", PROBE_ROUTE, { token, ip });
      assertEquals(
        after.status,
        401,
        "every token of the session is refused after logout",
      );
    }
    assertEquals(
      getUserCalls(),
      0,
      "…from the tombstone, without Supabase Auth",
    );
    assertEquals(
      redisStore.has(await authCacheKey(at1)),
      false,
      "the re-populated AT1 row is gone",
    );
  },
);

Deno.test(
  "lifecycle: with UPSTASH configured, an L1 cache row whose session_id has a tombstone in L2 (written by another isolate) is refused with 401 and not re-cached",
  async () => {
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "cached L1 + L2",
    );
    const key = await authCacheKey(accessToken);
    assert(redisStore.has(key), "L2 row present");

    // Another isolate handled POST /v1/auth/logout: upstream revoked, its own
    // L1 evicted, L2 row deleted, session tombstone published to L2. This
    // isolate's L1 still holds the verified row.
    liveSessionForToken(accessToken)!.revoked = true;
    redisStore.delete(key);
    redisStore.set(revokedKey(sessionIdOf(accessToken)), {
      value: "1",
      expiresAtMs: Date.now() + (AUTH_CACHE_MAX_TTL_SECONDS + 60) * 1000,
    });

    calls.length = 0;
    const stale = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
    assertEquals(stale.status, 401, "L1 hit refused by the L2 tombstone");
    assertEquals(getUserCalls(), 0, "…without consulting Supabase Auth");
    assert(
      !calls.some((c) => c === `redis:SET ${key}`),
      "…and without re-caching the bearer",
    );
    assertEquals(redisStore.has(key), false, "L2 row stays gone");
    assert(
      !calls.some((c) => c.startsWith("rest:")),
      "nothing reached PostgREST",
    );

    calls.length = 0;
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      401,
      "still refused",
    );
    assertEquals(getUserCalls(), 0, "…still from the tombstone");
  },
);
