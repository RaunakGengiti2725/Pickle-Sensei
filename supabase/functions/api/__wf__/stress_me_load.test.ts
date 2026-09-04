// stress-route-get-v1-me / lens failure-load — LOAD for GET /v1/me.
//
// The REAL handler (../index.ts via stress_me_harness.ts, Redis-enabled
// isolate, in-process fakes for Supabase Auth / PostgREST / Upstash) under:
//
//   1. latency campaign — STRESS_LOAD_REQ requests (default 1000) from
//      STRESS_LOAD_USERS users (default 50) in batches of STRESS_CONCURRENCY
//      (default 16): p50/p95/p99 overall and split cold (first request of a
//      bearer: auth verify + profile read) vs warm (auth from cache). The
//      Supabase round-trip count is asserted exactly per batch: one Auth call
//      per cold bearer, one PostgREST call per request, never more. A hot
//      path above 3 Supabase round trips is a finding.
//   2. burst — one user fires 300 requests inside one 60 s window: exactly
//      USER_RATE_LIMIT (240) succeed, the rest are 429 + Retry-After, and the
//      window resets after 60 s (clock shifted, no sleeping).
//   3. L1 memory — STRESS_USERS distinct cold bearers (default 2000; the
//      campaign runs 20000) with Redis UNREACHABLE so L1 is the only cache:
//      heap before/after (gc() when the run has --v8-flags=--expose-gc), the
//      L1 cap observed from outside (the first bearer is evicted → verified
//      again upstream; the last bearer is still an L1 hit) and the in-memory
//      rate-limit fallback's behaviour past its 20 000-window cap.
//
//   cd supabase/functions/api/__wf__ && deno task test --filter stress-me-load
//   STRESS_USERS=20000 STRESS_LOAD_REQ=2000 deno test -A --no-check --config deno.json \
//     --v8-flags=--expose-gc stress_me_load.test.ts
//
// Artifacts: artifacts/stress-me/latest/{load_latency,load_burst,load_l1_memory}.json

import { assert, assertEquals } from "@std/assert";
import {
  callMe,
  envInt,
  freshIp,
  heap,
  latencySummary,
  loadStressHarness,
  meBodyProblems,
  meRequest,
  OK,
  Prng,
  replayCommand,
  STRESS_SEED,
  type StressHarness,
  withClockOffset,
  writeArtifact,
} from "./stress_me_harness.ts";

const LOAD_REQ = envInt("STRESS_LOAD_REQ", 1000);
const LOAD_USERS = envInt("STRESS_LOAD_USERS", 50);
const CONCURRENCY = Math.max(1, envInt("STRESS_CONCURRENCY", 16));
const L1_USERS = envInt("STRESS_USERS", 2000);
/** index.ts USER_RATE_LIMIT / L1 cap in cache.ts / window cap in rateLimit.ts. */
const USER_LIMIT_PER_MINUTE = 240;
const L1_MAX_ENTRIES = 5_000;
const MEMORY_WINDOW_MAX = 20_000;

const forceGc = (): boolean => {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc !== "function") return false;
  maybeGc();
  return true;
};

interface Bearer {
  index: number;
  userId: string;
  token: string;
  ip: string;
  requests: number;
}

function mintBearers(h: StressHarness, prng: Prng, count: number): Bearer[] {
  const bearers: Bearer[] = [];
  for (let index = 0; index < count; index += 1) {
    const userId = prng.uuid();
    h.registerUser(userId);
    bearers.push({
      index,
      userId,
      token: h.mintSession(userId).accessToken,
      ip: freshIp(),
      requests: 0,
    });
  }
  return bearers;
}

// ── 1. latency + round trips ─────────────────────────────────────────────────

interface LatencyRow {
  i: number;
  seed: number;
  user: number;
  cold: boolean;
  status: number;
  ms: number;
}

Deno.test(`stress-me-load latency: ${LOAD_REQ} requests, ${LOAD_USERS} users, concurrency ${CONCURRENCY} — p50/p95 + Supabase round trips per request`, async () => {
  const h = await loadStressHarness({ redis: true });
  h.recordCalls = false;
  h.captureLogs = false;
  const prng = new Prng(STRESS_SEED);
  const bearers = mintBearers(h, prng, LOAD_USERS);
  const rows: LatencyRow[] = [];
  const problems: string[] = [];
  let maxBatchRoundTripsPerRequest = 0;
  let stampedeAuthCalls = 0;

  for (let start = 0; start < LOAD_REQ; start += CONCURRENCY) {
    const size = Math.min(CONCURRENCY, LOAD_REQ - start);
    const picks: Bearer[] = [];
    for (let k = 0; k < size; k += 1) {
      // Per-request seed: replayable choice of bearer.
      const seed = (STRESS_SEED + (start + k) * 0x9e3779b1) >>> 0;
      picks.push(bearers[new Prng(seed).int(0, bearers.length - 1)]);
    }
    // A bearer is cold until a request of it has COMPLETED; every request of a
    // bearer inside its first batch is cold (nothing has written the cache
    // yet), so an uncoalesced verify per concurrent first request is expected
    // upstream accounting and counted separately as a stampede.
    const coldFlags = picks.map((b) => b.requests === 0);
    const seenInBatch = new Set<number>();
    let stampede = 0;
    picks.forEach((b, k) => {
      if (coldFlags[k] && seenInBatch.has(b.index)) stampede += 1;
      seenInBatch.add(b.index);
    });
    picks.forEach((b) => (b.requests += 1));
    const coldRequests = coldFlags.filter(Boolean).length;
    stampedeAuthCalls += stampede;
    h.mark();
    const results = await Promise.all(
      picks.map(async (b) => {
        const t0 = performance.now();
        const response = await h.handler(
          meRequest({ token: b.token, ip: b.ip }),
        );
        const text = await response.text();
        return {
          status: response.status,
          ms: Math.round((performance.now() - t0) * 100) / 100,
          text,
          b,
        };
      }),
    );
    const counts = h.snapshot();
    results.forEach((r, k) => {
      const i = start + k;
      rows.push({
        i,
        seed: (STRESS_SEED + i * 0x9e3779b1) >>> 0,
        user: r.b.index,
        cold: coldFlags[k],
        status: r.status,
        ms: r.ms,
      });
      if (r.status !== 200) {
        problems.push(`request ${i} (user ${r.b.index}) → ${r.status}`);
      } else {
        const bodyProblems = meBodyProblems(JSON.parse(r.text), r.b.userId);
        if (bodyProblems.length) {
          problems.push(`request ${i}: ${bodyProblems.join("; ")}`);
        }
      }
    });
    // Exact upstream accounting for the batch.
    if (counts.rest !== size) {
      problems.push(
        `batch@${start}: ${counts.rest} PostgREST calls for ${size} requests`,
      );
    }
    // Duplicate cold bearers in one batch verify 1..n times depending on how
    // the in-process fakes interleave; anything outside that band is a bug.
    if (counts.auth > coldRequests || counts.auth < coldRequests - stampede) {
      problems.push(
        `batch@${start}: ${counts.auth} Auth calls for ${coldRequests} cold requests (${stampede} duplicates)`,
      );
    }
    if (counts.rc !== 0) {
      problems.push(`batch@${start}: RevenueCat called ${counts.rc}×`);
    }
    maxBatchRoundTripsPerRequest = Math.max(
      maxBatchRoundTripsPerRequest,
      (counts.auth + counts.rest) / size,
    );
  }

  const all = rows.map((r) => r.ms);
  const cold = rows.filter((r) => r.cold).map((r) => r.ms);
  const warm = rows.filter((r) => !r.cold).map((r) => r.ms);
  const summary = {
    unit: "route-get-v1-me",
    lens: "failure-load",
    seed: STRESS_SEED,
    requests: rows.length,
    users: LOAD_USERS,
    concurrency: CONCURRENCY,
    redis: true,
    statusCounts: rows.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
      {},
    ),
    latencyMs: {
      all: latencySummary(all),
      cold: latencySummary(cold),
      warm: latencySummary(warm),
    },
    supabaseRoundTrips: {
      coldPerRequest: 2,
      warmPerRequest: 1,
      maxObservedPerRequestInABatch:
        Math.round(maxBatchRoundTripsPerRequest * 100) / 100,
      hotPathAbove3: maxBatchRoundTripsPerRequest > 3,
      /** Auth verifies that a single-flight per bearer would have saved. */
      stampedeAuthCalls,
    },
    replay: replayCommand(
      "stress-me-load latency",
      STRESS_SEED,
      `STRESS_LOAD_REQ=${LOAD_REQ} STRESS_LOAD_USERS=${LOAD_USERS} STRESS_CONCURRENCY=${CONCURRENCY} `,
    ),
    problems,
    rows,
  };
  const path = await writeArtifact("load_latency.json", summary);
  console.log(
    `[stress-me-load] ${rows.length} requests: p50 ${summary.latencyMs.all.p50} ms, p95 ${summary.latencyMs.all.p95} ms (cold p95 ${summary.latencyMs.cold.p95}, warm p95 ${summary.latencyMs.warm.p95}); max Supabase round trips/request ${summary.supabaseRoundTrips.maxObservedPerRequestInABatch} → ${path}`,
  );
  assertEquals(rows.length, LOAD_REQ);
  assertEquals(problems, []);
  assert(
    maxBatchRoundTripsPerRequest <= 3,
    `hot path did ${maxBatchRoundTripsPerRequest} Supabase round trips per request`,
  );
});

// ── 1b. cold-start stampede: parallel first requests of ONE fresh bearer ─────

Deno.test("stress-me-load stampede: 8 parallel first requests of one fresh bearer with realistic upstream latency — Auth verifies are not coalesced (observe)", async () => {
  const h = await loadStressHarness({ redis: true });
  h.recordCalls = false;
  h.captureLogs = false;
  // Realistic wire latency so the eight requests overlap the way the app's
  // launch fan-out does (instant fakes finish one verify before the next
  // request even reads the cache, hiding the stampede).
  const upstreamLatencyMs = { auth: 40, redis: 3, rest: 10 };
  h.faults = {
    auth: { kind: "slow", ms: upstreamLatencyMs.auth },
    redis: { kind: "slow", ms: upstreamLatencyMs.redis },
    rest: { kind: "slow", ms: upstreamLatencyMs.rest },
    rc: OK,
  };
  const prng = new Prng(STRESS_SEED ^ 0x5741);
  const [b] = mintBearers(h, prng, 1);
  const parallel = 8;
  h.mark();
  const statuses = await Promise.all(
    Array.from({ length: parallel }, async () => {
      const response = await h.handler(meRequest({ token: b.token, ip: b.ip }));
      await response.text();
      return response.status;
    }),
  );
  const counts = h.snapshot();
  // Once the cache is written the same bearer is served without Auth.
  const warm = await callMe(h, meRequest({ token: b.token, ip: b.ip }));
  const path = await writeArtifact("load_stampede.json", {
    unit: "route-get-v1-me",
    lens: "failure-load",
    seed: STRESS_SEED ^ 0x5741,
    parallelFirstRequests: parallel,
    upstreamLatencyMs,
    statuses,
    upstream: counts,
    authVerifiesPerParallelRequest: counts.auth / parallel,
    warmAfter: { status: warm.status, counts: warm.counts },
    replay: replayCommand("stress-me-load stampede", STRESS_SEED),
  });
  h.faults = { auth: OK, rest: OK, redis: OK, rc: OK };
  console.log(
    `[stress-me-load] stampede: ${parallel} parallel cold requests → ${counts.auth} Auth verifies, ${counts.rest} PostgREST reads; warm after: auth ${warm.counts.auth} → ${path}`,
  );
  assertEquals(statuses, Array.from({ length: parallel }, () => 200));
  assertEquals(counts.rest, parallel);
  assertEquals(warm.status, 200);
  assertEquals(warm.counts.auth, 0);
  assert(
    counts.auth >= 1 && counts.auth <= parallel,
    `Auth verifies ${counts.auth}`,
  );
});

// ── 2. burst against the per-user budget ─────────────────────────────────────

Deno.test("stress-me-load burst: 300 requests from one user in one window → exactly 240 succeed, 60 are 429 + Retry-After, window resets", async () => {
  const h = await loadStressHarness({ redis: true });
  h.recordCalls = false;
  h.captureLogs = false;
  const prng = new Prng(STRESS_SEED ^ 0x0badf00d);
  const [b] = mintBearers(h, prng, 1);
  const statuses: number[] = [];
  const retryAfters: string[] = [];
  const problems: string[] = [];
  // Run inside one aligned 60 s bucket so the window cannot roll mid-burst.
  const bucketStartMs = Math.floor(Date.now() / 60_000) * 60_000;
  await withClockOffset(bucketStartMs + 1_000 - Date.now(), async () => {
    for (let i = 0; i < 300; i += CONCURRENCY) {
      const size = Math.min(CONCURRENCY, 300 - i);
      const batch = await Promise.all(
        Array.from({ length: size }, async () => {
          const response = await h.handler(
            meRequest({ token: b.token, ip: b.ip }),
          );
          await response.text();
          return response;
        }),
      );
      for (const response of batch) {
        statuses.push(response.status);
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (!retryAfter) problems.push("429 without Retry-After");
          else retryAfters.push(retryAfter);
        }
      }
    }
  });
  const ok = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  const other = statuses.filter((s) => s !== 200 && s !== 429);
  // Next window: the same bearer is served again.
  const afterWindow = await withClockOffset(
    bucketStartMs + 61_000 - Date.now(),
    () => callMe(h, meRequest({ token: b.token, ip: b.ip })),
  );
  const path = await writeArtifact("load_burst.json", {
    unit: "route-get-v1-me",
    lens: "failure-load",
    seed: STRESS_SEED ^ 0x0badf00d,
    requests: statuses.length,
    concurrency: CONCURRENCY,
    ok,
    limited,
    other,
    retryAfterSeconds: [...new Set(retryAfters)].map(Number).sort((a, c) =>
      a - c
    ),
    nextWindowStatus: afterWindow.status,
    replay: replayCommand("stress-me-load burst", STRESS_SEED),
    problems,
  });
  console.log(
    `[stress-me-load] burst: ${ok}×200, ${limited}×429, other ${
      JSON.stringify(other)
    }, next window ${afterWindow.status} → ${path}`,
  );
  assertEquals(problems, []);
  assertEquals(other, []);
  assertEquals(ok, USER_LIMIT_PER_MINUTE);
  assertEquals(limited, 300 - USER_LIMIT_PER_MINUTE);
  assertEquals(afterWindow.status, 200);
  assert(
    retryAfters.every((s) => Number(s) >= 1 && Number(s) <= 60),
    `Retry-After outside the window: ${[...new Set(retryAfters)].join(",")}`,
  );
});

// ── 3. L1 memory under many distinct users (Redis unreachable) ───────────────

Deno.test(`stress-me-load L1 memory: ${L1_USERS} distinct cold bearers with Redis unreachable (STRESS_USERS)`, async () => {
  const h = await loadStressHarness({ redis: true });
  h.recordCalls = false;
  h.captureLogs = false;
  h.faults = { auth: OK, rest: OK, redis: { kind: "network" }, rc: OK };
  const prng = new Prng(STRESS_SEED ^ 0x1e55e5);
  const problems: string[] = [];

  // A "canary" heavy user before the flood: spends 200 of its 240/min budget.
  const [heavy] = mintBearers(h, prng, 1);
  const bucketStartMs = Math.floor(Date.now() / 60_000) * 60_000;
  const clock = bucketStartMs + 1_000 - Date.now();
  const heavyBefore = { ok: 0, limited: 0 };
  await withClockOffset(clock, async () => {
    for (let i = 0; i < 200; i += 1) {
      const r = await callMe(
        h,
        meRequest({ token: heavy.token, ip: heavy.ip }),
      );
      if (r.status === 200) heavyBefore.ok += 1;
      else if (r.status === 429) heavyBefore.limited += 1;
      else problems.push(`heavy warm-up ${r.status}`);
    }
  });

  // Mint every bearer (fake Auth/PostgREST state) BEFORE the baseline so the
  // heap delta is what the handler retained: L1 rows + rate-limit windows.
  const bearers = mintBearers(h, prng, L1_USERS);
  const gcForced = forceGc();
  const heapBefore = heap();
  const startedAt = performance.now();
  const durations: number[] = [];
  const statusCounts: Record<string, number> = {};
  let authCalls = 0;
  let restCalls = 0;
  await withClockOffset(clock, async () => {
    for (let start = 0; start < bearers.length; start += CONCURRENCY) {
      const batch = bearers.slice(start, start + CONCURRENCY);
      h.mark();
      const results = await Promise.all(
        batch.map(async (b) => {
          const t0 = performance.now();
          const response = await h.handler(
            meRequest({ token: b.token, ip: b.ip }),
          );
          await response.text();
          return { status: response.status, ms: performance.now() - t0 };
        }),
      );
      const counts = h.snapshot();
      authCalls += counts.auth;
      restCalls += counts.rest;
      for (const r of results) {
        durations.push(r.ms);
        statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      }
    }
  });
  const floodMs = performance.now() - startedAt;
  forceGc();
  const heapAfter = heap();

  // L1 cap observed from outside: Redis is unreachable, so a warm request
  // answers from L1 (0 Auth calls) only while the entry survived eviction.
  const probe = async (b: Bearer) => {
    const r = await withClockOffset(
      clock,
      () => callMe(h, meRequest({ token: b.token, ip: b.ip })),
    );
    return { status: r.status, authCalls: r.counts.auth };
  };
  const first = await probe(bearers[0]);
  const last = await probe(bearers[bearers.length - 1]);
  const expectEvicted = L1_USERS > L1_MAX_ENTRIES;
  if (first.status !== 200) {
    problems.push(`first bearer re-probe ${first.status}`);
  }
  if (last.status !== 200) problems.push(`last bearer re-probe ${last.status}`);
  if (expectEvicted && first.authCalls !== 1) {
    problems.push(
      `first bearer should have been evicted from L1 (auth calls ${first.authCalls})`,
    );
  }
  if (!expectEvicted && first.authCalls !== 0) {
    problems.push(
      `first bearer should still be in L1 (auth calls ${first.authCalls})`,
    );
  }
  if (last.authCalls !== 0) {
    problems.push(
      `last bearer should be an L1 hit (auth calls ${last.authCalls})`,
    );
  }

  // Heavy user after the flood: with the in-memory fallback intact it has 40
  // requests left in this window; if the fallback cleared its 20 000-window
  // map during the flood, the budget silently restarted.
  const heavyAfter = { ok: 0, limited: 0 };
  await withClockOffset(clock, async () => {
    for (let i = 0; i < 100; i += 1) {
      const r = await callMe(
        h,
        meRequest({ token: heavy.token, ip: heavy.ip }),
      );
      if (r.status === 200) heavyAfter.ok += 1;
      else if (r.status === 429) heavyAfter.limited += 1;
      else problems.push(`heavy after-flood ${r.status}`);
    }
  });
  const windowsTouchedByFlood = 2 * L1_USERS; // ip + user window per cold bearer
  const fallbackMayHaveCleared = windowsTouchedByFlood + 2 >= MEMORY_WINDOW_MAX;
  const budgetHeld = heavyBefore.ok + heavyAfter.ok === USER_LIMIT_PER_MINUTE;

  h.faults = { auth: OK, rest: OK, redis: OK, rc: OK };
  const path = await writeArtifact("load_l1_memory.json", {
    unit: "route-get-v1-me",
    lens: "failure-load",
    seed: STRESS_SEED ^ 0x1e55e5,
    users: bearers.length,
    concurrency: CONCURRENCY,
    redis:
      "unreachable (network fault) — L1 + in-memory rate-limit fallback only",
    floodMs: Math.round(floodMs),
    statusCounts,
    upstream: {
      authCalls,
      restCalls,
      perUser: {
        auth: authCalls / bearers.length,
        rest: restCalls / bearers.length,
      },
    },
    latencyMs: latencySummary(durations),
    heap: {
      gcForced,
      before: heapBefore,
      after: heapAfter,
      heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
      rssDeltaBytes: heapAfter.rss - heapBefore.rss,
      heapUsedDeltaPerUserBytes: Math.round(
        (heapAfter.heapUsed - heapBefore.heapUsed) / bearers.length,
      ),
    },
    l1: {
      maxEntries: L1_MAX_ENTRIES,
      expectEvicted,
      firstBearerReprobe: first,
      lastBearerReprobe: last,
    },
    rateLimitFallback: {
      memoryWindowMax: MEMORY_WINDOW_MAX,
      windowsTouchedByFlood,
      fallbackMayHaveCleared,
      heavyUser: {
        before: heavyBefore,
        after: heavyAfter,
        totalOk: heavyBefore.ok + heavyAfter.ok,
        limit: USER_LIMIT_PER_MINUTE,
        budgetHeld,
      },
    },
    replay: replayCommand(
      "stress-me-load L1",
      STRESS_SEED,
      `STRESS_USERS=${L1_USERS} `,
    ),
    problems,
  });
  console.log(
    `[stress-me-load] L1: ${bearers.length} users in ${
      Math.round(floodMs)
    } ms, heapUsed Δ ${
      (heapAfter.heapUsed - heapBefore.heapUsed) / 1e6
    } MB (gc ${gcForced}), first bearer auth=${first.authCalls}, last auth=${last.authCalls}, heavy user ${heavyBefore.ok}+${heavyAfter.ok} ok of 300 (limit 240) → ${path}`,
  );
  assertEquals(problems, []);
  assertEquals(statusCounts, { "200": bearers.length });
  assertEquals(authCalls, bearers.length);
  assertEquals(restCalls, bearers.length);
  if (!fallbackMayHaveCleared) {
    assert(
      budgetHeld,
      `per-user budget: ${
        heavyBefore.ok + heavyAfter.ok
      } ok of 300 (limit ${USER_LIMIT_PER_MINUTE})`,
    );
  }
});
