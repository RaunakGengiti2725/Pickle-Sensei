// Stress harness for POST /v1/me/delete-request (failure-injection + load).
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, exactly like
// routesHarness.ts / sessionHarness.ts) behind a fake `fetch` that models
// every upstream the route can touch — Supabase Auth (GoTrue), PostgREST
// (the deletion-challenge upsert, the exit-survey RPC/select/insert),
// Upstash Redis and RevenueCat — and lets a test inject, per upstream and per
// call, an HTTP status, a malformed body, a socket failure, extra latency or
// an indefinite hang. Nothing here talks to a network.
//
// Every campaign is driven by a seeded PRNG (mulberry32) so any iteration is
// replayable from its seed; the tests write JSON tables (seed → outcome) to
// STRESS_OUT_DIR. Slow campaigns scale with STRESS_ITER (small default).

import { createHmac } from "node:crypto";
import { captureAccessLog } from "../http.ts";

export type Target =
  | "auth.user" // GET  /auth/v1/user            (session bearer verification)
  | "auth.token" // POST /auth/v1/token           (provider id_token grant)
  | "rest.deletion_upsert" // POST /rest/v1/account_deletion_requests
  | "rest.access_state" // POST /rest/v1/rpc/access_state
  | "rest.profiles" // GET  /rest/v1/profiles
  | "rest.feedback_insert" // POST /rest/v1/account_deletion_feedback
  | "rest.other" // any other PostgREST call (must not happen on this route)
  | "redis" // POST <upstash>/pipeline
  | "revenuecat" // GET  api.revenuecat.com/v1/subscribers/…
  | "unknown";

export type Fault =
  | { kind: "ok" }
  | {
      kind: "http";
      status: number;
      body?: string;
      headers?: Record<string, string>;
    }
  | { kind: "throw"; message?: string }
  | { kind: "delay"; ms: number; then?: Fault }
  | { kind: "hang" };

export interface RecordedCall {
  seq: number;
  target: Target;
  url: string;
  method: string;
  fault: Fault;
  /** ms after the harness clock started */
  at: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple" | "email";
  createdAt: string;
  premium: boolean;
  scoredCount: number;
}

export interface DeletionRow {
  user_id: string;
  challenge: string;
  created_at: string;
  expires_at: string;
}

export interface FeedbackRow {
  user_id: string;
  reason: string;
  wanted: string | null;
  details: string | null;
  provider: string;
  platform: string | null;
  app_version: string | null;
  account_age_days: number | null;
  was_premium: boolean | null;
  scored_count: number | null;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  calls: RecordedCall[];
  callsTo(target: Target): RecordedCall[];
  users: Map<string, FakeUser>;
  sessions: Map<string, string>; // access token → user id
  deletionRequests: Map<string, DeletionRow>;
  feedback: FeedbackRow[];
  redis: Map<string, { value: string; expiresAtMs: number }>;
  /** Queue one or more faults for a target; consumed FIFO, one per call.
   * `sticky` faults are repeated for every call until reset. */
  inject(target: Target, ...faults: Fault[]): void;
  injectSticky(target: Target, fault: Fault): void;
  /** Drop every queued / sticky fault (upstreams healthy again). */
  clearFaults(): void;
  /** When set, every `rest.*` call (PostgREST) is forwarded over the real
   * network to this base URL (e.g. a local PostgREST in front of a disposable
   * postgres:16) instead of the in-memory model; faults still apply first. */
  restProxy: string | null;
  /** When set, `mintSession` signs its JWT (HS256) so a real PostgREST
   * accepts it. */
  jwtSecret: string | null;
  /** Access-log lines the function emitted (captured, not printed). */
  accessLog: string[];
  /** console.error lines the function emitted (captured, not printed). */
  errorLog: string[];
  /** Wall-clock latency applied to every upstream call (ms), sampled from
   * `latency` when set. */
  latency: ((target: Target) => number) | null;
  /** Release every hung upstream call with a normal answer. */
  releaseHangs(): void;
  hungCount(): number;
  reset(): void;
  registerUser(user: Partial<FakeUser> & { id: string }): FakeUser;
  /** A Supabase-shaped access token whose GET /auth/v1/user answers `user`. */
  mintSession(userId: string, ttlSeconds?: number): string;
  /** The request the app sends. */
  request(opts: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    rawBody?: BodyInit | null;
    headers?: Record<string, string>;
  }): Request;
}

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ROUTE_PATH = "/v1/me/delete-request";

// ── Seeded PRNG (mulberry32; identical to xc_concurrency_harness.ts) ─────────

export class Prng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export const envInt = (name: string, fallback: number): number => {
  const raw = Number(Deno.env.get(name));
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 60);
export const STRESS_OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";

export async function writeReport(name: string, report: unknown): Promise<string | null> {
  if (!STRESS_OUT_DIR) return null;
  await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
  const path = `${STRESS_OUT_DIR.replace(/\/$/, "")}/${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

export function latencyStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
    mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
  };
}

// ── The mobile client's view of a response (apps/mobile/src/account/deletion.ts)

export type ClientClass =
  | "challenge" // 2xx with {challenge, expiresAt}
  | "session_expired" // 401 → sign in again (non-retryable)
  | "rejected_retryable" // 429 or ≥500 → user may try again
  | "rejected_final" // other 4xx, or 2xx without a usable body
  | "unavailable"; // no HTTP answer inside the app's 15 s (network / timeout)

export const CLIENT_TIMEOUT_MS = 15_000;

export function classifyForClient(status: number, body: unknown): ClientClass {
  if (status === 401) return "session_expired";
  if (status < 200 || status >= 300) {
    return status === 429 || status >= 500 ? "rejected_retryable" : "rejected_final";
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!record) return "rejected_final";
  return typeof record.challenge === "string" && typeof record.expiresAt === "string"
    ? "challenge"
    : "rejected_final";
}

// ── JWT helpers ─────────────────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>, secret?: string | null): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const signingInput = `${header}.${b64url(JSON.stringify(payload))}`;
  if (!secret) return `${signingInput}.${b64url("sig")}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export function googleIdToken(sub: string, ttlSeconds = 3600): string {
  return fakeJwt({
    iss: "https://accounts.google.com",
    sub,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const seg = token.split(".")[1] ?? "";
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function targetOf(url: string, method: string): Target {
  if (url.startsWith(RC_URL)) return "revenuecat";
  if (url === `${REDIS_URL}/pipeline`) return "redis";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return "auth.user";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) return "auth.token";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    const path = new URL(url).pathname.slice("/rest/v1/".length);
    if (path === "account_deletion_requests" && method === "POST") return "rest.deletion_upsert";
    if (path === "rpc/access_state") return "rest.access_state";
    if (path === "profiles" && method === "GET") return "rest.profiles";
    if (path === "account_deletion_feedback" && method === "POST") return "rest.feedback_insert";
    return "rest.other";
  }
  return "unknown";
}

let harness: Harness | null = null;
let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`;
}

/** Boot the real edge function once per test module. `redis: true` configures
 * Upstash (cache.ts reads its env at import, so this is fixed per isolate). */
export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<Harness> {
  if (harness) {
    harness.reset();
    return harness;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_stress");
  for (const k of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
    "AUTH_UPSTREAM_TIMEOUT_MS",
  ])
    Deno.env.delete(k);
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "upstash-stress-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const queues = new Map<Target, Fault[]>();
  const sticky = new Map<Target, Fault>();
  const hung: Array<() => void> = [];
  const t0 = performance.now();
  let seq = 0;

  const state: Harness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    calls: [],
    callsTo: (target) => state.calls.filter((c) => c.target === target),
    users: new Map(),
    sessions: new Map(),
    deletionRequests: new Map(),
    feedback: [],
    redis: new Map(),
    latency: null,
    inject(target, ...faults) {
      const q = queues.get(target) ?? [];
      q.push(...faults);
      queues.set(target, q);
    },
    injectSticky(target, fault) {
      sticky.set(target, fault);
    },
    clearFaults() {
      queues.clear();
      sticky.clear();
    },
    restProxy: null,
    jwtSecret: null,
    accessLog: [],
    errorLog: [],
    releaseHangs() {
      for (const release of hung.splice(0)) release();
    },
    hungCount: () => hung.length,
    reset() {
      state.calls = [];
      state.users = new Map();
      state.sessions = new Map();
      state.deletionRequests = new Map();
      state.feedback = [];
      state.redis = new Map();
      state.latency = null;
      state.accessLog = [];
      state.errorLog = [];
      queues.clear();
      sticky.clear();
      state.releaseHangs();
    },
    registerUser(partial) {
      const user: FakeUser = {
        id: partial.id,
        email: partial.email ?? `${partial.id.slice(0, 8)}@example.com`,
        provider: partial.provider ?? "google",
        createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
        premium: partial.premium ?? false,
        scoredCount: partial.scoredCount ?? 0,
      };
      state.users.set(user.id, user);
      return user;
    },
    mintSession(userId, ttlSeconds = 3600) {
      const token = fakeJwt(
        {
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: crypto.randomUUID(),
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        state.jwtSecret,
      );
      state.sessions.set(token, userId);
      return token;
    },
    request(opts) {
      const headers = new Headers({ "x-forwarded-for": opts.ip ?? freshIp(), ...opts.headers });
      if (opts.token !== null && opts.token !== undefined) {
        headers.set("Authorization", `Bearer ${opts.token}`);
      }
      let body: BodyInit | null | undefined = opts.rawBody;
      if (opts.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(opts.body);
      }
      return new Request(`http://edge.stress.test/functions/v1/api${ROUTE_PATH}`, {
        method: "POST",
        headers,
        body: body ?? undefined,
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
    created_at: user.createdAt,
  });

  const authError = (status: number, msg: string) =>
    jsonResponse(status, { code: status, msg, error_code: "bad_jwt" });

  /** The upstream's NORMAL answer (what a healthy dependency returns). */
  const realAnswer = (
    target: Target,
    request: Request,
    headers: Record<string, string>,
    body: unknown,
  ): Response => {
    const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    switch (target) {
      case "auth.user": {
        const userId = state.sessions.get(bearer);
        const user = userId ? state.users.get(userId) : undefined;
        if (!user) return authError(401, "invalid JWT: session not found");
        return jsonResponse(200, gotrueUser(user));
      }
      case "auth.token": {
        const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const claims = decodeJwtPayload(
          typeof payload.id_token === "string" ? payload.id_token : "",
        );
        const sub = typeof claims?.sub === "string" ? claims.sub : "";
        const user = state.users.get(sub);
        if (!user || user.provider !== payload.provider) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        const token = state.mintSession(user.id);
        return jsonResponse(200, {
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `rt-${crypto.randomUUID()}`,
          user: gotrueUser(user),
        });
      }
      case "rest.deletion_upsert": {
        const sub = decodeJwtPayload(bearer)?.sub;
        const rows = Array.isArray(body) ? body : [body];
        for (const row of rows as DeletionRow[]) {
          if (!sub || row.user_id !== sub) {
            return jsonResponse(403, {
              code: "42501",
              message:
                'new row violates row-level security policy for table "account_deletion_requests"',
              details: null,
              hint: null,
            });
          }
          state.deletionRequests.set(row.user_id, { ...row });
        }
        return new Response(null, { status: 201 });
      }
      case "rest.access_state": {
        const sub = decodeJwtPayload(bearer)?.sub;
        const user = typeof sub === "string" ? state.users.get(sub) : undefined;
        return jsonResponse(200, [
          {
            premium: user?.premium ?? false,
            scored_count: user?.scoredCount ?? 0,
            reserved_count: 0,
          },
        ]);
      }
      case "rest.profiles": {
        const sub = decodeJwtPayload(bearer)?.sub;
        const user = typeof sub === "string" ? state.users.get(sub) : undefined;
        const accept = headers["accept"] ?? "";
        if (!user) {
          return accept.includes("vnd.pgrst.object")
            ? jsonResponse(406, { code: "PGRST116", message: "0 rows", details: null, hint: null })
            : jsonResponse(200, []);
        }
        const row = { created_at: user.createdAt };
        return jsonResponse(200, accept.includes("vnd.pgrst.object") ? row : [row]);
      }
      case "rest.feedback_insert": {
        const sub = decodeJwtPayload(bearer)?.sub;
        const rows = Array.isArray(body) ? body : [body];
        for (const row of rows as FeedbackRow[]) {
          if (!sub || row.user_id !== sub) {
            return jsonResponse(403, {
              code: "42501",
              message:
                'new row violates row-level security policy for table "account_deletion_feedback"',
              details: null,
              hint: null,
            });
          }
          state.feedback.push({ ...row });
        }
        return new Response(null, { status: 201 });
      }
      case "redis": {
        if (headers["authorization"] !== "Bearer upstash-stress-token") {
          return jsonResponse(401, { error: "Unauthorized" });
        }
        const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
        return jsonResponse(
          200,
          commands.map((c) => runRedisCommand(state, c)),
        );
      }
      case "revenuecat":
        return jsonResponse(200, { subscriber: { entitlements: {}, subscriptions: {} } });
      default:
        return new Response(`unexpected fetch in stress test: ${request.method} ${request.url}`, {
          status: 599,
        });
    }
  };

  const applyFault = async (
    fault: Fault,
    answer: () => Response,
    signal: AbortSignal | null,
  ): Promise<Response> => {
    switch (fault.kind) {
      case "ok":
        return answer();
      case "http":
        return new Response(fault.body ?? "", {
          status: fault.status,
          headers: { "Content-Type": "application/json", ...(fault.headers ?? {}) },
        });
      case "throw":
        throw new TypeError(fault.message ?? "error sending request for url (connection reset)");
      case "delay":
        await sleep(fault.ms);
        if (signal?.aborted) throw new DOMException("The signal has been aborted", "AbortError");
        return applyFault(fault.then ?? { kind: "ok" }, answer, signal);
      case "hang":
        return new Promise<Response>((resolve, reject) => {
          const release = () => resolve(answer());
          hung.push(release);
          signal?.addEventListener(
            "abort",
            () => {
              const i = hung.indexOf(release);
              if (i >= 0) hung.splice(i, 1);
              reject(new DOMException("The signal has been aborted", "AbortError"));
            },
            { once: true },
          );
        });
    }
  };

  const realFetch = globalThis.fetch;
  const proxyRest = async (request: Request, text: string, signal: AbortSignal | null) => {
    const url = new URL(request.url);
    const forwarded = new URL(
      url.pathname.replace(/^\/rest\/v1/, "") + url.search,
      state.restProxy!,
    );
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await realFetch(forwarded, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : text,
      signal: signal ?? undefined,
    });
    // Buffer so the Response is fully materialised (mirrors the in-memory model).
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const target = targetOf(request.url, request.method);
    const queued = queues.get(target);
    const fault: Fault =
      queued && queued.length > 0 ? queued.shift()! : (sticky.get(target) ?? { kind: "ok" });
    seq += 1;
    state.calls.push({
      seq,
      target,
      url: request.url,
      method: request.method,
      fault,
      at: Math.round((performance.now() - t0) * 1000) / 1000,
      body,
      headers,
    });
    const signal = init?.signal ?? request.signal ?? null;
    if (signal?.aborted) throw new DOMException("The signal has been aborted", "AbortError");
    const extra = state.latency ? state.latency(target) : 0;
    if (extra > 0) await sleep(extra);
    if (state.restProxy && target.startsWith("rest.") && fault.kind === "ok") {
      return proxyRest(request, text, signal);
    }
    return applyFault(fault, () => realAnswer(target, request, headers, body), signal);
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((a) => typeof a === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    state.handler = fn;
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
    if (state.accessLog.length < 50_000) state.accessLog.push(line);
  });
  const capture =
    (real: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const line = args
        .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
        .join(" ");
      if (line.startsWith("[api]")) {
        if (state.errorLog.length < 50_000) state.errorLog.push(line);
        return;
      }
      real(...args);
    };
  console.error = capture(console.error);
  console.warn = capture(console.warn);

  await import("../index.ts");
  harness = state;
  return state;
}

function redisLive(state: Harness, key: string) {
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
  state: Harness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  const [op, ...args] = command.map(String);
  switch (op) {
    case "GET":
      return { result: redisLive(state, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
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
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) return { result: 0 };
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

/** Issue one request through the real handler and describe the outcome. */
export interface Outcome {
  status: number;
  body: unknown;
  client: ClientClass;
  latencyMs: number;
  retryAfter: string | null;
  calls: Record<string, number>;
  supabaseRoundTrips: number;
  redisRoundTrips: number;
}

export async function drive(h: Harness, request: Request): Promise<Outcome> {
  const before = h.calls.length;
  const started = performance.now();
  const response = await h.handler(request);
  const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  const calls: Record<string, number> = {};
  let supabaseRoundTrips = 0;
  let redisRoundTrips = 0;
  for (const call of h.calls.slice(before)) {
    calls[call.target] = (calls[call.target] ?? 0) + 1;
    if (call.target.startsWith("auth.") || call.target.startsWith("rest.")) supabaseRoundTrips += 1;
    if (call.target === "redis") redisRoundTrips += 1;
  }
  return {
    status: response.status,
    body,
    client: classifyForClient(response.status, body),
    latencyMs,
    retryAfter: response.headers.get("Retry-After"),
    calls,
    supabaseRoundTrips,
    redisRoundTrips,
  };
}

export const VALID_SURVEY = {
  reason: "not_using",
  wanted: "price",
  details: "Moving on — thanks.",
  platform: "ios",
  appVersion: "1.2.3",
};
