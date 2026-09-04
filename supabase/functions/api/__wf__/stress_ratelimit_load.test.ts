// stress-edge-ratelimit — LOAD + MEMORY campaign against the real handler.
//
//  1. STRESS_ITER requests (seeded route/user mix over STRESS_USERS distinct
//     users) → p50/p95/p99 latency per route, Supabase (Auth + PostgREST +
//     RevenueCat) round trips per request (any hot-path request doing > 3 is
//     a finding), Upstash round trips per request, heap before/after.
//  2. Heap of the per-isolate L1 caches after STRESS_USERS distinct
//     authenticated users (auth cache is capped at 5 000 rows in cache.ts).
//  3. rateLimit.ts memory fallback: 20k / 50k / 100k distinct keys — heap,
//     time per hit, and the wipe-at-20 000 threshold minimised to the exact
//     key count (the [defect] the existing suite pins at the module level is
//     reproduced here through the REAL handler with Upstash down).
//
// Defaults are small so the suite stays fast; evidence runs:
//   cd supabase/functions/api/__wf__ && STRESS_ITER=1500 STRESS_USERS=20000 \
//     deno test -A --no-check --config deno.json stress_ratelimit_load.test.ts
//
// Results: artifacts/stress-edge-ratelimit/load/<scenario>.json

import postgres from "postgres";
import { assert, assertEquals, configureRedis, loadIsolate } from "./harness.ts";
import {
  DEFAULT_USER,
  edgeRequest,
  heapUsed,
  histogram,
  loadStressHarness,
  registerStressEnvRestore,
  Prng,
  replayCommand,
  sessionToken,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  summarize,
  writeReport,
} from "./stress_ratelimit_harness.ts";

const FILE = "stress_ratelimit_load.test.ts";
const MAX_SUPABASE_ROUND_TRIPS = 3;

/** `deno test --v8-flags=--expose-gc` makes heap deltas meaningful; without
 * it the numbers are recorded but not asserted. */
const exposedGc = (globalThis as { gc?: unknown }).gc;
const forceGc: (() => void) | null =
  typeof exposedGc === "function" ? (exposedGc as () => void) : null;
function heapNow(): number {
  forceGc?.();
  return heapUsed();
}

type RouteId = "access" | "healthz" | "billing-sync" | "refresh" | "privacy";

interface RoutePlan {
  id: RouteId;
  weight: number;
  request: (rng: Prng, token: string, ip: string, i: number) => Request;
  /** Supabase (Auth + PostgREST) round trips the route needs once auth is cached. */
  expectedSupabase: number;
  /** RevenueCat round trips (external, counted separately). */
  expectedRc: number;
}

const ROUTES: RoutePlan[] = [
  {
    id: "access",
    weight: 60,
    request: (_rng, token, ip) => edgeRequest("GET", "/v1/me/access", { token, ip }),
    expectedSupabase: 1, // access_state RPC
    expectedRc: 0,
  },
  {
    id: "healthz",
    weight: 15,
    request: (_rng, _token, ip) => edgeRequest("GET", "/healthz", { token: null, ip }),
    expectedSupabase: 0,
    expectedRc: 0,
  },
  {
    id: "privacy",
    weight: 5,
    request: (_rng, _token, ip) => edgeRequest("GET", "/privacy", { token: null, ip }),
    expectedSupabase: 0,
    expectedRc: 0,
  },
  {
    id: "billing-sync",
    weight: 10,
    request: (_rng, token, ip) => edgeRequest("POST", "/v1/billing/sync", { token, ip, body: {} }),
    expectedSupabase: 2, // billing_entitlements upsert + access_state RPC
    expectedRc: 1,
  },
  {
    id: "refresh",
    weight: 10,
    request: (_rng, _token, ip, i) =>
      edgeRequest("POST", "/v1/auth/refresh", {
        token: null,
        ip,
        body: { refreshToken: `refresh-r${i}-${DEFAULT_USER}` },
      }),
    expectedSupabase: 1, // Auth token endpoint
    expectedRc: 0,
  },
];

function pickRoute(rng: Prng): RoutePlan {
  const total = ROUTES.reduce((sum, r) => sum + r.weight, 0);
  let roll = rng.int(total);
  for (const r of ROUTES) {
    if (roll < r.weight) return r;
    roll -= r.weight;
  }
  return ROUTES[0];
}

Deno.test(
  `stress-load: ${STRESS_ITER} seeded requests over ${STRESS_USERS} users — latency, round trips, heap`,
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("load");
    // Distinct users, each with a stable session bearer; IPs spread over a /16
    // so the per-IP budget (1 200/min) never binds before the per-user one.
    const users = Array.from({ length: STRESS_USERS }, () => {
      const userId = rng.uuid();
      return {
        userId,
        token: sessionToken({ userId }),
        ip: `10.${rng.int(256)}.${rng.int(256)}.${1 + rng.int(254)}`,
      };
    });
    const heapBefore = heapNow();
    const perRoute: Record<
      string,
      { latencies: number[]; supabase: number[]; rc: number[]; redis: number[]; statuses: number[] }
    > = {};
    for (const r of ROUTES)
      perRoute[r.id] = { latencies: [], supabase: [], rc: [], redis: [], statuses: [] };
    const overBudget: Array<{
      i: number;
      route: RouteId;
      userId: string;
      supabase: number;
      calls: string[];
    }> = [];
    const rows: Array<[number, RouteId, string, number, number, number, number, number]> = []; // i, route, user, status, ms, supabase, rc, redis
    const wallStart = performance.now();
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const route = pickRoute(rng);
      const user = users[rng.int(users.length)];
      const tag = `load:${i}`;
      const t0 = performance.now();
      const res = await h.track(tag, () => h.handler(route.request(rng, user.token, user.ip, i)));
      const ms = performance.now() - t0;
      await res.body?.cancel();
      const calls = h.callsFor(tag);
      const supabase = calls.filter((c) => c.upstream === "auth" || c.upstream === "rest").length;
      const rc = calls.filter((c) => c.upstream === "rc").length;
      const redis = calls.filter((c) => c.upstream === "redis").length;
      const bucket = perRoute[route.id];
      bucket.latencies.push(ms);
      bucket.supabase.push(supabase);
      bucket.rc.push(rc);
      bucket.redis.push(redis);
      bucket.statuses.push(res.status);
      rows.push([i, route.id, user.userId, res.status, Number(ms.toFixed(3)), supabase, rc, redis]);
      if (supabase > MAX_SUPABASE_ROUND_TRIPS) {
        overBudget.push({
          i,
          route: route.id,
          userId: user.userId,
          supabase,
          calls: calls.map((c) => `${c.upstream} ${c.method} ${c.url}`),
        });
      }
    }
    const wallMs = performance.now() - wallStart;
    const heapAfter = heapNow();
    const routeSummary: Record<string, unknown> = {};
    for (const [id, b] of Object.entries(perRoute)) {
      if (b.latencies.length === 0) continue;
      routeSummary[id] = {
        requests: b.latencies.length,
        statuses: histogram(b.statuses),
        latencyMs: summarize(b.latencies),
        supabaseRoundTrips: histogram(b.supabase),
        revenueCatRoundTrips: histogram(b.rc),
        redisRoundTrips: histogram(b.redis),
      };
    }
    const all = Object.values(perRoute).flatMap((b) => b.latencies);
    const path = await writeReport("load", "handler_load", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "stress-load:"),
      requests: STRESS_ITER,
      users: STRESS_USERS,
      wallMs: Number(wallMs.toFixed(1)),
      throughputPerSec: Number((STRESS_ITER / (wallMs / 1000)).toFixed(1)),
      latencyMs: summarize(all),
      heapBytes: {
        before: heapBefore,
        after: heapAfter,
        delta: heapAfter - heapBefore,
        gcForced: forceGc !== null,
      },
      upstreamTotals: histogram(h.calls.map((c) => c.upstream)),
      routes: routeSummary,
      overBudget,
      columns: [
        "i",
        "route",
        "userId",
        "status",
        "ms",
        "supabaseRoundTrips",
        "revenueCatRoundTrips",
        "redisRoundTrips",
      ],
      rows,
    });
    console.log(`[stress-load] ${STRESS_ITER} requests → ${path}`);
    assertEquals(
      overBudget,
      [],
      `requests with > ${MAX_SUPABASE_ROUND_TRIPS} Supabase round trips`,
    );
    for (const r of ROUTES) {
      const b = perRoute[r.id];
      for (const status of b.statuses)
        assert([200, 429].includes(status), `${r.id}: status ${status}`);
      // Every route settles at its expected round-trip count once auth is cached
      // (the first request of a user costs +1 for Auth getUser).
      const settled = b.supabase.filter((n) => n <= r.expectedSupabase + 1).length;
      assertEquals(settled, b.supabase.length, `${r.id}: round trips beyond expected+1`);
      assertEquals(
        b.rc.filter((n) => n > r.expectedRc).length,
        0,
        `${r.id}: RevenueCat round trips beyond expected`,
      );
    }
  },
);

Deno.test(
  `stress-load: L1 auth cache under ${STRESS_USERS} distinct users — heap plateaus (5 000-row cap)`,
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("l1");
    const checkpoints: Array<{
      users: number;
      heapBytes: number;
      msPerRequest: number;
      authCalls: number;
      fakeRedisKeys: number;
    }> = [];
    const step = Math.max(1, Math.floor(STRESS_USERS / 8));
    const heapStart = heapNow();
    let authCalls = 0;
    let t0 = performance.now();
    for (let i = 1; i <= STRESS_USERS; i += 1) {
      const userId = rng.uuid();
      const res = await h.handler(
        edgeRequest("GET", "/v1/me/access", {
          token: sessionToken({ userId }),
          ip: `10.9.${rng.int(256)}.${1 + rng.int(254)}`,
        }),
      );
      await res.body?.cancel();
      assertEquals(res.status, 200);
      if (i % step === 0 || i === STRESS_USERS) {
        // The harness call/command logs and the in-process fake Upstash store
        // are the test's own memory: every user is new, so nothing is ever read
        // back from L2 and emptying it leaves the handler's behaviour unchanged.
        // What remains across checkpoints is L1 + the function's fixed state.
        authCalls += h.calls.filter((c) => c.upstream === "auth").length;
        h.calls.length = 0;
        h.redis.commands.length = 0;
        const fakeRedisKeys = h.redis.store.size;
        h.redis.store.clear();
        checkpoints.push({
          users: i,
          heapBytes: heapNow(),
          msPerRequest: Number(((performance.now() - t0) / step).toFixed(3)),
          authCalls,
          fakeRedisKeys,
        });
        t0 = performance.now();
      }
    }
    const first = checkpoints[0];
    const past5k = checkpoints.filter((c) => c.users >= 5_000);
    const marginal =
      past5k.length >= 2
        ? (past5k[past5k.length - 1].heapBytes - past5k[0].heapBytes) /
          (past5k[past5k.length - 1].users - past5k[0].users)
        : null;
    const path = await writeReport("load", "l1_auth_cache_memory", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "L1 auth cache").replace(
        "deno test",
        "deno test --v8-flags=--expose-gc",
      ),
      users: STRESS_USERS,
      gcForced: forceGc !== null,
      heapStart,
      checkpoints,
      totalGrowthBytes: checkpoints[checkpoints.length - 1].heapBytes - heapStart,
      bytesPerUserFirstCheckpoint: Number(((first.heapBytes - heapStart) / first.users).toFixed(1)),
      marginalBytesPerUserPast5k: marginal === null ? null : Number(marginal.toFixed(1)),
      authCallsPerUser: Number((authCalls / STRESS_USERS).toFixed(3)),
    });
    console.log(`[stress-load] L1 auth cache → ${path}`);
    // One Auth verification per distinct user (nothing cached across users).
    assertEquals(authCalls, STRESS_USERS);
    if (forceGc && marginal !== null) {
      // L1 is capped at 5 000 auth rows (cache.ts MEMORY_MAX_ENTRIES): past the
      // cap the heap must stop growing with the user count (an auth row is
      // ~700 B; < 256 B/user of GC noise allowed).
      assert(marginal < 256, `heap keeps growing past the L1 cap: ${marginal.toFixed(1)} B/user`);
    }
  },
);

// ── rateLimit.ts memory fallback (Upstash unconfigured / down) ───────────────

Deno.test(
  "stress-load: memory fallback under 20k / 50k / 100k distinct keys — bounded heap, wipe threshold minimised",
  async () => {
    configureRedis(false);
    const iso = await loadIsolate();
    const rng = new Prng(STRESS_SEED).fork("mem");
    const rows: Array<Record<string, unknown>> = [];
    for (const distinct of [20_000, 50_000, 100_000]) {
      const prefix = `k${distinct}-${rng.int(1e9)}`;
      const heapBefore = heapUsed();
      const t0 = performance.now();
      let allowed = 0;
      for (let i = 0; i < distinct; i += 1) {
        if ((await iso.rateLimit.enforceRateLimit("user", `${prefix}-${i}`, 240, 60)).allowed)
          allowed += 1;
      }
      const ms = performance.now() - t0;
      rows.push({
        distinct,
        allowed,
        totalMs: Number(ms.toFixed(1)),
        usPerHit: Number(((ms * 1000) / distinct).toFixed(2)),
        heapDeltaBytes: heapUsed() - heapBefore,
      });
    }
    // Minimise the wipe: a victim at its limit stays limited after N-1 fresh
    // ids and is admitted again after N. Bisect N in [1, 40 000] on a fresh
    // module each probe so the count is exact.
    const freshBlocked = async (floodCount: number): Promise<boolean> => {
      const iso2 = await loadIsolate();
      const victim = "victim";
      for (let i = 0; i < 3; i += 1) await iso2.rateLimit.enforceRateLimit("ip", victim, 3, 60);
      assert(
        !(await iso2.rateLimit.enforceRateLimit("ip", victim, 3, 60)).allowed,
        "victim limited",
      );
      for (let i = 0; i < floodCount; i += 1)
        await iso2.rateLimit.enforceRateLimit("ip", `f-${i}`, 3, 60);
      return !(await iso2.rateLimit.enforceRateLimit("ip", victim, 3, 60)).allowed;
    };
    let lo = 1;
    let hi = 40_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await freshBlocked(mid)) lo = mid + 1;
      else hi = mid;
    }
    const minimalFlood = lo;
    const stillBlockedAt = await freshBlocked(minimalFlood - 1);
    const unblockedAt = !(await freshBlocked(minimalFlood));
    const path = await writeReport("load", "memory_fallback_keys", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "memory fallback under"),
      sweeps: rows,
      wipe: {
        minimalDistinctFloodIds: minimalFlood,
        victimStillBlockedAtMinusOne: stillBlockedAt,
        victimUnblockedAtMinimal: unblockedAt,
      },
    });
    console.log(`[stress-load] memory fallback → ${path}`);
    for (const r of rows) assertEquals(r.allowed, r.distinct, "every fresh id is admitted");
    // Heap is bounded by the 20 000-row cap regardless of key count.
    const [k20, , k100] = rows.map((r) => r.heapDeltaBytes as number);
    assert(k100 < 3 * Math.max(k20, 1_000_000), `100k keys grew heap ${k100} B vs 20k ${k20} B`);
    assert(stillBlockedAt && unblockedAt, "threshold not exact");
    assertEquals(
      minimalFlood,
      20_000,
      "[defect] 20 000 fresh ids wipe every live window (MEMORY_WINDOW_MAX)",
    );
  },
);

Deno.test(
  `[defect] stress-load: with Upstash down, ${Math.max(STRESS_USERS, 20_001)} distinct users through the REAL handler un-block a rate-limited IP`,
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("handler-mem");
    const victimIp = "198.51.100.99";
    h.fault("redis", { kind: "http", status: 500 });
    // Exhaust the victim's public budget (60/min on /healthz) → 429.
    for (let i = 0; i < 60; i += 1)
      await (
        await h.handler(edgeRequest("GET", "/healthz", { token: null, ip: victimIp }))
      ).body?.cancel();
    const denied = await h.handler(edgeRequest("GET", "/healthz", { token: null, ip: victimIp }));
    await denied.body?.cancel();
    assertEquals(denied.status, 429, "victim limited in memory fallback");
    // Each request from a fresh (ip, user) pair opens TWO memory windows
    // (`ip:<ip>` pre-auth + `user:<uuid>` route budget), so the 20 000-row cap
    // is hit after ~10 000 such requests, not 20 000.
    const users = Math.max(STRESS_USERS, 20_001);
    let firstUnblockedAfter: number | null = null;
    const probeEvery = 1_000;
    const t0 = performance.now();
    for (let i = 1; i <= users; i += 1) {
      const res = await h.handler(
        edgeRequest("GET", "/v1/me/access", {
          token: sessionToken({ userId: rng.uuid() }),
          ip: `10.7.${rng.int(256)}.${1 + rng.int(254)}`,
        }),
      );
      await res.body?.cancel();
      if (i % probeEvery === 0 && firstUnblockedAfter === null) {
        const probe = await h.handler(
          edgeRequest("GET", "/healthz", { token: null, ip: victimIp }),
        );
        await probe.body?.cancel();
        if (probe.status === 200) firstUnblockedAfter = i;
      }
    }
    const finalProbe = await h.handler(
      edgeRequest("GET", "/healthz", { token: null, ip: victimIp }),
    );
    await finalProbe.body?.cancel();
    h.clearFaults();
    const path = await writeReport("load", "handler_memory_fallback_wipe", {
      seed: STRESS_SEED,
      replay: replayCommand(FILE, "Upstash down"),
      users,
      wallMs: Number((performance.now() - t0).toFixed(1)),
      victimUnblockedAfterUsers: firstUnblockedAfter,
      finalProbeStatus: finalProbe.status,
      heapBytes: heapUsed(),
    });
    console.log(`[stress-load] handler memory-fallback wipe → ${path}`);
    assertEquals(
      finalProbe.status,
      200,
      "[defect] the limited IP is admitted again after the wipe",
    );
    assert(
      firstUnblockedAfter !== null && firstUnblockedAfter <= 10_000 + probeEvery,
      `victim un-blocked after ${firstUnblockedAfter} users (expected ≤ ${10_000 + probeEvery})`,
    );
  },
);

// ── REAL Postgres half: the one RPC behind the hot path ──────────────────────────
// `GET /v1/me/access` is Auth (cached) + ONE PostgREST call: `rpc/access_state`.
// The in-process campaign above models PostgREST; this drives the real
// function on a disposable postgres:16 with every migration applied
// (./xc_pg_up.sh → XC_PG_URL). Without XC_PG_URL the test is `ignore`d, and an
// ignored run is NOT a pass.

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";

Deno.test({
  name: `stress-load: access_state() on real postgres:16 — ${STRESS_ITER} calls, one statement each, p50/p95`,
  ignore: PG_URL === "",
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const rng = new Prng(STRESS_SEED).fork("pg-access-state");
    const users = Math.min(STRESS_USERS, 500);
    const ids = Array.from({ length: users }, () => rng.uuid());
    try {
      for (const id of ids) {
        await sql.unsafe(`delete from auth.users where id = '${id}'`);
        await sql.unsafe(
          `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
        );
      }
      const latencies: number[] = [];
      const rows: Array<[number, string, number, boolean, number, number]> = []; // i, user, ms, premium, scored, reserved
      for (let i = 0; i < STRESS_ITER; i += 1) {
        const userId = ids[rng.int(ids.length)];
        const t0 = performance.now();
        const [row] = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
          return await tx.unsafe(
            `select premium, scored_count, reserved_count from public.access_state()`,
          );
        });
        const ms = performance.now() - t0;
        latencies.push(ms);
        assertEquals(row.premium, false);
        assertEquals(Number(row.scored_count), 0);
        assertEquals(Number(row.reserved_count), 0);
        rows.push([
          i,
          userId,
          Number(ms.toFixed(3)),
          row.premium,
          Number(row.scored_count),
          Number(row.reserved_count),
        ]);
      }
      const path = await writeReport("load", "pg_access_state_latency", {
        seed: STRESS_SEED,
        replay: replayCommand(FILE, "real postgres").replace(
          "&& ",
          "&& XC_PG_URL=<from ./xc_pg_up.sh> ",
        ),
        plane: "local docker postgres:16 (NOT hosted Supabase)",
        calls: STRESS_ITER,
        users,
        latencyMs: summarize(latencies),
        rows,
      });
      console.log(`[stress-load] real postgres access_state → ${path}`);
      assertEquals(latencies.length, STRESS_ITER);
    } finally {
      for (const id of ids) await sql.unsafe(`delete from auth.users where id = '${id}'`);
      await sql.end();
    }
  },
});

registerStressEnvRestore(FILE);
