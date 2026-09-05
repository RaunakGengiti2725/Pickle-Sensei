// stress-route-post-v1-analyses-id / failure-load — FAULT-INJECTING upstream
// for the REAL edge handler (../index.ts, Deno.serve captured in-process).
//
// The unit under test is the only `POST /v1/analyses/:id…` route the router
// exposes: `POST /v1/analyses/:id/feedback` (submitAnalysisFeedback). Its
// upstreams, in call order, are
//
//   auth     GET  {SUPABASE_URL}/auth/v1/user            (session bearer, cold cache)
//            POST {SUPABASE_URL}/auth/v1/token?grant_type=id_token (transitional provider bearer)
//   shots    GET  {SUPABASE_URL}/rest/v1/shots?select=id&id=eq.…&user_id=eq.…
//   consent  GET  {SUPABASE_URL}/rest/v1/consent_records?…
//   insert   POST {SUPABASE_URL}/rest/v1/analysis_feedback?select=id,created_at
//   redis    POST {UPSTASH_REDIS_REST_URL}/pipeline      (only when the isolate booted with Upstash set)
//   rc       GET  https://api.revenuecat.com/…            (never on this route — asserted)
//
// Every upstream can be put into one FaultMode at a time; everything else
// answers from a small in-memory model (users/sessions, shots, consent rows,
// analysis_feedback with its (analysis_id, user_id) uniqueness, a Redis that
// understands exactly the commands cache.ts issues). Every upstream call is
// recorded with its target so a request's Supabase round trips can be counted.
//
// Nothing here touches a network: `globalThis.fetch` is replaced before
// ../index.ts is imported, and Deno.serve is captured.

import { captureAccessLog } from "../http.ts";
import {
  b64url,
  isRecord,
  jwtPayload,
  Prng,
} from "./xc_concurrency_harness.ts";

export { isRecord, Prng };

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://redis.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
const REDIS_TOKEN = "stress-redis-token";

/** A string that only ever appears in INJECTED upstream error bodies; a
 * client-visible response containing it is a detail leak. */
export const CANARY = "CANARY_UPSTREAM_DETAIL_7f3a";

export type Target =
  | "auth"
  | "shots"
  | "consent"
  | "insert"
  | "redis"
  | "rc"
  | "other";

export type FaultMode =
  | { kind: "ok" }
  /** An HTTP answer with this status and raw body (default: a JSON error carrying the canary). */
  | {
    kind: "http";
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }
  /** Answer only after `ms`; honours the caller's AbortSignal like a real socket. */
  | { kind: "hang"; ms: number }
  /** Connection-level failure (TypeError, as Deno's fetch throws). `times`
   * bounds how many consecutive calls fail (default: every call). */
  | { kind: "throw"; times?: number }
  /** 2xx with a body that is not JSON. */
  | { kind: "malformed" }
  /** 2xx with an empty body. */
  | { kind: "empty" }
  /** 2xx with this JSON body, whatever the caller expected. */
  | { kind: "shape"; body: unknown; status?: number };

export interface FaultPlan {
  auth?: FaultMode;
  shots?: FaultMode;
  consent?: FaultMode;
  insert?: FaultMode;
  redis?: FaultMode;
  rc?: FaultMode;
}

export interface UpstreamCall {
  t: number;
  target: Target;
  method: string;
  url: string;
  status: number | "throw" | "abort";
  ms: number;
}

export interface FeedbackRow {
  id: string;
  user_id: string;
  analysis_id: string;
  rating: string;
  category: string | null;
  created_at: string;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** PostgREST-shaped error body. */
function pgrstError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
) {
  return jsonResponse(status, { code, message, details, hint: null });
}

function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

/** Wait `ms` unless `signal` aborts first (then reject exactly like fetch). */
function hang(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
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

export class StressUpstream {
  plan: FaultPlan = {};
  calls: UpstreamCall[] = [];
  /** Per-target remaining "throw" budget (FaultMode.throw.times). */
  private throwBudget = new Map<Target, number>();
  users = new Map<string, { email: string; provider: "google" | "apple" }>();
  /** access token → user id (session bearers minted by mintSession). */
  sessions = new Map<string, string>();
  shots: Array<{ id: string; user_id: string }> = [];
  consent: Array<{
    user_id: string;
    scope: string;
    action: string;
    consent_version: string | null;
    created_at: string;
    id: string;
  }> = [];
  feedback: FeedbackRow[] = [];
  redis = new Map<string, { value: string; expiresAtMs: number }>();
  redisCommands: Array<Array<string | number>> = [];
  /** Extra latency (ms) applied to every non-faulted Supabase answer. */
  baseLatencyMs = 0;
  private t0 = performance.now();
  private mint = 0;

  reset(): void {
    this.plan = {};
    this.calls = [];
    this.throwBudget.clear();
    this.users.clear();
    this.sessions.clear();
    this.shots = [];
    this.consent = [];
    this.feedback = [];
    this.redis.clear();
    this.redisCommands = [];
    this.baseLatencyMs = 0;
  }

  setFault(target: keyof FaultPlan, mode: FaultMode | undefined): void {
    this.plan[target] = mode;
    if (mode?.kind === "throw") {
      this.throwBudget.set(target, mode.times ?? Infinity);
    } else this.throwBudget.delete(target);
  }

  callsTo(target: Target): UpstreamCall[] {
    return this.calls.filter((c) => c.target === target);
  }

  /** Supabase round trips (auth + PostgREST) recorded since `from`. */
  supabaseRoundTrips(from = 0): number {
    return this.calls
      .slice(from)
      .filter((c) =>
        c.target === "auth" || c.target === "shots" || c.target === "consent" ||
        c.target === "insert" ||
        (c.target === "other" && c.url.startsWith(SUPABASE_URL))
      )
      .length;
  }

  // ── model setup ──

  ensureUser(userId: string, provider: "google" | "apple" = "google"): void {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        email: `${userId.slice(0, 8)}@example.com`,
        provider,
      });
    }
  }

  /** A Supabase session access token for `userId` (fresh session_id each call). */
  mintSession(userId: string, ttlSeconds = 3600): string {
    this.ensureUser(userId);
    this.mint += 1;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: `sess-${this.mint}-${userId.slice(0, 8)}`,
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
          jti: `${this.mint}-${crypto.randomUUID()}`,
        }),
      )
    }.sig`;
    this.sessions.set(token, userId);
    return token;
  }

  addShot(userId: string, shotId: string): void {
    this.ensureUser(userId);
    this.shots.push({ id: shotId, user_id: userId });
  }

  grantConsent(userId: string, scope: string): void {
    this.consent.push({
      id: crypto.randomUUID(),
      user_id: userId,
      scope,
      action: "grant",
      consent_version: "2026-08-29",
      created_at: new Date().toISOString(),
    });
  }

  private userJson(userId: string) {
    const user = this.users.get(userId)!;
    return {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  // ── fault application ──

  private async faulted(
    target: Target,
    mode: FaultMode | undefined,
    signal: AbortSignal | null | undefined,
    ok: () => Response | Promise<Response>,
  ): Promise<Response> {
    if (!mode || mode.kind === "ok") {
      if (this.baseLatencyMs > 0 && target !== "redis" && target !== "rc") {
        await hang(this.baseLatencyMs, signal);
      }
      return await ok();
    }
    switch (mode.kind) {
      case "http":
        return new Response(
          mode.body ?? JSON.stringify({
            code: "STRESS",
            message: `${CANARY} ${target} http ${mode.status}`,
            details: CANARY,
            hint: null,
            error: "stress_fault",
            error_description: CANARY,
            msg: CANARY,
          }),
          {
            status: mode.status,
            headers: {
              "Content-Type": "application/json",
              ...(mode.headers ?? {}),
            },
          },
        );
      case "hang":
        await hang(mode.ms, signal);
        return await ok();
      case "throw": {
        const left = this.throwBudget.get(target) ?? Infinity;
        if (left > 0) {
          this.throwBudget.set(target, left - 1);
          throw new TypeError(
            `error sending request for url (${target}): connection reset`,
          );
        }
        return await ok();
      }
      case "malformed":
        return new Response(
          `<html><body>${CANARY} bad gateway page</body></html>`,
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      case "empty":
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      case "shape":
        return jsonResponse(mode.status ?? 200, mode.body);
    }
  }

  // ── redis model (exactly the commands cache.ts issues) ──

  private redisExec(
    command: Array<string | number>,
  ): { result?: unknown; error?: string } {
    const [op, ...args] = command.map(String);
    const now = Date.now();
    const live = (key: string) => {
      const entry = this.redis.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= now) {
        this.redis.delete(key);
        return null;
      }
      return entry;
    };
    switch (op) {
      case "GET":
        return { result: live(args[0])?.value ?? null };
      case "SET": {
        const exIndex = args.indexOf("EX");
        const ttl = exIndex >= 0 ? Number(args[exIndex + 1]) : 3600;
        this.redis.set(args[0], {
          value: args[1],
          expiresAtMs: now + ttl * 1000,
        });
        return { result: "OK" };
      }
      case "TTL": {
        const entry = live(args[0]);
        if (!entry) return { result: -2 };
        return {
          result: Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1000)),
        };
      }
      case "INCR": {
        const entry = live(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.redis.set(args[0], {
          value: String(next),
          expiresAtMs: entry ? entry.expiresAtMs : Infinity,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = live(args[0]);
        if (!entry) return { result: 0 };
        if (args[2] === "NX" && entry.expiresAtMs !== Infinity) {
          return { result: 0 };
        }
        entry.expiresAtMs = now + Number(args[1]) * 1000;
        return { result: 1 };
      }
      case "DEL": {
        let n = 0;
        for (const key of args) if (this.redis.delete(key)) n++;
        return { result: n };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }

  // ── dispatcher ──

  private classify(request: Request): Target {
    const url = request.url;
    if (url.startsWith(RC_URL)) return "rc";
    if (url.startsWith(REDIS_URL)) return "redis";
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/shots`)) return "shots";
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/consent_records`)) {
      return "consent";
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/analysis_feedback`)) {
      return "insert";
    }
    return "other";
  }

  async dispatch(request: Request, rawBody: string): Promise<Response> {
    const target = this.classify(request);
    const started = performance.now();
    const record = (status: UpstreamCall["status"]) =>
      this.calls.push({
        t: Math.round((started - this.t0) * 100) / 100,
        target,
        method: request.method,
        url: request.url,
        status,
        ms: Math.round((performance.now() - started) * 100) / 100,
      });
    try {
      const response = await this.faulted(
        target,
        this.plan[target as keyof FaultPlan],
        request.signal,
        () => this.answer(target, request, rawBody),
      );
      record(response.status);
      return response;
    } catch (error) {
      record(
        error instanceof DOMException && error.name === "AbortError"
          ? "abort"
          : "throw",
      );
      throw error;
    }
  }

  private bearerOf(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  }

  private answer(target: Target, request: Request, rawBody: string): Response {
    const url = new URL(request.url);
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    switch (target) {
      case "rc":
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: { entitlements: {} },
        });
      case "redis": {
        this.redisCommands.push(
          ...(Array.isArray(body)
            ? (body as Array<Array<string | number>>)
            : []),
        );
        const results = Array.isArray(body)
          ? (body as Array<Array<string | number>>).map((command) =>
            this.redisExec(command)
          )
          : [];
        return jsonResponse(200, results);
      }
      case "auth": {
        const path = url.pathname.slice("/auth/v1/".length);
        if (path === "user" && request.method === "GET") {
          const userId = this.sessions.get(this.bearerOf(request));
          if (!userId) {
            return jsonResponse(403, {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            });
          }
          return jsonResponse(200, this.userJson(userId));
        }
        if (
          path === "token" && url.searchParams.get("grant_type") === "id_token"
        ) {
          const idToken = isRecord(body) && typeof body.id_token === "string"
            ? body.id_token
            : "";
          const sub = jwtPayload(idToken)?.sub;
          if (typeof sub !== "string" || !sub) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "bad id token",
            });
          }
          const provider = isRecord(body) && body.provider === "apple"
            ? "apple"
            : "google";
          this.ensureUser(sub, provider);
          const access = this.mintSession(sub);
          return jsonResponse(200, {
            access_token: access,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: `rt-${this.mint}`,
            user: this.userJson(sub),
          });
        }
        return jsonResponse(404, {
          msg: `stress harness: unmodelled auth path ${path}`,
        });
      }
      case "shots":
      case "consent":
      case "insert":
        return this.postgrest(target, request, url, body);
      default:
        return new Response(
          `stress harness: unexpected fetch ${request.method} ${request.url}`,
          {
            status: 599,
          },
        );
    }
  }

  /** The acting user of a PostgREST call: the JWT sub of its bearer (RLS). */
  private principal(request: Request): string | null {
    const token = this.bearerOf(request);
    if (!token || token === ANON_KEY) return null;
    if (token === SERVICE_ROLE_KEY) return "service";
    const sub = jwtPayload(token)?.sub;
    return typeof sub === "string" ? sub : null;
  }

  private postgrest(
    target: Target,
    request: Request,
    url: URL,
    body: unknown,
  ): Response {
    const who = this.principal(request);
    if (!who) return pgrstError(401, "PGRST301", "JWT expired");
    const accept = request.headers.get("accept") ?? "";
    const wantsObject = accept.includes("application/vnd.pgrst.object+json");
    const eq = (col: string) => {
      const raw = url.searchParams.get(col);
      return raw?.startsWith("eq.") ? raw.slice(3) : null;
    };
    const shaped = (rows: Array<Record<string, unknown>>, status = 200) => {
      if (!wantsObject) return jsonResponse(status, rows);
      if (rows.length !== 1) {
        return pgrstError(
          406,
          "PGRST116",
          "JSON object requested, multiple (or no) rows returned",
          `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
        );
      }
      return jsonResponse(status, rows[0]);
    };
    if (target === "shots" && request.method === "GET") {
      const id = eq("id");
      const userId = eq("user_id");
      const rows = this.shots
        .filter((s) =>
          (who === "service" || s.user_id === who) &&
          (id === null || s.id === id) &&
          (userId === null || s.user_id === userId)
        )
        .map((s) => ({ id: s.id }));
      return shaped(rows);
    }
    if (target === "consent" && request.method === "GET") {
      const userId = eq("user_id");
      const rows = this.consent
        .filter((c) =>
          (who === "service" || c.user_id === who) &&
          (userId === null || c.user_id === userId)
        )
        .sort((a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
        )
        .map(({ scope, action, consent_version, created_at }) => ({
          scope,
          action,
          consent_version,
          created_at,
        }));
      return shaped(rows);
    }
    if (target === "insert" && request.method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const out: Array<Record<string, unknown>> = [];
      for (const raw of rows) {
        if (!isRecord(raw)) {
          return pgrstError(400, "PGRST102", "Empty or invalid json");
        }
        const userId = String(raw.user_id ?? "");
        if (who !== "service" && userId !== who) {
          return pgrstError(
            403,
            "42501",
            'new row violates row-level security policy for table "analysis_feedback"',
          );
        }
        const analysisId = String(raw.analysis_id ?? "");
        if (
          this.feedback.some((f) =>
            f.analysis_id === analysisId && f.user_id === userId
          )
        ) {
          return pgrstError(
            409,
            "23505",
            'duplicate key value violates unique constraint "analysis_feedback_analysis_id_user_id_key"',
            `Key (analysis_id, user_id)=(${analysisId}, ${userId}) already exists.`,
          );
        }
        const row: FeedbackRow = {
          id: crypto.randomUUID(),
          user_id: userId,
          analysis_id: analysisId,
          rating: String(raw.rating),
          category: typeof raw.category === "string" ? raw.category : null,
          created_at: new Date().toISOString(),
        };
        this.feedback.push(row);
        out.push({ id: row.id, created_at: row.created_at });
      }
      return shaped(out, 201);
    }
    return pgrstError(
      405,
      "PGRST105",
      `stress harness: unmodelled ${request.method} ${url.pathname}`,
    );
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface AccessLine {
  evt: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  upstream: StressUpstream;
  accessLog: AccessLine[];
  /** Whether this isolate booted the function with Upstash configured. */
  redis: boolean;
  /** console.error/warn lines the function emitted (operator-side detail). */
  serverLog: string[];
}

let loaded: StressHarness | null = null;

/** Boot ../index.ts once per isolate. `redis` must be decided before the
 * first call (cache.ts reads UPSTASH_* at import time). */
export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (loaded) {
    if (options.redis !== undefined && options.redis !== loaded.redis) {
      throw new Error(
        "stress harness: redis mode is fixed per isolate; use a separate test file",
      );
    }
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const upstream = new StressUpstream();
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.text().catch(() => "");
    return upstream.dispatch(request, rawBody);
  }) as typeof fetch;

  const serverLog: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => {
    serverLog.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    serverLog.push(args.map(String).join(" "));
  };
  void realError;
  void realWarn;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | StressHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }

  const accessLog: AccessLine[] = [];
  captureAccessLog((line) => accessLog.push(JSON.parse(line) as AccessLine));

  loaded = {
    handler,
    upstream,
    accessLog,
    redis: Boolean(options.redis),
    serverLog,
  };
  return loaded;
}

// ── Request builders ─────────────────────────────────────────────────────────

export function feedbackRequest(
  analysisId: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    /** Path suffix after /v1/analyses/:id (default "/feedback"). */
    suffix?: string;
    method?: string;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.42",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const rawBody = options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (rawBody !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(
    `http://edge.stress.test/functions/v1/api/v1/analyses/${analysisId}${
      options.suffix ?? "/feedback"
    }`,
    { method: options.method ?? "POST", headers, body: rawBody },
  );
}

export function fakeGoogleIdToken(sub: string, nonce = ""): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(nonce ? { nonce } : {}),
    }),
  );
  return `${header}.${payload}.sig`;
}

export interface Outcome {
  status: number;
  code?: string;
  message?: string;
  retryAfter: string | null;
  requestId: string | null;
  bodyText: string;
  ms: number;
}

/** Drive one request through the real handler and read the whole answer. */
export async function drive(
  h: StressHarness,
  request: Request,
): Promise<Outcome> {
  const t0 = performance.now();
  const response = await h.handler(request);
  const bodyText = await response.text();
  const ms = performance.now() - t0;
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const err = parsed.error;
    if (isRecord(err)) {
      if (typeof err.code === "string") code = err.code;
      if (typeof err.message === "string") message = err.message;
    }
  } catch {
    // non-JSON body: reported via bodyText
  }
  return {
    status: response.status,
    code,
    message,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    bodyText,
    ms: Math.round(ms * 100) / 100,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Seeds per fault case / scale multiplier for the campaigns. Small by
 * default so the files live in `deno task test`; the full campaigns run with
 * STRESS_ITER=… (see each file's header). */
export const STRESS_ITER = envInt("STRESS_ITER", 1);
export const STRESS_SEED = envInt("STRESS_SEED", 20260905);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-post-v1-analyses-id/latest/",
    import.meta.url,
  )
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
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

export function latencySummary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : 0,
  };
}

/** Seeded per-iteration identities: user, analysis, IP and payload. */
export function seededCase(seed: number) {
  const prng = new Prng(seed);
  const userId = prng.uuid();
  const analysisId = prng.uuid();
  const notQuite = prng.next() < 0.5;
  const categories = [
    "wrong_stroke",
    "wrong_player",
    "contact_looks_wrong",
    "feedback_mismatch",
    "other",
  ];
  const category = categories[prng.int(0, categories.length - 1)];
  const ip = `10.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`;
  return {
    prng,
    userId,
    analysisId,
    ip,
    body: notQuite ? { rating: "not_quite", category } : { rating: "accurate" },
    consentGranted: prng.next() < 0.5,
  };
}
