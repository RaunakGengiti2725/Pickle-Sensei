// Adversarial probes against the session-revocation fence introduced in
// fd37f4c1 (cache.ts cacheGetUnlessRevoked / index.ts fenceRevokedSession),
// run against the REAL edge handler with the same fetch-layer fakes the
// lifecycle suite uses (stateful Supabase Auth + an Upstash pipeline emulating
// L2). Nothing hosted is touched; nothing here is a secret.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_fd37f4c1_auth_fence.test.ts
//
// The Upstash fake can be put into a WRITE-FAILURE mode: the pipeline HTTP call
// succeeds (200) but every SET answers a per-command error, exactly what
// Upstash returns when the database is out of memory / over quota while reads
// keep working ("OOM command not allowed when used memory > 'maxmemory'").

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";

const SUPABASE_URL = "http://supabase.attack.test";
const REDIS_URL = "http://redis.attack.test";
const PROBE_ROUTE = "/v1/me/saved-drills";
const USER = "22222222-2222-4222-8222-222222222222";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;

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
const timeline: string[] = [];

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
/** When set, every SET fails per-command while the pipeline itself is 200. */
let redisWriteError: string | null = null;

function redisLive(key: string): RedisEntry | null {
  const entry = redisStore.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    redisStore.delete(key);
    return null;
  }
  return entry;
}
function redisCommand(command: Array<string | number>): { result?: unknown; error?: string } {
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
      if (redisWriteError) return { error: redisWriteError };
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
      return json(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token",
      });
    }
    return json(400, { code: 400, msg: "unsupported grant" });
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
    timeline.push("auth:getUser");
    const session = liveSessionForToken(bearer);
    if (!session) {
      return json(401, {
        code: 401,
        error_code: "session_not_found",
        msg: "Session does not exist",
      });
    }
    return json(200, userJson(session.userId));
  }
  if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/logout") {
    timeline.push("auth:logout");
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
const freshIp = (): string => `203.0.113.${(ipCounter += 1)}`;

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
    new Request("http://edge.attack.test/functions/v1/api/v1/account/bootstrap", {
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

const getUserCalls = () => timeline.filter((entry) => entry === "auth:getUser").length;

// ─── attacks ────────────────────────────────────────────────────────────────

Deno.test(
  "ATTACK fd37f4c1 [regression vs 4d812e1a]: while Upstash refuses writes (per-command OOM error, reads fine) the auth cache must still serve a bearer this isolate verified — not re-verify it with Supabase Auth on EVERY request",
  async () => {
    const ip = freshIp();
    const { accessToken: bearer } = await bootstrap(ip);
    redisWriteError = "OOM command not allowed when used memory > 'maxmemory'.";
    try {
      timeline.length = 0;
      for (let i = 0; i < 5; i += 1) {
        assertEquals(
          (await call("GET", PROBE_ROUTE, { token: bearer, ip })).status,
          200,
          `request ${i + 1} authenticates (session is live upstream)`,
        );
      }
      // Baseline (4d812e1a): 1 — the first request verifies and the L1 row
      // (written before the failed L2 SET) serves the other four.
      // Candidate: 5 — every L1 hit asks L2 "TTL key", gets -2 because the
      // row never landed there, and is downgraded to a miss → getUser again.
      assertEquals(
        getUserCalls(),
        1,
        `Supabase Auth consulted ${getUserCalls()}× for 5 requests of one verified bearer; timeline: ${timeline.join(" → ")}`,
      );
    } finally {
      redisWriteError = null;
    }
  },
);

Deno.test(
  "verified_ok fd37f4c1: with Upstash writes failing, logout still fences the session in THIS isolate (L1 marker) — old and new bearers refused, upstream revoked",
  async () => {
    const ip = freshIp();
    const { accessToken: bearer } = await bootstrap(ip);
    assertEquals((await call("GET", PROBE_ROUTE, { token: bearer, ip })).status, 200);
    redisWriteError = "OOM command not allowed when used memory > 'maxmemory'.";
    try {
      assertEquals((await call("POST", "/v1/auth/logout", { token: bearer, ip })).status, 204);
      assertEquals(liveSessionForToken(bearer), null, "upstream session revoked");
      assertEquals((await call("GET", PROBE_ROUTE, { token: bearer, ip })).status, 401);
    } finally {
      redisWriteError = null;
    }
  },
);

Deno.test(
  "verified_ok fd37f4c1: a second logout with an already-fenced bearer is 401 (fence wins before the route), not 204 — same as 4d812e1a where upstream getUser refused it",
  async () => {
    const ip = freshIp();
    const { accessToken: bearer } = await bootstrap(ip);
    assertEquals((await call("POST", "/v1/auth/logout", { token: bearer, ip })).status, 204);
    timeline.length = 0;
    assertEquals((await call("POST", "/v1/auth/logout", { token: bearer, ip })).status, 401);
    assertEquals(getUserCalls(), 0, "refused from the tombstone");
  },
);

Deno.test(
  "verified_ok fd37f4c1: marker TTL boundary — 661s after logout the pre-refresh sibling is still refused (its L1/L2 rows are gone, upstream refuses it), never served from a stale row",
  async () => {
    const realNow = Date.now;
    let offsetMs = 0;
    Date.now = () => realNow() + offsetMs;
    try {
      const ip = freshIp();
      const { accessToken: oldToken, refreshToken } = await bootstrap(ip);
      assertEquals((await call("GET", PROBE_ROUTE, { token: oldToken, ip })).status, 200);
      const refreshed = await call("POST", "/v1/auth/refresh", { ip, body: { refreshToken } });
      assertEquals(refreshed.status, 200);
      const newToken = [...sessions.values()]
        .find((s) => s.accessTokens.includes(oldToken))!
        .accessTokens.at(-1)!;
      assertEquals((await call("POST", "/v1/auth/logout", { token: newToken, ip })).status, 204);

      for (const seconds of [1, 59, 61, 599, 659, 661, 3599]) {
        offsetMs = seconds * 1000;
        const response = await call("GET", PROBE_ROUTE, { token: oldToken, ip });
        assertEquals(response.status, 401, `old sibling refused ${seconds}s after logout`);
      }
    } finally {
      Date.now = realNow;
    }
  },
);
