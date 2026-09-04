// stress-edge-ratelimit — shared harness for the stress_ratelimit_*.test.ts
// campaigns (failure injection + load against rateLimit.ts budgets).
//
// Boots the REAL edge handler (../index.ts, Deno.serve captured, no socket)
// with every upstream stubbed at the fetch layer:
//
//   Supabase Auth   GET  /auth/v1/user, POST /auth/v1/token (refresh + id_token)
//   PostgREST       /rest/v1/<table>, /rest/v1/rpc/<fn>
//   RevenueCat      https://api.revenuecat.com/v1/subscribers/<id>
//   Upstash Redis   <FAKE_REDIS_URL>/pipeline (via ./harness.ts fakeUpstash)
//
// Each upstream has an independent FAULT SCRIPT (HTTP status, hang honouring
// the caller's abort signal, socket error, malformed 2xx body, per-command
// Redis errors, short/odd pipeline replies) so a test can break exactly one
// dependency and observe the user-visible verdict + recoverability.
//
// Every upstream call is recorded with the request it belongs to, so a test
// can count Supabase / Upstash round trips PER REQUEST (sequential requests
// only — concurrent requests are attributed to the "burst" they ran in).
//
// The Redis choice (configured or not) is fixed at first load per test
// module because cache.ts reads UPSTASH_* at import time.
//
// Deterministic: every campaign draws from `Prng(seed)`; the seed and the
// replay command are written into every JSON report (artifacts/stress-edge-
// ratelimit/<module>/<scenario>.json, override with STRESS_OUT_DIR).

import { FAKE_REDIS_URL, fakeUpstash, type FakeUpstash } from "./harness.ts";

// ─── deterministic RNG ───────────────────────────────────────────────────────

/** mulberry32 — small, fast, deterministic; enough for scenario shuffling. */
export class Prng {
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
  /** A child generator whose seed is derived from this one + a label. */
  fork(label: string): Prng {
    let h = this.seed ^ 0x9e3779b9;
    for (let i = 0; i < label.length; i += 1) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return new Prng(h >>> 0);
  }
  uuid(): string {
    const hex = () => this.int(16).toString(16);
    const seg = (n: number) => Array.from({ length: n }, hex).join("");
    return `${seg(8)}-${seg(4)}-4${seg(3)}-${"89ab"[this.int(4)]}${seg(3)}-${seg(12)}`;
  }
  ipv4(): string {
    // TEST-NET-2/3 + documentation ranges only; never a real client.
    const a = this.pick([198, 203, 192]);
    const b = a === 198 ? 51 : a === 203 ? 0 : 0;
    const c = a === 198 ? 100 : a === 203 ? 113 : 2;
    return `${a}.${b}.${c}.${this.int(256)}`;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Scale knob: campaigns default to the smallest size that still proves the
 * property in the suite; the evidence runs use STRESS_ITER >= 1000. */
export const STRESS_ITER = envInt("STRESS_ITER", 200);
export const STRESS_USERS = envInt("STRESS_USERS", 2_000);

// ─── fault scripts ───────────────────────────────────────────────────────────

export type Fault =
  | { kind: "ok" }
  /** Answer with this HTTP status (and optional body / headers). */
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  /** Never answer. Rejects with the caller's abort reason when it has a signal;
   * without one the call hangs until `releaseHangs()` (PostgREST via
   * supabase-js passes no signal). */
  | { kind: "hang" }
  /** Socket-level failure (fetch rejects with a TypeError). */
  | { kind: "net_error" }
  /** HTTP 200 with this exact body (default content-type application/json). */
  | { kind: "malformed"; body: string; contentType?: string }
  /** Upstash only: reply `{ error }` for every command whose name matches. */
  | { kind: "redis_command_error"; command: string; error: string }
  /** Upstash only: return only the first `keep` results (short reply). */
  | { kind: "redis_truncate"; keep: number }
  /** Upstash only: override the `result` of every command whose name matches. */
  | { kind: "redis_result"; command: string; result: unknown };

export interface UpstreamCall {
  upstream: Upstream;
  url: string;
  method: string;
  fault: Fault["kind"];
  /** Which handler invocation this call belonged to (see `track`). */
  requestTag: string | null;
  atMs: number;
}

export type Upstream = "auth" | "rest" | "rc" | "redis";
export const UPSTREAMS: readonly Upstream[] = ["auth", "rest", "rc", "redis"];

export type FaultSource = Fault | Fault[] | ((call: { index: number; url: string }) => Fault);

interface FaultScript {
  source: FaultSource;
  index: number;
}

export interface SessionTokenOptions {
  userId: string;
  sessionId?: string;
  expSeconds?: number;
  provider?: "google" | "apple";
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redis: FakeUpstash;
  calls: UpstreamCall[];
  /** Subscriber JSON RevenueCat returns (entitlements map). */
  subscriber: Record<string, unknown>;
  /** Rows for PostgREST table GETs, by table name. */
  tables: Record<string, unknown[]>;
  /** RPC results by function name (default: access_state → one free row). */
  rpcs: Record<string, unknown>;
  /** Users the fake Auth knows (any decodable session bearer is accepted;
   * this map lets a test override app_metadata for a user id). */
  users: Map<string, Record<string, unknown>>;
  fault(upstream: Upstream, source: FaultSource): void;
  clearFaults(): void;
  /** Release every hanging call that had no abort signal (answers 503). */
  releaseHangs(): void;
  /** Run `fn` with every upstream call attributed to `tag`. */
  track<T>(tag: string, fn: () => Promise<T>): Promise<T>;
  callsFor(tag: string): UpstreamCall[];
  reset(): void;
}

export const SUPABASE_URL = "http://supabase.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const WEBHOOK_SECRET = "stress-webhook-secret";
export const EDGE_BASE = "http://edge.test/functions/v1/api";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodePayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
  } catch {
    return null;
  }
}

/** A Supabase-issued access token as the app bears it after bootstrap. */
export function sessionToken(options: SessionTokenOptions): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: options.userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: options.sessionId ?? `sess-${options.userId}`,
      exp: options.expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
      app_metadata: { provider: options.provider ?? "google" },
    }),
  );
  return `${header}.${payload}.sig`;
}

export function providerIdToken(sub: string, issuer = "https://accounts.google.com"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: issuer, sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  return `${header}.${payload}.sig`;
}

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string | null;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== null) {
    headers.set(
      "Authorization",
      `Bearer ${options.token ?? sessionToken({ userId: DEFAULT_USER })}`,
    );
  }
  if (options.ip !== null && !headers.has("x-forwarded-for") && !headers.has("cf-connecting-ip")) {
    headers.set("x-forwarded-for", options.ip ?? "203.0.113.20");
  }
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`${EDGE_BASE}${path}`, { method, headers, body });
}

export function webhookRequest(
  event: Record<string, unknown>,
  options: { ip?: string; authorization?: string | null } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization =
    options.authorization === undefined ? WEBHOOK_SECRET : options.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  headers.set("x-forwarded-for", options.ip ?? "203.0.113.10");
  return new Request(`${EDGE_BASE}/webhooks/revenuecat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ api_version: "1.0", event }),
  });
}

export const DEFAULT_USER = "11111111-1111-4111-8111-111111111111";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

let harness: StressHarness | null = null;

/** `deno test` runs every file of the suite in ONE process, so environment
 * variables set here leak into later files (index.ts reads
 * `AUTH_UPSTREAM_TIMEOUT_MS` per call). Each stress module ends with
 * `registerStressEnvRestore()`, which puts back whatever was there before. */
const STRESS_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_WEBHOOK_AUTH",
  "REVENUECAT_SECRET_API_KEY",
  "APPLE_SIGN_IN_CLIENT_ID",
  "APPLE_SIGN_IN_TEAM_ID",
  "APPLE_SIGN_IN_KEY_ID",
  "APPLE_SIGN_IN_PRIVATE_KEY",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "AUTH_UPSTREAM_TIMEOUT_MS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
let envBefore: Map<string, string | undefined> | null = null;

function snapshotEnv(): void {
  if (envBefore) return;
  envBefore = new Map(STRESS_ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
}

export function restoreStressEnv(): void {
  if (!envBefore) return;
  for (const [key, value] of envBefore) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

/** Call once at the END of every stress test module (tests run in definition
 * order, and a failing earlier test does not skip this one). */
export function registerStressEnvRestore(module: string): void {
  Deno.test(`${module}: restore process env for the rest of the suite`, () => {
    restoreStressEnv();
  });
}

function applyStressEnv(options: { redis?: boolean; authTimeoutMs?: number }): void {
  snapshotEnv();
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  // Keep the Auth deadline short so hang/timeout cases stay fast; the real
  // default is 6 s (index.ts AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT).
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(options.authTimeoutMs ?? 400));
  if (options.redis ?? true) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", FAKE_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "stress-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
}

/** Boot the real edge function once per test module. The env is (re)applied
 * on every call because a previous module may have restored it. */
export async function loadStressHarness(
  options: { redis?: boolean; authTimeoutMs?: number } = {},
): Promise<StressHarness> {
  applyStressEnv(options);
  if (harness) {
    harness.reset();
    return harness;
  }

  const scripts: Record<Upstream, FaultScript> = {
    auth: { source: { kind: "ok" }, index: 0 },
    rest: { source: { kind: "ok" }, index: 0 },
    rc: { source: { kind: "ok" }, index: 0 },
    redis: { source: { kind: "ok" }, index: 0 },
  };
  const nextFault = (upstream: Upstream, url: string): Fault => {
    const script = scripts[upstream];
    const i = script.index;
    script.index += 1;
    const source = script.source;
    if (typeof source === "function") return source({ index: i, url });
    if (Array.isArray(source)) return source[Math.min(i, source.length - 1)] ?? { kind: "ok" };
    return source;
  };

  const hanging: Array<() => void> = [];
  let currentTag: string | null = null;

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redis: null as unknown as FakeUpstash,
    calls: [],
    subscriber: { entitlements: {} },
    tables: {},
    rpcs: { access_state: [{ premium: false, scored_count: 0, reserved_count: 0 }] },
    users: new Map(),
    fault(upstream, source) {
      scripts[upstream] = { source, index: 0 };
    },
    clearFaults() {
      for (const upstream of UPSTREAMS) scripts[upstream] = { source: { kind: "ok" }, index: 0 };
    },
    releaseHangs() {
      for (const release of hanging.splice(0)) release();
    },
    async track(tag, fn) {
      const previous = currentTag;
      currentTag = tag;
      try {
        return await fn();
      } finally {
        currentTag = previous;
      }
    },
    callsFor(tag) {
      return state.calls.filter((call) => call.requestTag === tag);
    },
    reset() {
      state.calls = [];
      state.subscriber = { entitlements: {} };
      state.tables = {};
      state.rpcs = { access_state: [{ premium: false, scored_count: 0, reserved_count: 0 }] };
      state.users.clear();
      state.clearFaults();
      state.releaseHangs();
      state.redis.store.clear();
      state.redis.commands.length = 0;
      state.redis.failStatus = null;
      state.redis.hang = false;
      state.redis.commandError = null;
      state.redis.truncateRepliesTo = null;
      state.redis.calls = 0;
    },
  };

  /** Apply a generic fault to a non-Redis upstream; null → serve normally. */
  const applyFault = async (fault: Fault, init?: RequestInit): Promise<Response | null> => {
    switch (fault.kind) {
      case "ok":
        return null;
      case "http":
        return new Response(fault.body ?? `upstream ${fault.status}`, {
          status: fault.status,
          headers: fault.headers ?? { "Content-Type": "text/plain" },
        });
      case "net_error":
        throw new TypeError("error sending request: connection reset by peer");
      case "malformed":
        return new Response(fault.body, {
          status: 200,
          headers: { "Content-Type": fault.contentType ?? "application/json" },
        });
      case "hang": {
        const signal = init?.signal;
        if (signal) {
          await new Promise<void>((_, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable");
        }
        await new Promise<void>((resolve) => hanging.push(resolve));
        return new Response("released hang", { status: 503 });
      }
      default:
        // Redis-only fault kinds are meaningless for HTTP upstreams: serve normally.
        return null;
    }
  };

  const userFor = (sub: string): Record<string, unknown> => ({
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: `${sub.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...(state.users.get(sub) ?? {}),
  });

  const sessionFor = (sub: string, tag: string) => ({
    access_token: sessionToken({ userId: sub, sessionId: `sess-${tag}-${sub}` }),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${tag}-${sub}`,
    user: userFor(sub),
  });

  const baseFetch = globalThis.fetch;
  const stubbedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const upstream: Upstream | null = url.startsWith(RC_URL)
      ? "rc"
      : url.startsWith(`${SUPABASE_URL}/auth/v1/`)
        ? "auth"
        : url.startsWith(`${SUPABASE_URL}/rest/v1/`)
          ? "rest"
          : null;
    if (!upstream) {
      return new Response(`unexpected fetch in stress harness: ${request.method} ${url}`, {
        status: 599,
      });
    }
    const fault = nextFault(upstream, url);
    state.calls.push({
      upstream,
      url,
      method: request.method,
      fault: fault.kind,
      requestTag: currentTag,
      atMs: performance.now(),
    });
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const injected = await applyFault(fault, init);
    if (injected) return injected;

    if (upstream === "rc") {
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber: state.subscriber });
    }
    if (upstream === "auth") {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/v1/user") {
        const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
        const payload = decodePayload(bearer);
        const sub = typeof payload?.sub === "string" ? payload.sub : null;
        if (!sub)
          return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
        return jsonResponse(200, userFor(sub));
      }
      if (pathname === "/auth/v1/token") {
        const grant = new URL(url).searchParams.get("grant_type");
        const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        if (grant === "refresh_token") {
          const refreshToken = String(payload.refresh_token ?? "");
          if (!refreshToken.startsWith("refresh-")) {
            return jsonResponse(400, {
              code: 400,
              error_code: "refresh_token_not_found",
              msg: "Invalid Refresh Token: Refresh Token Not Found",
            });
          }
          const sub = refreshToken.split("-").slice(2).join("-") || DEFAULT_USER;
          return jsonResponse(200, sessionFor(sub, "rotated"));
        }
        // id_token grant (bootstrap / transitional provider bearer)
        const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
        const sub = String(decodePayload(idToken)?.sub ?? DEFAULT_USER);
        return jsonResponse(200, sessionFor(sub, "minted"));
      }
      return jsonResponse(404, { msg: `fake auth: unhandled ${pathname}` });
    }
    // PostgREST
    const table = new URL(url).pathname.slice("/rest/v1/".length);
    if (table.startsWith("rpc/")) {
      const fn = table.slice("rpc/".length);
      if (!(fn in state.rpcs)) {
        return jsonResponse(404, { code: "PGRST202", message: `rpc ${fn} not stubbed` });
      }
      return jsonResponse(200, state.rpcs[fn]);
    }
    if (request.method === "GET") {
      const rows = state.tables[table] ?? [];
      if ((request.headers.get("accept") ?? "").includes("application/vnd.pgrst.object+json")) {
        if (rows.length === 0) {
          return jsonResponse(406, {
            code: "PGRST116",
            message: "0 rows",
            details: null,
            hint: null,
          });
        }
        return jsonResponse(200, rows[0]);
      }
      return jsonResponse(200, rows);
    }
    if (request.method === "POST" || request.method === "PATCH") {
      return new Response(null, { status: 201 });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 405 });
  }) as typeof fetch;

  globalThis.fetch = stubbedFetch;
  // fakeUpstash wraps the CURRENT globalThis.fetch and forwards non-Redis URLs.
  const redis = fakeUpstash();
  state.redis = redis;
  const redisFetch = globalThis.fetch;

  // Outer layer: Redis fault scripting on top of fakeUpstash's own knobs.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE_REDIS_URL)) return redisFetch(input, init);
    const fault = nextFault("redis", url);
    state.calls.push({
      upstream: "redis",
      url,
      method: "POST",
      fault: fault.kind,
      requestTag: currentTag,
      atMs: performance.now(),
    });
    switch (fault.kind) {
      case "ok":
        return redisFetch(input, init);
      case "http":
        return new Response(fault.body ?? "upstash error", { status: fault.status });
      case "net_error":
        throw new TypeError("error sending request: connection refused");
      case "malformed":
        return new Response(fault.body, {
          status: 200,
          headers: { "Content-Type": fault.contentType ?? "application/json" },
        });
      case "hang": {
        const signal = init?.signal;
        await new Promise<void>((_, reject) => {
          if (!signal) return hanging.push(() => reject(new Error("released")));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }
      case "redis_command_error": {
        // Let fakeUpstash skip the command (not execute-then-mask), so a
        // failed EXPIRE really leaves the key without a TTL.
        const previous = redis.commandError;
        redis.commandError = (cmd) =>
          String(cmd[0]).toUpperCase() === fault.command.toUpperCase() ? fault.error : null;
        try {
          return await redisFetch(input, init);
        } finally {
          redis.commandError = previous;
        }
      }
      case "redis_truncate":
      case "redis_result": {
        const commands = JSON.parse(String(init?.body ?? "[]")) as Array<Array<string | number>>;
        const real = await redisFetch(input, init);
        const results = (await real.json()) as Array<{ result?: unknown; error?: string }>;
        let shaped = results;
        if (fault.kind === "redis_result") {
          shaped = results.map((slot, i) =>
            String(commands[i]?.[0]).toUpperCase() === fault.command.toUpperCase()
              ? { result: fault.result }
              : slot,
          );
        } else {
          shaped = results.slice(0, fault.keep);
        }
        return jsonResponse(200, shaped);
      }
    }
  }) as typeof fetch;
  void baseFetch;

  const realServe = Deno.serve;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
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
  Deno.serve = realServe;
  harness = state;
  return state;
}

// ─── observations & reports ──────────────────────────────────────────────────

export interface ResponseView {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: number | null;
  rateLimitRemaining: number | null;
  requestId: string | null;
}

export async function view(response: Response): Promise<ResponseView> {
  const text = await response.text();
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(text);
    code = typeof parsed?.error?.code === "string" ? parsed.error.code : null;
    message = typeof parsed?.error?.message === "string" ? parsed.error.message : null;
  } catch {
    // non-JSON body (legal pages etc.)
  }
  const retryAfterRaw = response.headers.get("Retry-After");
  const remainingRaw = response.headers.get("RateLimit-Remaining");
  return {
    status: response.status,
    code,
    message,
    retryAfter: retryAfterRaw === null ? null : Number(retryAfterRaw),
    rateLimitRemaining: remainingRaw === null ? null : Number(remainingRaw),
    requestId: response.headers.get("x-request-id"),
  };
}

/** Live counter of one rate-limit scope for an id in the fake Redis (sum over
 * buckets — a campaign may straddle a window boundary). */
export function redisCount(redis: FakeUpstash, scope: string, id: string): number {
  let total = 0;
  for (const [key, entry] of redis.store) {
    if (key.startsWith(`rl:${scope}:`) && key.endsWith(`:${id}`)) {
      if (entry.expiresAtMs === null || entry.expiresAtMs > Date.now())
        total += Number(entry.value);
    }
  }
  return total;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(values: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: Number(mean.toFixed(3)),
  };
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function outDir(module: string): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  const base = env
    ? env.endsWith("/")
      ? env
      : `${env}/`
    : new URL("../../../../artifacts/stress-edge-ratelimit/", import.meta.url).pathname;
  return `${base}${module}/`;
}

export async function writeReport(module: string, name: string, report: unknown): Promise<string> {
  const dir = outDir(module);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function replayCommand(file: string, filter: string, seed = STRESS_SEED): string {
  return `cd supabase/functions/api/__wf__ && STRESS_SEED=${seed} STRESS_ITER=${STRESS_ITER} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

export function heapUsed(): number {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === "function") g();
  return Deno.memoryUsage().heapUsed;
}
