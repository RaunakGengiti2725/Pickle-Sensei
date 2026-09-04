// stress-route-get-v1-me — FAILURE-INJECTION + LOAD harness for GET /v1/me.
//
// Boots the REAL edge function (../index.ts, Deno.serve captured) behind one
// programmable fetch. Every upstream the route can reach — Supabase Auth
// (GET /auth/v1/user, the transitional id_token grant), PostgREST
// (GET /rest/v1/profiles), Upstash Redis (POST /pipeline) and RevenueCat
// (never on this route; kept to prove isolation) — is answered by a per-upstream
// FaultMode that can fail, time out, stall, or return a malformed 2xx. Nothing
// here touches a network.
//
// Everything is counted (Supabase round trips per request, Redis pipelines,
// RevenueCat calls) and every campaign is driven by a seeded PRNG so any
// iteration replays from its seed (stress_me_failure.test.ts,
// stress_me_load.test.ts). Artifacts (seed → outcome tables, latency
// percentiles, heap snapshots) are written under STRESS_OUT_DIR (default
// artifacts/stress-me/latest/).

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "stress-anon-key";

/** Detail string planted in upstream error bodies: it must be logged, never
 * echoed to the client (5xx bodies stay generic). */
export const CANARY = "CANARY-UPSTREAM-DETAIL-7f3a9c";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(
      atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
    ) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

/** mulberry32 — deterministic, replayable from its 32-bit seed. */
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
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Fault model ──────────────────────────────────────────────────────────────

export type Upstream = "auth" | "rest" | "redis" | "rc";

export type FaultMode =
  | { kind: "ok" }
  /** An HTTP answer of `status`. `body` picks the shape (default: the
   * upstream's own JSON error shape carrying CANARY as its message). */
  | {
    kind: "http";
    status: number;
    body?: "json-error" | "html" | "empty" | "json-array";
    retryAfter?: number;
  }
  /** A 2xx whose body the caller cannot use. Per-upstream shapes below. */
  | { kind: "malformed"; shape: string }
  /** The socket fails (`TypeError: error sending request`) `times` times
   * (default forever), then the upstream answers normally. */
  | { kind: "network"; times?: number }
  /** Headers + body answer only after `ms` (still a normal answer). */
  | { kind: "slow"; ms: number }
  /** No answer at all until the caller's AbortSignal fires (then rejects
   * with the caller's reason); a caller WITHOUT a signal waits `hardMs`
   * (default 30 s) so a probe can measure that nothing bounded it. */
  | { kind: "stall"; hardMs?: number }
  /** Headers arrive with 200, the body stream errors mid-way. */
  | { kind: "truncated" }
  /** The n-th call to the upstream (within one request, see mark()) gets
   * `steps[n]`; calls past the end are answered normally. */
  | { kind: "sequence"; steps: FaultMode[] };

export const OK: FaultMode = { kind: "ok" };

export interface FakeUser {
  id: string;
  email: string;
  provider: string;
  /** Row PostgREST returns for this user; null = no profile row. */
  profile: Record<string, unknown> | null;
}

export interface FakeSession {
  userId: string;
  accessToken: string;
  sessionId: string;
  expiresAt: number;
}

export interface RecordedCall {
  upstream: Upstream;
  method: string;
  url: string;
  at: number;
}

export interface RestRequest {
  method: string;
  table: string;
  /** The `select=` column list as sent by supabase-js. */
  select: string;
  /** Every other query parameter (PostgREST filters such as `id=eq.<uuid>`). */
  filters: Record<string, string>;
  /** The bearer's JWT `sub` (the caller PostgREST would run RLS as). */
  sub: string | null;
  /** True when supabase-js asked for exactly one object (`.single()`). */
  wantsObject: boolean;
}

export type RestBackend = (request: RestRequest) => Promise<Response>;

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  faults: Record<Upstream, FaultMode>;
  /** Per-upstream call counters since the last reset()/mark(). */
  counts: Record<Upstream, number>;
  /** Calls recorded when `recordCalls` is true (kept off for big campaigns). */
  calls: RecordedCall[];
  recordCalls: boolean;
  /** The fake Upstash store + every command it ran. */
  redis: Map<string, { value: string; expiresAtMs: number }>;
  redisCommands: string[];
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  /** console.error lines captured while `captureLogs` is on. */
  errorLog: string[];
  accessLog: Array<Record<string, unknown>>;
  captureLogs: boolean;
  /** When set, healthy (`ok`) PostgREST calls are answered by this backend
   * instead of the in-memory profile map — stress_me_pg.test.ts points it at a
   * real postgres:16 so the route's SELECT runs against the migrated schema. */
  restBackend: RestBackend | null;
  /** Registers a user with a default complete profile. */
  registerUser(id: string, provider?: string): FakeUser;
  /** Mints a Supabase-issued session bearer for the user (default 1 h). */
  mintSession(userId: string, ttlSeconds?: number): FakeSession;
  /** A Google ID token for the user (transitional provider-token bearer). */
  providerToken(userId: string, ttlSeconds?: number): string;
  /** Clear faults, counters, logs, redis, users, sessions. */
  reset(): void;
  /** Zero the counters only (between requests of one case). */
  mark(): void;
  /** Snapshot of counters as a plain object. */
  snapshot(): Record<Upstream, number>;
}

let harness: StressHarness | null = null;
let ipCounter = 0;

/** A fresh client IP per call so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function meRequest(
  options: {
    token?: string | null;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? freshIp(),
    ...options.headers,
  });
  if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  return new Request("http://edge.test/functions/v1/api/v1/me", {
    method: "GET",
    headers,
  });
}

function defaultProfile(user: { id: string; email: string; provider: string }) {
  return {
    id: user.id,
    email: user.email,
    onboarding_state: "complete",
    provider: user.provider,
    skill_level: "intermediate",
    handedness: "right",
    primary_goal: "consistency",
    biggest_problem: "pop-ups",
    focus_checkpoint: "paddle_face",
    first_name: "Pat",
    gender: null,
  };
}

function gotrueUser(user: FakeUser): Record<string, unknown> {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const jsonResponse = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const reason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The signal has been aborted", "AbortError");
    if (signal.aborted) {
      reject(reason());
      return;
    }
    signal.addEventListener("abort", () => reject(reason()), { once: true });
  });
}

function truncatedResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"id":"11111111-1111-4111-8111-1111'));
      controller.error(new TypeError("connection reset while reading body"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The upstream's own error-body shape for an HTTP fault. */
function httpFaultResponse(
  upstream: Upstream,
  fault: Extract<FaultMode, { kind: "http" }>,
) {
  const extra: Record<string, string> = {};
  if (fault.retryAfter !== undefined) {
    extra["Retry-After"] = String(fault.retryAfter);
  }
  switch (fault.body ?? "json-error") {
    case "html":
      return new Response(
        `<html><body><h1>${fault.status}</h1>${CANARY}</body></html>`,
        {
          status: fault.status,
          headers: { "Content-Type": "text/html", ...extra },
        },
      );
    case "empty":
      return new Response(null, { status: fault.status, headers: extra });
    case "json-array":
      return jsonResponse(fault.status, [{ message: CANARY }], extra);
    case "json-error":
      if (upstream === "auth") {
        return jsonResponse(
          fault.status,
          { code: fault.status, error_code: "unexpected_failure", msg: CANARY },
          extra,
        );
      }
      if (upstream === "rest") {
        return jsonResponse(
          fault.status,
          {
            code: `PGRST${fault.status}`,
            message: CANARY,
            details: CANARY,
            hint: null,
          },
          extra,
        );
      }
      if (upstream === "redis") {
        return jsonResponse(fault.status, { error: CANARY }, extra);
      }
      return jsonResponse(fault.status, { code: 7000, message: CANARY }, extra);
  }
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

function runRedisCommand(
  state: StressHarness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  const [op, ...args] = command.map((part) => String(part));
  state.redisCommands.push(op);
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

/** Malformed-2xx shapes per upstream. Unknown shape → throws (test bug). */
function malformedResponse(
  _state: StressHarness,
  upstream: Upstream,
  shape: string,
  context: { user: FakeUser | null; commands: Array<Array<string | number>> },
): Response {
  const html = () =>
    new Response(`<html><body>gateway page ${CANARY}</body></html>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  if (upstream === "auth") {
    switch (shape) {
      case "html":
        return html();
      case "empty-object":
        return jsonResponse(200, {});
      case "null":
        return jsonResponse(200, null);
      case "array":
        return jsonResponse(200, [
          gotrueUser(context.user ?? placeholderUser()),
        ]);
      case "string":
        return jsonResponse(200, "ok");
      case "empty-body":
        return new Response(null, { status: 200 });
      case "no-provider": {
        const user = gotrueUser(context.user ?? placeholderUser());
        user.app_metadata = {};
        return jsonResponse(200, user);
      }
      case "email-provider": {
        const user = gotrueUser(context.user ?? placeholderUser());
        user.app_metadata = { provider: "email", providers: ["email"] };
        return jsonResponse(200, user);
      }
      case "id-not-string": {
        const user = gotrueUser(context.user ?? placeholderUser());
        user.id = 42;
        return jsonResponse(200, user);
      }
      case "status-204":
        return new Response(null, { status: 204 });
    }
  }
  if (upstream === "rest") {
    const row = context.user?.profile ?? defaultProfile(placeholderUser());
    switch (shape) {
      case "html":
        return html();
      case "empty-rows":
        return jsonResponse(200, []);
      case "null":
        return jsonResponse(200, null);
      case "empty-object":
        return jsonResponse(200, {});
      case "string":
        return jsonResponse(200, "ok");
      case "two-rows":
        return jsonResponse(200, [row, {
          ...row,
          id: "22222222-2222-4222-8222-222222222222",
        }]);
      case "row-missing-fields":
        return jsonResponse(200, [{ id: row.id }]);
      case "row-wrong-types":
        return jsonResponse(200, [
          {
            ...row,
            onboarding_state: 7,
            skill_level: { nested: true },
            first_name: 12345,
          },
        ]);
      case "row-foreign-id":
        return jsonResponse(200, [{
          ...row,
          id: "99999999-9999-4999-8999-999999999999",
        }]);
      case "empty-body":
        return new Response(null, { status: 200 });
      case "status-204":
        return new Response(null, { status: 204 });
    }
  }
  if (upstream === "redis") {
    switch (shape) {
      case "html":
        return html();
      case "empty-object":
        return jsonResponse(200, {});
      case "null":
        return jsonResponse(200, null);
      case "string":
        return jsonResponse(200, "OK");
      case "short-reply":
        return jsonResponse(200, []);
      case "slot-errors":
        return jsonResponse(
          200,
          context.commands.map(() => ({
            error: "ERR max requests limit exceeded",
          })),
        );
      case "slot-garbage":
        return jsonResponse(
          200,
          context.commands.map(() => ({ result: "not-json-not-a-number" })),
        );
      case "slot-null":
        return jsonResponse(200, context.commands.map(() => null));
      case "empty-body":
        return new Response(null, { status: 200 });
    }
  }
  if (upstream === "rc") {
    switch (shape) {
      case "html":
        return html();
      case "empty-object":
        return jsonResponse(200, {});
    }
  }
  throw new Error(
    `stress harness: unknown malformed shape ${upstream}/${shape}`,
  );
}

function placeholderUser(): FakeUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "placeholder@example.com",
    provider: "google",
    profile: null,
  };
}

/** Boot the real function once per test module. `redis: true` wires the fake
 * Upstash endpoint (cache.ts reads UPSTASH_* at import, so the choice is fixed
 * for the isolate). */
export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stress-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  for (
    const key of [
      "APPLE_SIGN_IN_CLIENT_ID",
      "APPLE_SIGN_IN_TEAM_ID",
      "APPLE_SIGN_IN_KEY_ID",
      "APPLE_SIGN_IN_PRIVATE_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY",
    ]
  ) {
    Deno.env.delete(key);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const networkFailuresLeft: Record<Upstream, number> = {
    auth: 0,
    rest: 0,
    redis: 0,
    rc: 0,
  };
  let sessionCounter = 0;

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    faults: { auth: OK, rest: OK, redis: OK, rc: OK },
    counts: { auth: 0, rest: 0, redis: 0, rc: 0 },
    calls: [],
    recordCalls: true,
    redis: new Map(),
    redisCommands: [],
    users: new Map(),
    sessions: new Map(),
    errorLog: [],
    accessLog: [],
    captureLogs: true,
    restBackend: null,
    registerUser(id, provider = "google") {
      const base = { id, email: `${id.slice(0, 8)}@example.com`, provider };
      const user: FakeUser = { ...base, profile: defaultProfile(base) };
      state.users.set(id, user);
      return user;
    },
    mintSession(userId, ttlSeconds = 3600) {
      sessionCounter += 1;
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sessionId = `sess-${sessionCounter}-${userId.slice(0, 8)}`;
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId,
        jti: `jti-${sessionCounter}`,
        exp: expiresAt,
      });
      const session: FakeSession = {
        userId,
        accessToken,
        sessionId,
        expiresAt,
      };
      state.sessions.set(accessToken, session);
      return session;
    },
    providerToken(userId, ttlSeconds = 3600) {
      sessionCounter += 1;
      return fakeJwt({
        iss: "https://accounts.google.com",
        sub: userId,
        jti: `pjti-${sessionCounter}`,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },
    reset() {
      state.faults = { auth: OK, rest: OK, redis: OK, rc: OK };
      state.counts = { auth: 0, rest: 0, redis: 0, rc: 0 };
      state.calls = [];
      state.recordCalls = true;
      state.redis = new Map();
      state.redisCommands = [];
      state.users = new Map();
      state.sessions = new Map();
      state.errorLog = [];
      state.accessLog = [];
      state.captureLogs = true;
      state.restBackend = null;
      for (const key of Object.keys(networkFailuresLeft) as Upstream[]) {
        networkFailuresLeft[key] = 0;
      }
      armed.clear();
    },
    mark() {
      state.counts = { auth: 0, rest: 0, redis: 0, rc: 0 };
      state.calls = [];
      state.redisCommands = [];
    },
    snapshot() {
      return { ...state.counts };
    },
  };

  const armed = new Map<Upstream, FaultMode>();
  const networkBudget = (
    upstream: Upstream,
    fault: Extract<FaultMode, { kind: "network" }>,
  ) => {
    // A fresh `network` fault object re-arms its remaining failure count.
    if (armed.get(upstream) !== fault) {
      armed.set(upstream, fault);
      networkFailuresLeft[upstream] = fault.times ?? Number.POSITIVE_INFINITY;
    }
    if (networkFailuresLeft[upstream] > 0) {
      networkFailuresLeft[upstream] -= 1;
      return true;
    }
    return false;
  };

  const realAnswer = async (
    upstream: Upstream,
    request: Request,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Response> => {
    if (upstream === "redis") {
      if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }
    if (upstream === "rc") {
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: { entitlements: {} },
      });
    }
    if (upstream === "auth") {
      if (url.pathname === "/auth/v1/user" && request.method === "GET") {
        const bearer = (headers["authorization"] ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const session = state.sessions.get(bearer);
        if (!session || session.expiresAt * 1000 <= Date.now()) {
          return jsonResponse(401, {
            code: 401,
            error_code: "session_not_found",
            msg: "invalid JWT: session not found",
          });
        }
        const user = state.users.get(session.userId);
        if (!user) {
          return jsonResponse(403, {
            code: 403,
            error_code: "user_not_found",
            msg: "User not found",
          });
        }
        return jsonResponse(200, gotrueUser(user));
      }
      if (
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "id_token"
      ) {
        const payload = isRecord(body) ? body : {};
        const claims = jwtPayload(
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
        const session = state.mintSession(user.id);
        return jsonResponse(200, {
          access_token: session.accessToken,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: session.expiresAt,
          refresh_token: `rt-${session.sessionId}`,
          user: gotrueUser(user),
        });
      }
      return jsonResponse(404, {
        code: 404,
        msg: `unstubbed auth path ${url.pathname}`,
      });
    }
    // PostgREST
    const table = url.pathname.slice("/rest/v1/".length);
    if (table !== "profiles" || request.method !== "GET") {
      return jsonResponse(404, {
        code: "PGRST205",
        message: `stress harness: unstubbed ${request.method} ${table}`,
      });
    }
    const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const sub = jwtPayload(bearer)?.sub;
    const idFilter = url.searchParams.get("id") ?? "";
    if (state.restBackend) {
      const filters: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        if (key !== "select") filters[key] = value;
      });
      return await state.restBackend({
        method: request.method,
        table,
        select: url.searchParams.get("select") ?? "*",
        filters,
        sub: typeof sub === "string" ? sub : null,
        wantsObject: (headers["accept"] ?? "").includes(
          "application/vnd.pgrst.object+json",
        ),
      });
    }
    const user = typeof sub === "string" ? state.users.get(sub) : undefined;
    // RLS: only the caller's own row is visible, and only when the filter asks for it.
    const rows = user && user.profile && idFilter === `eq.${user.id}`
      ? [user.profile]
      : [];
    const accept = headers["accept"] ?? "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        return jsonResponse(406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: `Results contain ${rows.length} rows`,
          hint: null,
        });
      }
      return jsonResponse(200, rows[0]);
    }
    return jsonResponse(200, rows);
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    let upstream: Upstream;
    if (request.url.startsWith(`${REDIS_URL}/`)) upstream = "redis";
    else if (request.url.startsWith(RC_URL)) upstream = "rc";
    else if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      upstream = "auth";
    } else if (request.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      upstream = "rest";
    } else {
      return new Response(
        `unexpected fetch in stress test: ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }
    state.counts[upstream] += 1;
    if (state.recordCalls) {
      state.calls.push({
        upstream,
        method: request.method,
        url: request.url,
        at: performance.now(),
      });
    }
    const signal = init?.signal ?? request.signal;
    let fault = state.faults[upstream];
    if (fault.kind === "sequence") {
      fault = fault.steps[state.counts[upstream] - 1] ?? OK;
    }
    switch (fault.kind) {
      case "ok":
      case "sequence":
        break;
      case "http":
        return httpFaultResponse(upstream, fault);
      case "malformed": {
        const bearer = (headers["authorization"] ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const sub = state.sessions.get(bearer)?.userId ??
          jwtPayload(bearer)?.sub;
        const user = typeof sub === "string"
          ? (state.users.get(sub) ?? null)
          : null;
        return malformedResponse(state, upstream, fault.shape, {
          user,
          commands: Array.isArray(body)
            ? (body as Array<Array<string | number>>)
            : [],
        });
      }
      case "network":
        if (networkBudget(upstream, fault)) {
          throw new TypeError(
            "error sending request for url: connection reset by peer",
          );
        }
        break;
      case "slow":
        await sleep(fault.ms);
        break;
      case "stall": {
        if (signal) return await abortRejection(signal);
        await sleep(fault.hardMs ?? 30_000);
        break;
      }
      case "truncated":
        return truncatedResponse();
    }
    return await realAnswer(upstream, request, url, headers, body);
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
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

  // Operator-facing detail goes to console.error; keep it for assertions
  // (logged, never echoed) without flooding the test output.
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...parts: unknown[]) => {
    if (!state.captureLogs) {
      realError(...parts);
      return;
    }
    if (state.errorLog.length < 2_000) {
      state.errorLog.push(
        parts.map((part) => (typeof part === "string" ? part : String(part)))
          .join(" "),
      );
    }
  };
  console.warn = (...parts: unknown[]) => {
    if (!state.captureLogs) realWarn(...parts);
  };
  captureAccessLog((line) => {
    if (!state.captureLogs) return;
    if (state.accessLog.length < 2_000) {
      try {
        state.accessLog.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        state.accessLog.push({ raw: line });
      }
    }
  });

  await import("../index.ts");
  harness = state;
  return state;
}

// ── Response inspection ─────────────────────────────────────────────────────

export interface Observed {
  status: number;
  retryAfter: string | null;
  requestId: string | null;
  contentType: string | null;
  /** Parsed JSON body (null when not JSON). */
  body: unknown;
  /** The raw body text. */
  text: string;
  /** error.message when the body carries one. */
  message: string | null;
  code: string | null;
  durationMs: number;
}

export async function observe(
  promise: Promise<Response>,
  startedAt: number,
): Promise<Observed> {
  const response = await promise;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("Content-Type"),
    body,
    text,
    message: error && typeof error.message === "string" ? error.message : null,
    code: error && typeof error.code === "string" ? error.code : null,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

export async function callMe(
  h: StressHarness,
  request: Request,
): Promise<Observed & { counts: Record<Upstream, number> }> {
  h.mark();
  const startedAt = performance.now();
  const observed = await observe(h.handler(request), startedAt);
  return { ...observed, counts: h.snapshot() };
}

/** The documented user-visible classes for GET /v1/me. */
export type VisibleClass =
  | "ok" // 200 with the profile payload
  | "refused" // 401 — the app signs the user out / re-authenticates
  | "unavailable" // 503 + Retry-After — the app retries, keeps its session
  | "rate_limited" // 429
  | "other";

export function classify(observed: Observed): VisibleClass {
  if (observed.status === 200) return "ok";
  if (observed.status === 401) return "refused";
  if (observed.status === 503) return "unavailable";
  if (observed.status === 429) return "rate_limited";
  return "other";
}

/** A 200 body must be the documented shape and belong to `userId`. */
export function meBodyProblems(body: unknown, userId: string): string[] {
  const problems: string[] = [];
  if (!isRecord(body)) return ["body is not an object"];
  const user = isRecord(body.user) ? body.user : null;
  if (!user) problems.push("user missing");
  else if (user.id !== userId) {
    problems.push(`user.id ${String(user.id)} !== ${userId}`);
  }
  if (
    body.onboardingState !== "complete" && body.onboardingState !== "pending"
  ) {
    problems.push(`onboardingState ${String(body.onboardingState)}`);
  }
  const profile = isRecord(body.profile) ? body.profile : null;
  if (!profile) problems.push("profile missing");
  else {
    for (
      const key of [
        "skill_level",
        "handedness",
        "primary_goal",
        "biggest_problem",
        "focus_checkpoint",
        "first_name",
        "gender",
      ]
    ) {
      if (!(key in profile)) problems.push(`profile.${key} missing`);
    }
  }
  return problems;
}

/** 5xx bodies are generic: no upstream detail, no table names, no stack. */
export function leaksDetail(observed: Observed): boolean {
  const haystack = observed.text.toLowerCase();
  return (
    haystack.includes(CANARY.toLowerCase()) ||
    haystack.includes("pgrst") ||
    haystack.includes("profiles") ||
    haystack.includes("upstash") ||
    haystack.includes("supabase.stress.test") ||
    haystack.includes("    at ")
  );
}

// ── Artifacts ───────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Random-campaign iterations (default small so the file lives in the suite). */
export const STRESS_ITER = envInt("STRESS_ITER", 40);
/** STRESS_SLOW=1 also runs the cases that wait for real upstream backoff
 * (multi-second PostgREST retry chains, Redis stalls). */
export const STRESS_SLOW = envInt("STRESS_SLOW", 0) === 1;

/** Same digest/encoding as cache.ts `sha256Hex` — reimplemented here so the
 * test never imports a production module before the harness has set the
 * environment (cache.ts reads the Redis secrets at module load). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function outDir(): string {
  const configured = Deno.env.get("STRESS_OUT_DIR");
  if (configured) {
    return configured.endsWith("/") ? configured : `${configured}/`;
  }
  const root = new URL(
    "../../../../artifacts/stress-me/latest/",
    import.meta.url,
  );
  return root.pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? NaN),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? NaN),
    mean: round(
      sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length),
    ),
  };
}

export function heap(): {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
} {
  const usage = Deno.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
  };
}

export function replayCommand(
  filter: string,
  seed: number,
  extraEnv = "",
): string {
  return `cd supabase/functions/api/__wf__ && STRESS_SEED=${seed} ${extraEnv}deno task test --filter "${filter}"`;
}

/** Run `fn` with Date.now() shifted by `offsetMs` (rate-limit windows and
 * cache expiry read Date.now()). */
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
