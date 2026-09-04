// stress_* harness for POST /v1/analysis-permits — FAILURE INJECTION + LOAD.
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, exactly like
// routesHarness.ts / sessionHarness.ts) and puts ONE fault-injectable fake
// behind globalThis.fetch for every upstream the route can touch:
//
//   gotrue      GET  /auth/v1/user                      (session bearer verification)
//               POST /auth/v1/token?grant_type=id_token  (transitional provider-token bearer)
//   reserve     POST /rest/v1/rpc/reserve_analysis_permit
//   access      POST /rest/v1/rpc/access_state
//   rest_other  any other /rest/v1/* call (the route must make none)
//   redis       POST <UPSTASH>/pipeline                  (only when booted with redis: true)
//   revenuecat  https://api.revenuecat.com/*             (the route must make none)
//
// The fake is a small stateful MODEL of the two RPCs (idempotent replay,
// 24h reserved window, two lifetime free ratings, premium bypass) so a load
// campaign can run thousands of requests with real outcomes; a test may
// instead plug a real Postgres executor in (`rpcBackend`) so the same real
// handler drives the real reserve_analysis_permit()/access_state() on a
// disposable postgres:16 with every migration applied (stress_permits_pg.test.ts).
//
// Every fault is injected per upstream, counted (one-shot / N-shot / sticky)
// and recorded, and every random choice flows from a seeded PRNG so any
// iteration replays from `STRESS_SEED`.
//
// Nothing here talks to a network: the only fetch that exists is the fake.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const REVENUECAT_URL = "https://api.revenuecat.com";
/** Marker planted in every injected upstream error body; a 5xx body that
 * echoes it has leaked upstream detail to the client. */
export const UPSTREAM_DETAIL_MARKER = "UPSTREAM_DETAIL_MARKER_7f3c";

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Load-campaign request count (>= 1000 for the coordinator's run). */
export const STRESS_ITER = envInt("STRESS_ITER", 200);
/** Distinct users for the L1 memory campaign (20 000 for the coordinator's run). */
export const STRESS_USERS = envInt("STRESS_USERS", 1_000);
/** Randomized fault-campaign iterations (each replays a fault case with a random pre-state). */
export const STRESS_FAULT_ITER = envInt("STRESS_FAULT_ITER", 120);
export const STRESS_OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export class Prng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(16).toString(16);
    return out;
  }
  /** RFC 4122 v4-shaped uuid, fully seeded. */
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = "89ab"[this.int(4)];
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

/** FNV-1a — derive a per-case seed from the campaign seed and a label. */
export function deriveSeed(seed: number, label: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ─── JWT helpers (unsigned: routing / claims only, like the other harnesses) ──

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const raw = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ─── Faults ──────────────────────────────────────────────────────────────────

export type Upstream = "gotrue" | "reserve" | "access" | "rest_other" | "redis" | "revenuecat";

export type Fault =
  /** HTTP answer with a JSON body (default body carries the detail marker). */
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  /** HTTP answer with a raw text body (malformed / non-JSON / HTML gateway page). */
  | { kind: "text"; status: number; text: string; contentType?: string }
  /** fetch() rejects (socket reset / DNS / TLS). */
  | { kind: "throw"; message?: string }
  /** Never answers until `releaseHangs()` (upstream black hole). */
  | { kind: "hang" }
  /** Answers normally after `ms` (slow upstream). */
  | { kind: "delay"; ms: number }
  /** Answers with `status`/`body` after `ms`. */
  | { kind: "delay_status"; ms: number; status: number; body?: unknown };

interface FaultSlot {
  fault: Fault;
  remaining: number;
}

export interface UpstreamCall {
  upstream: Upstream;
  method: string;
  url: string;
  faulted: boolean;
  atMs: number;
}

export interface PermitRowModel {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: string;
  outcome: string | null;
  created_at: string;
}

export interface UserModel {
  id: string;
  premium: boolean;
  /** identity-lifetime scored count (lifetime_scored_count()). */
  scored: number;
  provider: "google" | "apple";
}

export interface SessionModel {
  userId: string;
  sessionId: string;
  /** unix seconds */
  expiresAt: number;
  revoked: boolean;
}

export interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

/** Real-database executor for the two RPCs (stress_permits_pg.test.ts). Each
 * call runs as role `authenticated` with the caller's JWT sub. Throwing maps
 * to a PostgREST 500 error body. */
export interface RpcBackend {
  reserve(userId: string, idempotencyKey: string): Promise<unknown[]>;
  access(userId: string): Promise<unknown[]>;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class StressUpstream {
  readonly prng: Prng;
  readonly faults = new Map<Upstream, FaultSlot>();
  calls: UpstreamCall[] = [];
  users = new Map<string, UserModel>();
  sessions = new Map<string, SessionModel>();
  permits: PermitRowModel[] = [];
  redis = new Map<string, RedisEntry>();
  redisCommands: Array<Array<string | number>> = [];
  rpcBackend: RpcBackend | null = null;
  /** Wall-clock latency added to every model RPC (ms); 0 = as fast as possible. */
  modelLatencyMs = 0;
  private hangReleases: Array<() => void> = [];
  private readonly redisEnabled: boolean;

  constructor(seed: number, options: { redis: boolean }) {
    this.prng = new Prng(seed);
    this.redisEnabled = options.redis;
  }

  // ── faults ────────────────────────────────────────────────────────────────

  /** Apply `fault` to the next `times` calls of `upstream` (Infinity = sticky). */
  inject(upstream: Upstream, fault: Fault, times = 1): void {
    this.faults.set(upstream, { fault, remaining: times });
  }
  clearFaults(): void {
    this.faults.clear();
  }
  /** Let every hung upstream call complete (it then answers normally). */
  releaseHangs(): number {
    const n = this.hangReleases.length;
    for (const release of this.hangReleases) release();
    this.hangReleases = [];
    return n;
  }
  get pendingHangs(): number {
    return this.hangReleases.length;
  }

  // ── model state ───────────────────────────────────────────────────────────

  reset(): void {
    this.faults.clear();
    this.calls = [];
    this.users.clear();
    this.sessions.clear();
    this.permits = [];
    this.redis.clear();
    this.redisCommands = [];
    this.releaseHangs();
  }
  callsTo(upstream: Upstream): UpstreamCall[] {
    return this.calls.filter((c) => c.upstream === upstream);
  }
  addUser(user: Partial<UserModel> & { id: string }): UserModel {
    const full: UserModel = {
      id: user.id,
      premium: user.premium ?? false,
      scored: user.scored ?? 0,
      provider: user.provider ?? "google",
    };
    this.users.set(full.id, full);
    return full;
  }
  /** A Supabase session access token for `userId` (as bootstrap would mint). */
  mintSession(userId: string, ttlSeconds = 3600, sessionId?: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sid = sessionId ?? this.prng.uuid();
    const token = fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: sid,
      exp: expiresAt,
      jti: this.prng.uuid(),
    });
    this.sessions.set(token, { userId, sessionId: sid, expiresAt, revoked: false });
    return token;
  }
  /** A Google ID token (the transitional provider-token bearer). */
  providerIdToken(userId: string, ttlSeconds = 3600): string {
    return fakeJwt({
      iss: "https://accounts.google.com",
      sub: `google-sub-${userId}`,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: this.prng.uuid(),
    });
  }
  permitsOf(userId: string): PermitRowModel[] {
    return this.permits.filter((p) => p.user_id === userId);
  }
  reservedCount(userId: string): number {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.permits.filter(
      (p) => p.user_id === userId && p.status === "reserved" && Date.parse(p.created_at) > cutoff,
    ).length;
  }

  /** The model's reserve_analysis_permit(text) — mirrors migration
   * 20260902150000 (fast path, per-user serialization, identity-lifetime
   * scored count, 24h reserved window, premium bypass). JS is single-threaded
   * and the body below has no await, so it is atomic per call exactly as the
   * advisory lock makes the SQL one. */
  modelReserve(userId: string | null, key: string): unknown[] {
    if (!userId) return [{ result: "auth.required", permit_id: null }];
    const view = (p: PermitRowModel) => ({
      result: "accepted",
      permit_id: p.id,
      permit_status: p.status,
      permit_outcome: p.outcome,
      permit_created_at: p.created_at,
    });
    const existing = this.permits.find((p) => p.user_id === userId && p.idempotency_key === key);
    if (existing) return [view(existing)];
    const user = this.users.get(userId);
    const premium = user?.premium ?? false;
    const scored = user?.scored ?? 0;
    const remaining = 2 - Math.min(scored, 2);
    if (!premium && remaining <= this.reservedCount(userId)) {
      return [{ result: "access.paywall_required", permit_id: null }];
    }
    const row: PermitRowModel = {
      id: this.prng.uuid(),
      user_id: userId,
      idempotency_key: key,
      status: "reserved",
      outcome: null,
      created_at: new Date().toISOString(),
    };
    this.permits.push(row);
    return [view(row)];
  }

  modelAccess(userId: string | null): unknown[] {
    if (!userId) return [];
    const user = this.users.get(userId);
    return [
      {
        premium: user?.premium ?? false,
        scored_count: user?.scored ?? 0,
        reserved_count: this.reservedCount(userId),
      },
    ];
  }

  // ── fetch ─────────────────────────────────────────────────────────────────

  private classify(url: string, method: string): Upstream {
    if (url.startsWith(`${REDIS_URL}/`)) return "redis";
    if (url.startsWith(REVENUECAT_URL)) return "revenuecat";
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "gotrue";
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/reserve_analysis_permit`)) return "reserve";
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/access_state`)) return "access";
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "rest_other";
    throw new Error(`unexpected fetch in stress harness: ${method} ${url}`);
  }

  private takeFault(upstream: Upstream): Fault | null {
    const slot = this.faults.get(upstream);
    if (!slot || slot.remaining <= 0) return null;
    slot.remaining -= 1;
    if (slot.remaining <= 0) this.faults.delete(upstream);
    return slot.fault;
  }

  /** Like the real fetch: a pending call rejects with the signal's reason the
   * moment the caller aborts (AbortSignal.timeout → TimeoutError). */
  private abortable(signal: AbortSignal, wait: Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      wait.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return this.abortable(signal, new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private hang(signal: AbortSignal): Promise<void> {
    return this.abortable(signal, new Promise<void>((resolve) => this.hangReleases.push(resolve)));
  }

  /** The fault's answer, or null when the call should proceed normally. */
  private async applyFault(
    fault: Fault,
    upstream: Upstream,
    signal: AbortSignal,
  ): Promise<Response | null> {
    const detailBody = (status: number, extra: unknown) =>
      upstream === "gotrue"
        ? {
            code: status,
            error_code: "unexpected_failure",
            msg: `${UPSTREAM_DETAIL_MARKER} gotrue ${status}`,
          }
        : upstream === "redis"
          ? { error: `${UPSTREAM_DETAIL_MARKER} upstash ${status}` }
          : {
              message: `${UPSTREAM_DETAIL_MARKER} postgrest ${status}`,
              details: extra ?? null,
              hint: null,
              code: String(status),
            };
    switch (fault.kind) {
      case "status":
        return jsonResponse(
          fault.status,
          fault.body ?? detailBody(fault.status, null),
          fault.headers,
        );
      case "text":
        return new Response(fault.text, {
          status: fault.status,
          headers: { "Content-Type": fault.contentType ?? "text/html" },
        });
      case "throw":
        throw new TypeError(fault.message ?? `error sending request (${UPSTREAM_DETAIL_MARKER})`);
      case "hang":
        await this.hang(signal);
        return null;
      case "delay":
        await this.sleep(fault.ms, signal);
        return null;
      case "delay_status":
        await this.sleep(fault.ms, signal);
        return jsonResponse(fault.status, fault.body ?? detailBody(fault.status, null));
    }
  }

  readonly handleFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const method = request.method;
    const upstream = this.classify(url, method);
    const fault = this.takeFault(upstream);
    this.calls.push({ upstream, method, url, faulted: fault !== null, atMs: performance.now() });
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (fault) {
      const answer = await this.applyFault(fault, upstream, request.signal);
      if (answer) return answer;
    }
    if (request.signal.aborted) throw request.signal.reason;
    switch (upstream) {
      case "redis":
        return this.answerRedis(request, body);
      case "revenuecat":
        return jsonResponse(200, { subscriber: { entitlements: {}, subscriptions: {} } });
      case "gotrue":
        return this.answerGotrue(request, body);
      case "reserve":
      case "access":
        return this.answerRpc(upstream, request, body);
      case "rest_other":
        return jsonResponse(200, []);
    }
  };

  private bearerOf(request: Request): string {
    return (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  }

  private gotrueUser(user: UserModel) {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: `${user.id.slice(0, 8)}@example.com`,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      identities: [],
    };
  }

  private answerGotrue(request: Request, body: unknown): Response {
    const parsed = new URL(request.url);
    if (parsed.pathname === "/auth/v1/user" && request.method === "GET") {
      const session = this.sessions.get(this.bearerOf(request));
      if (!session || session.revoked) {
        return jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT: session not found",
        });
      }
      if (session.expiresAt * 1000 <= Date.now()) {
        return jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT: token is expired",
        });
      }
      const user = this.users.get(session.userId);
      if (!user)
        return jsonResponse(403, {
          code: 403,
          error_code: "user_not_found",
          msg: "User not found",
        });
      return jsonResponse(200, this.gotrueUser(user));
    }
    if (
      parsed.pathname === "/auth/v1/token" &&
      parsed.searchParams.get("grant_type") === "id_token"
    ) {
      const payload = isRecord(body) ? body : {};
      const claims = jwtPayload(typeof payload.id_token === "string" ? payload.id_token : "");
      const sub = typeof claims?.sub === "string" ? claims.sub : "";
      const userId = sub.startsWith("google-sub-") ? sub.slice("google-sub-".length) : "";
      const user = this.users.get(userId);
      if (!user) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Bad ID token",
          error_code: "bad_id_token",
        });
      }
      const token = this.mintSession(user.id);
      const session = this.sessions.get(token)!;
      return jsonResponse(200, {
        access_token: token,
        token_type: "bearer",
        expires_in: Math.max(1, session.expiresAt - Math.floor(Date.now() / 1000)),
        expires_at: session.expiresAt,
        refresh_token: `rt-${this.prng.uuid()}`,
        user: this.gotrueUser(user),
      });
    }
    if (parsed.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return jsonResponse(404, { msg: "not found" });
  }

  private async answerRpc(
    upstream: "reserve" | "access",
    request: Request,
    body: unknown,
  ): Promise<Response> {
    // PostgREST validates the JWT; the model trusts the sub claim the way the
    // real one trusts a signature (the bearer here is the verified session).
    const claims = jwtPayload(this.bearerOf(request));
    const userId = typeof claims?.sub === "string" ? claims.sub : null;
    if (this.modelLatencyMs > 0) await this.sleep(this.modelLatencyMs, request.signal);
    try {
      if (upstream === "reserve") {
        const key =
          isRecord(body) && typeof body.p_idempotency_key === "string"
            ? body.p_idempotency_key
            : "";
        const rows = this.rpcBackend
          ? await this.rpcBackend.reserve(userId ?? "", key)
          : this.modelReserve(userId, key);
        return jsonResponse(200, rows);
      }
      const rows = this.rpcBackend
        ? await this.rpcBackend.access(userId ?? "")
        : this.modelAccess(userId);
      return jsonResponse(200, rows);
    } catch (error) {
      // What PostgREST returns when the statement errors (e.g. 57014 statement_timeout).
      const message = error instanceof Error ? error.message : String(error);
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "XX000";
      return jsonResponse(500, { message, details: null, hint: null, code });
    }
  }

  private answerRedis(request: Request, body: unknown): Response {
    if (!this.redisEnabled) return jsonResponse(401, { error: "Unauthorized" });
    if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
    return jsonResponse(
      200,
      commands.map((command) => this.runRedisCommand(command)),
    );
  }

  private redisLive(key: string): RedisEntry | null {
    const entry = this.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.redis.delete(key);
      return null;
    }
    return entry;
  }

  private runRedisCommand(command: Array<string | number>): { result?: unknown; error?: string } {
    this.redisCommands.push(command);
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: this.redisLive(args[0])?.value ?? null };
      case "TTL": {
        const entry = this.redisLive(args[0]);
        if (!entry) return { result: -2 };
        if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
        return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
      }
      case "SET": {
        const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
        this.redis.set(args[0], {
          value: args[1],
          expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
        });
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) if (this.redis.delete(key)) removed += 1;
        return { result: removed };
      }
      case "INCR": {
        const entry = this.redisLive(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.redis.set(args[0], {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? Infinity,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.redisLive(args[0]);
        if (!entry) return { result: 0 };
        if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }
}

// ─── Boot the real function once per test module ─────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  upstream: StressUpstream;
  /** POST /v1/analysis-permits as the app sends it. */
  permitRequest(options: {
    token?: string | null;
    body?: unknown;
    rawBody?: string;
    ip?: string;
    headers?: Record<string, string>;
  }): Request;
  /** Fresh client IP so per-IP budgets never bleed across cases. */
  freshIp(): string;
}

let booted: StressHarness | null = null;

export async function loadStressHarness(
  options: { redis?: boolean; seed?: number } = {},
): Promise<StressHarness> {
  if (booted) {
    booted.upstream.reset();
    return booted;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "stress-rc-secret");
  for (const name of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
  ]) {
    Deno.env.delete(name);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const upstream = new StressUpstream(options.seed ?? STRESS_SEED, {
    redis: Boolean(options.redis),
  });
  globalThis.fetch = upstream.handleFetch as typeof fetch;

  let captured: ((request: Request) => Promise<Response>) | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    captured = handler;
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
  if (!captured) throw new Error("index.ts did not call Deno.serve");
  const handler = captured as (request: Request) => Promise<Response>;

  let ipCounter = 0;
  const freshIp = () => {
    ipCounter += 1;
    return `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`;
  };

  booted = {
    handler: (request) => handler(request),
    upstream,
    freshIp,
    permitRequest(opts) {
      const headers = new Headers({ "x-forwarded-for": opts.ip ?? freshIp(), ...opts.headers });
      if (opts.token !== null && opts.token !== undefined)
        headers.set("Authorization", `Bearer ${opts.token}`);
      const body =
        opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      if (body !== undefined && !headers.has("content-type"))
        headers.set("Content-Type", "application/json");
      return new Request("http://edge.stress.test/functions/v1/api/v1/analysis-permits", {
        method: "POST",
        headers,
        body,
      });
    },
  };
  return booted;
}

// ─── Response helpers ────────────────────────────────────────────────────────

export interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  permitId: string | null;
  body: unknown;
  text: string;
  latencyMs: number;
}

export async function observe(
  handler: (r: Request) => Promise<Response>,
  request: Request,
): Promise<Observed> {
  const t0 = performance.now();
  const response = await handler(request);
  const text = await response.text();
  const latencyMs = performance.now() - t0;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const permit = isRecord(body) && isRecord(body.permit) ? body.permit : null;
  return {
    status: response.status,
    code: error && typeof error.code === "string" ? error.code : null,
    message: error && typeof error.message === "string" ? error.message : null,
    retryAfter: response.headers.get("Retry-After"),
    permitId: permit && typeof permit.id === "string" ? permit.id : null,
    body,
    text,
    latencyMs,
  };
}

/** Race a handler call against a timer: `pending` when it has not answered
 * within `ms` (used to prove — or disprove — a deadline on a hung upstream). */
export async function raceHandler(
  promise: Promise<Response>,
  ms: number,
): Promise<{ pending: true } | { pending: false; response: Response }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ pending: true }>((resolve) => {
    timer = setTimeout(() => resolve({ pending: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then((response) => ({ pending: false as const, response })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function heapSnapshot(): { heapUsedMb: number; rssMb: number; external: number } {
  const usage = Deno.memoryUsage();
  return {
    heapUsedMb: Math.round((usage.heapUsed / 1_048_576) * 10) / 10,
    rssMb: Math.round((usage.rss / 1_048_576) * 10) / 10,
    external: usage.external,
  };
}

/** Write a JSON report when STRESS_OUT_DIR is set; always echo one summary line. */
export async function writeReport(name: string, report: unknown): Promise<string | null> {
  if (!STRESS_OUT_DIR) {
    console.warn(`[stress] ${name}: STRESS_OUT_DIR unset, report not written`);
    return null;
  }
  await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
  const path = `${STRESS_OUT_DIR.replace(/\/$/, "")}/${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  console.warn(`[stress] ${name}: wrote ${path}`);
  return path;
}
