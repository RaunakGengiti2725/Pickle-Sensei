// Failure-injection + load harness for GET /v1/me/saved-drills.
//
// Boots the REAL ../index.ts (Deno.serve captured, nothing listens) with every
// upstream the route can reach stubbed at the fetch layer and individually
// faultable:
//
//   auth        Supabase Auth (GoTrue): GET /auth/v1/user (session bearers),
//               POST /auth/v1/token?grant_type=id_token (transitional provider
//               bearers), POST /auth/v1/logout.
//   db          PostgREST: GET /rest/v1/user_saved_drills — the ONE query the
//               route issues. The stub pins the query shape (select / eq /
//               order) and answers from an in-memory table, or from a real
//               Postgres when `state.dbBackend` is set (stress_saved_drills_pg).
//   redis       Upstash REST /pipeline (only when loaded with `redis: true`;
//               cache.ts reads its env at import, so the mode is per module).
//   revenuecat  api.revenuecat.com — the route never needs it; faulting it
//               proves that.
//
// Every upstream call is attributed to the edge request that issued it via
// AsyncLocalStorage, so round trips per request are exact even when requests
// run concurrently. Randomness is seeded (mulberry32) and every case derives
// its own seed from STRESS_SEED + its id, so a run replays from the printed
// command. Results are written as JSON under STRESS_OUT_DIR (default
// artifacts/stress-saved-drills/latest/, gitignored).

import { AsyncLocalStorage } from "node:async_hooks";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
/** Marker planted in every injected upstream error body: it must never reach
 * the client (5xx bodies are generic by contract). */
export const LEAK_MARKER = "STRESS_UPSTREAM_DETAIL_MARKER";

export type Upstream = "auth" | "db" | "redis" | "revenuecat";
export const UPSTREAMS: readonly Upstream[] = [
  "auth",
  "db",
  "redis",
  "revenuecat",
];

export interface UpstreamCall {
  upstream: Upstream;
  method: string;
  url: string;
  /** Tag of the edge request that issued the call (null = untracked). */
  tag: string | null;
  startedMs: number;
  endedMs: number | null;
  outcome: "response" | "throw" | "pending" | "released";
  status: number | null;
  faulted: boolean;
}

export interface FaultContext {
  request: Request;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  /** 1-based count of calls this fault has seen (for flaky sequences). */
  attempt: number;
  /** The healthy stub's answer for this call. */
  normal: () => Promise<Response>;
  /** Registers a never-resolving promise that `releaseHung()` can settle. */
  hang: (honorAbort: boolean) => Promise<Response>;
}

export type FaultResponder = (
  ctx: FaultContext,
) => Promise<Response> | Response;

export interface SavedDrillRow {
  slug: string;
  saved_at: string;
}

export interface DbQuery {
  /** JWT `sub` of the bearer PostgREST received (the RLS identity). */
  bearerSub: string | null;
  bearer: string;
  userId: string;
  select: string[];
  order: string;
}

export interface FakeSession {
  userId: string;
  provider: "google" | "apple";
  email: string;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  calls: UpstreamCall[];
  faults: Partial<Record<Upstream, FaultResponder>>;
  faultAttempts: Record<Upstream, number>;
  /** Access tokens GoTrue would honour → who they belong to. */
  sessions: Map<string, FakeSession>;
  /** In-memory user_saved_drills, keyed by user id (used unless dbBackend is set). */
  savedDrills: Map<string, SavedDrillRow[]>;
  /** Optional real-database backend for the saved-drills query. */
  dbBackend: ((query: DbQuery) => Promise<SavedDrillRow[]>) | null;
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  reset(): void;
  callsTo(upstream: Upstream, tag?: string): UpstreamCall[];
  /** Settle every hung upstream promise (with `response`, default a 500 —
   * postgrest-js re-sends GETs on 503/520, which would just hang again) so
   * requests parked on a stalled upstream can finish. Returns how many. */
  releaseHung(response?: () => Response): number;
  setFault(upstream: Upstream, fault: FaultResponder | null): void;
  clearFaults(): void;
}

// ─── Seeded randomness ───────────────────────────────────────────────────────

/** mulberry32: tiny, deterministic, replayable. */
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
  ip(): string {
    return `198.51.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
  /** A slug that satisfies user_saved_drills_slug_bounds but is not in the catalog. */
  orphanSlug(): string {
    return `orphan-${this.int(0, 0xffffffff).toString(16)}`;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 1000);
export const STRESS_USERS = envInt("STRESS_USERS", 20000);
/** How long a request parked on a stalled upstream is given before the
 * harness records "no response" (the app has no client-side timeout). */
export const STRESS_HANG_MS = envInt("STRESS_HANG_MS", 1500);
/** Auth deadline the stress modules run the handler under. The production
 * default is 6 s (index.ts AUTH_UPSTREAM_TIMEOUT_MS_DEFAULT) and the deadline
 * behaviour is identical; the suite just must not spend 6 s per stalled-Auth
 * case. The handler reads the env var per request, and `deno test` runs every
 * module in one process, so the override is scoped to a test body rather than
 * set at module load (it would otherwise leak into later __wf__ modules). */
export const STRESS_AUTH_TIMEOUT_MS = 800;

export async function withAuthTimeout<T>(
  fn: () => Promise<T>,
  ms = STRESS_AUTH_TIMEOUT_MS,
): Promise<T> {
  const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(ms));
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
  }
}

/** Per-case seed: stable across runs for the same STRESS_SEED and case id. */
export function caseSeed(caseId: string, base = STRESS_SEED): number {
  return (fnv1a(`${base}:${caseId}`) ^ (base >>> 0)) >>> 0;
}

// ─── JWT helpers (unsigned — issuer routing only; verification is stubbed) ──

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(
      atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
    ) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function providerIdToken(
  sub: string,
  provider: "google" | "apple",
  ttlSeconds = 3600,
): string {
  return fakeJwt({
    iss: provider === "google"
      ? "https://accounts.google.com"
      : "https://appleid.apple.com",
    sub,
    jti: `jti-${sub}-${ttlSeconds}`,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

// ─── Redis executor (the commands cache.ts / rateLimit.ts issue) ─────────────

function redisLive(state: StressHarness, key: string): FakeRedisEntry | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

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

// ─── Harness ─────────────────────────────────────────────────────────────────

const requestContext = new AsyncLocalStorage<{ tag: string }>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function gotrueUser(session: FakeSession): Record<string, unknown> {
  return {
    id: session.userId,
    aud: "authenticated",
    role: "authenticated",
    email: session.email,
    app_metadata: { provider: session.provider, providers: [session.provider] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function upstreamOf(url: string): Upstream | null {
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "db";
  if (url.startsWith(`${REDIS_URL}/`)) return "redis";
  if (url.startsWith(RC_URL)) return "revenuecat";
  return null;
}

let harness: StressHarness | null = null;

export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (harness) {
    if (Boolean(options.redis) !== harness.redisEnabled) {
      throw new Error(
        "cache.ts fixes the Redis mode at import; load one mode per test module",
      );
    }
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "stress-anon-key");
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

  const hung: Array<
    { settle: (response: Response) => void; call: UpstreamCall }
  > = [];

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    calls: [],
    faults: {},
    faultAttempts: { auth: 0, db: 0, redis: 0, revenuecat: 0 },
    sessions: new Map(),
    savedDrills: new Map(),
    dbBackend: null,
    redis: new Map(),
    redisCommands: [],
    reset() {
      state.calls = [];
      state.faults = {};
      state.faultAttempts = { auth: 0, db: 0, redis: 0, revenuecat: 0 };
      state.sessions = new Map();
      state.savedDrills = new Map();
      state.dbBackend = null;
      state.redis = new Map();
      state.redisCommands = [];
      state.releaseHung();
    },
    callsTo(upstream, tag) {
      return state.calls.filter(
        (call) =>
          call.upstream === upstream && (tag === undefined || call.tag === tag),
      );
    },
    releaseHung(response = () => new Response(LEAK_MARKER, { status: 500 })) {
      const pending = hung.splice(0, hung.length);
      for (const entry of pending) {
        entry.call.outcome = "released";
        entry.call.endedMs = performance.now();
        entry.settle(response());
      }
      return pending.length;
    },
    setFault(upstream, fault) {
      if (fault) state.faults[upstream] = fault;
      else delete state.faults[upstream];
      state.faultAttempts[upstream] = 0;
    },
    clearFaults() {
      state.faults = {};
      state.faultAttempts = { auth: 0, db: 0, redis: 0, revenuecat: 0 };
    },
  };

  const normalAuth = (
    request: Request,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Response => {
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      const bearer = (headers["authorization"] ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      const session = state.sessions.get(bearer);
      if (!session) {
        return jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT",
        });
      }
      return jsonResponse(200, gotrueUser(session));
    }
    if (url.pathname === "/auth/v1/token" && request.method === "POST") {
      const grant = url.searchParams.get("grant_type");
      const payload = isRecord(body) ? body : {};
      if (grant !== "id_token") {
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      const idToken = typeof payload.id_token === "string"
        ? payload.id_token
        : "";
      const claims = jwtPayload(idToken);
      const sub = typeof claims?.sub === "string" ? claims.sub : "";
      const provider = payload.provider === "apple" ? "apple" : "google";
      if (!sub) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Bad ID token",
          error_code: "bad_id_token",
        });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub,
        aud: "authenticated",
        role: "authenticated",
        session_id: `minted-${sub}`,
        exp: expiresAt,
      });
      const session: FakeSession = {
        userId: sub,
        provider,
        email: `${sub}@example.com`,
      };
      state.sessions.set(accessToken, session);
      return jsonResponse(200, {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `rt-${sub}`,
        user: gotrueUser(session),
      });
    }
    if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
      return new Response(null, { status: 204 });
    }
    return new Response(`unexpected auth call: ${request.method} ${url}`, {
      status: 599,
    });
  };

  const normalDb = async (
    request: Request,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> => {
    const table = url.pathname.slice("/rest/v1/".length);
    if (table !== "user_saved_drills" || request.method !== "GET") {
      return new Response(
        `unexpected PostgREST call: ${request.method} ${url}`,
        { status: 599 },
      );
    }
    // Pin the exact query the route issues; anything else is a harness
    // failure (599), never a silently-wrong answer.
    const select = (url.searchParams.get("select") ?? "").split(",").map((s) =>
      s.trim()
    );
    const eq = url.searchParams.get("user_id") ?? "";
    const order = url.searchParams.get("order") ?? "";
    if (
      select.join(",") !== "slug,saved_at" ||
      !eq.startsWith("eq.") ||
      order !== "saved_at.desc" ||
      [...url.searchParams.keys()].some((k) =>
        !["select", "user_id", "order"].includes(k)
      )
    ) {
      return new Response(
        `unexpected saved-drills query shape: ${url.search}`,
        { status: 599 },
      );
    }
    const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const userId = eq.slice("eq.".length);
    const query: DbQuery = {
      bearerSub: (jwtPayload(bearer)?.sub as string | undefined) ?? null,
      bearer,
      userId,
      select,
      order,
    };
    let rows: SavedDrillRow[];
    if (state.dbBackend) {
      rows = await state.dbBackend(query);
    } else {
      // PostgREST + RLS: only the bearer's own rows exist for it.
      const own = query.bearerSub === userId
        ? (state.savedDrills.get(userId) ?? [])
        : [];
      rows = [...own].sort((
        a,
        b,
      ) => (a.saved_at < b.saved_at ? 1 : a.saved_at > b.saved_at ? -1 : 0));
    }
    return jsonResponse(
      200,
      rows.map((row) => ({ slug: row.slug, saved_at: row.saved_at })),
      { "Content-Range": `0-${Math.max(0, rows.length - 1)}/*` },
    );
  };

  const normalRedis = (
    headers: Record<string, string>,
    body: unknown,
  ): Response => {
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
  };

  const normalRevenueCat = (): Response =>
    jsonResponse(200, {
      request_date_ms: Date.now(),
      subscriber: { entitlements: {} },
    });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const upstream = upstreamOf(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call: UpstreamCall = {
      upstream: upstream ?? "db",
      method: request.method,
      url: request.url,
      tag: requestContext.getStore()?.tag ?? null,
      startedMs: performance.now(),
      endedMs: null,
      outcome: "pending",
      status: null,
      faulted: false,
    };
    state.calls.push(call);
    if (!upstream) {
      call.outcome = "response";
      call.status = 599;
      call.endedMs = performance.now();
      return new Response(
        `unexpected fetch in stress harness: ${request.method} ${url}`,
        {
          status: 599,
        },
      );
    }

    const normal = async (): Promise<Response> => {
      switch (upstream) {
        case "auth":
          return normalAuth(request, url, headers, body);
        case "db":
          return await normalDb(request, url, headers);
        case "redis":
          return normalRedis(headers, body);
        case "revenuecat":
          return normalRevenueCat();
      }
    };
    const hang = (honorAbort: boolean): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const entry = { settle: resolve, call };
        hung.push(entry);
        const signal = init?.signal ?? request.signal;
        if (honorAbort && signal) {
          const onAbort = () => {
            const at = hung.indexOf(entry);
            if (at >= 0) hung.splice(at, 1);
            call.outcome = "throw";
            call.endedMs = performance.now();
            reject(
              new DOMException("The signal has been aborted", "AbortError"),
            );
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });

    const fault = state.faults[upstream];
    try {
      let response: Response;
      if (fault) {
        call.faulted = true;
        state.faultAttempts[upstream] += 1;
        response = await fault({
          request,
          url,
          headers,
          body,
          attempt: state.faultAttempts[upstream],
          normal,
          hang,
        });
      } else {
        response = await normal();
      }
      if (call.outcome === "pending") {
        call.outcome = "response";
        call.endedMs = performance.now();
      }
      call.status = response.status;
      return response;
    } catch (error) {
      if (call.outcome === "pending") {
        call.outcome = "throw";
        call.endedMs = performance.now();
      }
      throw error;
    }
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const captured = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!captured) throw new Error("Deno.serve called without a handler");
    state.handler = captured;
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
  harness = state;
  return state;
}

// ─── Bearers ─────────────────────────────────────────────────────────────────

/** A Supabase access token GoTrue honours for `userId` (the post-2026-09-01
 * contract: what the app bears on every call). */
export function sessionBearer(
  state: StressHarness,
  userId: string,
  options: {
    provider?: "google" | "apple";
    ttlSeconds?: number;
    sessionId?: string;
  } = {},
): string {
  const provider = options.provider ?? "google";
  const token = fakeJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    session_id: options.sessionId ?? `session-${userId}`,
    exp: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 3600),
  });
  state.sessions.set(token, {
    userId,
    provider,
    email: `${userId}@example.com`,
  });
  return token;
}

/** A raw Google/Apple ID token: the transitional bearer of pre-contract builds. */
export function providerBearer(
  userId: string,
  provider: "google" | "apple" = "google",
): string {
  return providerIdToken(userId, provider);
}

export function savedDrillsRequest(
  token: string | null,
  options: { ip?: string; path?: string } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "203.0.113.77",
  });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request(
    `http://edge.test/functions/v1/api${options.path ?? "/v1/me/saved-drills"}`,
    {
      method: "GET",
      headers,
    },
  );
}

// ─── Driving the handler ─────────────────────────────────────────────────────

export interface RunResult {
  kind: "response";
  tag: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  latencyMs: number;
  roundTrips: Record<Upstream, number>;
  calls: UpstreamCall[];
}

export interface TimeoutResult {
  kind: "no_response";
  tag: string;
  waitedMs: number;
  roundTrips: Record<Upstream, number>;
  calls: UpstreamCall[];
  /** Resolves once the parked request finally answers (after releaseHung). */
  eventual: Promise<{ status: number; latencyMs: number }>;
}

export type Outcome = RunResult | TimeoutResult;

let tagCounter = 0;
export function nextTag(prefix = "req"): string {
  tagCounter += 1;
  return `${prefix}-${tagCounter}`;
}

function countRoundTrips(calls: UpstreamCall[]): Record<Upstream, number> {
  const counts: Record<Upstream, number> = {
    auth: 0,
    db: 0,
    redis: 0,
    revenuecat: 0,
  };
  for (const call of calls) counts[call.upstream] += 1;
  return counts;
}

/** Drive one request through the real handler, attributing every upstream
 * call it makes. Reads the whole body so latency includes serialization. */
export async function run(
  state: StressHarness,
  request: Request,
  tag = nextTag(),
): Promise<RunResult> {
  const startedAt = performance.now();
  const response = await requestContext.run(
    { tag },
    () => state.handler(request),
  );
  const text = await response.text();
  const latencyMs = performance.now() - startedAt;
  const headers: Record<string, string> = {};
  response.headers.forEach((
    value,
    key,
  ) => (headers[key.toLowerCase()] = value));
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  const calls = state.calls.filter((call) => call.tag === tag);
  return {
    kind: "response",
    tag,
    status: response.status,
    headers,
    body,
    text,
    latencyMs,
    roundTrips: countRoundTrips(calls),
    calls,
  };
}

/** Like `run`, but gives up waiting after `deadlineMs` (a request parked on a
 * stalled upstream). The parked request keeps running; `eventual` reports how
 * it ends once the harness releases the hang. */
export async function runWithDeadline(
  state: StressHarness,
  request: Request,
  deadlineMs: number,
  tag = nextTag(),
): Promise<Outcome> {
  const startedAt = performance.now();
  const pending = run(state, request, tag);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const first = await Promise.race([pending, deadline]);
  clearTimeout(timer);
  if (first !== "deadline") return first;
  const calls = state.calls.filter((call) => call.tag === tag);
  return {
    kind: "no_response",
    tag,
    waitedMs: performance.now() - startedAt,
    roundTrips: countRoundTrips(calls),
    calls,
    eventual: pending.then((result) => ({
      status: result.status,
      latencyMs: performance.now() - startedAt,
    })),
  };
}

// ─── Fault library ───────────────────────────────────────────────────────────

const pendingDelays = new Set<Promise<void>>();

/** Wait for every in-flight `faults.delay` timer (Deno's op sanitizer would
 * otherwise flag a test that answered before a slow upstream did). */
export async function drainDelays(): Promise<void> {
  while (pendingDelays.size > 0) {
    await Promise.all([...pendingDelays]);
  }
}

export const faults = {
  /** Answer every call with this HTTP status and body. */
  status(
    status: number,
    body: unknown = { code: status, message: LEAK_MARKER },
    headers: Record<string, string> = {},
  ): FaultResponder {
    return () =>
      typeof body === "string"
        ? new Response(body, { status, headers })
        : jsonResponse(status, body, headers);
  },
  /** A raw body with an explicit content type (HTML gateway page, truncated JSON…). */
  raw(
    status: number,
    body: string,
    contentType: string,
    headers: Record<string, string> = {},
  ): FaultResponder {
    return () =>
      new Response(body, {
        status,
        headers: { "Content-Type": contentType, ...headers },
      });
  },
  /** Connection-level failure: fetch rejects. */
  network(
    message = `TypeError: error sending request (${LEAK_MARKER})`,
  ): FaultResponder {
    return () => {
      throw new TypeError(message);
    };
  },
  /** Never answers. `honorAbort` = reject when the caller's AbortSignal fires. */
  hang(honorAbort = true): FaultResponder {
    return (ctx) => ctx.hang(honorAbort);
  },
  /** Answer after `ms` (healthy unless `then` is given). Timers are tracked
   * so `drainDelays()` can wait them out before a test returns. */
  delay(ms: number, then?: FaultResponder): FaultResponder {
    return async (ctx) => {
      const timer = new Promise<void>((resolve) => setTimeout(resolve, ms));
      pendingDelays.add(timer);
      try {
        await timer;
      } finally {
        pendingDelays.delete(timer);
      }
      return then ? await then(ctx) : await ctx.normal();
    };
  },
  /** The n-th call gets sequence[n-1]; calls past the sequence are healthy. */
  sequence(...steps: FaultResponder[]): FaultResponder {
    return (ctx) => {
      const step = steps[ctx.attempt - 1];
      return step ? step(ctx) : ctx.normal();
    };
  },
  /** Healthy transport, but the reply body is replaced. */
  replyWith(body: unknown, status = 200): FaultResponder {
    return () => (typeof body === "string"
      ? new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      })
      : jsonResponse(status, body));
  },
  /** Healthy Redis transport, but every command slot carries a Redis error. */
  redisCommandError(message = `ERR ${LEAK_MARKER}`): FaultResponder {
    return (ctx) => {
      const commands = Array.isArray(ctx.body) ? (ctx.body as unknown[]) : [];
      return jsonResponse(200, commands.map(() => ({ error: message })));
    };
  },
  /** Healthy Redis transport, but the pipeline reply is `keep` slots long. */
  redisTruncated(keep: number): FaultResponder {
    return async (ctx) => {
      const healthy = await ctx.normal();
      const slots = (await healthy.json()) as unknown[];
      return jsonResponse(200, slots.slice(0, keep));
    };
  },
  /** Healthy Redis transport, but every `result` is replaced by `value`. */
  redisResults(value: unknown): FaultResponder {
    return (ctx) => {
      const commands = Array.isArray(ctx.body) ? (ctx.body as unknown[]) : [];
      return jsonResponse(200, commands.map(() => ({ result: value })));
    };
  },
  /** Only calls matching `test` are faulted; the rest are healthy. */
  when(
    test: (ctx: FaultContext) => boolean,
    fault: FaultResponder,
  ): FaultResponder {
    return (ctx) => (test(ctx) ? fault(ctx) : ctx.normal());
  },
};

// ─── Reporting ───────────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencySummary(values: number[]): {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? NaN),
    meanMs: round(
      sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    ),
  };
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function memorySnapshot(): {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
} {
  const usage = Deno.memoryUsage();
  const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  };
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  // supabase/functions/api/__wf__/ → repo root.
  const root = new URL("../../../../", import.meta.url).pathname;
  return `${root}artifacts/stress-saved-drills/latest/`;
}

export async function writeJson(name: string, data: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

export function replayCommand(
  file: string,
  filter: string,
  extraEnv: Record<string, string | number> = {},
): string {
  const env = Object.entries({ STRESS_SEED, ...extraEnv })
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `cd supabase/functions/api/__wf__ && ${env} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}
