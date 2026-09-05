// stress-edge-http — FAILURE-INJECTION + LOAD harness for the REAL edge
// function (../index.ts, Deno.serve captured), lens `failure-load`.
//
// Layers, outermost first:
//
//   globalThis.fetch  →  FaultLayer (this file)  →  FakeSupabase model
//                                                (xc_concurrency_harness.ts)
//                                                 + FakeUpstash pipeline (here)
//
// The fault layer classifies every upstream call the function makes
// (Supabase Auth / PostgREST / Upstash Redis / RevenueCat), records it, and
// consults the ACTIVE fault list. A matching fault replaces (status /
// malformed body / throw / hang-until-abort / delay) or decorates the model's
// answer; anything unmatched flows through to the stateful model, so the
// same harness serves both the fault matrix and the load campaign.
//
// Everything is seeded (mulberry32 Prng) and every campaign writes a JSON
// table under STRESS_OUT_DIR (default artifacts/stress-edge-http/latest/).
// Nothing here talks to a network: the only fetch that exists is the fake.

import {
  fakeGoogleIdToken,
  FakeSupabase,
  isRecord,
  Prng,
  RC_URL,
  SUPABASE_URL,
  WEBHOOK_SECRET,
} from "./xc_concurrency_harness.ts";

export { fakeGoogleIdToken, isRecord, RC_URL, SUPABASE_URL, WEBHOOK_SECRET };

/** xc Prng (mulberry32) plus the pick/chance helpers the campaigns use. */
export class Rng extends Prng {
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export const REDIS_URL = "https://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";

export type Upstream = "auth" | "rest" | "redis" | "rc" | "other";

export interface UpstreamCall {
  /** ms since harness boot */
  t: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** Short path-ish label: auth:/user, rest:rpc/access_state, redis:pipeline, rc:subscriber */
  op: string;
  /** Fault id applied to this call, if any. */
  fault: string | null;
  /** Wall time the fake upstream took to answer (ms). */
  durationMs: number;
  /** Response status (or "throw" / "abort"). */
  outcome: string;
  /** Request body as sent upstream (PostgREST writes / RPC arguments). */
  body: string;
}

export type FaultMode =
  | {
    kind: "status";
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }
  | { kind: "throw"; message?: string }
  /** Never answers; resolves only when the caller's AbortSignal fires (or
   * after `capMs`, so a caller WITHOUT a deadline cannot hang the suite). */
  | { kind: "hang"; capMs: number }
  /** Model answer, delayed. */
  | { kind: "delay"; ms: number }
  /** Model answer, then rewritten (malformed bodies etc.). */
  | {
    kind: "mutate";
    mutate: (response: Response) => Promise<Response> | Response;
  };

export interface Fault {
  id: string;
  upstream: Upstream;
  /** Narrow to a specific call (default: every call of that upstream). The
   * request body is already consumed by the recorder; it arrives as `body`. */
  match?: (request: Request, op: string, body: string) => boolean;
  mode: FaultMode;
  /** How many calls this fault fires for before it is spent (default ∞). */
  times?: number;
  /** Fired so far (bookkeeping). */
  fired?: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  redis: FakeUpstash;
  calls: UpstreamCall[];
  faults: Fault[];
  /** Replace the active fault list. */
  setFaults(faults: Fault[]): void;
  clearFaults(): void;
  /** Reset the model + counters (NOT the function's per-isolate caches —
   * those are the thing under test; use fresh users/tokens per scenario). */
  reset(seed: number, latencyMaxMs?: number): void;
  /** Calls recorded since `mark`. */
  since(mark: number): UpstreamCall[];
  mark(): number;
  redisEnabled: boolean;
}

// ── Fake Upstash (Redis REST /pipeline) ──────────────────────────────────────

export interface FakeUpstash {
  store: Map<string, { value: string; expiresAtMs: number | null }>;
  commands: Array<Array<string | number>>;
  /** Rewrite a single command's reply (poison the cache, break INCR…). */
  replyOverride:
    | ((
      cmd: Array<string | number>,
      reply: { result?: unknown; error?: string },
    ) => {
      result?: unknown;
      error?: string;
    })
    | null;
  reset(): void;
}

function redisLive(
  store: FakeUpstash["store"],
  key: string,
): { value: string; expiresAtMs: number | null } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function runRedisCommand(
  redis: FakeUpstash,
  cmd: Array<string | number>,
): { result?: unknown; error?: string } {
  const [name, ...args] = cmd.map(String);
  const store = redis.store;
  switch (name.toUpperCase()) {
    case "GET":
      return { result: redisLive(store, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(store, args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return {
        result: Math.max(
          1,
          Math.ceil((entry.expiresAtMs - Date.now()) / 1_000),
        ),
      };
    }
    case "SET": {
      const [key, value, ex, seconds] = args;
      if (ex && ex.toUpperCase() !== "EX") return { error: "ERR syntax error" };
      const ttl = ex ? Number(seconds) : NaN;
      store.set(key, {
        value,
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1_000 : null,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (store.delete(key)) n += 1;
      return { result: n };
    }
    case "INCR": {
      const entry = redisLive(store, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? null,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, flag] = args;
      const entry = redisLive(store, key);
      if (!entry) return { result: 0 };
      if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

function fakeUpstash(): FakeUpstash {
  const redis: FakeUpstash = {
    store: new Map(),
    commands: [],
    replyOverride: null,
    reset() {
      redis.store = new Map();
      redis.commands = [];
      redis.replyOverride = null;
    },
  };
  return redis;
}

async function redisPipeline(
  redis: FakeUpstash,
  request: Request,
  rawBody: string,
) {
  if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }
  let commands: Array<Array<string | number>> = [];
  try {
    const parsed = JSON.parse(rawBody);
    commands = Array.isArray(parsed) ? parsed : [];
  } catch {
    commands = [];
  }
  const replies = commands.map((cmd) => {
    redis.commands.push(cmd);
    const reply = runRedisCommand(redis, cmd);
    return redis.replyOverride ? redis.replyOverride(cmd, reply) : reply;
  });
  return new Response(JSON.stringify(replies), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Classification ───────────────────────────────────────────────────────────

export function classify(request: Request): { upstream: Upstream; op: string } {
  const url = new URL(request.url);
  if (request.url.startsWith(RC_URL)) {
    return { upstream: "rc", op: "rc:subscriber" };
  }
  if (url.origin === REDIS_URL) {
    return { upstream: "redis", op: "redis:pipeline" };
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
    const path = url.pathname.slice("/auth/v1".length);
    const grant = url.searchParams.get("grant_type");
    return {
      upstream: "auth",
      op: `auth:${path}${grant ? `?grant_type=${grant}` : ""}`,
    };
  }
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
    return {
      upstream: "rest",
      op: `rest:${request.method} ${url.pathname.slice("/rest/v1/".length)}`,
    };
  }
  return { upstream: "other", op: `${request.method} ${url.pathname}` };
}

function hangUntilAbort(
  signal: AbortSignal | null | undefined,
  capMs: number,
): Promise<"abort" | "cap"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("cap"), capMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve("abort");
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve("abort");
        },
        { once: true },
      );
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted: StressHarness | null = null;

/** Process environment is shared by every test module `deno task test` runs
 * (isolates differ, the env does not). Each key this harness or a campaign
 * touches is snapshotted on first boot; `restoreProcessEnv()` — the LAST
 * test of every stress module — puts it back so a later suite's
 * `AUTH_UPSTREAM_TIMEOUT_MS` / Upstash configuration is what IT expects. */
const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_WEBHOOK_AUTH",
  "REVENUECAT_SECRET_API_KEY",
  "APPLE_SIGN_IN_CLIENT_ID",
  "APPLE_SIGN_IN_TEAM_ID",
  "APPLE_SIGN_IN_KEY_ID",
  "APPLE_SIGN_IN_PRIVATE_KEY",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AUTH_UPSTREAM_TIMEOUT_MS",
] as const;
let envSnapshot: Map<string, string | undefined> | null = null;

export function snapshotProcessEnv(): void {
  if (envSnapshot) return;
  envSnapshot = new Map(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
}

export function restoreProcessEnv(): void {
  if (!envSnapshot) return;
  for (const [key, value] of envSnapshot) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

/** Boot the real edge function once per test module. `redis: true` points
 * cache.ts at the fake Upstash endpoint (read at import — fixed per isolate). */
export async function loadStressHarness(
  options: { redis?: boolean; seed?: number; latencyMaxMs?: number } = {},
): Promise<StressHarness> {
  if (booted) return booted;
  snapshotProcessEnv();
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
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

  const fake = new FakeSupabase(options.seed ?? 1, options.latencyMaxMs ?? 0);
  const redis = fakeUpstash();
  const calls: UpstreamCall[] = [];
  const t0 = performance.now();
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    fake,
    redis,
    calls,
    faults: [],
    setFaults(faults) {
      state.faults = faults.map((fault) => ({ ...fault, fired: 0 }));
    },
    clearFaults() {
      state.faults = [];
    },
    reset(seed, latencyMaxMs) {
      fake.reset(seed, latencyMaxMs);
      redis.reset();
      state.faults = [];
    },
    mark: () => calls.length,
    since: (mark) => calls.slice(mark),
    redisEnabled: Boolean(options.redis),
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : null);
    const rawBody = await request.text().catch(() => "");
    const { upstream, op } = classify(request);
    const started = performance.now();
    const record: UpstreamCall = {
      t: Math.round((started - t0) * 100) / 100,
      upstream,
      method: request.method,
      url: request.url,
      op,
      fault: null,
      durationMs: 0,
      outcome: "",
      body: rawBody,
    };
    calls.push(record);
    const finish = (outcome: string) => {
      record.durationMs = Math.round((performance.now() - started) * 100) /
        100;
      record.outcome = outcome;
    };
    const fault = state.faults.find(
      (candidate) =>
        candidate.upstream === upstream &&
        (candidate.times === undefined ||
          (candidate.fired ?? 0) < candidate.times) &&
        (!candidate.match || candidate.match(request, op, rawBody)),
    );
    const model = async (): Promise<Response> => {
      if (upstream === "redis") return redisPipeline(redis, request, rawBody);
      if (upstream === "rest" && request.method === "GET") {
        // Read-only tables the xc model does not carry (rank / progress
        // views): an empty result set is a valid, honest answer for a user
        // with no scored history, and lets those routes' fan-out be counted.
        const table = new URL(request.url).pathname.slice("/rest/v1/".length);
        if (!table.startsWith("rpc/") && !(table in fake.tables)) {
          return jsonResponse(200, []);
        }
      }
      if (upstream === "rest" && request.method === "PATCH") {
        // PostgREST `PATCH … Prefer: return=representation` (the onboarding
        // update): the xc model answers 204 with no body, which the route
        // reads as "no row". Apply the eq filters and echo the patched rows.
        const url = new URL(request.url);
        const table = url.pathname.slice("/rest/v1/".length);
        const rows = fake.tables[table];
        if (
          rows &&
          (request.headers.get("prefer") ?? "").includes(
            "return=representation",
          )
        ) {
          let patch: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(rawBody);
            patch = isRecord(parsed) ? parsed : {};
          } catch {
            patch = {};
          }
          const matched = rows.filter((row) =>
            [...url.searchParams.entries()].every(([col, raw]) =>
              !raw.startsWith("eq.") || String(row[col]) === raw.slice(3)
            )
          );
          for (const row of matched) Object.assign(row, patch);
          const single = (request.headers.get("accept") ?? "").includes(
            "pgrst.object",
          );
          if (single) {
            return matched.length === 1
              ? jsonResponse(200, matched[0])
              : jsonResponse(406, {
                code: "PGRST116",
                message: `${matched.length} rows`,
              });
          }
          return jsonResponse(200, matched);
        }
      }
      return fake.handleFetch(request, rawBody);
    };
    if (!fault) {
      const response = await model();
      finish(String(response.status));
      return response;
    }
    fault.fired = (fault.fired ?? 0) + 1;
    record.fault = fault.id;
    const mode = fault.mode;
    switch (mode.kind) {
      case "status": {
        finish(String(mode.status));
        return new Response(mode.body ?? "", {
          status: mode.status,
          headers: mode.headers ?? { "Content-Type": "application/json" },
        });
      }
      case "throw": {
        finish("throw");
        throw new TypeError(
          mode.message ?? "stress: simulated connection failure",
        );
      }
      case "hang": {
        const how = await hangUntilAbort(signal, mode.capMs);
        finish(how === "abort" ? "abort" : "hang-cap");
        if (how === "abort") {
          throw new DOMException("The signal has been aborted", "AbortError");
        }
        // The caller had no deadline: the cap fired. Answer with a 504 so the
        // scenario can tell "stalled to the cap" from an ordinary answer.
        return new Response("stress: upstream stalled past cap", {
          status: 504,
        });
      }
      case "delay": {
        await new Promise((resolve) => setTimeout(resolve, mode.ms));
        const response = await model();
        finish(String(response.status));
        return response;
      }
      case "mutate": {
        const response = await mode.mutate(await model());
        finish(String(response.status));
        return response;
      }
    }
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
  booted = state;
  return state;
}

// ── Request builders ─────────────────────────────────────────────────────────

export function edgeRequest(
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
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const body = options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
  });
}

export interface Answer {
  status: number;
  requestId: string | null;
  contentType: string | null;
  retryAfter: string | null;
  code: string | null;
  message: string | null;
  body: unknown;
  text: string;
  durationMs: number;
}

export async function answer(
  h: StressHarness,
  request: Request,
): Promise<Answer> {
  const started = performance.now();
  const response = await h.handler(request);
  const text = await response.text();
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    code: error && typeof error.code === "string" ? error.code : null,
    message: error && typeof error.message === "string" ? error.message : null,
    body,
    text,
    durationMs,
  };
}

/** Bootstrap a seeded user through the real route → its session bearer. */
export async function signIn(
  h: StressHarness,
  sub: string,
  ip: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const out = await answer(
    h,
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  if (out.status !== 200) {
    throw new Error(
      `bootstrap for ${sub} failed: ${out.status} ${out.text.slice(0, 200)}`,
    );
  }
  const session = isRecord(out.body) && isRecord(out.body.session)
    ? out.body.session
    : {};
  return {
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
    userId: sub,
  };
}

let ipCounter = 0;
/** A fresh client IP per scenario so per-IP budgets never bleed across cases.
 * 100.64.0.0/10 (RFC 6598) — a block no other __wf__ suite uses, so the
 * budgets this campaign spends (30 auth failures → 5 min lockout) can never
 * be confused with another suite's addresses in shared artifacts or logs. */
export function freshIp(): string {
  ipCounter += 1;
  return `100.${64 + Math.floor(ipCounter / 62_500)}.${
    Math.floor(ipCounter / 250) % 250
  }.${(ipCounter % 250) + 1}`;
}

// ── Stats / reporting ────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencyStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
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
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 1);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-http/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeArtifact(
  name: string,
  data: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(
    path,
    typeof data === "string" ? data : JSON.stringify(data, null, 2),
  );
  return path;
}

export function heapNow(): Deno.MemoryUsage {
  return Deno.memoryUsage();
}

/** Upstream call counts per op since `mark` — the round-trip table. */
export function roundTrips(
  calls: UpstreamCall[],
): Record<Upstream | "total", number> & {
  ops: Record<string, number>;
} {
  const out = {
    auth: 0,
    rest: 0,
    redis: 0,
    rc: 0,
    other: 0,
    total: 0,
    ops: {} as Record<string, number>,
  };
  for (const call of calls) {
    out[call.upstream] += 1;
    out.total += 1;
    out.ops[call.op] = (out.ops[call.op] ?? 0) + 1;
  }
  return out;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
