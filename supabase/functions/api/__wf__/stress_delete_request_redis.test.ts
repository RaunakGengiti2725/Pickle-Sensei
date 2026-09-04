/**
 * stress — POST /v1/me/delete-request — Upstash Redis (L2) fault injection.
 *
 * Twin of stress_delete_request_failure_load.test.ts with UPSTASH configured
 * (cache.ts reads its env at import, so the two modes need separate
 * isolates). Every Redis fault must FAIL OPEN: the request is answered from
 * the L1/memory fallbacks and Supabase Auth is re-consulted when the cache
 * cannot answer — never a 5xx, never a lockout, never a leaked detail.
 *
 *   STRESS_ITER=500 STRESS_OUT_DIR=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_delete_request_redis.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  type ClientClass,
  drive,
  type Fault,
  freshIp,
  type Harness,
  latencyStats,
  loadStressHarness,
  type Outcome,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  VALID_SURVEY,
  writeReport,
} from "./stress_delete_request_harness.ts";

const h: Harness = await loadStressHarness({ redis: true });

let userCounter = 0;
function newUser(h: Harness) {
  userCounter += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  const user = h.registerUser({ id });
  const token = h.mintSession(id);
  return { user, token, ip: freshIp() };
}

const slots = (...results: unknown[]) => ({
  kind: "http" as const,
  status: 200,
  body: JSON.stringify(results.map((result) => ({ result }))),
});

interface RedisCase {
  id: string;
  title: string;
  /** Fault applied to every Redis pipeline call of the request (sticky) or,
   * with `once`, to the first pipeline call only (the pre-auth IP INCR). */
  fault: Fault;
  once?: boolean;
  /** Expected status of the follow-up request with Redis healthy again. */
  recover?: number;
  /** Warm (a healthy request first) so the fault hits a cache-HIT path. */
  warm?: boolean;
  expect: {
    status: number;
    client: ClientClass;
    authCalls?: number;
    minLatencyMs?: number;
    maxLatencyMs?: number;
    check?: (o: Outcome, h: Harness) => string | null;
  };
}

const REDIS_CASES: RedisCase[] = [
  {
    id: "R01",
    title: "Redis 500",
    fault: { kind: "http", status: 500, body: "{}" },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R02",
    title: "Redis 401 (bad token)",
    fault: { kind: "http", status: 401, body: '{"error":"Unauthorized"}' },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R03",
    title: "Redis socket failure",
    fault: { kind: "throw" },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R04",
    title: "Redis hangs → every pipeline aborts at 1 200 ms; request still answered",
    fault: { kind: "hang" },
    expect: {
      status: 200,
      client: "challenge",
      authCalls: 1,
      minLatencyMs: 1150,
      check: (o) => (o.redisRoundTrips >= 3 ? null : `only ${o.redisRoundTrips} redis calls`),
    },
  },
  {
    id: "R05",
    title: "Redis 200 with a non-array JSON body",
    fault: { kind: "http", status: 200, body: '{"result":"OK"}' },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R06",
    title: "Redis 200 with a non-JSON body",
    fault: { kind: "http", status: 200, body: "<html>" },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R07",
    title: "Redis 200 with per-command errors in every slot",
    fault: {
      kind: "http",
      status: 200,
      body: JSON.stringify([{ error: "ERR" }, { error: "ERR" }, { error: "ERR" }]),
    },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R08",
    title: "Redis 200 with an empty array (short reply)",
    fault: slots(),
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R09",
    title: "Redis INCR (pre-auth IP window) answers a string → memory fallback",
    fault: slots("abc"),
    once: true,
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R09b",
    title: "Redis answers null in every slot (coherent miss) → re-verified, memory windows",
    fault: slots(null, null, null),
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R10",
    title:
      "Redis INCR answers a huge number → the pre-auth IP budget is over → 429 (Redis is the authority)",
    fault: slots(1_000_000_000, 1_000_000_000),
    expect: { status: 429, client: "rejected_retryable", authCalls: 0 },
  },
  {
    id: "R11",
    title: "Redis GET of the auth row answers garbage → cache miss → re-verified",
    fault: slots(null, "not json", 500),
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R12",
    title:
      "Redis says the session is REVOKED (marker present) → 401; marker copied to L1 for 60 s so the recovery is 401 too",
    fault: slots("1", "1", "1"),
    expect: { status: 401, client: "session_expired", authCalls: 0 },
    recover: 401,
  },
  {
    id: "R12b",
    title:
      "Redis answers a string where the revocation marker is read (incoherent L2) → treated as revoked",
    fault: slots("abc", "abc", "abc"),
    expect: { status: 401, client: "session_expired", authCalls: 0 },
    recover: 401,
  },
  {
    id: "R13",
    title: "Redis slow (300 ms per pipeline) — latency scales with pipeline count",
    fault: { kind: "delay", ms: 300 },
    expect: { status: 200, client: "challenge", minLatencyMs: 600 },
  },
  {
    id: "R14",
    title: "Redis 500 on a warm cache (L1 has the row) → served from L1, no auth call",
    fault: { kind: "http", status: 500, body: "{}" },
    warm: true,
    expect: { status: 200, client: "challenge", authCalls: 0 },
  },
  {
    id: "R15",
    title: "Redis TTL says the row is gone (-2) on a warm cache → re-verified",
    fault: slots(null, -2),
    warm: true,
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
  {
    id: "R16",
    title: "Redis 502 html",
    fault: { kind: "http", status: 502, body: "<html>bad gateway</html>" },
    expect: { status: 200, client: "challenge", authCalls: 1 },
  },
];

Deno.test(
  "STRESS delete-request (Upstash configured): Redis faults fail open — status, client class, auth re-verification",
  async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const c of REDIS_CASES) {
      h.reset();
      const { user, token, ip } = newUser(h);
      if (c.warm) {
        const warm = await drive(h, h.request({ token, ip, body: {} }));
        assertEquals(warm.status, 200, `${c.id} warm-up`);
        h.calls = [];
        h.deletionRequests.clear();
      }
      if (c.once) h.inject("redis", c.fault);
      else h.injectSticky("redis", c.fault);
      const o = await drive(h, h.request({ token, ip, body: {} }));
      const problems: string[] = [];
      if (o.status !== c.expect.status) problems.push(`status ${o.status} != ${c.expect.status}`);
      if (o.client !== c.expect.client) problems.push(`client ${o.client} != ${c.expect.client}`);
      if (c.expect.authCalls !== undefined && (o.calls["auth.user"] ?? 0) !== c.expect.authCalls) {
        problems.push(`auth calls ${o.calls["auth.user"] ?? 0} != ${c.expect.authCalls}`);
      }
      if (c.expect.minLatencyMs !== undefined && o.latencyMs < c.expect.minLatencyMs) {
        problems.push(`latency ${o.latencyMs} < ${c.expect.minLatencyMs}`);
      }
      if (c.expect.maxLatencyMs !== undefined && o.latencyMs > c.expect.maxLatencyMs) {
        problems.push(`latency ${o.latencyMs} > ${c.expect.maxLatencyMs}`);
      }
      if (o.status >= 500) problems.push(`5xx ${o.status}`);
      if (o.status === 200) {
        const challenge = (o.body as Record<string, unknown>)?.challenge;
        if (h.deletionRequests.get(user.id)?.challenge !== challenge)
          problems.push("challenge not stored");
      }
      const custom = c.expect.check?.(o, h);
      if (custom) problems.push(custom);
      // Recovery with Redis healthy again (same user, same token).
      h.releaseHangs();
      h.reset();
      h.registerUser(user);
      h.sessions.set(token, user.id);
      const again = await drive(h, h.request({ token, ip, body: {} }));
      const wantRecover = c.recover ?? 200;
      if (again.status !== wantRecover) problems.push(`recovery ${again.status} != ${wantRecover}`);
      rows.push({
        id: c.id,
        title: c.title,
        status: o.status,
        client: o.client,
        latencyMs: o.latencyMs,
        redisRoundTrips: o.redisRoundTrips,
        supabaseRoundTrips: o.supabaseRoundTrips,
        calls: o.calls,
        recovery: again.status,
        outcome: problems.length === 0 ? "HELD" : "BROKEN",
        problems,
      });
    }
    const path = await writeReport("delete_request_redis_faults", { rows });
    const broken = rows.filter((r) => r.outcome === "BROKEN");
    console.log(
      `[stress] redis faults: ${rows.length} ran, ${broken.length} broken${path ? ` → ${path}` : ""}`,
    );
    assertEquals(
      broken.map((r) => `${r.id}: ${(r.problems as string[]).join("; ")}`),
      [],
    );
  },
);

Deno.test(
  `STRESS delete-request (Upstash configured): randomized Redis fault campaign (${STRESS_ITER} seeded iterations) + redis round trips per request`,
  async () => {
    const pool: Array<{ label: string; fault: Fault | null }> = [
      { label: "healthy", fault: null },
      { label: "500", fault: { kind: "http", status: 500, body: "{}" } },
      { label: "throw", fault: { kind: "throw" } },
      { label: "garbage", fault: { kind: "http", status: 200, body: "<html>" } },
      {
        label: "errors",
        fault: { kind: "http", status: 200, body: JSON.stringify([{ error: "ERR" }]) },
      },
      { label: "short", fault: slots() },
      { label: "nulls", fault: slots(null, null, null) },
      { label: "slow", fault: { kind: "delay", ms: 5 } },
    ];
    const rows: Array<Record<string, unknown>> = [];
    const hitRoundTrips: number[] = [];
    const missRoundTrips: number[] = [];
    const latencies: number[] = [];
    let broken = 0;
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = STRESS_SEED + 40_000 + i;
      const rng = new Prng(seed);
      h.reset();
      const { user, token, ip } = newUser(h);
      const survey = rng.next() < 0.5;
      const warm = rng.next() < 0.5;
      if (warm) {
        const w = await drive(h, h.request({ token, ip, body: {} }));
        if (w.status !== 200) throw new Error(`seed ${seed}: warm ${w.status}`);
        h.calls = [];
      }
      // Per-call faults: a fresh pick for every pipeline call of the request.
      const picks: string[] = [];
      for (let k = 0; k < 8; k++) {
        const p = rng.pick(pool);
        picks.push(p.label);
        h.inject("redis", p.fault ?? { kind: "ok" });
      }
      const o = await drive(
        h,
        h.request({ token, ip, body: survey ? { survey: VALID_SURVEY } : {} }),
      );
      const problems: string[] = [];
      if (o.status !== 200) problems.push(`status ${o.status}`);
      const challenge = (o.body as Record<string, unknown>)?.challenge;
      if (o.status === 200 && h.deletionRequests.get(user.id)?.challenge !== challenge) {
        problems.push("challenge not stored");
      }
      if (survey && o.status === 200 && h.feedback.length !== 1)
        problems.push(`feedback ${h.feedback.length}`);
      const authCalls = o.calls["auth.user"] ?? 0;
      if (authCalls > 1) problems.push(`auth calls ${authCalls}`);
      if (!warm && authCalls !== 1) problems.push(`cold path must verify once, got ${authCalls}`);
      (warm ? hitRoundTrips : missRoundTrips).push(o.redisRoundTrips);
      latencies.push(o.latencyMs);
      if (problems.length) broken += 1;
      rows.push({
        seed,
        warm,
        survey,
        redisFaults: picks,
        status: o.status,
        authCalls,
        redisRoundTrips: o.redisRoundTrips,
        supabaseRoundTrips: o.supabaseRoundTrips,
        latencyMs: o.latencyMs,
        outcome: problems.length ? "BROKEN" : "HELD",
        problems,
      });
    }
    const report = {
      baseSeed: STRESS_SEED + 40_000,
      iterations: STRESS_ITER,
      broken,
      latency: latencyStats(latencies),
      redisRoundTripsPerRequest: {
        authCacheHit: hitRoundTrips.length
          ? { min: Math.min(...hitRoundTrips), max: Math.max(...hitRoundTrips) }
          : null,
        authCacheMiss: missRoundTrips.length
          ? { min: Math.min(...missRoundTrips), max: Math.max(...missRoundTrips) }
          : null,
      },
      rows,
    };
    const path = await writeReport("delete_request_redis_random", report);
    console.log(
      `[stress] redis random: ${STRESS_ITER} iterations, ${broken} broken, ${JSON.stringify(report.redisRoundTripsPerRequest)}${path ? ` → ${path}` : ""}`,
    );
    assertEquals(
      rows
        .filter((r) => r.outcome === "BROKEN")
        .map((r) => `${r.seed}: ${(r.problems as string[]).join("; ")}`),
      [],
    );
    assert(rows.length === STRESS_ITER);
  },
);
