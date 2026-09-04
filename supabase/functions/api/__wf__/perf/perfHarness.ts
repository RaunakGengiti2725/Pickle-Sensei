// Performance harness for the production Edge Function (supabase/functions/api).
//
// Boots the REAL handler (index.ts → Deno.serve, captured) in-process behind a
// fetch stub that classifies and counts every outbound round trip:
//
//   supabase_auth   $SUPABASE_URL/auth/v1/*   (signInWithIdToken, getUser, refresh, logout, admin)
//   supabase_rest   $SUPABASE_URL/rest/v1/*   (PostgREST tables + RPCs)
//   redis           $UPSTASH_REDIS_REST_URL/pipeline (L2 cache + shared rate limits)
//   revenuecat      https://api.revenuecat.com/*
//   other           anything else (Apple, unexpected)
//
// Unlike routesHarness.ts this loader can boot with Upstash CONFIGURED (an
// in-memory Redis emulation answers the pipeline protocol), and it can inject
// deterministic per-class latency so round trips translate into wall time.
// The PostgREST stub applies eq./in. filters, Range paging and
// `Prefer: return=representation` so every route's happy path is reachable
// from one shared fixture set.
//
// Every value here is a stub — nothing touches a hosted Supabase project.
// Numbers produced with injected latency are SIMULATED and labelled as such.

import { AsyncLocalStorage } from "node:async_hooks";

export const SUPABASE_URL = "https://perf-stub.supabase.local";
export const REDIS_URL = "https://perf-redis.upstash.local";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers";
export const WEBHOOK_SECRET = "perf-webhook-secret";

export type UpstreamClass = "supabase_auth" | "supabase_rest" | "redis" | "revenuecat" | "other";

export interface RecordedCall {
  cls: UpstreamClass;
  /** Stable label: `<METHOD> <path>` with query and ids stripped. */
  label: string;
  method: string;
  url: string;
  requestBytes: number;
  responseBytes: number;
  /** Redis pipeline commands (redis class only). */
  commands?: string[];
}

export interface LatencyProfile {
  supabase_auth: number;
  supabase_rest: number;
  redis: number;
  revenuecat: number;
  other: number;
}

export const ZERO_LATENCY: LatencyProfile = {
  supabase_auth: 0,
  supabase_rest: 0,
  redis: 0,
  revenuecat: 0,
  other: 0,
};

/** Plausible same-region numbers used ONLY to show how round trips compound.
 * They are not measurements of the hosted platform. */
export const SIMULATED_LATENCY: LatencyProfile = {
  supabase_auth: 60,
  supabase_rest: 20,
  redis: 3,
  revenuecat: 150,
  other: 50,
};

export interface HarnessOptions {
  redis: boolean;
  latency: LatencyProfile;
}

export interface Fixtures {
  /** Rows by PostgREST table/view name. Filters `eq.`/`in.` apply to any
   * column present on the row. */
  tables: Record<string, Array<Record<string, unknown>>>;
  /** Table → row producer from the request's query (takes precedence over
   * `tables`). Lets a stub echo the id the function asked for, so ownership
   * checks succeed for every deterministic id without materialising rows. */
  resolvers: Record<
    string,
    (params: URLSearchParams, method: string) => Array<Record<string, unknown>>
  >;
  /** RPC name → response body (array or scalar), or a function of args. */
  rpcs: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  /** RevenueCat subscriber body returned for every GET. */
  subscriber: Record<string, unknown>;
  /** L2 entries written after the Redis reset that precedes each scenario. */
  redisSeed: Array<{ key: string; value: string; ttlSeconds: number }>;
}

/** Per-request attribution under concurrency: run the handler inside
 * `callContext.run(list, …)` and every upstream call made on behalf of that
 * request (through supabase-js, cache.ts, rateLimit.ts, raw fetch) lands in
 * `list`. `drain()` still returns the global sequence for cross-checks. */
export const callContext = new AsyncLocalStorage<RecordedCall[]>();

export interface PerfHarness {
  handler: (request: Request) => Promise<Response>;
  options: HarnessOptions;
  fixtures: Fixtures;
  /** Calls recorded since the last `drain()`. */
  drain(): RecordedCall[];
  /** Total calls recorded since boot, by class. */
  totals: Record<UpstreamClass, number>;
  /** Console lines swallowed while `quiet` is on (index.ts logs on 5xx). */
  consoleLines: { error: number; warn: number; log: number };
  setQuiet(quiet: boolean): void;
  /** Wipe the emulated Redis (L2). L1 memory inside index.ts is NOT reachable. */
  resetRedis(): void;
  /** Pre-populate the emulated Redis so a request can take the L2-hit path
   * (L1 miss → Redis GET/TTL hit → no PostgREST). */
  seedRedis(key: string, value: string, ttlSeconds: number): void;
}

// ─── Deterministic identities ────────────────────────────────────────────────

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** FNV-1a 32-bit — cheap, deterministic, dependency-free. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** RFC-4122-shaped UUID derived from a seed string (version nibble 4,
 * variant 10xx) so `isUuid()` in the function accepts it. */
export function seededUuid(seed: string): string {
  const parts: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    parts.push(fnv1a(`${seed}:${i}`).toString(16).padStart(8, "0"));
  }
  const hex = parts.join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

export function userIdFor(seed: string, index: number): string {
  return seededUuid(`${seed}:user:${index}`);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/** Frozen at import so a (userId, nonce) pair always yields the SAME token
 * bytes for the life of the process — otherwise the auth cache key (a hash of
 * the bearer) would silently change whenever the wall clock ticked a second. */
const TOKEN_ISSUED_AT = nowSeconds();
const TOKEN_EXPIRES_AT = TOKEN_ISSUED_AT + 3600;

/** Unsigned Google ID token whose `sub` maps to `userId` in the Auth stub. */
export function googleIdToken(userId: string, nonce = ""): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: userId,
      aud: "perf",
      exp: TOKEN_EXPIRES_AT,
      iat: TOKEN_ISSUED_AT,
      nonce,
    }),
  );
  return `${header}.${payload}.${b64url("sig")}`;
}

/** Unsigned Supabase-issued access token (iss ends with /auth/v1) for the
 * post-bootstrap contract: authenticate() verifies it with getUser(). */
export function sessionToken(userId: string, nonce = ""): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      exp: TOKEN_EXPIRES_AT,
      iat: TOKEN_ISSUED_AT,
      session_id: nonce || userId,
    }),
  );
  return `${header}.${payload}.${b64url("sig")}`;
}

function decodeSub(token: string): string | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const sub = JSON.parse(atob(padded)).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

// ─── Request builders ────────────────────────────────────────────────────────

export interface RequestSpec {
  method: string;
  path: string;
  token?: string;
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export function buildRequest(spec: RequestSpec): { request: Request; requestBytes: number } {
  const headers = new Headers({ "x-forwarded-for": spec.ip ?? "203.0.113.20", ...spec.headers });
  if (spec.token) headers.set("Authorization", `Bearer ${spec.token}`);
  let body: string | undefined;
  if (spec.body !== undefined) {
    body = JSON.stringify(spec.body);
    headers.set("Content-Type", "application/json");
    headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  }
  const request = new Request(`http://edge.perf/functions/v1/api${spec.path}`, {
    method: spec.method,
    headers,
    body,
  });
  return { request, requestBytes: body ? new TextEncoder().encode(body).byteLength : 0 };
}

// ─── Fixture defaults ────────────────────────────────────────────────────────

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

export function activeSubscriber(premium: boolean): Record<string, unknown> {
  return {
    entitlements: premium
      ? {
          pickle_sensei_pro: {
            expires_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            product_identifier: "pickle_sensei_pro_monthly",
          },
        }
      : {},
  };
}

export function defaultFixtures(): Fixtures {
  return {
    tables: {},
    resolvers: {},
    rpcs: {
      access_state: [{ premium: false, scored_count: 0, reserved_count: 0 }],
      reserve_analysis_permit: (args: Record<string, unknown>) => [
        {
          result: "accepted",
          permit_id: seededUuid(`permit:${String(args.p_idempotency_key ?? "")}`),
          permit_status: "reserved",
          permit_outcome: null,
          permit_created_at: new Date().toISOString(),
        },
      ],
      apply_synced_shot: "accepted",
    },
    subscriber: activeSubscriber(false),
    redisSeed: [],
  };
}

// ─── In-memory Redis (Upstash REST pipeline subset) ──────────────────────────

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

class MemoryRedis {
  readonly store = new Map<string, RedisEntry>();

  private live(key: string): RedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  run(command: Array<string | number>): { result: unknown } | { error: string } {
    const [op, ...rest] = command.map(String);
    switch (op.toUpperCase()) {
      case "GET":
        return { result: this.live(rest[0])?.value ?? null };
      case "TTL": {
        const entry = this.live(rest[0]);
        if (!entry) return { result: -2 };
        if (entry.expiresAtMs === null) return { result: -1 };
        return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
      }
      case "SET": {
        const [key, value, ...opts] = rest;
        let expiresAtMs: number | null = null;
        const exIndex = opts.findIndex((o) => o.toUpperCase() === "EX");
        if (exIndex >= 0) expiresAtMs = Date.now() + Number(opts[exIndex + 1]) * 1000;
        this.store.set(key, { value, expiresAtMs });
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;
        for (const key of rest) if (this.store.delete(key)) removed += 1;
        return { result: removed };
      }
      case "INCR": {
        const entry = this.live(rest[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.store.set(rest[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.live(rest[0]);
        if (!entry) return { result: 0 };
        const nx = rest.slice(2).some((o) => o.toUpperCase() === "NX");
        if (nx && entry.expiresAtMs !== null) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(rest[1]) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }
}

// ─── PostgREST emulation ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesFilters(row: Record<string, unknown>, params: URLSearchParams): boolean {
  for (const [column, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(column)) continue;
    if (!(column in row)) continue;
    const value = String(row[column]);
    if (raw.startsWith("eq.")) {
      if (value !== raw.slice(3)) return false;
    } else if (raw.startsWith("in.(")) {
      const wanted = raw
        .slice(4, -1)
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""));
      if (!wanted.includes(value)) return false;
    }
  }
  return true;
}

/** postgrest-js `range(from, to)` / `limit(n)` travel as `offset` + `limit`
 * query params (verified in @supabase/postgrest-js dist: `range()` sets
 * searchParams offset/limit); a raw `Range` header is honoured too. */
function applyRange(rows: unknown[], params: URLSearchParams, headers: Headers): unknown[] {
  const offsetParam = params.get("offset");
  const limitParam = params.get("limit");
  if (offsetParam !== null || limitParam !== null) {
    const offset = Math.max(0, Number(offsetParam ?? 0) || 0);
    const limit = limitParam === null ? Infinity : Math.max(0, Number(limitParam) || 0);
    return rows.slice(offset, limit === Infinity ? undefined : offset + limit);
  }
  const range = headers.get("range");
  if (!range) return rows;
  const [fromRaw, toRaw] = range.split("-");
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return rows;
  return rows.slice(from, to + 1);
}

function pgrstResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function respondPostgrest(
  fixtures: Fixtures,
  request: Request,
  bodyText: string,
  url: URL,
): Response {
  const target = url.pathname.slice("/rest/v1/".length);
  const accept = request.headers.get("accept") ?? "";
  const prefer = request.headers.get("prefer") ?? "";
  const wantsObject = accept.includes("application/vnd.pgrst.object+json");
  const wantsRepresentation = prefer.includes("return=representation");

  if (target.startsWith("rpc/")) {
    const fn = target.slice("rpc/".length);
    const stub = fixtures.rpcs[fn];
    if (stub === undefined) {
      return pgrstResponse(404, { code: "PGRST202", message: `rpc ${fn} not stubbed` });
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bodyText);
      if (isRecord(parsed)) args = parsed;
    } catch {
      // no args
    }
    const value = typeof stub === "function" ? stub(args) : stub;
    return pgrstResponse(200, value);
  }

  const resolver = fixtures.resolvers[target];
  const rows = resolver
    ? resolver(url.searchParams, request.method)
    : (fixtures.tables[target] ?? []).filter((row) => matchesFilters(row, url.searchParams));

  if (request.method === "GET") {
    if (wantsObject) {
      if (rows.length === 0) {
        return pgrstResponse(406, {
          code: "PGRST116",
          message: "0 rows",
          details: null,
          hint: null,
        });
      }
      return pgrstResponse(200, rows[0]);
    }
    return pgrstResponse(200, applyRange(rows, url.searchParams, request.headers));
  }

  if (request.method === "POST") {
    if (!wantsRepresentation) return new Response(null, { status: 201 });
    let inserted: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bodyText);
      inserted = isRecord(parsed)
        ? parsed
        : Array.isArray(parsed) && isRecord(parsed[0])
          ? parsed[0]
          : {};
    } catch {
      // empty
    }
    const row = {
      id: seededUuid(`inserted:${target}:${bodyText}`),
      created_at: new Date().toISOString(),
      ...inserted,
    };
    return pgrstResponse(201, wantsObject ? row : [row]);
  }

  if (request.method === "PATCH") {
    if (!wantsRepresentation) return new Response(null, { status: 204 });
    let patch: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bodyText);
      if (isRecord(parsed)) patch = parsed;
    } catch {
      // empty
    }
    const updated = rows.map((row) => ({ ...row, ...patch }));
    if (wantsObject) {
      if (updated.length === 0) {
        return pgrstResponse(406, {
          code: "PGRST116",
          message: "0 rows",
          details: null,
          hint: null,
        });
      }
      return pgrstResponse(200, updated[0]);
    }
    return pgrstResponse(200, updated);
  }

  if (request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return pgrstResponse(405, { message: `unsupported ${request.method}` });
}

// ─── Supabase Auth emulation ─────────────────────────────────────────────────

function authUser(userId: string): Record<string, unknown> {
  return {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: `${userId.slice(0, 8)}@example.com`,
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function authSession(userId: string, nonce: string): Record<string, unknown> {
  return {
    access_token: sessionToken(userId, nonce),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: nowSeconds() + 3600,
    refresh_token: `refresh-${nonce}`,
    user: authUser(userId),
  };
}

function respondAuth(request: Request, bodyText: string, url: URL): Response {
  const path = url.pathname.slice("/auth/v1".length);
  if (path === "/token") {
    const grant = url.searchParams.get("grant_type") ?? "";
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bodyText);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      // empty
    }
    if (grant === "id_token") {
      const sub = decodeSub(String(payload.id_token ?? ""));
      if (!sub) return pgrstResponse(400, { error: "invalid id_token" });
      return pgrstResponse(200, authSession(sub, `idt-${fnv1a(String(payload.id_token))}`));
    }
    if (grant === "refresh_token") {
      const refresh = String(payload.refresh_token ?? "");
      const sub = seededUuid(`refresh-owner:${refresh}`);
      return pgrstResponse(200, authSession(sub, `rt-${fnv1a(refresh)}`));
    }
    return pgrstResponse(400, { error: `unsupported grant ${grant}` });
  }
  if (path === "/user" && request.method === "GET") {
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const sub = decodeSub(bearer);
    if (!sub) return pgrstResponse(401, { message: "invalid JWT" });
    return pgrstResponse(200, authUser(sub));
  }
  if (path === "/logout") {
    return new Response(null, { status: 204 });
  }
  if (path.startsWith("/admin/users/") && request.method === "DELETE") {
    return pgrstResponse(200, {});
  }
  return pgrstResponse(404, { message: `auth path not stubbed: ${request.method} ${path}` });
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function labelFor(cls: UpstreamClass, method: string, url: URL, commands?: string[]): string {
  if (cls === "redis") return `REDIS ${commands?.join("+") ?? "pipeline"}`;
  if (cls === "supabase_rest") {
    const target = url.pathname.slice("/rest/v1/".length);
    return `${method} rest/${target}`;
  }
  if (cls === "supabase_auth") {
    const grant = url.searchParams.get("grant_type");
    const path = url.pathname.slice("/auth/v1/".length).replace(UUID_RE, ":id");
    return `${method} auth/${path}${grant ? `?grant_type=${grant}` : ""}`;
  }
  if (cls === "revenuecat") {
    return `${method} revenuecat/subscribers/:id`;
  }
  return `${method} ${url.host}${url.pathname.replace(UUID_RE, ":id")}`;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

let booted: PerfHarness | null = null;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Boot once per process. Redis on/off is decided at boot because cache.ts
 * reads the Upstash secrets at module evaluation. */
export async function bootPerfHarness(options: HarnessOptions): Promise<PerfHarness> {
  if (booted) {
    if (booted.options.redis !== options.redis) {
      throw new Error("perf harness already booted with a different redis setting");
    }
    booted.options.latency = options.latency;
    return booted;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-perf-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-perf-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_perf_revenuecat");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "perf-redis-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const redis = new MemoryRedis();
  const fixtures = defaultFixtures();
  let pending: RecordedCall[] = [];
  const totals: Record<UpstreamClass, number> = {
    supabase_auth: 0,
    supabase_rest: 0,
    redis: 0,
    revenuecat: 0,
    other: 0,
  };
  const consoleLines = { error: 0, warn: 0, log: 0 };

  // index.ts writes its structured api_request line via console.log; the
  // harness counts (and can silence) every level, so it patches the console
  // object itself rather than calling the methods.
  const patched = globalThis.console;
  const realConsole = { error: patched.error, warn: patched.warn, log: patched.log };
  let quiet = false;
  patched.error = (...args: unknown[]) => {
    consoleLines.error += 1;
    if (!quiet) realConsole.error(...args);
  };
  patched.warn = (...args: unknown[]) => {
    consoleLines.warn += 1;
    if (!quiet) realConsole.warn(...args);
  };
  patched.log = (...args: unknown[]) => {
    consoleLines.log += 1;
    if (!quiet) realConsole.log(...args);
  };

  const encoder = new TextEncoder();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const bodyText = await request.text().catch(() => "");
    let cls: UpstreamClass = "other";
    let response: Response;
    let commands: string[] | undefined;

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      cls = "supabase_auth";
      response = respondAuth(request, bodyText, url);
    } else if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      cls = "supabase_rest";
      response = respondPostgrest(fixtures, request, bodyText, url);
    } else if (url.origin === REDIS_URL) {
      cls = "redis";
      let batch: Array<Array<string | number>> = [];
      try {
        const parsed = JSON.parse(bodyText);
        if (Array.isArray(parsed)) batch = parsed as Array<Array<string | number>>;
      } catch {
        // empty pipeline
      }
      commands = batch.map((cmd) => String(cmd[0]).toUpperCase());
      response = pgrstResponse(
        200,
        batch.map((cmd) => redis.run(cmd)),
      );
    } else if (url.href.startsWith(RC_URL)) {
      cls = "revenuecat";
      response =
        request.method === "DELETE"
          ? pgrstResponse(200, { deleted: true })
          : pgrstResponse(200, { request_date_ms: Date.now(), subscriber: fixtures.subscriber });
    } else {
      response = new Response(`unexpected fetch in perf harness: ${request.method} ${url.href}`, {
        status: 599,
      });
    }

    const responseText = await response.clone().text();
    const call: RecordedCall = {
      cls,
      label: labelFor(cls, request.method, url, commands),
      method: request.method,
      url: url.href,
      requestBytes: encoder.encode(bodyText).byteLength,
      responseBytes: encoder.encode(responseText).byteLength,
      commands,
    };
    pending.push(call);
    callContext.getStore()?.push(call);
    totals[cls] += 1;
    await sleep(harness.options.latency[cls]);
    return response;
  }) as typeof fetch;

  let handler: ((request: Request) => Promise<Response>) | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  const harness: PerfHarness = {
    handler: (request) => {
      if (!handler) throw new Error("edge handler not captured");
      return handler(request);
    },
    options: { redis: options.redis, latency: { ...options.latency } },
    fixtures,
    drain() {
      const out = pending;
      pending = [];
      return out;
    },
    totals,
    consoleLines,
    setQuiet(value) {
      quiet = value;
    },
    resetRedis() {
      redis.store.clear();
    },
    seedRedis(key, value, ttlSeconds) {
      redis.store.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    },
  };

  await import("../../index.ts");
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  booted = harness;
  return harness;
}
