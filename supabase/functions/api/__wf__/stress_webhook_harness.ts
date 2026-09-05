// Failure-injection + load harness for POST /webhooks/revenuecat.
//
// Boots the REAL ../index.ts (Deno.serve captured, nothing listens) with every
// upstream the route touches installed at the fetch layer as a STATEFUL fake:
//
//   RevenueCat  GET https://api.revenuecat.com/v1/subscribers/<id>
//   PostgREST   GET  /rest/v1/webhook_events        (idempotency lookup)
//               POST /rest/v1/webhook_events        (audit upsert, ignore-duplicates)
//               POST /rest/v1/billing_entitlements  (verdict upsert, merge-duplicates)
//   GoTrue      /auth/v1/*                          (the route must never call it)
//   Upstash     POST <UPSTASH_REDIS_REST_URL>/pipeline (rate-limit windows)
//
// The PostgREST fake persists rows (so replays really hit the duplicate
// branch) and enforces billing_entitlements.user_id → profiles.id like the
// migration does. With STRESS_PG_URL (alias XC_PG_URL) set, the same two
// tables are served by a disposable postgres:16 with every migration applied
// (./xc_pg_up.sh) as role service_role — the PostgREST protocol is translated
// to SQL, so the handler's writes land in the real schema.
//
// Faults are injected per target (rc / pg.* / auth / redis) as HTTP status,
// network error, malformed body, or hang (pending until released or the
// caller's AbortSignal fires). Every upstream call is recorded so a request's
// Supabase round trips can be counted. Seeded: every case derives its ids,
// ips and subscriber shape from a Prng; failures replay from the seed.

export const SECRET = "stress-webhook-secret";
export const SUPABASE_URL = "http://supabase.stress";
export const REDIS_URL = "https://redis.stress";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const WEBHOOK_PATH = "http://edge.test/functions/v1/api/webhooks/revenuecat";

export type Target =
  | "rc"
  | "pg.webhook_events.get"
  | "pg.webhook_events.post"
  | "pg.billing_entitlements.post"
  | "pg.*"
  | "auth"
  | "redis";

export type Fault =
  | {
      kind: "http";
      status: number;
      body: string;
      contentType?: string;
      headers?: Record<string, string>;
    }
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "network" }
  | { kind: "hang" };

export interface FaultRule {
  target: Target;
  fault: Fault;
  /** Skip this many matching calls before the fault applies (0 = first call). */
  after?: number;
  /** How many matching calls fail (default Infinity = every one). */
  times?: number;
}

export interface Call {
  n: number;
  target: Target;
  url: string;
  method: string;
  prefer: string | null;
  body: unknown;
  status: number | "network" | "hang";
  hadSignal: boolean;
  atMs: number;
}

export interface EntitlementRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_type: string | null;
  app_user_id: string | null;
  payload: unknown;
}

export interface World {
  handler: (request: Request) => Promise<Response>;
  calls: Call[];
  rules: FaultRule[];
  /** RevenueCat subscriber JSON per app_user_id (missing → auto-created, no entitlements). */
  subscribers: Map<string, unknown>;
  /** In-memory PostgREST model. */
  profiles: Set<string>;
  entitlements: Map<string, EntitlementRow>;
  webhookEvents: Map<string, WebhookEventRow>;
  /** In-memory Upstash model. */
  redis: Map<string, { value: string; expiresAtMs: number | null }>;
  /** Seeded per-call latency (ms) applied to every fake upstream reply. */
  latency: () => number;
  /** Optional real Postgres behind the two tables. */
  pg: PgBridge | null;
  releaseHangs(): void;
  pendingHangs(): number;
  reset(): void;
  callsTo(target: Target | ((call: Call) => boolean), since?: number): Call[];
}

export interface PgBridge {
  select(table: string, column: string, value: string, selectCols: string): Promise<unknown[]>;
  upsert(
    table: string,
    row: Record<string, unknown>,
    onConflict: string,
    ignoreDuplicates: boolean,
  ): Promise<{ code: string; message: string } | null>;
}

// ── Seeded RNG (same generator as xc_concurrency_harness.ts) ─────────────────

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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  hex(chars: number): string {
    let out = "";
    while (out.length < chars) out += this.int(16).toString(16);
    return out;
  }
  /** RFC 4122 v4-shaped uuid (matches the route's isUuid). */
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[this.int(4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  ip(): string {
    return `${10 + this.int(200)}.${this.int(256)}.${this.int(256)}.${1 + this.int(254)}`;
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
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Request builders ─────────────────────────────────────────────────────────

export function webhookRequest(
  event: unknown,
  options: {
    authorization?: string | null;
    ip?: string;
    rawBody?: string;
    contentLength?: string;
  } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization = options.authorization === undefined ? SECRET : options.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  headers.set("x-forwarded-for", options.ip ?? "203.0.113.10");
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Request(WEBHOOK_PATH, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(event === null ? {} : { api_version: "1.0", event }),
  });
}

export function activeSubscriber(
  expiresDate: string | null = new Date(Date.now() + 86_400_000).toISOString(),
  productId = "pickle_sensei_pro_monthly",
  key = "pickle_sensei_pro",
): Record<string, unknown> {
  return { entitlements: { [key]: { expires_date: expiresDate, product_identifier: productId } } };
}

/** Subscriber whose entitlement expired an hour ago → verdict premium:false. */
export function lapsedSubscriber(): Record<string, unknown> {
  return activeSubscriber(new Date(Date.now() - 3_600_000).toISOString());
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let world: World | null = null;

export async function loadWorld(): Promise<World> {
  if (world) {
    world.reset();
    return world;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-stress-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-stress-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_stress_revenuecat");
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));
  // Redis ON so the Upstash path (and its fallbacks) is what the route runs.
  Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-stress-token");

  const realServe = Deno.serve;
  const hangs: Array<() => void> = [];

  const state: World = {
    handler: () => Promise.reject(new Error("handler not captured")),
    calls: [],
    rules: [],
    subscribers: new Map(),
    profiles: new Set(),
    entitlements: new Map(),
    webhookEvents: new Map(),
    redis: new Map(),
    latency: () => 0,
    pg: null,
    releaseHangs() {
      for (const release of hangs.splice(0)) release();
    },
    pendingHangs: () => hangs.length,
    reset() {
      state.releaseHangs();
      state.calls = [];
      state.rules = [];
      state.subscribers = new Map();
      state.profiles = new Set();
      state.entitlements = new Map();
      state.webhookEvents = new Map();
      state.redis = new Map();
      state.latency = () => 0;
    },
    callsTo(target, since = 0) {
      const match = typeof target === "function" ? target : (call: Call) => call.target === target;
      return state.calls.filter((call) => call.n >= since && match(call));
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const pgError = (status: number, code: string, message: string): Response =>
    jsonResponse(status, { code, message, details: null, hint: null });

  const matchCounts = new Map<FaultRule, number>();
  function faultFor(target: Target): Fault | null {
    for (const rule of state.rules) {
      const applies =
        rule.target === target || (rule.target === "pg.*" && target.startsWith("pg."));
      if (!applies) continue;
      const seen = matchCounts.get(rule) ?? 0;
      matchCounts.set(rule, seen + 1);
      const after = rule.after ?? 0;
      const times = rule.times ?? Number.POSITIVE_INFINITY;
      if (seen >= after && seen < after + times) return rule.fault;
    }
    return null;
  }

  function applyFault(
    fault: Fault,
    signal: AbortSignal | null,
    record: Call,
    normal: () => Promise<Response>,
  ): Promise<Response> {
    switch (fault.kind) {
      case "http":
        record.status = fault.status;
        return Promise.resolve(
          new Response(fault.body, {
            status: fault.status,
            headers: { "Content-Type": fault.contentType ?? "application/json", ...fault.headers },
          }),
        );
      case "json":
        record.status = fault.status ?? 200;
        return Promise.resolve(jsonResponse(fault.status ?? 200, fault.body));
      case "network":
        record.status = "network";
        return Promise.reject(new TypeError("error sending request: connection refused"));
      case "hang":
        record.status = "hang";
        return new Promise<Response>((resolve, reject) => {
          const release = () => {
            signal?.removeEventListener("abort", onAbort);
            normal().then(resolve, reject);
          };
          const onAbort = () => {
            const index = hangs.indexOf(release);
            if (index >= 0) hangs.splice(index, 1);
            reject(new DOMException("The signal has been aborted", "TimeoutError"));
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
          hangs.push(release);
        });
    }
  }

  // ── Fake Upstash: INCR / EXPIRE [NX] / GET / SET EX / DEL / TTL ─────────────
  function redisPipeline(commands: unknown): unknown[] {
    if (!Array.isArray(commands)) return [{ error: "ERR malformed pipeline" }];
    const now = Date.now();
    const live = (key: string) => {
      const entry = state.redis.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        state.redis.delete(key);
        return null;
      }
      return entry;
    };
    return commands.map((command) => {
      if (!Array.isArray(command)) return { error: "ERR malformed command" };
      const [op, key, ...args] = command.map(String);
      switch (op.toUpperCase()) {
        case "INCR": {
          const entry = live(key);
          const next = (entry ? Number(entry.value) : 0) + 1;
          state.redis.set(key, { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
          return { result: next };
        }
        case "EXPIRE": {
          const entry = live(key);
          if (!entry) return { result: 0 };
          if (args[1]?.toUpperCase() === "NX" && entry.expiresAtMs !== null) return { result: 0 };
          entry.expiresAtMs = now + Number(args[0]) * 1_000;
          return { result: 1 };
        }
        case "GET":
          return { result: live(key)?.value ?? null };
        case "SET": {
          const ex = args[1]?.toUpperCase() === "EX" ? Number(args[2]) : null;
          state.redis.set(key, {
            value: args[0],
            expiresAtMs: ex === null ? null : now + ex * 1_000,
          });
          return { result: "OK" };
        }
        case "DEL": {
          let removed = 0;
          for (const k of [key, ...args]) removed += state.redis.delete(k) ? 1 : 0;
          return { result: removed };
        }
        case "TTL": {
          const entry = live(key);
          if (!entry) return { result: -2 };
          if (entry.expiresAtMs === null) return { result: -1 };
          return { result: Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1_000)) };
        }
        default:
          return { error: `ERR unknown command ${op}` };
      }
    });
  }

  // ── Fake PostgREST for the two tables the route writes ──────────────────────
  async function postgrest(
    request: Request,
    url: URL,
    body: unknown,
    prefer: string,
  ): Promise<Response> {
    const table = url.pathname.slice("/rest/v1/".length);
    if (request.method === "GET") {
      const select = url.searchParams.get("select") ?? "*";
      const accept = request.headers.get("accept") ?? "";
      let column: string | null = null;
      let value: string | null = null;
      for (const [k, v] of url.searchParams) {
        if (k !== "select" && v.startsWith("eq.")) {
          column = k;
          value = v.slice(3);
        }
      }
      let rows: unknown[];
      if (state.pg && (table === "webhook_events" || table === "billing_entitlements")) {
        rows = await state.pg.select(table, column ?? "id", value ?? "", select);
      } else if (table === "webhook_events") {
        const row = value === null ? null : state.webhookEvents.get(value);
        rows = row ? [{ id: row.id }] : [];
      } else if (table === "billing_entitlements") {
        const row = value === null ? null : state.entitlements.get(value);
        rows = row ? [row] : [];
      } else {
        return pgError(404, "PGRST205", `table ${table} not modelled`);
      }
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (rows.length !== 1) return pgError(406, "PGRST116", `${rows.length} rows`);
        return jsonResponse(200, rows[0]);
      }
      return jsonResponse(200, rows);
    }
    if (request.method === "POST") {
      const onConflict = url.searchParams.get("on_conflict") ?? "";
      const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");
      const merge = prefer.includes("resolution=merge-duplicates");
      const row = isRecord(body) ? body : null;
      if (!row) return pgError(400, "PGRST102", "body is not an object");
      if (state.pg && (table === "webhook_events" || table === "billing_entitlements")) {
        const err = await state.pg.upsert(table, row, onConflict, ignoreDuplicates);
        if (err)
          return pgError(
            err.code === "23503" || err.code === "23505" ? 409 : 400,
            err.code,
            err.message,
          );
        return new Response(null, { status: 201 });
      }
      if (table === "webhook_events") {
        const id = String(row.id);
        if (state.webhookEvents.has(id)) {
          if (ignoreDuplicates) return new Response(null, { status: 201 });
          if (!merge) {
            return pgError(
              409,
              "23505",
              'duplicate key value violates unique constraint "webhook_events_pkey"',
            );
          }
        }
        state.webhookEvents.set(id, {
          id,
          provider: String(row.provider ?? "revenuecat"),
          event_type: typeof row.event_type === "string" ? row.event_type : null,
          app_user_id: typeof row.app_user_id === "string" ? row.app_user_id : null,
          payload: row.payload,
        });
        return new Response(null, { status: 201 });
      }
      if (table === "billing_entitlements") {
        const userId = String(row.user_id);
        if (!state.profiles.has(userId)) {
          return pgError(
            409,
            "23503",
            'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
          );
        }
        if (state.entitlements.has(userId) && !merge && !ignoreDuplicates) {
          return pgError(
            409,
            "23505",
            'duplicate key value violates unique constraint "billing_entitlements_pkey"',
          );
        }
        if (!(state.entitlements.has(userId) && ignoreDuplicates)) {
          state.entitlements.set(userId, {
            user_id: userId,
            premium: Boolean(row.premium),
            product_key: typeof row.product_key === "string" ? row.product_key : null,
            expires_at: typeof row.expires_at === "string" ? row.expires_at : null,
            verified_at: String(row.verified_at ?? new Date().toISOString()),
          });
        }
        return new Response(null, { status: 201 });
      }
      return pgError(404, "PGRST205", `table ${table} not modelled`);
    }
    return pgError(405, "PGRST105", `${request.method} not modelled`);
  }

  function classify(request: Request, url: URL): Target {
    if (url.href.startsWith(RC_URL)) return "rc";
    if (url.href.startsWith(`${REDIS_URL}/`)) return "redis";
    if (url.href.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
    if (url.href.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = url.pathname.slice("/rest/v1/".length);
      const verb = request.method === "GET" ? "get" : "post";
      return `pg.${table}.${verb}` as Target;
    }
    return "pg.*";
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null) ?? null;
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const target = classify(request, url);
    const record: Call = {
      n: state.calls.length,
      target,
      url: url.href,
      method: request.method,
      prefer: request.headers.get("prefer"),
      body,
      status: 0,
      hadSignal: signal !== null,
      atMs: performance.now(),
    };
    state.calls.push(record);

    const wait = state.latency();
    if (wait > 0) await sleep(wait);

    const normal = async (): Promise<Response> => {
      let response: Response;
      if (target === "rc") {
        const appUserId = decodeURIComponent(url.pathname.slice("/v1/subscribers/".length));
        const subscriber = state.subscribers.get(appUserId) ?? { entitlements: {} };
        response = jsonResponse(200, { request_date_ms: Date.now(), subscriber });
      } else if (target === "redis") {
        response = jsonResponse(200, redisPipeline(body));
      } else if (target === "auth") {
        response = jsonResponse(200, {});
      } else if (target.startsWith("pg.")) {
        response = await postgrest(request, url, body, request.headers.get("prefer") ?? "");
      } else {
        response = new Response(
          `unexpected fetch in stress harness: ${request.method} ${url.href}`,
          { status: 599 },
        );
      }
      record.status = response.status;
      return response;
    };

    const fault = faultFor(target);
    if (fault) return applyFault(fault, signal, record, normal);
    return normal();
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

  await import("../index.ts");
  Deno.serve = realServe;
  world = state;
  return state;
}

// ── Response capture ─────────────────────────────────────────────────────────

export interface Outcome {
  status: number;
  body: Record<string, unknown> | null;
  errorMessage: string | null;
  retryAfter: string | null;
  latencyMs: number;
  /** Upstream calls made while this request ran (sequential mode only). */
  supabaseCalls: number;
  rcCalls: number;
  redisCalls: number;
  authCalls: number;
  hadPendingHang: boolean;
}

export async function run(
  w: World,
  request: Request,
  options: { hangProbeMs?: number } = {},
): Promise<Outcome> {
  const since = w.calls.length;
  const started = performance.now();
  const pending = w.handler(request);
  let hadPendingHang = false;
  if (options.hangProbeMs !== undefined) {
    const probe = Symbol("probe");
    let raced = await Promise.race([pending, sleep(options.hangProbeMs).then(() => probe)]);
    if (raced === probe) hadPendingHang = true;
    // Once the probe fired, keep releasing whatever hangs next until the
    // handler settles (a persistent hang rule re-arms on every upstream call).
    while (raced === probe) {
      w.releaseHangs();
      raced = await Promise.race([pending, sleep(20).then(() => probe)]);
    }
  }
  const response = await pending;
  const latencyMs = performance.now() - started;
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    body = isRecord(parsed) ? parsed : null;
  } catch {
    body = null;
  }
  const error = body && isRecord(body.error) ? body.error : null;
  const calls = w.calls.filter((call) => call.n >= since);
  return {
    status: response.status,
    body,
    errorMessage: error && typeof error.message === "string" ? error.message : null,
    retryAfter: response.headers.get("retry-after"),
    latencyMs,
    supabaseCalls: calls.filter((c) => c.target.startsWith("pg.")).length,
    rcCalls: calls.filter((c) => c.target === "rc").length,
    redisCalls: calls.filter((c) => c.target === "redis").length,
    authCalls: calls.filter((c) => c.target === "auth").length,
    hadPendingHang,
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-webhook-revenuecat/latest/", import.meta.url)
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}
