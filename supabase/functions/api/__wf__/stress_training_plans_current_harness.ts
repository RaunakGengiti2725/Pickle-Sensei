// Failure-injection + load harness for the edge route
// `GET /v1/training-plans/current` (supabase/functions/api/index.ts).
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, exactly like
// routesHarness.ts / sessionHarness.ts) behind ONE fake `fetch` that models
// every upstream the request path can touch:
//
//   auth   — Supabase Auth (GoTrue) GET /auth/v1/user + the transitional
//            POST /auth/v1/token?grant_type=id_token exchange
//   rest   — PostgREST (/rest/v1/…) — the route never calls it; the fake
//            proves that by recording every call
//   redis  — Upstash REST /pipeline (auth cache L2 + shared rate limits)
//   rc     — RevenueCat subscriber reads — the route never calls it
//
// Each upstream can be told, per edge request, to fail with an HTTP status,
// throw at the socket level, hang until the caller's deadline, answer slowly,
// or answer with a malformed/transformed body. Upstream calls are attributed
// to the edge request that caused them through AsyncLocalStorage, so the
// Supabase round-trip count per request is exact even under concurrency.
//
// Nothing here touches a network: the only fetch that exists is the fake.

import { AsyncLocalStorage } from "node:async_hooks";
import { type AccessLogEntry, captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const RC_PREFIX = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "anon-stress-key";
export const ROUTE_PATH = "/v1/training-plans/current";

// ── Seeded randomness ────────────────────────────────────────────────────────

/** mulberry32: tiny, deterministic, good enough for scenario shaping. */
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
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out;
  }
  /** RFC 4122 v4-shaped id (matches the function's UUID_RE). */
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = "89ab"[this.int(0, 3)];
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${
      s.slice(16, 20)
    }-${s.slice(20)}`;
  }
  ip(): string {
    return `${this.int(1, 223)}.${this.int(0, 255)}.${this.int(0, 255)}.${
      this.int(1, 254)
    }`;
  }
}

/** FNV-1a over `${master}:${label}:${iteration}` — a stable per-iteration seed. */
export function seedFor(
  master: number,
  label: string,
  iteration: number,
): number {
  const text = `${master}:${label}:${iteration}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencyStats(values: number[]): {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.length ? sum / sorted.length : 0),
  };
}

// ── Fault model ──────────────────────────────────────────────────────────────

export type UpstreamName = "auth" | "rest" | "redis" | "rc";

export type RedisReply = { result?: unknown; error?: string };

export interface FaultSpec {
  mode: "http" | "throw" | "hang" | "slow" | "reply";
  /** `http`/`slow`: status of the injected answer (slow defaults to the healthy answer). */
  status?: number;
  /** `http`/`slow`: raw text body when a string, JSON otherwise. */
  body?: unknown;
  headers?: Record<string, string>;
  /** `slow`: added latency; `hang`: how long a signal-less caller waits
   * before the fake gives up on its behalf (a caller WITH a deadline is
   * released by its own abort signal, which is the point of the mode). */
  delayMs?: number;
  /** Restrict the fault to some attempts (0-based, per upstream, per edge
   * request). Default: every attempt. */
  attempts?: (attempt: number) => boolean;
  /** Restrict the fault to calls whose parsed request body matches (redis:
   * the pipeline command list). Default: every call. */
  when?: (body: unknown) => boolean;
  /** `reply` (redis): rewrite one slot of the healthy pipeline reply. Return
   * undefined to keep the healthy slot. */
  reply?: (
    command: Array<string | number>,
    index: number,
    healthy: RedisReply,
  ) => RedisReply | undefined;
  /** `reply` (redis): rewrite the whole reply body (truncate, wrap, …). */
  transform?: (replies: RedisReply[]) => unknown;
}

export type Faults = Partial<Record<UpstreamName, FaultSpec>>;

export interface UpstreamCall {
  t: number;
  tag: string | null;
  upstream: UpstreamName | "unknown";
  method: string;
  url: string;
  attempt: number;
  /** How the fake answered: `http:<status>`, `throw`, `hang`, `slow:<status>`, `reply`. */
  outcome: string;
}

export interface FakeUser {
  id: string;
  email: string;
  /** GoTrue app_metadata.provider (google | apple | email …). */
  provider: string;
  /** Extra linked providers (app_metadata.providers). */
  providers?: string[];
}

export interface FakeSession {
  userId: string;
  accessToken: string;
  expiresAt: number;
  revoked: boolean;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface RunResult {
  status: number;
  body: unknown;
  text: string;
  headers: Record<string, string>;
  requestId: string;
  durationMs: number;
  calls: Record<UpstreamName, number> & { supabase: number; total: number };
  accessLog: AccessLogEntry | null;
  /** console.error / console.warn lines the function emitted during this request. */
  operatorLog: string[];
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisConfigured: boolean;
  /** Mutable: the fault plan every upstream consults on its next call. */
  faults: Faults;
  calls: UpstreamCall[];
  redis: Map<string, FakeRedisEntry>;
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  /** When true GET /auth/v1/user accepts ANY Supabase-shaped bearer whose
   * `sub` is a registered-or-not uuid (memory sweeps mint nothing). */
  statelessAuth: boolean;
  registerUser(user: FakeUser): void;
  mintSession(
    userId: string,
    ttlSeconds: number,
    sessionId?: string,
  ): FakeSession;
  /** Supabase-shaped access token nobody minted (right issuer, unknown session). */
  forgedToken(userId: string, ttlSeconds: number): string;
  /** A Google/Apple ID token (the transitional bearer kind). */
  providerToken(
    provider: "google" | "apple",
    sub: string,
    ttlSeconds: number,
  ): string;
  request(options: RequestOptions): Request;
  /** Run one edge request; every upstream call it causes is attributed to it. */
  run(request: Request): Promise<RunResult>;
  /** Forget recorded calls, logs, the fake Redis store, sessions and faults.
   * The function's L1 caches live on (they are per-isolate state). */
  reset(): void;
  accessLog: AccessLogEntry[];
  operatorLog: Array<{ tag: string | null; line: string }>;
}

export interface RequestOptions {
  method?: string;
  path?: string;
  token?: string | null;
  ip?: string;
  headers?: Record<string, string>;
  body?: string;
  /** URL prefix the gateway may present. */
  mount?: "/functions/v1/api" | "/api" | "";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${
    b64url(crypto.randomUUID())
  }`;
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const raw = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(
      /_/g,
      "/",
    );
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gotrueUser(user: FakeUser): Record<string, unknown> {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: {
      provider: user.provider,
      providers: user.providers ?? [user.provider],
    },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const authError = (status: number, code: string, msg: string): Response =>
  jsonResponse(status, { code: status, error_code: code, msg });

function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

/** Never answers on its own; the caller's abort signal releases it. A caller
 * without a signal is released after `fallbackMs` with a 599 so a test can
 * never wedge. */
function hangUntilAbort(
  signal: AbortSignal | null | undefined,
  fallbackMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(
        new Response("stress: hang fallback (caller had no deadline)", {
          status: 599,
        }),
      );
    }, fallbackMs);
    signal?.addEventListener("abort", onAbort);
  });
}

function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

function bodyOf(spec: FaultSpec): BodyInit | null {
  if (spec.body === undefined) return null;
  return typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
}

function headersOf(spec: FaultSpec): Record<string, string> {
  const headers: Record<string, string> = {};
  if (spec.body !== undefined && typeof spec.body !== "string") {
    headers["Content-Type"] = "application/json";
  }
  return { ...headers, ...(spec.headers ?? {}) };
}

// ── Loading the real handler ─────────────────────────────────────────────────

const requestContext = new AsyncLocalStorage<{
  tag: string;
  attempts: Map<UpstreamName, number>;
  operatorLog: string[];
}>();

let harness: StressHarness | null = null;

export async function loadStressHarness(
  options: { redis: boolean },
): Promise<StressHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  for (
    const name of [
      "APPLE_SIGN_IN_CLIENT_ID",
      "APPLE_SIGN_IN_TEAM_ID",
      "APPLE_SIGN_IN_KEY_ID",
      "APPLE_SIGN_IN_PRIVATE_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY",
      "SB_PUBLISHABLE_KEY",
    ]
  ) {
    Deno.env.delete(name);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const t0 = performance.now();
  let ipCounter = 0;

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisConfigured: options.redis,
    faults: {},
    calls: [],
    redis: new Map(),
    users: new Map(),
    sessions: new Map(),
    statelessAuth: false,
    accessLog: [],
    operatorLog: [],
    registerUser(user) {
      state.users.set(user.id, user);
    },
    mintSession(userId, ttlSeconds, sessionId) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId ?? crypto.randomUUID(),
        exp: expiresAt,
      });
      const session: FakeSession = {
        userId,
        accessToken,
        expiresAt,
        revoked: false,
      };
      state.sessions.set(accessToken, session);
      return session;
    },
    forgedToken(userId, ttlSeconds) {
      return fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },
    providerToken(provider, sub, ttlSeconds) {
      return fakeJwt({
        iss: provider === "google"
          ? "https://accounts.google.com"
          : "https://appleid.apple.com",
        sub,
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },
    request(opts) {
      ipCounter += 1;
      const headers = new Headers({
        "x-forwarded-for": opts.ip ??
          `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`,
        ...(opts.headers ?? {}),
      });
      if (opts.token !== null && opts.token !== undefined) {
        headers.set("Authorization", `Bearer ${opts.token}`);
      }
      if (opts.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      const mount = opts.mount ?? "/functions/v1/api";
      return new Request(
        `http://edge.stress.test${mount}${opts.path ?? ROUTE_PATH}`,
        {
          method: opts.method ?? "GET",
          headers,
          body: opts.body,
        },
      );
    },
    async run(request) {
      const tag = crypto.randomUUID();
      const context = {
        tag,
        attempts: new Map<UpstreamName, number>(),
        operatorLog: [] as string[],
      };
      const before = state.calls.length;
      const startedAt = performance.now();
      const response = await requestContext.run(
        context,
        () => state.handler(request),
      );
      const text = await response.text();
      const durationMs = Math.round((performance.now() - startedAt) * 100) /
        100;
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON body stays as text
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((
        value,
        key,
      ) => (headers[key.toLowerCase()] = value));
      const mine = state.calls.slice(before).filter((call) => call.tag === tag);
      const count = (name: UpstreamName) =>
        mine.filter((call) => call.upstream === name).length;
      const calls = {
        auth: count("auth"),
        rest: count("rest"),
        redis: count("redis"),
        rc: count("rc"),
        supabase: count("auth") + count("rest"),
        total: mine.length,
      };
      const requestId = headers["x-request-id"] ?? "";
      const accessLog =
        state.accessLog.find((entry) => entry.requestId === requestId) ?? null;
      return {
        status: response.status,
        body,
        text,
        headers,
        requestId,
        durationMs,
        calls,
        accessLog,
        operatorLog: context.operatorLog,
      };
    },
    reset() {
      state.faults = {};
      state.calls = [];
      state.redis = new Map();
      state.users = new Map();
      state.sessions = new Map();
      state.statelessAuth = false;
      state.accessLog = [];
      state.operatorLog = [];
    },
  };

  captureAccessLog((line) => {
    try {
      state.accessLog.push(JSON.parse(line) as AccessLogEntry);
    } catch {
      // never a non-JSON line by contract; keep going
    }
  });
  const forward = (line: string) => {
    const context = requestContext.getStore();
    context?.operatorLog.push(line);
    state.operatorLog.push({ tag: context?.tag ?? null, line });
  };
  const render = (args: unknown[]) =>
    args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
  console.error = (...args: unknown[]) => forward(render(args));
  console.warn = (...args: unknown[]) => forward(render(args));

  function redisLive(key: string): FakeRedisEntry | null {
    const entry = state.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      state.redis.delete(key);
      return null;
    }
    return entry;
  }

  function runRedisCommand(command: Array<string | number>): RedisReply {
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: redisLive(args[0])?.value ?? null };
      case "TTL": {
        const entry = redisLive(args[0]);
        if (!entry) return { result: -2 };
        if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
        return {
          result: Math.max(
            1,
            Math.ceil((entry.expiresAtMs - Date.now()) / 1000),
          ),
        };
      }
      case "SET": {
        const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
        state.redis.set(args[0], {
          value: args[1],
          expiresAtMs: Number.isFinite(ttl)
            ? Date.now() + ttl * 1000
            : Infinity,
        });
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) if (state.redis.delete(key)) removed += 1;
        return { result: removed };
      }
      case "INCR": {
        const entry = redisLive(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        state.redis.set(args[0], {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? Infinity,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = redisLive(args[0]);
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

  function upstreamOf(url: URL): UpstreamName | "unknown" {
    if (url.href.startsWith(RC_PREFIX)) return "rc";
    if (url.href === `${REDIS_URL}/pipeline`) return "redis";
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      return "auth";
    }
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      return "rest";
    }
    return "unknown";
  }

  function healthyAnswer(
    upstream: UpstreamName,
    request: Request,
    url: URL,
    body: unknown,
  ): Response {
    if (upstream === "rc") {
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: { entitlements: {} },
      });
    }
    if (upstream === "redis") {
      if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(200, commands.map(runRedisCommand));
    }
    if (upstream === "rest") {
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        return jsonResponse(406, {
          code: "PGRST116",
          message: "0 rows",
          details: null,
          hint: null,
        });
      }
      return jsonResponse(200, []);
    }
    // auth
    const path = url.pathname.slice("/auth/v1/".length);
    if (path === "user" && request.method === "GET") {
      const bearer = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (state.statelessAuth) {
        const sub = jwtPayload(bearer)?.sub;
        if (typeof sub !== "string" || !sub) {
          return authError(
            401,
            "bad_jwt",
            "invalid JWT: unable to parse or verify signature",
          );
        }
        const user = state.users.get(sub) ?? {
          id: sub,
          email: `${sub.slice(0, 8)}@example.com`,
          provider: "google",
        };
        return jsonResponse(200, gotrueUser(user));
      }
      const session = state.sessions.get(bearer);
      if (!session) {
        return authError(401, "bad_jwt", "invalid JWT: session not found");
      }
      if (session.revoked) {
        return authError(
          403,
          "session_not_found",
          "Session from session_id claim in JWT does not exist",
        );
      }
      if (session.expiresAt * 1000 <= Date.now()) {
        return authError(401, "bad_jwt", "invalid JWT: token is expired");
      }
      const user = state.users.get(session.userId);
      if (!user) {
        return authError(
          403,
          "user_not_found",
          "User from sub claim in JWT does not exist",
        );
      }
      return jsonResponse(200, gotrueUser(user));
    }
    if (path === "token" && request.method === "POST") {
      const grant = url.searchParams.get("grant_type");
      const payload = isRecord(body) ? body : {};
      if (grant === "id_token") {
        const idToken = typeof payload.id_token === "string"
          ? payload.id_token
          : "";
        const sub = jwtPayload(idToken)?.sub;
        const user = typeof sub === "string" ? state.users.get(sub) : undefined;
        if (!user || user.provider !== payload.provider) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        const session = state.mintSession(user.id, 3600);
        return jsonResponse(200, {
          access_token: session.accessToken,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: session.expiresAt,
          refresh_token: `rt-${crypto.randomUUID()}`,
          user: gotrueUser(user),
        });
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    return jsonResponse(404, {
      msg: `stress harness: unmodelled auth path ${path}`,
    });
  }

  async function answer(
    upstream: UpstreamName,
    request: Request,
    url: URL,
    body: unknown,
    attempt: number,
  ): Promise<{ response: Response; outcome: string }> {
    const spec = state.faults[upstream];
    const applies = spec !== undefined &&
      (spec.attempts === undefined || spec.attempts(attempt)) &&
      (spec.when === undefined || spec.when(body));
    if (!spec || !applies) {
      const response = healthyAnswer(upstream, request, url, body);
      return { response, outcome: `healthy:${response.status}` };
    }
    switch (spec.mode) {
      case "throw":
        throw new TypeError(
          "stress: error sending request: connection reset by peer",
        );
      case "hang": {
        const response = await hangUntilAbort(
          request.signal,
          spec.delayMs ?? 2_500,
        );
        return { response, outcome: "hang-fallback" };
      }
      case "slow": {
        await sleepUnlessAborted(spec.delayMs ?? 250, request.signal);
        if (spec.status === undefined) {
          const response = healthyAnswer(upstream, request, url, body);
          return { response, outcome: `slow:${response.status}` };
        }
        return {
          response: new Response(bodyOf(spec), {
            status: spec.status,
            headers: headersOf(spec),
          }),
          outcome: `slow:${spec.status}`,
        };
      }
      case "http":
        return {
          response: new Response(bodyOf(spec), {
            status: spec.status ?? 500,
            headers: headersOf(spec),
          }),
          outcome: `http:${spec.status ?? 500}`,
        };
      case "reply": {
        const commands = Array.isArray(body)
          ? (body as Array<Array<string | number>>)
          : [];
        const replies = commands.map((command, index) => {
          const healthy = runRedisCommand(command);
          return spec.reply?.(command, index, healthy) ?? healthy;
        });
        const payload = spec.transform ? spec.transform(replies) : replies;
        return {
          response: typeof payload === "string"
            ? new Response(payload, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
            : jsonResponse(200, payload),
          outcome: "reply",
        };
      }
    }
  }

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const upstream = upstreamOf(url);
    const context = requestContext.getStore();
    const attempt = upstream === "unknown"
      ? 0
      : (context?.attempts.get(upstream) ?? 0);
    if (upstream !== "unknown") context?.attempts.set(upstream, attempt + 1);
    const call: UpstreamCall = {
      t: Math.round((performance.now() - t0) * 100) / 100,
      tag: context?.tag ?? null,
      upstream,
      method: request.method,
      url: request.url,
      attempt,
      outcome: "",
    };
    state.calls.push(call);
    if (upstream === "unknown") {
      call.outcome = "unexpected";
      return new Response(
        `stress harness: unexpected fetch ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    try {
      const { response, outcome } = await answer(
        upstream,
        request,
        url,
        body,
        attempt,
      );
      call.outcome = outcome;
      return response;
    } catch (error) {
      call.outcome =
        error instanceof DOMException && error.name === "AbortError"
          ? "aborted"
          : "throw";
      throw error;
    }
  }) as typeof fetch;

  const realServe = Deno.serve;
  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
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

  await import("../index.ts");
  Deno.serve = realServe;
  harness = state;
  return state;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-get-v1-training-plans-current/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}
