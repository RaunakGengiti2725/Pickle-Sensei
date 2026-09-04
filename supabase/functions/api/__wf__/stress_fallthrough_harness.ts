// Stress harness for the PUBLIC + FALLTHROUGH surface of the edge function:
//   GET|HEAD /healthz, /privacy, /terms (+ /support) and everything the
//   router does not know (unknown paths, unsupported methods) — the branch of
//   handleRequest() in ../index.ts that runs BEFORE any route logic.
//
// Boots the REAL ../index.ts in-process (Deno.serve captured) behind a fetch
// fake that models every upstream the pre-route pipeline can touch —
// Supabase Auth (GET /auth/v1/user, POST /auth/v1/token), PostgREST,
// Upstash Redis (/pipeline) and RevenueCat — and lets a test put ONE fault
// on each of them: connection refused, a hang (until the caller aborts or a
// bounded delay elapses), any HTTP status, a 2xx with a non-JSON / empty /
// wrong-shaped body, a slow-but-valid answer, or (Redis only) a reply that is
// not a pipeline array, has a per-command error, is short, or carries a
// garbage / huge / negative counter.
//
// Every upstream call is recorded, so a test can assert round trips per
// request, not just the response class. A seeded RNG (mulberry32) makes every
// randomized iteration replayable from its seed. Results are written as JSON
// under STRESS_OUT_DIR (default artifacts/stress-route-public-fallthrough/latest/).
//
// Nothing here talks to a network: the only fetch that exists is the fake.

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const REVENUECAT_URL = "https://api.revenuecat.com/v1/subscribers/";

export type Upstream =
  | "auth_user"
  | "auth_token"
  | "rest"
  | "redis"
  | "revenuecat";
export const UPSTREAMS: readonly Upstream[] = [
  "auth_user",
  "auth_token",
  "rest",
  "redis",
  "revenuecat",
];

export type FaultKind =
  | "none"
  /** fetch() rejects (socket refused / reset / DNS). */
  | "reject"
  /** No answer until the caller's AbortSignal fires or `hangMs` elapses; then
   * answers normally (a stalled upstream that eventually recovers). */
  | "hang"
  /** An HTTP answer with `status` (+ optional Retry-After) and a JSON error body. */
  | "http"
  /** A valid answer delayed by `delayMs`. */
  | "slow_ok"
  /** 200 whose body is not JSON (a gateway HTML page). */
  | "malformed_body"
  /** 200 whose body is JSON of the wrong shape. */
  | "wrong_shape"
  /** 200 with an empty body. */
  | "empty_body";

export interface Fault {
  kind: FaultKind;
  status?: number;
  retryAfter?: string;
  hangMs?: number;
  delayMs?: number;
}

export const NO_FAULT: Fault = { kind: "none" };

/** Redis-specific reply shapes (only meaningful for the "redis" upstream). */
export type RedisReplyShape =
  | "real"
  /** Reply is a JSON object, not an array. */
  | "non_array"
  /** Every slot carries a Redis-side error. */
  | "command_error"
  /** Reply has fewer slots than commands. */
  | "short_reply"
  /** Counter slots answer with a non-numeric string. */
  | "garbage_count"
  /** Counter slots answer with a huge number. */
  | "huge_count"
  /** Counter slots answer with a negative number. */
  | "negative_count"
  /** Counter slots answer with a numeric string. */
  | "string_count";

export interface RecordedCall {
  upstream: Upstream;
  url: string;
  method: string;
  /** Wall-clock ms the fake spent before answering. */
  ms: number;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple";
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  faults: Record<Upstream, Fault>;
  redisReply: RedisReplyShape;
  calls: RecordedCall[];
  /** Structured `api_request` lines the handler emitted (captured, not printed). */
  accessLog: string[];
  redisCommands: Array<Array<string | number>>;
  redis: Map<string, { value: string; expiresAtMs: number }>;
  users: Map<string, FakeUser>;
  /** access token → user id (sessions the fake GoTrue has minted). */
  sessions: Map<string, string>;
  callsTo(upstream: Upstream): RecordedCall[];
  /** Clear faults, counters and fake state (users/sessions/redis store). */
  reset(): void;
  /** Register a user and mint a Supabase-shaped session access token for it. */
  sessionFor(user: FakeUser, ttlSeconds?: number): string;
  /** Register a user and return a provider ID token whose `sub` is the user id. */
  providerTokenFor(user: FakeUser, ttlSeconds?: number): string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  return decodeSegment(token.split(".")[1] ?? "");
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${
    b64url(crypto.randomUUID())
  }`;
}

export function userOf(
  n: number,
  provider: "google" | "apple" = "google",
): FakeUser {
  const hex = n.toString(16).padStart(12, "0");
  return {
    id: `7e000000-0000-4000-8000-${hex}`,
    email: `stress-${n}@example.test`,
    provider,
  };
}

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Deterministic per-iteration seed derived from a campaign seed. */
export function iterationSeed(campaignSeed: number, index: number): number {
  return (Math.imul(campaignSeed ^ 0x9e3779b9, 0x85ebca6b) +
    Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
}

// ─── Percentiles / memory ────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[rank];
}

export function latencySummary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    n: sorted.length,
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted[sorted.length - 1] ?? NaN),
    mean_ms: round(
      sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    ),
  };
}

export function heapSnapshot() {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  const usage = Deno.memoryUsage();
  return {
    heapUsed_mb: Math.round((usage.heapUsed / 1_048_576) * 100) / 100,
    heapTotal_mb: Math.round((usage.heapTotal / 1_048_576) * 100) / 100,
    rss_mb: Math.round((usage.rss / 1_048_576) * 100) / 100,
    gcForced: typeof gc === "function",
  };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function outDir(): string {
  const configured = Deno.env.get("STRESS_OUT_DIR");
  if (configured) return configured;
  return new URL(
    "../../../../artifacts/stress-route-public-fallthrough/latest/",
    import.meta.url,
  )
    .pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir.endsWith("/") ? dir : `${dir}/`}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

// ─── Clock ───────────────────────────────────────────────────────────────────

/** Run `fn` with Date.now() shifted by `offsetMs` (rate-limit windows, the
 * auth cache and bearer expiry all read Date.now()). */
export async function withClockOffset<T>(
  offsetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// ─── Requests ────────────────────────────────────────────────────────────────

let ipCounter = 0;
/** A fresh client IP per call so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`;
}

export const EDGE_ORIGIN = "http://edge.stress.test";
export const MOUNT = "/functions/v1/api";

export function apiRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    /** Use the bare path (no gateway mount prefix). */
    bare?: boolean;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? freshIp(),
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const url = `${EDGE_ORIGIN}${options.bare ? "" : MOUNT}${path}`;
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: canHaveBody ? (options.body ?? undefined) : undefined,
  });
}

export interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  contentType: string | null;
  cacheControl: string | null;
  retryAfter: string | null;
  requestId: string | null;
  bodyBytes: number;
  bodyText: string;
  ms: number;
}

/** Send one request through the real handler and flatten what a client sees. */
export async function observe(
  h: StressHarness,
  request: Request,
): Promise<Observed> {
  const started = performance.now();
  const response = await h.handler(request);
  const bodyText = await response.text();
  const ms = performance.now() - started;
  let code: string | null = null;
  let message: string | null = null;
  if (
    (response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (isRecord(parsed) && isRecord(parsed.error)) {
        code = typeof parsed.error.code === "string" ? parsed.error.code : null;
        message = typeof parsed.error.message === "string"
          ? parsed.error.message
          : null;
      }
    } catch {
      // Non-JSON body under a JSON content type is itself an observation.
      code = "<unparseable>";
    }
  }
  return {
    status: response.status,
    code,
    message,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    retryAfter: response.headers.get("retry-after"),
    requestId: response.headers.get("x-request-id"),
    bodyBytes: new TextEncoder().encode(bodyText).byteLength,
    bodyText,
    ms,
  };
}

// ─── Fault plumbing ──────────────────────────────────────────────────────────

class FaultReject extends TypeError {
  constructor() {
    super("error sending request for url: connection refused (stress fault)");
    this.name = "TypeError";
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The signal has been aborted", "AbortError");
}

function delay(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Apply a fault BEFORE the real answer is computed. Returns a Response to
 * short-circuit with, or null to let the real fake answer (after any delay). */
async function applyFault(
  fault: Fault,
  signal: AbortSignal | null | undefined,
  errorBody: (status: number) => string,
): Promise<Response | null> {
  switch (fault.kind) {
    case "none":
      return null;
    case "reject":
      throw new FaultReject();
    case "hang":
      // Resolves only when the caller aborts (→ throws its abort reason) or
      // the bounded hang elapses (→ the real answer, late).
      await delay(fault.hangMs ?? 1_500, signal);
      return null;
    case "slow_ok":
      await delay(fault.delayMs ?? 100, signal);
      return null;
    case "http": {
      const status = fault.status ?? 500;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (fault.retryAfter) headers["Retry-After"] = fault.retryAfter;
      return new Response(errorBody(status), { status, headers });
    }
    case "malformed_body":
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    case "wrong_shape":
      return new Response(
        JSON.stringify({ unexpected: true, id: 42, items: [] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    case "empty_body":
      return new Response("", { status: 200 });
  }
}

let harness: StressHarness | null = null;

const AUTH_TIMEOUT_ENV = "AUTH_UPSTREAM_TIMEOUT_MS";

/** index.ts reads AUTH_UPSTREAM_TIMEOUT_MS on every Auth call, and `deno test`
 * runs every module in ONE process, so the override must not outlive a
 * request: it is installed while ≥1 stress request is in flight and the
 * previous value is put back when the last one settles. */
function scopedAuthTimeout(
  inner: (request: Request) => Promise<Response>,
  timeoutMs: number,
): (request: Request) => Promise<Response> {
  let inFlight = 0;
  let previous: string | undefined;
  return async (request) => {
    if (inFlight === 0) {
      previous = Deno.env.get(AUTH_TIMEOUT_ENV);
      Deno.env.set(AUTH_TIMEOUT_ENV, String(timeoutMs));
    }
    inFlight += 1;
    try {
      return await inner(request);
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        if (previous === undefined) Deno.env.delete(AUTH_TIMEOUT_ENV);
        else Deno.env.set(AUTH_TIMEOUT_ENV, previous);
      }
    }
  };
}

/** Boot the real edge function once per test module. `redis: true` wires a
 * fake Upstash REST endpoint (cache.ts reads UPSTASH_* at import, so the
 * choice is fixed at first load). `authTimeoutMs` sets AUTH_UPSTREAM_TIMEOUT_MS
 * for the duration of each stress request so hang faults resolve quickly. */
export async function loadStressHarness(
  options: { redis?: boolean; authTimeoutMs?: number } = {},
): Promise<StressHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "stress-rc-secret");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    faults: emptyFaults(),
    redisReply: "real",
    calls: [],
    accessLog: [],
    redisCommands: [],
    redis: new Map(),
    users: new Map(),
    sessions: new Map(),
    callsTo(upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
    reset() {
      state.faults = emptyFaults();
      state.redisReply = "real";
      state.calls = [];
      state.accessLog = [];
      state.redisCommands = [];
      state.redis = new Map();
      state.users = new Map();
      state.sessions = new Map();
    },
    sessionFor(user, ttlSeconds = 3600) {
      state.users.set(user.id, user);
      const token = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: user.id,
        aud: "authenticated",
        role: "authenticated",
        session_id: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      state.sessions.set(token, user.id);
      return token;
    },
    providerTokenFor(user, ttlSeconds = 3600) {
      state.users.set(user.id, user);
      return fakeJwt({
        iss: user.provider === "apple"
          ? "https://appleid.apple.com"
          : "https://accounts.google.com",
        sub: user.id,
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },
  };

  const gotrueUser = (user: FakeUser) => ({
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const gotrueError = (status: number) =>
    JSON.stringify({
      code: status,
      msg: `stress fault ${status}`,
      error_code: "unexpected_failure",
    });
  const pgrstError = (status: number) =>
    JSON.stringify({
      code: `PGRST${status}`,
      message: `stress fault ${status}`,
      details: null,
    });
  const rcError = (status: number) =>
    JSON.stringify({ code: status, message: "stress fault" });
  const redisError = (status: number) =>
    JSON.stringify({ error: `stress fault ${status}` });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const signal = init?.signal ?? request.signal;
    const parsed = new URL(url);
    const bodyText = await request.text().catch(() => "");
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    let upstream: Upstream;
    if (url.startsWith(REDIS_URL)) upstream = "redis";
    else if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      upstream = "auth_user";
    } else if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      upstream = "auth_token";
    } else if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) upstream = "rest";
    else if (url.startsWith(REVENUECAT_URL)) upstream = "revenuecat";
    else {
      return new Response(
        `unexpected fetch in stress test: ${request.method} ${url}`,
        {
          status: 599,
        },
      );
    }
    const started = performance.now();
    const record = () =>
      state.calls.push({
        upstream,
        url,
        method: request.method,
        ms: performance.now() - started,
      });

    const errorBody = upstream === "redis"
      ? redisError
      : upstream === "rest"
      ? pgrstError
      : upstream === "revenuecat"
      ? rcError
      : gotrueError;
    try {
      const short = await applyFault(
        state.faults[upstream],
        signal,
        errorBody,
      );
      if (short) return short;
    } finally {
      record();
    }

    switch (upstream) {
      case "redis": {
        if (
          request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`
        ) {
          return jsonResponse(401, { error: "Unauthorized" });
        }
        const commands = Array.isArray(body)
          ? (body as Array<Array<string | number>>)
          : [];
        const real = commands.map((command) => runRedisCommand(state, command));
        return jsonResponse(
          200,
          shapeRedisReply(state.redisReply, commands, real),
        );
      }
      case "auth_user": {
        const bearer = (request.headers.get("authorization") ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const userId = state.sessions.get(bearer);
        const user = userId ? state.users.get(userId) : undefined;
        if (!user) {
          return jsonResponse(401, {
            code: 401,
            msg: "invalid JWT: session not found",
            error_code: "bad_jwt",
          });
        }
        return jsonResponse(200, gotrueUser(user));
      }
      case "auth_token": {
        const grant = parsed.searchParams.get("grant_type");
        const payload = isRecord(body) ? body : {};
        if (grant !== "id_token") {
          return jsonResponse(400, { error: "unsupported_grant_type" });
        }
        const idToken = typeof payload.id_token === "string"
          ? payload.id_token
          : "";
        const claims = jwtPayload(idToken);
        const sub = typeof claims?.sub === "string" ? claims.sub : "";
        const user = state.users.get(sub);
        if (!user || user.provider !== payload.provider) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        const accessToken = state.sessionFor(user);
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        return jsonResponse(200, {
          access_token: accessToken,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: expiresAt,
          refresh_token: `rt-${crypto.randomUUID()}`,
          user: gotrueUser(user),
        });
      }
      case "rest": {
        // The routes under stress never reach PostgREST; any call here is
        // itself a finding, but answer plausibly so the handler cannot hang.
        if (parsed.pathname.startsWith("/rest/v1/rpc/")) {
          return jsonResponse(200, {});
        }
        if (request.method === "GET") return jsonResponse(200, []);
        return new Response(null, { status: 204 });
      }
      case "revenuecat":
        return jsonResponse(200, {
          subscriber: { entitlements: {}, subscriptions: {} },
        });
    }
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = scopedAuthTimeout(handler, options.authTimeoutMs ?? 300);
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  captureAccessLog((line) => {
    state.accessLog.push(line);
    if (state.accessLog.length > 10_000) state.accessLog.splice(0, 5_000);
  });
  await import("../index.ts");
  harness = state;
  return state;
}

function emptyFaults(): Record<Upstream, Fault> {
  return {
    auth_user: NO_FAULT,
    auth_token: NO_FAULT,
    rest: NO_FAULT,
    redis: NO_FAULT,
    revenuecat: NO_FAULT,
  };
}

function redisLive(
  state: StressHarness,
  key: string,
): { value: string; expiresAtMs: number } | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

/** Minimal Upstash-compatible executor for the commands cache.ts issues. */
function runRedisCommand(
  state: StressHarness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  state.redisCommands.push(command);
  const [op, ...args] = command.map((part) => String(part));
  switch (op) {
    case "GET":
      return { result: redisLive(state, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
      state.redis.set(args[0], {
        value: args[1],
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (state.redis.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(state, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      state.redis.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? Infinity,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: 0 };
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

function shapeRedisReply(
  shape: RedisReplyShape,
  commands: Array<Array<string | number>>,
  real: Array<{ result?: unknown; error?: string }>,
): unknown {
  const isCounter = (command: Array<string | number>) =>
    command[0] === "INCR" || command[0] === "GET";
  switch (shape) {
    case "real":
      return real;
    case "non_array":
      return { result: "OK" };
    case "command_error":
      return commands.map(() => ({ error: "ERR max requests limit exceeded" }));
    case "short_reply":
      return real.slice(0, Math.max(0, real.length - 1));
    case "garbage_count":
      return real.map((
        slot,
        i,
      ) => (isCounter(commands[i]) ? { result: "not-a-number" } : slot));
    case "huge_count":
      return real.map((
        slot,
        i,
      ) => (isCounter(commands[i]) ? { result: 9_007_199_254_740_991 } : slot));
    case "negative_count":
      return real.map((
        slot,
        i,
      ) => (isCounter(commands[i]) ? { result: -7 } : slot));
    case "string_count":
      return real.map((slot, i) =>
        isCounter(commands[i]) && typeof slot.result === "number"
          ? { result: String(slot.result) }
          : slot
      );
  }
}
