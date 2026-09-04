// Shared helpers for the `stress_ratelimit_*.test.ts` campaigns — a SEEDED
// concurrency stress harness for supabase/functions/api/rateLimit.ts.
//
// Everything here is deterministic given a seed: the iteration parameters,
// the scheduler jitter that interleaves Promise.all bursts, and the fake
// Upstash's request/response latency and fault injection. Every iteration
// writes one row to a JSON table (seed → outcome) and carries the exact
// command that replays it alone.
//
// Knobs (all optional):
//   STRESS_ITER      iterations per campaign (default 40 — fast enough for the suite)
//   STRESS_SEED      base seed; iteration i runs with seed STRESS_SEED + i
//   STRESS_KEYS      distinct keys for the memory-cardinality campaign (default 100_000)
//   STRESS_STRICT    1 = also assert known-defect invariants (suite default 0: observe only)
//   STRESS_OUT_DIR   where the JSON tables go (default artifacts/stress-edge-ratelimit/latest/)
//
// Nothing here contacts a network: Redis is `SeededUpstash` (in-process fetch
// interceptor), Supabase/RevenueCat are the xc FakeSupabase model.

import { FAKE_REDIS_URL, configureRedis } from "./harness.ts";
import { Prng, envInt } from "./xc_concurrency_harness.ts";

export { Prng, configureRedis, envInt };

export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_KEYS = envInt("STRESS_KEYS", 100_000);
export const STRESS_STRICT = envInt("STRESS_STRICT", 0) === 1;

export function iterationSeed(i: number): number {
  return (STRESS_SEED + i) >>> 0;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded wall time: a hung promise is a BROKEN outcome, never a hung suite. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline ${ms}ms exceeded: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Seeded fake Upstash ──────────────────────────────────────────────────────

type Cmd = Array<string | number>;
type PipelineResult = Array<{ result?: unknown; error?: string }>;

export interface UpstashFaults {
  /** Seeded latency (ms) BEFORE the pipeline executes — reorders INCRs across callers. */
  requestLatencyMaxMs: number;
  /** Seeded latency (ms) AFTER execution, before the reply is visible. */
  responseLatencyMaxMs: number;
  /** Probability [0,1] that a pipeline call answers HTTP 503 (whole call fails). */
  httpFailP: number;
  /** Probability [0,1] that a pipeline call hangs until the caller's 1.2s AbortSignal fires. */
  hangP: number;
  /** Probability [0,1] that a pipeline call answers every command with `{ error }` (HTTP 200). */
  commandErrorP: number;
  /** Probability [0,1] that the reply is truncated to zero results (short reply). */
  shortReplyP: number;
  /** When true, only EXPIRE commands error (INCR succeeds) — models a partial pipeline failure. */
  expireOnlyError: boolean;
}

export const HEALTHY: UpstashFaults = {
  requestLatencyMaxMs: 0,
  responseLatencyMaxMs: 0,
  httpFailP: 0,
  hangP: 0,
  commandErrorP: 0,
  shortReplyP: 0,
  expireOnlyError: false,
};

export interface SeededUpstash {
  store: Map<string, { value: string; expiresAtMs: number | null }>;
  faults: UpstashFaults;
  calls: number;
  httpFailures: number;
  hangs: number;
  commandErrors: number;
  shortReplies: number;
  commands: Cmd[];
  /** Clock used for TTL bookkeeping (overridable for skew campaigns). */
  now: () => number;
  restore(): void;
}

function live(
  store: SeededUpstash["store"],
  key: string,
  now: number,
): { value: string; expiresAtMs: number | null } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
    store.delete(key);
    return null;
  }
  return entry;
}

function runCommand(fake: SeededUpstash, cmd: Cmd): { result?: unknown; error?: string } {
  const [name, ...args] = cmd.map(String);
  const now = fake.now();
  switch (name.toUpperCase()) {
    case "GET":
      return { result: live(fake.store, args[0], now)?.value ?? null };
    case "TTL": {
      const entry = live(fake.store, args[0], now);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return { result: Math.max(0, Math.ceil((entry.expiresAtMs - now) / 1000)) };
    }
    case "SET": {
      const [key, value, ...rest] = args;
      const exIdx = rest.findIndex((r) => r.toUpperCase() === "EX");
      const ttl = exIdx >= 0 ? Number(rest[exIdx + 1]) : NaN;
      fake.store.set(key, {
        value,
        expiresAtMs: Number.isFinite(ttl) ? now + ttl * 1000 : null,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (fake.store.delete(key)) n += 1;
      return { result: n };
    }
    case "INCR": {
      const entry = live(fake.store, args[0], now);
      const next = (entry ? Number(entry.value) : 0) + 1;
      fake.store.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, ...flags] = args;
      const entry = live(fake.store, key, now);
      if (!entry) return { result: 0 };
      const nx = flags.some((f) => f.toUpperCase() === "NX");
      if (nx && entry.expiresAtMs !== null) return { result: 0 };
      entry.expiresAtMs = now + Number(seconds) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

/** Installs a fetch interceptor for FAKE_REDIS_URL whose latency and faults
 * are drawn from `prng` — replaying the seed replays the interleaving. Other
 * URLs fall through to whatever fetch was installed before (FakeSupabase). */
export function seededUpstash(prng: Prng, faults: UpstashFaults = HEALTHY): SeededUpstash {
  const original = globalThis.fetch;
  const fake: SeededUpstash = {
    store: new Map(),
    faults: { ...faults },
    calls: 0,
    httpFailures: 0,
    hangs: 0,
    commandErrors: 0,
    shortReplies: 0,
    commands: [],
    now: () => Date.now(),
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE_REDIS_URL)) return original(input, init);
    fake.calls += 1;
    const f = fake.faults;
    // Draw every random decision up front so the decision sequence per call
    // is stable regardless of how the awaits below interleave.
    const hang = prng.next() < f.hangP;
    const httpFail = prng.next() < f.httpFailP;
    const cmdErr = prng.next() < f.commandErrorP;
    const short = prng.next() < f.shortReplyP;
    const reqLatency = f.requestLatencyMaxMs > 0 ? prng.int(0, f.requestLatencyMaxMs) : 0;
    const respLatency = f.responseLatencyMaxMs > 0 ? prng.int(0, f.responseLatencyMaxMs) : 0;
    if (hang) {
      fake.hangs += 1;
      await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (reqLatency > 0) await sleep(reqLatency);
    if (httpFail) {
      fake.httpFailures += 1;
      return new Response("upstream error", { status: 503 });
    }
    const commands = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
    const results: PipelineResult = [];
    for (const cmd of commands) {
      fake.commands.push(cmd);
      const isExpire = String(cmd[0]).toUpperCase() === "EXPIRE";
      if (cmdErr || (f.expireOnlyError && isExpire)) {
        fake.commandErrors += 1;
        results.push({ error: "ERR max requests limit exceeded" });
      } else {
        results.push(runCommand(fake, cmd));
      }
    }
    if (respLatency > 0) await sleep(respLatency);
    if (short) {
      fake.shortReplies += 1;
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return fake;
}

// ── Outcome table ────────────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export function inv(list: Invariant[], name: string, holds: boolean, detail = ""): void {
  list.push({ name, holds, detail });
}

export interface OutcomeRow {
  campaign: string;
  iteration: number;
  seed: number;
  params: Record<string, unknown>;
  outcome: "HELD" | "BROKEN";
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
  error?: string;
}

export interface CampaignTable {
  campaign: string;
  file: string;
  generatedAt: string;
  deno: string;
  env: { STRESS_ITER: number; STRESS_SEED: number; STRESS_KEYS: number; STRESS_STRICT: boolean };
  iterations: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  totals: Record<string, number>;
  durationMs: number;
  rows: OutcomeRow[];
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-edge-ratelimit/latest/", import.meta.url).pathname;
}

export function replayCommand(file: string, filter: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

/** Runs `iterations` seeded iterations of `body`, collecting one OutcomeRow
 * each. A thrown error (including a deadline) is a BROKEN row, not a crash of
 * the campaign, so the table is complete even when a seed misbehaves. */
export async function runCampaign(
  file: string,
  campaign: string,
  filter: string,
  iterations: number,
  body: (ctx: {
    seed: number;
    iteration: number;
    prng: Prng;
    params: Record<string, unknown>;
    observations: Record<string, unknown>;
    invariants: Invariant[];
  }) => Promise<void>,
  options: { deadlineMs?: number; totalsFrom?: (row: OutcomeRow) => Record<string, number> } = {},
): Promise<CampaignTable> {
  const rows: OutcomeRow[] = [];
  const totals: Record<string, number> = {};
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const seed = iterationSeed(i);
    const prng = new Prng(seed);
    const params: Record<string, unknown> = {};
    const observations: Record<string, unknown> = {};
    const invariants: Invariant[] = [];
    const t0 = performance.now();
    let error: string | undefined;
    try {
      await withDeadline(
        body({ seed, iteration: i, prng, params, observations, invariants }),
        options.deadlineMs ?? 20_000,
        `${campaign} seed=${seed}`,
      );
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      inv(invariants, "iteration completes without throwing", false, error);
    }
    const row: OutcomeRow = {
      campaign,
      iteration: i,
      seed,
      params,
      outcome: invariants.every((x) => x.holds) ? "HELD" : "BROKEN",
      invariants,
      observations,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      replay: replayCommand(file, filter, seed),
      ...(error ? { error } : {}),
    };
    rows.push(row);
    if (options.totalsFrom) {
      for (const [k, v] of Object.entries(options.totalsFrom(row))) {
        totals[k] = (totals[k] ?? 0) + v;
      }
    }
  }
  const table: CampaignTable = {
    campaign,
    file,
    generatedAt: new Date().toISOString(),
    deno: Deno.version.deno,
    env: { STRESS_ITER, STRESS_SEED, STRESS_KEYS, STRESS_STRICT },
    iterations: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    brokenSeeds: rows.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
    totals,
    durationMs: Math.round(performance.now() - started),
    rows,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}${campaign}.json`, JSON.stringify(table, null, 2));
  return table;
}

/** Fails the Deno test with every broken invariant listed (seed + replay). */
export function assertTableHeld(table: CampaignTable): void {
  if (table.broken === 0) return;
  const lines = table.rows
    .filter((r) => r.outcome === "BROKEN")
    .slice(0, 10)
    .map(
      (r) =>
        `seed=${r.seed}: ${r.invariants
          .filter((x) => !x.holds)
          .map((x) => `${x.name} (${x.detail})`)
          .join("; ")}\n  replay: ${r.replay}`,
    );
  throw new Error(
    `${table.campaign}: ${table.broken}/${table.iterations} iterations BROKEN\n${lines.join("\n")}`,
  );
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function pickWeighted<T>(prng: Prng, entries: Array<[T, number]>): T {
  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  let roll = prng.next() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** Unique IPv4 per call — the edge fn's in-memory windows outlive every
 * iteration in this process, so each burst gets its own identity. */
let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  const n = ipCounter;
  return `10.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

export function heapNow(): { heapUsed: number; rss: number } {
  const m = Deno.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss };
}
