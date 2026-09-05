// STRESS — unit edge-legal, lens failure-load (NO Upstash: per-isolate memory
// limiter, the deployment shape when UPSTASH_* secrets are unset).
//
// Own module on purpose: cache.ts reads UPSTASH_* at import time, so the
// memory-only function has to boot in its own isolate (deno test runs each
// module in a fresh isolate; env vars are shared and cleaned up by the
// harness after import).
//
// What the legal routes keep in memory is ONE Map — rateLimit.ts `windows`
// (capped at MEMORY_WINDOW_MAX = 20_000 entries, one per ip per minute
// bucket). cache.ts's L1 is never touched by these routes (0 cacheSet calls;
// no upstream to cache). The memory campaign therefore drives STRESS_USERS
// distinct client IPs through the real handler and measures the heap.
//
//   cd supabase/functions/api/__wf__ && deno task test stress_legal_memory_load.test.ts
//   STRESS_LOAD=1000 STRESS_USERS=20000 deno test -A --no-check --config deno.json \
//     --v8-flags=--expose-gc stress_legal_memory_load.test.ts   # exact heap numbers

import { assert, assertEquals } from "@std/assert";
import {
  freshIp,
  histogram,
  iterationSeed,
  latencySummary,
  LEGAL_METHODS,
  LEGAL_ROUTES,
  LEGAL_TEXT,
  legalRequest,
  loadStressHarness,
  observe,
  PUBLIC_PAGE_LIMIT,
  Rng,
  round,
  STRESS_LOAD,
  STRESS_SEED,
  STRESS_USERS,
  withClockOffset,
  withFrozenClock,
  writeTable,
} from "./stress_legal_harness.ts";

/** rateLimit.ts MEMORY_WINDOW_MAX (module-private; pinned here by behaviour). */
const MEMORY_WINDOW_MAX = 20_000;

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;

function heapUsed(): number {
  gc?.();
  return Deno.memoryUsage().heapUsed;
}

Deno.test("stress/legal(memory): load without Upstash — STRESS_LOAD requests, zero upstream round trips", async () => {
  const h = await loadStressHarness({ redis: false });
  const rng = new Rng(iterationSeed(STRESS_SEED, 0x3e3));
  const pool = Array.from(
    { length: Math.ceil(STRESS_LOAD / 50) },
    () => freshIp(),
  );
  const latencies: number[] = [];
  const problems: string[] = [];
  const wallStart = performance.now();
  await withFrozenClock(async () => {
    for (let i = 0; i < STRESS_LOAD; i += 1) {
      const route = rng.pick(LEGAL_ROUTES);
      const method = rng.pick(LEGAL_METHODS);
      const obs = await observe(
        h,
        legalRequest(method, route, { ip: pool[i % pool.length] }),
        route,
      );
      latencies.push(round(obs.latencyMs));
      if (obs.status !== 200) problems.push(`#${i} status ${obs.status}`);
      const trips = Object.values(obs.roundTrips).reduce((a, b) => a + b, 0);
      if (trips !== 0) {
        problems.push(`#${i} round trips ${JSON.stringify(obs.roundTrips)}`);
      }
      if (method === "GET" && !obs.bodyMatchesDocument) {
        problems.push(`#${i} body mismatch`);
      }
    }
  });
  const wallMs = performance.now() - wallStart;
  const latency = latencySummary(latencies);
  const path = await writeTable("load_memory", {
    requests: latencies.length,
    distinctIps: pool.length,
    wallMs: round(wallMs),
    throughputRps: round((latencies.length / wallMs) * 1000, 1),
    latency,
    fetchCalls: h.calls.length,
    accessLogRows: h.accessLog.length,
  });
  console.log(
    `[stress/legal] load(memory): n=${latencies.length} p50=${latency.p50Ms}ms p95=${latency.p95Ms}ms → ${path}`,
  );
  assertEquals(problems, []);
  assertEquals(h.calls.length, 0, "no fetch at all without Upstash");
});

Deno.test("stress/legal(memory): 60 served then 429, a new minute recovers; the isolate never calls out", async () => {
  const h = await loadStressHarness({ redis: false });
  const ip = freshIp();
  const statuses: number[] = [];
  await withFrozenClock(async () => {
    for (let i = 0; i < PUBLIC_PAGE_LIMIT + 10; i += 1) {
      const res = await h.handler(legalRequest("GET", "/support", { ip }));
      statuses.push(res.status);
      const body = await res.text();
      if (res.status === 200) assertEquals(body, LEGAL_TEXT["/support"]);
      else {
        assertEquals(res.status, 429);
        assertEquals(
          (JSON.parse(body) as { error: { code: string } }).error.code,
          "rate_limited",
        );
      }
    }
  });
  let recovered = 0;
  await withClockOffset(60_000, async () => {
    const res = await h.handler(legalRequest("GET", "/support", { ip }));
    recovered = res.status;
    await res.body?.cancel();
  });
  assertEquals(histogram(statuses), { "200": PUBLIC_PAGE_LIMIT, "429": 10 });
  assertEquals(recovered, 200);
  assertEquals(h.calls.length, 0);
});

Deno.test("stress/legal(memory): STRESS_USERS distinct client IPs — heap growth of the rate-limit window map", async () => {
  const h = await loadStressHarness({ redis: false });
  const rng = new Rng(iterationSeed(STRESS_SEED, 0x0dd));
  const users = STRESS_USERS;
  const before = heapUsed();
  const latencies: number[] = [];
  let limited = 0;
  const wallStart = performance.now();
  await withFrozenClock(async () => {
    for (let i = 0; i < users; i += 1) {
      const ip = `${(i >> 24) & 255}.${(i >> 16) & 255}.${(i >> 8) & 255}.${
        i & 255
      }`;
      const route = rng.pick(LEGAL_ROUTES);
      const obs = await observe(h, legalRequest("GET", route, { ip }), route);
      latencies.push(obs.latencyMs);
      if (obs.status === 429) limited += 1;
      else if (obs.status !== 200) {
        throw new Error(`user ${i}: status ${obs.status}`);
      }
      // Keep the harness's own bookkeeping out of the measurement.
      if (h.accessLog.length > 500) h.accessLog.length = 0;
    }
  });
  const wallMs = performance.now() - wallStart;
  const after = heapUsed();
  const deltaBytes = after - before;
  const path = await writeTable("memory_distinct_users", {
    distinctUsers: users,
    gcExposed: Boolean(gc),
    heapUsedBefore: before,
    heapUsedAfter: after,
    heapDeltaBytes: deltaBytes,
    heapDeltaPerUserBytes: round(deltaBytes / users, 1),
    windowMapCap: MEMORY_WINDOW_MAX,
    wallMs: round(wallMs),
    latency: latencySummary(latencies),
    limited,
    rss: Deno.memoryUsage().rss,
  });
  console.log(
    `[stress/legal] ${users} distinct users: heap Δ=${
      (deltaBytes / 1024 / 1024).toFixed(2)
    } MiB (${(deltaBytes / users).toFixed(0)} B/user, gc=${
      Boolean(gc)
    }) → ${path}`,
  );
  assertEquals(limited, 0, "a fresh ip is never limited");
  // Without --expose-gc the delta is dominated by not-yet-collected request
  // garbage, so the bound is only meaningful when gc() ran: < 512 B retained
  // per distinct client (one Map entry: key string + {count, resetAtMs}).
  if (gc) {
    assert(
      deltaBytes < users * 512,
      `heap retained ${deltaBytes} bytes for ${users} users`,
    );
  }
});

Deno.test("stress/legal(memory): the 20k window cap — a flood of distinct IPs evicts (clears) live windows, fail-open", async () => {
  const h = await loadStressHarness({ redis: false });
  const victim = freshIp();
  let limitedBeforeFlood = 0;
  let statusAfterFlood = 0;
  let floodLimited = 0;
  await withClockOffset(120_000, async () => {
    // Fill the victim's window to the limit and one past it.
    for (let i = 0; i <= PUBLIC_PAGE_LIMIT; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/terms", { ip: victim }),
      );
      await res.body?.cancel();
      if (res.status === 429) limitedBeforeFlood += 1;
    }
    // MEMORY_WINDOW_MAX distinct new keys in the same minute: when the map is
    // full and nothing has expired, memoryIncr() clears it.
    for (let i = 0; i < MEMORY_WINDOW_MAX; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/terms", {
          ip: `240.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        }),
      );
      await res.body?.cancel();
      if (res.status === 429) floodLimited += 1;
    }
    const res = await h.handler(legalRequest("GET", "/terms", { ip: victim }));
    statusAfterFlood = res.status;
    await res.body?.cancel();
  });
  const path = await writeTable("memory_window_cap", {
    windowMapCap: MEMORY_WINDOW_MAX,
    victimLimitedBeforeFlood: limitedBeforeFlood,
    floodRequests: MEMORY_WINDOW_MAX,
    floodLimited,
    victimStatusAfterFlood: statusAfterFlood,
  });
  console.log(
    `[stress/legal] window cap: victim limited=${limitedBeforeFlood} before flood, status after=${statusAfterFlood} → ${path}`,
  );
  assertEquals(limitedBeforeFlood, 1);
  assertEquals(floodLimited, 0);
  // Pins the documented fail-open: the eviction storm forgets the victim's
  // exhausted window (rateLimit.ts memoryIncr → windows.clear()).
  assertEquals(statusAfterFlood, 200);
});

Deno.test("stress/legal(memory): oversized client-ip keys — 8 KiB x-forwarded-for hops, heap per entry", async () => {
  const h = await loadStressHarness({ redis: false });
  const n = Math.min(STRESS_USERS, 2000);
  const hop = (i: number) => `${"a".repeat(8_000)}${i}`;
  const before = heapUsed();
  let served = 0;
  await withClockOffset(240_000, async () => {
    for (let i = 0; i < n; i += 1) {
      const res = await h.handler(
        legalRequest("GET", "/privacy", {
          ip: null,
          headers: { "x-forwarded-for": `10.0.0.1, ${hop(i)}` },
        }),
      );
      await res.body?.cancel();
      if (res.status === 200) served += 1;
      if (h.accessLog.length > 500) h.accessLog.length = 0;
    }
  });
  const after = heapUsed();
  const delta = after - before;
  const path = await writeTable("memory_oversized_keys", {
    entries: n,
    hopBytes: 8_000,
    gcExposed: Boolean(gc),
    heapDeltaBytes: delta,
    heapDeltaPerEntryBytes: round(delta / n, 1),
    projectedAtCapMiB: round((delta / n) * MEMORY_WINDOW_MAX / 1024 / 1024, 1),
    served,
  });
  console.log(
    `[stress/legal] oversized keys ×${n}: Δ=${
      (delta / 1024 / 1024).toFixed(2)
    } MiB (${(delta / n).toFixed(0)} B/entry) → ${path}`,
  );
  assertEquals(served, n);
});
