// STRESS — unit edge-legal, lens failure-load (Upstash-configured isolate).
//
// The real edge function boots once here with UPSTASH_* set, so the legal
// routes' single upstream (the shared rate-limit counter in Upstash) is live
// and fault-injectable. Every campaign records a JSON table under
// artifacts/stress-edge-legal/latest/ (see stress_legal_harness.ts for the
// STRESS_* knobs and the full-scale command).
//
//   cd supabase/functions/api/__wf__ && deno task test stress_legal_failure_load.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  ALL_FAULTS,
  type FaultCase,
  freshIp,
  histogram,
  INDEPENDENCE_FAULTS,
  iterationSeed,
  judge,
  latencySummary,
  LEGAL_METHODS,
  LEGAL_ROUTES,
  LEGAL_TEXT,
  type LegalMethod,
  legalRequest,
  type LegalRoute,
  loadStressHarness,
  observe,
  PUBLIC_PAGE_LIMIT,
  REDIS_TIMEOUT_MS,
  Rng,
  round,
  STRESS_CASE_SEED,
  STRESS_ITER,
  STRESS_LOAD,
  STRESS_SEED,
  type StressHarness,
  UPSTASH_FAULTS,
  withClockOffset,
  withFrozenClock,
  writeTable,
} from "./stress_legal_harness.ts";

const FULL_MATRIX = Deno.env.get("STRESS_MATRIX") === "full";

const REPLAY =
  "cd supabase/functions/api/__wf__ && STRESS_CASE_SEED=<seed> deno test -A --no-check --config deno.json stress_legal_failure_load.test.ts --filter 'seeded random'";

interface FaultRow {
  fault: string;
  upstream: string;
  title: string;
  route: LegalRoute;
  method: LegalMethod;
  ip: string;
  expected: string;
  status: number;
  code: string | null;
  latencyMs: number;
  roundTrips: Record<string, number>;
  recoveredStatus: number;
  limiterUnderFault: string;
  problems: string[];
  outcome: "HELD" | "BROKEN";
}

/** How the limiter behaves for one IP while the fault stays active: does the
 * memory fallback (or Redis) still stop the 61st request? Slow faults are
 * skipped (61 × 1.2 s is not a suite-friendly probe). */
async function limiterUnderFault(
  h: StressHarness,
  fault: FaultCase,
  route: LegalRoute,
): Promise<string> {
  if (fault.minLatencyMs !== undefined && fault.minLatencyMs > 100) {
    return "skipped-slow";
  }
  if (fault.expect === "rate_limited") return "redis-authoritative-429";
  const ip = freshIp();
  return await withFrozenClock(async () => {
    h.faults[fault.upstream] = fault;
    let firstLimitedAt = -1;
    for (let i = 1; i <= PUBLIC_PAGE_LIMIT + 5; i += 1) {
      const obs = await observe(h, legalRequest("GET", route, { ip }), route);
      if (obs.status === 429 && firstLimitedAt < 0) firstLimitedAt = i;
      else if (obs.status !== 200 && obs.status !== 429) {
        return `unexpected-${obs.status}@${i}`;
      }
    }
    h.faults[fault.upstream] = null;
    if (firstLimitedAt === PUBLIC_PAGE_LIMIT + 1) return "limited-at-61";
    if (firstLimitedAt < 0) return "never-limited";
    return `limited-at-${firstLimitedAt}`;
  });
}

Deno.test("stress/legal: fault matrix — every upstream fault × route × method (user-visible class + recovery)", async () => {
  const h = await loadStressHarness({ redis: true });
  const rows: FaultRow[] = [];
  const started = performance.now();
  for (const fault of ALL_FAULTS) {
    // Faults that impose ≥250ms per request cost 1.2s × 6 combos each; the
    // quick (default) matrix runs them once, STRESS_MATRIX=full runs all six.
    const slow = (fault.minLatencyMs ?? 0) >= 250 && !FULL_MATRIX;
    for (const route of slow ? ["/privacy" as const] : LEGAL_ROUTES) {
      for (const method of slow ? ["GET" as const] : LEGAL_METHODS) {
        h.reset();
        const ip = freshIp();
        h.faults[fault.upstream] = fault;
        const obs = await observe(
          h,
          legalRequest(method, route, { ip }),
          route,
        );
        const problems = judge(fault, method, route, obs);
        h.faults[fault.upstream] = null;
        // Recoverability: the SAME client, one request after the fault clears.
        const recovered = await observe(
          h,
          legalRequest(method, route, { ip }),
          route,
        );
        if (recovered.status !== 200) {
          problems.push(`did not recover: ${recovered.status}`);
        }
        if (method === "GET" && !recovered.bodyMatchesDocument) {
          problems.push("recovered body mismatch");
        }
        const limiter = method === "GET" && route === "/privacy"
          ? await limiterUnderFault(h, fault, route)
          : "n/a";
        if (limiter.startsWith("unexpected")) {
          problems.push(`limiter probe ${limiter}`);
        }
        if (
          fault.fallback === "memory" && limiter !== "n/a" &&
          limiter !== "skipped-slow" && limiter !== "limited-at-61"
        ) {
          problems.push(
            `memory fallback expected to limit at 61 but ${limiter}`,
          );
        }
        if (
          fault.fallback === "redis" && fault.expect === "served" &&
          limiter !== "n/a" && limiter !== "skipped-slow" &&
          limiter !== "limited-at-61" && limiter !== "never-limited"
        ) {
          problems.push(`redis-counted fault limited unexpectedly: ${limiter}`);
        }
        rows.push({
          fault: fault.id,
          upstream: fault.upstream,
          title: fault.title,
          route,
          method,
          ip,
          expected: fault.expect,
          status: obs.status,
          code: obs.code,
          latencyMs: round(obs.latencyMs),
          roundTrips: obs.roundTrips,
          recoveredStatus: recovered.status,
          limiterUnderFault: limiter,
          problems,
          outcome: problems.length === 0 ? "HELD" : "BROKEN",
        });
      }
    }
  }
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const path = await writeTable("fault_matrix", {
    unit: "edge-legal",
    lens: "failure-load",
    matrix: FULL_MATRIX ? "full" : "quick",
    faultCases: ALL_FAULTS.length,
    upstashFaults: UPSTASH_FAULTS.length,
    independenceFaults: INDEPENDENCE_FAULTS.length,
    iterations: rows.length,
    durationMs: round(performance.now() - started),
    outcomes: histogram(rows.map((r) => r.outcome)),
    limiterUnderFault: histogram(
      rows.filter((r) => r.limiterUnderFault !== "n/a").map((r) =>
        `${r.fault}:${r.limiterUnderFault}`
      ),
    ),
    rows,
  });
  console.log(
    `[stress/legal] fault matrix: ${rows.length} iterations, ${broken.length} broken → ${path}`,
  );
  assertEquals(
    broken.map((r) =>
      `${r.fault} ${r.method} ${r.route}: ${r.problems.join("; ")}`
    ),
    [],
  );
  assert(
    ALL_FAULTS.length >= 40,
    `fault catalogue has ${ALL_FAULTS.length} cases (< 40)`,
  );
});

interface RandomRow {
  iteration: number;
  seed: number;
  fault: string | null;
  route: LegalRoute;
  method: LegalMethod;
  ipShape: string;
  ip: string;
  requestIdIn: string | null;
  query: string;
  status: number;
  code: string | null;
  latencyMs: number;
  roundTrips: Record<string, number>;
  recoveredStatus: number;
  problems: string[];
  outcome: "HELD" | "BROKEN";
}

const IP_SHAPES = [
  "xff-single",
  "xff-multihop",
  "cf-connecting-ip",
  "xff-spaces-and-empties",
] as const;

function shapeHeaders(
  shape: (typeof IP_SHAPES)[number],
  ip: string,
  rng: Rng,
): Record<string, string> {
  switch (shape) {
    case "xff-single":
      return { "x-forwarded-for": ip };
    case "xff-multihop": {
      const hops = Array.from(
        { length: 1 + rng.int(6) },
        () => `10.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`,
      );
      return { "x-forwarded-for": [...hops, ip].join(", ") };
    }
    case "cf-connecting-ip":
      return {
        "cf-connecting-ip": ip,
        "x-forwarded-for": `10.0.0.${rng.int(256)}`,
      };
    case "xff-spaces-and-empties":
      return { "x-forwarded-for": ` , ,  10.1.1.${rng.int(256)} ,, ${ip}  , ` };
  }
}

const NO_FAULT: FaultCase = {
  id: "NONE",
  upstream: "upstash",
  title: "honest upstash",
  fallback: "redis",
  expect: "served",
  respond: ({ honest }) => honest(),
};

Deno.test("stress/legal: seeded random fault campaign (STRESS_ITER iterations, each replayable by seed)", async () => {
  const h = await loadStressHarness({ redis: true });
  const rows: RandomRow[] = [];
  const started = performance.now();
  const seeds: number[] = STRESS_CASE_SEED !== null
    ? [STRESS_CASE_SEED]
    : Array.from({ length: STRESS_ITER }, (_, i) =>
      iterationSeed(STRESS_SEED, i));
  for (const [iteration, seed] of seeds.entries()) {
    const rng = new Rng(seed);
    h.reset();
    const fault = rng.chance(0.08) ? NO_FAULT : rng.pick(ALL_FAULTS);
    const route = rng.pick(LEGAL_ROUTES);
    const method = rng.pick(LEGAL_METHODS);
    const ipShape = rng.pick(IP_SHAPES);
    const ip = `198.51.${rng.int(256)}.${rng.int(256)}-${seed.toString(16)}`;
    const headers = shapeHeaders(ipShape, ip, rng);
    const requestIdIn = rng.chance(0.3) ? crypto.randomUUID() : null;
    if (requestIdIn) headers["x-request-id"] = requestIdIn;
    const query = rng.chance(0.3) ? `?v=${rng.int(1_000_000)}` : "";
    h.faults[fault.upstream] = fault;
    const obs = await observe(
      h,
      legalRequest(method, `${route}${query}`, { ip: null, headers }),
      route,
    );
    const problems = judge(fault, method, route, obs);
    if (requestIdIn && obs.requestId !== requestIdIn) {
      problems.push(`request id not echoed: ${obs.requestId}`);
    }
    if (
      fault.upstream === "upstash" && fault.id !== "NONE" &&
      obs.roundTrips.upstash !== 1
    ) {
      problems.push(`upstash round trips ${obs.roundTrips.upstash} != 1`);
    }
    const logged = h.accessLog.filter((e) => e.requestId === obs.requestId);
    if (logged.length !== 1 || logged[0].status !== obs.status) {
      problems.push(`access log rows for request: ${logged.length}`);
    }
    h.faults[fault.upstream] = null;
    const recovered = await observe(
      h,
      legalRequest(method, route, { ip: null, headers }),
      route,
    );
    if (recovered.status !== 200) {
      problems.push(`did not recover: ${recovered.status}`);
    }
    rows.push({
      iteration,
      seed,
      fault: fault.id === "NONE" ? null : fault.id,
      route,
      method,
      ipShape,
      ip,
      requestIdIn,
      query,
      status: obs.status,
      code: obs.code,
      latencyMs: round(obs.latencyMs),
      roundTrips: obs.roundTrips,
      recoveredStatus: recovered.status,
      problems,
      outcome: problems.length === 0 ? "HELD" : "BROKEN",
    });
  }
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const path = await writeTable("random_faults", {
    baseSeed: STRESS_SEED,
    replay: REPLAY,
    iterations: rows.length,
    durationMs: round(performance.now() - started),
    outcomes: histogram(rows.map((r) => r.outcome)),
    faults: histogram(rows.map((r) => r.fault ?? "none")),
    statuses: histogram(rows.map((r) => r.status)),
    latency: latencySummary(rows.map((r) => r.latencyMs)),
    rows,
  });
  console.log(
    `[stress/legal] random faults: ${rows.length} iterations, ${broken.length} broken → ${path}`,
  );
  assertEquals(
    broken.map((r) =>
      `seed ${r.seed} (${r.fault} ${r.method} ${r.route}): ${
        r.problems.join("; ")
      }`
    ),
    [],
  );
});

interface LoadRow {
  i: number;
  route: LegalRoute;
  method: LegalMethod;
  ip: string;
  status: number;
  latencyMs: number;
  upstash: number;
  supabase: number;
}

Deno.test("stress/legal: load with live Upstash — STRESS_LOAD requests, p50/p95 and round trips per request", async () => {
  const h = await loadStressHarness({ redis: true });
  const rng = new Rng(iterationSeed(STRESS_SEED, 0x10ad));
  const pool = Array.from(
    { length: Math.ceil(STRESS_LOAD / 50) },
    () => freshIp(),
  );
  const rows: LoadRow[] = [];
  const problems: string[] = [];
  const wallStart = performance.now();
  await withFrozenClock(async () => {
    for (let i = 0; i < STRESS_LOAD; i += 1) {
      const route = rng.pick(LEGAL_ROUTES);
      const method = rng.pick(LEGAL_METHODS);
      const ip = pool[i % pool.length];
      const obs = await observe(h, legalRequest(method, route, { ip }), route);
      const supabase = obs.roundTrips.supabaseAuth + obs.roundTrips.postgrest;
      rows.push({
        i,
        route,
        method,
        ip,
        status: obs.status,
        latencyMs: round(obs.latencyMs),
        upstash: obs.roundTrips.upstash,
        supabase,
      });
      if (obs.status !== 200) problems.push(`#${i} status ${obs.status}`);
      if (obs.roundTrips.upstash !== 1) {
        problems.push(`#${i} upstash ${obs.roundTrips.upstash}`);
      }
      if (supabase !== 0 || obs.roundTrips.revenuecat !== 0) {
        problems.push(
          `#${i} supabase/revenuecat ${JSON.stringify(obs.roundTrips)}`,
        );
      }
      if (method === "GET" && !obs.bodyMatchesDocument) {
        problems.push(`#${i} body mismatch`);
      }
    }
  });
  const wallMs = performance.now() - wallStart;
  const perIp = histogram(rows.map((r) => r.ip));
  const maxPerIp = Math.max(...Object.values(perIp));
  const logged = h.accessLog.filter((e) => e.evt === "api_request").length;
  const latency = latencySummary(rows.map((r) => r.latencyMs));
  const path = await writeTable("load_redis", {
    requests: rows.length,
    distinctIps: pool.length,
    maxRequestsPerIp: maxPerIp,
    wallMs: round(wallMs),
    throughputRps: round((rows.length / wallMs) * 1000, 1),
    latency,
    roundTripsPerRequest: {
      upstash: histogram(rows.map((r) => r.upstash)),
      supabase: histogram(rows.map((r) => r.supabase)),
    },
    statuses: histogram(rows.map((r) => r.status)),
    accessLogRows: logged,
    rows,
  });
  console.log(
    `[stress/legal] load(redis): n=${rows.length} p50=${latency.p50Ms}ms p95=${latency.p95Ms}ms → ${path}`,
  );
  assert(
    maxPerIp <= PUBLIC_PAGE_LIMIT,
    `pool sizing bug: ${maxPerIp} requests on one ip`,
  );
  assertEquals(problems, []);
  assert(
    logged >= rows.length,
    `access log has ${logged} rows for ${rows.length} requests`,
  );
});

Deno.test("stress/legal: concurrent load with live Upstash — batches of 50 in flight", async () => {
  const h = await loadStressHarness({ redis: true });
  const rng = new Rng(iterationSeed(STRESS_SEED, 0xc0c0));
  const total = STRESS_LOAD;
  const pool = Array.from({ length: Math.ceil(total / 50) }, () => freshIp());
  const latencies: number[] = [];
  const statuses: number[] = [];
  const wallStart = performance.now();
  await withFrozenClock(async () => {
    for (let done = 0; done < total; done += 50) {
      const batch = Math.min(50, total - done);
      const results = await Promise.all(
        Array.from({ length: batch }, (_, j) => {
          const route = rng.pick(LEGAL_ROUTES);
          return observe(
            h,
            legalRequest(rng.pick(LEGAL_METHODS), route, {
              ip: pool[(done + j) % pool.length],
            }),
            route,
          );
        }),
      );
      for (const obs of results) {
        latencies.push(round(obs.latencyMs));
        statuses.push(obs.status);
      }
    }
  });
  const wallMs = performance.now() - wallStart;
  const latency = latencySummary(latencies);
  const path = await writeTable("load_redis_concurrent", {
    requests: latencies.length,
    concurrency: 50,
    wallMs: round(wallMs),
    throughputRps: round((latencies.length / wallMs) * 1000, 1),
    latency,
    statuses: histogram(statuses),
  });
  console.log(
    `[stress/legal] load(redis, concurrent): n=${latencies.length} p50=${latency.p50Ms}ms p95=${latency.p95Ms}ms → ${path}`,
  );
  assertEquals(histogram(statuses), { "200": latencies.length });
});

Deno.test("stress/legal: 429 path — 60 served, then rate_limited with Retry-After, recovers at the next window", async () => {
  const h = await loadStressHarness({ redis: true });
  const ip = freshIp();
  const extra = Math.max(20, Math.min(STRESS_LOAD, 500));
  const statuses: number[] = [];
  const retryAfter: number[] = [];
  const latency200: number[] = [];
  const latency429: number[] = [];
  let recovered = 0;
  let remainingHeader: string | null = null;
  await withFrozenClock(async () => {
    for (let i = 0; i < PUBLIC_PAGE_LIMIT + extra; i += 1) {
      const started = performance.now();
      const res = await h.handler(legalRequest("GET", "/terms", { ip }));
      const body = await res.text();
      const ms = performance.now() - started;
      statuses.push(res.status);
      if (res.status === 200) {
        latency200.push(ms);
        assertEquals(body, LEGAL_TEXT["/terms"]);
      } else {
        latency429.push(ms);
        retryAfter.push(Number(res.headers.get("retry-after")));
        remainingHeader = res.headers.get("ratelimit-remaining");
        const parsed = JSON.parse(body) as {
          error: { code: string; message: string };
        };
        assertEquals(parsed.error.code, "rate_limited");
        assertEquals(res.headers.get("cache-control"), "no-store");
        assert(
          !body.includes("@"),
          "429 body must not carry the support mailbox or any address",
        );
      }
    }
  });
  await withClockOffset(61_000, async () => {
    const res = await h.handler(legalRequest("GET", "/terms", { ip }));
    recovered = res.status;
    await res.body?.cancel();
  });
  const path = await writeTable("rate_limit_path", {
    ip,
    requests: statuses.length,
    served: statuses.filter((s) => s === 200).length,
    limited: statuses.filter((s) => s === 429).length,
    firstLimitedAt: statuses.indexOf(429) + 1,
    retryAfter: { min: Math.min(...retryAfter), max: Math.max(...retryAfter) },
    remainingHeader,
    latency200: latencySummary(latency200),
    latency429: latencySummary(latency429),
    recoveredStatusAfter61s: recovered,
  });
  console.log(
    `[stress/legal] 429 path: first limited at #${
      statuses.indexOf(429) + 1
    }, recovered=${recovered} → ${path}`,
  );
  assertEquals(statuses.filter((s) => s === 200).length, PUBLIC_PAGE_LIMIT);
  assertEquals(statuses.indexOf(429), PUBLIC_PAGE_LIMIT);
  assert(
    retryAfter.every((s) => s >= 1 && s <= 60),
    `retry-after out of range: ${retryAfter.join(",")}`,
  );
  assertEquals(remainingHeader, "0");
  assertEquals(recovered, 200);
});

Deno.test("stress/legal: Upstash hangs under concurrent load — every request is served after ONE 1.2s timeout, in parallel", async () => {
  const h = await loadStressHarness({ redis: true });
  const hang = UPSTASH_FAULTS.find((f) => f.id === "U34")!;
  const concurrency = Math.max(10, Math.min(STRESS_LOAD, 200));
  h.faults.upstash = hang;
  const wallStart = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => {
      const route = LEGAL_ROUTES[i % LEGAL_ROUTES.length];
      return observe(h, legalRequest("GET", route, { ip: freshIp() }), route);
    }),
  );
  const wallMs = performance.now() - wallStart;
  h.faults.upstash = null;
  const after = await observe(
    h,
    legalRequest("GET", "/privacy", { ip: freshIp() }),
    "/privacy",
  );
  const latency = latencySummary(results.map((r) => r.latencyMs));
  const path = await writeTable("upstash_timeout_concurrent", {
    concurrency,
    wallMs: round(wallMs),
    latency,
    statuses: histogram(results.map((r) => r.status)),
    recoveredLatencyMs: round(after.latencyMs),
  });
  console.log(
    `[stress/legal] upstash hang ×${concurrency}: wall=${
      wallMs.toFixed(0)
    }ms p95=${latency.p95Ms}ms → ${path}`,
  );
  assertEquals(histogram(results.map((r) => r.status)), { "200": concurrency });
  assert(
    results.every((r) => r.bodyMatchesDocument),
    "every hung-redis request still served the document",
  );
  assert(
    latency.p50Ms >= REDIS_TIMEOUT_MS - 50,
    `p50 ${latency.p50Ms}ms below the redis timeout: timeout not honoured`,
  );
  assert(
    wallMs < REDIS_TIMEOUT_MS * 2,
    `wall ${wallMs.toFixed(0)}ms: hung redis calls were serialised`,
  );
  assertEquals(after.status, 200);
  assert(
    after.latencyMs < 200,
    `recovered request took ${after.latencyMs.toFixed(0)}ms`,
  );
});

Deno.test("stress/legal: client-ip trust surface — which header keys the limiter (observed, pinned)", async () => {
  const h = await loadStressHarness({ redis: true });
  const n = PUBLIC_PAGE_LIMIT + 20;
  const table: Record<string, unknown> = {};
  await withFrozenClock(async () => {
    // (a) one fixed XFF, rotating cf-connecting-ip → never limited.
    const xff = freshIp();
    let limited = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/support", {
          ip: null,
          headers: {
            "x-forwarded-for": xff,
            "cf-connecting-ip": `192.0.2.${i % 256}`,
          },
        }),
      );
      await res.body?.cancel();
      if (res.status === 429) limited += 1;
    }
    table.rotatingCfConnectingIpFixedXff = { requests: n, limited };
    // (b) one fixed cf-connecting-ip, rotating XFF → limited at 61.
    const cf = freshIp();
    limited = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/support", {
          ip: null,
          headers: {
            "cf-connecting-ip": cf,
            "x-forwarded-for": `192.0.2.${i % 256}`,
          },
        }),
      );
      await res.body?.cancel();
      if (res.status === 429) limited += 1;
    }
    table.fixedCfConnectingIpRotatingXff = { requests: n, limited };
    // (c) no ip header at all → the shared "unknown" bucket.
    limited = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/support", { ip: null }),
      );
      await res.body?.cancel();
      if (res.status === 429) limited += 1;
    }
    table.noIpHeaderSharedBucket = { requests: n, limited };
    // (d) rotating LAST xff hop with a fixed first hop → never limited.
    limited = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/support", {
          ip: null,
          headers: { "x-forwarded-for": `${xff}, 192.0.2.${i % 256}` },
        }),
      );
      await res.body?.cancel();
      if (res.status === 429) limited += 1;
    }
    table.rotatingLastXffHop = { requests: n, limited };
  });
  const path = await writeTable("ip_trust_surface", table);
  console.log(`[stress/legal] ip trust surface → ${path}`);
  assertEquals(table.rotatingCfConnectingIpFixedXff, {
    requests: n,
    limited: 0,
  });
  assertEquals(table.fixedCfConnectingIpRotatingXff, {
    requests: n,
    limited: 20,
  });
  assertEquals(table.noIpHeaderSharedBucket, { requests: n, limited: 20 });
  assertEquals(table.rotatingLastXffHop, { requests: n, limited: 0 });
});

interface SurfaceRow {
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  code: string | null;
  bodyIsDocument: LegalRoute | null;
  bodyBytes: number;
  errorMessage: string | null;
}

Deno.test("stress/legal: path/method surface — variants of the public URLs (never 5xx, never a document leak)", async () => {
  const h = await loadStressHarness({ redis: true });
  const probes: Array<[string, string]> = [
    ["GET", "/privacy"],
    ["HEAD", "/privacy"],
    ["GET", "/privacy/"],
    ["GET", "/PRIVACY"],
    ["GET", "/privacy?utm_source=appstore"],
    ["GET", "/privacy#section-7"],
    ["GET", "//privacy"],
    ["GET", "/priv%61cy"],
    ["GET", "/privacy%2F"],
    ["GET", "/v1/me/privacy"],
    ["GET", "/../privacy"],
    ["GET", "/terms/"],
    ["GET", "/support/"],
    ["GET", "/privacy.txt"],
    ["GET", "/privacy-policy"],
    ["POST", "/privacy"],
    ["PUT", "/privacy"],
    ["DELETE", "/privacy"],
    ["PATCH", "/privacy"],
    ["OPTIONS", "/privacy"],
    ["get", "/privacy"],
    ["GET", "/terms?" + "x".repeat(8_000)],
  ];
  const rows: SurfaceRow[] = [];
  for (const [method, path] of probes) {
    let request: Request;
    try {
      request = legalRequest(method, path, { ip: freshIp() });
    } catch (error) {
      rows.push({
        method,
        path,
        status: -1,
        contentType: null,
        code: String(error),
        bodyIsDocument: null,
        bodyBytes: 0,
        errorMessage: null,
      });
      continue;
    }
    const res = await h.handler(request);
    const body = await res.text();
    let code: string | null = null;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        code =
          (JSON.parse(body) as { error?: { code?: string } }).error?.code ??
            null;
      } catch {
        code = null;
      }
    }
    const doc = (LEGAL_ROUTES as readonly LegalRoute[]).find((r) =>
      body === LEGAL_TEXT[r]
    ) ?? null;
    rows.push({
      method: request.method,
      path: path.length > 80
        ? `${path.slice(0, 80)}…(${path.length} chars)`
        : path,
      status: res.status,
      contentType: res.headers.get("content-type"),
      code,
      bodyIsDocument: doc,
      bodyBytes: body.length,
      errorMessage: code === null &&
          (res.headers.get("content-type") ?? "").includes("application/json")
        ? body
        : null,
    });
  }
  const tablePath = await writeTable("path_method_surface", { rows });
  console.log(`[stress/legal] path/method surface → ${tablePath}`);
  assert(
    rows.every((r) => r.status < 500),
    `5xx on surface: ${JSON.stringify(rows.filter((r) => r.status >= 500))}`,
  );
  const get = rows.find((r) => r.method === "GET" && r.path === "/privacy")!;
  assertEquals(get.bodyIsDocument, "/privacy");
  for (const r of rows) {
    if (r.bodyIsDocument && !["GET", "HEAD"].includes(r.method)) {
      throw new Error(`${r.method} ${r.path} served a document`);
    }
  }
});

Deno.test("stress/legal: real HTTP round trip through Deno.serve — HEAD strips the body, request id and latency", async () => {
  const h = await loadStressHarness({ redis: true });
  const server = h.realServe(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    h.handler,
  );
  const base = `http://127.0.0.1:${server.addr.port}/functions/v1/api`;
  const rng = new Rng(iterationSeed(STRESS_SEED, 0x4774));
  const n = STRESS_LOAD;
  const pool = Array.from({ length: Math.ceil(n / 50) }, () => freshIp());
  const latencies: number[] = [];
  const statuses: number[] = [];
  const problems: string[] = [];
  const wallStart = performance.now();
  try {
    await withFrozenClock(async () => {
      for (let i = 0; i < n; i += 1) {
        const route = rng.pick(LEGAL_ROUTES);
        const method = rng.pick(LEGAL_METHODS);
        const requestId = crypto.randomUUID();
        const started = performance.now();
        const res = await h.realFetch(`${base}${route}`, {
          method,
          headers: {
            "x-forwarded-for": pool[i % pool.length],
            "x-request-id": requestId,
          },
        });
        const body = await res.text();
        latencies.push(round(performance.now() - started));
        statuses.push(res.status);
        if (res.status !== 200) {
          problems.push(`#${i} ${method} ${route} status ${res.status}`);
        }
        if (res.headers.get("x-request-id") !== requestId) {
          problems.push(`#${i} request id ${res.headers.get("x-request-id")}`);
        }
        if (method === "GET" && body !== LEGAL_TEXT[route]) {
          problems.push(`#${i} GET body mismatch (${body.length} bytes)`);
        }
        if (method === "HEAD" && body.length !== 0) {
          problems.push(`#${i} HEAD carried ${body.length} body bytes`);
        }
        if (
          !(res.headers.get("content-type") ?? "").startsWith(
            "text/plain; charset=utf-8",
          )
        ) {
          problems.push(
            `#${i} content-type ${res.headers.get("content-type")}`,
          );
        }
      }
    });
  } finally {
    await server.shutdown();
  }
  const wallMs = performance.now() - wallStart;
  const latency = latencySummary(latencies);
  const path = await writeTable("load_real_http", {
    requests: latencies.length,
    wallMs: round(wallMs),
    throughputRps: round((latencies.length / wallMs) * 1000, 1),
    latency,
    statuses: histogram(statuses),
    problems,
  });
  console.log(
    `[stress/legal] real http: n=${latencies.length} p50=${latency.p50Ms}ms p95=${latency.p95Ms}ms → ${path}`,
  );
  assertEquals(problems, []);
});
