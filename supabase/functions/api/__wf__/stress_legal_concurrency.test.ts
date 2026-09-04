// stress-edge-legal-concurrency — seeded Promise.all bursts against the REAL
// edge handler (../index.ts) for the public legal text routes
// (GET|HEAD …/support | …/privacy | …/terms, legal.ts) and the shared
// per-IP "legal" fixed-window budget (PUBLIC_PAGE_LIMIT = 60/min) they sit
// behind.
//
// The handler is materialised per "edge instance" from source (index.ts +
// rateLimit.ts re-pointed at a query-string copy of cache.ts, exactly like
// harness.ts::loadIsolate) so every instance owns its in-memory rate-limit
// windows, and two instances can share one fake Upstash Redis — the
// cross-instance path production runs when UPSTASH_* is set.
//
// One ITERATION = one seeded burst scenario (family drawn from the seed):
//   mem_same_ip        one IP, K∈[61,160] mixed GET/HEAD × 3 docs, random mount
//                      prefixes, spoofed leading x-forwarded-for hops, client
//                      request ids, call-during-call follow-ups — memory limiter
//   mem_multi_ip       2–5 IPs in one burst, some over budget, some under
//   redis_two_instances two edge instances, one shared Redis, seeded pipeline
//                      latency — TRUE cross-instance budget
//   redis_fail_open    seeded Redis faults (HTTP 500 / network reject / command
//                      error / truncated reply) mid-burst — fail-open contract
//   redis_hang         every Redis call hangs until the 1.2 s client timeout
//   clock_skew         virtual Date.now jumps (+61 s / +30 s / −61 s) between
//                      requests of one burst
//   cancel_during_call client aborts Request signals / cancels response bodies
//                      mid-burst
//
// Invariants (the CONTRACT — never an observed defect):
//   exact budget       admitted == Σ_key min(requests_key, 60) when the limiter
//                      is reachable (memory path, or every Redis call succeeds)
//   fail-open bounds   min(K,60) ≤ admitted ≤ 60·(1 + instances) when Redis
//                      misbehaves; NEVER a 5xx on a public text route
//   no double spend    Redis counter == K and exactly one [INCR, EXPIRE NX]
//                      pipeline per request; the key carries a TTL ≤ 60 s
//   response integrity every 200 carries the document of ITS path with the
//                      legalTextResponse headers; every 429 carries the
//                      rateLimitResponse headers and Retry-After ∈ [1,60]
//   request id + log   one x-request-id per response (client id echoed when
//                      well-formed, otherwise a unique UUID) and exactly one
//                      access-log line per request, matching id/method/status
//   bounded wall time  a burst completes within STRESS_BURST_BUDGET_MS
//                      (hang family: + the 1.2 s Redis timeout)
//
// Scale (override by env): STRESS_ITER=120 iterations (campaign: ≥500),
// STRESS_SEED=20260904 base seed (iteration i uses seed STRESS_SEED+i),
// STRESS_FAMILY=<name> pins the family, STRESS_OUT_DIR for the JSON table.
// Replay one iteration exactly:
//   STRESS_SEED=<seed> STRESS_ITER=1 deno test -A --no-check --config deno.json \
//     stress_legal_concurrency.test.ts
//
// Run: cd supabase/functions/api/__wf__ && deno task test   (or the file alone)

import { assert, assertEquals } from "@std/assert";
import { type AccessLogEntry, captureAccessLog } from "../http.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

// ── Config ───────────────────────────────────────────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const STRESS_ITER = envInt("STRESS_ITER", 120);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_FAMILY = Deno.env.get("STRESS_FAMILY") ?? "";
/** Wall-time bound for one burst (K ≤ 200 in-process requests). */
export const STRESS_BURST_BUDGET_MS = envInt("STRESS_BURST_BUDGET_MS", 3_000);

const LIMIT = 60;
const WINDOW_SECONDS = 60;
const REDIS_TIMEOUT_MS = 1_200;
const MEMORY_WINDOW_MAX = 20_000;

const FAKE_REDIS_URL = "https://stress-upstash.test";
const FAKE_REDIS_TOKEN = "stress-token";

const API_DIR = new URL("../", import.meta.url);

// ── Seeded scheduler ─────────────────────────────────────────────────────────

/** mulberry32 — the same generator as xc_concurrency_harness.ts. */
class Prng {
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
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Edge instances (fresh module graph per instance) ─────────────────────────

type Handler = (request: Request) => Promise<Response>;

interface EdgeInstance {
  name: string;
  redis: boolean;
  handler: Handler;
}

let instanceCounter = 0;

/** Materialise ../index.ts with its own cache.ts + rateLimit.ts instance so
 * the in-memory rate-limit windows (and `redisConfigured()`, which reads env
 * at module load) belong to THIS instance. Deno.serve is captured, never
 * bound to a port. */
async function loadEdgeInstance(options: { redis: boolean }): Promise<EdgeInstance> {
  instanceCounter += 1;
  const tag = `stress-legal-${Date.now()}-${instanceCounter}`;
  const cacheSpecifier = new URL(`cache.ts?iso=${tag}`, API_DIR).href;

  const rateLimitSource = await Deno.readTextFile(new URL("rateLimit.ts", API_DIR));
  const rateLimitBlob = URL.createObjectURL(
    new Blob([rateLimitSource.replace('from "./cache.ts"', `from "${cacheSpecifier}"`)], {
      type: "application/typescript",
    }),
  );
  const indexSource = (await Deno.readTextFile(new URL("index.ts", API_DIR)))
    .replace('from "./cache.ts"', `from "${cacheSpecifier}"`)
    .replace('from "./rateLimit.ts"', `from "${rateLimitBlob}"`)
    .replace(
      /from "\.\/(\w+)\.ts"/g,
      (_match, name: string) => `from "${new URL(`${name}.ts`, API_DIR).href}"`,
    );
  assert(
    indexSource.includes(cacheSpecifier) && indexSource.includes(rateLimitBlob),
    "index.ts import rewrite failed — the cache/rateLimit import lines changed",
  );
  const indexBlob = URL.createObjectURL(
    new Blob([indexSource], { type: "application/typescript" }),
  );

  const previousEnv = {
    url: Deno.env.get("UPSTASH_REDIS_REST_URL"),
    token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN"),
  };
  for (const [key, value] of Object.entries({
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    REVENUECAT_WEBHOOK_AUTH: "stress-webhook-secret",
  })) {
    if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", FAKE_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", FAKE_REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  let captured: Handler | null = null;
  const realServe = Deno.serve;
  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as Handler | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    captured = fn;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;
  try {
    await import(indexBlob);
  } finally {
    Deno.serve = realServe;
    URL.revokeObjectURL(indexBlob);
    URL.revokeObjectURL(rateLimitBlob);
    if (previousEnv.url === undefined) Deno.env.delete("UPSTASH_REDIS_REST_URL");
    else Deno.env.set("UPSTASH_REDIS_REST_URL", previousEnv.url);
    if (previousEnv.token === undefined) Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
    else Deno.env.set("UPSTASH_REDIS_REST_TOKEN", previousEnv.token);
  }
  if (!captured) throw new Error("index.ts did not register a Deno.serve handler");
  return {
    name: `${options.redis ? "redis" : "mem"}#${instanceCounter}`,
    redis: options.redis,
    handler: captured,
  };
}

// ── Fake Upstash (async, seeded latency, injectable faults) ──────────────────

type Cmd = Array<string | number>;
type Fault = "ok" | "http500" | "reject" | "cmderr" | "truncate" | "hang";

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

class FakeRedis {
  store = new Map<string, RedisEntry>();
  pipelines = 0;
  commands: Cmd[] = [];
  faults: Record<Fault, number> = { ok: 0, http500: 0, reject: 0, cmderr: 0, truncate: 0, hang: 0 };
  /** Per-call scheduler hooks, set by the running iteration. */
  latencyMs: () => number = () => 0;
  faultFor: () => Fault = () => "ok";
  /** Real clock even while the test patches Date.now (TTL bookkeeping). */
  private readonly realNow: () => number;
  private readonly previousFetch: typeof fetch;

  constructor() {
    this.realNow = Date.now.bind(Date);
    this.previousFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(FAKE_REDIS_URL)) return this.previousFetch(input, init);
      return this.pipeline(String(init?.body ?? "[]"), init?.signal ?? null);
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.previousFetch;
  }

  resetForIteration(): void {
    this.store.clear();
    this.pipelines = 0;
    this.commands = [];
    this.faults = { ok: 0, http500: 0, reject: 0, cmderr: 0, truncate: 0, hang: 0 };
    this.latencyMs = () => 0;
    this.faultFor = () => "ok";
  }

  private live(key: string): RedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.realNow()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  private run(cmd: Cmd): { result?: unknown; error?: string } {
    const [name, ...args] = cmd.map(String);
    switch (name.toUpperCase()) {
      case "GET":
        return { result: this.live(args[0])?.value ?? null };
      case "INCR": {
        const entry = this.live(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.store.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
        return { result: next };
      }
      case "EXPIRE": {
        const [key, seconds, flag] = args;
        const entry = this.live(key);
        if (!entry) return { result: 0 };
        if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) return { result: 0 };
        entry.expiresAtMs = this.realNow() + Number(seconds) * 1_000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  }

  private async pipeline(body: string, signal: AbortSignal | null): Promise<Response> {
    this.pipelines += 1;
    const fault = this.faultFor();
    this.faults[fault] += 1;
    const latency = this.latencyMs();
    if (latency > 0) await sleep(latency);
    if (fault === "hang") {
      await new Promise<never>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (fault === "reject") throw new TypeError("connection reset");
    if (fault === "http500") return new Response("upstream error", { status: 500 });
    const commands = JSON.parse(body) as Cmd[];
    const results = commands.map((cmd) => {
      this.commands.push(cmd);
      // Upstash reports e.g. `ERR max requests limit exceeded` per command
      // with HTTP 200 — the counter is NOT incremented in that case.
      return fault === "cmderr" ? { error: "ERR max requests limit exceeded" } : this.run(cmd);
    });
    const reply = fault === "truncate" ? [] : results;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Requests ─────────────────────────────────────────────────────────────────

const DOCS = {
  support: SUPPORT_TEXT,
  privacy: PRIVACY_POLICY_TEXT,
  terms: TERMS_TEXT,
} as const;
type Doc = keyof typeof DOCS;
const DOC_NAMES: readonly Doc[] = ["support", "privacy", "terms"];
const MOUNTS = ["/functions/v1/api", "/api", "", "/functions/v1/api/v1/me"] as const;

let actorCounter = 0;
/** Unique per process (never collides with another iteration's window). */
function nextActorIp(): string {
  actorCounter += 1;
  const k = actorCounter;
  return `100.${64 + ((k >> 16) & 63)}.${(k >> 8) & 255}.${k & 255}`;
}

interface Lane {
  i: number;
  instance: EdgeInstance;
  ip: string;
  doc: Doc;
  method: "GET" | "HEAD";
  mount: string;
  ipHeader: "xff" | "xff-spoofed" | "cf";
  clientRequestId: string | null;
  abort: "none" | "sync" | "microtask";
  cancelBody: boolean;
  chain: boolean;
}

interface Row {
  i: number;
  instance: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  requestId: string | null;
  retryAfter: number | null;
  startedAt: number;
  endedAt: number;
  chained?: boolean;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

function buildRequest(
  lane: Lane,
  prng: Prng,
): { request: Request; controller: AbortController | null } {
  const headers = new Headers();
  if (lane.ipHeader === "cf") {
    headers.set("cf-connecting-ip", lane.ip);
    headers.set("x-forwarded-for", `198.51.100.${prng.int(1, 254)}`);
  } else if (lane.ipHeader === "xff-spoofed") {
    // Client-controlled leading hops vary on every request; the trusted
    // (last) hop is the actor — the budget must still be shared.
    headers.set("x-forwarded-for", `${prng.int(1, 254)}.${prng.int(0, 255)}.0.1, ${lane.ip}`);
  } else {
    headers.set("x-forwarded-for", lane.ip);
  }
  if (lane.clientRequestId) headers.set("x-request-id", lane.clientRequestId);
  const controller = lane.abort === "none" ? null : new AbortController();
  const request = new Request(`http://edge.test${lane.mount}/${lane.doc}`, {
    method: lane.method,
    headers,
    signal: controller?.signal,
  });
  return { request, controller };
}

interface Exec {
  rows: Row[];
  violations: string[];
  bodiesChecked: number;
  requestIds: string[];
}

const RETRY_AFTER_HEADER = "Retry-After";

async function execute(lane: Lane, prng: Prng, exec: Exec, chained = false): Promise<Response> {
  const { request, controller } = buildRequest(lane, prng);
  const startedAt = performance.now();
  const pending = lane.instance.handler(request);
  if (controller && lane.abort === "sync")
    controller.abort(new DOMException("client left", "AbortError"));
  if (controller && lane.abort === "microtask") {
    queueMicrotask(() => controller.abort(new DOMException("client left", "AbortError")));
  }
  let response: Response;
  try {
    response = await pending;
  } catch (error) {
    exec.violations.push(`lane ${lane.i}: handler rejected (${String(error)})`);
    exec.rows.push({
      i: lane.i,
      instance: lane.instance.name,
      ip: lane.ip,
      method: lane.method,
      path: `${lane.mount}/${lane.doc}`,
      status: -1,
      requestId: null,
      retryAfter: null,
      startedAt,
      endedAt: performance.now(),
      chained,
    });
    return new Response(null, { status: 599 });
  }
  const endedAt = performance.now();
  const requestId = response.headers.get("x-request-id");
  const retryAfterRaw = response.headers.get(RETRY_AFTER_HEADER);
  const retryAfter = retryAfterRaw === null ? null : Number(retryAfterRaw);
  exec.rows.push({
    i: lane.i,
    instance: lane.instance.name,
    ip: lane.ip,
    method: lane.method,
    path: `${lane.mount}/${lane.doc}`,
    status: response.status,
    requestId,
    retryAfter,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(endedAt * 100) / 100,
    chained,
  });
  if (requestId) exec.requestIds.push(requestId);

  const v = (cond: boolean, msg: string) => {
    if (!cond)
      exec.violations.push(`lane ${lane.i} ${lane.method} ${lane.mount}/${lane.doc}: ${msg}`);
  };
  v(
    requestId !== null && /^[A-Za-z0-9._-]{8,64}$/.test(requestId ?? ""),
    `x-request-id missing/malformed (${requestId})`,
  );
  if (lane.clientRequestId)
    v(requestId === lane.clientRequestId, `client request id not echoed (${requestId})`);

  if (response.status === 200) {
    v(
      response.headers.get("content-type") === "text/plain; charset=utf-8",
      `200 content-type ${response.headers.get("content-type")}`,
    );
    v(response.headers.get("x-content-type-options") === "nosniff", "200 missing nosniff");
    v(response.headers.get("referrer-policy") === "no-referrer", "200 referrer-policy");
    v(
      response.headers.get("cache-control") === "public, max-age=3600",
      `200 cache-control ${response.headers.get("cache-control")}`,
    );
    if (lane.cancelBody) {
      await response.body?.cancel();
    } else {
      const text = await response.text();
      // HEAD is answered by the same code path; the server strips the body on
      // the wire, in-process the document is still the one for this path.
      v(text === DOCS[lane.doc], `200 body is not the ${lane.doc} document (len ${text.length})`);
      exec.bodiesChecked += 1;
    }
  } else if (response.status === 429) {
    v(response.headers.get("content-type") === "application/json", "429 content-type");
    v(
      retryAfter !== null &&
        Number.isInteger(retryAfter) &&
        retryAfter >= 1 &&
        retryAfter <= WINDOW_SECONDS,
      `429 Retry-After ${retryAfterRaw}`,
    );
    v(
      response.headers.get("ratelimit-limit") === String(LIMIT),
      `429 RateLimit-Limit ${response.headers.get("ratelimit-limit")}`,
    );
    v(
      response.headers.get("ratelimit-remaining") === "0",
      `429 RateLimit-Remaining ${response.headers.get("ratelimit-remaining")}`,
    );
    v(response.headers.get("cache-control") === "no-store", "429 cache-control");
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    v(body?.error?.code === "rate_limited", `429 body code ${JSON.stringify(body)}`);
  } else {
    await response.body?.cancel();
    v(false, `unexpected status ${response.status}`);
  }
  if (lane.chain && !chained) {
    // call-during-call: the client fires a follow-up the moment its first
    // answer lands, while the rest of the burst is still in flight.
    await execute(
      { ...lane, clientRequestId: null, abort: "none", chain: false },
      prng,
      exec,
      true,
    );
  }
  return response;
}

// ── Families ─────────────────────────────────────────────────────────────────

const FAMILIES = [
  "mem_same_ip",
  "mem_multi_ip",
  "redis_two_instances",
  "redis_fail_open",
  "redis_hang",
  "clock_skew",
  "cancel_during_call",
] as const;
type Family = (typeof FAMILIES)[number];

const FAMILY_WEIGHTS: Record<Family, number> = {
  mem_same_ip: 24,
  mem_multi_ip: 16,
  redis_two_instances: 22,
  redis_fail_open: 14,
  redis_hang: 2,
  clock_skew: 11,
  cancel_during_call: 11,
};

function pickFamily(prng: Prng): Family {
  if (STRESS_FAMILY) {
    assert(
      (FAMILIES as readonly string[]).includes(STRESS_FAMILY),
      `unknown STRESS_FAMILY ${STRESS_FAMILY}`,
    );
    prng.next(); // keep the draw sequence identical to an unpinned run
    return STRESS_FAMILY as Family;
  }
  const total = Object.values(FAMILY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = prng.next() * total;
  for (const family of FAMILIES) {
    roll -= FAMILY_WEIGHTS[family];
    if (roll < 0) return family;
  }
  return FAMILIES[FAMILIES.length - 1];
}

interface IterationReport {
  iteration: number;
  seed: number;
  family: Family;
  inputs: Record<string, unknown>;
  requests: number;
  admitted: number;
  limited: number;
  statusHistogram: Record<string, number>;
  redis: {
    pipelines: number;
    commands: number;
    faults: Record<Fault, number>;
    finalCounters: Record<string, number>;
  } | null;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  violationsSample: string[];
  durationMs: number;
  outcome: "HELD" | "BROKEN";
  replay: string;
}

interface Ctx {
  mem: EdgeInstance;
  redisA: EdgeInstance;
  redisB: EdgeInstance;
  redis: FakeRedis;
}

function makeLanes(
  prng: Prng,
  count: number,
  actors: Array<{ ip: string; instance: EdgeInstance }>,
  opts: { abort?: boolean; cancelBody?: boolean; chainP?: number } = {},
): Lane[] {
  return Array.from({ length: count }, (_, i) => {
    const actor = actors[i % actors.length];
    return {
      i,
      instance: actor.instance,
      ip: actor.ip,
      doc: prng.pick(DOC_NAMES),
      method: prng.chance(0.25) ? "HEAD" : "GET",
      mount: prng.pick(MOUNTS),
      ipHeader: prng.chance(0.2) ? "cf" : prng.chance(0.3) ? "xff-spoofed" : "xff",
      clientRequestId: prng.chance(0.3) ? `stress-${prng.seed}-${i}` : null,
      abort: opts.abort ? (prng.chance(0.5) ? "sync" : "microtask") : "none",
      cancelBody: opts.cancelBody ? prng.chance(0.5) : false,
      chain: prng.chance(opts.chainP ?? 0),
    };
  });
}

function histogram(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

async function burst(lanes: Lane[], prng: Prng, exec: Exec): Promise<void> {
  const shuffled = prng.shuffle(lanes);
  await Promise.all(shuffled.map((lane) => execute(lane, prng, exec)));
}

function commonInvariants(
  exec: Exec,
  logLines: AccessLogEntry[],
  durationMs: number,
  budgetMs: number,
): Invariant[] {
  const rows = exec.rows;
  const out: Invariant[] = [];
  const fiveXx = rows.filter((r) => r.status >= 500 || r.status < 0);
  out.push({
    name: "no 5xx / no rejected handler call",
    holds: fiveXx.length === 0,
    detail: `bad=${fiveXx.length} of ${rows.length}`,
  });
  out.push({
    name: "every 200 is its document with legalTextResponse headers; every 429 has rateLimitResponse headers",
    holds: exec.violations.length === 0,
    detail:
      exec.violations.length === 0
        ? `bodiesChecked=${exec.bodiesChecked}`
        : exec.violations.slice(0, 3).join(" | "),
  });
  const minted = rows
    .filter((r) => r.requestId && !r.requestId.startsWith("stress-"))
    .map((r) => r.requestId as string);
  out.push({
    name: "minted x-request-id unique per response",
    holds: new Set(minted).size === minted.length,
    detail: `minted=${minted.length} distinct=${new Set(minted).size}`,
  });
  const logById = new Map<string, AccessLogEntry[]>();
  for (const line of logLines) {
    const list = logById.get(line.requestId) ?? [];
    list.push(line);
    logById.set(line.requestId, list);
  }
  let logMismatch = 0;
  for (const row of rows) {
    if (!row.requestId) {
      logMismatch += 1;
      continue;
    }
    const lines = logById.get(row.requestId) ?? [];
    const match = lines.find(
      (l) => l.status === row.status && l.method === row.method && l.evt === "api_request",
    );
    if (!match) logMismatch += 1;
  }
  out.push({
    name: "exactly one access-log line per request (id/method/status match)",
    holds: logLines.length === rows.length && logMismatch === 0,
    detail: `lines=${logLines.length} rows=${rows.length} unmatched=${logMismatch}`,
  });
  out.push({
    name: "bounded wall time (no deadlock)",
    holds: durationMs <= budgetMs,
    detail: `${durationMs}ms ≤ ${budgetMs}ms`,
  });
  return out;
}

const admittedOf = (rows: Row[]) => rows.filter((r) => r.status === 200).length;
const limitedOf = (rows: Row[]) => rows.filter((r) => r.status === 429).length;
const expectExact = (perKey: number[]) => perKey.reduce((sum, n) => sum + Math.min(n, LIMIT), 0);

async function runIteration(ctx: Ctx, iteration: number, seed: number): Promise<IterationReport> {
  const prng = new Prng(seed);
  const family = pickFamily(prng);
  ctx.redis.resetForIteration();
  const exec: Exec = { rows: [], violations: [], bodiesChecked: 0, requestIds: [] };
  const logLines: AccessLogEntry[] = [];
  const restoreLog = captureAccessLog((line) => logLines.push(JSON.parse(line) as AccessLogEntry));
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const invariants: Invariant[] = [];
  let budgetMs = STRESS_BURST_BUDGET_MS;
  const realDateNow = Date.now;
  const t0 = performance.now();
  try {
    switch (family) {
      case "mem_same_ip": {
        const k = prng.int(LIMIT + 1, 160);
        const chainP = prng.chance(0.5) ? 0.15 : 0;
        const actor = { ip: nextActorIp(), instance: ctx.mem };
        Object.assign(inputs, { k, chainP, ip: actor.ip });
        await burst(makeLanes(prng, k, [actor], { chainP }), prng, exec);
        const total = exec.rows.length;
        invariants.push({
          name: "shared legal budget: exactly 60 admitted across support/privacy/terms, GET+HEAD, all mounts, spoofed hops, follow-ups",
          holds: admittedOf(exec.rows) === LIMIT && limitedOf(exec.rows) === total - LIMIT,
          detail: `requests=${total} admitted=${admittedOf(exec.rows)} 429=${limitedOf(exec.rows)}`,
        });
        break;
      }
      case "mem_multi_ip": {
        const actorCount = prng.int(2, 5);
        const actors = Array.from({ length: actorCount }, () => ({
          ip: nextActorIp(),
          instance: ctx.mem,
        }));
        const perActor = actors.map(() =>
          prng.chance(0.5) ? prng.int(LIMIT + 1, 90) : prng.int(1, LIMIT),
        );
        const lanes: Lane[] = [];
        actors.forEach((actor, a) => {
          for (const lane of makeLanes(prng, perActor[a], [actor]))
            lanes.push({ ...lane, i: lanes.length });
        });
        Object.assign(inputs, { actors: actors.map((a) => a.ip), perActor });
        await burst(lanes, prng, exec);
        let holds = true;
        const detail: string[] = [];
        actors.forEach((actor, a) => {
          const mine = exec.rows.filter((r) => r.ip === actor.ip);
          const ok =
            admittedOf(mine) === Math.min(perActor[a], LIMIT) &&
            limitedOf(mine) === perActor[a] - Math.min(perActor[a], LIMIT);
          holds &&= ok;
          detail.push(`${actor.ip}:${perActor[a]}→${admittedOf(mine)}/${limitedOf(mine)}`);
        });
        invariants.push({
          name: "per-IP isolation: each IP admitted exactly min(n,60), no cross-IP bleed",
          holds,
          detail: detail.join(" "),
        });
        break;
      }
      case "redis_two_instances": {
        const k = prng.int(LIMIT + 1, 160);
        const maxLatency = prng.int(0, 10);
        const chainP = prng.chance(0.5) ? 0.15 : 0;
        const ip = nextActorIp();
        ctx.redis.latencyMs = () => prng.int(0, maxLatency);
        const lanes = makeLanes(
          prng,
          k,
          [
            { ip, instance: ctx.redisA },
            { ip, instance: ctx.redisB },
          ],
          { chainP },
        );
        Object.assign(inputs, {
          k,
          maxLatencyMs: maxLatency,
          chainP,
          ip,
          instances: [ctx.redisA.name, ctx.redisB.name],
        });
        await burst(lanes, prng, exec);
        const total = exec.rows.length;
        const counters = [...ctx.redis.store.entries()].filter(([key]) =>
          key.startsWith("rl:legal:"),
        );
        const counterSum = counters.reduce((sum, [, e]) => sum + Number(e.value), 0);
        const buckets = counters.length;
        invariants.push({
          name: "cross-instance budget: exactly 60 admitted per window across two edge instances",
          holds:
            admittedOf(exec.rows) === expectExact(counters.map(([, e]) => Number(e.value))) &&
            limitedOf(exec.rows) === total - admittedOf(exec.rows) &&
            buckets >= 1 &&
            buckets <= 2,
          detail: `requests=${total} admitted=${admittedOf(exec.rows)} 429=${limitedOf(exec.rows)} windowKeys=${buckets}`,
        });
        invariants.push({
          name: "no double spend: Redis counter == requests, one [INCR, EXPIRE NX] pipeline per request",
          holds:
            counterSum === total &&
            ctx.redis.pipelines === total &&
            ctx.redis.commands.length === 2 * total,
          detail: `counter=${counterSum} pipelines=${ctx.redis.pipelines} commands=${ctx.redis.commands.length}`,
        });
        const ttlOk = counters.every(
          ([, e]) =>
            e.expiresAtMs !== null && e.expiresAtMs - realDateNow() <= WINDOW_SECONDS * 1_000 + 50,
        );
        invariants.push({
          name: "window key carries a TTL ≤ 60 s (no leaked counter)",
          holds: ttlOk && buckets > 0,
          detail: counters
            .map(
              ([k2, e]) =>
                `${k2}:ttl=${e.expiresAtMs === null ? "none" : Math.round((e.expiresAtMs - realDateNow()) / 1000)}s`,
            )
            .join(" "),
        });
        break;
      }
      case "redis_fail_open": {
        const k = prng.int(LIMIT + 1, 160);
        const maxLatency = prng.int(0, 6);
        const ip = nextActorIp();
        const pFault = prng.pick([0.1, 0.3, 0.6]);
        ctx.redis.latencyMs = () => prng.int(0, maxLatency);
        ctx.redis.faultFor = () =>
          prng.chance(pFault)
            ? prng.pick(["http500", "reject", "cmderr", "truncate"] as Fault[])
            : "ok";
        const twoInstances = prng.chance(0.5);
        const actors = twoInstances
          ? [
              { ip, instance: ctx.redisA },
              { ip, instance: ctx.redisB },
            ]
          : [{ ip, instance: ctx.redisA }];
        Object.assign(inputs, {
          k,
          maxLatencyMs: maxLatency,
          pFault,
          ip,
          instances: actors.map((a) => a.instance.name),
        });
        await burst(makeLanes(prng, k, actors), prng, exec);
        const total = exec.rows.length;
        const admitted = admittedOf(exec.rows);
        const upper = LIMIT * (1 + actors.length);
        invariants.push({
          name: "fail-open bounds: min(K,60) ≤ admitted ≤ 60·(1+instances), rest 429",
          holds:
            admitted >= Math.min(total, LIMIT) &&
            admitted <= upper &&
            admitted + limitedOf(exec.rows) === total,
          detail: `requests=${total} admitted=${admitted} 429=${limitedOf(exec.rows)} upper=${upper} faults=${JSON.stringify(ctx.redis.faults)}`,
        });
        const redisOnly = ctx.redis.faults.ok + ctx.redis.faults.truncate;
        const counterSum = [...ctx.redis.store.entries()]
          .filter(([key]) => key.startsWith("rl:legal:"))
          .reduce((sum, [, e]) => sum + Number(e.value), 0);
        invariants.push({
          name: "no double spend: exactly one pipeline per request; Redis counter == executed INCRs",
          holds: ctx.redis.pipelines === total && counterSum === redisOnly,
          detail: `pipelines=${ctx.redis.pipelines} counter=${counterSum} executedIncr=${redisOnly}`,
        });
        break;
      }
      case "redis_hang": {
        const k = prng.int(LIMIT + 1, 100);
        const ip = nextActorIp();
        ctx.redis.faultFor = () => "hang";
        const actors = [
          { ip, instance: ctx.redisA },
          { ip, instance: ctx.redisB },
        ];
        const lanes = makeLanes(prng, k, actors);
        const perInstance = actors.map(
          (a) => lanes.filter((l) => l.instance === a.instance).length,
        );
        Object.assign(inputs, { k, ip, perInstance });
        budgetMs = STRESS_BURST_BUDGET_MS + REDIS_TIMEOUT_MS;
        await burst(lanes, prng, exec);
        const total = exec.rows.length;
        invariants.push({
          name: "Redis hang: every call falls back to memory after the 1.2 s timeout; each instance admits exactly min(n,60)",
          holds:
            admittedOf(exec.rows) === expectExact(perInstance) &&
            limitedOf(exec.rows) === total - expectExact(perInstance),
          detail: `requests=${total} admitted=${admittedOf(exec.rows)} expected=${expectExact(perInstance)} hangs=${ctx.redis.faults.hang}`,
        });
        const slowest = Math.max(...exec.rows.map((r) => r.endedAt - r.startedAt));
        invariants.push({
          name: "hung Redis is abandoned at REDIS_TIMEOUT_MS (no unbounded wait)",
          holds: slowest >= REDIS_TIMEOUT_MS - 50 && slowest <= REDIS_TIMEOUT_MS + 1_000,
          detail: `slowest=${Math.round(slowest)}ms`,
        });
        break;
      }
      case "clock_skew": {
        // Fully virtual clock: buckets are exact, real time never drifts in.
        const k = prng.int(LIMIT + 1, 150);
        const baseMs = realDateNow();
        const jumpMs = prng.pick([61_000, 30_000, -61_000, 120_000]);
        const flipAtRequest = prng.int(1, k - 1);
        // One memory-path request performs exactly 3 Date.now() reads
        // (windowKey, memoryIncr, toResult) synchronously; the flip lands on
        // a request boundary and the alignment is verified below.
        const flipAtCall = flipAtRequest * 3;
        let calls = 0;
        Date.now = () => {
          calls += 1;
          return baseMs + (calls > flipAtCall ? jumpMs : 0);
        };
        const actor = { ip: nextActorIp(), instance: ctx.mem };
        Object.assign(inputs, { k, jumpMs, flipAtRequest, baseMs, ip: actor.ip });
        await burst(makeLanes(prng, k, [actor]), prng, exec);
        Date.now = realDateNow;
        const bucket = (ms: number) => Math.floor(ms / (WINDOW_SECONDS * 1_000));
        const sameBucket = bucket(baseMs) === bucket(baseMs + jumpMs);
        const expected = sameBucket
          ? Math.min(k, LIMIT)
          : Math.min(flipAtRequest, LIMIT) + Math.min(k - flipAtRequest, LIMIT);
        observations.dateNowCalls = calls;
        observations.sameBucket = sameBucket;
        invariants.push({
          name: "clock skew: each virtual window admits exactly min(n,60); a jump never resets or leaks the current window",
          holds:
            calls === 3 * k &&
            admittedOf(exec.rows) === expected &&
            limitedOf(exec.rows) === k - expected,
          detail: `k=${k} jump=${jumpMs}ms flipAt=${flipAtRequest} sameBucket=${sameBucket} admitted=${admittedOf(exec.rows)} expected=${expected} dateNowCalls=${calls}/${3 * k}`,
        });
        break;
      }
      case "cancel_during_call": {
        const k = prng.int(LIMIT + 1, 140);
        const ip = nextActorIp();
        const viaRedis = prng.chance(0.5);
        const actor = { ip, instance: viaRedis ? ctx.redisA : ctx.mem };
        if (viaRedis) ctx.redis.latencyMs = () => prng.int(0, 5);
        Object.assign(inputs, { k, ip, instance: actor.instance.name });
        const lanes = makeLanes(prng, k, [actor], { abort: true, cancelBody: true });
        // roughly half the lanes abort; the rest are normal callers
        for (const lane of lanes) if (prng.chance(0.5)) lane.abort = "none";
        observations.aborted = lanes.filter((l) => l.abort !== "none").length;
        observations.bodiesCancelled = lanes.filter((l) => l.cancelBody).length;
        await burst(lanes, prng, exec);
        invariants.push({
          name: "cancel-during-call: aborted signals and cancelled bodies never lose a response or a charge — exactly 60 admitted",
          holds:
            admittedOf(exec.rows) === LIMIT &&
            limitedOf(exec.rows) === k - LIMIT &&
            exec.rows.every((r) => r.status > 0),
          detail: `k=${k} aborted=${observations.aborted} admitted=${admittedOf(exec.rows)} 429=${limitedOf(exec.rows)}`,
        });
        break;
      }
    }
  } finally {
    Date.now = realDateNow;
    restoreLog();
  }
  const durationMs = Math.round(performance.now() - t0);
  invariants.push(...commonInvariants(exec, logLines, durationMs, budgetMs));
  const outcome = invariants.every((inv) => inv.holds) ? "HELD" : "BROKEN";
  const finalCounters: Record<string, number> = {};
  for (const [key, entry] of ctx.redis.store)
    if (key.startsWith("rl:")) finalCounters[key] = Number(entry.value);
  return {
    iteration,
    seed,
    family,
    inputs,
    requests: exec.rows.length,
    admitted: admittedOf(exec.rows),
    limited: limitedOf(exec.rows),
    statusHistogram: histogram(exec.rows.map((r) => `${r.method}:${r.status}`)),
    redis:
      family.startsWith("redis") || inputs.instance === ctx.redisA.name
        ? {
            pipelines: ctx.redis.pipelines,
            commands: ctx.redis.commands.length,
            faults: { ...ctx.redis.faults },
            finalCounters,
          }
        : null,
    invariants,
    observations,
    violationsSample: exec.violations.slice(0, 10),
    durationMs,
    outcome,
    replay: `cd supabase/functions/api/__wf__ && STRESS_SEED=${seed} STRESS_ITER=1 deno test -A --no-check --config deno.json stress_legal_concurrency.test.ts`,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-legal-concurrency/latest/", import.meta.url)
    .pathname;
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: `stress legal concurrency: ${STRESS_ITER} seeded bursts (base seed ${STRESS_SEED}) — every invariant HELD`,
  // Redis-timeout AbortSignals and the fake's latency timers outlive a single
  // iteration only in the hang family; both are awaited before the test ends,
  // but the AbortSignal.timeout timers created by cache.ts are not ours to
  // clear.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const redis = new FakeRedis();
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const reports: IterationReport[] = [];
    const campaignStart = performance.now();
    try {
      const ctx: Ctx = {
        mem: await loadEdgeInstance({ redis: false }),
        redisA: await loadEdgeInstance({ redis: true }),
        redisB: await loadEdgeInstance({ redis: true }),
        redis,
      };
      for (let i = 0; i < STRESS_ITER; i++) {
        const seed = (STRESS_SEED + i) >>> 0;
        const report = await runIteration(ctx, i, seed);
        reports.push(report);
        if (report.outcome === "BROKEN") {
          console.log(`[stress-legal] BROKEN seed=${seed} family=${report.family}`);
          for (const inv of report.invariants.filter((x) => !x.holds))
            console.log(`[stress-legal]   ${inv.name} — ${inv.detail}`);
        }
      }
    } finally {
      redis.restore();
    }
    const campaignMs = Math.round(performance.now() - campaignStart);
    const failed = reports.filter((r) => r.outcome === "BROKEN");
    const summary = {
      generatedAt: new Date().toISOString(),
      deno: Deno.version,
      env: { STRESS_ITER, STRESS_SEED, STRESS_FAMILY, STRESS_BURST_BUDGET_MS },
      iterations: reports.length,
      requests: reports.reduce((sum, r) => sum + r.requests, 0),
      admitted: reports.reduce((sum, r) => sum + r.admitted, 0),
      limited: reports.reduce((sum, r) => sum + r.limited, 0),
      families: histogram(reports.map((r) => r.family)),
      outcomes: histogram(reports.map((r) => `${r.family}:${r.outcome}`)),
      invariantsChecked: reports.reduce((sum, r) => sum + r.invariants.length, 0),
      invariantsBroken: reports.reduce(
        (sum, r) => sum + r.invariants.filter((i) => !i.holds).length,
        0,
      ),
      slowestIterationMs: Math.max(0, ...reports.map((r) => r.durationMs)),
      campaignMs,
      seedsFailed: failed.map((r) => ({
        seed: r.seed,
        family: r.family,
        broken: r.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`),
        replay: r.replay,
      })),
      seedTable: reports.map((r) => ({
        seed: r.seed,
        family: r.family,
        requests: r.requests,
        admitted: r.admitted,
        limited: r.limited,
        outcome: r.outcome,
        durationMs: r.durationMs,
      })),
    };
    await Deno.writeTextFile(`${dir}iterations.json`, JSON.stringify(reports, null, 2));
    await Deno.writeTextFile(`${dir}summary.json`, JSON.stringify(summary, null, 2));
    console.log(
      `[stress-legal] ${reports.length} iterations / ${summary.requests} requests in ${campaignMs}ms → ${dir}summary.json`,
    );
    console.log(`[stress-legal] families ${JSON.stringify(summary.families)}`);
    assert(reports.length === STRESS_ITER, `ran ${reports.length} of ${STRESS_ITER} iterations`);
    assert(
      failed.length === 0,
      `${failed.length} BROKEN iteration(s): ${failed
        .map(
          (r) =>
            `seed=${r.seed} ${r.family} [${r.invariants
              .filter((i) => !i.holds)
              .map((i) => i.name)
              .join("; ")}]`,
        )
        .join(" · ")} — replay: ${failed[0]?.replay}`,
    );
  },
});

// Memory-fallback eviction: rateLimit.ts caps the per-isolate window map at
// MEMORY_WINDOW_MAX = 20_000 live keys and, when every key is still live,
// CLEARS the whole map (rateLimit.ts:33-38). The header contract of the
// module ("at most 60 requests inside each clock minute per key", "still
// stops any single runaway client") must survive 20_000 distinct identities
// hitting the isolate inside one window.
Deno.test({
  name: "stress legal: 20 000 distinct client identities in one window must not reset a runaway client's legal budget (memory fallback)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const instance = await loadEdgeInstance({ redis: false });
    const runaway = "100.127.255.254";
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const get = async (ip: string): Promise<number> => {
      const response = await instance.handler(
        new Request("http://edge.test/functions/v1/api/terms", {
          headers: { "x-forwarded-for": ip },
        }),
      );
      await response.body?.cancel();
      return response.status;
    };
    const restoreLog = captureAccessLog(() => {});
    const t0 = performance.now();
    let phase1Admitted = 0;
    let crowdAdmitted = 0;
    let phase2Admitted = 0;
    try {
      // Phase 1: the runaway client spends half its budget.
      const phase1 = await Promise.all(Array.from({ length: 30 }, () => get(runaway)));
      phase1Admitted = phase1.filter((s) => s === 200).length;
      // Crowd: MEMORY_WINDOW_MAX distinct identities, one request each, in
      // bursts of 500 — every key is live, none can be evicted as expired.
      for (let start = 0; start < MEMORY_WINDOW_MAX; start += 500) {
        const statuses = await Promise.all(
          Array.from({ length: 500 }, (_, j) => {
            const k = start + j;
            return get(`10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`);
          }),
        );
        crowdAdmitted += statuses.filter((s) => s === 200).length;
      }
      // Phase 2: the runaway client bursts again inside the same window.
      const phase2 = await Promise.all(Array.from({ length: 60 }, () => get(runaway)));
      phase2Admitted = phase2.filter((s) => s === 200).length;
    } finally {
      restoreLog();
    }
    const durationMs = Math.round(performance.now() - t0);
    const total = phase1Admitted + phase2Admitted;
    const report = {
      scenario: "mem_eviction_20k_identities",
      seed: null,
      inputs: {
        runaway,
        phase1Requests: 30,
        crowdIdentities: MEMORY_WINDOW_MAX,
        phase2Requests: 60,
      },
      observed: { phase1Admitted, crowdAdmitted, phase2Admitted, runawayAdmittedTotal: total },
      expected: { runawayAdmittedTotal: LIMIT, crowdAdmitted: MEMORY_WINDOW_MAX },
      outcome: total === LIMIT && crowdAdmitted === MEMORY_WINDOW_MAX ? "HELD" : "BROKEN",
      durationMs,
      replay:
        "cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json --filter '20 000 distinct' stress_legal_concurrency.test.ts",
    };
    await Deno.writeTextFile(`${dir}mem_eviction.json`, JSON.stringify(report, null, 2));
    console.log(
      `[stress-legal] mem_eviction: ${JSON.stringify(report.observed)} in ${durationMs}ms → ${dir}mem_eviction.json`,
    );
    assertEquals(
      crowdAdmitted,
      MEMORY_WINDOW_MAX,
      "every distinct identity's first request is within its own budget",
    );
    assertEquals(
      total,
      LIMIT,
      `runaway client admitted ${total} of 90 requests inside one window (limit 60): ` +
        `the 20 000-key eviction in rateLimit.ts memoryIncr() cleared its live window`,
    );
  },
});
