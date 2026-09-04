// ADVERSARIAL probes against the logout/session-tombstone fix (9781621e) in
// ../index.ts + ../cache.ts. Same fake Supabase Auth / Upstash pipeline as
// be-auth-session-lifecycle.test.ts, plus two fault injectors:
//   • redisMode  — "ok" | "down" (Upstash answers 503) | "garbage" (non-array body)
//                 | "cmd-error" ([{error}] per command) | "empty" (HTTP 200 with [])
//   • getUserGate — holds /auth/v1/user open AFTER liveness was decided, so a
//     racing verification can land after the logout has tombstoned the session.
//
// Tests named "ATTACK" encode the behaviour the fix CLAIMS (AGENTS.md → "Auth
// sessions": every access token of a signed-out session is 401 in every isolate
// within one request) and are expected to FAIL on 9781621e; tests named
// "control" are expected to pass and pin the neighbourhood.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_attack_logout_tombstone.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";

const SUPABASE_URL = "http://supabase.attack.test";
const REDIS_URL = "http://redis.attack.test";
const PROBE_ROUTE = "/v1/me/saved-drills";
const USER = "22222222-2222-4222-8222-222222222222";
const VICTIM = "33333333-3333-4333-8333-333333333333";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const authCacheKey = async (token: string) => `auth:${await sha256Hex(token)}`;
const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(payload),
  )}.${b64url("sig")}`;
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
const calls: string[] = [];
let getUserGate: { token: string; held: Promise<void> } | null = null;
let getUserStarted: (() => void) | null = null;

type RedisMode = "ok" | "down" | "garbage" | "cmd-error" | "empty";
let redisMode: RedisMode = "ok";

function mintAccessToken(session: Session, expOffsetSeconds = 3600): string {
  counter += 1;
  const now = Math.floor(Date.now() / 1000);
  const token = jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: session.userId,
    aud: "authenticated",
    role: "authenticated",
    session_id: session.id,
    jti: `jti-${counter}`,
    exp: now + expOffsetSeconds,
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ─── fake Upstash ───────────────────────────────────────────────────────────

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
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
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
    if (redisMode === "down") {
      calls.push(`redis:DOWN ${commands.map((c) => c[0]).join(",")}`);
      return json(503, { error: "upstash unavailable" });
    }
    if (redisMode === "garbage") {
      calls.push(`redis:GARBAGE ${commands.map((c) => c[0]).join(",")}`);
      return json(200, { error: "not a pipeline array" });
    }
    if (redisMode === "cmd-error") {
      // Upstash pipeline shape for a command Redis rejected (WRONGTYPE / NOPERM /
      // quota): HTTP 200 with a per-command {error} instead of {result}.
      calls.push(`redis:CMDERR ${commands.map((c) => c[0]).join(",")}`);
      return json(
        200,
        commands.map((c) => ({ error: `ERR ${String(c[0])} rejected` })),
      );
    }
    if (redisMode === "empty") {
      // Truncated pipeline reply: a well-formed JSON array with fewer entries than
      // commands — the GET/TTL results the caller indexes are simply absent.
      calls.push(`redis:EMPTY ${commands.map((c) => c[0]).join(",")}`);
      return json(200, []);
    }
    return json(200, commands.map(runRedis));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    calls.push(`auth:token:${grant}`);
    if (grant === "id_token") {
      const session = newSession(String(decodePayload(String(body.id_token ?? "")).sub));
      return json(200, sessionJson(session, mintAccessToken(session)));
    }
    if (grant === "refresh_token") {
      for (const session of sessions.values()) {
        if (!session.revoked && session.refreshToken === String(body.refresh_token ?? "")) {
          counter += 1;
          session.refreshToken = `rt-${counter}`;
          return json(200, sessionJson(session, mintAccessToken(session)));
        }
      }
      return json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid" });
    }
    return json(400, { code: 400, msg: "unsupported grant" });
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    calls.push("auth:getUser");
    // Liveness is decided NOW (as Supabase Auth would); the response may be
    // held so it lands after a concurrent logout finished.
    const session = liveSessionForToken(bearer);
    if (getUserGate && getUserGate.token === bearer) {
      getUserStarted?.();
      await getUserGate.held;
    }
    if (!session) {
      return json(401, { code: 401, error_code: "session_not_found", msg: "Session not found" });
    }
    return json(200, userJson(session.userId));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
    calls.push(`auth:logout:${url.searchParams.get("scope")}`);
    const session = liveSessionForToken(bearer);
    if (!session) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    session.revoked = true;
    return new Response(null, { status: 204 });
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.slice("/rest/v1/".length);
    calls.push(`rest:${request.method}:${table}`);
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
  return new Response(`unexpected fetch in attack test: ${request.method} ${request.url}`, {
    status: 599,
  });
}

// ─── handler boot ───────────────────────────────────────────────────────────

let handler: ((request: Request) => Promise<Response>) | null = null;

async function boot(): Promise<(request: Request) => Promise<Response>> {
  if (handler) return handler;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-attack-key");
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-attack-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "attack-webhook-secret");
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
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-attack-token");

  globalThis.fetch = fakeFetch as typeof fetch;
  captureAccessLog(() => undefined);
  Deno.serve = ((...args: unknown[]) => {
    const found = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
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
const freshIp = () => `203.0.113.${++ipCounter}`;

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
    new Request(`http://edge.attack.test/functions/v1/api${path}`, { method, headers, body }),
  );
  await response.text().catch(() => undefined);
  return response;
}

async function bootstrap(
  ip: string,
  user = USER,
): Promise<{ accessToken: string; refreshToken: string }> {
  const h = await boot();
  const response = await h(
    new Request("http://edge.attack.test/functions/v1/api/v1/account/bootstrap", {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        Authorization: `Bearer ${googleIdToken(user)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }),
  );
  const payload = (await response.json()) as {
    session?: { accessToken: string; refreshToken: string };
  };
  assert(response.status === 200 && payload.session, `bootstrap (status ${response.status})`);
  return payload.session;
}

const getUserCalls = () => calls.filter((c) => c === "auth:getUser").length;
const sessionIdOf = (token: string) => String(decodePayload(token).session_id);
const resetFaults = () => {
  redisMode = "ok";
  getUserGate = null;
  getUserStarted = null;
};

// ─── ATTACK: expected to FAIL on 9781621e ───────────────────────────────────

Deno.test(
  "ATTACK-1: POST /v1/auth/logout answers 204 while Upstash is unreachable, although neither the L2 auth row was deleted nor the session tombstone persisted — a bearer of the signed-out session keeps authenticating from L2 in every other isolate for up to AUTH_CACHE_MAX_TTL once Redis is back",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    const key = await authCacheKey(accessToken);
    assert(redisStore.has(key), "precondition: verified row in L2");

    redisMode = "down";
    calls.length = 0;
    const logout = await call("POST", "/v1/auth/logout", { token: accessToken, ip });
    assertEquals(liveSessionForToken(accessToken), null, "upstream revoked the session");
    redisMode = "ok";

    const tombstoneDurable = redisStore.has(revokedKey(sessionIdOf(accessToken)));
    const rowDurablyGone = !redisStore.has(key);
    // The contract (AGENTS.md "Auth sessions"): after a 204 EVERY access token
    // of the session is refused in EVERY isolate within one request. A 204 is
    // therefore only truthful when the L2 row is gone AND the tombstone is
    // durable; otherwise the client must be told to retry (503, as for an
    // unreachable Auth) — the next attempt finds the upstream session already
    // gone (401 → treated as revoked) and re-issues DEL + tombstone.
    assert(
      logout.status !== 204 || (tombstoneDurable && rowDurablyGone),
      `logout → ${logout.status} while Redis was unreachable: L2 row still present=${!rowDurablyGone}, tombstone in L2=${tombstoneDurable}; calls=${calls.join(", ")}`,
    );
  },
);

Deno.test(
  "ATTACK-2 (regression probe vs 4d812e1a): with Upstash configured but unreachable, a bearer already verified into L1 is re-verified with auth.getUser on EVERY request (baseline served the L1 hit without Supabase Auth)",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    calls.length = 0;
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    assertEquals(getUserCalls(), 0, "precondition: warm L1 hit, Redis healthy");

    redisMode = "down";
    calls.length = 0;
    for (let i = 0; i < 3; i += 1) {
      assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    }
    redisMode = "ok";
    assertEquals(
      getUserCalls(),
      0,
      `3 requests during a Redis outage with a warm L1 row made ${getUserCalls()} auth.getUser round trips (baseline: 0)`,
    );
  },
);

Deno.test(
  "ATTACK-3: a per-command Upstash error on the tombstone lookup (HTTP 200, [{error}] instead of [{result}]) is read as 'no marker' — a warm L1 row of a session that ANOTHER device signed out is still served, while a transport failure (503) on the same lookup correctly bypasses the cache",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    liveSessionForToken(accessToken)!.revoked = true; // signed out upstream elsewhere

    const served: string[] = [];
    for (const mode of ["cmd-error", "empty"] as const) {
      redisMode = mode;
      calls.length = 0;
      const response = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
      redisMode = "ok";
      if (response.status !== 401) {
        served.push(`[${mode}] status=${response.status} calls=${calls.join(", ")}`);
      }
    }
    assertEquals(
      served,
      [],
      `revoked session served from L1 although the tombstone lookup did not succeed:\n${served.join("\n")}`,
    );
  },
);

// ─── controls: expected to PASS on 9781621e ─────────────────────────────────

Deno.test(
  "control: a tampered bearer that claims ANOTHER user's session_id cannot tombstone that session (authenticate() refuses it upstream before logoutRoute)",
  async () => {
    resetFaults();
    const ip = freshIp();
    const victim = await bootstrap(ip, VICTIM);
    const attacker = await bootstrap(ip, USER);
    assertEquals((await call("GET", PROBE_ROUTE, { token: victim.accessToken, ip })).status, 200);

    const forged = jwt({
      ...decodePayload(attacker.accessToken),
      session_id: sessionIdOf(victim.accessToken),
    });
    assertNotEquals(forged, attacker.accessToken);
    calls.length = 0;
    const logout = await call("POST", "/v1/auth/logout", { token: forged, ip });
    assertEquals(logout.status, 401, "forged bearer refused");
    assert(!calls.includes("auth:logout:local"), "no upstream logout was issued");
    assertEquals(redisStore.has(revokedKey(sessionIdOf(victim.accessToken))), false);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: victim.accessToken, ip })).status,
      200,
      "victim unaffected",
    );
  },
);

Deno.test(
  "control: a racing verification that Supabase Auth answered BEFORE revocation but that lands AFTER logout tombstoned the session is served once, and its re-cached row is refused on the very next request",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken: at1, refreshToken } = await bootstrap(ip);
    const at2Response = await call("POST", "/v1/auth/refresh", { ip, body: { refreshToken } });
    assertEquals(at2Response.status, 200);
    // Re-fetch AT2 from the fake (call() drains the body).
    const at2 = sessions.get(sessionIdOf(at1))!.accessTokens.at(-1)!;
    assertNotEquals(at1, at2);

    let release!: () => void;
    getUserGate = { token: at1, held: new Promise<void>((resolve) => (release = resolve)) };
    const started = new Promise<void>((resolve) => (getUserStarted = resolve));
    const racing = call("GET", PROBE_ROUTE, { token: at1, ip });
    await started; // liveness decided (live), response held

    assertEquals((await call("POST", "/v1/auth/logout", { token: at2, ip })).status, 204);
    assert(redisStore.has(revokedKey(sessionIdOf(at2))), "tombstone published");

    release();
    getUserGate = null;
    getUserStarted = null;
    assertEquals((await racing).status, 200, "the in-flight verification is served once");
    assert(redisStore.has(await authCacheKey(at1)), "…and re-populated L2 for AT1");

    calls.length = 0;
    assertEquals((await call("GET", PROBE_ROUTE, { token: at1, ip })).status, 401);
    assertEquals(getUserCalls(), 0, "refused by the tombstone");
    assertEquals(redisStore.has(await authCacheKey(at1)), false, "stale row evicted");
  },
);

Deno.test(
  "control: when the tombstone lookup gets a malformed Upstash body, the cache is bypassed and Supabase Auth decides (a revoked session is 401, not served from L1)",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    liveSessionForToken(accessToken)!.revoked = true; // another device signed out upstream

    redisMode = "garbage";
    calls.length = 0;
    const response = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
    redisMode = "ok";
    assertEquals(response.status, 401, "not served from the warm L1 row");
    assert(getUserCalls() >= 1, "Supabase Auth was consulted");
  },
);

Deno.test(
  "control: logout of a bearer whose session Supabase Auth already revoked (upstream 401) is idempotent — 204 and the tombstone is still written",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 200);
    liveSessionForToken(accessToken)!.revoked = true;

    calls.length = 0;
    const logout = await call("POST", "/v1/auth/logout", { token: accessToken, ip });
    assertEquals(logout.status, 204);
    assert(redisStore.has(revokedKey(sessionIdOf(accessToken))), "tombstone written");
    assertEquals((await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status, 401);
  },
);

Deno.test(
  "control (pre-existing at 4d812e1a, not changed by the fix): an EXPIRED bearer cannot sign out — 401 before any upstream call, so the refresh token stays live and no tombstone is written",
  async () => {
    resetFaults();
    const ip = freshIp();
    const { accessToken } = await bootstrap(ip);
    const session = liveSessionForToken(accessToken)!;
    const expired = mintAccessToken(session, -5);
    calls.length = 0;
    const logout = await call("POST", "/v1/auth/logout", { token: expired, ip });
    assertEquals(logout.status, 401);
    assert(!calls.includes("auth:logout:local"), "upstream never asked");
    assertEquals(session.revoked, false, "session still live upstream");
    assertEquals(redisStore.has(revokedKey(session.id)), false);
  },
);
