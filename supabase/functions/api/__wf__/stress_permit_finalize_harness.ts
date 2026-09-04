/**
 * stress harness — POST /v1/analysis-permits/:id/finalize (release/consume).
 *
 * Boots the REAL edge function (../index.ts) in-process behind a stateful
 * fake of every upstream it can reach on this route — Supabase Auth
 * (GoTrue GET /auth/v1/user), PostgREST (`analysis_permits` GET/PATCH with
 * the exact filters + return=representation semantics the route relies on,
 * `access_state` RPC), Upstash Redis REST (/pipeline) and RevenueCat — and
 * adds a FAULT LAYER that makes any one of those upstreams fail, hang, or
 * answer with a malformed body for the nth call inside a request.
 *
 * Nothing here talks to a network: `globalThis.fetch` is replaced before the
 * function is imported, `Deno.serve` is intercepted to capture the handler.
 * Every request is traced (GoTrue / PostgREST / Redis / RevenueCat round
 * trips, faults applied, latency) so the campaigns can report per-request
 * round-trip counts, and every random choice comes from a seeded `Prng` so
 * a case replays from its seed.
 *
 * One isolate per configuration: cache.ts reads UPSTASH_* at import, so the
 * Redis-backed and the L1-only campaigns live in separate test modules.
 */
import { Prng } from "./xc_concurrency_harness.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REVENUECAT_HOST = "https://api.revenuecat.com";
const ANON_KEY = "stress-anon-key";
const REDIS_TOKEN = "stress-upstash-token";

export const RELEASABLE_OUTCOMES = [
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;
export type ReleasableOutcome = (typeof RELEASABLE_OUTCOMES)[number];

// ─── Fault layer ─────────────────────────────────────────────────────────────

/** Which upstream call a fault targets. `rest.select` is every GET on
 * analysis_permits (the route's lookup and its race re-read alike; use
 * `occurrence` to pick one), `rest.update` the conditional PATCH. */
export type UpstreamTarget =
  | "auth"
  | "rest.select"
  | "rest.update"
  | "rpc.access_state"
  | "redis"
  | "revenuecat";

export type FaultAnswer =
  /** fetch rejects (connection refused / reset) */
  | { kind: "network_error"; message?: string }
  /** no answer: rejects with AbortError when the caller's signal fires, else
   * after `ms` with a socket hang-up — PostgREST calls carry no signal. */
  | { kind: "hang"; ms: number }
  /** an HTTP answer of the fake's choosing (status, body, headers) */
  | {
    kind: "http";
    status: number;
    body: string;
    headers?: Record<string, string>;
  }
  /** the normal answer, `ms` late */
  | { kind: "slow"; ms: number };

export interface FaultSpec {
  target: UpstreamTarget;
  /** 1-based index of the matching call within the fault window; omitted = every call */
  occurrence?: number;
  /** fault the nth matching call and every later one (client retries included) */
  minOccurrence?: number;
  /** rest.update only: perform the write before answering with the fault
   * ("the database committed, the answer was lost"). */
  applyWrite?: boolean;
  answer: FaultAnswer;
}

// ─── Fake state ──────────────────────────────────────────────────────────────

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple" | null;
  premium: boolean;
  scoredCount: number;
}

export interface FakeSession {
  accessToken: string;
  userId: string;
  sessionId: string;
  expSeconds: number;
  revoked: boolean;
}

export interface PermitRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: "reserved" | "finalized" | "released";
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpstreamCall {
  target: UpstreamTarget | "other";
  method: string;
  url: string;
  fault: string | null;
  /** redis only: the pipeline's commands */
  commands?: string[];
}

export interface Trace {
  calls: UpstreamCall[];
  gotrue: number;
  postgrest: number;
  redis: number;
  revenuecat: number;
  faultsApplied: number;
}

export function emptyTrace(): Trace {
  return {
    calls: [],
    gotrue: 0,
    postgrest: 0,
    redis: 0,
    revenuecat: 0,
    faultsApplied: 0,
  };
}

export interface SendResult {
  status: number;
  code: string | null;
  message: string | null;
  body: unknown;
  retryAfter: string | null;
  requestId: string | null;
  latencyMs: number;
  trace: Trace;
}

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(JSON.stringify(payload))
  }.stress-signature`;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const pgrstError = (status: number, code: string, message: string) =>
  jsonResponse(status, { code, message, details: null, hint: null });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StressHarness {
  handler: (request: Request) => Promise<Response> = () =>
    Promise.reject(new Error("handler not captured"));
  readonly redisConfigured: boolean;

  users = new Map<string, FakeUser>();
  sessions = new Map<string, FakeSession>();
  permits = new Map<string, PermitRow>();
  redis = new Map<string, RedisEntry>();

  /** Active faults; cleared with `clearFaults()`. */
  faults: FaultSpec[] = [];
  private faultCounters = new Map<UpstreamTarget, number>();

  /** The trace the next upstream call is attributed to (sequential sends). */
  trace: Trace = emptyTrace();
  totals: Trace = emptyTrace();

  /** Seeded per-call upstream latency (0 = none; pure handler overhead). */
  upstreamLatencyMs = 0;
  private latencyRng = new Prng(1);

  constructor(redisConfigured: boolean) {
    this.redisConfigured = redisConfigured;
  }

  reset(): void {
    this.users.clear();
    this.sessions.clear();
    this.permits.clear();
    this.redis.clear();
    this.clearFaults();
    this.trace = emptyTrace();
  }

  clearFaults(): void {
    this.faults = [];
    this.faultCounters.clear();
  }

  /** Install faults for the calls made from now on; counters restart. */
  setFaults(faults: FaultSpec[]): void {
    this.faults = faults;
    this.faultCounters.clear();
  }

  addUser(rng: Prng, overrides: Partial<FakeUser> = {}): FakeUser {
    const id = rng.uuid();
    const user: FakeUser = {
      id,
      email: `u-${id.slice(0, 8)}@example.com`,
      provider: "google",
      premium: false,
      scoredCount: 0,
      ...overrides,
    };
    this.users.set(user.id, user);
    return user;
  }

  mintSession(rng: Prng, userId: string, ttlSeconds = 3600): FakeSession {
    const sessionId = rng.uuid();
    const expSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    const accessToken = fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: expSeconds,
      // a per-token nonce keeps two sessions of one user distinct
      nonce: rng.uuid(),
    });
    const session: FakeSession = {
      accessToken,
      userId,
      sessionId,
      expSeconds,
      revoked: false,
    };
    this.sessions.set(accessToken, session);
    return session;
  }

  addPermit(
    rng: Prng,
    userId: string,
    overrides: Partial<PermitRow> = {},
  ): PermitRow {
    const now = new Date().toISOString();
    const row: PermitRow = {
      id: rng.uuid(),
      user_id: userId,
      idempotency_key: `key-${rng.uuid()}`,
      status: "reserved",
      outcome: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    this.permits.set(row.id, row);
    return row;
  }

  /** A fresh user + session + reserved permit from the case's rng. */
  seedCase(rng: Prng, userOverrides: Partial<FakeUser> = {}) {
    const user = this.addUser(rng, userOverrides);
    const session = this.mintSession(rng, user.id);
    const permit = this.addPermit(rng, user.id);
    return { user, session, permit };
  }

  finalizeRequest(
    permitId: string,
    token: string | null,
    body: unknown,
    ip = "203.0.113.10",
  ): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request(
      `${SUPABASE_URL}/functions/v1/api/v1/analysis-permits/${
        encodeURIComponent(permitId)
      }/finalize`,
      {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    );
  }

  /** Drive one request through the real handler and collect its trace. */
  async send(request: Request): Promise<SendResult> {
    this.trace = emptyTrace();
    const startedAt = performance.now();
    const response = await this.handler(request);
    const text = await response.text();
    const latencyMs = performance.now() - startedAt;
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const error = body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : null;
    const code = error && typeof error === "object" &&
        typeof (error as { code?: unknown }).code ===
          "string"
      ? (error as { code: string }).code
      : null;
    const message = error && typeof error === "object" &&
        typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : null;
    return {
      status: response.status,
      code,
      message,
      body,
      retryAfter: response.headers.get("Retry-After"),
      requestId: response.headers.get("X-Request-Id"),
      latencyMs,
      trace: this.trace,
    };
  }

  // ── fetch dispatcher ──────────────────────────────────────────────────────

  private classify(method: string, url: URL): UpstreamTarget | "other" {
    const href = url.href;
    if (href === `${REDIS_URL}/pipeline`) return "redis";
    if (href.startsWith(REVENUECAT_HOST)) return "revenuecat";
    if (href.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
    if (href.startsWith(`${SUPABASE_URL}/rest/v1/rpc/access_state`)) {
      return "rpc.access_state";
    }
    if (href.startsWith(`${SUPABASE_URL}/rest/v1/analysis_permits`)) {
      if (method === "GET") return "rest.select";
      if (method === "PATCH") return "rest.update";
    }
    return "other";
  }

  private matchFault(target: UpstreamTarget): FaultSpec | null {
    const n = (this.faultCounters.get(target) ?? 0) + 1;
    this.faultCounters.set(target, n);
    for (const fault of this.faults) {
      if (fault.target !== target) continue;
      if (fault.occurrence !== undefined && fault.occurrence !== n) continue;
      if (fault.minOccurrence !== undefined && n < fault.minOccurrence) {
        continue;
      }
      return fault;
    }
    return null;
  }

  private async answerFault(
    fault: FaultSpec,
    signal: AbortSignal | null,
    normal: () => Promise<Response>,
  ): Promise<Response> {
    const answer = fault.answer;
    switch (answer.kind) {
      case "network_error":
        throw new TypeError(
          answer.message ?? "error sending request for url: connection refused",
        );
      case "hang": {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, answer.ms);
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timer);
              reject(
                new DOMException("The signal has been aborted", "AbortError"),
              );
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(
                  new DOMException("The signal has been aborted", "AbortError"),
                );
              },
              { once: true },
            );
          }
        });
        throw new TypeError(
          "error sending request for url: connection reset (socket hang up)",
        );
      }
      case "http":
        return new Response(answer.body, {
          status: answer.status,
          headers: {
            "Content-Type": "application/json",
            ...(answer.headers ?? {}),
          },
        });
      case "slow":
        await sleep(answer.ms);
        return await normal();
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text().catch(() => "");
    const target = this.classify(request.method, url);
    const call: UpstreamCall = {
      target,
      method: request.method,
      url: url.href,
      fault: null,
    };
    this.trace.calls.push(call);
    const bump = (trace: Trace) => {
      if (target === "auth") trace.gotrue += 1;
      else if (
        target === "rest.select" || target === "rest.update" ||
        target === "rpc.access_state"
      ) {
        trace.postgrest += 1;
      } else if (target === "redis") trace.redis += 1;
      else if (target === "revenuecat") trace.revenuecat += 1;
    };
    bump(this.trace);
    bump(this.totals);

    if (this.upstreamLatencyMs > 0) {
      await sleep(this.latencyRng.int(0, this.upstreamLatencyMs));
    }

    const fault = target === "other" ? null : this.matchFault(target);
    const normal = () => this.answer(target, request, url, text, call);
    if (!fault) return await normal();
    call.fault = `${fault.answer.kind}${
      fault.answer.kind === "http" ? `:${fault.answer.status}` : ""
    }`;
    this.trace.faultsApplied += 1;
    this.totals.faultsApplied += 1;
    if (fault.applyWrite && target === "rest.update") {
      this.applyPatch(url, text, request.headers);
    }
    return await this.answerFault(fault, request.signal ?? null, normal);
  }

  private bearerSub(headers: Headers): string | null {
    const bearer = (headers.get("authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    const sub = jwtPayload(bearer)?.sub;
    return typeof sub === "string" ? sub : null;
  }

  private async answer(
    target: UpstreamTarget | "other",
    request: Request,
    url: URL,
    text: string,
    call: UpstreamCall,
  ): Promise<Response> {
    switch (target) {
      case "redis":
        return this.answerRedis(request, text, call);
      case "revenuecat":
        return jsonResponse(200, { subscriber: { entitlements: {} } });
      case "auth":
        return this.answerAuth(request, url);
      case "rpc.access_state":
        return this.answerAccessState(request);
      case "rest.select":
        return this.answerSelect(request, url);
      case "rest.update":
        return this.answerUpdate(request, url, text);
      default:
        return new Response(
          `unexpected fetch in stress harness: ${request.method} ${url.href}`,
          {
            status: 599,
          },
        );
    }
  }

  private answerAuth(request: Request, url: URL): Response {
    const authError = (status: number, msg: string) =>
      jsonResponse(status, { code: status, msg, error_code: "bad_jwt" });
    if (url.pathname.endsWith("/auth/v1/user") && request.method === "GET") {
      if (request.headers.get("apikey") !== ANON_KEY) {
        return authError(401, "No API key found");
      }
      const bearer = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      const session = this.sessions.get(bearer);
      if (!session || session.revoked) {
        return authError(401, "invalid JWT: session not found");
      }
      if (session.expSeconds * 1000 <= Date.now()) {
        return authError(401, "invalid JWT: token is expired");
      }
      const user = this.users.get(session.userId);
      if (!user) return authError(403, "user not found");
      return jsonResponse(200, {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: user.provider
          ? { provider: user.provider, providers: [user.provider] }
          : { provider: "email", providers: ["email"] },
        user_metadata: {},
        identities: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }
    return jsonResponse(404, { code: 404, msg: "not found" });
  }

  private answerAccessState(request: Request): Response {
    const sub = this.bearerSub(request.headers);
    if (!sub) return pgrstError(401, "PGRST301", "JWT expired");
    const user = this.users.get(sub);
    const reserved = [...this.permits.values()].filter(
      (p) => p.user_id === sub && p.status === "reserved",
    ).length;
    return jsonResponse(200, [
      {
        premium: user?.premium ?? false,
        scored_count: user?.scoredCount ?? 0,
        reserved_count: reserved,
      },
    ]);
  }

  /** RLS scope + the eq. filters the route sends. */
  private visibleRows(url: URL, headers: Headers): PermitRow[] {
    const sub = this.bearerSub(headers);
    if (!sub) return [];
    let rows = [...this.permits.values()].filter((p) => p.user_id === sub);
    for (const [key, raw] of url.searchParams) {
      if (key === "select") continue;
      const m = /^eq\.(.*)$/.exec(raw);
      if (!m) continue;
      const value = m[1];
      rows = rows.filter((row) =>
        String(row[key as keyof PermitRow]) === value
      );
    }
    return rows;
  }

  private project(url: URL, rows: PermitRow[]): Array<Record<string, unknown>> {
    const select = url.searchParams.get("select") ?? "*";
    const columns = select === "*"
      ? null
      : select.split(",").map((c) => c.trim()).filter(Boolean);
    return rows.map((row) => {
      if (!columns) return { ...row };
      const out: Record<string, unknown> = {};
      for (const column of columns) {
        out[column] = row[column as keyof PermitRow];
      }
      return out;
    });
  }

  private answerSelect(request: Request, url: URL): Response {
    if (!this.bearerSub(request.headers)) {
      return pgrstError(401, "PGRST301", "JWT expired");
    }
    const rows = this.visibleRows(url, request.headers);
    return jsonResponse(200, this.project(url, rows), {
      "Content-Range": `0-${Math.max(0, rows.length - 1)}/*`,
    });
  }

  /** Apply the PATCH body to the visible+filtered rows; returns them. */
  private applyPatch(url: URL, text: string, headers: Headers): PermitRow[] {
    let patch: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        patch = parsed as Record<string, unknown>;
      }
    } catch {
      patch = {};
    }
    const rows = this.visibleRows(url, headers);
    const now = new Date().toISOString();
    for (const row of rows) {
      for (const [key, value] of Object.entries(patch)) {
        // Column-level UPDATE grant (20260831160000): status + outcome only.
        if (key !== "status" && key !== "outcome") {
          throw new Error(
            `grant violation: authenticated cannot update ${key}`,
          );
        }
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updated_at = now;
    }
    return rows;
  }

  private answerUpdate(request: Request, url: URL, text: string): Response {
    if (!this.bearerSub(request.headers)) {
      return pgrstError(401, "PGRST301", "JWT expired");
    }
    let rows: PermitRow[];
    try {
      rows = this.applyPatch(url, text, request.headers);
    } catch (error) {
      return pgrstError(
        403,
        "42501",
        error instanceof Error ? error.message : String(error),
      );
    }
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("return=representation")) {
      return jsonResponse(200, this.project(url, rows));
    }
    return new Response(null, { status: 204 });
  }

  // ── Upstash fake ──────────────────────────────────────────────────────────

  private redisLive(key: string): RedisEntry | null {
    const entry = this.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.redis.delete(key);
      return null;
    }
    return entry;
  }

  private runRedisCommand(
    command: Array<string | number>,
  ): { result?: unknown; error?: string } {
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: this.redisLive(args[0])?.value ?? null };
      case "TTL": {
        const entry = this.redisLive(args[0]);
        if (!entry) return { result: -2 };
        if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
        return {
          result: Math.max(
            1,
            Math.ceil((entry.expiresAtMs - Date.now()) / 1000),
          ),
        };
      }
      case "SET": {
        const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
        this.redis.set(args[0], {
          value: args[1],
          expiresAtMs: Number.isFinite(ttl)
            ? Date.now() + ttl * 1000
            : Infinity,
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

  private answerRedis(
    request: Request,
    text: string,
    call: UpstreamCall,
  ): Response {
    if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    let commands: Array<Array<string | number>> = [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        commands = parsed as Array<Array<string | number>>;
      }
    } catch {
      commands = [];
    }
    call.commands = commands.map((c) => String(c[0]));
    return jsonResponse(
      200,
      commands.map((command) => this.runRedisCommand(command)),
    );
  }
}

let booted: StressHarness | null = null;

/** Boot the real edge function once per isolate. The Redis choice is fixed
 * at first load (cache.ts reads UPSTASH_* at import). */
export async function loadStressHarness(
  options: { redis: boolean },
): Promise<StressHarness> {
  if (booted) {
    if (booted.redisConfigured !== options.redis) {
      throw new Error(
        "stress harness already booted with a different Redis configuration",
      );
    }
    booted.reset();
    return booted;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stress-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "stress-revenuecat-key");
  for (
    const name of [
      "APPLE_SIGN_IN_CLIENT_ID",
      "APPLE_SIGN_IN_TEAM_ID",
      "APPLE_SIGN_IN_KEY_ID",
      "APPLE_SIGN_IN_PRIVATE_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY",
    ]
  ) {
    Deno.env.delete(name);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const harness = new StressHarness(options.redis);
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      harness.fetch(input, init)) as typeof fetch;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    harness.handler = handler;
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
  booted = harness;
  return harness;
}

// ─── Reporting helpers ───────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);

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
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    n: sorted.length,
    minMs: round(sorted[0] ?? NaN),
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

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-permit-finalize/latest/",
    import.meta.url,
  ).pathname;
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

export function heapSnapshot() {
  const usage = Deno.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
  };
}
