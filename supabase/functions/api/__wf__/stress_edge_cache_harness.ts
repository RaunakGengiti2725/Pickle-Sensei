// Stress harness for the edge cache (cache.ts L1/L2) under the CONCURRENCY
// lens: N real module isolates (cache.ts, or the WHOLE handler index.ts) share
// ONE fake Upstash REST endpoint whose latency and faults are drawn from a
// seeded PRNG, so every interleaving is replayable from its seed.
//
// Nothing here is imported by production code; the tests in
// stress_edge_cache_*.test.ts drive it. Env knobs (all optional):
//
//   STRESS_SEED        base seed (default 20260905); iteration i uses SEED+i
//   STRESS_ITER        iterations per scenario (default 4 — fast enough for the
//                      suite; the campaign in the report used 60)
//   STRESS_LATENCY_MS  max seeded latency per fake upstream call (default 6)
//   STRESS_OUT_DIR     where the seed → outcome JSON tables are written
//                      (default artifacts/stress-edge-cache/latest/)
//
// Replay ONE seed:
//   STRESS_SEED=<seed> STRESS_ITER=1 deno test -A --no-check --config deno.json \
//     stress_edge_cache_concurrency.test.ts --filter "<scenario label>"

import { FakeSupabase, Prng, SUPABASE_URL } from "./xc_concurrency_harness.ts";

export { Prng };

export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";

const API_DIR = new URL("../", import.meta.url);

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 4);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A monotonic clock for ordering events inside one iteration. */
export const now = (): number => performance.now();

/** The real wall clock, untouched by shiftClock (the Redis plane keeps it). */
const realDateNow = Date.now;

// ─── Seeded fake Upstash ─────────────────────────────────────────────────────

export type RedisFault = "ok" | "http500" | "hang" | "cmd-error" | "truncate";

export type RedisMode =
  | { kind: "healthy" }
  /** Every request fails with HTTP 503 (Upstash down / unreachable). */
  | { kind: "down" }
  /** Every request hangs until the caller's AbortSignal fires (1.2 s). */
  | { kind: "hang" }
  /** Each request independently fails (503) with probability p. */
  | { kind: "flap"; p: number }
  /** Redis answers, but every command in the pipeline carries an error. */
  | { kind: "cmd-error" }
  /** Redis answers with a pipeline reply shorter than the command list. */
  | { kind: "truncate" };

interface RedisEntry {
  value: string;
  /** Redis-clock ms; null = no expiry. */
  expiresAtMs: number | null;
}

export interface RedisRequestLog {
  tStart: number;
  tEnd: number;
  commands: string[];
  fault: RedisFault;
}

/** Fake Upstash REST `/pipeline` with seeded latency, seeded faults, a
 * skewable clock and a full request log. GET/SET EX/TTL/DEL/INCR/EXPIRE [NX]
 * /EXISTS — the exact command set cache.ts emits. Pipelines are atomic (as
 * in Redis: one command sequence runs without interleaving). */
export class SeededUpstash {
  store = new Map<string, RedisEntry>();
  log: RedisRequestLog[] = [];
  mode: RedisMode = { kind: "healthy" };
  /** Redis clock = wall clock + this offset (TTL skew between planes). */
  clockOffsetMs = 0;
  latencyMaxMs: number;
  prng: Prng;
  requests = 0;
  faults = 0;
  /** Fires synchronously right after a pipeline has been applied to the
   * store (before the reply is sent) — lets a test schedule a competing call
   * at an exact point of the interleaving. */
  onApplied: ((commands: string[]) => void) | null = null;

  constructor(seed: number, latencyMaxMs: number) {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
  }

  redisNow(): number {
    return realDateNow() + this.clockOffsetMs;
  }

  private live(key: string): RedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.redisNow()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  /** Direct peek for assertions (never used by the code under test). */
  get(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  ttlSeconds(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAtMs === null) return -1;
    return Math.max(
      1,
      Math.round((entry.expiresAtMs - this.redisNow()) / 1000),
    );
  }

  /** Any fault injected during [tStart, tEnd]? Used to tell a documented
   * degraded-mode answer from a genuine violation. */
  faultWithin(tStart: number, tEnd: number): boolean {
    return this.log.some((r) =>
      r.fault !== "ok" && r.tEnd >= tStart && r.tStart <= tEnd
    );
  }

  private runCommand(
    cmd: Array<string | number>,
  ): { result?: unknown; error?: string } {
    const op = String(cmd[0]).toUpperCase();
    const key = String(cmd[1]);
    switch (op) {
      case "GET":
        return { result: this.live(key)?.value ?? null };
      case "SET": {
        const value = String(cmd[2]);
        let expiresAtMs: number | null = null;
        for (let i = 3; i < cmd.length; i += 1) {
          if (String(cmd[i]).toUpperCase() === "EX") {
            expiresAtMs = this.redisNow() + Number(cmd[i + 1]) * 1000;
            i += 1;
          }
        }
        this.store.set(key, { value, expiresAtMs });
        return { result: "OK" };
      }
      case "TTL":
        return { result: this.ttlSeconds(key) };
      case "EXISTS": {
        let n = 0;
        for (let i = 1; i < cmd.length; i += 1) {
          if (this.live(String(cmd[i]))) n += 1;
        }
        return { result: n };
      }
      case "DEL": {
        let n = 0;
        for (let i = 1; i < cmd.length; i += 1) {
          if (this.live(String(cmd[i]))) n += 1;
          this.store.delete(String(cmd[i]));
        }
        return { result: n };
      }
      case "INCR": {
        const entry = this.live(key);
        const next = (entry ? Number(entry.value) : 0) + 1;
        if (!Number.isFinite(next)) {
          return { error: "ERR value is not an integer" };
        }
        this.store.set(key, {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? null,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.live(key);
        if (!entry) return { result: 0 };
        const nx = cmd.slice(3).some((flag) =>
          String(flag).toUpperCase() === "NX"
        );
        if (nx && entry.expiresAtMs !== null) return { result: 0 };
        entry.expiresAtMs = this.redisNow() + Number(cmd[2]) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }

  private pickFault(): RedisFault {
    switch (this.mode.kind) {
      case "healthy":
        return "ok";
      case "down":
        return "http500";
      case "hang":
        return "hang";
      case "cmd-error":
        return "cmd-error";
      case "truncate":
        return "truncate";
      case "flap":
        return this.prng.next() < this.mode.p ? "http500" : "ok";
    }
  }

  async handle(request: Request, rawBody: string): Promise<Response> {
    const tStart = now();
    this.requests += 1;
    const entry: RedisRequestLog = {
      tStart,
      tEnd: tStart,
      commands: [],
      fault: "ok",
    };
    this.log.push(entry);
    if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
      entry.fault = "http500";
      entry.tEnd = now();
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }
    let commands: Array<Array<string | number>> = [];
    try {
      const parsed = JSON.parse(rawBody);
      if (Array.isArray(parsed)) {
        commands = parsed as Array<Array<string | number>>;
      }
    } catch {
      commands = [];
    }
    entry.commands = commands.map((c) => c.map(String).join(" "));
    const fault = this.pickFault();
    entry.fault = fault;
    if (fault !== "ok") this.faults += 1;

    if (fault === "hang") {
      await new Promise<void>((_, reject) => {
        const signal = request.signal;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
    if (fault === "http500") {
      entry.tEnd = now();
      return new Response("upstash unavailable", { status: 503 });
    }
    // The pipeline is applied atomically at THIS point (after the latency).
    const results = commands.map((cmd) =>
      fault === "cmd-error" ? { error: "ERR injected" } : this.runCommand(cmd)
    );
    const reply = fault === "truncate"
      ? results.slice(0, Math.max(0, results.length - 1))
      : results;
    this.onApplied?.(entry.commands);
    entry.tEnd = now();
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── Process-global plumbing (fetch / Deno.serve / env) ──────────────────────

type Handler = (request: Request) => Promise<Response>;

interface Globals {
  fetch: typeof fetch;
  serve: typeof Deno.serve;
  env: Record<string, string | undefined>;
}

const ENV_KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_WEBHOOK_AUTH",
  "REVENUECAT_SECRET_API_KEY",
];

let saved: Globals | null = null;

function saveGlobals(): void {
  if (saved) return;
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) env[key] = Deno.env.get(key);
  saved = { fetch: globalThis.fetch, serve: Deno.serve, env };
}

/** Restore fetch/serve/env exactly as they were before the first `install`,
 * so later test modules in the same process see an untouched world. */
export function restoreGlobals(): void {
  if (!saved) return;
  globalThis.fetch = saved.fetch;
  (Deno as unknown as { serve: unknown }).serve = saved.serve;
  for (const key of ENV_KEYS) {
    const value = saved.env[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  saved = null;
}

export interface UpstreamCall {
  t: number;
  method: string;
  url: string;
}

/** The shared world one iteration runs in: one fake Redis, optionally one fake
 * Supabase (GoTrue + PostgREST + RevenueCat, from xc_concurrency_harness), and
 * an optional interceptor that answers selected upstream calls itself. */
export class World {
  redis: SeededUpstash;
  fake: FakeSupabase | null;
  upstream: UpstreamCall[] = [];
  intercept:
    | ((request: Request, rawBody: string) => Promise<Response> | null)
    | null = null;
  private t0 = now();

  constructor(
    seed: number,
    options: { supabase?: boolean; latencyMaxMs?: number } = {},
  ) {
    const latency = options.latencyMaxMs ?? STRESS_LATENCY_MS;
    this.redis = new SeededUpstash(seed ^ 0x5eed, latency);
    this.fake = options.supabase ? new FakeSupabase(seed, latency) : null;
  }

  /** Route process-global fetch through this world. */
  install(): void {
    saveGlobals();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      const rawBody = await request.text().catch(() => "");
      this.upstream.push({
        t: Math.round((now() - this.t0) * 100) / 100,
        method: request.method,
        url: request.url,
      });
      if (request.url === `${REDIS_URL}/pipeline`) {
        return this.redis.handle(request, rawBody);
      }
      const intercepted = this.intercept?.(request, rawBody) ?? null;
      if (intercepted) return intercepted;
      if (this.fake) return this.fake.handleFetch(request, rawBody);
      return new Response(
        `stress harness: unexpected fetch ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }) as typeof fetch;
  }
}

// ─── Module isolates ─────────────────────────────────────────────────────────

export type CacheModule = typeof import("../cache.ts");
export type RateLimitModule = typeof import("../rateLimit.ts");

export interface CacheIsolate {
  id: number;
  cache: CacheModule;
  rateLimit: RateLimitModule;
}

export interface HandlerIsolate extends CacheIsolate {
  handler: Handler;
}

let isolateCounter = 0;

function setRedisEnv(enabled: boolean): void {
  saveGlobals();
  if (enabled) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
}

async function materialiseRateLimit(cacheSpecifier: string): Promise<string> {
  const source = await Deno.readTextFile(new URL("rateLimit.ts", API_DIR));
  const patched = source.replace(
    'from "./cache.ts"',
    `from "${cacheSpecifier}"`,
  );
  if (patched === source) {
    throw new Error("rateLimit.ts no longer imports ./cache.ts");
  }
  return URL.createObjectURL(
    new Blob([patched], { type: "application/typescript" }),
  );
}

/** A fresh cache.ts + rateLimit.ts pair with its own L1 maps (one "edge
 * isolate"). cache.ts reads UPSTASH_* at import time, so the env is set for
 * the duration of the import only. */
export async function loadCacheIsolate(
  options: { redis?: boolean } = {},
): Promise<CacheIsolate> {
  isolateCounter += 1;
  const id = isolateCounter;
  setRedisEnv(options.redis ?? true);
  const cacheSpecifier =
    new URL(`cache.ts?stress=${Date.now()}-${id}`, API_DIR).href;
  const cache = (await import(cacheSpecifier)) as CacheModule;
  const rateLimitUrl = await materialiseRateLimit(cacheSpecifier);
  const rateLimit = (await import(rateLimitUrl)) as RateLimitModule;
  URL.revokeObjectURL(rateLimitUrl);
  return { id, cache, rateLimit };
}

/** The REAL handler (index.ts) re-materialised so that ITS cache.ts and
 * rateLimit.ts are private to this isolate while every other module (drills,
 * http, legal, supabase-js…) resolves normally. Deno.serve is captured. */
export async function loadHandlerIsolate(
  options: { redis?: boolean } = {},
): Promise<HandlerIsolate> {
  isolateCounter += 1;
  const id = isolateCounter;
  saveGlobals();
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "xc-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "xc-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "xc-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  setRedisEnv(options.redis ?? true);

  const cacheSpecifier =
    new URL(`cache.ts?stress=${Date.now()}-${id}`, API_DIR).href;
  const cache = (await import(cacheSpecifier)) as CacheModule;
  const rateLimitUrl = await materialiseRateLimit(cacheSpecifier);
  const rateLimit = (await import(rateLimitUrl)) as RateLimitModule;

  let source = await Deno.readTextFile(new URL("index.ts", API_DIR));
  const before = source;
  source = source.replace('from "./cache.ts"', `from "${cacheSpecifier}"`);
  source = source.replace('from "./rateLimit.ts"', `from "${rateLimitUrl}"`);
  if (source === before) {
    throw new Error("index.ts no longer imports ./cache.ts");
  }
  source = source.replace(
    /from "\.\/([A-Za-z0-9_]+\.ts)"/g,
    (_match, file: string) => `from "${new URL(file, API_DIR).href}"`,
  );

  let handler: Handler | null = null;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | Handler
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  const indexUrl = URL.createObjectURL(
    new Blob([source], { type: "application/typescript" }),
  );
  try {
    await import(indexUrl);
  } finally {
    URL.revokeObjectURL(indexUrl);
    URL.revokeObjectURL(rateLimitUrl);
    (Deno as unknown as { serve: unknown }).serve = saved!.serve;
  }
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  return { id, cache, rateLimit, handler };
}

// ─── Clock control (TTL / clock-skew scenarios) ──────────────────────────────

let clockOffsetMs = 0;

/** Shift the isolates' wall clock (Date.now) by `ms`; cumulative. Redis keeps
 * its own offset (SeededUpstash.clockOffsetMs), so the two planes can skew. */
export function shiftClock(ms: number): void {
  clockOffsetMs += ms;
  Date.now = () => realDateNow() + clockOffsetMs;
}

export function resetClock(): void {
  clockOffsetMs = 0;
  Date.now = realDateNow;
}

// ─── Requests against a handler isolate ──────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: { token?: string | null; ip?: string; body?: unknown } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
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

export interface TimedResponse {
  status: number;
  body: Record<string, unknown>;
  tStart: number;
  tEnd: number;
}

export async function timed(
  handler: Handler,
  request: Request,
): Promise<TimedResponse> {
  const tStart = now();
  const response = await handler(request);
  const text = await response.text();
  const tEnd = now();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text);
      body = parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      body = { _raw: text };
    }
  }
  return { status: response.status, body, tStart, tEnd };
}

// ─── Seed → outcome tables ───────────────────────────────────────────────────

export type Outcome = "HELD" | "BROKEN" | "DOCUMENTED";

export interface IterationResult {
  seed: number;
  outcome: Outcome;
  /** Why it is BROKEN / DOCUMENTED — empty for HELD. */
  detail: string[];
  /** Deterministic reproducer tests (C2m, C7m, …) that pin each BROKEN line's
   * defect; a BROKEN line with no pin is a NEW failure. */
  pinnedBy: string[];
  inputs: Record<string, unknown>;
  counters: Record<string, number>;
  durationMs: number;
}

export interface ScenarioTable {
  scenario: string;
  label: string;
  lens: "concurrency";
  baseSeed: number;
  iterations: IterationResult[];
  summary: {
    HELD: number;
    BROKEN: number;
    DOCUMENTED: number;
    total: number;
    /** BROKEN seeds with at least one line no deterministic reproducer pins. */
    brokenUnpinned: number;
    brokenPinnedBy: Record<string, number>;
  };
  replay: string;
  wallMs: number;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-cache/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeTable(table: ScenarioTable): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${table.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  return path;
}

/** A per-iteration invariant ledger. `broken` is a hard failure; `documented`
 * marks a degraded-mode answer the code comments / [defect] tests already
 * pin (it is reported, never counted as HELD, never as BROKEN). */
export class Ledger {
  detail: string[] = [];
  pinnedBy: string[] = [];
  brokenCount = 0;
  unpinnedCount = 0;
  documentedCount = 0;
  counters: Record<string, number> = {};

  /** `pinnedBy` names the deterministic reproducer in this file that forces
   * the same interleaving (the seeded run then only measures how often it
   * happens); without it the failure is new and fails the test. */
  broken(message: string, pinnedBy?: string): void {
    this.brokenCount += 1;
    if (pinnedBy) {
      this.pinnedBy.push(pinnedBy);
      this.detail.push(`BROKEN[${pinnedBy}]: ${message}`);
    } else {
      this.unpinnedCount += 1;
      this.detail.push(`BROKEN: ${message}`);
    }
  }

  documented(message: string): void {
    this.documentedCount += 1;
    this.detail.push(`DOCUMENTED: ${message}`);
  }

  count(key: string, by = 1): void {
    this.counters[key] = (this.counters[key] ?? 0) + by;
  }

  outcome(): Outcome {
    if (this.brokenCount > 0) return "BROKEN";
    if (this.documentedCount > 0) return "DOCUMENTED";
    return "HELD";
  }
}

export function replayCommand(
  file: string,
  label: string,
  seed: number,
): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${label}"`;
}

/** Run `iterations` seeded iterations of one scenario, write its table and
 * return it. Tests assert `summary.BROKEN === 0`, or `summary.brokenUnpinned
 * === 0` where a deterministic reproducer pins the known interleaving. */
export async function runScenario(
  file: string,
  scenario: string,
  label: string,
  iterations: number,
  body: (
    seed: number,
    ledger: Ledger,
    inputs: Record<string, unknown>,
  ) => Promise<void>,
): Promise<ScenarioTable> {
  const t0 = now();
  const results: IterationResult[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const seed = STRESS_SEED + i;
    const ledger = new Ledger();
    const inputs: Record<string, unknown> = {};
    const tIter = now();
    try {
      await body(seed, ledger, inputs);
    } catch (error) {
      ledger.broken(
        `threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      resetClock();
    }
    results.push({
      seed,
      outcome: ledger.outcome(),
      detail: ledger.detail,
      pinnedBy: [...new Set(ledger.pinnedBy)],
      inputs,
      counters: ledger.counters,
      durationMs: Math.round(now() - tIter),
    });
  }
  const summary: ScenarioTable["summary"] = {
    HELD: 0,
    BROKEN: 0,
    DOCUMENTED: 0,
    total: results.length,
    brokenUnpinned: 0,
    brokenPinnedBy: {},
  };
  for (const r of results) {
    summary[r.outcome] += 1;
    if (r.outcome !== "BROKEN") continue;
    if (r.detail.some((d) => d.startsWith("BROKEN: "))) {
      summary.brokenUnpinned += 1;
    }
    for (const pin of r.pinnedBy) {
      summary.brokenPinnedBy[pin] = (summary.brokenPinnedBy[pin] ?? 0) + 1;
    }
  }
  const table: ScenarioTable = {
    scenario,
    label,
    lens: "concurrency",
    baseSeed: STRESS_SEED,
    iterations: results,
    summary,
    replay: replayCommand(file, label, STRESS_SEED),
    wallMs: Math.round(now() - t0),
  };
  const path = await writeTable(table);
  const pins = Object.entries(summary.brokenPinnedBy).map(([k, v]) =>
    `${k}×${v}`
  ).join(",");
  console.log(
    `[stress] ${scenario}: ${summary.HELD} HELD / ${summary.DOCUMENTED} DOCUMENTED / ${summary.BROKEN} BROKEN (${summary.brokenUnpinned} unpinned${
      pins ? `; pinned ${pins}` : ""
    }) over ${summary.total} seeds (${table.wallMs} ms) → ${path}`,
  );
  return table;
}

/** Seeds with a BROKEN line no deterministic reproducer pins (new failures). */
export function unpinnedBrokenSeeds(table: ScenarioTable): string {
  return table.iterations
    .filter((r) => r.detail.some((d) => d.startsWith("BROKEN: ")))
    .map((r) => `seed ${r.seed}: ${r.detail.join(" | ")}`)
    .join("\n");
}

export function brokenSeeds(table: ScenarioTable): string {
  return table.iterations
    .filter((r) => r.outcome === "BROKEN")
    .map((r) => `seed ${r.seed}: ${r.detail.join(" | ")}`)
    .join("\n");
}

/** Weighted pick of a Redis mode for one iteration. `hang` is excluded (each
 * hung call costs the real 1.2 s timeout; scenario C5 covers it on purpose). */
export function pickRedisMode(prng: Prng): RedisMode {
  const roll = prng.next();
  if (roll < 0.5) return { kind: "healthy" };
  if (roll < 0.75) return { kind: "flap", p: 0.15 + prng.next() * 0.25 };
  if (roll < 0.9) return { kind: "down" };
  if (roll < 0.95) return { kind: "cmd-error" };
  return { kind: "truncate" };
}

export function describeMode(mode: RedisMode): string {
  return mode.kind === "flap" ? `flap(p=${mode.p.toFixed(2)})` : mode.kind;
}
