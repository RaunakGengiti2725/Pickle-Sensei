// Edge Function per-route round-trip + latency benchmark.
//
//   deno run -A --v8-flags=--expose-gc perf_edge_latency_bench.ts \
//     --redis off|on --latency zero|simulated --requests 1000 \
//     [--concurrency N] [--seed S] [--scenario id[,id…]|all] [--out file.json]
//
// One process = one Redis setting (cache.ts reads the Upstash env at import).
// For every scenario: prime auth (and the route cache when asked), then run
// `requests` measured requests through the REAL handler, attributing every
// upstream call to its request (AsyncLocalStorage), and report p50/p95/p99
// latency, per-class round trips, payload bytes, statuses, heap deltas and a
// replayable record of every unexpected status.
//
// "hot round trips" = Supabase Auth + PostgREST + RevenueCat calls on the
// request; Redis is reported separately (it is the cache, not the thing the
// cache protects). The assignment's threshold (>3 on the hot path) is
// evaluated on the MEDIAN request of each scenario.

import { parseArgs } from "node:util";
import {
  bootPerfHarness,
  buildRequest,
  callContext,
  SIMULATED_LATENCY,
  userIdFor,
  ZERO_LATENCY,
  type LatencyProfile,
  type PerfHarness,
  type RecordedCall,
  type RequestSpec,
  type UpstreamClass,
} from "./perfHarness.ts";
import {
  ipFor,
  SCENARIOS,
  tokenFor,
  type Scenario,
  type ScenarioContext,
} from "./perfScenarios.ts";

const CLASSES: UpstreamClass[] = ["supabase_auth", "supabase_rest", "revenuecat", "redis", "other"];
const HOT_CLASSES: UpstreamClass[] = ["supabase_auth", "supabase_rest", "revenuecat"];

export interface Distribution {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface FailureRecord {
  index: number;
  userIndex: number;
  userId: string;
  status: number;
  expected: number[];
  request: { method: string; path: string; body?: unknown; bodyBytes: number };
  responseBody: string;
  calls: string[];
}

export interface ScenarioResult {
  id: string;
  route: string;
  variant: string;
  hotPath: boolean;
  notes?: string;
  users: number | "unique";
  requests: number;
  warmRequests: number;
  concurrency: number;
  wallMs: number;
  throughputRps: number;
  statuses: Record<string, number>;
  failureCount: number;
  failures: FailureRecord[];
  latencyMs: Distribution;
  roundTrips: {
    hot: Distribution;
    total: Distribution;
    byClass: Record<UpstreamClass, Distribution>;
    /** Upstream labels with average count per request (sum / requests). */
    labels: Record<string, { perRequest: number; total: number }>;
  };
  bytes: {
    request: Distribution;
    response: Distribution;
    upstreamRequest: Distribution;
    upstreamResponse: Distribution;
  };
  heap: {
    beforeHeapUsed: number;
    afterHeapUsed: number;
    deltaHeapUsed: number;
    rssBefore: number;
    rssAfter: number;
    gcForced: boolean;
  };
  consoleLines: { error: number; warn: number; log: number };
  /** Median hot round trips > 3 (assignment threshold). */
  exceedsThreshold: boolean;
}

export interface BenchOutput {
  meta: {
    tool: string;
    seed: string;
    redis: boolean;
    latencyMode: "zero" | "simulated";
    latencyMs: LatencyProfile;
    requestsPerScenario: number;
    heavyRequestsPerScenario: number;
    concurrency: number;
    deno: string;
    v8: string;
    startedAt: string;
    durationMs: number;
    simulated: boolean;
  };
  scenarios: ScenarioResult[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[pos];
}

export function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    min: sorted[0] ?? 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : 0,
  };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

async function runPool<T>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  });
  await Promise.all(lanes);
  return results;
}

function forceGc(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    return true;
  }
  return false;
}

interface Sample {
  index: number;
  userIndex: number;
  status: number;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  responseText: string;
  calls: RecordedCall[];
  spec: RequestSpec;
}

async function execute(
  harness: PerfHarness,
  spec: RequestSpec,
  index: number,
  userIndex: number,
): Promise<Sample> {
  const { request, requestBytes } = buildRequest(spec);
  const calls: RecordedCall[] = [];
  const started = performance.now();
  const response = await callContext.run(calls, () => harness.handler(request));
  const responseText = await response.text();
  const latencyMs = performance.now() - started;
  return {
    index,
    userIndex,
    status: response.status,
    latencyMs,
    requestBytes,
    responseBytes: new TextEncoder().encode(responseText).byteLength,
    responseText,
    calls,
    spec,
  };
}

export async function runScenario(
  harness: PerfHarness,
  scenario: Scenario,
  ctx: ScenarioContext,
  concurrency: number,
): Promise<ScenarioResult> {
  scenario.fixtures(harness.fixtures, ctx);
  harness.resetRedis();
  for (const entry of harness.fixtures.redisSeed) {
    harness.seedRedis(entry.key, entry.value, entry.ttlSeconds);
  }
  const users = scenario.users === "unique" ? ctx.requests : scenario.users;
  const userIndexOf = (index: number): number =>
    scenario.users === "unique" ? index : index % users;

  // ── Warm-up: prime the auth cache for every user the measured requests
  // will rotate through (the steady state of a signed-in device), plus any
  // route-specific cache the scenario wants HOT. "unique" scenarios skip auth
  // priming unless they opt in: without it they measure the cold path.
  let warmRequests = 0;
  if (scenario.token !== "none" && (scenario.users !== "unique" || scenario.warmAuth)) {
    await runPool(users, Math.max(concurrency, 8), async (userIndex) => {
      const warm: RequestSpec = {
        method: "GET",
        path: "/v1/me/access",
        token: tokenFor(scenario.token, ctx.seed, userIndex),
        ip: ipFor(userIndex),
      };
      await execute(harness, warm, -1, userIndex);
      warmRequests += 1;
      if (scenario.warmRoute) {
        await execute(harness, scenario.warmRoute(ctx, userIndex), -1, userIndex);
        warmRequests += 1;
      }
    });
  }
  harness.drain();
  const consoleBefore = { ...harness.consoleLines };

  const gcForced = forceGc();
  const memBefore = Deno.memoryUsage();
  const wallStart = performance.now();
  const samples = await runPool(ctx.requests, concurrency, (index) => {
    const userIndex = userIndexOf(index);
    return execute(harness, scenario.build(ctx, index, userIndex), index, userIndex);
  });
  const wallMs = performance.now() - wallStart;
  if (gcForced) forceGc();
  const memAfter = Deno.memoryUsage();
  const globalCalls = harness.drain();

  const statuses: Record<string, number> = {};
  const failures: FailureRecord[] = [];
  let failureCount = 0;
  const latencies: number[] = [];
  const hot: number[] = [];
  const total: number[] = [];
  const byClass: Record<UpstreamClass, number[]> = {
    supabase_auth: [],
    supabase_rest: [],
    revenuecat: [],
    redis: [],
    other: [],
  };
  const labels: Record<string, number> = {};
  const reqBytes: number[] = [];
  const resBytes: number[] = [];
  const upReq: number[] = [];
  const upRes: number[] = [];

  for (const sample of samples) {
    statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
    latencies.push(round3(sample.latencyMs));
    reqBytes.push(sample.requestBytes);
    resBytes.push(sample.responseBytes);
    const counts: Record<UpstreamClass, number> = {
      supabase_auth: 0,
      supabase_rest: 0,
      revenuecat: 0,
      redis: 0,
      other: 0,
    };
    let upReqSum = 0;
    let upResSum = 0;
    for (const call of sample.calls) {
      counts[call.cls] += 1;
      labels[call.label] = (labels[call.label] ?? 0) + 1;
      upReqSum += call.requestBytes;
      upResSum += call.responseBytes;
    }
    for (const cls of CLASSES) byClass[cls].push(counts[cls]);
    hot.push(HOT_CLASSES.reduce((acc, cls) => acc + counts[cls], 0));
    total.push(sample.calls.length);
    upReq.push(upReqSum);
    upRes.push(upResSum);
    if (!scenario.expectStatus.includes(sample.status)) {
      failureCount += 1;
      if (failures.length < 25) {
        failures.push({
          index: sample.index,
          userIndex: sample.userIndex,
          userId: userIdFor(ctx.seed, sample.userIndex),
          status: sample.status,
          expected: scenario.expectStatus,
          request: {
            method: sample.spec.method,
            path: sample.spec.path,
            body: sample.requestBytes <= 8_192 ? sample.spec.body : undefined,
            bodyBytes: sample.requestBytes,
          },
          responseBody: sample.responseText.slice(0, 600),
          calls: sample.calls.map((call) => call.label),
        });
      }
    }
  }

  const attributed = samples.reduce((acc, sample) => acc + sample.calls.length, 0);
  if (attributed !== globalCalls.length) {
    // Attribution and the global tap disagree — only possible if a call
    // escaped the async context. Surface loudly rather than under-count.
    console.error(
      `[perf] ${scenario.id}: attributed ${attributed} calls but recorded ${globalCalls.length}`,
    );
  }

  const labelTable: Record<string, { perRequest: number; total: number }> = {};
  for (const [label, count] of Object.entries(labels).sort((a, b) => b[1] - a[1])) {
    labelTable[label] = { perRequest: round3(count / ctx.requests), total: count };
  }
  const hotDist = distribution(hot);
  const byClassDist = {} as Record<UpstreamClass, Distribution>;
  for (const cls of CLASSES) byClassDist[cls] = distribution(byClass[cls]);

  return {
    id: scenario.id,
    route: scenario.route,
    variant: scenario.variant,
    hotPath: scenario.hotPath,
    notes: scenario.notes,
    users: scenario.users,
    requests: ctx.requests,
    warmRequests,
    concurrency,
    wallMs: round3(wallMs),
    throughputRps: round3((ctx.requests / wallMs) * 1000),
    statuses,
    failureCount,
    failures,
    latencyMs: distribution(latencies),
    roundTrips: {
      hot: hotDist,
      total: distribution(total),
      byClass: byClassDist,
      labels: labelTable,
    },
    bytes: {
      request: distribution(reqBytes),
      response: distribution(resBytes),
      upstreamRequest: distribution(upReq),
      upstreamResponse: distribution(upRes),
    },
    heap: {
      beforeHeapUsed: memBefore.heapUsed,
      afterHeapUsed: memAfter.heapUsed,
      deltaHeapUsed: memAfter.heapUsed - memBefore.heapUsed,
      rssBefore: memBefore.rss,
      rssAfter: memAfter.rss,
      gcForced,
    },
    consoleLines: {
      error: harness.consoleLines.error - consoleBefore.error,
      warn: harness.consoleLines.warn - consoleBefore.warn,
      log: harness.consoleLines.log - consoleBefore.log,
    },
    exceedsThreshold: scenario.hotPath && hotDist.p50 > 3,
  };
}

export interface BenchOptions {
  redis: boolean;
  latencyMode: "zero" | "simulated";
  requests: number;
  heavyRequests: number;
  concurrency: number;
  seed: string;
  scenarioIds: string[] | "all";
}

export async function runBench(options: BenchOptions): Promise<BenchOutput> {
  const startedAt = new Date();
  const latency = options.latencyMode === "simulated" ? SIMULATED_LATENCY : ZERO_LATENCY;
  const harness = await bootPerfHarness({ redis: options.redis, latency });
  harness.setQuiet(true);
  const selected =
    options.scenarioIds === "all"
      ? SCENARIOS
      : SCENARIOS.filter((scenario) => (options.scenarioIds as string[]).includes(scenario.id));
  if (options.scenarioIds !== "all" && selected.length !== options.scenarioIds.length) {
    const known = new Set(SCENARIOS.map((s) => s.id));
    const missing = options.scenarioIds.filter((id) => !known.has(id));
    throw new Error(`unknown scenario id(s): ${missing.join(", ")}`);
  }
  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const requests = scenario.heavy ? options.heavyRequests : options.requests;
    // Unique populations get a scenario-specific seed so no earlier scenario
    // can have warmed their auth/rank/progress entries in the isolate's L1.
    const seed = scenario.users === "unique" ? `${options.seed}:${scenario.id}` : options.seed;
    const ctx: ScenarioContext = { seed, requests };
    results.push(await runScenario(harness, scenario, ctx, options.concurrency));
  }
  harness.setQuiet(false);
  return {
    meta: {
      tool: "supabase/functions/api/__wf__/perf/perf_edge_latency_bench.ts",
      seed: options.seed,
      redis: options.redis,
      latencyMode: options.latencyMode,
      latencyMs: latency,
      requestsPerScenario: options.requests,
      heavyRequestsPerScenario: options.heavyRequests,
      concurrency: options.concurrency,
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      simulated: options.latencyMode === "simulated",
    },
    scenarios: results,
  };
}

function parseCli(argv: string[]): BenchOptions & { out: string | null } {
  const { values } = parseArgs({
    args: argv,
    options: {
      redis: { type: "string", default: "off" },
      latency: { type: "string", default: "zero" },
      requests: { type: "string", default: "1000" },
      "heavy-requests": { type: "string" },
      concurrency: { type: "string" },
      seed: { type: "string", default: "perf-edge-latency-n1" },
      scenario: { type: "string", default: "all" },
      out: { type: "string" },
    },
  });
  const redis = values.redis === "on";
  if (values.redis !== "on" && values.redis !== "off") throw new Error("--redis on|off");
  const latencyMode = values.latency === "simulated" ? "simulated" : "zero";
  if (values.latency !== "simulated" && values.latency !== "zero") {
    throw new Error("--latency zero|simulated");
  }
  const requests = Number(values.requests);
  if (!Number.isInteger(requests) || requests < 1) throw new Error("--requests must be >= 1");
  // `heavy` scenarios (the 400 ms profile-retry sleep in me-missing-profile)
  // default to 100 requests: 1000 sequential 400 ms sleeps is wall time, not
  // signal. Override with --heavy-requests.
  const heavyRequests = values["heavy-requests"]
    ? Number(values["heavy-requests"])
    : Math.min(requests, 100);
  const concurrency = values.concurrency
    ? Number(values.concurrency)
    : latencyMode === "simulated"
      ? 25
      : 1;
  const scenarioIds =
    values.scenario === "all" ? ("all" as const) : values.scenario!.split(",").filter(Boolean);
  return {
    redis,
    latencyMode,
    requests,
    heavyRequests,
    concurrency,
    seed: values.seed!,
    scenarioIds,
    out: values.out ?? null,
  };
}

if (import.meta.main) {
  const options = parseCli(Deno.args);
  const output = await runBench(options);
  const text = JSON.stringify(output, null, 2);
  if (options.out) {
    await Deno.writeTextFile(options.out, text);
    const failures = output.scenarios.reduce((acc, s) => acc + s.failureCount, 0);
    console.error(
      `[perf] wrote ${options.out}: ${output.scenarios.length} scenarios, ` +
        `${failures} unexpected statuses, ${output.meta.durationMs}ms`,
    );
  } else {
    let bytes = new TextEncoder().encode(text + "\n");
    while (bytes.length > 0) {
      const written = await Deno.stdout.write(bytes);
      bytes = bytes.subarray(written);
    }
  }
}
