// Stress harness for `GET /v1/me/consent/status` (lens: failure injection +
// load). Boots the REAL ../index.ts in-process (Deno.serve captured, exactly
// like routesHarness.ts / sessionHarness.ts) behind ONE fake `fetch` that
// plays every upstream the function can reach:
//
//   Supabase Auth   GET  /auth/v1/user                 (bearer verification)
//   PostgREST       GET  /rest/v1/consent_records      (the route's only DB read)
//   Upstash Redis   POST /pipeline                     (L2 cache + shared limits;
//                                                       only when booted with redis)
//   RevenueCat      https://api.revenuecat.com/…       (never on this route)
//
// Every upstream can be made to fail / hang / answer garbage by queueing
// `Fault`s; every upstream call is recorded with timing so a request's
// Supabase round-trip count is exact. Nothing here talks to a network.
//
// Deterministic: users, bearers and consent ledgers derive from a mulberry32
// PRNG seeded by STRESS_SEED (default 20260904); every campaign iteration is
// replayable from its seed. Campaign sizes come from STRESS_ITER /
// STRESS_USERS (small defaults keep the suite fast; the full campaign is
// STRESS_ITER=1000 STRESS_USERS=20000).
//
// cache.ts reads UPSTASH_* at import time, so a Redis-enabled boot needs its
// own test module (see stress_consent_status_redis.test.ts).

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
export const ROUTE_PATH = "/v1/me/consent/status";

// ─── env / seed ──────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Requests in the load campaign (full campaign: 1000). */
export const STRESS_ITER = envInt("STRESS_ITER", 200);
/** Distinct users in the L1-memory campaign (full campaign: 20000). */
export const STRESS_USERS = envInt("STRESS_USERS", 2000);
/** When set, invariants tagged as known findings are asserted too. */
export const STRESS_STRICT = Deno.env.get("STRESS_STRICT") === "1";
/** Comma-separated fault-case ids to run alone (e.g. `STRESS_CASE=D23,D25`); empty = all. */
export const STRESS_CASE: ReadonlySet<string> = new Set(
  (Deno.env.get("STRESS_CASE") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

/** mulberry32 — deterministic, tiny, replayable. */
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
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── model ───────────────────────────────────────────────────────────────────

export interface StressUser {
  id: string;
  email: string;
  provider: "google" | "apple";
  sessionId: string;
  /** Supabase-issued access token (the bearer every route takes). */
  accessToken: string;
  ip: string;
}

export interface LedgerRow {
  id: string;
  user_id: string;
  scope: string;
  action: string;
  consent_version: string | null;
  created_at: string;
}

export interface ScopeStatus {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: "granted" | "withdrawn" | null;
  lastActionAt: string | null;
}

export interface ConsentStatusBody {
  subjectPseudonym: null;
  scopes: ScopeStatus[];
}

/** The status the route MUST report for a ledger (spec: index.ts comment
 * above foldConsentStatus — every scope present, missing = inactive, latest
 * action per scope wins, ledger ordered created_at then id). */
export function oracleFold(rows: LedgerRow[]): ConsentStatusBody {
  const ordered = postgrestOrder(rows);
  return {
    subjectPseudonym: null,
    scopes: CONSENT_SCOPES.map((scope) => {
      const mine = ordered.filter((r) => r.scope === scope);
      const last = mine.length > 0 ? mine[mine.length - 1] : null;
      return {
        scope,
        active: last?.action === "grant",
        consentVersion: last?.consent_version ?? null,
        lastAction: last === null ? null : last.action === "grant" ? "granted" : "withdrawn",
        lastActionAt: last?.created_at ?? null,
      };
    }),
  };
}

/** PostgREST's `order=created_at.asc,id.asc` over ISO timestamps + uuids. */
export function postgrestOrder(rows: LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) =>
    a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
}

const BASE_MS = Date.UTC(2026, 0, 1);

/** A seeded consent ledger: 0..maxRows rows across the three real scopes plus
 * an occasional unknown scope, duplicate timestamps (so `id` breaks ties),
 * null and versioned grants, withdraw rows carrying the version forward. */
export function seededLedger(prng: Prng, userId: string, maxRows = 12): LedgerRow[] {
  const count = prng.int(0, maxRows);
  const rows: LedgerRow[] = [];
  let t = BASE_MS + prng.int(0, 90) * 86_400_000;
  for (let i = 0; i < count; i += 1) {
    if (!prng.chance(0.2)) t += prng.int(1, 3_600_000);
    const scope = prng.chance(0.08)
      ? prng.pick(["marketing", "", "VIDEO_ANALYSIS"])
      : prng.pick(CONSENT_SCOPES);
    const action = prng.chance(0.6) ? "grant" : "withdraw";
    rows.push({
      id: prng.uuid(),
      user_id: userId,
      scope,
      action,
      consent_version: prng.chance(0.15) ? null : `2026-0${prng.int(1, 9)}`,
      created_at: new Date(t).toISOString(),
    });
  }
  return rows;
}

export function seededUser(prng: Prng, index: number, ttlSeconds = 3600): StressUser {
  const id = prng.uuid();
  const provider = prng.chance(0.5) ? "google" : "apple";
  const sessionId = prng.uuid();
  return {
    id,
    email: `u${index}@example.com`,
    provider,
    sessionId,
    accessToken: fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: id,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: prng.uuid(),
    }),
    ip: `203.0.${prng.int(0, 255)}.${prng.int(1, 254)}`,
  };
}

// ─── faults ──────────────────────────────────────────────────────────────────

export type Upstream = "auth" | "postgrest" | "redis" | "revenuecat";

export type FaultSpec =
  /** An HTTP answer (any status, any body; `json` is serialized). */
  | {
      kind: "http";
      status: number;
      body?: string;
      json?: unknown;
      headers?: Record<string, string>;
    }
  /** Never answers; rejects with AbortError when the caller aborts. When
   * `resolveAfterMs` is set the answer arrives that late (a stall, not a
   * black hole). */
  | { kind: "hang"; resolveAfterMs?: number; then?: FaultSpec }
  /** A socket-level failure (fetch rejects with TypeError). */
  | { kind: "network"; message?: string }
  /** Answer normally after `ms`. */
  | { kind: "slow"; ms: number }
  /** Answer normally (an explicit no-fault slot for sequences). */
  | { kind: "pass" };

export interface Fault {
  upstream: Upstream;
  spec: FaultSpec;
  /** How many matching calls this fault consumes (default 1). */
  times?: number;
  /** Only calls whose URL contains this fragment (default: any call). */
  urlIncludes?: string;
  /** Redis only: only pipelines containing a command starting with this op
   * (e.g. "SET", "INCR"). */
  redisOp?: string;
}

export interface UpstreamCall {
  seq: number;
  upstream: Upstream;
  method: string;
  url: string;
  startedMs: number;
  durationMs: number;
  /** HTTP status returned, or "hang" / "network" / "abort". */
  outcome: string;
  fault?: FaultSpec["kind"];
  redisOps?: string[];
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  calls: UpstreamCall[];
  /** Queue a fault (FIFO per upstream). */
  inject(fault: Fault): void;
  /** Drop every queued fault. */
  clearFaults(): void;
  users: Map<string, StressUser>;
  ledgers: Map<string, LedgerRow[]>;
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  /** Server-side `[api] …` error lines the function logged (console.error). */
  errorLog: string[];
  /** Access-log lines the function emitted. */
  accessLog: string[];
  /** Register a user so Auth and PostgREST know it. */
  addUser(user: StressUser, ledger?: LedgerRow[]): void;
  /** Replace the modelled PostgREST with a real backend (the docker
   * Postgres test translates the captured query into SQL). Faults still
   * apply in front of it. */
  postgrestBackend: ((request: Request, parsed: URL) => Promise<Response>) | null;
  /** Fresh model (users, ledgers, redis, calls, faults) — the function's own
   * L1 caches persist, exactly as in a long-lived isolate. */
  reset(): void;
  /** Run one request and return the slice of upstream calls it made. */
  request(req: Request): Promise<{ response: Response; calls: UpstreamCall[]; latencyMs: number }>;
}

let booted: StressHarness | null = null;

/** The console before boot swaps console.warn/error for the evidence log. */
const report: (line: string) => void = console.warn.bind(console);

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const gotrueUser = (user: StressUser) => ({
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

function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Turn a FaultSpec into an answer (or a rejection); `real` produces the
 * healthy answer for "slow"/"pass". */
async function applyFault(
  spec: FaultSpec,
  signal: AbortSignal | null,
  real: () => Response | Promise<Response>,
): Promise<Response> {
  switch (spec.kind) {
    case "http": {
      const body = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.body ?? "");
      return new Response(body, {
        status: spec.status,
        headers: { "Content-Type": "application/json", ...(spec.headers ?? {}) },
      });
    }
    case "hang": {
      if (spec.resolveAfterMs === undefined) {
        await new Promise<never>((_, reject) => {
          if (signal?.aborted) return reject(abortError());
          signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      await sleep(spec.resolveAfterMs ?? 0, signal);
      return spec.then ? applyFault(spec.then, signal, real) : real();
    }
    case "network":
      throw new TypeError(spec.message ?? "error sending request: connection reset");
    case "slow":
      await sleep(spec.ms, signal);
      return real();
    case "pass":
      return real();
  }
}

export function requestFor(user: StressUser, headers: Record<string, string> = {}): Request {
  return new Request(`http://edge.test/functions/v1/api${ROUTE_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      "x-forwarded-for": user.ip,
      ...headers,
    },
  });
}

export function rawRequest(
  token: string | null,
  ip: string,
  headers: Record<string, string> = {},
): Request {
  const h: Record<string, string> = { "x-forwarded-for": ip, ...headers };
  if (token !== null) h.Authorization = `Bearer ${token}`;
  return new Request(`http://edge.test/functions/v1/api${ROUTE_PATH}`, {
    method: "GET",
    headers: h,
  });
}

/** Boot the real edge function once per test module. */
export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<StressHarness> {
  if (booted) {
    if (Boolean(options.redis) !== booted.redisEnabled) {
      throw new Error("the Redis choice is fixed at first boot (cache.ts reads env at import)");
    }
    booted.reset();
    return booted;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  for (const key of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
    "AUTH_UPSTREAM_TIMEOUT_MS",
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

  const faults: Fault[] = [];
  let seq = 0;

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    calls: [],
    inject(fault) {
      faults.push({ ...fault, times: fault.times ?? 1 });
    },
    clearFaults() {
      faults.length = 0;
    },
    users: new Map(),
    ledgers: new Map(),
    redis: new Map(),
    redisCommands: [],
    errorLog: [],
    accessLog: [],
    postgrestBackend: null,
    addUser(user, ledger = []) {
      state.users.set(user.id, user);
      state.ledgers.set(user.id, ledger);
    },
    reset() {
      state.calls = [];
      faults.length = 0;
      state.users = new Map();
      state.ledgers = new Map();
      state.redis = new Map();
      state.redisCommands = [];
      state.errorLog = [];
      state.accessLog = [];
      state.postgrestBackend = null;
    },
    async request(req) {
      const before = state.calls.length;
      const t0 = performance.now();
      const response = await state.handler(req);
      const latencyMs = performance.now() - t0;
      return { response, calls: state.calls.slice(before), latencyMs };
    },
  };

  const takeFault = (
    upstream: Upstream,
    url: string,
    redisOps: string[] | null,
  ): FaultSpec | null => {
    const index = faults.findIndex(
      (f) =>
        f.upstream === upstream &&
        (f.urlIncludes === undefined || url.includes(f.urlIncludes)) &&
        (f.redisOp === undefined || (redisOps ?? []).some((op) => op === f.redisOp)),
    );
    if (index < 0) return null;
    const fault = faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) faults.splice(index, 1);
    return fault.spec;
  };

  const bearerOf = (request: Request): string =>
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  const userForBearer = (bearer: string): StressUser | null => {
    const sub = jwtPayload(bearer)?.sub;
    return typeof sub === "string" ? (state.users.get(sub) ?? null) : null;
  };

  const realAuthUser = (request: Request): Response => {
    const user = userForBearer(bearerOf(request));
    if (!user) {
      return jsonResponse(401, {
        code: 401,
        msg: "invalid JWT: session not found",
        error_code: "bad_jwt",
      });
    }
    return jsonResponse(200, gotrueUser(user));
  };

  const realPostgrest = (request: Request, parsed: URL): Response => {
    const table = parsed.pathname.slice("/rest/v1/".length);
    if (table !== "consent_records" || request.method !== "GET") {
      return jsonResponse(404, {
        code: "PGRST205",
        message: `stress stub: no ${request.method} ${table}`,
      });
    }
    const user = userForBearer(bearerOf(request));
    // RLS: an unknown bearer sees nothing.
    const owned = user ? (state.ledgers.get(user.id) ?? []) : [];
    const eq = parsed.searchParams.get("user_id") ?? "";
    const filtered = eq.startsWith("eq.") ? owned.filter((r) => r.user_id === eq.slice(3)) : owned;
    const select = (parsed.searchParams.get("select") ?? "*").split(",").map((s) => s.trim());
    const order = parsed.searchParams.get("order") ?? "";
    const ordered = order === "created_at.asc,id.asc" ? postgrestOrder(filtered) : [...filtered];
    const projected = ordered.map((row) => {
      if (select.includes("*")) return row;
      const out: Record<string, unknown> = {};
      for (const col of select) out[col] = (row as unknown as Record<string, unknown>)[col];
      return out;
    });
    return jsonResponse(200, projected);
  };

  const redisLive = (key: string): FakeRedisEntry | null => {
    const entry = state.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      state.redis.delete(key);
      return null;
    }
    return entry;
  };

  const runRedisCommand = (
    command: Array<string | number>,
  ): { result?: unknown; error?: string } => {
    state.redisCommands.push(command);
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: redisLive(args[0])?.value ?? null };
      case "TTL": {
        const entry = redisLive(args[0]);
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
        if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const parsed = new URL(url);
    const signal = init?.signal ?? request.signal ?? null;
    let upstream: Upstream;
    let real: () => Response | Promise<Response>;
    let redisOps: string[] | null = null;
    if (url === `${REDIS_URL}/pipeline`) {
      upstream = "redis";
      const text = await request.text().catch(() => "");
      let commands: Array<Array<string | number>> = [];
      try {
        const parsedBody = JSON.parse(text) as unknown;
        commands = Array.isArray(parsedBody) ? (parsedBody as Array<Array<string | number>>) : [];
      } catch {
        commands = [];
      }
      redisOps = commands.map((c) => String(c[0]));
      real = () => {
        if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
          return jsonResponse(401, { error: "Unauthorized" });
        }
        return jsonResponse(
          200,
          commands.map((command) => runRedisCommand(command)),
        );
      };
    } else if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      upstream = "auth";
      real = () => realAuthUser(request);
    } else if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      upstream = "auth";
      real = () => jsonResponse(400, { error: "unsupported_grant_type", msg: "stress stub" });
    } else if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      upstream = "postgrest";
      real = () =>
        state.postgrestBackend
          ? state.postgrestBackend(request, parsed)
          : realPostgrest(request, parsed);
    } else if (url.startsWith(RC_URL)) {
      upstream = "revenuecat";
      real = () => jsonResponse(200, { subscriber: { entitlements: {}, subscriptions: {} } });
    } else {
      return new Response(`unexpected fetch in stress test: ${request.method} ${url}`, {
        status: 599,
      });
    }

    const call: UpstreamCall = {
      seq: seq++,
      upstream,
      method: request.method,
      url,
      startedMs: performance.now(),
      durationMs: 0,
      outcome: "",
    };
    if (redisOps) call.redisOps = redisOps;
    state.calls.push(call);
    const spec = takeFault(upstream, url, redisOps);
    if (spec) call.fault = spec.kind;
    try {
      const response = spec ? await applyFault(spec, signal, real) : await real();
      call.outcome = String(response.status);
      return response;
    } catch (error) {
      call.outcome =
        error instanceof DOMException && error.name === "AbortError" ? "abort" : "network";
      throw error;
    } finally {
      call.durationMs = performance.now() - call.startedMs;
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

  // Server-side detail goes to console.error; keep it as evidence instead of
  // flooding the test output (20k requests would print 20k lines).
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...parts: unknown[]) => {
    state.errorLog.push(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" "));
  };
  console.warn = (...parts: unknown[]) => {
    state.errorLog.push(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" "));
  };
  captureAccessLog((line) => {
    state.accessLog.push(line);
  });
  globalThis.addEventListener("unload", () => {
    console.error = realError;
    console.warn = realWarn;
  });

  await import("../index.ts");
  booted = state;
  return state;
}

// ─── outcome recording ───────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
  /** A known finding: reported, not asserted (unless STRESS_STRICT=1). */
  finding?: string;
}

export interface CaseOutcome {
  id: string;
  seed: number;
  title: string;
  upstream: Upstream | "route" | "mixed";
  fault: string;
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  latencyMs: number;
  supabaseRoundTrips: number;
  authCalls: number;
  postgrestCalls: number;
  redisCalls: number;
  revenuecatCalls: number;
  /** User-visible error class the case landed in. */
  errorClass:
    | "ok"
    | "credential_refused"
    | "retryable_unavailable"
    | "rate_limited"
    | "server_error"
    | "other";
  recoverable: boolean | null;
  expected: string;
  verdict: "HELD" | "BROKEN";
  detail: string;
  replay: string;
}

export function classify(
  status: number,
  code: string | null,
  retryAfter: string | null,
): CaseOutcome["errorClass"] {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "credential_refused";
  if (status === 429 || code === "rate_limited") return "rate_limited";
  if (status === 503) return "retryable_unavailable";
  if (status === 500) return "server_error";
  return retryAfter ? "retryable_unavailable" : "other";
}

export async function readError(
  response: Response,
): Promise<{ code: string | null; message: string | null; raw: string }> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    return {
      code: typeof parsed?.error?.code === "string" ? parsed.error.code : null,
      message: typeof parsed?.error?.message === "string" ? parsed.error.message : null,
      raw,
    };
  } catch {
    return { code: null, message: null, raw };
  }
}

export function countBy(calls: UpstreamCall[], upstream: Upstream): number {
  return calls.filter((c) => c.upstream === upstream).length;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-consent-status/latest/", import.meta.url).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

/** `--filter` selects a top-level test; a single fault case is picked with STRESS_CASE. */
export function replayCommand(
  file: string,
  filter: string,
  seed = STRESS_SEED,
  caseId?: string,
): string {
  const pick = caseId ? `STRESS_CASE=${caseId} STRESS_STRICT=1 ` : "";
  return `${pick}STRESS_SEED=${seed} STRESS_ITER=${STRESS_ITER} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

/** Assert every non-finding invariant; print findings. */
export function assertInvariants(invariants: Invariant[], label: string): void {
  const broken = invariants.filter((i) => !i.holds);
  for (const i of broken) {
    report(`[stress] ${label}: ${i.finding ? "FINDING" : "BROKEN"} ${i.name} — ${i.detail}`);
  }
  const fatal = broken.filter((i) => !i.finding || STRESS_STRICT);
  if (fatal.length > 0) {
    throw new Error(
      `${label}: ${fatal.length} invariant(s) broken:\n` +
        fatal.map((i) => `  - ${i.name}: ${i.detail}`).join("\n"),
    );
  }
}
