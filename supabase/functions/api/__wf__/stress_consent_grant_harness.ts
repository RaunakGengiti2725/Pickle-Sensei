// stress — POST /v1/me/consent/grant (failure-injection + load lens).
//
// Boots the REAL ../index.ts in-process (Deno.serve captured) behind a
// STATEFUL fake of every upstream the route can reach:
//
//   * Supabase Auth  — GET /auth/v1/user (session bearers) and the id_token
//                      grant (transitional provider-token bearers);
//   * PostgREST      — consent_records is a real append-only table here:
//                      inserts persist, GETs honour user_id=eq / order= /
//                      select=, RLS is enforced by the bearer's sub, and the
//                      DB CHECK `consent_records_bounds` (migration
//                      20260831160000) is modelled so the edge/DB cap mismatch
//                      is visible in-process (the Postgres file proves it);
//   * Upstash Redis  — the /pipeline REST endpoint (GET/TTL/SET/DEL/INCR/
//                      EXPIRE), enabled per isolate with `redis: true`
//                      (cache.ts reads UPSTASH_* at import, so the choice is
//                      fixed at first load — one test module per mode);
//   * RevenueCat     — recorded only; the route must never reach it.
//
// Faults are injected per upstream target: HTTP status (with a canary in the
// body so leaks are detectable), connection error, hang (honours the caller's
// AbortSignal — or, for callers that pass none, resolves after `ms` so a
// missing deadline is measurable), malformed 2xx (non-JSON / wrong shape) and
// slow-but-correct. Every call is recorded with its target, so Supabase round
// trips per request are COUNTED, not inferred.
//
// Nothing here talks to a network: the only fetch that exists is the fake.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_HOST = "https://api.revenuecat.com";
export const ANON_KEY = "stress-anon-key";

export const CONSENT_SCOPES = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export type Upstream = "auth" | "rest" | "redis" | "revenuecat" | "other";
export type FaultTarget =
  | "auth_user"
  | "auth_id_token"
  | "rest_insert"
  | "rest_select"
  | "redis"
  | "revenuecat";

export type FaultMode =
  | {
    kind: "http";
    status: number;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  }
  | { kind: "network"; message?: string }
  | { kind: "hang"; ms: number }
  | { kind: "malformed"; rawBody: string; status?: number }
  | { kind: "shape"; body: unknown; status?: number }
  | { kind: "slow"; ms: number };

export interface Fault {
  target: FaultTarget;
  mode: FaultMode;
  /** How many matching calls the fault applies to (default: every call). */
  times?: number;
}

export interface RecordedCall {
  seq: number;
  upstream: Upstream;
  target: FaultTarget | null;
  url: string;
  method: string;
  fault: string | null;
  /** True when the caller handed fetch an AbortSignal. */
  hasSignal: boolean;
  startedAtMs: number;
  durationMs: number;
}

export interface FakeUser {
  id: string;
  email: string;
  /** app_metadata.provider as GoTrue reports it (google | apple | email | none). */
  provider: string | null;
}

export interface FakeSession {
  userId: string;
  sessionId: string;
  /** Unix seconds. */
  exp: number;
  revoked: boolean;
}

export interface ConsentRecord {
  id: string;
  user_id: string;
  scope: string;
  consent_version: string | null;
  action: string;
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  created_at: string;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

/** Upstream call counters for one window (see `StressHarness.window`). */
export interface CallCounts {
  auth: number;
  rest: number;
  restInsert: number;
  restSelect: number;
  redis: number;
  revenuecat: number;
  other: number;
  /** auth + rest — the Supabase round trips the task counts. */
  supabase: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  consentRows: ConsentRecord[];
  redis: Map<string, FakeRedisEntry>;
  calls: RecordedCall[];
  /** When false only counters are kept (load campaigns). */
  recordCalls: boolean;
  counts: CallCounts;
  faults: Fault[];
  /** Canary planted in every injected upstream error body; must never reach a client. */
  canary: string;
  setFaults(...faults: Fault[]): void;
  clearFaults(): void;
  /** Snapshot counters, run `fn`, return the per-window delta. */
  window<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; counts: CallCounts; calls: RecordedCall[] }>;
  registerUser(user: FakeUser): void;
  /** Mint a session access token (bearer) for `userId`. */
  mintSession(
    userId: string,
    opts?: { ttlSeconds?: number; sessionId?: string },
  ): string;
  rowsFor(userId: string): ConsentRecord[];
  /** Forget users/sessions/rows/calls/redis; faults too. Keeps the module state of index.ts. */
  reset(): void;
  /** Drop the fake's own bulk state (sessions, users, rows, calls) so heap
   * measurements isolate the function's own per-isolate caches. */
  dropFakeState(): void;
}

// ── Deterministic helpers ────────────────────────────────────────────────────

/** mulberry32 — deterministic; every campaign iteration replays from its seed. */
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
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    while (out.length < n) out += this.int(0, 15).toString(16);
    return out;
  }
  /** RFC 4122-shaped v4 uuid (matches index.ts UUID_RE). */
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = ["8", "9", "a", "b"][this.int(0, 3)];
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${
      s.slice(16, 20)
    }-${s.slice(20)}`;
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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(seg)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Unsigned JWT (the function routes on iss/exp/sub only; verification is the fake Auth's job). */
export function fakeJwt(
  payload: Record<string, unknown>,
  nonce?: string,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${
    b64url(nonce ?? crypto.randomUUID())
  }`;
}

export function googleIdToken(
  sub: string,
  ttlSeconds = 3600,
  nonce?: string,
): string {
  return fakeJwt(
    {
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    },
    nonce,
  );
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-consent-grant/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

let ipCounter = 0;
/** A fresh client IP so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function apiRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    rawBody?: string;
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
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
  });
}

export interface RouteOutcome {
  status: number;
  body: unknown;
  text: string;
  headers: Record<string, string>;
  latencyMs: number;
  counts: CallCounts;
  calls: RecordedCall[];
}

export async function call(
  h: StressHarness,
  request: Request,
): Promise<RouteOutcome> {
  const started = performance.now();
  const { result, counts, calls } = await h.window(() => h.handler(request));
  const latencyMs = performance.now() - started;
  const text = await result.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body stays as text
  }
  const headers: Record<string, string> = {};
  result.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return {
    status: result.status,
    body,
    text,
    headers,
    latencyMs,
    counts,
    calls,
  };
}

export function errorMessageOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.message === "string" ? body.error.message : null;
}

export function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

// ── Fake upstreams ───────────────────────────────────────────────────────────

const emptyCounts = (): CallCounts => ({
  auth: 0,
  rest: 0,
  restInsert: 0,
  restSelect: 0,
  redis: 0,
  revenuecat: 0,
  other: 0,
  supabase: 0,
});

function gotrueUser(user: FakeUser): Record<string, unknown> {
  const meta: Record<string, unknown> = user.provider
    ? { provider: user.provider, providers: [user.provider] }
    : {};
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: meta,
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
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const pgrstError = (status: number, code: string, message: string): Response =>
  jsonResponse(status, { code, message, details: null, hint: null });

const authError = (status: number, msg: string, code = "bad_jwt"): Response =>
  jsonResponse(status, { code: status, msg, error_code: code });

/** Mirrors `consent_records_bounds` (20260831160000) + `consent_records_device_size`. */
function boundsViolation(row: Record<string, unknown>): string | null {
  const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
  if (len(row.scope) > 50) return "scope";
  if (len(row.consent_version) > 50) return "consent_version";
  if (len(row.source) > 100) return "source";
  if (len(row.capture_mode) > 50) return "capture_mode";
  const device = row.device;
  if (
    device !== null && device !== undefined &&
    JSON.stringify(device).length > 4096
  ) return "device";
  return null;
}

/** Monotonic fake `now()` for created_at: strictly increasing so the order the
 * route asks for (created_at asc, id asc) is well defined here. */
let clockTick = 0;
function nextCreatedAt(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 8, 4, 12, 0, 0) + clockTick).toISOString();
}

let harness: StressHarness | null = null;

function abortError(signal: AbortSignal | null): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The signal has been aborted", "AbortError");
}

function classify(
  url: URL,
  method: string,
): { upstream: Upstream; target: FaultTarget | null } {
  const origin = `${url.protocol}//${url.host}`;
  if (origin === SUPABASE_URL) {
    if (url.pathname.startsWith("/auth/v1/")) {
      if (url.pathname === "/auth/v1/user") {
        return { upstream: "auth", target: "auth_user" };
      }
      if (
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "id_token"
      ) {
        return { upstream: "auth", target: "auth_id_token" };
      }
      return { upstream: "auth", target: null };
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (method === "GET" || method === "HEAD") {
        return { upstream: "rest", target: "rest_select" };
      }
      return { upstream: "rest", target: "rest_insert" };
    }
    return { upstream: "other", target: null };
  }
  if (origin === REDIS_URL) return { upstream: "redis", target: "redis" };
  if (origin === RC_HOST) {
    return { upstream: "revenuecat", target: "revenuecat" };
  }
  return { upstream: "other", target: null };
}

function describeFault(mode: FaultMode): string {
  switch (mode.kind) {
    case "http":
      return `http ${mode.status}`;
    case "network":
      return "network";
    case "hang":
      return `hang ${mode.ms}ms`;
    case "malformed":
      return `malformed ${mode.status ?? 200}`;
    case "shape":
      return `shape ${mode.status ?? 200}`;
    case "slow":
      return `slow ${mode.ms}ms`;
  }
}

/**
 * Run `fn` with a short Supabase Auth deadline so hang/timeout faults resolve
 * quickly. index.ts reads AUTH_UPSTREAM_TIMEOUT_MS per call and Deno.env is
 * process-wide (shared by every test module in one `deno test` run), so the
 * override is restored in `finally` — the same discipline as
 * adjudicate_xc_ci_release_static.test.ts.
 */
export async function withStressAuthTimeout<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const key = "AUTH_UPSTREAM_TIMEOUT_MS";
  const previous = Deno.env.get(key);
  Deno.env.set(key, Deno.env.get("STRESS_AUTH_TIMEOUT_MS") ?? "400");
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
}

/** Boot the real edge function once per test module. */
export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }
  const redisEnabled = Boolean(options.redis);

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stress-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "stress-rc-key");
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
  if (redisEnabled) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  let seq = 0;
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled,
    users: new Map(),
    sessions: new Map(),
    consentRows: [],
    redis: new Map(),
    calls: [],
    recordCalls: true,
    counts: emptyCounts(),
    faults: [],
    canary: `CANARY-${crypto.randomUUID()}`,
    setFaults(...faults: Fault[]) {
      state.faults = faults.map((f) => ({ ...f }));
    },
    clearFaults() {
      state.faults = [];
    },
    async window<T>(fn: () => Promise<T>) {
      const before = { ...state.counts };
      const firstSeq = seq;
      const result = await fn();
      const counts = emptyCounts();
      for (const key of Object.keys(counts) as Array<keyof CallCounts>) {
        counts[key] = state.counts[key] - before[key];
      }
      const calls = state.recordCalls
        ? state.calls.filter((c) => c.seq >= firstSeq)
        : [];
      return { result, counts, calls };
    },
    registerUser(user: FakeUser) {
      state.users.set(user.id, user);
    },
    mintSession(
      userId: string,
      opts: { ttlSeconds?: number; sessionId?: string } = {},
    ): string {
      const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 3600);
      const sessionId = opts.sessionId ?? crypto.randomUUID();
      const token = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId,
        exp,
      });
      state.sessions.set(token, { userId, sessionId, exp, revoked: false });
      return token;
    },
    rowsFor(userId: string) {
      return state.consentRows.filter((r) => r.user_id === userId);
    },
    reset() {
      state.dropFakeState();
      state.redis = new Map();
      state.faults = [];
      state.recordCalls = true;
      state.counts = emptyCounts();
    },
    dropFakeState() {
      state.users = new Map();
      state.sessions = new Map();
      state.consentRows = [];
      state.calls = [];
    },
  };

  const bearerOf = (headers: Headers): string =>
    (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  /** The session behind a PostgREST/Auth bearer, or an error response. */
  const sessionOf = (headers: Headers): FakeSession | Response => {
    const bearer = bearerOf(headers);
    const session = state.sessions.get(bearer);
    if (!session || session.revoked) {
      return pgrstError(401, "PGRST301", "JWT invalid");
    }
    if (session.exp * 1000 <= Date.now()) {
      return pgrstError(401, "PGRST301", "JWT expired");
    }
    return session;
  };

  const restConsent = async (request: Request, url: URL): Promise<Response> => {
    const session = sessionOf(request.headers);
    if (session instanceof Response) return session;
    if (request.method === "POST") {
      let payload: unknown;
      try {
        payload = JSON.parse(await request.text());
      } catch {
        return pgrstError(
          400,
          "PGRST102",
          "Empty or invalid json request body",
        );
      }
      const rows = Array.isArray(payload) ? payload : [payload];
      const inserted: ConsentRecord[] = [];
      for (const raw of rows) {
        if (!isRecord(raw)) return pgrstError(400, "PGRST102", "Invalid row");
        if (raw.user_id !== session.userId) {
          return pgrstError(
            403,
            "42501",
            'new row violates row-level security policy for table "consent_records"',
          );
        }
        if (typeof raw.scope !== "string" || typeof raw.action !== "string") {
          return pgrstError(
            400,
            "23502",
            "null value in column violates not-null constraint",
          );
        }
        if (raw.action !== "grant" && raw.action !== "withdraw") {
          return pgrstError(
            400,
            "23514",
            'new row for relation "consent_records" violates check constraint "consent_records_action_check"',
          );
        }
        const violated = boundsViolation(raw);
        if (violated) {
          return pgrstError(
            400,
            "23514",
            `new row for relation "consent_records" violates check constraint "consent_records_bounds" (${violated})`,
          );
        }
        inserted.push({
          id: crypto.randomUUID(),
          user_id: session.userId,
          scope: raw.scope,
          consent_version: typeof raw.consent_version === "string"
            ? raw.consent_version
            : null,
          action: raw.action,
          source: typeof raw.source === "string" ? raw.source : null,
          device: raw.device ?? null,
          capture_mode: typeof raw.capture_mode === "string"
            ? raw.capture_mode
            : null,
          created_at: nextCreatedAt(),
        });
      }
      state.consentRows.push(...inserted);
      const prefer = request.headers.get("prefer") ?? "";
      if (prefer.includes("return=representation")) {
        return jsonResponse(201, inserted);
      }
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") {
      // RLS: only the bearer's rows are visible, whatever the filter says.
      let rows = state.consentRows.filter((r) => r.user_id === session.userId);
      for (const [key, value] of url.searchParams) {
        if (
          key === "select" || key === "order" || key === "limit" ||
          key === "offset"
        ) continue;
        const m = /^eq\.(.*)$/.exec(value);
        if (!m) {
          return pgrstError(
            400,
            "PGRST100",
            `unsupported filter ${key}=${value}`,
          );
        }
        rows = rows.filter((r) =>
          String((r as unknown as Record<string, unknown>)[key]) === m[1]
        );
      }
      const order = url.searchParams.get("order");
      if (order) {
        const terms = order.split(",").map((t) => {
          const [col, dir] = t.split(".");
          return { col, desc: dir === "desc" };
        });
        rows = [...rows].sort((a, b) => {
          for (const { col, desc } of terms) {
            const av = String((a as unknown as Record<string, unknown>)[col]);
            const bv = String((b as unknown as Record<string, unknown>)[col]);
            if (av === bv) continue;
            return (av < bv ? -1 : 1) * (desc ? -1 : 1);
          }
          return 0;
        });
      }
      const select = url.searchParams.get("select") ?? "*";
      const projected = select === "*" ? rows : rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const col of select.split(",").map((s) => s.trim())) {
          out[col] = (r as unknown as Record<string, unknown>)[col];
        }
        return out;
      });
      return jsonResponse(200, projected);
    }
    // update/delete are revoked from `authenticated` (20260831160000).
    return pgrstError(
      403,
      "42501",
      "permission denied for table consent_records",
    );
  };

  const realFetch = async (request: Request, url: URL): Promise<Response> => {
    const origin = `${url.protocol}//${url.host}`;
    if (origin === REDIS_URL && url.pathname === "/pipeline") {
      if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      let commands: unknown;
      try {
        commands = JSON.parse(await request.text());
      } catch {
        return jsonResponse(400, { error: "ERR invalid pipeline" });
      }
      const list = Array.isArray(commands)
        ? (commands as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        list.map((command) => runRedisCommand(state, command)),
      );
    }
    if (origin === SUPABASE_URL) {
      if (url.pathname === "/auth/v1/user" && request.method === "GET") {
        const bearer = bearerOf(request.headers);
        const session = state.sessions.get(bearer);
        if (!session || session.revoked) {
          return authError(401, "invalid JWT: session not found");
        }
        if (session.exp * 1000 <= Date.now()) {
          return authError(401, "invalid JWT: token is expired");
        }
        const user = state.users.get(session.userId);
        if (!user) return authError(403, "User not found", "user_not_found");
        return jsonResponse(200, gotrueUser(user));
      }
      if (url.pathname === "/auth/v1/token" && request.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(await request.text()) as unknown;
          if (isRecord(parsed)) payload = parsed;
        } catch {
          // empty body
        }
        if (grant === "id_token") {
          const idToken = typeof payload.id_token === "string"
            ? payload.id_token
            : "";
          const sub = jwtPayload(idToken)?.sub;
          const user = typeof sub === "string"
            ? state.users.get(sub)
            : undefined;
          if (!user || user.provider !== payload.provider) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "Bad ID token",
              error_code: "bad_id_token",
            });
          }
          const token = state.mintSession(user.id);
          const session = state.sessions.get(token)!;
          return jsonResponse(200, {
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: session.exp,
            refresh_token: `rt-${crypto.randomUUID()}`,
            user: gotrueUser(user),
          });
        }
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length);
        if (table === "consent_records") return restConsent(request, url);
        if (request.method === "GET") return jsonResponse(200, []);
        return new Response(null, { status: 201 });
      }
    }
    if (origin === RC_HOST) {
      return jsonResponse(200, {
        subscriber: { entitlements: {}, subscriptions: {} },
      });
    }
    return new Response(`unexpected fetch in test: ${request.method} ${url}`, {
      status: 599,
    });
  };

  const applyFault = async (
    mode: FaultMode,
    request: Request,
    url: URL,
    signal: AbortSignal | null,
  ): Promise<Response> => {
    switch (mode.kind) {
      case "http": {
        const headers = {
          "Content-Type": "application/json",
          ...(mode.headers ?? {}),
        };
        if (mode.rawBody !== undefined) {
          return new Response(mode.rawBody, { status: mode.status, headers });
        }
        const body = mode.body ?? {
          code: mode.status,
          error_code: "injected_failure",
          msg: `injected upstream failure ${state.canary}`,
          message: `injected upstream failure ${state.canary}`,
          error: "injected_failure",
          error_description: `injected upstream failure ${state.canary}`,
          details: state.canary,
          hint: state.canary,
        };
        return jsonResponse(mode.status, body, mode.headers);
      }
      case "network":
        throw new TypeError(
          mode.message ??
            `error sending request: connection refused ${state.canary}`,
        );
      case "hang":
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError(signal));
            return;
          }
          const timer = setTimeout(resolve, mode.ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(abortError(signal));
            },
            { once: true },
          );
        });
        return realFetch(request, url);
      case "malformed":
        return new Response(mode.rawBody, {
          status: mode.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      case "shape":
        return jsonResponse(mode.status ?? 200, mode.body);
      case "slow":
        await new Promise((resolve) => setTimeout(resolve, mode.ms));
        return realFetch(request, url);
    }
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : null) ?? null;
    const url = new URL(request.url);
    const { upstream, target } = classify(url, request.method);
    seq += 1;
    const mySeq = seq;
    state.counts[upstream] += 1;
    if (upstream === "auth" || upstream === "rest") {
      state.counts.supabase += 1;
    }
    if (target === "rest_insert") state.counts.restInsert += 1;
    if (target === "rest_select") state.counts.restSelect += 1;

    let fault: Fault | null = null;
    if (target) {
      const idx = state.faults.findIndex((f) =>
        f.target === target && (f.times ?? Infinity) > 0
      );
      if (idx >= 0) {
        fault = state.faults[idx];
        if (fault.times !== undefined) fault.times -= 1;
      }
    }
    const startedAtMs = performance.now();
    const record = (): void => {
      if (!state.recordCalls) return;
      state.calls.push({
        seq: mySeq,
        upstream,
        target,
        url: request.url,
        method: request.method,
        fault: fault ? describeFault(fault.mode) : null,
        hasSignal: signal !== null,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
      });
    };
    try {
      const response = fault
        ? await applyFault(fault.mode, request, url, signal)
        : await realFetch(request, url);
      record();
      return response;
    } catch (error) {
      record();
      throw error;
    }
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

  await import("../index.ts");
  harness = state;
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

// ── Scenario helpers shared by the campaigns ────────────────────────────────

export interface Actor {
  userId: string;
  token: string;
  ip: string;
}

/** A registered google user with a live session, ids derived from the seed. */
export function seededActor(
  h: StressHarness,
  rng: Prng,
  provider: string | null = "google",
): Actor {
  const userId = rng.uuid();
  h.registerUser({
    id: userId,
    email: `${userId.slice(0, 8)}@example.com`,
    provider,
  });
  const token = h.mintSession(userId, { sessionId: rng.uuid() });
  return { userId, token, ip: freshIp() };
}

export function grantBody(
  scope: ConsentScope,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scope,
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: "iPhone16,2 iOS 19.0",
    captureMode: "all_captures",
    ...overrides,
  };
}

export function grantRequest(
  actor: Actor,
  body: unknown,
  extra: { rawBody?: string } = {},
): Request {
  return apiRequest("POST", "/v1/me/consent/grant", {
    token: actor.token,
    ip: actor.ip,
    body: extra.rawBody === undefined ? body : undefined,
    rawBody: extra.rawBody,
  });
}

export function statusRequest(actor: Actor): Request {
  return apiRequest("GET", "/v1/me/consent/status", {
    token: actor.token,
    ip: actor.ip,
  });
}

/** Warm the auth cache for the actor (a status read; adds no ledger row). */
export async function warmAuth(h: StressHarness, actor: Actor): Promise<void> {
  const out = await call(h, statusRequest(actor));
  if (out.status !== 200) {
    throw new Error(`warm-up failed: ${out.status} ${out.text}`);
  }
}

export function activeScopes(body: unknown): Record<string, boolean> | null {
  if (!isRecord(body) || !Array.isArray(body.scopes)) return null;
  const out: Record<string, boolean> = {};
  for (const entry of body.scopes) {
    if (isRecord(entry) && typeof entry.scope === "string") {
      out[entry.scope] = entry.active === true;
    }
  }
  return out;
}

/** Shape check for the 200 body of grant/status. */
export function validStatusBody(body: unknown): boolean {
  if (
    !isRecord(body) || body.subjectPseudonym !== null ||
    !Array.isArray(body.scopes)
  ) return false;
  if (body.scopes.length !== CONSENT_SCOPES.length) return false;
  return body.scopes.every(
    (entry, i) =>
      isRecord(entry) &&
      entry.scope === CONSENT_SCOPES[i] &&
      typeof entry.active === "boolean" &&
      (entry.consentVersion === null ||
        typeof entry.consentVersion === "string") &&
      (entry.lastAction === null || entry.lastAction === "granted" ||
        entry.lastAction === "withdrawn") &&
      (entry.lastActionAt === null || typeof entry.lastActionAt === "string"),
  );
}

/** The status the route should derive from the fake ledger (route semantics:
 * latest action per scope wins, in created_at, id order). */
export function expectedActive(
  h: StressHarness,
  userId: string,
): Record<string, boolean> {
  const rows = [...h.rowsFor(userId)].sort((a, b) =>
    a.created_at === b.created_at
      ? (a.id < b.id ? -1 : 1)
      : a.created_at < b.created_at
      ? -1
      : 1
  );
  const out: Record<string, boolean> = {};
  for (const scope of CONSENT_SCOPES) {
    const last = rows.filter((r) => r.scope === scope).at(-1);
    out[scope] = last?.action === "grant";
  }
  return out;
}

export function heapNow(): Deno.MemoryUsage {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  return Deno.memoryUsage();
}
