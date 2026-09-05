// Stress harness for the drills/media edge routes (unit `edge-drills-media`,
// lens `failure-load`). Boots the REAL ../index.ts with Deno.serve captured
// and replaces globalThis.fetch with a programmable upstream layer:
//
//   * Supabase Auth  — id-token exchange and GET /auth/v1/user (JWT-decoded)
//   * PostgREST      — a stateful, RLS-like `user_saved_drills` table with
//                      PostgREST query/Prefer semantics (select/eq/order,
//                      ignore-duplicates upsert, delete, maybeSingle)
//   * Upstash Redis  — a pipeline emulator (GET/TTL/SET EX/DEL/INCR/EXPIRE NX)
//   * RevenueCat     — subscriber reads (drills routes must never call it)
//
// Every upstream can be faulted independently (`Fault`): HTTP verdicts, a
// socket-level rejection, a hang (honours the caller's AbortSignal, otherwise
// settles after `hangCapMs`), slow answers, and malformed bodies. Every
// upstream call is recorded so a test can count Supabase round trips per
// request. Nothing here touches a hosted project: SUPABASE_URL / Upstash URL
// are .test hosts that only exist inside this fetch stub.
//
// New file only — production code and existing tests are untouched.

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "anon-stress-key";

export type Upstream = "auth" | "rest" | "upstash" | "revenuecat";

export type FaultMode =
  | "http500"
  | "http502_html"
  | "http503_retry_after"
  | "http503_retry_after_1s"
  | "http429"
  | "http400_check_violation"
  | "http401"
  | "http401_pgrst301"
  | "http403_grant"
  | "http404"
  | "http406"
  | "http409_unique"
  | "network_reject"
  | "hang"
  | "slow"
  | "malformed_json"
  | "truncated_json"
  | "empty_200"
  | "shape_object"
  | "shape_null"
  | "shape_string"
  | "shape_two_rows"
  | "shape_null_slug"
  | "shape_no_provider"
  | "redis_slot_error"
  | "redis_incr_huge"
  | "redis_incr_string"
  | "redis_get_garbage"
  | "redis_get_wrong_json";

export interface Fault {
  upstream: Upstream;
  mode: FaultMode;
  /** Only the nth call matching this fault's filters (1-based, counted from
   * the moment the fault is installed) is faulted; default: every call. */
  nth?: number;
  /** Only calls whose URL contains this fragment are faulted. */
  urlIncludes?: string;
  /** Only calls with this HTTP method are faulted. */
  method?: string;
  /** For `slow`: how long to wait before answering normally. */
  delayMs?: number;
}

export interface UpstreamCall {
  seq: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** HTTP status of the stubbed answer, or a fault label. */
  outcome: string;
  ms: number;
}

export interface SavedRow {
  user_id: string;
  slug: string;
  saved_at: string;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  faults: Fault[];
  calls: UpstreamCall[];
  /** Fake PostgREST table (all users). */
  savedDrills: SavedRow[];
  /** Fake Upstash keyspace. */
  redis: Map<string, { value: string; expiresAtMs: number }>;
  /** Upper bound for a `hang` that nobody aborts. */
  hangCapMs: number;
  /** Fixed latency added to every upstream answer (0 by default). */
  upstreamLatencyMs: number;
  /** Operator log lines captured from console.error / console.warn. */
  operatorLog: string[];
  redisConfigured: boolean;
  /** When set, un-faulted PostgREST calls are answered by this backend (e.g.
   * a translator onto a real docker postgres:16) instead of the in-memory
   * table. `sub` is the bearer's user id (RLS identity). */
  restBackend:
    | ((request: Request, rawBody: string, sub: string) => Promise<Response>)
    | null;
  /** Clears faults, calls, table, keyspace and operator log. */
  reset(): void;
  /** reset() + hand the process env back the way this file found it. */
  dispose(): void;
  callsTo(upstream: Upstream): UpstreamCall[];
  /** Calls made since `mark` (a previous `calls.length`). */
  callsSince(mark: number): UpstreamCall[];
}

// ── Seeded PRNG (mulberry32) — every scenario replays from its seed ──────────

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
    return `${this.int(1, 223)}.${this.int(0, 255)}.${this.int(0, 255)}.${
      this.int(1, 254)
    }`;
  }
  fork(label: string): Prng {
    return new Prng((this.seed ^ fnv1a(label)) >>> 0);
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

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Tokens ───────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(base64));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Transitional bearer: a Google ID token (the edge exchanges it once). */
export function providerToken(sub: string, ttlSeconds = 3600): string {
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** Contract bearer: a Supabase-issued access token (session_id carried). */
export function sessionToken(
  sub: string,
  sessionId = `sess-${sub}`,
  ttlSeconds = 3600,
): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    session_id: sessionId,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function userOfBearer(request: Request): string | null {
  const payload = decodeJwt(bearerOf(request));
  const sub = payload?.sub;
  return typeof sub === "string" && sub ? sub : null;
}

// ── Request builder ──────────────────────────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.42",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

// ── Upstream stubs ───────────────────────────────────────────────────────────

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

class StressAbortError extends Error {
  constructor() {
    super("The signal has been aborted");
    this.name = "AbortError";
  }
}

function classify(url: string): Upstream | null {
  if (url.startsWith(`${SUPABASE_URL}/auth/v1`)) return "auth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1`)) return "rest";
  if (url.startsWith(REDIS_URL)) return "upstash";
  if (url.startsWith(RC_URL)) return "revenuecat";
  return null;
}

const SLUG_BOUNDS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function pgrstError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
) {
  return jsonResponse(status, { code, message, details, hint: null });
}

/** Answer a Supabase Auth call. */
function authAnswer(
  request: Request,
  rawBody: string,
  mode: FaultMode | null,
): Response {
  const url = new URL(request.url);
  if (mode === "shape_object") return jsonResponse(200, {});
  if (mode === "shape_null") return jsonResponse(200, null);
  if (mode === "shape_string") return jsonResponse(200, "ok");
  if (url.pathname.endsWith("/auth/v1/token")) {
    let sub = "00000000-0000-4000-8000-000000000000";
    try {
      const payload = JSON.parse(rawBody) as {
        id_token?: string;
        refresh_token?: string;
      };
      const decoded = payload.id_token ? decodeJwt(payload.id_token) : null;
      if (typeof decoded?.sub === "string") sub = decoded.sub;
    } catch {
      // keep default
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return jsonResponse(200, {
      access_token: sessionToken(sub, `sess-exch-${sub}`),
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: `refresh-${sub}`,
      user: {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: `${sub.slice(0, 8)}@example.com`,
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      },
    });
  }
  if (url.pathname.endsWith("/auth/v1/user")) {
    const sub = userOfBearer(request);
    if (!sub) {
      return jsonResponse(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT",
      });
    }
    return jsonResponse(200, {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: `${sub.slice(0, 8)}@example.com`,
      app_metadata: mode === "shape_no_provider"
        ? {}
        : { provider: "google", providers: ["google"] },
      user_metadata: {},
    });
  }
  return jsonResponse(404, { msg: "stress auth stub: unknown path" });
}

/** PostgREST semantics for `user_saved_drills`, with RLS applied by bearer. */
function restAnswer(
  h: StressHarness,
  request: Request,
  rawBody: string,
  mode: FaultMode | null,
): Response {
  const url = new URL(request.url);
  const table = url.pathname.slice("/rest/v1/".length);
  if (table !== "user_saved_drills") {
    return pgrstError(
      404,
      "PGRST205",
      `stress rest stub: table ${table} is not modelled`,
    );
  }
  const sub = userOfBearer(request);
  if (!sub) return pgrstError(401, "PGRST301", "JWT invalid");
  const filters: Array<(row: SavedRow) => boolean> = [];
  for (const [key, value] of url.searchParams) {
    if (
      key === "select" || key === "order" || key === "on_conflict" ||
      key === "columns"
    ) continue;
    if (key === "limit" || key === "offset") continue;
    if (!value.startsWith("eq.")) {
      return pgrstError(
        400,
        "PGRST100",
        `stress rest stub: unsupported filter ${key}=${value}`,
      );
    }
    const expected = value.slice(3);
    filters.push((row) => String(row[key as keyof SavedRow]) === expected);
  }
  const visible = () =>
    h.savedDrills.filter((row) =>
      row.user_id === sub && filters.every((f) => f(row))
    );
  const prefer = request.headers.get("prefer") ?? "";
  const accept = request.headers.get("accept") ?? "";
  const wantsObject = accept.includes("application/vnd.pgrst.object+json");

  if (request.method === "GET") {
    if (mode === "shape_two_rows") {
      const twice = [
        { slug: "a", saved_at: "2026-09-01T00:00:00Z" },
        { slug: "b", saved_at: "2026-09-02T00:00:00Z" },
      ];
      return jsonResponse(200, twice);
    }
    if (mode === "shape_null_slug") {
      return jsonResponse(200, [{ slug: null, saved_at: null }]);
    }
    let rows = visible();
    const order = url.searchParams.get("order");
    if (order?.startsWith("saved_at")) {
      const desc = order.includes(".desc");
      rows = [...rows].sort((a, b) =>
        desc
          ? b.saved_at.localeCompare(a.saved_at)
          : a.saved_at.localeCompare(b.saved_at)
      );
    }
    const select = (url.searchParams.get("select") ?? "*")
      .split(",")
      .map((column) => column.trim());
    const projected = rows.map((row) => {
      if (select.includes("*")) return { ...row };
      const out: Record<string, unknown> = {};
      for (const column of select) out[column] = row[column as keyof SavedRow];
      return out;
    });
    if (wantsObject) {
      if (projected.length === 1) return jsonResponse(200, projected[0]);
      return pgrstError(
        406,
        "PGRST116",
        "JSON object requested, multiple (or no) rows returned",
        `The result contains ${projected.length} rows`,
      );
    }
    return jsonResponse(200, projected);
  }

  if (request.method === "POST") {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return pgrstError(400, "PGRST102", "Empty or invalid json");
    }
    const rows = (Array.isArray(payload) ? payload : [payload]) as Array<
      Record<string, unknown>
    >;
    const inserted: SavedRow[] = [];
    for (const row of rows) {
      const userId = String(row.user_id ?? "");
      const slug = String(row.slug ?? "");
      if (userId !== sub) {
        // RLS with-check: the row is not the caller's.
        return pgrstError(
          401,
          "42501",
          'new row violates row-level security policy for table "user_saved_drills"',
        );
      }
      if (!SLUG_BOUNDS.test(slug)) {
        return pgrstError(
          400,
          "23514",
          'new row for relation "user_saved_drills" violates check constraint "user_saved_drills_slug_bounds"',
        );
      }
      const existing = h.savedDrills.find((r) =>
        r.user_id === userId && r.slug === slug
      );
      if (existing) {
        if (prefer.includes("resolution=ignore-duplicates")) continue;
        if (prefer.includes("resolution=merge-duplicates")) continue;
        return pgrstError(
          409,
          "23505",
          'duplicate key value violates unique constraint "user_saved_drills_pkey"',
        );
      }
      const saved: SavedRow = {
        user_id: userId,
        slug,
        saved_at: new Date().toISOString(),
      };
      h.savedDrills.push(saved);
      inserted.push(saved);
    }
    if (prefer.includes("return=representation")) {
      return jsonResponse(201, inserted);
    }
    return new Response(null, { status: 201 });
  }

  if (request.method === "DELETE") {
    const doomed = new Set(visible());
    h.savedDrills = h.savedDrills.filter((row) => !doomed.has(row));
    if (prefer.includes("return=representation")) {
      return jsonResponse(200, [...doomed]);
    }
    return new Response(null, { status: 204 });
  }

  if (request.method === "PATCH") {
    return pgrstError(405, "PGRST105", "stress rest stub: PATCH not modelled");
  }
  return pgrstError(
    405,
    "PGRST105",
    `stress rest stub: ${request.method} not modelled`,
  );
}

/** Upstash REST pipeline emulator. */
function redisAnswer(
  h: StressHarness,
  rawBody: string,
  mode: FaultMode | null,
): Response {
  let commands: Array<Array<string | number>>;
  try {
    commands = JSON.parse(rawBody);
    if (!Array.isArray(commands)) throw new Error("not an array");
  } catch {
    return jsonResponse(400, { error: "ERR failed to parse pipeline" });
  }
  const now = Date.now();
  const live = (key: string) => {
    const entry = h.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== Infinity && entry.expiresAtMs <= now) {
      h.redis.delete(key);
      return null;
    }
    return entry;
  };
  const results = commands.map((command) => {
    const [op, ...args] = command.map(String);
    switch (op.toUpperCase()) {
      case "GET": {
        const entry = live(args[0]);
        // Corrupt VALUE rows only: a revocation marker is presence-based, so
        // garbage there is a legitimate "revoked" answer, not a malformed one.
        const valueRow = !args[0].includes(":revoked:");
        if (mode === "redis_get_garbage" && valueRow) {
          return { result: "\u0000not-json{" };
        }
        if (mode === "redis_get_wrong_json" && valueRow) {
          return { result: JSON.stringify({ userId: 42 }) };
        }
        return { result: entry ? entry.value : null };
      }
      case "TTL": {
        const entry = live(args[0]);
        if (!entry) return { result: -2 };
        if (entry.expiresAtMs === Infinity) return { result: -1 };
        return {
          result: Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1000)),
        };
      }
      case "SET": {
        const [key, value, ex, seconds] = args;
        const ttlMs = ex?.toUpperCase() === "EX" ? Number(seconds) * 1000 : NaN;
        h.redis.set(key, {
          value,
          expiresAtMs: Number.isFinite(ttlMs) ? now + ttlMs : Infinity,
        });
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) if (h.redis.delete(key)) removed += 1;
        return { result: removed };
      }
      case "INCR": {
        if (mode === "redis_incr_huge") return { result: 1_000_000_000 };
        if (mode === "redis_incr_string") return { result: "not-a-number" };
        const entry = live(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        h.redis.set(args[0], {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? Infinity,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const [key, seconds, flag] = args;
        const entry = live(key);
        if (!entry) return { result: 0 };
        if (flag?.toUpperCase() === "NX" && entry.expiresAtMs !== Infinity) {
          return { result: 0 };
        }
        entry.expiresAtMs = now + Number(seconds) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  });
  if (mode === "redis_slot_error") {
    return jsonResponse(
      200,
      results.map(() => ({
        error: "OOM command not allowed when used memory > 'maxmemory'",
      })),
    );
  }
  return jsonResponse(200, results);
}

function revenueCatAnswer(): Response {
  return jsonResponse(200, {
    request_date_ms: Date.now(),
    subscriber: {
      entitlements: {
        pickle_sensei_pro: {
          expires_date: new Date(Date.now() + 86_400_000).toISOString(),
          product_identifier: "pickle_sensei_pro_monthly",
        },
      },
    },
  });
}

/** Generic malformed / verdict faults shared by every upstream. */
function genericFault(mode: FaultMode, upstream: Upstream): Response | null {
  switch (mode) {
    case "http500":
      return jsonResponse(500, { message: "internal error", code: "XX000" });
    case "http502_html":
      return new Response(
        "<html><body><h1>502 Bad Gateway</h1></body></html>",
        {
          status: 502,
          headers: { "Content-Type": "text/html" },
        },
      );
    case "http503_retry_after":
      return jsonResponse(503, { message: "over capacity" }, {
        "Retry-After": "7",
      });
    case "http503_retry_after_1s":
      return jsonResponse(503, { message: "over capacity" }, {
        "Retry-After": "1",
      });
    case "http429":
      return jsonResponse(429, { message: "rate limited" }, {
        "Retry-After": "3",
      });
    case "http400_check_violation":
      return pgrstError(
        400,
        "23514",
        'new row for relation "user_saved_drills" violates check constraint "user_saved_drills_slug_bounds"',
      );
    case "http401":
      return upstream === "auth"
        ? jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT: token expired",
        })
        : jsonResponse(401, { message: "Unauthorized" });
    case "http401_pgrst301":
      return pgrstError(401, "PGRST301", "JWT expired");
    case "http403_grant":
      return pgrstError(
        403,
        "42501",
        "permission denied for table user_saved_drills",
      );
    case "http404":
      return jsonResponse(404, { message: "not found" });
    case "http406":
      return pgrstError(
        406,
        "PGRST116",
        "JSON object requested, multiple (or no) rows returned",
      );
    case "http409_unique":
      return pgrstError(
        409,
        "23505",
        'duplicate key value violates unique constraint "user_saved_drills_pkey"',
      );
    case "malformed_json":
      return new Response("{not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "truncated_json":
      return new Response('[{"slug":"dink-ladder","sav', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "empty_200":
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "shape_object":
      return upstream === "auth"
        ? null
        : jsonResponse(200, { unexpected: true });
    case "shape_null":
      return upstream === "auth" ? null : jsonResponse(200, null);
    case "shape_string":
      return upstream === "auth" ? null : jsonResponse(200, "a string");
    default:
      return null;
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

let loaded: StressHarness | null = null;

export async function loadStressHarness(
  options: { redis?: boolean; authTimeoutMs?: number } = {},
): Promise<StressHarness> {
  if (loaded) {
    loaded.reset();
    return loaded;
  }
  const redisConfigured = options.redis ?? false;
  // Env is process-wide across test files (module state is not): remember
  // what was there so `dispose()` can hand it back to the next file.
  const ENV_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REVENUECAT_WEBHOOK_AUTH",
    "REVENUECAT_SECRET_API_KEY",
    "AUTH_UPSTREAM_TIMEOUT_MS",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.set(
    "AUTH_UPSTREAM_TIMEOUT_MS",
    String(options.authTimeoutMs ?? 400),
  );
  if (redisConfigured) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "stress-redis-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const counters: Record<Upstream, number> = {
    auth: 0,
    rest: 0,
    upstash: 0,
    revenuecat: 0,
  };
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    faults: [],
    calls: [],
    savedDrills: [],
    redis: new Map(),
    hangCapMs: 2_000,
    upstreamLatencyMs: 0,
    operatorLog: [],
    redisConfigured,
    restBackend: null,
    dispose() {
      state.reset();
      for (const [key, value] of priorEnv) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    },
    reset() {
      state.faults = [];
      state.calls = [];
      state.savedDrills = [];
      state.redis = new Map();
      state.operatorLog = [];
      state.upstreamLatencyMs = 0;
      for (const key of Object.keys(counters) as Upstream[]) counters[key] = 0;
    },
    callsTo(upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
    callsSince(mark) {
      return state.calls.slice(mark);
    },
  };

  // Operator-facing lines are evidence, not noise: keep them off stdout and
  // in the harness so tests can assert what reached the logs.
  const realError = console.error;
  const realWarn = console.warn;
  const capture = (level: string) => (...args: unknown[]) => {
    const line = args
      .map((
        arg,
      ) => (typeof arg === "string"
        ? arg
        : (arg as Error)?.message ?? String(arg))
      )
      .join(" ");
    state.operatorLog.push(`${level} ${line}`);
    if (state.operatorLog.length > 5_000) state.operatorLog.shift();
  };
  console.error = capture("error") as typeof console.error;
  console.warn = capture("warn") as typeof console.warn;
  captureAccessLog(() => undefined);
  void realError;
  void realWarn;

  const faultHits = new WeakMap<Fault, number>();
  const matchFault = (upstream: Upstream, request: Request): Fault | null => {
    for (const fault of state.faults) {
      if (fault.upstream !== upstream) continue;
      if (fault.urlIncludes && !request.url.includes(fault.urlIncludes)) {
        continue;
      }
      if (fault.method && fault.method !== request.method) continue;
      const hits = (faultHits.get(fault) ?? 0) + 1;
      faultHits.set(fault, hits);
      if (fault.nth !== undefined && fault.nth !== hits) continue;
      return fault;
    }
    return null;
  };

  const settleHang = (
    signal: AbortSignal | null | undefined,
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new StressAbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(new Response("stress hang cap reached", { status: 599 }));
      }, state.hangCapMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new StressAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const upstream = classify(request.url);
    const started = performance.now();
    const seq = state.calls.length + 1;
    const record = (outcome: string) => {
      state.calls.push({
        seq,
        upstream: upstream ?? "rest",
        method: request.method,
        url: request.url,
        outcome,
        ms: Math.round((performance.now() - started) * 100) / 100,
      });
    };
    if (!upstream) {
      record("unexpected");
      return new Response(
        `unexpected fetch in stress harness: ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }
    counters[upstream] += 1;
    const rawBody = await request.text().catch(() => "");
    const fault = matchFault(upstream, request);
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);

    if (state.upstreamLatencyMs > 0) await sleep(state.upstreamLatencyMs);

    if (fault) {
      if (fault.mode === "network_reject") {
        record("network_reject");
        throw new TypeError(
          "error sending request: connection reset by peer (stress)",
        );
      }
      if (fault.mode === "hang") {
        try {
          const answer = await settleHang(signal);
          record("hang_cap");
          return answer;
        } catch (error) {
          record("hang_aborted");
          throw error;
        }
      }
      if (fault.mode === "slow") {
        await sleep(fault.delayMs ?? 250);
      } else {
        const generic = genericFault(fault.mode, upstream);
        if (generic) {
          record(`fault:${fault.mode}:${generic.status}`);
          return generic;
        }
      }
    }
    const mode = fault && fault.mode !== "slow" ? fault.mode : null;
    let answer: Response;
    switch (upstream) {
      case "auth":
        answer = authAnswer(request, rawBody, mode);
        break;
      case "rest": {
        const sub = mode === null && state.restBackend
          ? userOfBearer(request)
          : null;
        answer = sub && state.restBackend
          ? await state.restBackend(request, rawBody, sub)
          : restAnswer(state, request, rawBody, mode);
        break;
      }
      case "upstash":
        answer = redisAnswer(state, rawBody, mode);
        break;
      case "revenuecat":
        answer = revenueCatAnswer();
        break;
    }
    record(mode ? `fault:${mode}:${answer.status}` : String(answer.status));
    return answer;
  }) as typeof fetch;

  const realServe = Deno.serve;
  let handler: StressHarness["handler"] | null = null;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | StressHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  state.handler = handler;
  loaded = state;
  return state;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-drills-media/latest/",
    import.meta.url,
  )
    .pathname;
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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    out[String(value)] = (out[String(value)] ?? 0) + 1;
  }
  return out;
}

/** Race the handler against a wall-clock budget: `stalled` when no answer
 * arrived in time (the handler keeps running; await `pending` before the test
 * ends so the sanitizer sees a quiet event loop). */
export async function answerWithin(
  handler: StressHarness["handler"],
  request: Request,
  budgetMs: number,
): Promise<
  {
    response: Response | null;
    stalled: boolean;
    ms: number;
    pending: Promise<unknown>;
  }
> {
  const started = performance.now();
  const pending = handler(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const response = await Promise.race([pending, budget]);
  clearTimeout(timer);
  const ms = Math.round((performance.now() - started) * 100) / 100;
  return {
    response,
    stalled: response === null,
    ms,
    pending: pending.catch(() => undefined),
  };
}
