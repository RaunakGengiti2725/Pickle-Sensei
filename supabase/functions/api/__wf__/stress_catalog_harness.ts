// stress · route-get-v1-catalog-drills · failure-load — fault-injecting boot of
// the REAL edge function (../index.ts, Deno.serve captured) for
// GET /v1/catalog/drills.
//
// Unlike routesHarness.ts (canned rows) and xc_concurrency_harness.ts
// (stateful model), this harness is a PROGRAMMABLE FAULT PLANE over every
// upstream the route can reach — Supabase Auth (GoTrue), Supabase PostgREST,
// Upstash Redis and RevenueCat — so each one can be made to fail, time out,
// hang or answer malformed bytes IN TURN, for N calls, and the user-visible
// error class + recoverability of the real handler can be asserted.
//
// Everything else is a faithful-enough minimal upstream:
//   * GoTrue    GET /auth/v1/user resolves the bearer's `sub` statelessly
//               (any uuid is a valid google user unless `users` overrides it),
//               POST /auth/v1/token?grant_type=id_token mints a session;
//   * PostgREST GET /rest/v1/user_saved_drills applies RLS by bearer and
//               answers a SEEDED, per-user deterministic set of saved slugs
//               (so every response can be checked against the user it is for);
//   * Upstash   the same command executor sessionHarness.ts uses;
//   * RevenueCat answers an empty subscriber (the route must never call it).
//
// Nothing here talks to a network. Never points at a hosted project.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
const REDIS_TOKEN = "stress-upstash-token";

/** Every fault body/detail embeds this marker; a response body that contains
 * it has leaked upstream detail to the client (5xx bodies must be generic). */
export const LEAK_MARKER = "STRESS-LEAK-MARKER-7f3a";

export type UpstreamClass =
  | "gotrue"
  | "postgrest"
  | "upstash"
  | "revenuecat"
  | "other";

export type Fault =
  /** HTTP answer with this status/body/headers (body defaults to a JSON error carrying LEAK_MARKER). */
  | {
    kind: "http";
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }
  /** fetch() rejects (socket reset / DNS / refused). */
  | { kind: "throw"; message?: string }
  /** Never answers unless the caller's AbortSignal fires (a real socket hang). */
  | { kind: "hang" }
  /** Delays the normal answer by `ms` (slow upstream). */
  | { kind: "delay"; ms: number }
  /** 200 with exactly these bytes (malformed / unexpected shape). */
  | { kind: "body"; body: string; status?: number; contentType?: string }
  /** Arbitrary responder over the parsed request. */
  | {
    kind: "custom";
    respond: (request: Request, body: unknown) => Response | Promise<Response>;
  };

export interface ArmedFault {
  fault: Fault;
  /** Apply to the next N matching calls, then heal. undefined = until cleared. */
  times?: number;
  /** Only apply when the request matches (default: every call of the class). */
  when?: (request: Request, body: unknown) => boolean;
}

export interface RecordedCall {
  t: number;
  cls: UpstreamClass;
  method: string;
  url: string;
  /** HTTP status of the answer, or "throw" / "hang" / "abort". */
  outcome: number | "throw" | "hang" | "abort";
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  /** Armed faults by upstream class (cleared by reset()). */
  faults: Partial<Record<UpstreamClass, ArmedFault>>;
  /** Cumulative upstream call counters by class (never reset by reset(); snapshot them). */
  counters: Record<UpstreamClass, number>;
  /** Detailed call log — only kept while `recordCalls` is true (off for floods). */
  calls: RecordedCall[];
  recordCalls: boolean;
  redis: Map<string, FakeRedisEntry>;
  redisCommands: number;
  /** Provider override per user id (default google). */
  users: Map<string, { provider: string; email: string | null }>;
  /** Saved slugs the fake PostgREST answers for a user (seeded, deterministic). */
  savedFor(userId: string): string[];
  /** Catalog slugs (loaded from ../drills.ts). */
  catalogSlugs: string[];
  /** console.error/warn lines captured while `captureConsole` is on. */
  serverLog: string[];
  captureConsole: boolean;
  /** Structured access-log entries captured from http.ts. */
  accessLog: Array<Record<string, unknown>>;
  keepAccessLog: boolean;
  /** Clear faults, call log, redis store and server log (NOT the function's own L1 state). */
  reset(): void;
  snapshot(): Record<UpstreamClass, number>;
  /** Counter delta since `before`. */
  since(before: Record<UpstreamClass, number>): Record<UpstreamClass, number>;
}

// ── Seeded RNG ───────────────────────────────────────────────────────────────

/** mulberry32 — every scenario input derives from (STRESS_SEED, case id). */
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
  /** Dotted-quad in 10.0.0.0/8 — a fresh client IP per case/user. */
  ip(): string {
    return `10.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
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
/** Sequential load requests (p50/p95 + round trips). */
export const STRESS_LOAD = envInt("STRESS_LOAD", 200);
/** Distinct users flooded through the cold auth path (L1 memory bound). */
export const STRESS_USERS = envInt("STRESS_USERS", 1_500);
/** Concurrent requests per burst. */
export const STRESS_BURST = envInt("STRESS_BURST", 40);
/** Repetitions of the whole fault matrix (flake detection). */
export const STRESS_ITER = envInt("STRESS_ITER", 1);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-get-v1-catalog-drills/latest/",
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
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

export function latencyStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    n: sorted.length,
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

// ── Tokens ───────────────────────────────────────────────────────────────────

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(seg));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
    b64url(JSON.stringify(payload))
  }.sig`;
}

/** A Supabase-shaped ACCESS token for `sub` (the contract bearer). */
export function sessionToken(
  sub: string,
  options: { sessionId?: string; expSeconds?: number } = {},
): string {
  return fakeJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: options.sessionId ?? `sess-${sub}`,
    exp: options.expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
  });
}

/** A Google ID token (the TRANSITIONAL bearer authenticate() still accepts). */
export function googleIdToken(sub: string, expSeconds?: number): string {
  return fakeJwt({
    iss: "https://accounts.google.com",
    sub,
    exp: expSeconds ?? Math.floor(Date.now() / 1000) + 3600,
  });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Requests ─────────────────────────────────────────────────────────────────

export function catalogRequest(options: {
  token?: string | null;
  ip?: string;
  query?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.9",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const path = options.path ?? "/v1/catalog/drills";
  const url = `http://edge.stress.test/functions/v1/api${path}${
    options.query ? `?${options.query}` : ""
  }`;
  return new Request(url, { method: options.method ?? "GET", headers });
}

export async function readJson(
  response: Response,
): Promise<{ text: string; json: unknown }> {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

// ── Fake Redis (Upstash pipeline executor) ───────────────────────────────────

function redisLive(
  store: Map<string, FakeRedisEntry>,
  key: string,
): FakeRedisEntry | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

export function runRedisCommand(
  store: Map<string, FakeRedisEntry>,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  const [op, ...args] = command.map((part) => String(part));
  switch (op) {
    case "GET":
      return { result: redisLive(store, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(store, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
      store.set(args[0], {
        value: args[1],
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (store.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(store, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? Infinity,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(store, args[0]);
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

// ── Boot ─────────────────────────────────────────────────────────────────────

let loaded: StressHarness | null = null;

function classify(url: URL): UpstreamClass {
  if (url.href.startsWith(RC_URL)) return "revenuecat";
  if (url.origin === REDIS_URL) return "upstash";
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
    return "gotrue";
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    return "postgrest";
  }
  return "other";
}

const jsonResponse = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

/** A promise that rejects with AbortError when the signal fires — the shape
 * a real fetch takes on a socket that never answers. Without a signal it
 * never settles (the caller has no deadline: that is the point of the case). */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (!signal) return;
    const abort = () =>
      reject(new DOMException("The signal has been aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function loadStressHarness(
  options: { redis: boolean },
): Promise<StressHarness> {
  if (loaded) {
    if (loaded.redisEnabled !== options.redis) {
      throw new Error(
        "stress harness: Redis mode is fixed at first load (cache.ts reads env at import)",
      );
    }
    loaded.reset();
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
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

  const { drillCatalog } = await import("../drills.ts");
  const catalogSlugs = (await drillCatalog()).map((d) => d.slug);
  const { captureAccessLog } = await import("../http.ts");

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: options.redis,
    faults: {},
    counters: { gotrue: 0, postgrest: 0, upstash: 0, revenuecat: 0, other: 0 },
    calls: [],
    recordCalls: true,
    redis: new Map(),
    redisCommands: 0,
    users: new Map(),
    catalogSlugs,
    savedFor(userId: string): string[] {
      // Deterministic per user: 0..4 slugs chosen by a PRNG seeded from the id.
      const prng = new Prng(fnv1a(`saved:${userId}`));
      const n = prng.int(0, 4);
      const picked = new Set<string>();
      for (let i = 0; i < n; i++) picked.add(prng.pick(catalogSlugs));
      return [...picked].sort();
    },
    serverLog: [],
    captureConsole: false,
    accessLog: [],
    keepAccessLog: false,
    reset() {
      state.faults = {};
      state.calls = [];
      state.recordCalls = true;
      state.redis = new Map();
      state.redisCommands = 0;
      state.users = new Map();
      state.serverLog = [];
      state.captureConsole = false;
      state.accessLog = [];
      state.keepAccessLog = false;
    },
    snapshot() {
      return { ...state.counters };
    },
    since(before) {
      const out = { ...state.counters };
      for (const key of Object.keys(out) as UpstreamClass[]) {
        out[key] -= before[key];
      }
      return out;
    },
  };

  captureAccessLog((line: string) => {
    if (!state.keepAccessLog) return;
    try {
      state.accessLog.push(JSON.parse(line));
    } catch {
      state.accessLog.push({ raw: line });
    }
  });
  const realError = console.error;
  const realWarn = console.warn;
  const capture =
    (level: string, real: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (!state.captureConsole) return real(...args);
      state.serverLog.push(
        `${level} ${
          args.map((
            a,
          ) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
            .join(" ")
        }`,
      );
    };
  console.error = capture("error", realError);
  console.warn = capture("warn", realWarn);

  const bearerOf = (request: Request): string => {
    const auth = request.headers.get("authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : "";
  };
  const userJson = (sub: string) => {
    const user = state.users.get(sub) ??
      { provider: "google", email: `${sub.slice(0, 8)}@example.com` };
    return {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  };

  const healthy = (
    cls: UpstreamClass,
    request: Request,
    url: URL,
    body: unknown,
  ): Response => {
    switch (cls) {
      case "revenuecat":
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: { entitlements: {} },
        });
      case "upstash": {
        if (url.pathname !== "/pipeline") {
          return jsonResponse(404, { error: "not a pipeline" });
        }
        if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
          return jsonResponse(401, { error: "Unauthorized" });
        }
        const commands = Array.isArray(body)
          ? (body as Array<Array<string | number>>)
          : [];
        state.redisCommands += commands.length;
        return jsonResponse(
          200,
          commands.map((c) => runRedisCommand(state.redis, c)),
        );
      }
      case "gotrue": {
        const path = url.pathname.slice("/auth/v1/".length);
        if (path === "user" && request.method === "GET") {
          const payload = jwtPayload(bearerOf(request));
          const sub = typeof payload?.sub === "string" ? payload.sub : "";
          if (
            !sub || typeof payload?.exp !== "number" ||
            payload.exp * 1000 <= Date.now()
          ) {
            return jsonResponse(401, {
              code: 401,
              error_code: "bad_jwt",
              msg: "invalid JWT",
            });
          }
          return jsonResponse(200, userJson(sub));
        }
        if (path === "token" && request.method === "POST") {
          const grant = url.searchParams.get("grant_type");
          const payload = isRecord(body) ? body : {};
          if (grant === "id_token") {
            const claims = jwtPayload(
              typeof payload.id_token === "string" ? payload.id_token : "",
            );
            const sub = typeof claims?.sub === "string" ? claims.sub : "";
            if (!sub) {
              return jsonResponse(400, {
                error: "invalid_grant",
                error_description: "Bad ID token",
              });
            }
            const exp = Math.floor(Date.now() / 1000) + 3600;
            return jsonResponse(200, {
              access_token: sessionToken(sub, {
                expSeconds: exp,
                sessionId: `sess-idtoken-${sub}`,
              }),
              token_type: "bearer",
              expires_in: 3600,
              expires_at: exp,
              refresh_token: `rt-${sub}`,
              user: userJson(sub),
            });
          }
          return jsonResponse(400, { error: "unsupported_grant_type" });
        }
        return jsonResponse(404, {
          msg: `stress harness: unmodelled auth path ${path}`,
        });
      }
      case "postgrest": {
        const target = url.pathname.slice("/rest/v1/".length);
        const payload = jwtPayload(bearerOf(request));
        const sub = typeof payload?.sub === "string" ? payload.sub : null;
        if (target === "user_saved_drills" && request.method === "GET") {
          // RLS: only the bearer's own rows; anon/service bearers see nothing here.
          if (!sub) return jsonResponse(200, []);
          const filter = url.searchParams.get("user_id") ?? "";
          const rows = filter === `eq.${sub}`
            ? state.savedFor(sub).map((slug) => ({ slug }))
            : [];
          return jsonResponse(200, rows);
        }
        if (target.startsWith("rpc/")) {
          return jsonResponse(404, {
            code: "PGRST202",
            message: `rpc ${target.slice(4)} not modelled`,
          });
        }
        return jsonResponse(404, {
          code: "PGRST205",
          message: `table ${target} not modelled`,
        });
      }
      default:
        return new Response(
          `stress harness: unexpected fetch ${request.method} ${request.url}`,
          { status: 599 },
        );
    }
  };

  const t0 = performance.now();
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const cls = classify(url);
    state.counters[cls] += 1;
    const rawBody = await request.clone().text().catch(() => "");
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const record: RecordedCall = {
      t: Math.round((performance.now() - t0) * 100) / 100,
      cls,
      method: request.method,
      url: request.url,
      outcome: 0,
    };
    if (state.recordCalls) state.calls.push(record);
    const signal = init?.signal ?? request.signal;

    const armed = state.faults[cls];
    let fault: Fault | null = null;
    if (armed && (!armed.when || armed.when(request, body))) {
      fault = armed.fault;
      if (armed.times !== undefined) {
        armed.times -= 1;
        if (armed.times <= 0) delete state.faults[cls];
      }
    }
    if (fault) {
      switch (fault.kind) {
        case "throw":
          record.outcome = "throw";
          throw new TypeError(
            fault.message ??
              `error sending request: connection reset (${LEAK_MARKER})`,
          );
        case "hang": {
          record.outcome = "hang";
          try {
            return await hang(signal);
          } catch (error) {
            record.outcome = "abort";
            throw error;
          }
        }
        case "delay": {
          await sleep(fault.ms);
          if (signal?.aborted) {
            record.outcome = "abort";
            throw new DOMException(
              "The signal has been aborted",
              "AbortError",
            );
          }
          break;
        }
        case "http": {
          record.outcome = fault.status;
          return new Response(
            fault.body ??
              JSON.stringify({
                code: String(fault.status),
                message: `upstream failure ${LEAK_MARKER}`,
              }),
            {
              status: fault.status,
              headers: {
                "Content-Type": "application/json",
                ...fault.headers,
              },
            },
          );
        }
        case "body": {
          record.outcome = fault.status ?? 200;
          return new Response(fault.body, {
            status: fault.status ?? 200,
            headers: {
              "Content-Type": fault.contentType ?? "application/json",
            },
          });
        }
        case "custom": {
          const response = await fault.respond(request, body);
          record.outcome = response.status;
          return response;
        }
      }
    }
    const response = healthy(cls, request, url, body);
    record.outcome = response.status;
    return response;
  }) as typeof fetch;

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
  state.handler = handler;
  loaded = state;
  return state;
}

/** Saved flags in a 200 body, as {slug: saved} — compared against savedFor(). */
export function savedSlugsOf(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const out: string[] = [];
  for (const item of body.items) {
    if (
      !isRecord(item) || typeof item.slug !== "string" ||
      typeof item.saved !== "boolean"
    ) return null;
    if (item.saved) out.push(item.slug);
  }
  return out.sort();
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
