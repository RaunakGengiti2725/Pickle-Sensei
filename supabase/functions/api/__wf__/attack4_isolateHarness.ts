// Adversarial pass #4 (edge-auth-cache-ratelimit) — multi-isolate harness for
// the REAL edge handler.
//
// routesHarness.ts loads ../index.ts exactly once, so every test in the
// process shares ONE cache.ts / rateLimit.ts instance (one L1, one memory
// rate-limit map). Several assigned scenarios need the handler itself running
// in N separate "isolates" (own L1, own memory windows, shared fake Redis):
//
//   loadEdgeIsolate() — re-materialises index.ts from source with its
//                       "./cache.ts" and "./rateLimit.ts" imports pointed at a
//                       per-isolate module instance (query-string specifier /
//                       blob URL, the same trick harness.ts uses), captures the
//                       Deno.serve handler, and returns it together with that
//                       isolate's cache + rateLimit modules for white-box
//                       assertions. http.ts stays canonical so
//                       captureAccessLog() from ../http.ts sees the isolate's
//                       access lines.
//   installFakeSupabase() — a fetch-layer Supabase Auth + PostgREST stand-in
//                       that COUNTS signInWithIdToken / getUser / logout calls,
//                       mints JWT-shaped Supabase access tokens (iss ends in
//                       /auth/v1 so authenticate() routes them to getUser), and
//                       revokes tokens on POST /auth/v1/logout — so a logged-out
//                       bearer is refused by "Supabase" exactly like production.
//
// Layering: installFakeSupabase() first, then harness.ts fakeUpstash() on top
// (fakeUpstash forwards non-Redis URLs to the fetch it replaced). Env is read
// at module load in cache.ts, so configureRedis() must run BEFORE
// loadEdgeIsolate(). Everything here is process-global; run tests serially.

export const SUPABASE_URL = "http://supabase.test";
export const ANON_KEY = "anon-test-key";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Google ID token routed to the transitional authenticate() branch. */
export function googleIdToken(sub: string, expInSeconds = 3600, nonce = ""): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + expInSeconds,
      ...(nonce ? { nonce } : {}),
    }),
  );
  return `${header}.${payload}.sig`;
}

/** Supabase-issued access token shape (iss ends with /auth/v1) — the bearer
 * the app holds after bootstrap. Verification is the fake Auth's job. */
export function supabaseAccessToken(sub: string, expInSeconds = 3600, sessionId = "s1"): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + expInSeconds,
    }),
  );
  return `${header}.${payload}.sig`;
}

export interface FakeSupabase {
  signInCalls: number;
  getUserCalls: number;
  logoutCalls: number;
  profileReads: number;
  /** id_token strings signInWithIdToken was asked to exchange, in order. */
  signInTokens: string[];
  /** Access tokens minted by signInWithIdToken (one per "session"). */
  mintedSessions: string[];
  /** Bearers revoked through POST /auth/v1/logout. */
  revoked: Set<string>;
  /** Every non-Redis URL fetched, in order. */
  urls: string[];
  /** When set, getUser answers this status for every bearer. */
  getUserStatus: number | null;
  /** When set, POST /auth/v1/logout answers this status (no revocation). */
  logoutStatus: number | null;
  /** Simulated network latency of every Supabase Auth call (ms). */
  latencyMs: number;
  restore(): void;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function authUser(sub: string) {
  return {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: `${sub.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

export function installFakeSupabase(options: { latencyMs?: number } = {}): FakeSupabase {
  const original = globalThis.fetch;
  let mintCounter = 0;
  const fake: FakeSupabase = {
    signInCalls: 0,
    getUserCalls: 0,
    logoutCalls: 0,
    profileReads: 0,
    signInTokens: [],
    mintedSessions: [],
    revoked: new Set(),
    urls: [],
    getUserStatus: null,
    logoutStatus: null,
    latencyMs: options.latencyMs ?? 0,
    restore() {
      globalThis.fetch = original;
    },
  };
  const latency = () =>
    fake.latencyMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, fake.latencyMs))
      : Promise.resolve();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    fake.urls.push(url);
    if (!url.startsWith(SUPABASE_URL)) {
      return new Response(`unexpected fetch in attack test: ${request.method} ${url}`, {
        status: 599,
      });
    }
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      await latency();
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const idToken = typeof body.id_token === "string" ? body.id_token : "";
      const sub = String(decodeJwtPayload(idToken)?.sub ?? "unknown-sub");
      fake.signInCalls += 1;
      fake.signInTokens.push(idToken);
      mintCounter += 1;
      const accessToken = supabaseAccessToken(sub, 3600, `minted-${mintCounter}`);
      fake.mintedSessions.push(accessToken);
      return jsonResponse(200, {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: `refresh-${mintCounter}`,
        user: authUser(sub),
      });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      await latency();
      fake.getUserCalls += 1;
      if (fake.getUserStatus !== null) {
        return jsonResponse(fake.getUserStatus, { code: fake.getUserStatus, msg: "forced" });
      }
      const payload = decodeJwtPayload(bearer);
      if (!payload || fake.revoked.has(bearer)) {
        return jsonResponse(401, { code: 401, msg: "invalid JWT: session not found" });
      }
      return jsonResponse(200, authUser(String(payload.sub)));
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      await latency();
      fake.logoutCalls += 1;
      if (fake.logoutStatus !== null) {
        return jsonResponse(fake.logoutStatus, { code: fake.logoutStatus, msg: "forced" });
      }
      if (!decodeJwtPayload(bearer)) return jsonResponse(401, { code: 401, msg: "invalid JWT" });
      fake.revoked.add(bearer);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/profiles`)) {
      // Real PostgREST checks the JWT's signature and exp ONLY — a session
      // logged out at Auth still passes here until the access token expires.
      fake.profileReads += 1;
      const payload = decodeJwtPayload(bearer);
      const exp = typeof payload?.exp === "number" ? payload.exp : 0;
      if (!payload || exp * 1_000 <= Date.now()) {
        return jsonResponse(401, { code: "PGRST301", message: "JWT expired" });
      }
      const sub = String(payload.sub);
      return jsonResponse(200, {
        id: sub,
        email: `${sub.slice(0, 8)}@example.com`,
        onboarding_state: "complete",
        provider: "google",
        skill_level: null,
        handedness: null,
        primary_goal: null,
        biggest_problem: null,
        focus_checkpoint: null,
        first_name: null,
        gender: null,
      });
    }
    return new Response(`unstubbed supabase call: ${request.method} ${url}`, { status: 599 });
  }) as typeof fetch;

  return fake;
}

export type CacheModule = typeof import("../cache.ts");
export type RateLimitModule = typeof import("../rateLimit.ts");

export interface EdgeIsolate {
  tag: string;
  handler: (request: Request) => Promise<Response>;
  cache: CacheModule;
  rateLimit: RateLimitModule;
}

let isolateCounter = 0;

function ensureBaseEnv(): void {
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  }
}

/** Boot one edge "isolate": the real handler with its OWN cache.ts and
 * rateLimit.ts instances. Redis env must already be configured. */
export async function loadEdgeIsolate(): Promise<EdgeIsolate> {
  ensureBaseEnv();
  isolateCounter += 1;
  const tag = `attack4-${Date.now()}-${isolateCounter}`;
  const apiDir = new URL("../", import.meta.url);

  const cacheSpecifier = new URL(`../cache.ts?iso=${tag}`, import.meta.url).href;
  const cache = (await import(cacheSpecifier)) as CacheModule;

  const rateLimitSource = await Deno.readTextFile(new URL("../rateLimit.ts", import.meta.url));
  const rateLimitBlob = URL.createObjectURL(
    new Blob([rateLimitSource.replace('from "./cache.ts"', `from "${cacheSpecifier}"`)], {
      type: "application/typescript",
    }),
  );
  const rateLimit = (await import(rateLimitBlob)) as RateLimitModule;

  const indexSource = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  const patchedIndex = indexSource
    .replace('from "./cache.ts"', `from "${cacheSpecifier}"`)
    .replace('from "./rateLimit.ts"', `from "${rateLimitBlob}"`)
    .replace(/from "\.\/([A-Za-z0-9_]+\.ts)"/g, (_m, file: string) => {
      return `from "${new URL(file, apiDir).href}"`;
    });
  const indexBlob = URL.createObjectURL(
    new Blob([patchedIndex], { type: "application/typescript" }),
  );

  const realServe = Deno.serve;
  let captured: EdgeIsolate["handler"] | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | EdgeIsolate["handler"]
      | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    captured = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;
  try {
    await import(indexBlob);
  } finally {
    Deno.serve = realServe;
    URL.revokeObjectURL(indexBlob);
    URL.revokeObjectURL(rateLimitBlob);
  }
  if (!captured) throw new Error("index.ts did not call Deno.serve");
  return { tag, handler: captured, cache, rateLimit };
}

export const EDGE_BASE = "http://edge.test/functions/v1/api";

/** Request builder that adds NOTHING implicit: no IP header, no bearer unless
 * asked — the scenarios here are about exactly those headers. */
export function edgeRequest(
  method: string,
  path: string,
  options: { token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${EDGE_BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Deterministic PRNG (mulberry32) — seeds are recorded in test output. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededUuid(rand: () => number): string {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const run = (n: number) => Array.from({ length: n }, hex).join("");
  return `${run(8)}-${run(4)}-4${run(3)}-8${run(3)}-${run(12)}`;
}

/** Freeze/advance Date.now() for the whole process (rateLimit.ts, cache.ts,
 * index.ts and the fake Redis all read the same clock). */
export function stubClock(startMs: number): { advance(ms: number): void; restore(): void } {
  const realNow = Date.now;
  let now = startMs;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}
