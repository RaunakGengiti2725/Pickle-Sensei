// stress: POST /v1/sessions/:id/finalize (the "end session" route) — shared
// fault-injection + load harness.
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, globalThis.fetch
// replaced) in front of a programmable upstream model:
//
//   Supabase Auth   GET /auth/v1/user               (bearer → user)
//   PostgREST       GET|PATCH /rest/v1/sessions      (RLS by bearer sub)
//   Upstash Redis   POST <REDIS_URL>/pipeline        (only when the isolate
//                                                     was booted with redis)
//   RevenueCat      GET api.revenuecat.com/…         (recorded; the route
//                                                     must never reach it)
//
// Every upstream call is classified and can be faulted INDIVIDUALLY by a
// per-kind script (nth call → action): HTTP status, malformed body, socket
// failure, hang (honouring the caller's AbortSignal), or delay. Calls are
// attributed to the edge request that caused them via AsyncLocalStorage, so
// the per-request upstream round-trip count is exact even under concurrency.
//
// Deterministic: every id/token comes from a mulberry32 Prng seeded from
// STRESS_SEED (default 20260905); a failing scenario replays from its seed.
// Slow campaigns scale with STRESS_ITER / STRESS_USERS (small defaults keep
// the file inside `deno task test`).
//
// New file — never touches production code or existing tests.

import { AsyncLocalStorage } from "node:async_hooks";
import { b64url, envInt, isRecord, jwtPayload, Prng } from "./xc_concurrency_harness.ts";

export { envInt, isRecord, Prng };

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "https://redis.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const ANON_KEY = "stress-anon-key";
export const RC_HOST = "https://api.revenuecat.com";

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 1_000);
export const STRESS_USERS = envInt("STRESS_USERS", 2_000);

// ── Upstream call model ──────────────────────────────────────────────────────

export type UpstreamKind =
  | "auth_get_user"
  | "auth_other"
  | "pg_sessions_select"
  | "pg_sessions_update"
  | "pg_other"
  | "redis"
  | "revenuecat"
  | "unknown";

export interface UpstreamCall {
  n: number;
  /** id of the edge request that caused this call (AsyncLocalStorage). */
  requestId: string | null;
  kind: UpstreamKind;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** what the fault script decided */
  action: string;
  tStartMs: number;
  tEndMs: number;
}

export type FaultAction =
  | { kind: "pass" }
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "raw"; status: number; text: string; contentType?: string }
  | { kind: "throw"; message?: string }
  /** Never answers; rejects with AbortError when the caller's signal fires.
   * `maxMs` is a safety valve for callers WITHOUT a signal (PostgREST). */
  | { kind: "hang"; maxMs: number; then?: FaultAction }
  /** Executes immediately, replies after `ms` (slow network / slow reply). */
  | { kind: "delay"; ms: number; then?: FaultAction };

export type FaultScript = (call: {
  n: number;
  call: Omit<UpstreamCall, "action" | "tEndMs">;
}) => FaultAction;

export interface SessionRow {
  id: string;
  user_id: string;
  ended_at: string | null;
  started_at: string;
  kind: string;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple";
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  users: Map<string, FakeUser>;
  /** access token → user id */
  bearers: Map<string, string>;
  sessions: Map<string, SessionRow>;
  redis: Map<string, { value: string; expiresAtMs: number }>;
  calls: UpstreamCall[];
  faults: Partial<Record<UpstreamKind, FaultScript>>;
  /** Per-kind call counters (reset with resetFaults). */
  kindCounters: Partial<Record<UpstreamKind, number>>;
  /** Fresh model (users/bearers/sessions/redis/calls/faults). L1 caches
   * inside the edge fn are per-isolate and DO survive — mint new bearers
   * per scenario when that matters. */
  reset(): void;
  resetFaults(): void;
  mintUser(prng: Prng, provider?: "google" | "apple"): FakeUser;
  /** A Supabase-issued access token for the user (session_id claim, exp). */
  mintBearer(userId: string, options?: { ttlSeconds?: number; sessionId?: string }): string;
  mintSession(prng: Prng, userId: string, endedAt?: string | null): SessionRow;
  callsFor(requestId: string): UpstreamCall[];
  /** Drive the REAL handler with request-id attribution. */
  invoke(request: Request, requestId?: string): Promise<Response>;
}

const als = new AsyncLocalStorage<{ requestId: string }>();

function classify(method: string, url: URL): UpstreamKind {
  const href = url.href;
  if (href.startsWith(`${REDIS_URL}/`)) return "redis";
  if (href.startsWith(RC_HOST)) return "revenuecat";
  if (href.startsWith(`${SUPABASE_URL}/auth/v1/user`) && method === "GET") return "auth_get_user";
  if (href.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth_other";
  if (href.startsWith(`${SUPABASE_URL}/rest/v1/sessions`)) {
    if (method === "GET") return "pg_sessions_select";
    if (method === "PATCH") return "pg_sessions_update";
    return "pg_other";
  }
  if (href.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "pg_other";
  return "unknown";
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.stress-sig`;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** PostgREST-style `col=eq.value` / `col=is.null` filters over rows. */
export function applyPostgrestFilters(rows: SessionRow[], params: URLSearchParams): SessionRow[] {
  let out = rows;
  for (const [key, raw] of params) {
    if (key === "select" || key === "columns" || key === "on_conflict") continue;
    const dot = raw.indexOf(".");
    const op = dot >= 0 ? raw.slice(0, dot) : "eq";
    const value = dot >= 0 ? raw.slice(dot + 1) : raw;
    out = out.filter((row) => {
      const cell = (row as unknown as Record<string, unknown>)[key];
      switch (op) {
        case "eq":
          return String(cell).toLowerCase() === value.toLowerCase();
        case "is":
          return value === "null" ? cell === null : Boolean(cell) === (value === "true");
        case "in": {
          const list = value.replace(/^\(|\)$/g, "").split(",");
          return list.includes(String(cell));
        }
        default:
          throw new Error(`stress harness: unsupported PostgREST operator ${op}`);
      }
    });
  }
  return out;
}

function selectColumns(row: SessionRow, select: string | null): Record<string, unknown> {
  if (!select || select === "*") return { ...row };
  const out: Record<string, unknown> = {};
  for (const col of select.split(",")) {
    out[col.trim()] = (row as unknown as Record<string, unknown>)[col.trim()];
  }
  return out;
}

function redisCommand(
  state: StressHarness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  const [op, ...args] = command.map(String);
  const now = Date.now();
  const live = (key: string) => {
    const entry = state.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= now) {
      state.redis.delete(key);
      return null;
    }
    return entry;
  };
  switch (op) {
    case "GET":
      return { result: live(args[0])?.value ?? null };
    case "TTL": {
      const entry = live(args[0]);
      return { result: entry ? Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1000)) : -2 };
    }
    case "SET": {
      // SET key value EX seconds [NX]
      const exIdx = args.indexOf("EX");
      const ttl = exIdx >= 0 ? Number(args[exIdx + 1]) : 3600;
      if (args.includes("NX") && live(args[0])) return { result: null };
      state.redis.set(args[0], { value: args[1], expiresAtMs: now + ttl * 1000 });
      return { result: "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (state.redis.delete(key)) n += 1;
      return { result: n };
    }
    case "INCR": {
      const entry = live(args[0]);
      const next = entry ? Number(entry.value) + 1 : 1;
      state.redis.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? now + 365 * 86_400_000,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = live(args[0]);
      if (!entry) return { result: 0 };
      const nx = args.includes("NX");
      const ttl = Number(args[1]);
      if (nx && entry.expiresAtMs < now + 300 * 86_400_000) return { result: 0 };
      entry.expiresAtMs = now + ttl * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command ${op}` };
  }
}

async function honourSignal(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) throw new DOMException("The signal has been aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("The signal has been aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function realAnswer(
  state: StressHarness,
  request: Request,
  kind: UpstreamKind,
  body: unknown,
  headers: Record<string, string>,
): Response {
  const url = new URL(request.url);
  const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  switch (kind) {
    case "redis": {
      if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
      return jsonResponse(
        200,
        commands.map((c) => redisCommand(state, c)),
      );
    }
    case "auth_get_user": {
      const userId = state.bearers.get(bearer);
      const claims = jwtPayload(bearer);
      if (!userId || (typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now())) {
        return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      const user = state.users.get(userId)!;
      return jsonResponse(200, {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: { provider: user.provider, providers: [user.provider] },
        user_metadata: {},
      });
    }
    case "pg_sessions_select":
    case "pg_sessions_update": {
      const sub = jwtPayload(bearer)?.sub;
      if (typeof sub !== "string") {
        return jsonResponse(401, { code: "PGRST301", message: "JWT expired or missing" });
      }
      const visible = [...state.sessions.values()].filter((row) => row.user_id === sub);
      const matched = applyPostgrestFilters(visible, url.searchParams);
      if (kind === "pg_sessions_select") {
        const select = url.searchParams.get("select");
        const rows = matched.map((row) => selectColumns(row, select));
        if ((headers["accept"] ?? "").includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            return jsonResponse(406, {
              code: "PGRST116",
              details: `Results contain ${rows.length} rows`,
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            });
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      // PATCH: only the column grant the migration allows (ended_at).
      const patch = isRecord(body) ? body : {};
      for (const col of Object.keys(patch)) {
        if (col !== "ended_at") {
          return jsonResponse(401, {
            code: "42501",
            message: `permission denied for table sessions`,
            details: null,
            hint: null,
          });
        }
      }
      for (const row of matched) {
        row.ended_at = typeof patch.ended_at === "string" ? patch.ended_at : row.ended_at;
      }
      return new Response(null, { status: 204 });
    }
    case "revenuecat":
      return jsonResponse(200, { subscriber: { entitlements: {}, subscriptions: {} } });
    case "auth_other":
    case "pg_other":
    case "unknown":
      return new Response(`stress harness: unexpected upstream ${request.method} ${request.url}`, {
        status: 599,
      });
  }
}

async function performAction(
  state: StressHarness,
  action: FaultAction,
  request: Request,
  kind: UpstreamKind,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  switch (action.kind) {
    case "pass":
      return realAnswer(state, request, kind, body, headers);
    case "status":
      return jsonResponse(action.status, action.body ?? { error: `injected ${action.status}` }, {
        ...action.headers,
      });
    case "raw":
      return new Response(action.text === "" ? null : action.text, {
        status: action.status,
        headers: action.text === "" ? {} : { "Content-Type": action.contentType ?? "text/html" },
      });
    case "throw":
      throw new TypeError(action.message ?? "error sending request: connection reset");
    case "hang":
      await honourSignal(action.maxMs, request.signal);
      return performAction(state, action.then ?? { kind: "pass" }, request, kind, body, headers);
    case "delay": {
      // Slow NETWORK, not a slow statement: the upstream executes immediately
      // (a read sees the state at execution time) and the reply is delayed —
      // the realistic read→write race window.
      const response = await performAction(
        state,
        action.then ?? { kind: "pass" },
        request,
        kind,
        body,
        headers,
      );
      await honourSignal(action.ms, request.signal);
      return response;
    }
  }
}

let loaded: StressHarness | null = null;

/** Boot once per isolate. `redis` decides whether cache.ts sees Upstash env
 * (read at module load, so it cannot change afterwards in this isolate). */
export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<StressHarness> {
  if (loaded) {
    if (Boolean(options.redis) !== loaded.redisEnabled) {
      throw new Error("stress harness: redis mode is fixed per isolate (one test file per mode)");
    }
    loaded.reset();
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stress-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
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

  const t0 = performance.now();
  let seq = 0;
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    users: new Map(),
    bearers: new Map(),
    sessions: new Map(),
    redis: new Map(),
    calls: [],
    faults: {},
    kindCounters: {},
    reset() {
      state.users = new Map();
      state.bearers = new Map();
      state.sessions = new Map();
      state.redis = new Map();
      state.calls = [];
      state.resetFaults();
    },
    resetFaults() {
      state.faults = {};
      state.kindCounters = {};
    },
    mintUser(prng, provider = "google") {
      const id = prng.uuid();
      const user: FakeUser = { id, email: `${id.slice(0, 8)}@example.com`, provider };
      state.users.set(id, user);
      return user;
    },
    mintBearer(userId, options = {}) {
      const exp = Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 3600);
      const token = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: options.sessionId ?? crypto.randomUUID(),
        exp,
        // unique per mint so two bearers of one user never share a cache key
        jti: crypto.randomUUID(),
      });
      state.bearers.set(token, userId);
      return token;
    },
    mintSession(prng, userId, endedAt = null) {
      const row: SessionRow = {
        id: prng.uuid(),
        user_id: userId,
        ended_at: endedAt,
        started_at: "2026-09-01T10:00:00.000Z",
        kind: "practice",
      };
      state.sessions.set(row.id, row);
      return row;
    },
    callsFor(requestId) {
      return state.calls.filter((call) => call.requestId === requestId);
    },
    invoke(request, requestId = crypto.randomUUID()) {
      return als.run({ requestId }, () => state.handler(request));
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const kind = classify(request.method, url);
    const n = (state.kindCounters[kind] ?? 0) + 1;
    state.kindCounters[kind] = n;
    const partial = {
      n: ++seq,
      requestId: als.getStore()?.requestId ?? null,
      kind,
      method: request.method,
      url: request.url,
      headers,
      body,
      tStartMs: Math.round((performance.now() - t0) * 1000) / 1000,
    };
    const script = state.faults[kind];
    const action: FaultAction = script ? script({ n, call: partial }) : { kind: "pass" };
    const record: UpstreamCall = { ...partial, action: describeAction(action), tEndMs: 0 };
    state.calls.push(record);
    try {
      return await performAction(state, action, request, kind, body, headers);
    } finally {
      record.tEndMs = Math.round((performance.now() - t0) * 1000) / 1000;
    }
  }) as typeof fetch;

  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    state.handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  loaded = state;
  return state;
}

export function describeAction(action: FaultAction): string {
  switch (action.kind) {
    case "pass":
      return "pass";
    case "status":
      return `status:${action.status}`;
    case "raw":
      return `raw:${action.status}`;
    case "throw":
      return "throw";
    case "hang":
      return `hang:${action.maxMs}${action.then ? `>${describeAction(action.then)}` : ""}`;
    case "delay":
      return `delay:${action.ms}${action.then ? `>${describeAction(action.then)}` : ""}`;
  }
}

// ── Request builders ─────────────────────────────────────────────────────────

export function finalizeRequest(
  sessionId: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
    method?: string;
    pathSuffix?: string;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.42",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  return new Request(
    `http://edge.stress.test/functions/v1/api/v1/sessions/${sessionId}${options.pathSuffix ?? "/finalize"}`,
    {
      method: options.method ?? "POST",
      headers,
      body: options.body ?? undefined,
    },
  );
}

export async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { _raw: parsed };
  } catch {
    return { _text: text };
  }
}

/** The user-visible error class the app derives from a response: status,
 * typed code (if any), and whether the mobile outbox treats it as
 * retryable (isPermanentSyncFailure in apps/mobile/src/data/sync.ts:79 —
 * 4xx other than 401/408/429 burns an attempt; everything else retries). */
export interface ErrorClass {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  requestId: string | null;
  /** how the mobile outbox would treat it */
  outbox: "success" | "retry" | "permanent";
  /** 5xx body must be generic (REVIEW.md) */
  leaksDetail: boolean;
}

export async function classifyResponse(response: Response): Promise<ErrorClass> {
  const body = await readJson(response);
  const error = body && isRecord(body.error) ? body.error : null;
  const code = error && typeof error.code === "string" ? error.code : null;
  const message = error && typeof error.message === "string" ? error.message : null;
  const status = response.status;
  const outbox: ErrorClass["outbox"] =
    status < 400
      ? "success"
      : status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
        ? "permanent"
        : "retry";
  const text = JSON.stringify(body ?? {});
  const leaksDetail =
    status >= 500 &&
    /injected|PGRST|42501|ECONN|connection|stack|sessions|postgres|supabase|redis/i.test(text) &&
    !/temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\./.test(
      text,
    );
  return {
    status,
    code,
    message,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    outbox,
    leaksDetail,
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-end-session/latest/", import.meta.url).pathname;
}

export async function writeJson(name: string, data: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(samples: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? NaN),
    mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
  };
}

/** Forces a GC first when the isolate runs with --v8-flags=--expose-gc, so
 * heap deltas measure retained memory rather than garbage. */
export function heapSnapshot(): Deno.MemoryUsage & { gcForced: boolean } {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  return { ...Deno.memoryUsage(), gcForced: Boolean(gc) };
}

export function replayCommand(file: string, filter: string, seed: number): string {
  return `cd supabase/functions/api/__wf__ && STRESS_SEED=${seed} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}
