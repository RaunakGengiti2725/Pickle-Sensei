// stress-route-get-v1-rank — FAULT-INJECTING black-box harness for the edge
// function, purpose-built for GET /v1/rank.
//
// Boots the REAL ../index.ts in-process (Deno.serve captured, no port) with
// every upstream behind ONE programmable fetch fake:
//
//   Supabase Auth   GET /auth/v1/user (session bearer verification)
//   PostgREST       GET /rest/v1/player_technique_rating, /rest/v1/player_rank_state
//   Upstash Redis   POST /pipeline (L2 cache + shared rate limits; only when
//                   the harness is loaded with `redis: true` — cache.ts reads
//                   its env at import, so the choice is fixed per isolate /
//                   per test file)
//   RevenueCat      GET /v1/subscribers/… (NOT on the rank path — kept so the
//                   matrix can PROVE it is never consulted)
//
// Any upstream can be made to fail / stall / answer malformed for N calls via
// `injectFault`. Every fetch is recorded so a test can count Supabase and
// Redis round trips PER REQUEST. Nothing here touches a network.
//
// Seeded: `Prng` (mulberry32) drives user ids, IPs, session ids and rank rows,
// so any case replays from `STRESS_SEED` + its case index.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "stress-anon-key";

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

/** mulberry32 — deterministic, replayable from its 32-bit seed. */
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
  /** A routable-looking test IP (TEST-NET / documentation ranges only). */
  ip(): string {
    return `${this.pick([198, 203, 192])}.${this.pick([51, 0, 18])}.${
      this.int(0, 254)
    }.${this.int(1, 254)}`;
  }
}

/** Derive a per-case seed from the campaign seed and a case label (FNV-1a). */
export function caseSeed(campaignSeed: number, label: string): number {
  let h = (0x811c9dc5 ^ campaignSeed) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Faults ───────────────────────────────────────────────────────────────────

export type UpstreamTarget = "auth" | "rest" | "redis" | "rc";

export type FaultSpec =
  /** Answer with this HTTP status and (optional) raw body / headers. */
  | {
    kind: "http";
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }
  /** fetch() rejects (socket reset / DNS / connection refused). */
  | { kind: "throw"; message?: string }
  /** Never answer. Honours the request's AbortSignal (rejects with AbortError)
   * and can be released by `releaseHangs()` (answers normally then). */
  | { kind: "hang" }
  /** Answer normally after `ms`. */
  | { kind: "delay"; ms: number }
  /** Redis only: answer 200 with this raw body (malformed pipeline replies). */
  | { kind: "raw"; body: string; status?: number }
  /** Redis only: replace the per-command results (index-aligned) — a function
   * receives the pipeline commands and returns the results array. */
  | {
    kind: "redis";
    results: (commands: Array<Array<string | number>>) => unknown;
  };

export interface Fault {
  target: UpstreamTarget;
  spec: FaultSpec;
  /** Calls left that this fault applies to (Infinity = until cleared). */
  remaining: number;
  /** PostgREST only: apply just to this table (path segment after /rest/v1/). */
  table?: string;
  /** Number of calls this fault actually intercepted. */
  hits: number;
}

export interface RecordedCall {
  url: string;
  method: string;
  target: UpstreamTarget | "other";
  /** PostgREST table / auth path / "pipeline" — for per-request attribution. */
  detail: string;
  status: number | "throw" | "hang";
  faulted: boolean;
  t: number;
}

export interface FakeSession {
  userId: string;
  accessToken: string;
  sessionId: string;
  expiresAt: number;
  revoked: boolean;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface TechniqueRow {
  user_id: string;
  shot_type: string;
  score: number;
  captured_at: string;
  sampled_count: number;
  confidence_weight: number;
}

export interface RankStateRow {
  user_id: string;
  rating: number;
  tier: string;
  technique_count: number;
  scored_shot_count: number;
  updated_at: string;
}

export type RestBackend = (input: {
  table: string;
  url: URL;
  headers: Record<string, string>;
  bearer: string;
}) => Promise<Response | null>;

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  calls: RecordedCall[];
  faults: Fault[];
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  users: Map<string, { id: string; email: string; provider: string }>;
  sessions: Map<string, FakeSession>;
  /** PostgREST rows: `player_technique_rating` and `player_rank_state`
   * are filtered by `user_id=eq.` exactly like PostgREST; other tables are
   * returned verbatim. */
  tables: Record<string, Array<Record<string, unknown>>>;
  /** Optional real backend for PostgREST GETs (stress_rank_pg.test.ts points
   * it at docker postgres:16). `null` → answer from `tables`. Survives
   * `reset()`. */
  restBackend: RestBackend | null;
  subscriber: Record<string, unknown> | null;
  /** Drop faults, calls, redis state, users, sessions, rows. */
  reset(): void;
  registerUser(id: string, provider?: string): void;
  mintSession(userId: string, ttlSeconds?: number): FakeSession;
  injectFault(
    target: UpstreamTarget,
    spec: FaultSpec,
    options?: { times?: number; table?: string },
  ): Fault;
  clearFaults(): void;
  /** Answer every pending `hang` normally. Resolves once they are released. */
  releaseHangs(): void;
  pendingHangs(): number;
  /** Calls recorded since `mark` (an index into `calls`). */
  callsSince(mark: number): RecordedCall[];
}

let harness: StressHarness | null = null;

function jsonResponse(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function gotrueUser(user: { id: string; email: string; provider: string }) {
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

function targetOf(
  url: string,
): { target: UpstreamTarget | "other"; detail: string } {
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
    return {
      target: "auth",
      detail: new URL(url).pathname.slice("/auth/v1/".length),
    };
  }
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    return {
      target: "rest",
      detail: new URL(url).pathname.slice("/rest/v1/".length),
    };
  }
  if (url.startsWith(REDIS_URL)) return { target: "redis", detail: "pipeline" };
  if (url.startsWith(RC_URL)) return { target: "rc", detail: "subscriber" };
  return { target: "other", detail: url };
}

export async function loadStressHarness(
  options: { redis: boolean },
): Promise<StressHarness> {
  if (harness) {
    if (harness.redisEnabled !== options.redis) {
      throw new Error(
        "stress harness already loaded with a different redis setting — cache.ts reads its env at import; use one setting per test file",
      );
    }
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
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

  const hangs: Array<() => void> = [];
  const t0 = performance.now();

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: options.redis,
    calls: [],
    faults: [],
    redis: new Map(),
    redisCommands: [],
    users: new Map(),
    sessions: new Map(),
    tables: {},
    restBackend: null,
    subscriber: {},
    reset() {
      state.calls = [];
      state.faults = [];
      state.redis = new Map();
      state.redisCommands = [];
      state.users = new Map();
      state.sessions = new Map();
      state.tables = {};
      state.subscriber = {};
    },
    registerUser(id, provider = "google") {
      state.users.set(id, {
        id,
        email: `${id.slice(0, 8)}@example.com`,
        provider,
      });
    },
    mintSession(userId, ttlSeconds = 3600) {
      if (!state.users.has(userId)) state.registerUser(userId);
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sessionId = crypto.randomUUID();
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: sessionId,
          exp: expiresAt,
          jti: crypto.randomUUID(),
        }),
      );
      const accessToken = `${header}.${payload}.sig`;
      const session: FakeSession = {
        userId,
        accessToken,
        sessionId,
        expiresAt,
        revoked: false,
      };
      state.sessions.set(accessToken, session);
      return session;
    },
    injectFault(target, spec, opts = {}) {
      const fault: Fault = {
        target,
        spec,
        remaining: opts.times ?? Infinity,
        table: opts.table,
        hits: 0,
      };
      state.faults.push(fault);
      return fault;
    },
    clearFaults() {
      state.faults = [];
    },
    releaseHangs() {
      const pending = hangs.splice(0, hangs.length);
      for (const release of pending) release();
    },
    pendingHangs() {
      return hangs.length;
    },
    callsSince(mark) {
      return state.calls.slice(mark);
    },
  };

  const normalAnswer = async (
    request: Request,
    target: UpstreamTarget | "other",
    detail: string,
    body: unknown,
  ): Promise<Response> => {
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));

    if (target === "rc") {
      if (!state.subscriber) {
        return new Response("upstream error", { status: 500 });
      }
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: state.subscriber,
      });
    }
    if (target === "redis") {
      if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }
    if (target === "auth") {
      if (detail === "user" && request.method === "GET") {
        const bearer = (headers["authorization"] ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const session = state.sessions.get(bearer);
        if (!session || session.revoked) {
          return jsonResponse(401, {
            code: 401,
            msg: "invalid JWT: session not found",
            error_code: "bad_jwt",
          });
        }
        if (session.expiresAt * 1000 <= Date.now()) {
          return jsonResponse(401, {
            code: 401,
            msg: "invalid JWT: token is expired",
            error_code: "bad_jwt",
          });
        }
        const user = state.users.get(session.userId);
        if (!user) {
          return jsonResponse(403, {
            code: 403,
            msg: "user not found",
            error_code: "user_not_found",
          });
        }
        return jsonResponse(200, gotrueUser(user));
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (target === "rest") {
      const parsed = new URL(url);
      const table = detail;
      if (table.startsWith("rpc/")) {
        return jsonResponse(404, {
          code: "PGRST202",
          message: `rpc ${table} not stubbed`,
        });
      }
      if (request.method === "GET" && state.restBackend) {
        const bearer = (headers["authorization"] ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const answered = await state.restBackend({
          table,
          url: parsed,
          headers,
          bearer,
        });
        if (answered) return answered;
      }
      if (request.method === "GET") {
        let rows = state.tables[table] ?? [];
        const eq = parsed.searchParams.get("user_id");
        if (eq && eq.startsWith("eq.")) {
          const wanted = eq.slice(3);
          rows = rows.filter((row) => String(row.user_id) === wanted);
        }
        const order = parsed.searchParams.get("order");
        if (order) {
          const [col, dir] = order.split(".");
          rows = [...rows].sort((a, b) => {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === "desc" ? -cmp : cmp;
          });
        }
        const accept = headers["accept"] ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) {
            return jsonResponse(406, {
              code: "PGRST116",
              message: "0 rows",
              details: "The result contains 0 rows",
              hint: null,
            });
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST" || request.method === "PATCH") {
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
    }
    return new Response(
      `unexpected fetch in stress harness: ${request.method} ${url}`,
      { status: 599 },
    );
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const { target, detail } = targetOf(url);
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const record: RecordedCall = {
      url,
      method: request.method,
      target,
      detail,
      status: 0,
      faulted: false,
      t: Math.round((performance.now() - t0) * 100) / 100,
    };
    state.calls.push(record);

    const fault = target === "other" ? undefined : state.faults.find(
      (f) =>
        f.target === target && f.remaining > 0 &&
        (f.table === undefined || f.table === detail),
    );
    if (fault) {
      fault.remaining -= 1;
      fault.hits += 1;
      record.faulted = true;
      const spec = fault.spec;
      switch (spec.kind) {
        case "http":
          record.status = spec.status;
          return new Response(
            spec.body ?? JSON.stringify({ error: `injected ${spec.status}` }),
            {
              status: spec.status,
              headers: {
                "Content-Type": "application/json",
                ...(spec.headers ?? {}),
              },
            },
          );
        case "throw":
          record.status = "throw";
          throw new TypeError(
            spec.message ?? "error sending request: connection reset by peer",
          );
        case "hang": {
          record.status = "hang";
          return await new Promise<Response>((resolve, reject) => {
            let done = false;
            const release = () => {
              if (done) return;
              done = true;
              normalAnswer(request, target, detail, body).then(
                resolve,
                reject,
              );
            };
            hangs.push(release);
            request.signal.addEventListener("abort", () => {
              if (done) return;
              done = true;
              const index = hangs.indexOf(release);
              if (index >= 0) hangs.splice(index, 1);
              reject(
                new DOMException("The signal has been aborted", "AbortError"),
              );
            });
          });
        }
        case "delay":
          await sleep(spec.ms);
          break;
        case "raw":
          record.status = spec.status ?? 200;
          return new Response(spec.body, {
            status: spec.status ?? 200,
            headers: { "Content-Type": "application/json" },
          });
        case "redis": {
          const commands = Array.isArray(body)
            ? (body as Array<Array<string | number>>)
            : [];
          for (const command of commands) state.redisCommands.push(command);
          record.status = 200;
          return jsonResponse(200, spec.results(commands));
        }
      }
    }
    const response = await normalAnswer(request, target, detail, body);
    record.status = response.status;
    return response;
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const captured = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!captured) throw new Error("Deno.serve called without a handler");
    state.handler = captured;
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

// ── Requests ─────────────────────────────────────────────────────────────────

export function rankRequest(token: string | null, ip: string): Request {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request("http://edge.test/functions/v1/api/v1/rank", {
    method: "GET",
    headers,
  });
}

/** A Supabase-shaped bearer nobody minted (right issuer, unknown session). */
export function forgedSessionToken(
  sub: string,
  expOffsetSeconds = 3600,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    }),
  );
  return `${header}.${payload}.sig`;
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

// ── Seeded rank data ─────────────────────────────────────────────────────────

export const SHOT_TYPES = [
  "dink",
  "third_shot_drop",
  "drive",
  "serve",
  "return",
  "volley",
  "overhead",
  "lob",
  "reset",
  "speedup",
] as const;

export function tierForRating(rating: number): string {
  if (rating >= 9) return "diamond";
  if (rating >= 7.5) return "platinum";
  if (rating >= 6) return "gold";
  if (rating >= 4.5) return "silver";
  return "bronze";
}

/** Seeded technique rows for `userId` plus the bit-identical saved state the
 * trigger would have persisted (playerRank.ts / recompute_player_rank math:
 * integer hundredths, round half away from zero). */
export function seededRank(
  prng: Prng,
  userId: string,
  techniqueCount = prng.int(1, 6),
): { techniques: TechniqueRow[]; state: RankStateRow; rating: number } {
  const pool: string[] = [...SHOT_TYPES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = prng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const types = pool.slice(0, Math.min(techniqueCount, pool.length));
  const techniques: TechniqueRow[] = types.map((shotType) => {
    const total = prng.int(1, 12);
    return {
      user_id: userId,
      shot_type: shotType,
      score: prng.int(0, 1000) / 100,
      captured_at: new Date(Date.UTC(2026, 8, prng.int(1, 28), prng.int(0, 23)))
        .toISOString(),
      sampled_count: Math.min(total, 8),
      confidence_weight: Math.min(total, 5),
    };
  });
  let weightSum = 0;
  let hundredths = 0;
  let scored = 0;
  for (const t of techniques) {
    weightSum += t.confidence_weight;
    hundredths += t.confidence_weight * Math.round(t.score * 100);
    scored += t.sampled_count;
  }
  const rating = Math.round(hundredths / weightSum) / 100;
  const state: RankStateRow = {
    user_id: userId,
    rating,
    tier: tierForRating(rating),
    technique_count: techniques.length,
    scored_shot_count: scored,
    updated_at: "2026-09-04T12:00:00.000Z",
  };
  return { techniques, state, rating };
}

/** Register a seeded user with rows + a minted session; returns what a test
 * needs to drive GET /v1/rank as that user. */
export function seedUser(
  h: StressHarness,
  prng: Prng,
  options: { techniques?: number; withState?: boolean } = {},
): {
  userId: string;
  token: string;
  ip: string;
  rating: number | null;
  session: FakeSession;
} {
  const userId = prng.uuid();
  h.registerUser(userId);
  const session = h.mintSession(userId);
  const ip = prng.ip();
  const count = options.techniques ?? prng.int(1, 6);
  if (count === 0) {
    return { userId, token: session.accessToken, ip, rating: null, session };
  }
  const rank = seededRank(prng, userId, count);
  h.tables.player_technique_rating ??= [];
  h.tables.player_rank_state ??= [];
  h.tables.player_technique_rating.push(
    ...(rank.techniques as unknown as Array<Record<string, unknown>>),
  );
  if (options.withState !== false) {
    h.tables.player_rank_state.push(
      rank.state as unknown as Record<string, unknown>,
    );
  }
  return {
    userId,
    token: session.accessToken,
    ip,
    rating: rank.rating,
    session,
  };
}

// ── Metrics / reporting ──────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarize(values: number[]): {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: Math.round(mean * 1000) / 1000,
  };
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-rank/latest/", import.meta.url)
    .pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/** Deno.memoryUsage() after an explicit GC when the runtime exposes one
 * (`--v8-flags=--expose-gc`); `gc` reports whether it ran. */
export function heapSnapshot(): Deno.MemoryUsage & { gc: boolean } {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    gc();
  }
  return { ...Deno.memoryUsage(), gc: typeof gc === "function" };
}

/** Run `fn` with Date.now() frozen (keeps a burst inside one rate-limit
 * window and one cache TTL). */
export async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
