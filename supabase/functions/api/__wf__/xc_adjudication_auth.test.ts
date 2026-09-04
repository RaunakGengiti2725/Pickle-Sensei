// xc-security adjudication — independent reproduction of the auth-cache /
// logout / rate-limit candidates against the REAL edge handler (../index.ts
// loaded with Deno.serve captured), backed by a small stateful fake Supabase
// Auth (sessions, refresh rotation, scope=local logout, getUser) and a fake
// Upstash pipeline, both installed at the fetch layer. No hosted resource is
// touched; nothing here is a secret.
//
// Tests named `REPRO (defect)` were written to assert the defective behaviour
// so the finding was executable; the three logout/revocation ones (SIBLING,
// TOCTOU, L1) now pin the FIXED contract — every bearer of a logged-out
// Supabase session is refused, in every isolate, within one request. Tests
// named `control` pin the behaviour that already held.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json xc_adjudication_auth.test.ts

// NOTE: cache.ts reads the Upstash env at import time, so it must not be
// imported statically here — index.ts pulls it in after boot() sets the env.
import { captureAccessLog } from "../http.ts";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SUPABASE_URL = "http://supabase.adjudicate.test";
const REDIS_URL = "http://redis.adjudicate.test";
const PROBE_ROUTE = "/v1/me/saved-drills"; // authenticated, PostgREST list → 200 []

const VICTIM = "11111111-1111-4111-8111-111111111111";
const ATTACKER = "22222222-2222-4222-8222-222222222222";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

export function googleIdToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    aud: "com.picklesensei",
    exp: now + 3600,
    iat: now,
  });
}

// ─── fake Supabase Auth state ───────────────────────────────────────────────

interface Session {
  id: string;
  userId: string;
  accessTokens: string[];
  refreshToken: string;
  revoked: boolean;
}

const sessions = new Map<string, Session>();
let counter = 0;
const upstreamCalls: string[] = [];
const postgrestBearers: string[] = [];

/** Gate that lets a test hold the upstream logout open (TOCTOU window). */
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

function userJson(userId: string) {
  return {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: `${userId.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

function sessionJson(session: Session, accessToken: string) {
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: session.refreshToken,
    user: userJson(session.userId),
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ─── fake Upstash (pipeline REST) ───────────────────────────────────────────

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}
export const redisStore = new Map<string, RedisEntry>();

function redisGetLive(key: string): RedisEntry | null {
  const entry = redisStore.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    redisStore.delete(key);
    return null;
  }
  return entry;
}

function runRedisCommand(command: Array<string | number>): { result: unknown } {
  const [op, ...args] = command.map(String);
  switch (op) {
    case "GET":
      return { result: redisGetLive(args[0])?.value ?? null };
    case "TTL": {
      const entry = redisGetLive(args[0]);
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
      const entry = redisGetLive(args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      redisStore.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisGetLive(args[0]);
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
    upstreamCalls.push("redis:pipeline");
    const commands = JSON.parse(text) as Array<Array<string | number>>;
    return json(200, commands.map(runRedisCommand));
  }

  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    upstreamCalls.push(`auth:token:${grant}`);
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
      return json(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token",
      });
    }
    return json(400, { code: 400, msg: "unsupported grant" });
  }

  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    upstreamCalls.push("auth:getUser");
    const session = liveSessionForToken(bearer);
    if (!session)
      return json(401, {
        code: 401,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      });
    return json(200, userJson(session.userId));
  }

  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
    upstreamCalls.push(`auth:logout:${url.searchParams.get("scope")}`);
    logoutStarted?.();
    if (logoutGate) await logoutGate;
    const session = liveSessionForToken(bearer);
    if (!session) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    session.revoked = true;
    return new Response(null, { status: 204 });
  }

  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    upstreamCalls.push(`rest:${request.method}:${url.pathname.slice("/rest/v1/".length)}`);
    postgrestBearers.push(bearer);
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

  return new Response(`unexpected fetch in adjudication test: ${request.method} ${request.url}`, {
    status: 599,
  });
}

// ─── handler boot ───────────────────────────────────────────────────────────

let handler: ((request: Request) => Promise<Response>) | null = null;
const accessLog: string[] = [];

async function boot(): Promise<(request: Request) => Promise<Response>> {
  if (handler) return handler;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-adjudication-key");
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-adjudication-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "adjudication-webhook-secret");
  for (const key of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
    "REVENUECAT_SECRET_API_KEY",
    "REVENUECAT_PUBLIC_SDK_KEY",
  ])
    Deno.env.delete(key);
  Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-adjudication-token");

  globalThis.fetch = fakeFetch as typeof fetch;
  captureAccessLog((line) => accessLog.push(line));
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
/** Fresh client IP per test so the per-IP budgets never couple tests. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; ip: string; body?: unknown } = { ip: "203.0.113.250" },
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
    new Request(`http://edge.adjudicate.test/functions/v1/api${path}`, { method, headers, body }),
  );
  await response.text().catch(() => undefined);
  return response;
}

async function bootstrap(
  userId: string,
  ip: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const h = await boot();
  const headers = new Headers({
    "x-forwarded-for": ip,
    Authorization: `Bearer ${googleIdToken(userId)}`,
    "Content-Type": "application/json",
  });
  const response = await h(
    new Request("http://edge.adjudicate.test/functions/v1/api/v1/account/bootstrap", {
      method: "POST",
      headers,
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

const authCacheKey = async (token: string) => `auth:${await sha256Hex(token)}`;

// ─── tests ──────────────────────────────────────────────────────────────────

Deno.test(
  "control: access token authenticates, replays from cache, and the exact logged-out bearer is refused",
  async () => {
    const ip = freshIp();
    const { accessToken } = await bootstrap(VICTIM, ip);
    upstreamCalls.length = 0;
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "first call verifies upstream",
    );
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      1,
      "one getUser on the cold cache",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "second call",
    );
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      1,
      "second call served from cache",
    );

    assertEquals(
      (await call("POST", "/v1/auth/logout", { token: accessToken, ip })).status,
      204,
      "logout",
    );
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      401,
      "exact bearer dead after logout",
    );
  },
);

Deno.test(
  "REPRO (defect): SIBLING bearer — the pre-refresh access token of the SAME session keeps working after logout, from the auth cache",
  async () => {
    const ip = freshIp();
    const { accessToken: at1, refreshToken } = await bootstrap(VICTIM, ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: at1, ip })).status, 200, "AT1 cached");

    const refreshed = await call("POST", "/v1/auth/refresh", { ip, body: { refreshToken } });
    assertEquals(refreshed.status, 200, "refresh rotates");
    const at2 = sessions.get(liveSessionForToken(at1)!.id)!.accessTokens.at(-1)!;
    assert(at2 !== at1, "refresh minted a second access token in the same session");
    assertEquals((await call("GET", PROBE_ROUTE, { token: at2, ip })).status, 200, "AT2 cached");

    assertEquals(
      (await call("POST", "/v1/auth/logout", { token: at2, ip })).status,
      204,
      "logout with AT2",
    );
    const session = [...sessions.values()].find((s) => s.accessTokens.includes(at1))!;
    assertEquals(session.revoked, true, "upstream session revoked (both tokens dead upstream)");
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: at2, ip })).status,
      401,
      "AT2 (the logged-out bearer) is refused",
    );

    upstreamCalls.length = 0;
    const forwardedBefore = postgrestBearers.filter((b) => b === at1).length;
    const sibling = await call("GET", PROBE_ROUTE, { token: at1, ip });
    assertEquals(sibling.status, 401, "AT1 of the revoked session is refused");
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      0,
      "…from the session tombstone, without consulting Supabase Auth",
    );
    assertEquals(
      postgrestBearers.filter((b) => b === at1).length,
      forwardedBefore,
      "…and the revoked session's JWT is not forwarded to PostgREST",
    );
    assert(
      redisStore.has(`auth:revoked:${session.id}`),
      "the session-level tombstone is in L2 for every isolate to see",
    );
  },
);

Deno.test(
  "REPRO (defect): logout evicts the cache BEFORE upstream revocation — a concurrent request re-caches the bearer, which then survives its own logout",
  async () => {
    const ip = freshIp();
    const { accessToken } = await bootstrap(VICTIM, ip);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "bearer cached",
    );

    let releaseLogout!: () => void;
    logoutGate = new Promise<void>((resolve) => (releaseLogout = resolve));
    const started = new Promise<void>((resolve) => (logoutStarted = resolve));
    const logoutPending = call("POST", "/v1/auth/logout", { token: accessToken, ip });
    await started; // upstream /logout is in flight; nothing is evicted yet

    const raced = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
    assertEquals(
      raced.status,
      200,
      "request inside the window is still accepted (session live upstream)",
    );

    releaseLogout();
    logoutGate = null;
    logoutStarted = null;
    assertEquals((await logoutPending).status, 204, "logout completes");
    const session = liveSessionForToken(accessToken);
    assertEquals(session, null, "upstream: session revoked");

    upstreamCalls.length = 0;
    const after = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
    assertEquals(
      after.status,
      401,
      "logged-out bearer refused after its own logout completed, whatever the race cached",
    );
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      0,
      "…from the session tombstone, without consulting Supabase Auth",
    );
  },
);

Deno.test(
  "REPRO (defect): transitional provider-ID-token branch is live on non-bootstrap routes; logout cannot revoke it and each cache miss mints an orphan Supabase session",
  async () => {
    const ip = freshIp();
    const idToken = googleIdToken(ATTACKER);
    const sessionsBefore = sessions.size;
    const first = await call("GET", PROBE_ROUTE, { token: idToken, ip });
    assertEquals(first.status, 200, "[defect] raw Google ID token authenticates a data route");
    assertEquals(
      sessions.size,
      sessionsBefore + 1,
      "…by minting a Supabase session the client never receives",
    );
    const minted = [...sessions.values()].at(-1)!;

    const logout = await call("POST", "/v1/auth/logout", { token: idToken, ip });
    assertEquals(logout.status, 204, "logout reports success");
    assertEquals(
      minted.revoked,
      false,
      "[defect] …but the minted session is not revoked (upstream 401 swallowed)",
    );

    const again = await call("GET", PROBE_ROUTE, { token: idToken, ip });
    assertEquals(again.status, 200, "[defect] the same ID token authenticates again after logout");
    assertEquals(
      sessions.size,
      sessionsBefore + 2,
      "…minting a second orphan session (cache was evicted)",
    );
    assertEquals(minted.revoked, false, "first orphan still live");
  },
);

Deno.test(
  "REPRO (defect): L1 keeps serving a session another isolate revoked (L2 row gone, upstream session dead)",
  async () => {
    const ip = freshIp();
    const { accessToken } = await bootstrap(VICTIM, ip);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "bearer cached in L1 + L2",
    );
    const key = await authCacheKey(accessToken);
    assert(redisStore.has(key), "L2 row present");

    // Simulate `POST /v1/auth/logout` handled by a DIFFERENT isolate: it deletes
    // the L2 row and revokes the session upstream, but cannot reach this L1.
    redisStore.delete(key);
    liveSessionForToken(accessToken)!.revoked = true;

    upstreamCalls.length = 0;
    const stale = await call("GET", PROBE_ROUTE, { token: accessToken, ip });
    assertEquals(stale.status, 401, "revoked session is NOT served from this isolate's L1");
    // The L2 row vanished with no tombstone (only an isolate running the old
    // logout leaves L2 like this): the L1 copy is not trusted on its own, the
    // bearer is re-verified with Supabase Auth, which refuses it.
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      1,
      "…after one re-verification with Supabase Auth",
    );
    assertEquals(redisStore.has(key), false, "…and without re-populating L2");
  },
);

Deno.test(
  "REPRO (defect, requires Upstash write access): a forged L2 auth row is trusted without re-verifying the bearer",
  async () => {
    const ip = freshIp();
    const now = Math.floor(Date.now() / 1000);
    // Attacker-chosen bearer: well-formed, unexpired, Supabase-issued shape, never verified by anyone.
    const forgedBearer = jwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: ATTACKER,
      exp: now + 3600,
      iat: now,
      jti: "forged",
    });
    redisStore.set(await authCacheKey(forgedBearer), {
      value: JSON.stringify({
        userId: VICTIM,
        email: "victim@example.com",
        provider: "google",
        accessToken: "not-a-real-jwt",
        expiresAtMs: Date.now() + 600_000,
      }),
      expiresAtMs: Date.now() + 600_000,
    });
    upstreamCalls.length = 0;
    const response = await call("GET", PROBE_ROUTE, { token: forgedBearer, ip });
    assertEquals(response.status, 200, "[defect] forged cache row authenticates");
    assertEquals(
      upstreamCalls.filter((c) => c === "auth:getUser").length,
      0,
      "…without any Supabase Auth verification",
    );
    assertEquals(
      postgrestBearers.at(-1),
      "not-a-real-jwt",
      "…and the forged row's access token is what reaches PostgREST",
    );
  },
);

Deno.test(
  "characterization: per-IP auth-failure budget (30/5 min) locks out VALID bearers, bootstrap and refresh from the same address",
  async () => {
    const ip = freshIp();
    const { accessToken, refreshToken } = await bootstrap(VICTIM, ip);
    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      200,
      "victim works before the noise",
    );

    // Co-tenant on the same NAT address presents 30 garbage session tokens.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 30; i += 1) {
      const junk = jwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: ATTACKER,
        exp: now + 3600,
        jti: `junk-${i}`,
      });
      assertEquals(
        (await call("GET", PROBE_ROUTE, { token: junk, ip })).status,
        401,
        `junk bearer ${i} → 401`,
      );
    }

    assertEquals(
      (await call("GET", PROBE_ROUTE, { token: accessToken, ip })).status,
      429,
      "victim's VALID cached bearer → 429",
    );
    const bootstrapBlocked = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(VICTIM),
      ip,
      body: {},
    });
    assertEquals(bootstrapBlocked.status, 429, "sign-in from the address → 429");
    assertEquals(
      (await call("POST", "/v1/auth/refresh", { ip, body: { refreshToken } })).status,
      429,
      "refresh from the address → 429",
    );
  },
);

Deno.test(
  "characterization: access log route field carries arbitrary unmatched path segments verbatim",
  async () => {
    const ip = freshIp();
    accessLog.length = 0;
    await call("GET", "/v1/nope/USER-SUPPLIED-SEGMENT-xyz", { ip });
    const line = accessLog.find((l) => l.includes("USER-SUPPLIED-SEGMENT-xyz"));
    assert(line, "unmatched path segment appears verbatim in the access log route field");
  },
);
