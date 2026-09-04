// stress-route-get-v1-me-access — failure-injection + load harness for the
// REAL edge handler (../index.ts, Deno.serve captured), lens `failure-load`.
//
// Every upstream the route can reach sits behind one programmable fetch:
//   auth  — GoTrue  (GET /auth/v1/user, POST /auth/v1/token?grant_type=id_token)
//   db    — PostgREST (POST /rest/v1/rpc/access_state)
//   redis — Upstash REST (/pipeline) — only when loaded with `redis: true`
//   rc    — RevenueCat subscribers API
// A `Fault` on an upstream replaces its next answers (HTTP status, thrown
// socket error, hang honouring the caller's AbortSignal, malformed 2xx body,
// wrongly-shaped JSON, or extra latency). Everything is recorded: every
// upstream call carries the bearer it was made with, so Supabase round trips
// are attributable PER REQUEST even under Promise.all bursts.
//
// Seeded (mulberry32 via xc_concurrency_harness.Prng): every case derives its
// user id / token / counters / client IP from `caseSeed(STRESS_SEED, caseId)`,
// so a failing case replays with the printed command. Nothing here touches a
// network: the only fetch that exists is the fake.

import { captureAccessLog } from "../http.ts";
import { type AccessLogEntry } from "../http.ts";
import { b64url, envInt, isRecord, jwtPayload, Prng } from "./xc_concurrency_harness.ts";

export { envInt, isRecord, Prng };

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
/** Short Auth deadline so timeout cases run in well under a second. The
 * production default is 6 000 ms; only the constant differs, not the path. */
export const AUTH_TIMEOUT_MS = 400;

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Per-case seed: replayable from STRESS_SEED + the case id alone. */
export function caseSeed(caseId: string): number {
  return (STRESS_SEED ^ fnv1a(caseId)) >>> 0;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Faults ───────────────────────────────────────────────────────────────────

export type Upstream = "auth" | "db" | "redis" | "rc";

export type Fault =
  /** An HTTP answer with this status (default body: a JSON error object). */
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  /** fetch() rejects (connection reset / refused / DNS). */
  | { kind: "throw"; message?: string }
  /** No answer for `ms`. Rejects with AbortError if the caller aborts first;
   * otherwise (when `then` is "answer") continues with the normal answer, or
   * (when `then` is "release") waits until `release()` is called. */
  | { kind: "hang"; ms: number; then?: "answer" | "release" }
  /** A 2xx with exactly this raw body (malformed / non-JSON / empty…). */
  | { kind: "body"; status?: number; body: string; contentType?: string }
  /** A 2xx whose JSON body is `value` (shaped but wrong). */
  | { kind: "json"; status?: number; value: unknown }
  /** Correct answer, `ms` late. */
  | { kind: "delay"; ms: number };

export interface Faults {
  auth?: Fault;
  db?: Fault;
  redis?: Fault;
  rc?: Fault;
}

export interface UpstreamCall {
  t: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** Bearer the call was made with ("" when none) — request attribution.
   * For the id_token grant (which bears the anon key) this is the ID token
   * from the body, and the session it mints is aliased back to that token. */
  bearer: string;
  status: number | "throw" | "abort";
  faulted: boolean;
}

export interface UserState {
  id: string;
  email: string;
  provider: "google" | "apple";
  premium: boolean;
  scored_count: number;
  reserved_count: number;
}

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  faults: Faults;
  users: Map<string, UserState>;
  /** access token → user id (GoTrue session table) */
  sessions: Map<string, string>;
  /** session access token minted by an id_token grant → the ID token. */
  aliases: Map<string, string>;
  redis: Map<string, RedisEntry>;
  redisCommands: Array<Array<string | number>>;
  calls: UpstreamCall[];
  accessLog: AccessLogEntry[];
  /** `[api] …` lines console.error'd by the function (operator detail). */
  serverErrors: string[];
  /** When set, the fake PostgREST answers `rpc/access_state` with whatever
   * this returns for the bearer's `sub` (e.g. the REAL `access_state()` on a
   * disposable Postgres) instead of the modelled `users` row. */
  accessStateResolver: ((userId: string) => Promise<unknown>) | null;
  /** Resolve every fault of kind "hang"/"release" currently parked. */
  release(): void;
  reset(): void;
  /** Put back the real fetch/console.error/access-log sink and the
   * AUTH_UPSTREAM_TIMEOUT_MS the process started with. `deno task test`
   * runs every module in one isolate, so each stress module calls this as
   * its last step; the next loadStressHarness() re-installs. */
  teardown(): void;
  registerUser(state: Partial<UserState> & { id: string }): UserState;
  /** A Supabase session access token GoTrue will verify for this user. */
  mintSession(userId: string, ttlSeconds?: number): string;
  /** A Google/Apple ID token (transitional bearer) for this user. */
  mintProviderToken(userId: string, ttlSeconds?: number): string;
  /** Supabase (auth + db) round trips made with this bearer, in order. */
  supabaseCallsFor(bearer: string): UpstreamCall[];
  callsTo(upstream: Upstream): UpstreamCall[];
}

let loaded: StressHarness | null = null;
const noop = () => {};
let install: () => void = noop;
let uninstall: () => void = noop;

const jsonResponse = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

function gotrueUser(user: UserState): Record<string, unknown> {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function redisLive(state: StressHarness, key: string): RedisEntry | null {
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

class HangAborted extends DOMException {
  constructor() {
    super("The signal has been aborted", "AbortError");
  }
}

/** Boot the real edge function once per test module (cache.ts fixes the
 * Redis choice at import, so `redis` is honoured on the FIRST load only). */
export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<StressHarness> {
  if (loaded) {
    loaded.reset();
    install();
    return loaded;
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

  const parked = new Set<() => void>();
  const t0 = performance.now();
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    faults: {},
    users: new Map(),
    sessions: new Map(),
    aliases: new Map(),
    redis: new Map(),
    redisCommands: [],
    calls: [],
    accessLog: [],
    serverErrors: [],
    accessStateResolver: null,
    release() {
      for (const fn of parked) fn();
      parked.clear();
    },
    teardown() {
      state.release();
      uninstall();
    },
    reset() {
      state.release();
      state.faults = {};
      state.users = new Map();
      state.sessions = new Map();
      state.aliases = new Map();
      state.redis = new Map();
      state.redisCommands = [];
      state.calls = [];
      state.accessLog = [];
      state.serverErrors = [];
      state.accessStateResolver = null;
    },
    registerUser(partial) {
      const user: UserState = {
        id: partial.id,
        email: partial.email ?? `${partial.id.slice(0, 8)}@example.com`,
        provider: partial.provider ?? "google",
        premium: partial.premium ?? false,
        scored_count: partial.scored_count ?? 0,
        reserved_count: partial.reserved_count ?? 0,
      };
      state.users.set(user.id, user);
      return user;
    },
    mintSession(userId, ttlSeconds = 3600) {
      const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: crypto.randomUUID(),
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
          jti: crypto.randomUUID(),
        }),
      )}.sig`;
      state.sessions.set(token, userId);
      return token;
    },
    mintProviderToken(userId, ttlSeconds = 3600) {
      const user = state.users.get(userId);
      const iss =
        user?.provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com";
      return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
        JSON.stringify({
          iss,
          sub: userId,
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
          jti: crypto.randomUUID(),
        }),
      )}.sig`;
    },
    supabaseCallsFor(bearer) {
      return state.calls.filter(
        (call) =>
          (call.upstream === "auth" || call.upstream === "db") &&
          (call.bearer === bearer || state.aliases.get(call.bearer) === bearer),
      );
    },
    callsTo(upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
  };

  const applyFault = async (
    fault: Fault | undefined,
    request: Request,
  ): Promise<Response | "answer"> => {
    if (!fault) return "answer";
    switch (fault.kind) {
      case "status":
        return new Response(
          fault.body ??
            JSON.stringify({ error: "injected", message: `injected HTTP ${fault.status}` }),
          {
            status: fault.status,
            headers: { "Content-Type": "application/json", ...(fault.headers ?? {}) },
          },
        );
      case "throw":
        throw new TypeError(fault.message ?? "error sending request: connection reset by peer");
      case "body":
        return new Response(fault.body, {
          status: fault.status ?? 200,
          headers: { "Content-Type": fault.contentType ?? "application/json" },
        });
      case "json":
        return jsonResponse(fault.status ?? 200, fault.value);
      case "delay":
        await sleep(fault.ms);
        return "answer";
      case "hang": {
        await new Promise<void>((resolve, reject) => {
          const signal = request.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            if (timer !== undefined) clearTimeout(timer);
            parked.delete(finish);
            reject(new HangAborted());
          };
          const finish = () => {
            signal.removeEventListener("abort", onAbort);
            parked.delete(finish);
            resolve();
          };
          if (signal.aborted) {
            reject(new HangAborted());
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          if (fault.then === "release") {
            parked.add(finish);
          } else {
            timer = setTimeout(finish, fault.ms);
          }
        });
        return "answer";
      }
    }
  };

  const normalAnswer = async (
    upstream: Upstream,
    request: Request,
    body: unknown,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (upstream === "redis") {
      if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }
    if (upstream === "rc") {
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber: { entitlements: {} } });
    }
    if (upstream === "auth") {
      const path = url.pathname.slice("/auth/v1/".length);
      if (path === "user" && request.method === "GET") {
        const userId = state.sessions.get(bearerOf(request));
        const user = userId ? state.users.get(userId) : undefined;
        if (!user) {
          return jsonResponse(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          });
        }
        return jsonResponse(200, gotrueUser(user));
      }
      if (path === "token" && request.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        const payload = isRecord(body) ? body : {};
        if (grant === "id_token") {
          const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
          const sub = jwtPayload(idToken)?.sub;
          const user = typeof sub === "string" ? state.users.get(sub) : undefined;
          if (!user || user.provider !== payload.provider) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "Bad ID token",
              error_code: "bad_id_token",
            });
          }
          const accessToken = state.mintSession(user.id);
          state.aliases.set(accessToken, idToken);
          const exp = jwtPayload(accessToken)?.exp;
          return jsonResponse(200, {
            access_token: accessToken,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: exp,
            refresh_token: `rt-${crypto.randomUUID()}`,
            user: gotrueUser(user),
          });
        }
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      return jsonResponse(404, { msg: `stress harness: unmodelled auth path ${path}` });
    }
    // db — PostgREST
    const target = url.pathname.slice("/rest/v1/".length);
    if (target === "rpc/access_state" && request.method === "POST") {
      const sub = jwtPayload(bearerOf(request))?.sub;
      const user = typeof sub === "string" ? state.users.get(sub) : undefined;
      if (typeof sub !== "string" || !sub) {
        return jsonResponse(401, { code: "PGRST301", message: "JWT expired or missing" });
      }
      if (state.accessStateResolver) {
        return jsonResponse(200, await state.accessStateResolver(sub));
      }
      return jsonResponse(200, [
        {
          premium: user?.premium ?? false,
          scored_count: user?.scored_count ?? 0,
          reserved_count: user?.reserved_count ?? 0,
        },
      ]);
    }
    return jsonResponse(404, {
      code: "PGRST202",
      message: `stress harness: unmodelled PostgREST target ${request.method} ${target}`,
    });
  };

  const stressFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    let upstream: Upstream;
    if (url.startsWith(REDIS_URL)) upstream = "redis";
    else if (url.startsWith(RC_URL)) upstream = "rc";
    else if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) upstream = "auth";
    else if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) upstream = "db";
    else {
      return new Response(`stress harness: unexpected fetch ${request.method} ${url}`, {
        status: 599,
      });
    }
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const bodyIdToken = isRecord(body) && typeof body.id_token === "string" ? body.id_token : null;
    const record: UpstreamCall = {
      t: Math.round((performance.now() - t0) * 100) / 100,
      upstream,
      method: request.method,
      url,
      bearer: upstream === "auth" && bodyIdToken ? bodyIdToken : bearerOf(request),
      status: 0,
      faulted: Boolean(state.faults[upstream]),
    };
    state.calls.push(record);
    try {
      const injected = await applyFault(state.faults[upstream], request);
      const response =
        injected === "answer" ? await normalAnswer(upstream, request, body) : injected;
      record.status = response.status;
      return response;
    } catch (error) {
      record.status =
        error instanceof DOMException && error.name === "AbortError" ? "abort" : "throw";
      throw error;
    }
  }) as typeof fetch;

  const stressError =
    (realError: typeof console.error) =>
    (...args: unknown[]) => {
      const first = typeof args[0] === "string" ? args[0] : "";
      if (first.startsWith("[api]")) {
        state.serverErrors.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
        return;
      }
      realError(...args);
    };
  install = () => {
    if (uninstall !== noop) return;
    const realFetch = globalThis.fetch;
    const realError = console.error;
    const priorTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
    globalThis.fetch = stressFetch;
    console.error = stressError(realError);
    const releaseLog = captureAccessLog((line) => {
      state.accessLog.push(JSON.parse(line) as AccessLogEntry);
    });
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
    uninstall = () => {
      globalThis.fetch = realFetch;
      console.error = realError;
      releaseLog();
      if (priorTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", priorTimeout);
      uninstall = noop;
    };
  };
  install();

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  state.handler = handler;
  loaded = state;
  return state;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function accessRequest(token: string | null, ip: string, requestId?: string): Request {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (requestId) headers.set("x-request-id", requestId);
  return new Request("http://edge.stress.test/functions/v1/api/v1/me/access", {
    method: "GET",
    headers,
  });
}

/** Distinct, documentation-range client IPs (never collide across cases). */
export function ipFor(prng: Prng): string {
  return `10.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`;
}

export interface AccessBody {
  premium?: unknown;
  entitlements?: unknown;
  freeRatings?: {
    limit?: unknown;
    used?: unknown;
    reserved?: unknown;
    remaining?: unknown;
    availableToReserve?: unknown;
  };
  canStartRating?: unknown;
  paywallRequired?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export interface Observed {
  status: number;
  body: AccessBody;
  raw: string;
  requestId: string | null;
  retryAfter: string | null;
  durationMs: number;
  /** Supabase (auth + db) round trips attributed to this bearer. */
  roundTrips: number;
  authCalls: number;
  dbCalls: number;
  redisPipelines: number;
}

export async function observe(
  h: StressHarness,
  request: Request,
  bearer: string,
): Promise<Observed> {
  const before = h.calls.length;
  const t0 = performance.now();
  const response = await h.handler(request);
  const raw = await response.text();
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  let body: AccessBody = {};
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) body = parsed as AccessBody;
  } catch {
    body = {};
  }
  const mine = h.calls
    .slice(before)
    .filter((call) => call.bearer === bearer || h.aliases.get(call.bearer) === bearer);
  const redisPipelines = h.calls.slice(before).filter((call) => call.upstream === "redis").length;
  return {
    status: response.status,
    body,
    raw,
    requestId: response.headers.get("x-request-id"),
    retryAfter: response.headers.get("Retry-After"),
    durationMs,
    roundTrips: mine.filter((c) => c.upstream === "auth" || c.upstream === "db").length,
    authCalls: mine.filter((c) => c.upstream === "auth").length,
    dbCalls: mine.filter((c) => c.upstream === "db").length,
    redisPipelines,
  };
}

/** The payload invariants GET /v1/me/access promises the app (parseAccess). */
export function accessInvariantViolations(body: AccessBody): string[] {
  const out: string[] = [];
  const fr = body.freeRatings ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const limit = num(fr.limit);
  const used = num(fr.used);
  const reserved = num(fr.reserved);
  const remaining = num(fr.remaining);
  const available = num(fr.availableToReserve);
  if (limit !== 2) out.push(`limit=${String(fr.limit)} ≠ 2`);
  if (!(used >= 0 && used <= 2)) out.push(`used=${String(fr.used)} outside 0..2`);
  if (!(reserved >= 0 && reserved <= 2)) out.push(`reserved=${String(fr.reserved)} outside 0..2`);
  if (remaining !== 2 - used) out.push(`remaining=${String(fr.remaining)} ≠ 2-used`);
  if (available !== remaining - reserved) {
    out.push(`availableToReserve=${String(fr.availableToReserve)} ≠ remaining-reserved`);
  }
  if (!(available >= 0)) out.push(`availableToReserve=${String(fr.availableToReserve)} < 0`);
  if (typeof body.premium !== "boolean") out.push(`premium=${String(body.premium)} not boolean`);
  const ents = Array.isArray(body.entitlements) ? body.entitlements : null;
  if (!ents) out.push("entitlements not an array");
  else if (ents.includes("premium") !== body.premium) {
    out.push(`premium=${String(body.premium)} but entitlements=${JSON.stringify(ents)}`);
  }
  const expectedCan = body.premium === true || available > 0;
  if (body.canStartRating !== expectedCan) {
    out.push(`canStartRating=${String(body.canStartRating)} ≠ premium||available>0`);
  }
  if (body.paywallRequired !== !body.canStartRating) {
    out.push(`paywallRequired=${String(body.paywallRequired)} ≠ !canStartRating`);
  }
  return out;
}

/** Strings a generic 5xx body must never carry (upstream/DB internals). */
export const INTERNAL_DETAIL_MARKERS = [
  "PGRST",
  "42501",
  "injected",
  "access_state",
  "postgres",
  "supabase",
  "stack",
  "TypeError",
  "connection reset",
  "<html",
];

export function leakedDetail(raw: string): string[] {
  const lower = raw.toLowerCase();
  return INTERNAL_DETAIL_MARKERS.filter((marker) => lower.includes(marker.toLowerCase()));
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-get-v1-me-access/latest/", import.meta.url)
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function latencySummary(samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
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
