// Stress harness for the public legal text routes (GET|HEAD /support,
// /privacy, /terms — served from legal.ts through index.ts). Companion to
// routesHarness.ts / sessionHarness.ts: boots the REAL ../index.ts with
// Deno.serve captured and EVERY upstream (Upstash REST, Supabase Auth,
// PostgREST, RevenueCat) behind a fault-injectable fake fetch.
//
// The legal routes consult exactly one upstream — the Upstash-backed rate
// limiter (`enforceRateLimit("legal", ip, 60, 60)`) — so the fault catalogue
// below is Upstash-heavy; the Supabase/RevenueCat faults exist to PROVE the
// routes never touch those services (0 round trips, served promptly even
// while they hang).
//
// Campaign knobs (all optional; defaults keep the suite fast):
//   STRESS_SEED       base seed for every seeded campaign        (20260905)
//   STRESS_ITER       seeded random fault iterations             (60)
//   STRESS_LOAD       requests per load campaign                 (200)
//   STRESS_USERS      distinct client IPs in the memory campaign (2000)
//   STRESS_CASE_SEED  replay ONE iteration of the random campaign by the
//                     per-iteration seed printed in the results table
//   STRESS_OUT        directory for the JSON result tables
//                     (default artifacts/stress-edge-legal/latest/)
//
// Full-scale run used for the stress report:
//   STRESS_ITER=1000 STRESS_LOAD=1000 STRESS_USERS=20000 \
//     deno test -A --no-check --config deno.json stress_legal_failure_load.test.ts
//   STRESS_LOAD=1000 STRESS_USERS=20000 \
//     deno test -A --no-check --config deno.json stress_legal_memory_load.test.ts

import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { type AccessLogEntry, captureAccessLog } from "../http.ts";

// ─── Knobs ───────────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 60);
export const STRESS_LOAD = envInt("STRESS_LOAD", 200);
export const STRESS_USERS = envInt("STRESS_USERS", 2000);
export const STRESS_CASE_SEED: number | null = (() => {
  const raw = Deno.env.get("STRESS_CASE_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-legal/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeTable(
  name: string,
  table: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  return path;
}

// ─── Seeded RNG (mulberry32; every iteration derives its own 32-bit seed) ───

export class Rng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  /** Uniform in [0, 1). */
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
}

/** Per-iteration seed: splitmix-style hash of (base, index) so any single
 * iteration is replayable from the number printed in the table. */
export function iterationSeed(base: number, index: number): number {
  let x = (base ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[index];
}

export function latencySummary(values: number[]): {
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1] ?? NaN),
    meanMs: round(sorted.length ? sum / sorted.length : NaN),
  };
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

// ─── Routes under test ──────────────────────────────────────────────────────

export const LEGAL_ROUTES = ["/support", "/privacy", "/terms"] as const;
export type LegalRoute = (typeof LEGAL_ROUTES)[number];
export const LEGAL_METHODS = ["GET", "HEAD"] as const;
export type LegalMethod = (typeof LEGAL_METHODS)[number];

export const LEGAL_TEXT: Record<LegalRoute, string> = {
  "/support": SUPPORT_TEXT,
  "/privacy": PRIVACY_POLICY_TEXT,
  "/terms": TERMS_TEXT,
};

export const PUBLIC_PAGE_LIMIT = 60;
export const REDIS_TIMEOUT_MS = 1_200;

// ─── Fault-injectable upstreams ─────────────────────────────────────────────

export type Upstream = "upstash" | "supabaseAuth" | "postgrest" | "revenuecat";

export interface FaultContext {
  request: Request;
  /** Parsed pipeline body for Upstash (null when not JSON). */
  body: unknown;
  /** The honest fake's answer, so a fault can wrap or corrupt it. */
  honest: () => Response;
  /** Fault call counter for this fault (1-based), for intermittent modes. */
  nth: number;
}

/** What the client must observe when this fault is active on a FRESH ip. */
export type UserVisible =
  | "served" // 200 text (rate limiter failed open or counted honestly)
  | "rate_limited"; // 429 rate_limited because Redis (authoritatively) said so

export interface FaultCase {
  id: string;
  upstream: Upstream;
  title: string;
  /** Which counter source the limiter should end up on for a fresh ip
   * ("split": an intermittent fault divides one client's hits between
   * Redis and the per-isolate memory window, so neither sees them all). */
  fallback: "memory" | "redis" | "split";
  expect: UserVisible;
  /** Lower bound on request latency this fault must impose (ms). */
  minLatencyMs?: number;
  respond(ctx: FaultContext): Promise<Response> | Response;
}

export interface RecordedCall {
  url: string;
  method: string;
  upstream: Upstream | "other";
  body: unknown;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  realFetch: typeof fetch;
  realServe: typeof Deno.serve;
  redisEnabled: boolean;
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  calls: RecordedCall[];
  /** Active fault per upstream (null = honest fake). */
  faults: Partial<Record<Upstream, FaultCase | null>>;
  faultCalls: number;
  accessLog: AccessLogEntry[];
  reset(): void;
  callsTo(upstream: Upstream): RecordedCall[];
}

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "upstash-stress-token";
export const REVENUECAT_URL = "https://api.revenuecat.com";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let harness: StressHarness | null = null;

/** Boot the real edge function ONCE per test module. `redis` is fixed at
 * first load because cache.ts reads UPSTASH_* at import time. */
export async function loadStressHarness(
  options: { redis: boolean },
): Promise<StressHarness> {
  if (harness) {
    if (harness.redisEnabled !== options.redis) {
      throw new Error(
        "stress harness already booted with a different redis setting",
      );
    }
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
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

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    realFetch,
    realServe,
    redisEnabled: options.redis,
    redis: new Map(),
    redisCommands: [],
    calls: [],
    faults: {},
    faultCalls: 0,
    accessLog: [],
    reset() {
      state.redis = new Map();
      state.redisCommands = [];
      state.calls = [];
      state.faults = {};
      state.faultCalls = 0;
      state.accessLog = [];
    },
    callsTo(upstream: Upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
  };

  captureAccessLog((line) => {
    state.accessLog.push(JSON.parse(line) as AccessLogEntry);
  });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const text = await request.clone().text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const upstream = classify(url);
    state.calls.push({ url, method: request.method, upstream, body });

    const honest = (): Response => {
      if (upstream === "upstash") {
        if (
          request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`
        ) {
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
      if (upstream === "supabaseAuth") {
        return jsonResponse(401, {
          code: 401,
          msg: "invalid JWT",
          error_code: "bad_jwt",
        });
      }
      if (upstream === "postgrest") return jsonResponse(200, []);
      if (upstream === "revenuecat") {
        return jsonResponse(200, { subscriber: {} });
      }
      return new Response(
        `unexpected fetch in stress test: ${request.method} ${url}`,
        {
          status: 599,
        },
      );
    };

    const fault = upstream === "other" ? null : state.faults[upstream];
    if (fault) {
      state.faultCalls += 1;
      return await fault.respond({
        request,
        body,
        honest,
        nth: state.faultCalls,
      });
    }
    return honest();
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
  // cache.ts has read its configuration; do not leak it into later modules.
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  Deno.serve = realServe;
  harness = state;
  return state;
}

function classify(url: string): Upstream | "other" {
  if (url.startsWith(REDIS_URL)) return "upstash";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1`)) return "supabaseAuth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1`)) return "postgrest";
  if (url.startsWith(REVENUECAT_URL)) return "revenuecat";
  return "other";
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
    case "TTL": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

// ─── Fault catalogue ────────────────────────────────────────────────────────

/** Reject when the caller's AbortSignal fires (cache.ts uses
 * AbortSignal.timeout(1200)); never resolves otherwise. No timers of our own,
 * so the test sanitizers stay quiet. */
function hangUntilAbort(request: Request): Promise<never> {
  return new Promise((_, reject) => {
    const signal = request.signal;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function afterMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 200 whose body never completes until the caller aborts. */
function hangingBody(request: Request, prefix: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      const signal = request.signal;
      const fail = () =>
        controller.error(
          signal.reason ?? new DOMException("aborted", "AbortError"),
        );
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function erroringBody(prefix: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(new TypeError("connection reset by peer"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const pipeline = (results: unknown): Response => jsonResponse(200, results);

export const UPSTASH_FAULTS: FaultCase[] = [
  {
    id: "U01",
    upstream: "upstash",
    title: "HTTP 500 JSON error",
    fallback: "memory",
    expect: "served",
    respond: () => jsonResponse(500, { error: "internal" }),
  },
  {
    id: "U02",
    upstream: "upstash",
    title: "HTTP 502 HTML body",
    fallback: "memory",
    expect: "served",
    respond: () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
  },
  {
    id: "U03",
    upstream: "upstash",
    title: "HTTP 503 empty body",
    fallback: "memory",
    expect: "served",
    respond: () => new Response(null, { status: 503 }),
  },
  {
    id: "U04",
    upstream: "upstash",
    title: "HTTP 401 token rejected",
    fallback: "memory",
    expect: "served",
    respond: () => jsonResponse(401, { error: "Unauthorized" }),
  },
  {
    id: "U05",
    upstream: "upstash",
    title: "HTTP 403 forbidden",
    fallback: "memory",
    expect: "served",
    respond: () => jsonResponse(403, { error: "Forbidden" }),
  },
  {
    id: "U06",
    upstream: "upstash",
    title: "HTTP 404 (wrong REST url)",
    fallback: "memory",
    expect: "served",
    respond: () => new Response("not found", { status: 404 }),
  },
  {
    id: "U07",
    upstream: "upstash",
    title: "HTTP 429 (Upstash quota)",
    fallback: "memory",
    expect: "served",
    respond: () =>
      jsonResponse(429, { error: "ERR max requests limit exceeded" }),
  },
  {
    id: "U08",
    upstream: "upstash",
    title: "200 with HTML instead of JSON",
    fallback: "memory",
    expect: "served",
    respond: () =>
      new Response("<html>captive portal</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  },
  {
    id: "U09",
    upstream: "upstash",
    title: "200 with empty body",
    fallback: "memory",
    expect: "served",
    respond: () => new Response("", { status: 200 }),
  },
  {
    id: "U10",
    upstream: "upstash",
    title: "200 with JSON null",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline(null),
  },
  {
    id: "U11",
    upstream: "upstash",
    title: "200 with JSON object instead of array",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline({ result: 1 }),
  },
  {
    id: "U12",
    upstream: "upstash",
    title: "200 with empty array",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline([]),
  },
  {
    id: "U13",
    upstream: "upstash",
    title: "200 with per-command errors",
    fallback: "memory",
    expect: "served",
    respond: () =>
      pipeline([{ error: "ERR max requests limit exceeded" }, {
        error: "ERR max requests limit exceeded",
      }]),
  },
  // Redis says "null" for INCR: Number(null) = 0 — counted as zero, not
  // treated as unavailable (documented quirk; asserted as observed).
  {
    id: "U14",
    upstream: "upstash",
    title: "200 with INCR result null",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: null }, { result: 0 }]),
  },
  {
    id: "U15",
    upstream: "upstash",
    title: "200 with INCR result empty string",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: "" }, { result: 1 }]),
  },
  {
    id: "U16",
    upstream: "upstash",
    title: "200 with INCR result 'NaN'",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline([{ result: "NaN" }, { result: 1 }]),
  },
  {
    id: "U17",
    upstream: "upstash",
    title: "200 with numeric string count '7'",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: "7" }, { result: 1 }]),
  },
  {
    id: "U18",
    upstream: "upstash",
    title: "200 with boolean count",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: true }, { result: 1 }]),
  },
  {
    id: "U19",
    upstream: "upstash",
    title: "200 with object count",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline([{ result: { count: 1 } }, { result: 1 }]),
  },
  {
    id: "U20",
    upstream: "upstash",
    title: "200 with single-element array count",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: [1] }, { result: 1 }]),
  },
  {
    id: "U21",
    upstream: "upstash",
    title: "200 with count exactly at the limit (60)",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: PUBLIC_PAGE_LIMIT }, { result: 1 }]),
  },
  {
    id: "U22",
    upstream: "upstash",
    title: "200 with count one over the limit (61)",
    fallback: "redis",
    expect: "rate_limited",
    respond: () => pipeline([{ result: PUBLIC_PAGE_LIMIT + 1 }, { result: 0 }]),
  },
  {
    id: "U23",
    upstream: "upstash",
    title: "200 with absurd count 1e15",
    fallback: "redis",
    expect: "rate_limited",
    respond: () => pipeline([{ result: 1e15 }, { result: 0 }]),
  },
  {
    id: "U24",
    upstream: "upstash",
    title: "200 with 23-digit string count",
    fallback: "redis",
    expect: "rate_limited",
    respond: () =>
      pipeline([{ result: "99999999999999999999999" }, { result: 0 }]),
  },
  {
    id: "U25",
    upstream: "upstash",
    title: "200 with negative count",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: -5 }, { result: 1 }]),
  },
  {
    id: "U26",
    upstream: "upstash",
    title: "200 with fractional count 1.5",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: 1.5 }, { result: 1 }]),
  },
  {
    id: "U27",
    upstream: "upstash",
    title: "200 with count 'Infinity'",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline([{ result: "Infinity" }, { result: 1 }]),
  },
  {
    id: "U28",
    upstream: "upstash",
    title: "200 with EXPIRE slot missing",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: 1 }]),
  },
  {
    id: "U29",
    upstream: "upstash",
    title: "200 with INCR ok but EXPIRE error",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: 1 }, { error: "ERR EXPIRE failed" }]),
  },
  {
    id: "U30",
    upstream: "upstash",
    title: "200 with extra pipeline slots",
    fallback: "redis",
    expect: "served",
    respond: () =>
      pipeline([{ result: 1 }, { result: 1 }, { result: 99 }, { result: 100 }]),
  },
  {
    id: "U31",
    upstream: "upstash",
    title: "200 with truncated JSON body",
    fallback: "memory",
    expect: "served",
    respond: () =>
      new Response('[{"result":1', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
  {
    id: "U32",
    upstream: "upstash",
    title: "fetch throws TypeError (connection refused)",
    fallback: "memory",
    expect: "served",
    respond: () => {
      throw new TypeError("error sending request: connection refused");
    },
  },
  {
    id: "U33",
    upstream: "upstash",
    title: "fetch rejects with AbortError immediately",
    fallback: "memory",
    expect: "served",
    respond: () =>
      Promise.reject(
        new DOMException("The signal has been aborted", "AbortError"),
      ),
  },
  {
    id: "U34",
    upstream: "upstash",
    title: "fetch hangs until the 1.2s timeout",
    fallback: "memory",
    expect: "served",
    minLatencyMs: REDIS_TIMEOUT_MS - 50,
    respond: ({ request }) => hangUntilAbort(request),
  },
  {
    id: "U35",
    upstream: "upstash",
    title: "200 headers, body hangs until timeout",
    fallback: "memory",
    expect: "served",
    minLatencyMs: REDIS_TIMEOUT_MS - 50,
    respond: ({ request }) => hangingBody(request, '[{"result":'),
  },
  {
    id: "U36",
    upstream: "upstash",
    title: "200 headers, body stream errors mid-way",
    fallback: "memory",
    expect: "served",
    respond: () => erroringBody('[{"result":1},'),
  },
  {
    id: "U37",
    upstream: "upstash",
    title: "slow but within timeout (300ms)",
    fallback: "redis",
    expect: "served",
    minLatencyMs: 280,
    respond: async ({ honest }) => {
      await afterMs(300);
      return honest();
    },
  },
  {
    id: "U38",
    upstream: "upstash",
    title: "200 JSON with text/plain content-type",
    fallback: "redis",
    expect: "served",
    respond: ({ honest }) =>
      new Response(honest().body, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  },
  {
    id: "U39",
    upstream: "upstash",
    title: "HTTP 204 no content",
    fallback: "memory",
    expect: "served",
    respond: () => new Response(null, { status: 204 }),
  },
  {
    id: "U40",
    upstream: "upstash",
    title: "200 with 50k-element pipeline reply",
    fallback: "redis",
    expect: "served",
    respond: () =>
      pipeline(
        Array.from({ length: 50_000 }, (_, i) => ({ result: i === 0 ? 1 : 0 })),
      ),
  },
  {
    id: "U41",
    upstream: "upstash",
    title: "intermittent: every 2nd call is a 500",
    fallback: "split",
    expect: "served",
    respond: (
      { honest, nth },
    ) => (nth % 2 === 0 ? jsonResponse(500, { error: "flap" }) : honest()),
  },
  {
    id: "U42",
    upstream: "upstash",
    title: "frozen counter: always reports 1",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: 1 }, { result: 1 }]),
  },
  {
    id: "U43",
    upstream: "upstash",
    title: "200 with a JSON string body",
    fallback: "memory",
    expect: "served",
    respond: () => pipeline("OK"),
  },
  {
    id: "U44",
    upstream: "upstash",
    title: "HTTP 302 redirect",
    fallback: "memory",
    expect: "served",
    respond: () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://elsewhere.test/" },
      }),
  },
  {
    id: "U45",
    upstream: "upstash",
    title: "slow reply just under the timeout (1000ms)",
    fallback: "redis",
    expect: "served",
    minLatencyMs: 980,
    respond: async ({ honest }) => {
      await afterMs(1000);
      return honest();
    },
  },
  {
    id: "U46",
    upstream: "upstash",
    title: "200 with 1 MiB of whitespace then valid JSON",
    fallback: "redis",
    expect: "served",
    respond: () =>
      new Response(" ".repeat(1_048_576) + '[{"result":1},{"result":1}]', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
  {
    id: "U47",
    upstream: "upstash",
    title: "200 with count 0",
    fallback: "redis",
    expect: "served",
    respond: () => pipeline([{ result: 0 }, { result: 1 }]),
  },
  {
    id: "U48",
    upstream: "upstash",
    title: "fetch throws a plain string",
    fallback: "memory",
    expect: "served",
    respond: () => {
      throw "boom";
    },
  },
];

/** Faults on upstreams the legal routes must NEVER contact. Each is
 * catastrophic if reached (hang / throw) so a stray round trip would show up
 * as a timeout or a 5xx rather than a silently-tolerated call. */
export const INDEPENDENCE_FAULTS: FaultCase[] = [
  {
    id: "S01",
    upstream: "supabaseAuth",
    title: "Supabase Auth 500",
    fallback: "redis",
    expect: "served",
    respond: () => jsonResponse(500, { msg: "down" }),
  },
  {
    id: "S02",
    upstream: "supabaseAuth",
    title: "Supabase Auth hangs",
    fallback: "redis",
    expect: "served",
    respond: ({ request }) => hangUntilAbort(request),
  },
  {
    id: "S03",
    upstream: "supabaseAuth",
    title: "Supabase Auth throws",
    fallback: "redis",
    expect: "served",
    respond: () => {
      throw new TypeError("dns failure");
    },
  },
  {
    id: "S04",
    upstream: "postgrest",
    title: "PostgREST 500",
    fallback: "redis",
    expect: "served",
    respond: () => jsonResponse(500, { code: "XX000" }),
  },
  {
    id: "S05",
    upstream: "postgrest",
    title: "PostgREST hangs",
    fallback: "redis",
    expect: "served",
    respond: ({ request }) => hangUntilAbort(request),
  },
  {
    id: "S06",
    upstream: "postgrest",
    title: "PostgREST malformed JSON",
    fallback: "redis",
    expect: "served",
    respond: () =>
      new Response("{oops", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
  {
    id: "R01",
    upstream: "revenuecat",
    title: "RevenueCat 500",
    fallback: "redis",
    expect: "served",
    respond: () => jsonResponse(500, { message: "down" }),
  },
  {
    id: "R02",
    upstream: "revenuecat",
    title: "RevenueCat hangs",
    fallback: "redis",
    expect: "served",
    respond: ({ request }) => hangUntilAbort(request),
  },
  {
    id: "R03",
    upstream: "revenuecat",
    title: "RevenueCat throws",
    fallback: "redis",
    expect: "served",
    respond: () => {
      throw new TypeError("tls handshake failed");
    },
  },
];

export const ALL_FAULTS: FaultCase[] = [
  ...UPSTASH_FAULTS,
  ...INDEPENDENCE_FAULTS,
];

// ─── Requests ───────────────────────────────────────────────────────────────

let ipCounter = 0;
/** A fresh client IP per case so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 256}.${(ipCounter % 250) + 1}`;
}

export function legalRequest(
  method: string,
  path: string,
  options: {
    ip?: string | null;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {},
): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.ip !== null) {
    headers.set("x-forwarded-for", options.ip ?? freshIp());
  }
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body,
  });
}

export interface Observation {
  status: number;
  code: string | null;
  contentType: string | null;
  cacheControl: string | null;
  requestId: string | null;
  retryAfter: string | null;
  bodyBytes: number;
  bodyMatchesDocument: boolean;
  latencyMs: number;
  roundTrips: Record<Upstream, number>;
}

/** Drive one request through the real handler and record everything a client
 * (and the access log) can see. */
export async function observe(
  h: StressHarness,
  request: Request,
  route: LegalRoute | null,
): Promise<Observation> {
  const callsBefore = h.calls.length;
  const started = performance.now();
  const response = await h.handler(request);
  const body = await response.text();
  const latencyMs = performance.now() - started;
  const calls = h.calls.slice(callsBefore);
  const roundTrips: Record<Upstream, number> = {
    upstash: 0,
    supabaseAuth: 0,
    postgrest: 0,
    revenuecat: 0,
  };
  for (const call of calls) {
    if (call.upstream !== "other") roundTrips[call.upstream] += 1;
  }
  let code: string | null = null;
  if (
    (response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string } };
      code = parsed.error?.code ?? null;
    } catch {
      code = null;
    }
  }
  return {
    status: response.status,
    code,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    requestId: response.headers.get("x-request-id"),
    retryAfter: response.headers.get("retry-after"),
    bodyBytes: body.length,
    bodyMatchesDocument: route !== null && body === LEGAL_TEXT[route],
    latencyMs,
    roundTrips,
  };
}

/** Run `fn` with Date.now() shifted by `offsetMs` (the edge function, its
 * cache and its rate-limit windows all read Date.now()). */
export async function withClockOffset<T>(
  offsetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Freeze Date.now() for the duration of `fn` (keeps a burst inside one
 * rate-limit window). */
export function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  return withClockOffset(0, fn);
}

/** Classify an observation against a fault's contract. Returns the list of
 * violated expectations (empty = HELD). */
export function judge(
  fault: FaultCase,
  method: LegalMethod,
  route: LegalRoute,
  obs: Observation,
): string[] {
  const problems: string[] = [];
  if (fault.expect === "served") {
    if (obs.status !== 200) problems.push(`status ${obs.status} != 200`);
    if (!(obs.contentType ?? "").startsWith("text/plain")) {
      problems.push(`content-type ${obs.contentType}`);
    }
    if (obs.cacheControl !== "public, max-age=3600") {
      problems.push(`cache-control ${obs.cacheControl}`);
    }
    if (method === "GET" && !obs.bodyMatchesDocument) {
      problems.push(`body is not the ${route} document`);
    }
  } else {
    if (obs.status !== 429) problems.push(`status ${obs.status} != 429`);
    if (obs.code !== "rate_limited") {
      problems.push(`code ${obs.code} != rate_limited`);
    }
    if (
      !obs.retryAfter || Number(obs.retryAfter) < 1 ||
      Number(obs.retryAfter) > 60
    ) {
      problems.push(`retry-after ${obs.retryAfter}`);
    }
  }
  if (!obs.requestId) problems.push("missing x-request-id");
  if (
    obs.roundTrips.supabaseAuth + obs.roundTrips.postgrest +
        obs.roundTrips.revenuecat > 0
  ) {
    problems.push(`unexpected round trips ${JSON.stringify(obs.roundTrips)}`);
  }
  if (fault.minLatencyMs !== undefined && obs.latencyMs < fault.minLatencyMs) {
    problems.push(
      `latency ${obs.latencyMs.toFixed(1)}ms < ${fault.minLatencyMs}ms`,
    );
  }
  if (obs.latencyMs > REDIS_TIMEOUT_MS + 400) {
    problems.push(
      `latency ${
        obs.latencyMs.toFixed(1)
      }ms exceeds the 1.2s redis timeout + 400ms`,
    );
  }
  return problems;
}
