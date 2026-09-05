// STRESS · Upstash (L2 cache + rate-limit store) failure injection and hot-path
// round trips for GET /v1/me/saved-drills, with Redis CONFIGURED. Lives apart
// from stress_saved_drills_faults.test.ts because cache.ts / rateLimit.ts read
// their Upstash env once at import.
//
//   STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
//     stress_saved_drills_redis.test.ts --filter "R08"

import { assert, assertEquals } from "@std/assert";
import {
  assertHydrated,
  type CaseOutcome,
  catalogSlugs,
  type FaultCase,
  runFaultCase,
  seedRows,
  summarize,
} from "./stress_saved_drills_cases.ts";
import {
  caseSeed,
  envInt,
  faults,
  latencySummary,
  LEAK_MARKER,
  loadStressHarness,
  Prng,
  replayCommand,
  run,
  savedDrillsRequest,
  sessionBearer,
  STRESS_HANG_MS,
  STRESS_SEED,
  withAuthTimeout,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const FILE = "stress_saved_drills_redis.test.ts";
/** cache.ts bounds every Upstash call with AbortSignal.timeout(1200). */
const REDIS_CALL_TIMEOUT_MS = 1200;
/** Requests for the Redis-on hot-path latency sample (STRESS_ITER / 4 default). */
const REDIS_LOAD_ITER = envInt(
  "STRESS_REDIS_ITER",
  Math.max(50, Math.floor(envInt("STRESS_ITER", 1000) / 4)),
);

const CASES: FaultCase[] = [
  {
    id: "R01 redis 500 → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.status(500, { error: LEAK_MARKER }),
    expect: {
      status: 200,
      calls: { redis: { min: 1, max: 6 }, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R02 redis 401 bad token → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.status(401, { error: "Unauthorized" }),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R03 redis 429 quota → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.status(429, { error: LEAK_MARKER }),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R04 redis connection refused → fail open, 200, no added latency",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.network(),
    expect: {
      status: 200,
      calls: { db: 1 },
      latencyMs: { max: 200 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "R05 redis stalls → 200 only after every Upstash call waits out its 1.2 s timeout in series",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.hang(true),
    expect: {
      status: "no_response",
      eventualStatus: 200,
      eventualWaitMs: 7000,
      eventualLatencyMs: {
        min: 4 * REDIS_CALL_TIMEOUT_MS - 100,
        max: 4 * REDIS_CALL_TIMEOUT_MS + 1500,
      },
      callsAtSettle: { redis: 4, db: 1, auth: 0 },
      recovery: "n/a",
      classification: "BROKEN",
      shouldBe:
        `a stalled Upstash should cost at most one timeout per request (fast-fail after the first stall), not 4 × ${REDIS_CALL_TIMEOUT_MS} ms ≈ 4.8 s on the hot path (deadline ${STRESS_HANG_MS} ms)`,
    },
  },
  {
    id: "R06 redis per-command errors → re-verify with Auth, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.redisCommandError(),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
    note:
      "unknown ≠ absent: the cached row is not served, Supabase Auth is consulted again",
  },
  {
    id: "R07 redis short pipeline reply → re-verify with Auth, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.redisTruncated(0),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "R08 redis answers a string for every GET → treated as revoked, 401 pinned in L1",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.redisResults("1"),
    expect: {
      status: 401,
      retryAfter: false,
      calls: { redis: { min: 1, max: 4 }, auth: 0, db: 0 },
      recovery: "sticky_401",
      classification: "BROKEN",
      shouldBe:
        "a revocation marker read from L2 should be validated (exact marker value) before it is copied into L1 for 60 s; a malformed reply must not sign the user out of this isolate",
    },
  },
  {
    id: "R09 redis answers JSON garbage for every GET → 401 pinned in L1",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.redisResults("{not json"),
    expect: {
      status: 401,
      retryAfter: false,
      recovery: "sticky_401",
      classification: "BROKEN",
      shouldBe:
        "same as R08 — any string in the revoked-marker slot is a revocation",
    },
  },
  {
    id:
      "R10 redis answers a large number for every command → 429 from the auth-failure budget",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.redisResults(10_000),
    expect: {
      status: 429,
      retryAfter: true,
      calls: { auth: 0, db: 0 },
      recovery: "same_bearer",
      classification: "BROKEN",
      shouldBe:
        "a per-IP count that jumps from 0 to 10 000 in one reply is not plausible; today it is trusted and the request is refused (recovers as soon as Redis answers sanely)",
    },
  },
  {
    id: "R11 redis answers an object instead of an array → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.replyWith({ result: "OK" }),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R12 redis answers truncated JSON → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.raw(200, "[{", "application/json"),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R13 redis answers HTML → fail open, 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.raw(200, `<html>${LEAK_MARKER}</html>`, "text/html"),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "R14 redis slow 150 ms per call → 200, latency ≈ 4 × 150 ms (serial pipelines)",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.delay(150),
    expect: {
      status: 200,
      calls: { redis: 4 },
      latencyMs: { min: 4 * 150 - 20 },
      recovery: "n/a",
      classification: "HELD",
    },
    note:
      "4 sequential Upstash round trips per request is the steady-state cost (see hot-path test)",
  },
  {
    id: "R15 redis one connection error then healthy → 200",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.sequence(faults.network()),
    expect: {
      status: 200,
      calls: { db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "R16 redis says this IP is over budget → 429 (Redis-counted limits are trusted)",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.when(
      (ctx) =>
        Array.isArray(ctx.body) &&
        (ctx.body as unknown[][]).some((cmd) =>
          cmd[0] === "INCR" && String(cmd[1]).startsWith("rl:ip:")
        ),
      (ctx) => {
        const commands = ctx.body as Array<Array<string | number>>;
        return new Response(
          JSON.stringify(
            commands.map((cmd) => ({
              result: cmd[0] === "INCR" ? 1201 : cmd[0] === "EXPIRE" ? 1 : null,
            })),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    ),
    expect: {
      status: 429,
      retryAfter: true,
      calls: { auth: 0, db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "R17 redis SET refused (cache write fails) → 200, row served from L1",
    upstream: "redis",
    bearer: "session",
    fault: faults.when(
      (ctx) =>
        Array.isArray(ctx.body) &&
        (ctx.body as unknown[][]).some((cmd) => cmd[0] === "SET"),
      faults.redisResults(null),
    ),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id: "R18 redis + auth both down, cold cache → 503 from Auth",
    upstream: "redis",
    bearer: "session",
    fault: faults.network(),
    also: { auth: faults.network() },
    expect: {
      status: 503,
      retryAfter: true,
      calls: { db: 0 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "R19 redis + db both down, warm cache → 503 from the DB step",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.status(500),
    also: { db: faults.status(500) },
    expect: {
      status: 503,
      calls: { db: 1 },
      recovery: "same_bearer",
      classification: "HELD",
    },
  },
  {
    id: "R20 redis down + cold cache → Auth verifies, 200",
    upstream: "redis",
    bearer: "session",
    fault: faults.network(),
    expect: {
      status: 200,
      calls: { auth: 1, db: 1 },
      recovery: "n/a",
      classification: "HELD",
    },
  },
  {
    id:
      "R21 redis stalls (ignores abort) → request parks on the first pipeline",
    upstream: "redis",
    bearer: "session",
    warm: true,
    fault: faults.hang(false),
    expect: {
      status: "no_response",
      eventualStatus: 200,
      calls: { redis: 1, db: 0 },
      recovery: "n/a",
      classification: "HELD",
    },
    note:
      `harness-only: Deno's fetch honours AbortSignal.timeout, so this models a runtime stall, not Upstash (deadline ${STRESS_HANG_MS} ms)`,
  },
];

const outcomes: CaseOutcome[] = [];

for (const c of CASES) {
  Deno.test(`stress saved-drills redis fault ${c.id}`, async () => {
    const state = await loadStressHarness({ redis: true });
    outcomes.push(
      await withAuthTimeout(() => runFaultCase(state, c, FILE)),
    );
  });
}

Deno.test("stress saved-drills redis hot path: round trips per request and latency", async () => {
  const state = await loadStressHarness({ redis: true });
  state.reset();
  const seed = caseSeed("redis-hot-path");
  const prng = new Prng(seed);
  const slugs = await catalogSlugs();
  // GENERAL_USER_LIMIT is 240/min, so the sample is spread over enough users
  // to stay under it; each user is warmed once (cold path measured on the first).
  const users = Array.from({ length: Math.ceil(REDIS_LOAD_ITER / 200) }, () => {
    const userId = prng.uuid();
    const rows = seedRows(prng, slugs, 5);
    state.savedDrills.set(userId, rows);
    return { rows, ip: prng.ip(), bearer: sessionBearer(state, userId) };
  });

  const cold = await run(
    state,
    savedDrillsRequest(users[0].bearer, { ip: users[0].ip }),
    "redis-cold",
  );
  assertEquals(cold.status, 200);
  assertHydrated(cold.body, users[0].rows, slugs);
  for (const u of users.slice(1)) {
    assertEquals(
      (await run(
        state,
        savedDrillsRequest(u.bearer, { ip: u.ip }),
        "redis-cold",
      )).status,
      200,
    );
  }

  const latencies: number[] = [];
  const perRequest: Array<Record<string, number>> = [];
  for (let i = 0; i < REDIS_LOAD_ITER; i++) {
    const u = users[i % users.length];
    const r = await run(
      state,
      savedDrillsRequest(u.bearer, { ip: u.ip }),
      `redis-warm-${i}`,
    );
    if (i % 50 === 0) assertHydrated(r.body, u.rows, slugs);
    assertEquals(r.status, 200, `warm request ${i}`);
    latencies.push(r.latencyMs);
    perRequest.push(r.roundTrips);
    assertEquals(r.roundTrips.auth, 0, "warm: Supabase Auth never consulted");
    assertEquals(r.roundTrips.db, 1, "warm: exactly one PostgREST query");
  }
  const redisPerRequest = perRequest.map((r) => r.redis);
  const supabasePerRequest = perRequest.map((r) => r.auth + r.db);
  const commandsByOp: Record<string, number> = {};
  for (const cmd of state.redisCommands) {
    commandsByOp[String(cmd[0])] = (commandsByOp[String(cmd[0])] ?? 0) + 1;
  }

  const report = {
    seed,
    replay: replayCommand(FILE, "redis hot path", {
      STRESS_REDIS_ITER: REDIS_LOAD_ITER,
    }),
    requests: REDIS_LOAD_ITER,
    users: users.length,
    cold: {
      roundTrips: cold.roundTrips,
      latencyMs: Math.round(cold.latencyMs * 100) / 100,
    },
    warm: {
      latency: latencySummary(latencies),
      redisRoundTripsPerRequest: {
        min: Math.min(...redisPerRequest),
        max: Math.max(...redisPerRequest),
      },
      supabaseRoundTripsPerRequest: {
        min: Math.min(...supabasePerRequest),
        max: Math.max(...supabasePerRequest),
      },
      redisCommandsByOp: commandsByOp,
    },
    note:
      "Redis on: 4 sequential Upstash pipelines per request (ip limit, auth-failure peek, revocation+TTL probe, user limit) + 1 PostgREST = 5 network round trips; Supabase itself sees 1.",
  };
  const path = await writeJson("redis_hot_path.json", report);
  console.log(`[stress] wrote ${path}: ${JSON.stringify(report.warm)}`);
  assertEquals(
    cold.roundTrips,
    { auth: 1, db: 1, redis: 6, revenuecat: 0 },
    "cold path round trips",
  );
  assert(
    report.warm.supabaseRoundTripsPerRequest.max <= 3,
    "Supabase round trips per request ≤ 3",
  );
  assertEquals(
    report.warm.redisRoundTripsPerRequest,
    { min: 4, max: 4 },
    "4 Upstash pipelines per warm request",
  );
});

Deno.test("stress saved-drills redis fault table → JSON", async () => {
  const ids = new Set(CASES.map((c) => c.id));
  assertEquals(ids.size, CASES.length, "case ids are unique");
  const path = await writeJson("faults_redis.json", {
    route: "GET /v1/me/saved-drills",
    redis: true,
    seed: STRESS_SEED,
    hangDeadlineMs: STRESS_HANG_MS,
    summary: summarize(outcomes),
    cases: outcomes,
  });
  console.log(
    `[stress] wrote ${path}: ${outcomes.length}/${CASES.length} cases ran`,
  );
  for (const o of outcomes) assert(o.passed, o.id);
});
