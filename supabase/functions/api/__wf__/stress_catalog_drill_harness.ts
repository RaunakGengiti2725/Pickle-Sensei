// stress-catalog-drill — failure-injection + load harness for the edge route
// GET /v1/catalog/drills/:slug (../index.ts, REAL handler in-process).
//
// Like routesHarness.ts the function boots with Deno.serve captured and every
// upstream stubbed at the fetch layer, but every upstream here is a small
// stateful MODEL with a programmable FAULT in front of it:
//
//   auth_user   GET  /auth/v1/user                (session bearer verification)
//   auth_token  POST /auth/v1/token?grant_type=…  (transitional provider-token exchange)
//   rest        GET  /rest/v1/user_saved_drills   (the route's one PostgREST read)
//   redis       POST <UPSTASH>/pipeline           (L2 cache + shared rate limits)
//   revenuecat  GET  https://api.revenuecat.com/… (never on this route — control)
//
// Faults: HTTP status + body, arbitrary JSON, malformed JSON, a thrown network
// error, an artificial delay, or a HANG that only ends when the caller's
// AbortSignal fires or the test releases it (`releaseHung`). Every upstream
// call is recorded with its latency so a test can count Supabase / Redis round
// trips per request. Seeded RNG (mulberry32) so every iteration replays.
//
// Own isolate per test file: cache.ts reads UPSTASH_* at import time, so the
// Redis-enabled and Redis-less variants must boot from different test files.
// The route's Postgres-backed variant (stress_catalog_drill_pg.test.ts) swaps
// the `rest` model for real SQL against a migrated postgres:16 via `restBackend`.

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "https://redis.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const REST_TABLE = "user_saved_drills";

/** Kept far below the production default (6 s) so hang cases stay cheap;
 * the handler reads AUTH_UPSTREAM_TIMEOUT_MS at call time. */
export const AUTH_TIMEOUT_MS = 400;

export type Upstream = "auth_user" | "auth_token" | "rest" | "redis" | "revenuecat";
export const UPSTREAMS: readonly Upstream[] = [
  "auth_user",
  "auth_token",
  "rest",
  "redis",
  "revenuecat",
];

export type Fault =
  | {
      kind: "http";
      status: number;
      body?: string;
      contentType?: string;
      headers?: Record<string, string>;
    }
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "malformed_json"; status?: number }
  | { kind: "throw"; message?: string }
  | { kind: "hang" }
  | { kind: "delay"; ms: number; then?: Fault };

export type FaultPlan = Partial<Record<Upstream, Fault>>;

export interface RecordedCall {
  upstream: Upstream | "other";
  url: string;
  method: string;
  /** Redis: the pipeline's command names; PostgREST: the query string. */
  detail: string;
  status: number | "throw" | "hang";
  durationMs: number;
  faulted: boolean;
  /** User the call was made for (bearer/provider-token owner); null for Redis/RC. */
  userId: string | null;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple" | "email";
}

export interface RunResult {
  status: number;
  code: string | null;
  message: string | null;
  body: unknown;
  bodyText: string;
  retryAfter: string | null;
  requestId: string | null;
  latencyMs: number;
  /** Upstream calls made while THIS request ran (sequential use only). */
  calls: RecordedCall[];
  roundTrips: Record<Upstream, number> & { supabase: number };
  /** True when the handler did not answer inside `deadlineMs`; the handler
   * promise is then parked in `pending` (await `drain()` before the test ends). */
  timedOut: boolean;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  faults: FaultPlan;
  calls: RecordedCall[];
  logs: string[];
  accessLog: Record<string, unknown>[];
  redis: Map<string, { value: string; expiresAtMs: number }>;
  redisConfigured: boolean;
  /** `${userId}|${slug}` rows the PostgREST model answers from (RLS by bearer). */
  saved: Set<string>;
  /** Optional real backend for the route's PostgREST read (Postgres tests). */
  restBackend: ((query: RestQuery) => Promise<Response>) | null;
  users: Map<string, FakeUser>;
  registerUser(user: FakeUser): void;
  /** A Supabase-shaped access token verified by the auth_user model. */
  mintSession(userId: string, ttlSeconds?: number): string;
  /** A Google ID token the auth_token model exchanges for `userId`. */
  providerToken(userId: string, provider?: "google" | "apple", ttlSeconds?: number): string;
  userOfBearer(bearer: string): FakeUser | null;
  /** Answer every hung upstream call (599) so blocked handlers finish. */
  releaseHung(): number;
  hungCount(): number;
  /** Handler promises that outlived their `run()` deadline. */
  pending: Promise<Response>[];
  /** Release hung upstreams and settle every parked handler promise. */
  drain(): Promise<number>;
  /** Runs the real handler; upstream calls are attributed by user so that
   * parked (still retrying) requests of OTHER users do not pollute the count. */
  run(request: Request, deadlineMs?: number): Promise<RunResult>;
  /** Clear faults, calls, logs, saved rows and Redis (users/sessions stay). */
  reset(): void;
  /** Put back the real fetch/console/env so later test files in the same
   * isolate see the process as it was; `loadStressHarness` re-installs. */
  restore(): void;
  /** Re-install fetch/console/env after a `restore()` (done by `loadStressHarness`). */
  install(): void;
}

export interface RestQuery {
  bearerUser: FakeUser | null;
  bearer: string;
  table: string;
  params: URLSearchParams;
  accept: string;
  method: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url(crypto.randomUUID())}`;
}

/** mulberry32 — deterministic, small; the seed alone replays an iteration. */
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
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  ip(): string {
    return `198.51.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
  string(length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_"): string {
    return Array.from({ length }, () => alphabet[this.int(0, alphabet.length - 1)]).join("");
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-catalog-drill/latest/", import.meta.url).pathname;
}

export async function writeArtifact(name: string, data: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
  };
}

export function userRequest(
  path: string,
  options: { token: string; ip?: string; method?: string; headers?: Record<string, string> },
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${options.token}`,
    "x-forwarded-for": options.ip ?? "203.0.113.77",
    ...options.headers,
  });
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

class HungCall {
  resolve!: (response: Response) => void;
  reject!: (error: unknown) => void;
  readonly promise: Promise<Response>;
  constructor() {
    this.promise = new Promise<Response>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const pgrstError = (status: number, code: string, message: string) =>
  jsonResponse(status, { code, message, details: null, hint: null });

let harness: StressHarness | null = null;

export async function loadStressHarness(options: { redis: boolean }): Promise<StressHarness> {
  if (harness) {
    if (harness.redisConfigured !== options.redis) {
      throw new Error(
        "stress harness already booted with a different Redis setting — use a separate test file",
      );
    }
    harness.install();
    harness.reset();
    return harness;
  }

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;
  const realError = console.error;
  const realWarn = console.warn;
  let restoreAccessLog: () => void = () => {};
  let installed = false;
  const env: Record<string, string | null> = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY: "stress-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "stress-service-role-key",
    REVENUECAT_WEBHOOK_AUTH: "stress-webhook-secret",
    REVENUECAT_SECRET_API_KEY: "sk_test_stress",
    AUTH_UPSTREAM_TIMEOUT_MS: String(AUTH_TIMEOUT_MS),
    UPSTASH_REDIS_REST_URL: options.redis ? REDIS_URL : null,
    UPSTASH_REDIS_REST_TOKEN: options.redis ? "stress-redis-token" : null,
  };
  const savedEnv = new Map<string, string | undefined>();
  const applyEnv = (name: string, value: string | null | undefined) => {
    if (value === null || value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  };
  let stressFetch: typeof fetch = realFetch;
  const install = () => {
    if (installed) return;
    installed = true;
    for (const [name, value] of Object.entries(env)) {
      savedEnv.set(name, Deno.env.get(name));
      applyEnv(name, value);
    }
    globalThis.fetch = stressFetch;
    console.error = (...args: unknown[]) => pushLog(`error: ${args.map(String).join(" ")}`);
    console.warn = (...args: unknown[]) => pushLog(`warn: ${args.map(String).join(" ")}`);
    restoreAccessLog = captureAccessLog((line) => {
      if (state.accessLog.length < LOG_CAP) state.accessLog.push(JSON.parse(line));
    });
  };
  const LOG_CAP = 5_000;
  const hung: HungCall[] = [];
  const sessions = new Map<string, string>(); // access token → user id
  const providerTokens = new Map<string, string>(); // provider id token → user id

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    faults: {},
    calls: [],
    logs: [],
    accessLog: [],
    redis: new Map(),
    redisConfigured: options.redis,
    saved: new Set(),
    restBackend: null,
    users: new Map(),
    registerUser(user) {
      state.users.set(user.id, user);
    },
    mintSession(userId, ttlSeconds = 3600) {
      if (!state.users.has(userId)) {
        state.registerUser({ id: userId, email: `${userId}@example.com`, provider: "google" });
      }
      const token = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      sessions.set(token, userId);
      return token;
    },
    providerToken(userId, provider = "google", ttlSeconds = 3600) {
      if (!state.users.has(userId)) {
        state.registerUser({ id: userId, email: `${userId}@example.com`, provider });
      }
      const token = fakeJwt({
        iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
        sub: `${provider}-subject-${userId}`,
        aud: "com.picklesensei",
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      providerTokens.set(token, userId);
      return token;
    },
    userOfBearer(bearer) {
      const userId = sessions.get(bearer);
      return userId ? (state.users.get(userId) ?? null) : null;
    },
    releaseHung() {
      const n = hung.length;
      for (const call of hung.splice(0)) {
        call.resolve(new Response("released by test", { status: 599 }));
      }
      return n;
    },
    hungCount: () => hung.length,
    pending: [],
    async drain() {
      state.releaseHung();
      const parked = state.pending.splice(0);
      const settled = await Promise.allSettled(parked);
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") await outcome.value.body?.cancel();
      }
      return parked.length;
    },
    async run(request, deadlineMs = 2_000) {
      const before = state.calls.length;
      const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      const requestUser = sessions.get(bearer) ?? providerTokens.get(bearer) ?? null;
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
      });
      const handled = state.handler(request);
      const answer = await Promise.race([handled, deadline]);
      clearTimeout(timer);
      const latencyMs = performance.now() - startedAt;
      const calls = state.calls
        .slice(before)
        .filter((call) => call.userId === null || call.userId === requestUser);
      if (answer === "timeout") state.pending.push(handled);
      const roundTrips = { supabase: 0 } as RunResult["roundTrips"];
      for (const upstream of UPSTREAMS) roundTrips[upstream] = 0;
      for (const call of calls) {
        if (call.upstream === "other") continue;
        roundTrips[call.upstream] += 1;
        if (
          call.upstream === "auth_user" ||
          call.upstream === "auth_token" ||
          call.upstream === "rest"
        ) {
          roundTrips.supabase += 1;
        }
      }
      if (answer === "timeout") {
        return {
          status: 0,
          code: null,
          message: null,
          body: null,
          bodyText: "",
          retryAfter: null,
          requestId: null,
          latencyMs,
          calls,
          roundTrips,
          timedOut: true,
        };
      }
      const bodyText = await answer.text();
      let body: unknown = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      return {
        status: answer.status,
        code: typeof error?.code === "string" ? error.code : null,
        message: typeof error?.message === "string" ? error.message : null,
        body,
        bodyText,
        retryAfter: answer.headers.get("Retry-After"),
        requestId: answer.headers.get("x-request-id"),
        latencyMs,
        calls,
        roundTrips,
        timedOut: false,
      };
    },
    reset() {
      state.faults = {};
      state.calls = [];
      state.logs = [];
      state.accessLog = [];
      state.redis.clear();
      state.saved.clear();
      state.restBackend = null;
      state.releaseHung();
      state.pending = [];
    },
    install() {
      install();
    },
    restore() {
      if (!installed) return;
      installed = false;
      globalThis.fetch = realFetch;
      Deno.serve = realServe;
      console.error = realError;
      console.warn = realWarn;
      restoreAccessLog();
      for (const [name, value] of savedEnv) applyEnv(name, value);
      savedEnv.clear();
    },
  };

  const pushLog = (line: string) => {
    if (state.logs.length < LOG_CAP) state.logs.push(line);
  };

  // ── Upstream models ────────────────────────────────────────────────────────

  const redisExec = (command: Array<string | number>): { result?: unknown; error?: string } => {
    const now = Date.now();
    const [name, ...args] = command.map(String);
    const live = (key: string) => {
      const entry = state.redis.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= now) {
        state.redis.delete(key);
        return null;
      }
      return entry;
    };
    switch (name.toUpperCase()) {
      case "GET":
        return { result: live(args[0])?.value ?? null };
      case "SET": {
        const exIndex = args.findIndex((a) => a.toUpperCase() === "EX");
        const ttl = exIndex >= 0 ? Number(args[exIndex + 1]) : 10 * 365 * 86_400;
        state.redis.set(args[0], { value: args[1], expiresAtMs: now + ttl * 1_000 });
        return { result: "OK" };
      }
      case "TTL": {
        const entry = live(args[0]);
        if (!entry) return { result: -2 };
        return { result: Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1_000)) };
      }
      case "INCR": {
        const entry = live(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        state.redis.set(args[0], {
          value: String(next),
          expiresAtMs: entry ? entry.expiresAtMs : now + 10 * 365 * 86_400_000,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = live(args[0]);
        if (!entry) return { result: 0 };
        const nx = args.some((a) => a.toUpperCase() === "NX");
        const hasTtl = entry.expiresAtMs < now + 5 * 365 * 86_400_000;
        if (nx && hasTtl) return { result: 0 };
        entry.expiresAtMs = now + Number(args[1]) * 1_000;
        return { result: 1 };
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) if (state.redis.delete(key)) removed += 1;
        return { result: removed };
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  };

  const authUserModel = (request: Request): Response => {
    const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const user = state.userOfBearer(bearer);
    if (!user)
      return jsonResponse(401, {
        code: 401,
        msg: "invalid JWT: unable to parse or verify signature",
      });
    return jsonResponse(200, {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    });
  };

  const parseTokenGrant = async (
    request: Request,
  ): Promise<{ idToken: string; userId: string | null }> => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await request.text());
      if (isRecord(parsed)) payload = parsed;
    } catch {
      // empty body → invalid grant below
    }
    const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
    const userId = providerTokens.get(idToken);
    return { idToken, userId: userId ?? null };
  };

  const authTokenModel = (userId: string | null): Response => {
    if (!userId) {
      return jsonResponse(400, { error: "invalid_grant", error_description: "Bad ID token" });
    }
    const user = state.users.get(userId)!;
    const accessToken = state.mintSession(userId);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return jsonResponse(200, {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: `rt-${crypto.randomUUID()}`,
      user: {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: { provider: user.provider, providers: [user.provider] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    });
  };

  const restModel = async (request: Request, url: URL): Promise<Response> => {
    const table = url.pathname.slice("/rest/v1/".length);
    const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const query: RestQuery = {
      bearer,
      bearerUser: state.userOfBearer(bearer),
      table,
      params: url.searchParams,
      accept: request.headers.get("Accept") ?? "",
      method: request.method,
    };
    if (state.restBackend) return await state.restBackend(query);
    if (table !== REST_TABLE || request.method !== "GET") {
      return pgrstError(
        404,
        "PGRST205",
        `Could not find the table 'public.${table}' in the schema cache`,
      );
    }
    if (!query.bearerUser) return pgrstError(401, "PGRST301", "JWT expired");
    const filters: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams) {
      if (key === "select") continue;
      if (!value.startsWith("eq."))
        return pgrstError(400, "PGRST100", `unsupported filter ${key}=${value}`);
      filters.push([key, value.slice("eq.".length)]);
    }
    // RLS: rows visible only to their owner (auth.uid() = user_id).
    const rows: Array<{ slug: string }> = [];
    for (const key of state.saved) {
      const [owner, slug] = key.split("|", 2);
      if (owner !== query.bearerUser.id) continue;
      const row: Record<string, string> = { user_id: owner, slug };
      if (filters.every(([column, expected]) => row[column] === expected)) rows.push({ slug });
    }
    if (query.accept.includes("application/vnd.pgrst.object+json")) {
      if (rows.length === 0)
        return pgrstError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
      if (rows.length > 1)
        return pgrstError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
      return jsonResponse(200, rows[0]);
    }
    return jsonResponse(200, rows);
  };

  const applyFault = async (
    fault: Fault,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> => {
    switch (fault.kind) {
      case "http":
        return new Response(fault.body ?? "", {
          status: fault.status,
          headers: { "Content-Type": fault.contentType ?? "text/plain", ...fault.headers },
        });
      case "json":
        return jsonResponse(fault.status, fault.body, fault.headers);
      case "malformed_json":
        return new Response('{"this is": not json', {
          status: fault.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      case "throw":
        throw new TypeError(fault.message ?? "error sending request: connection reset by peer");
      case "hang": {
        const call = new HungCall();
        hung.push(call);
        if (signal) {
          if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
          signal.addEventListener(
            "abort",
            () => {
              const index = hung.indexOf(call);
              if (index >= 0) hung.splice(index, 1);
              call.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }
        return await call.promise;
      }
      case "delay": {
        await new Promise<void>((resolve) => setTimeout(resolve, fault.ms));
        if (fault.then) return await applyFault(fault.then, signal);
        throw new Error("delay fault needs a `then` when used as a terminal fault");
      }
    }
  };

  stressFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const signal = init?.signal ?? request.signal;
    let upstream: Upstream | "other" = "other";
    const detail = "";
    if (url.href.startsWith(RC_URL)) upstream = "revenuecat";
    else if (url.href.startsWith(`${REDIS_URL}/pipeline`)) upstream = "redis";
    else if (url.href.startsWith(`${SUPABASE_URL}/auth/v1/user`)) upstream = "auth_user";
    else if (url.href.startsWith(`${SUPABASE_URL}/auth/v1/token`)) upstream = "auth_token";
    else if (url.href.startsWith(`${SUPABASE_URL}/rest/v1/`)) upstream = "rest";

    const startedAt = performance.now();
    const record: RecordedCall = {
      upstream,
      url: url.href,
      method: request.method,
      detail,
      status: 0,
      durationMs: 0,
      faulted: false,
      userId: null,
    };
    const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    if (upstream === "auth_user" || upstream === "rest")
      record.userId = sessions.get(bearer) ?? null;
    if (upstream === "auth_token") {
      record.userId = (await parseTokenGrant(request.clone())).userId;
    }
    state.calls.push(record);
    const finish = (response: Response): Response => {
      record.status = response.status;
      record.durationMs = performance.now() - startedAt;
      return response;
    };
    try {
      if (upstream === "other") {
        return finish(
          new Response(`unexpected fetch in stress test: ${request.method} ${url.href}`, {
            status: 599,
          }),
        );
      }
      const fault = state.faults[upstream];
      if (upstream === "redis") {
        const text = await request.clone().text();
        try {
          const commands = JSON.parse(text) as Array<Array<string | number>>;
          record.detail = commands.map((c) => String(c[0]).toUpperCase()).join(",");
          if (fault) {
            record.faulted = true;
            return finish(await applyFault(fault, signal));
          }
          return finish(jsonResponse(200, commands.map(redisExec)));
        } catch (error) {
          if (error instanceof SyntaxError)
            return finish(new Response("bad pipeline", { status: 400 }));
          throw error;
        }
      }
      if (upstream === "rest") record.detail = url.search;
      if (fault) {
        record.faulted = true;
        if (fault.kind !== "delay" || fault.then) return finish(await applyFault(fault, signal));
        await new Promise<void>((resolve) => setTimeout(resolve, fault.ms));
      }
      switch (upstream) {
        case "revenuecat":
          return finish(jsonResponse(200, { request_date_ms: Date.now(), subscriber: {} }));
        case "auth_user":
          return finish(authUserModel(request));
        case "auth_token":
          return finish(authTokenModel(record.userId));
        case "rest":
          return finish(await restModel(request, url));
      }
    } catch (error) {
      record.status = error instanceof DOMException ? "hang" : "throw";
      record.durationMs = performance.now() - startedAt;
      throw error;
    }
  }) as typeof fetch;

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

  install();
  await import("../index.ts");
  Deno.serve = realServe;
  harness = state;
  return state;
}
