// STRESS · load for GET /v1/me/saved-drills through the real handler with
// stubbed upstreams (Redis unconfigured → per-isolate L1 + memory limiter):
//   1. ≥ STRESS_ITER warm requests: p50/p95 latency and Supabase round trips
//      per request (>3 on the hot path is a finding);
//   2. STRESS_USERS distinct users cold: L1 auth-cache + rate-limit window
//      memory, eviction behaviour at the 5 000-entry bound, and that the
//      per-request round-trip count is flat across the user population.
//
//   STRESS_ITER=1000 STRESS_USERS=20000 deno test -A --no-check --config deno.json \
//     --v8-flags=--expose-gc stress_saved_drills_load.test.ts
// Defaults keep the file inside the suite budget (1 000 requests / 6 000 users).
// With --expose-gc the heap is collected before each snapshot and the retained
// delta is asserted tightly; without it (plain `deno task test`) V8's sawtooth
// is recorded and the assertion falls back to the post-collection floor.

import { assert, assertEquals } from "@std/assert";
import {
  assertHydrated,
  catalogSlugs,
  seedRows,
} from "./stress_saved_drills_cases.ts";
import {
  caseSeed,
  envInt,
  histogram,
  latencySummary,
  loadStressHarness,
  memorySnapshot,
  Prng,
  replayCommand,
  run,
  savedDrillsRequest,
  sessionBearer,
  STRESS_ITER,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const FILE = "stress_saved_drills_load.test.ts";
const LOAD_USERS = envInt("STRESS_USERS", 6000);
/** GENERAL_USER_LIMIT in index.ts (240/min): requests per user stay under it. */
const PER_USER_BUDGET = 200;
/** cache.ts MEMORY_MAX_ENTRIES: the L1 bound the 20k-user campaign must respect. */
const L1_MAX_ENTRIES = 5_000;

const forceGc: (() => void) | null =
  typeof (globalThis as { gc?: unknown }).gc === "function"
    ? () => (globalThis as unknown as { gc: () => void }).gc()
    : null;
function collectedSnapshot() {
  forceGc?.();
  return memorySnapshot();
}

Deno.test(`stress saved-drills load: ${STRESS_ITER} warm requests, p50/p95 + round trips`, async () => {
  const state = await loadStressHarness();
  const seed = caseSeed("load-warm");
  const prng = new Prng(seed);
  const slugs = await catalogSlugs();
  const users = Array.from(
    { length: Math.ceil(STRESS_ITER / PER_USER_BUDGET) },
    () => {
      const userId = prng.uuid();
      const rows = seedRows(prng, slugs, prng.int(0, 8));
      state.savedDrills.set(userId, rows);
      return {
        userId,
        rows,
        ip: prng.ip(),
        bearer: sessionBearer(state, userId),
      };
    },
  );

  const coldLatencies: number[] = [];
  const coldTrips: string[] = [];
  for (const u of users) {
    const r = await run(
      state,
      savedDrillsRequest(u.bearer, { ip: u.ip }),
      "load-cold",
    );
    assertEquals(r.status, 200, "cold request");
    assertHydrated(r.body, u.rows, slugs);
    coldLatencies.push(r.latencyMs);
    coldTrips.push(`auth=${r.roundTrips.auth} db=${r.roundTrips.db}`);
    state.calls.length = 0;
  }

  const latencies: number[] = [];
  const supabaseTrips: number[] = [];
  const tripShapes: string[] = [];
  const statuses: number[] = [];
  let executed = 0;
  for (let i = 0; i < STRESS_ITER; i++) {
    const u = users[i % users.length];
    const r = await run(
      state,
      savedDrillsRequest(u.bearer, { ip: u.ip }),
      `load-${i}`,
    );
    executed += 1;
    statuses.push(r.status);
    latencies.push(r.latencyMs);
    supabaseTrips.push(r.roundTrips.auth + r.roundTrips.db);
    tripShapes.push(
      `auth=${r.roundTrips.auth} db=${r.roundTrips.db} redis=${r.roundTrips.redis} rc=${r.roundTrips.revenuecat}`,
    );
    if (r.status === 200 && i % 97 === 0) assertHydrated(r.body, u.rows, slugs);
    state.calls.length = 0;
  }

  const report = {
    seed,
    replay: replayCommand(FILE, "warm requests", { STRESS_ITER }),
    users: users.length,
    requestsExecuted: executed,
    statuses: histogram(statuses),
    cold: {
      latency: latencySummary(coldLatencies),
      roundTrips: histogram(coldTrips),
    },
    warm: {
      latency: latencySummary(latencies),
      supabaseRoundTripsPerRequest: histogram(supabaseTrips),
      roundTripShapes: histogram(tripShapes),
      maxSupabaseRoundTrips: Math.max(...supabaseTrips),
    },
  };
  const path = await writeJson("load_warm.json", report);
  console.log(
    `[stress] wrote ${path}: warm ${
      JSON.stringify(report.warm.latency)
    } trips ${JSON.stringify(report.warm.supabaseRoundTripsPerRequest)}`,
  );

  assertEquals(executed, STRESS_ITER);
  assertEquals(
    report.statuses,
    { "200": STRESS_ITER },
    "every warm request succeeds",
  );
  assertEquals(
    report.cold.roundTrips,
    { [`auth=1 db=1`]: users.length },
    "cold: 1 Auth + 1 PostgREST",
  );
  assertEquals(
    report.warm.supabaseRoundTripsPerRequest,
    { "1": STRESS_ITER },
    "warm: exactly 1 Supabase round trip",
  );
  assert(
    report.warm.maxSupabaseRoundTrips <= 3,
    "hot path ≤ 3 Supabase round trips",
  );
});

Deno.test(`stress saved-drills load: ${LOAD_USERS} distinct users, L1 cache + limiter memory`, async () => {
  const state = await loadStressHarness();
  const seed = caseSeed("load-users");
  const prng = new Prng(seed);
  const slugs = await catalogSlugs();
  const rows = seedRows(prng, slugs, 3);

  // Seed the fake Auth/DB first so their memory is excluded from the delta.
  const users: Array<{ bearer: string; ip: string }> = [];
  for (let i = 0; i < LOAD_USERS; i++) {
    const userId = prng.uuid();
    state.savedDrills.set(userId, rows);
    users.push({ bearer: sessionBearer(state, userId), ip: prng.ip() });
  }
  const before = collectedSnapshot();

  const startedAt = performance.now();
  const latencies: number[] = [];
  const trips: string[] = [];
  const statuses: number[] = [];
  const checkpoints: Array<
    { users: number; heapUsedMb: number; rssMb: number }
  > = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const r = await run(
      state,
      savedDrillsRequest(u.bearer, { ip: u.ip }),
      `users-${i}`,
    );
    statuses.push(r.status);
    latencies.push(r.latencyMs);
    trips.push(`auth=${r.roundTrips.auth} db=${r.roundTrips.db}`);
    state.calls.length = 0;
    if ((i + 1) % 2500 === 0 || i + 1 === users.length) {
      const m = collectedSnapshot();
      checkpoints.push({
        users: i + 1,
        heapUsedMb: m.heapUsedMb,
        rssMb: m.rssMb,
      });
    }
  }
  const wallMs = performance.now() - startedAt;
  const after = collectedSnapshot();
  // Without --expose-gc the sawtooth's lowest post-`before` reading is the
  // best available floor for what the route retained.
  const retainedFloorMb = Math.round(
    (Math.min(...checkpoints.map((c) => c.heapUsedMb)) - before.heapUsedMb) *
      100,
  ) / 100;

  // L1 residency probe: the most recent users must still be cached (0 Auth
  // calls); once the population exceeds the bound, the earliest were evicted.
  const probe = async (
    slice: Array<{ bearer: string; ip: string }>,
    tag: string,
  ) => {
    let authCalls = 0;
    for (const u of slice) {
      const r = await run(
        state,
        savedDrillsRequest(u.bearer, { ip: u.ip }),
        tag,
      );
      assertEquals(r.status, 200);
      authCalls += r.roundTrips.auth;
      state.calls.length = 0;
    }
    return authCalls;
  };
  const newestAuthCalls = await probe(users.slice(-100), "probe-newest");
  const oldestAuthCalls = await probe(users.slice(0, 100), "probe-oldest");

  const report = {
    seed,
    replay: replayCommand(FILE, "distinct users", { STRESS_USERS: LOAD_USERS })
      .replace(
        "--config deno.json",
        "--config deno.json --v8-flags=--expose-gc",
      ),
    users: LOAD_USERS,
    requestsExecuted: statuses.length + 200,
    wallMs: Math.round(wallMs),
    statuses: histogram(statuses),
    roundTrips: histogram(trips),
    latency: latencySummary(latencies),
    memory: {
      gcForced: forceGc !== null,
      before,
      after,
      heapUsedDeltaMb:
        Math.round((after.heapUsedMb - before.heapUsedMb) * 100) / 100,
      retainedFloorMb,
      rssDeltaMb: Math.round((after.rssMb - before.rssMb) * 100) / 100,
      checkpoints,
      note:
        "delta = route-side state (L1 auth cache ≤ 5 000 entries, limiter windows ≤ 20 000); the fake Auth/DB tables are allocated before `before`. Only meaningful with gcForced=true.",
    },
    l1Residency: {
      newest100AuthCalls: newestAuthCalls,
      oldest100AuthCalls: oldestAuthCalls,
      bound: L1_MAX_ENTRIES,
      exceededBound: LOAD_USERS > L1_MAX_ENTRIES,
    },
  };
  const path = await writeJson("load_users.json", report);
  console.log(
    `[stress] wrote ${path}: ${
      JSON.stringify({
        wallMs: report.wallMs,
        memory: report.memory.heapUsedDeltaMb,
        l1: report.l1Residency,
      })
    }`,
  );

  assertEquals(
    report.statuses,
    { "200": LOAD_USERS },
    "every distinct user succeeds",
  );
  assertEquals(
    report.roundTrips,
    { "auth=1 db=1": LOAD_USERS },
    "every cold user costs exactly 1 Auth + 1 PostgREST",
  );
  assertEquals(
    newestAuthCalls,
    0,
    "the 100 most recent users are served from L1",
  );
  if (LOAD_USERS > L1_MAX_ENTRIES) {
    assertEquals(
      oldestAuthCalls,
      100,
      "the 100 earliest users were evicted from L1 (bounded cache)",
    );
  } else {
    assertEquals(oldestAuthCalls, 0, "under the bound nothing is evicted");
  }
  // The route-side maps are bounded (5 000 + 20 000 entries): retained heap
  // must not scale with the user population. 64 MB leaves headroom over the
  // collected footprint (see load_users.json) and sits far under the 150 MB
  // edge-isolate ceiling.
  const retainedMb = forceGc ? report.memory.heapUsedDeltaMb : retainedFloorMb;
  assert(
    retainedMb < 64,
    `retained heap ${retainedMb} MB across ${LOAD_USERS} users (gcForced=${
      forceGc !== null
    })`,
  );
});
