// stress-route-get-v1-me-access / lens failure-load — LOAD + L1 MEMORY.
//
// Real handler, per-isolate mode (no Upstash), every upstream answering
// normally, seeded population of users with random access states.
//
//   wave 1  N distinct users, one COLD request each (auth verify + RPC)
//   wave 2  ITER requests over the hottest users (WARM: cached auth + RPC)
//           sequential, then BURST of them in one Promise.all
//   evict   user #0 again — with N > 5 000 the L1 auth cache (cap 5 000)
//           must have dropped it (bounded memory), so Auth is consulted again
//   memory  Deno.memoryUsage() at each stage
//
// Every response is checked against the seeded truth for its user (the
// access-state computation at scale), every request's Supabase round trips
// are counted (> 3 is a finding), p50/p95/p99 latency per phase is reported.
//
// Defaults are small so the suite stays fast; the campaign the report cites:
//   STRESS_USERS=20000 STRESS_ITER=1000 STRESS_BURST=100 \
//     deno test -A --no-check --config deno.json stress_v1_me_access_load.test.ts
// Replay is exact from STRESS_SEED (default 20260904). Report:
//   <STRESS_OUT_DIR|artifacts/stress-route-get-v1-me-access/latest/>load.json

import { assert, assertEquals } from "@std/assert";
import {
  accessInvariantViolations,
  accessRequest,
  caseSeed,
  envInt,
  histogram,
  latencySummary,
  loadStressHarness,
  observe,
  Prng,
  STRESS_SEED,
  type StressHarness,
  writeJson,
} from "./stress_access_harness.ts";

const USERS = envInt("STRESS_USERS", 300);
const ITER = envInt("STRESS_ITER", 300);
const BURST = envInt("STRESS_BURST", 50);
/** cache.ts MEMORY_MAX_ENTRIES — the L1 cap the eviction probe pins. */
const L1_CAP = 5_000;

interface Truth {
  id: string;
  token: string;
  ip: string;
  scored: number;
  reserved: number;
  premium: boolean;
}

interface Sample {
  i: number;
  user: number;
  status: number;
  ms: number;
  roundTrips: number;
  authCalls: number;
  dbCalls: number;
  violations: string[];
}

function expectedPayload(t: Truth) {
  const used = Math.min(2, t.scored);
  const remaining = 2 - used;
  const reserved = Math.min(t.reserved, remaining);
  const availableToReserve = remaining - reserved;
  const canStartRating = t.premium || availableToReserve > 0;
  return {
    premium: t.premium,
    entitlements: t.premium ? ["premium"] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

async function hit(h: StressHarness, t: Truth, i: number, user: number): Promise<Sample> {
  const o = await observe(h, accessRequest(t.token, t.ip), t.token);
  const violations: string[] = [];
  if (o.status !== 200) violations.push(`status ${o.status}: ${o.raw.slice(0, 120)}`);
  else {
    violations.push(...accessInvariantViolations(o.body));
    const want = JSON.stringify(expectedPayload(t));
    const got = JSON.stringify(o.body);
    if (want !== got) violations.push(`payload ${got} ≠ truth ${want}`);
  }
  if (o.roundTrips > 3) violations.push(`${o.roundTrips} Supabase round trips`);
  return {
    i,
    user,
    status: o.status,
    ms: o.durationMs,
    roundTrips: o.roundTrips,
    authCalls: o.authCalls,
    dbCalls: o.dbCalls,
    violations,
  };
}

function phaseSummary(samples: Sample[]) {
  return {
    requests: samples.length,
    latencyMs: latencySummary(samples.map((s) => s.ms)),
    statuses: histogram(samples.map((s) => s.status)),
    roundTrips: histogram(samples.map((s) => s.roundTrips)),
    maxRoundTrips: samples.reduce((m, s) => Math.max(m, s.roundTrips), 0),
    meanRoundTrips: samples.length
      ? Math.round((samples.reduce((a, s) => a + s.roundTrips, 0) / samples.length) * 1000) / 1000
      : NaN,
    violations: samples.filter((s) => s.violations.length).length,
    firstViolations: samples
      .filter((s) => s.violations.length)
      .slice(0, 10)
      .map((s) => ({ i: s.i, user: s.user, violations: s.violations })),
  };
}

/** Heap after a forced full GC when run with `--v8-flags=--expose-gc`
 * (otherwise whatever V8 has not collected yet — recorded as `gcForced`). */
const gcForced = typeof (globalThis as { gc?: () => void }).gc === "function";
const mem = () => {
  if (gcForced) (globalThis as unknown as { gc: () => void }).gc();
  const m = Deno.memoryUsage();
  return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
};

/** Drop the harness's own per-request logs so they are not what gets measured. */
function dropHarnessLogs(h: StressHarness): void {
  h.calls.length = 0;
  h.accessLog.length = 0;
  h.serverErrors.length = 0;
}

Deno.test(
  `stress load: ${USERS} users cold + ${ITER} warm + burst ${BURST} — latency, round trips, L1 bound`,
  async () => {
    const h = await loadStressHarness({ redis: false });
    h.reset();
    try {
      await campaign(h);
    } finally {
      h.teardown();
    }
  },
);

async function campaign(h: StressHarness): Promise<void> {
  const seed = caseSeed("load");
  const prng = new Prng(seed);
  const t0 = performance.now();
  const memory: Record<string, ReturnType<typeof mem>> = { start: mem() };

  // Population. IPs cycle through a /16 so no single address trips the
  // 1 200/min pre-auth budget even at 20k users.
  const truths: Truth[] = [];
  for (let i = 0; i < USERS; i++) {
    const id = prng.uuid();
    const t: Truth = {
      id,
      token: "",
      ip: `10.${(i >> 8) & 255}.${i & 255}.${1 + prng.int(0, 200)}`,
      scored: prng.int(0, 4),
      reserved: prng.int(0, 3),
      premium: prng.next() < 0.2,
    };
    h.registerUser({
      id,
      provider: prng.next() < 0.5 ? "google" : "apple",
      premium: t.premium,
      scored_count: t.scored,
      reserved_count: t.reserved,
    });
    t.token = h.mintSession(id);
    truths.push(t);
  }
  dropHarnessLogs(h);
  memory.populated = mem();

  // Wave 1 — cold.
  const cold: Sample[] = [];
  for (let i = 0; i < USERS; i++) cold.push(await hit(h, truths[i], i, i));
  const supabaseCallsAfterCold = h.calls.filter(
    (c) => c.upstream === "auth" || c.upstream === "db",
  ).length;
  dropHarnessLogs(h);
  memory.afterCold = mem();

  // Wave 2 — warm, sequential, over the hottest (most recently cached) users.
  const hot = truths.slice(Math.max(0, USERS - Math.min(USERS, 1_000)));
  const warm: Sample[] = [];
  for (let i = 0; i < ITER; i++) {
    const u = prng.int(0, hot.length - 1);
    warm.push(await hit(h, hot[u], i, USERS - hot.length + u));
  }
  dropHarnessLogs(h);
  memory.afterWarm = mem();

  // Burst — warm, concurrent, distinct users.
  // Distinct users (round trips are attributed per bearer, so a bearer in
  // flight twice would count the other request's RPC as its own).
  const burstPool = hot.map((_, i) => i);
  for (let i = burstPool.length - 1; i > 0; i--) {
    const j = prng.int(0, i);
    [burstPool[i], burstPool[j]] = [burstPool[j], burstPool[i]];
  }
  const burstUsers = burstPool.slice(0, Math.min(BURST, hot.length));
  const burstT0 = performance.now();
  const burst = await Promise.all(
    burstUsers.map((u, i) => hit(h, hot[u], i, USERS - hot.length + u)),
  );
  const burstWallMs = Math.round((performance.now() - burstT0) * 100) / 100;
  dropHarnessLogs(h);
  memory.afterBurst = mem();

  // Same user, burst — the per-user budget is 240/min; BURST must stay under.
  // Round trips are attributed per bearer, so with ONE bearer in flight N
  // times they are counted in aggregate (calls made / requests answered).
  const sameUser = hot[hot.length - 1];
  const sameCount = Math.min(BURST, 200);
  const sameBefore = h.calls.length;
  const sameBurstRaw = await Promise.all(
    Array.from({ length: sameCount }, (_, i) => hit(h, sameUser, i, USERS - 1)),
  );
  const sameCalls = h.calls
    .slice(sameBefore)
    .filter((c) => c.upstream === "auth" || c.upstream === "db");
  const sameRoundTripsPerRequest = sameCalls.length / sameCount;
  const sameBurst = sameBurstRaw.map((s) => ({
    ...s,
    roundTrips: sameRoundTripsPerRequest,
    violations: s.violations.filter((v) => !/Supabase round trips$/.test(v)),
  }));
  if (sameRoundTripsPerRequest > 3) {
    sameBurst[0].violations.push(
      `${sameRoundTripsPerRequest} Supabase round trips per request (aggregate)`,
    );
  }

  // Eviction probe — user #0 was cached first; with USERS > L1_CAP the
  // bounded L1 must have evicted it (Auth consulted again), otherwise it is
  // still a hit (no Auth call).
  h.calls.length = 0;
  const probe = await observe(h, accessRequest(truths[0].token, truths[0].ip), truths[0].token);
  const evicted = probe.authCalls === 1;
  const evictionExpected = USERS > L1_CAP;
  dropHarnessLogs(h);
  memory.afterProbe = mem();

  const all = [...cold, ...warm, ...burst, ...sameBurst];
  const violations = all.filter((s) => s.violations.length);
  const durationMs = Math.round(performance.now() - t0);

  const report = {
    unit: "route-get-v1-me-access",
    lens: "failure-load",
    seed,
    stressSeed: STRESS_SEED,
    redis: false,
    scale: { users: USERS, iter: ITER, burst: BURST, l1Cap: L1_CAP },
    gcForced,
    requests: all.length + 1,
    phases: {
      cold: phaseSummary(cold),
      warm: phaseSummary(warm),
      burst: {
        ...phaseSummary(burst),
        wallMs: burstWallMs,
        throughputRps: Math.round((burst.length / burstWallMs) * 1000),
      },
      sameUserBurst: {
        ...phaseSummary(sameBurst),
        aggregateSupabaseCalls: sameCalls.length,
        roundTripsPerRequest: sameRoundTripsPerRequest,
      },
    },
    supabaseRoundTripsPerColdRequest: USERS ? supabaseCallsAfterCold / USERS : NaN,
    hotPathOver3RoundTrips: all.filter((s) => s.roundTrips > 3).length,
    eviction: {
      expected: evictionExpected,
      observed: evicted,
      probeStatus: probe.status,
      probeAuthCalls: probe.authCalls,
      probeRoundTrips: probe.roundTrips,
      holds: evicted === evictionExpected,
    },
    memory,
    memoryDeltas: {
      coldHeapUsedBytes: memory.afterCold.heapUsed - memory.populated.heapUsed,
      coldRssBytes: memory.afterCold.rss - memory.populated.rss,
      warmHeapUsedBytes: memory.afterWarm.heapUsed - memory.afterCold.heapUsed,
      totalHeapUsedBytes: memory.afterProbe.heapUsed - memory.start.heapUsed,
      totalRssBytes: memory.afterProbe.rss - memory.start.rss,
      heapUsedPerDistinctUserBytes: USERS
        ? Math.round((memory.afterCold.heapUsed - memory.populated.heapUsed) / USERS)
        : NaN,
      /** cold-phase heap growth over the entries the L1 can hold (auth cache
       * cap 5 000 + one rate-limit window per IP and per user). */
      heapUsedPerRetainedL1EntryBytes: Math.round(
        (memory.afterCold.heapUsed - memory.populated.heapUsed) /
          (Math.min(USERS, L1_CAP) + 2 * USERS),
      ),
    },
    violations: violations.length,
    firstViolations: violations.slice(0, 20),
    durationMs,
    replay: `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${USERS} STRESS_ITER=${ITER} STRESS_BURST=${BURST} deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_v1_me_access_load.test.ts`,
  };
  const path = await writeJson("load", report);
  console.log(
    `[stress] load: ${report.requests} req in ${durationMs}ms — cold p50=${report.phases.cold.latencyMs.p50}ms p95=${report.phases.cold.latencyMs.p95}ms rt=${JSON.stringify(report.phases.cold.roundTrips)} | warm p50=${report.phases.warm.latencyMs.p50}ms p95=${report.phases.warm.latencyMs.p95}ms rt=${JSON.stringify(report.phases.warm.roundTrips)} | burst ${BURST} in ${burstWallMs}ms | evicted=${evicted} (expected ${evictionExpected}) | heapUsed ${memory.start.heapUsed}→${memory.afterProbe.heapUsed} rss ${memory.start.rss}→${memory.afterProbe.rss} → ${path}`,
  );

  assertEquals(
    violations.length,
    0,
    `${violations.length} requests violated: ${JSON.stringify(violations.slice(0, 3))}`,
  );
  assertEquals(report.hotPathOver3RoundTrips, 0, "a request cost more than 3 Supabase round trips");
  assert(
    cold.every((s) => s.roundTrips === 2),
    "cold path is exactly auth verify + access_state",
  );
  assert(
    warm.every((s) => s.roundTrips === 1),
    "warm path is exactly access_state",
  );
  assertEquals(probe.status, 200);
  assertEquals(
    evicted,
    evictionExpected,
    `L1 eviction: expected ${evictionExpected}, observed ${evicted}`,
  );
}
