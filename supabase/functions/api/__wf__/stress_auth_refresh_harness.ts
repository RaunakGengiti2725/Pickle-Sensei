// Stress harness for `POST /v1/auth/refresh` (failure-injection + load lens).
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, no port) with
// every upstream behind a programmable fake `fetch`:
//   • GoTrue  (POST /auth/v1/token?grant_type=refresh_token — the route's ONE
//              upstream dependency) — scripted per attempt: HTTP answers with
//              any status/body/headers, socket failures, hangs honouring the
//              abort signal, delayed answers, body streams that error or hang.
//   • Upstash (POST /pipeline) — a small in-memory Redis with the same
//              fault vocabulary (only wired when loaded with `redis: true`;
//              cache.ts reads UPSTASH_* at import, so that choice is per isolate).
//   • PostgREST + RevenueCat — minimal fakes that can be failed on purpose;
//              the refresh route must never call them, and we assert that.
//
// Every upstream call is recorded with timing so per-request round-trip
// counts and latencies are evidence, not inference. Nothing here touches a
// network: the only `fetch` that exists is the fake.
//
// Scale knobs (all optional, small defaults keep the suite fast):
//   STRESS_SEED     master seed for the seeded campaigns (default 20260905)
//   STRESS_ITER     random fault-campaign iterations (default 40)
//   STRESS_LOAD_N   load-campaign request count      (default 300)
//   STRESS_USERS    distinct users for the L1 memory campaign (default 2500)
//   STRESS_OUT_DIR  where JSON evidence tables are written
//                   (default artifacts/stress-auth-refresh/latest/)

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "anon-stress-key";
export const REDIS_TOKEN = "upstash-stress-token";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Seeded RNG (same generator as xc_concurrency_harness.ts, kept local so
// this harness has no dependency on other test modules) ──────────────────────

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
  /** Derive an independent, replayable child seed for iteration `i`. */
  child(i: number): number {
    return (Math.imul(this.seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_LOAD_N = envInt("STRESS_LOAD_N", 300);
export const STRESS_USERS = envInt("STRESS_USERS", 2500);

// ── Upstream behaviours ──────────────────────────────────────────────────────

export interface AttemptContext {
  /** 0-based index of this GoTrue attempt within ONE edge request. */
  attempt: number;
  request: Request;
  body: Record<string, unknown>;
  /** The abort signal the edge function passed to fetch (deadline). */
  signal: AbortSignal;
}

/** One upstream answer: a Response, or a thrown error (socket failure), or
 * a promise that only settles when the caller aborts (hang). */
export type Behaviour = (ctx: AttemptContext) => Promise<Response> | Response;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function rawResponse(
  status: number,
  text: string | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers });
}

/** Reject the way a real fetch does when its signal aborts. */
export function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Never answers; rejects with AbortError once the caller gives up. */
export const hang: Behaviour = (ctx) =>
  new Promise<Response>((_, reject) => {
    if (ctx.signal.aborted) return reject(abortError());
    ctx.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

/** Connection-level failure (what fetch throws for ECONNREFUSED/DNS/reset). */
export const socketFailure =
  (message = "error sending request for url: connection refused"): Behaviour =>
  () => {
    throw new TypeError(message);
  };

/** Answer after `ms` unless the caller aborts first (then reject like fetch). */
export const delayed =
  (ms: number, then: Behaviour): Behaviour =>
  async (ctx) => {
    await sleepUnlessAborted(ms, ctx.signal);
    if (ctx.signal.aborted) throw abortError();
    return then(ctx);
  };

/** Headers arrive, then the body stream errors mid-read. */
export const bodyStreamError =
  (status = 200): Behaviour =>
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"half'));
          controller.error(new TypeError("error reading a body from connection: reset"));
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );

/** Headers arrive, then the body never finishes (until abort). */
export const bodyHang =
  (status = 200): Behaviour =>
  (ctx) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"'));
          ctx.signal.addEventListener("abort", () => controller.error(abortError()), {
            once: true,
          });
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );

/** Attempt `i` gets `steps[i]`; past the end the last step repeats. */
export const sequence =
  (steps: readonly Behaviour[]): Behaviour =>
  (ctx) =>
    steps[Math.min(ctx.attempt, steps.length - 1)](ctx);

// ── The fake GoTrue session ──────────────────────────────────────────────────

export function gotrueUser(userId: string): Record<string, unknown> {
  return {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: `${userId.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

export interface SessionShape {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  token_type?: unknown;
  user?: unknown;
  [extra: string]: unknown;
}

/** A well-formed rotated session for `userId` (overrides win). */
export function validSession(userId: string, overrides: SessionShape = {}): SessionShape {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionShape = {
    access_token: `at-${userId}-${crypto.randomUUID()}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `rt-${crypto.randomUUID()}`,
    user: gotrueUser(userId),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete session[key];
    else session[key] = value;
  }
  return session;
}

export const GOTRUE_REFUSAL = (code = "refresh_token_not_found") =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_code: code,
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
  });

/** Default GoTrue: every presented refresh token rotates into a fresh pair
 * for a user id derived from the token (so distinct tokens ⇒ distinct users). */
export function userIdForToken(token: string): string {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
}

export const defaultRefreshGrant: Behaviour = (ctx) => {
  const presented = typeof ctx.body.refresh_token === "string" ? ctx.body.refresh_token : "";
  if (!presented) return GOTRUE_REFUSAL();
  return jsonResponse(200, validSession(userIdForToken(presented)));
};

// ── Recorded upstream traffic ────────────────────────────────────────────────

export type Upstream = "gotrue" | "postgrest" | "upstash" | "revenuecat" | "other";

export interface UpstreamCall {
  /** ms since harness load. */
  t: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** Request body (parsed JSON when possible). */
  body: unknown;
  /** How the fake answered: `http:<status>` | `throw:<name>` | `abort`. */
  outcome: string;
  durationMs: number;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface UpstashContext {
  commands: Array<Array<string | number>>;
  signal: AbortSignal;
}
export type UpstashBehaviour = (ctx: UpstashContext) => Promise<Response> | Response;

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  calls: UpstreamCall[];
  callsTo(upstream: Upstream): UpstreamCall[];
  /** GoTrue refresh-grant behaviour (null → defaultRefreshGrant). */
  gotrue: Behaviour | null;
  /** Upstash behaviour (null → the in-memory fake Redis below). */
  upstash: UpstashBehaviour | null;
  /** PostgREST behaviour (null → minimal 200 answers). */
  postgrest: Behaviour | null;
  /** RevenueCat behaviour (null → minimal subscriber). */
  revenuecat: Behaviour | null;
  /** The fake Upstash store (redis mode only). */
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  /** Forget recorded traffic and scripted faults (NOT the edge function's own
   * in-memory state — rate-limit windows live inside the real module). */
  reset(): void;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<StressHarness> {
  if (loaded) {
    if (Boolean(options.redis) !== loaded.redisEnabled) {
      throw new Error("redis mode is fixed at first load (cache.ts reads env at import)");
    }
    loaded.reset();
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  for (const key of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
  ]) {
    Deno.env.delete(key);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const t0 = performance.now();
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    calls: [],
    callsTo(upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
    gotrue: null,
    upstash: null,
    postgrest: null,
    revenuecat: null,
    redis: new Map(),
    redisCommands: [],
    reset() {
      state.calls = [];
      state.gotrue = null;
      state.upstash = null;
      state.postgrest = null;
      state.revenuecat = null;
      state.redis = new Map();
      state.redisCommands = [];
    },
  };

  // GoTrue attempts are numbered per edge request: authRequest() passes ONE
  // AbortSignal (its deadline controller) to every retry of the same call, so
  // the signal object identifies the edge request.
  const attemptCounters = new WeakMap<AbortSignal, number>();

  const classify = (url: URL): Upstream => {
    if (url.href.startsWith(REDIS_URL)) return "upstash";
    if (url.href.startsWith(RC_URL)) return "revenuecat";
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) return "gotrue";
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) return "postgrest";
    return "other";
  };

  const runRedis = (commands: Array<Array<string | number>>): Response =>
    jsonResponse(
      200,
      commands.map((command) => runRedisCommand(state, command)),
    );

  const defaultPostgrest: Behaviour = (ctx) => {
    const url = new URL(ctx.request.url);
    const target = url.pathname.slice("/rest/v1/".length);
    if (target.startsWith("rpc/")) return jsonResponse(200, {});
    if (ctx.request.method === "GET") return jsonResponse(200, []);
    return new Response(null, { status: 201 });
  };
  const defaultRevenueCat: Behaviour = () =>
    jsonResponse(200, { request_date_ms: Date.now(), subscriber: { entitlements: {} } });
  const defaultGotrueOther: Behaviour = () =>
    jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const upstream = classify(url);
    const started = performance.now();
    const signal = init?.signal ?? request.signal;
    const text = await request.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    const record: UpstreamCall = {
      t: Math.round((started - t0) * 100) / 100,
      upstream,
      method: request.method,
      url: request.url,
      body,
      outcome: "pending",
      durationMs: 0,
    };
    state.calls.push(record);
    const finish = (outcome: string) => {
      record.outcome = outcome;
      record.durationMs = Math.round((performance.now() - started) * 100) / 100;
    };
    try {
      let response: Response;
      if (upstream === "upstash") {
        if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
          response = jsonResponse(401, { error: "Unauthorized" });
        } else {
          const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
          response = state.upstash ? await state.upstash({ commands, signal }) : runRedis(commands);
        }
      } else if (upstream === "gotrue") {
        const grant = url.searchParams.get("grant_type");
        if (url.pathname === "/auth/v1/token" && grant === "refresh_token") {
          const payload = isRecord(body) ? body : {};
          const attempt = attemptCounters.get(signal) ?? 0;
          attemptCounters.set(signal, attempt + 1);
          if (signal.aborted) throw abortError();
          const ctx: AttemptContext = { attempt, request, body: payload, signal };
          response = await (state.gotrue ?? defaultRefreshGrant)(ctx);
        } else {
          response = await defaultGotrueOther({ attempt: 0, request, body: {}, signal });
        }
      } else if (upstream === "postgrest") {
        response = await (state.postgrest ?? defaultPostgrest)({
          attempt: 0,
          request,
          body: isRecord(body) ? body : {},
          signal,
        });
      } else if (upstream === "revenuecat") {
        response = await (state.revenuecat ?? defaultRevenueCat)({
          attempt: 0,
          request,
          body: isRecord(body) ? body : {},
          signal,
        });
      } else {
        response = new Response(`unexpected fetch in stress harness: ${request.url}`, {
          status: 599,
        });
      }
      finish(`http:${response.status}`);
      return response;
    } catch (error) {
      finish(
        error instanceof DOMException && error.name === "AbortError"
          ? "abort"
          : `throw:${error instanceof Error ? error.name : typeof error}`,
      );
      throw error;
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

function redisLive(state: StressHarness, key: string): FakeRedisEntry | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

/** Minimal Upstash-compatible executor for the commands cache.ts issues. */
export function runRedisCommand(
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

// ── Requests ─────────────────────────────────────────────────────────────────

let ipCounter = 0;
/** A fresh client IP so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`;
}

/** Deterministic, collision-free client IP for `index` (0 … 4,095,999). */
export function ipFor(index: number): string {
  return `100.${64 + (Math.floor(index / 64_000) % 64)}.${Math.floor(index / 250) % 256}.${(index % 250) + 1}`;
}

export function refreshRequest(
  options: {
    ip?: string;
    token?: string;
    /** Overrides the JSON body entirely (object or raw string). */
    body?: unknown;
    rawBody?: string | Uint8Array | ReadableStream<Uint8Array> | null;
    headers?: Record<string, string>;
    path?: string;
    method?: string;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? freshIp(),
    Accept: "application/json",
    ...options.headers,
  });
  let body: BodyInit | null | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  } else {
    const payload =
      options.body !== undefined
        ? options.body
        : { refreshToken: options.token ?? `rt-${crypto.randomUUID()}` };
    body = JSON.stringify(payload);
    headers.set("Content-Type", "application/json");
  }
  return new Request(
    `http://edge.stress.test${options.path ?? "/functions/v1/api/v1/auth/refresh"}`,
    {
      method: options.method ?? "POST",
      headers,
      body,
    },
  );
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

/** What the iOS client does with this answer — the SAME decision as
 * apps/mobile/src/account/sessionLifecycle.ts refreshApiSession():
 *   401/403             → SessionRefreshError(retryable=false) ⇒ sign-out
 *   !ok or bad session  → SessionRefreshError(retryable=true)  ⇒ retry later
 *   ok + usable session → rotated                               */
export type ClientClass = "signed_out" | "retryable" | "rotated";

export function clientClassOf(status: number, body: Record<string, unknown>): ClientClass {
  if (status === 401 || status === 403) return "signed_out";
  const session = isRecord(body.session) ? body.session : undefined;
  if (
    status < 200 ||
    status >= 300 ||
    typeof session?.accessToken !== "string" ||
    !session.accessToken.trim() ||
    typeof session.refreshToken !== "string" ||
    !session.refreshToken.trim() ||
    typeof session.expiresAt !== "number" ||
    !Number.isFinite(session.expiresAt)
  ) {
    return "retryable";
  }
  return "rotated";
}

export interface Observed {
  status: number;
  retryAfter: string | null;
  body: Record<string, unknown>;
  errorCode: string | undefined;
  clientClass: ClientClass;
  latencyMs: number;
  requestId: string | null;
  gotrueAttempts: number;
  gotrueOutcomes: string[];
  postgrestCalls: number;
  revenuecatCalls: number;
  upstashCalls: number;
}

async function presentedToken(request: Request): Promise<string | null> {
  if (request.method !== "POST" || request.body === null) return null;
  try {
    const parsed = JSON.parse(await request.clone().text());
    return isRecord(parsed) && typeof parsed.refreshToken === "string"
      ? parsed.refreshToken.trim()
      : null;
  } catch {
    return null;
  }
}

/** Drive ONE refresh through the real handler and summarise everything a
 * verdict needs. GoTrue attempts are attributed by the refresh token the
 * request carried (exact even under concurrency, as long as concurrent
 * requests carry distinct tokens); the other upstream counters are the calls
 * logged while this request was in flight, so they are exact only when
 * requests run one at a time. */
export async function refresh(h: StressHarness, request: Request): Promise<Observed> {
  const token = await presentedToken(request);
  const before = h.calls.length;
  const started = performance.now();
  const response = await h.handler(request);
  const body = await readJson(response);
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;
  const mine = h.calls.slice(before);
  const gotrue = mine.filter(
    (call) =>
      call.upstream === "gotrue" &&
      call.url.includes("grant_type=refresh_token") &&
      (token === null || (isRecord(call.body) && call.body.refresh_token === token)),
  );
  const error = isRecord(body.error) ? body.error : undefined;
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body,
    errorCode: typeof error?.code === "string" ? error.code : undefined,
    clientClass: clientClassOf(response.status, body),
    latencyMs,
    requestId: response.headers.get("x-request-id"),
    gotrueAttempts: gotrue.length,
    gotrueOutcomes: gotrue.map((call) => call.outcome),
    postgrestCalls: mine.filter((call) => call.upstream === "postgrest").length,
    revenuecatCalls: mine.filter((call) => call.upstream === "revenuecat").length,
    upstashCalls: mine.filter((call) => call.upstream === "upstash").length,
  };
}

/** Run `fn` with AUTH_UPSTREAM_TIMEOUT_MS set (the edge function reads it per
 * call), restoring the previous value afterwards. */
export async function withAuthTimeout<T>(ms: number | null, fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  if (ms === null) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(ms));
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
  }
}

/** Rate-limit windows are fixed buckets of `windowSeconds`; a budget scenario
 * that straddles a bucket edge would see its counter reset. Wait out the tail
 * of the current bucket when fewer than `needMs` remain. */
export async function awaitWindowHeadroom(windowSeconds: number, needMs: number): Promise<void> {
  const windowMs = windowSeconds * 1_000;
  const remaining = windowMs - (Date.now() % windowMs);
  if (remaining < needMs) await new Promise((resolve) => setTimeout(resolve, remaining + 5));
}

/** Silence the edge function's `[api] …` operator lines during a campaign
 * (they are expected for every injected fault) while keeping a count. */
export function muteConsole(): { restore(): void; errors: number; warns: number } {
  const con = globalThis.console;
  const originalError = con.error;
  const originalWarn = con.warn;
  const originalLog = con.log;
  const counter = {
    errors: 0,
    warns: 0,
    restore() {
      con.error = originalError;
      con.warn = originalWarn;
      con.log = originalLog;
    },
  };
  con.error = () => {
    counter.errors += 1;
  };
  con.warn = () => {
    counter.warns += 1;
  };
  con.log = () => undefined;
  return counter;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-auth-refresh/latest/", import.meta.url).pathname;
}

export async function writeReport(name: string, report: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function latencySummary(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : NaN,
  };
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function heapNow(): { heapUsedMb: number; rssMb: number } {
  const usage = Deno.memoryUsage();
  return {
    heapUsedMb: Math.round((usage.heapUsed / 1_048_576) * 100) / 100,
    rssMb: Math.round((usage.rss / 1_048_576) * 100) / 100,
  };
}
