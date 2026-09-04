/**
 * stress: POST /v1/analysis-permits with Upstash CONFIGURED — Redis fault
 * injection (lens `failure-load`). Separate module because the function
 * reads UPSTASH_REDIS_REST_* once at import; stress_permits_failure_load
 * boots the Redis-less isolate.
 *
 *   cd supabase/functions/api/__wf__ && deno task test stress_permits_redis_faults.test.ts
 *
 * Every Upstash failure mode must FAIL OPEN: the route answers exactly as it
 * would without Redis (L1 + local budgets), never a 5xx, never a lost or
 * doubled permit. The one thing Redis IS allowed to change is latency — the
 * black-hole case measures how much (REDIS_TIMEOUT_MS = 1 200 ms per
 * pipeline, applied sequentially to every pipeline of the request).
 */
import { assert, assertEquals } from "@std/assert";
import {
  deriveSeed,
  type Fault,
  loadStressHarness,
  observe,
  percentile,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  UPSTREAM_DETAIL_MARKER,
  writeReport,
} from "./stress_permits_harness.ts";

Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "400");

/** cache.ts REDIS_TIMEOUT_MS — what a hung pipeline costs. */
const REDIS_TIMEOUT_MS = 1_200;
/** Pipelines a WARM permit request issues: ip INCR, auth-fail GET, auth-cache GET/TTL, user INCR. */
const WARM_PIPELINES = 4;

interface RedisCase {
  id: string;
  fault: Fault;
  times?: number;
  /** cold: fresh bearer (auth cache miss → GoTrue + cacheIsRevoked + cacheSet pipelines). */
  auth?: "warm" | "cold";
  expectStatus: number;
  expectCode?: string | null;
  /** Lower bound on latency the fault must impose (ms) — documented, not desired. */
  minLatencyMs?: number;
  maxLatencyMs?: number;
  note?: string;
}

const errBody = { error: `${UPSTREAM_DETAIL_MARKER} upstash` };

export const REDIS_CASES: RedisCase[] = [
  {
    id: "D01-redis-500-sticky",
    fault: { kind: "status", status: 500, body: errBody },
    times: Infinity,
    expectStatus: 200,
  },
  {
    id: "D02-redis-401-sticky",
    fault: { kind: "status", status: 401, body: errBody },
    times: Infinity,
    expectStatus: 200,
  },
  { id: "D03-redis-socket-sticky", fault: { kind: "throw" }, times: Infinity, expectStatus: 200 },
  {
    id: "D04-redis-hang-sticky-warm",
    fault: { kind: "hang" },
    times: Infinity,
    expectStatus: 200,
    minLatencyMs: WARM_PIPELINES * REDIS_TIMEOUT_MS - 50,
    note: "every pipeline waits the full REDIS_TIMEOUT_MS",
  },
  {
    id: "D05-redis-hang-sticky-cold",
    fault: { kind: "hang" },
    times: Infinity,
    auth: "cold",
    expectStatus: 200,
    minLatencyMs: 6 * REDIS_TIMEOUT_MS - 50,
    note: "cold bearer: + revocation GET + cacheSet",
  },
  {
    id: "D06-redis-200-non-json",
    fault: { kind: "text", status: 200, text: "<html>upstash</html>", contentType: "text/html" },
    times: Infinity,
    expectStatus: 200,
  },
  {
    id: "D07-redis-200-object-not-array",
    fault: { kind: "status", status: 200, body: { result: "OK" } },
    times: Infinity,
    expectStatus: 200,
  },
  {
    id: "D08-redis-200-per-command-errors",
    fault: {
      kind: "status",
      status: 200,
      body: [
        { error: "ERR max requests limit exceeded" },
        { error: "ERR max requests limit exceeded" },
      ],
    },
    times: Infinity,
    expectStatus: 200,
  },
  {
    id: "D09-redis-200-short-array",
    fault: { kind: "status", status: 200, body: [] },
    times: Infinity,
    expectStatus: 200,
  },
  {
    id: "D10-redis-slow-300ms-sticky",
    fault: { kind: "delay", ms: 300 },
    times: Infinity,
    expectStatus: 200,
    minLatencyMs: WARM_PIPELINES * 300 - 50,
  },
  {
    id: "D11-redis-hang-once",
    fault: { kind: "hang" },
    times: 1,
    expectStatus: 200,
    minLatencyMs: REDIS_TIMEOUT_MS - 50,
    maxLatencyMs: 2 * REDIS_TIMEOUT_MS,
  },
  {
    id: "D12-redis-ip-counter-over-limit",
    fault: { kind: "status", status: 200, body: [{ result: 10_000 }, { result: 1 }] },
    times: 1,
    expectStatus: 429,
    note: "L2 says the per-IP budget is spent → honoured",
  },
  {
    id: "D13-redis-ip-counter-garbage",
    fault: { kind: "status", status: 200, body: [{ result: "abc" }, { result: 1 }] },
    times: 1,
    expectStatus: 200,
    note: "NaN counter → local window",
  },
  {
    id: "D14-redis-ip-counter-null",
    fault: { kind: "status", status: 200, body: [{ result: null }, { result: 1 }] },
    times: 1,
    expectStatus: 200,
  },
  {
    id: "D15-redis-503-then-ok",
    fault: { kind: "status", status: 503, body: errBody },
    times: 2,
    expectStatus: 200,
  },
  {
    id: "D16-redis-socket-cold",
    fault: { kind: "throw" },
    times: Infinity,
    auth: "cold",
    expectStatus: 200,
  },
  {
    id: "D17-redis-500-cold",
    fault: { kind: "status", status: 500, body: errBody },
    times: Infinity,
    auth: "cold",
    expectStatus: 200,
  },
  {
    id: "D18-redis-slow-1100ms-under-timeout",
    fault: { kind: "delay", ms: 1_100 },
    times: 1,
    expectStatus: 200,
    minLatencyMs: 1_050,
  },
];

function seededUser(h: StressHarness, prng: Prng, premium = true) {
  const id = prng.uuid();
  h.upstream.addUser({ id, premium });
  return { id, token: h.upstream.mintSession(id), ip: h.freshIp() };
}

Deno.test(
  "stress/permits redis faults: every Upstash failure fails open (same answer as without Redis)",
  async () => {
    const h = await loadStressHarness({ redis: true, seed: STRESS_SEED });
    const outcomes: Array<Record<string, unknown>> = [];
    const broken: string[] = [];
    for (const c of REDIS_CASES) {
      const prng = new Prng(deriveSeed(STRESS_SEED, c.id));
      const u = seededUser(h, prng);
      // Warm: one healthy request (auth cached in L1 + L2).
      const warm = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `warm-${prng.hex(6)}` },
        }),
      );
      assertEquals(warm.status, 200, `${c.id} warm-up: ${warm.text}`);
      const bearer = c.auth === "cold" ? h.upstream.mintSession(u.id) : u.token;
      const key = `redis-${c.id}-${prng.hex(6)}`;
      const callsBefore = h.upstream.calls.length;
      h.upstream.inject("redis", c.fault, c.times ?? 1);
      const o = await observe(
        h.handler,
        h.permitRequest({ token: bearer, ip: u.ip, body: { idempotencyKey: key } }),
      );
      const redisCalls = h.upstream.calls
        .slice(callsBefore)
        .filter((x) => x.upstream === "redis").length;
      const supabaseCalls = h.upstream.calls
        .slice(callsBefore)
        .filter((x) => x.upstream !== "redis").length;
      h.upstream.clearFaults();
      h.upstream.releaseHangs();
      let detail: string | null = null;
      if (o.status !== c.expectStatus) detail = `status ${o.status} != ${c.expectStatus}`;
      if (o.status >= 500) detail ??= "5xx from a Redis fault";
      if (o.text.includes(UPSTREAM_DETAIL_MARKER)) detail ??= "body leaked upstream detail";
      if (c.minLatencyMs !== undefined && o.latencyMs < c.minLatencyMs)
        detail ??= `latency ${o.latencyMs.toFixed(0)}ms < ${c.minLatencyMs}ms`;
      if (c.maxLatencyMs !== undefined && o.latencyMs > c.maxLatencyMs)
        detail ??= `latency ${o.latencyMs.toFixed(0)}ms > ${c.maxLatencyMs}ms`;
      // Recovery: Redis healthy again → same key replays the same permit, L2 in use again.
      const commandsBefore = h.upstream.redisCommands.length;
      const replay = await observe(
        h.handler,
        h.permitRequest({ token: bearer, ip: u.ip, body: { idempotencyKey: key } }),
      );
      if (replay.status !== 200) detail ??= `replay ${replay.status}`;
      if (o.status === 200 && replay.permitId !== o.permitId)
        detail ??= "replay returned a different permit";
      if (h.upstream.redisCommands.length === commandsBefore)
        detail ??= "L2 not used after recovery";
      const rows = h.upstream.permitsOf(u.id).filter((p) => p.idempotency_key === key);
      if (rows.length !== 1) detail ??= `${rows.length} rows for one key`;
      if (detail) broken.push(`${c.id}: ${detail}`);
      outcomes.push({
        id: c.id,
        seed: deriveSeed(STRESS_SEED, c.id),
        expectStatus: c.expectStatus,
        status: o.status,
        code: o.code,
        retryAfter: o.retryAfter,
        latencyMs: Math.round(o.latencyMs),
        redisCalls,
        supabaseCalls,
        replay: replay.status,
        verdict: detail ? "BROKEN" : "HELD",
        ...(detail ? { detail } : {}),
        ...(c.note ? { note: c.note } : {}),
      });
    }
    console.log(
      `[stress] redis faults:\n  ${outcomes.map((o) => `${o.verdict} ${String(o.id).padEnd(40)} status=${o.status} ra=${o.retryAfter} ${o.latencyMs}ms redis=${o.redisCalls} supabase=${o.supabaseCalls} replay=${o.replay}${o.detail ? ` ← ${o.detail}` : ""}`).join("\n  ")}`,
    );
    await writeReport("permits_redis_faults", {
      seed: STRESS_SEED,
      cases: outcomes.length,
      broken,
      outcomes,
    });
    assertEquals(broken, []);
  },
);

Deno.test(
  "stress/permits redis outage: free allowance and idempotency hold while L2 is down",
  async () => {
    const h = await loadStressHarness({ redis: true, seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "redis-outage-allowance"));
    const u = seededUser(h, prng, false);
    h.upstream.inject("redis", { kind: "throw" }, Infinity);
    const k1 = `out-${prng.hex(6)}`;
    const a = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: k1 } }),
    );
    const a2 = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: k1 } }),
    );
    const b = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: `out-${prng.hex(6)}` } }),
    );
    const c = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: `out-${prng.hex(6)}` } }),
    );
    h.upstream.clearFaults();
    assertEquals([a.status, a2.status, b.status, c.status], [200, 200, 200, 402]);
    assertEquals(a.permitId, a2.permitId, "same key → same permit during the outage");
    assertEquals(c.code, "access.paywall_required");
    assertEquals(h.upstream.permitsOf(u.id).length, 2);
    // Local per-user route budget still enforced without L2: 30/min → the 31st is 429.
    const p = seededUser(h, prng, true);
    h.upstream.inject("redis", { kind: "throw" }, Infinity);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const o = await observe(
        h.handler,
        h.permitRequest({ token: p.token, ip: p.ip, body: { idempotencyKey: `budget-${i}` } }),
      );
      statuses.push(o.status);
    }
    h.upstream.clearFaults();
    assertEquals(statuses.slice(0, 30), Array(30).fill(200));
    assertEquals(
      statuses[30],
      429,
      "31st permit request in the window is refused locally while Redis is down",
    );
  },
);

Deno.test(
  "stress/permits redis load: pipelines and Supabase round trips per warm request",
  async () => {
    const h = await loadStressHarness({ redis: true, seed: STRESS_SEED });
    const prng = new Prng(deriveSeed(STRESS_SEED, "redis-load"));
    const n = Math.max(50, Math.floor(STRESS_ITER / 4));
    const POOL = 25;
    const users = [] as Array<{ id: string; token: string; ip: string }>;
    for (let i = 0; i < POOL; i++) {
      const u = seededUser(h, prng);
      const warm = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `warm-${prng.hex(6)}` },
        }),
      );
      assertEquals(warm.status, 200);
      users.push(u);
    }
    const latencies: number[] = [];
    const redisHist: Record<number, number> = {};
    const supabaseHist: Record<number, number> = {};
    for (let i = 0; i < n; i++) {
      const u = users[prng.int(POOL)];
      const before = h.upstream.calls.length;
      const o = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `rl-${i}-${prng.hex(4)}` },
        }),
      );
      assertEquals(o.status, 200, o.text);
      const calls = h.upstream.calls.slice(before);
      const redis = calls.filter((c) => c.upstream === "redis").length;
      const supabase = calls.length - redis;
      redisHist[redis] = (redisHist[redis] ?? 0) + 1;
      supabaseHist[supabase] = (supabaseHist[supabase] ?? 0) + 1;
      latencies.push(o.latencyMs);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const report = {
      seed: STRESS_SEED,
      requests: n,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      redisPipelinesPerRequest: redisHist,
      supabaseRoundTripsPerRequest: supabaseHist,
    };
    console.log(`[stress] redis load: ${JSON.stringify(report)}`);
    await writeReport("permits_redis_load", report);
    assertEquals(supabaseHist, { 2: n }, "2 Supabase round trips per warm request with Redis on");
    assert(
      Object.keys(redisHist).every((k) => Number(k) <= WARM_PIPELINES),
      `warm request issued > ${WARM_PIPELINES} Upstash pipelines: ${JSON.stringify(redisHist)}`,
    );
  },
);
