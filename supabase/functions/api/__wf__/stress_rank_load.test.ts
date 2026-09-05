// stress-route-get-v1-rank — LOAD + L1 MEMORY campaign for GET /v1/rank.
//
// Runs the REAL handler in-process (stressRankHarness.ts) with healthy fake
// upstreams and measures, per request: status, wall latency, and the number
// of Supabase round trips (Auth + PostgREST) and Redis pipelines the handler
// issued. A hot path spending more than 3 Supabase round trips is a finding;
// 429s are reported separately from route outcomes (they are the rate
// limiter, not the route).
//
// Campaigns (all seeded from STRESS_SEED; every request replays from
// STRESS_SEED + its index):
//   load    — STRESS_ITER requests (default 1000) over STRESS_USERS_HOT users
//             (default 200), in bursts of STRESS_CONCURRENCY (default 25).
//   users   — STRESS_USERS distinct users (default 2000; the campaign scale is
//             20000) each making one cold request, sampling the heap every
//             STRESS_HEAP_EVERY users, to show the per-isolate L1 caches and
//             the memory rate-limit windows stay bounded (cache.ts caps L1 at
//             5000 entries, rateLimit.ts caps windows at 20000).
//
// STRESS_LOAD_REDIS=1 runs the same campaigns with the (fake, instant) Upstash
// L2 configured, which changes the redis pipeline count per request only.
//
// Artifacts: <STRESS_OUT_DIR>/load_<seed>.json and users_<seed>.json.
import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  envInt,
  heapSnapshot,
  histogram,
  isRecord,
  loadStressHarness,
  Prng,
  rankRequest,
  readJson,
  seedUser,
  STRESS_SEED,
  summarize,
  writeArtifact,
} from "./stressRankHarness.ts";

const REDIS = Deno.env.get("STRESS_LOAD_REDIS") === "1";
const h = await loadStressHarness({ redis: REDIS });

const ITER = envInt("STRESS_ITER", 1_000);
const HOT_USERS = envInt("STRESS_USERS_HOT", 200);
const CONCURRENCY = Math.max(1, envInt("STRESS_CONCURRENCY", 25));
const DISTINCT_USERS = envInt("STRESS_USERS", 2_000);
const HEAP_EVERY = Math.max(1, envInt("STRESS_HEAP_EVERY", 1_000));
const MAX_SUPABASE_ROUND_TRIPS = 3;
const FILE = "stress_rank_load.test.ts";

interface Sample {
  i: number;
  user: number;
  status: number;
  latencyMs: number;
  auth: number;
  rest: number;
  redis: number;
  path: "cold" | "warm" | "coalesced" | "other";
  ok: boolean;
  why: string | null;
}

function count(
  calls: ReturnType<typeof h.callsSince>,
  target: "auth" | "rest" | "redis",
): number {
  return calls.filter((c) => c.target === target).length;
}

Deno.test(`stress-rank-load ${ITER} requests over ${HOT_USERS} users (concurrency ${CONCURRENCY}, redis=${REDIS})`, async () => {
  h.reset();
  const prng = new Prng(caseSeed(STRESS_SEED, "load"));
  const users = Array.from({ length: HOT_USERS }, () => seedUser(h, prng));
  // Zipf-ish skew: a few users dominate (warm L1 hits), the tail stays cold.
  const pickUser = (): number => {
    const r = prng.next();
    return r < 0.5
      ? prng.int(0, Math.max(0, Math.floor(HOT_USERS / 20) - 1))
      : prng.int(0, HOT_USERS - 1);
  };
  const plan = Array.from({ length: ITER }, () => pickUser());

  const samples: Sample[] = [];
  const started = performance.now();
  for (let base = 0; base < plan.length; base += CONCURRENCY) {
    const burst = plan.slice(base, base + CONCURRENCY);
    // Concurrent requests share the call log, so per-request round-trip
    // counts overlap here; the burst measures latency/statuses under
    // concurrency and the sequential replay below attributes round trips.
    const results = await Promise.all(
      burst.map(async (userIdx, j) => {
        const u = users[userIdx];
        const mark = h.calls.length;
        const t0 = performance.now();
        const response = await h.handler(rankRequest(u.token, u.ip));
        const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
        const window = h.callsSince(mark);
        const body = await readJson(response);
        const auth = count(window, "auth");
        const rest = count(window, "rest");
        const redis = count(window, "redis");
        let why: string | null = null;
        if (response.status === 200) {
          const rating = isRecord(body.rank) ? body.rank.rating : body.rank;
          if (rating !== u.rating) {
            why = `rating ${String(rating)} !== seeded ${String(u.rating)}`;
          }
        } else if (response.status !== 429) {
          why = `status ${response.status}: ${
            JSON.stringify(body).slice(0, 120)
          }`;
        }
        return {
          i: base + j,
          user: userIdx,
          status: response.status,
          latencyMs,
          auth,
          rest,
          redis,
          why,
        };
      }),
    );
    for (const r of results) {
      samples.push({
        ...r,
        path: r.rest === 0 && r.auth === 0 ? "warm" : "cold",
        ok: r.why === null && r.status === 200,
      });
    }
  }
  const wallMs = Math.round(performance.now() - started);

  // Exact per-request attribution: replay the SAME plan sequentially (no
  // overlap) so Supabase round trips per request are unambiguous. Sequential
  // requests to a user whose entries are warm cost 0 Supabase round trips.
  h.calls = [];
  const sequential: Sample[] = [];
  const seqUsers = Array.from({ length: HOT_USERS }, () => seedUser(h, prng));
  for (let i = 0; i < plan.length; i++) {
    const u = seqUsers[plan[i]];
    const mark = h.calls.length;
    const t0 = performance.now();
    const response = await h.handler(rankRequest(u.token, u.ip));
    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const window = h.callsSince(mark);
    const body = await readJson(response);
    const auth = count(window, "auth");
    const rest = count(window, "rest");
    const redis = count(window, "redis");
    let why: string | null = null;
    if (response.status === 200) {
      const rating = isRecord(body.rank) ? body.rank.rating : body.rank;
      if (rating !== u.rating) {
        why = `rating ${String(rating)} !== seeded ${String(u.rating)}`;
      }
    } else if (response.status !== 429) {
      why = `status ${response.status}: ${JSON.stringify(body).slice(0, 120)}`;
    }
    sequential.push({
      i,
      user: plan[i],
      status: response.status,
      latencyMs,
      auth,
      rest,
      redis,
      path: auth + rest === 0
        ? "warm"
        : auth === 1 && rest === 2
        ? "cold"
        : "other",
      ok: why === null && response.status === 200,
      why,
    });
  }

  const supabaseTrips = sequential.map((s) => s.auth + s.rest);
  const cold = sequential.filter((s) => s.path === "cold");
  const warm = sequential.filter((s) => s.path === "warm");
  const other = sequential.filter((s) => s.path === "other");
  const rateLimited = sequential.filter((s) => s.status === 429);
  const failures = sequential.filter((s) => !s.ok && s.status !== 429);
  const burstFailures = samples.filter((s) => !s.ok && s.status !== 429);
  const over = sequential.filter((s) =>
    s.auth + s.rest > MAX_SUPABASE_ROUND_TRIPS
  );

  const report = {
    file: FILE,
    seed: STRESS_SEED,
    redis: REDIS,
    iterations: ITER,
    hotUsers: HOT_USERS,
    concurrency: CONCURRENCY,
    burst: {
      wallMs,
      statuses: histogram(samples.map((s) => s.status)),
      latencyMs: summarize(samples.map((s) => s.latencyMs)),
      failures: burstFailures.slice(0, 20),
      rateLimited: samples.filter((s) => s.status === 429).length,
    },
    sequential: {
      statuses: histogram(sequential.map((s) => s.status)),
      paths: histogram(sequential.map((s) => s.path)),
      latencyMs: {
        all: summarize(sequential.map((s) => s.latencyMs)),
        cold: summarize(cold.map((s) => s.latencyMs)),
        warm: summarize(warm.map((s) => s.latencyMs)),
      },
      supabaseRoundTrips: {
        histogram: histogram(supabaseTrips),
        max: Math.max(...supabaseTrips),
        perColdRequest: cold.length
          ? summarize(cold.map((s) => s.auth + s.rest))
          : null,
        perWarmRequest: warm.length
          ? summarize(warm.map((s) => s.auth + s.rest))
          : null,
        overBudget: over.map((s) => ({
          i: s.i,
          user: s.user,
          auth: s.auth,
          rest: s.rest,
        })),
      },
      redisPipelines: {
        histogram: histogram(sequential.map((s) => s.redis)),
        perColdRequest: cold.length
          ? summarize(cold.map((s) => s.redis))
          : null,
        perWarmRequest: warm.length
          ? summarize(warm.map((s) => s.redis))
          : null,
      },
      rateLimited: rateLimited.length,
      failures: failures.slice(0, 20),
      other: other.slice(0, 20),
    },
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${ITER} STRESS_USERS_HOT=${HOT_USERS} STRESS_CONCURRENCY=${CONCURRENCY} STRESS_LOAD_REDIS=${
        REDIS ? 1 : 0
      } deno test -A --no-check --config deno.json ${FILE} --filter stress-rank-load`,
    samples: sequential,
  };
  const path = await writeArtifact(
    `load_${STRESS_SEED}${REDIS ? "_redis" : ""}`,
    report,
  );
  console.log(`[stress-rank-load] wrote ${path}`);
  console.log(
    `[stress-rank-load] sequential p50=${report.sequential.latencyMs.all.p50}ms p95=${report.sequential.latencyMs.all.p95}ms ` +
      `cold=${cold.length} warm=${warm.length} other=${other.length} 429=${rateLimited.length} maxSupabaseTrips=${report.sequential.supabaseRoundTrips.max}`,
  );

  assertEquals(
    burstFailures.length,
    0,
    `burst failures: ${JSON.stringify(burstFailures.slice(0, 3))}`,
  );
  assertEquals(
    failures.length,
    0,
    `sequential failures: ${JSON.stringify(failures.slice(0, 3))}`,
  );
  assertEquals(
    rateLimited.length,
    0,
    "no request in the campaign should be rate limited (distinct users/IPs, < 240/user)",
  );
  assertEquals(
    over.length,
    0,
    `${over.length} requests spent > ${MAX_SUPABASE_ROUND_TRIPS} Supabase round trips`,
  );
  assertEquals(
    other.length,
    0,
    `unexpected round-trip shapes: ${JSON.stringify(other.slice(0, 3))}`,
  );
  for (const s of warm) {
    assertEquals(s.auth + s.rest, 0, "warm request must not touch Supabase");
  }
  assert(
    cold.length > 0 && warm.length > 0,
    "campaign must exercise both cold and warm paths",
  );
});

Deno.test(`stress-rank-users ${DISTINCT_USERS} distinct users, L1 + memory rate-limit windows stay bounded (redis=${REDIS})`, async () => {
  h.reset();
  const prng = new Prng(caseSeed(STRESS_SEED, "users"));
  const heapAt: Array<
    {
      users: number;
      heapUsedMB: number;
      rssMB: number;
      externalMB: number;
      gc: boolean;
      fakeRedisKeys: number;
    }
  > = [];
  const snap = (users: number) => {
    const m = heapSnapshot();
    heapAt.push({
      users,
      heapUsedMB: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
      rssMB: Math.round((m.rss / 1_048_576) * 100) / 100,
      externalMB: Math.round((m.external / 1_048_576) * 100) / 100,
      gc: m.gc,
      fakeRedisKeys: h.redis.size,
    });
  };
  snap(0);

  const statuses: number[] = [];
  const latencies: number[] = [];
  const trips: number[] = [];
  let wrong = 0;
  const started = performance.now();
  for (let i = 1; i <= DISTINCT_USERS; i++) {
    // One user at a time: seed rows, request, then drop the fake rows, the
    // fake session and the fake L2 rows (real Upstash is remote memory) so
    // the harness itself holds O(1) state and the heap curve reflects the
    // production module state (L1 caches + memory rate-limit windows).
    const u = seedUser(h, prng);
    const mark = h.calls.length;
    const t0 = performance.now();
    const response = await h.handler(rankRequest(u.token, u.ip));
    latencies.push(performance.now() - t0);
    const window = h.callsSince(mark);
    trips.push(count(window, "auth") + count(window, "rest"));
    statuses.push(response.status);
    const body = await readJson(response);
    const rating = isRecord(body.rank) ? body.rank.rating : body.rank;
    if (response.status !== 200 || rating !== u.rating) wrong++;
    h.tables = {};
    h.users.delete(u.userId);
    h.sessions.delete(u.token);
    h.calls = [];
    h.redisCommands = [];
    h.redis.clear();
    if (i % HEAP_EVERY === 0) snap(i);
  }
  if (heapAt[heapAt.length - 1].users !== DISTINCT_USERS) snap(DISTINCT_USERS);
  const wallMs = Math.round(performance.now() - started);

  // Bounded-memory evidence: once the caps are reached (5000 L1 entries per
  // map; 20000 windows) the heap must plateau — the second half of the
  // campaign may not grow more than the first quarter did.
  const first = heapAt[0].heapUsedMB;
  const quarter =
    heapAt.find((s) => s.users >= DISTINCT_USERS / 4)?.heapUsedMB ?? first;
  const half = heapAt.find((s) => s.users >= DISTINCT_USERS / 2)?.heapUsedMB ??
    first;
  const last = heapAt[heapAt.length - 1].heapUsedMB;
  const growthFirstQuarter = quarter - first;
  const growthSecondHalf = last - half;

  const report = {
    file: FILE,
    seed: STRESS_SEED,
    redis: REDIS,
    distinctUsers: DISTINCT_USERS,
    wallMs,
    statuses: histogram(statuses),
    wrongPayloads: wrong,
    latencyMs: summarize(latencies.map((v) => Math.round(v * 1000) / 1000)),
    supabaseRoundTrips: histogram(trips),
    heapAt,
    growthMB: {
      firstQuarter: growthFirstQuarter,
      secondHalf: growthSecondHalf,
    },
    gcExposed: heapAt[0].gc,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${DISTINCT_USERS} STRESS_HEAP_EVERY=${HEAP_EVERY} STRESS_LOAD_REDIS=${
        REDIS ? 1 : 0
      } deno test -A --no-check --config deno.json --v8-flags=--expose-gc ${FILE} --filter stress-rank-users`,
  };
  const path = await writeArtifact(
    `users_${STRESS_SEED}${REDIS ? "_redis" : ""}`,
    report,
  );
  console.log(`[stress-rank-users] wrote ${path}`);
  console.log(
    `[stress-rank-users] heap: ${
      heapAt.map((s) => `${s.users}:${s.heapUsedMB}MB`).join(" ")
    }`,
  );

  assertEquals(wrong, 0, "every distinct user must get their own seeded rank");
  assertEquals(histogram(statuses), { "200": DISTINCT_USERS });
  for (const t of trips) {
    assert(
      t <= MAX_SUPABASE_ROUND_TRIPS,
      `cold request spent ${t} Supabase round trips`,
    );
  }
  if (DISTINCT_USERS >= 20_000 && heapAt[0].gc) {
    assert(
      growthSecondHalf <= Math.max(2, growthFirstQuarter),
      `heap kept growing after the caps: +${growthSecondHalf}MB in the second half vs +${growthFirstQuarter}MB in the first quarter`,
    );
  }
});
