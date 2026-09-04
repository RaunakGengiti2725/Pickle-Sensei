/**
 * Stress: `GET /v1/me/consent/status` with the shared cache tier (Upstash
 * Redis REST) CONFIGURED, and the fake Upstash failing / stalling / answering
 * garbage in turn. Own module on purpose: cache.ts reads UPSTASH_* at import,
 * so the Redis-enabled function boots in its own isolate (same convention as
 * auth_cache_redis_test.ts).
 *
 * Every Redis fault must be invisible to the caller (Redis is failure-
 * tolerant by design): 200 + the oracle body, with only latency and the
 * L1/Auth fallback changing. The exceptions are semantic: a revocation
 * marker in L2 is a real 401 and an L2 window counter over budget is a real
 * 429 — those are shared-store state, not faults.
 *
 *   deno test -A --no-check --config deno.json stress_consent_status_redis.test.ts
 *   STRESS_ITER=1000 STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
 *     stress_consent_status_redis.test.ts
 *   STRESS_CASE=R05 STRESS_STRICT=1 deno test -A --no-check --config deno.json \
 *     stress_consent_status_redis.test.ts --filter "redis fault matrix"
 */
import { assert, assertEquals } from "@std/assert";
import {
  assertInvariants,
  countBy,
  type Fault,
  type Invariant,
  loadStressHarness,
  oracleFold,
  percentile,
  Prng,
  requestFor,
  seededLedger,
  seededUser,
  STRESS_CASE,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  type StressUser,
  writeJson,
} from "./stress_consent_status_harness.ts";

const FILE = "stress_consent_status_redis.test.ts";
/** cache.ts REDIS_TIMEOUT_MS — every pipeline is bounded by this. */
const REDIS_TIMEOUT_MS = 1_200;

interface RedisCase {
  id: string;
  name: string;
  /** Queue faults / mutate the fake store before the probe request(s). */
  arrange: (h: StressHarness, user: StressUser) => void | Promise<void>;
  /** Judge a COLD user (no warm-up request): L1 empty, L2 whatever `arrange` seeded. */
  cold?: boolean;
  /** How many requests the probe makes (default 1); the LAST one is judged. */
  requests?: number;
  expectStatus: number;
  /** Expected Auth calls on the judged request (undefined = don't care). */
  expectAuthCalls?: number;
  /** Latency ceiling for the judged request. */
  maxLatencyMs?: number;
  /** The verdict must PERSIST after faults clear (a revocation is sticky);
   * default: the next request must recover to 200 + oracle body. */
  sticky?: boolean;
  /** A known finding: reported, not asserted unless STRESS_STRICT=1. */
  finding?: string;
  fullOnly?: boolean;
}

const redisFault = (spec: Fault["spec"], times = 20, redisOp?: string): Fault => ({
  upstream: "redis",
  spec,
  times,
  ...(redisOp ? { redisOp } : {}),
});

function authKeys(h: StressHarness): string[] {
  return [...h.redis.entries()].filter(([, e]) => e.value.includes('"userId"')).map(([k]) => k);
}

/** index.ts authCacheKey: `auth:` + sha256(bearer) hex. */
async function authCacheKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `auth:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** What another isolate would have written to L2 after verifying `user`. */
function l2Record(user: StressUser, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    userId: user.id,
    email: user.email,
    provider: user.provider,
    accessToken: user.accessToken,
    expiresAtMs: Date.now() + 540_000,
    ...overrides,
  });
}

async function seedL2(h: StressHarness, user: StressUser, value: string): Promise<void> {
  h.redis.set(await authCacheKey(user.accessToken), { value, expiresAtMs: Date.now() + 540_000 });
}

const CASES: RedisCase[] = [
  {
    id: "R01",
    name: "Upstash 500 on every pipeline",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 500, body: "internal" })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R02",
    name: "Upstash 401 (rotated token)",
    arrange: (h) =>
      h.inject(redisFault({ kind: "http", status: 401, json: { error: "Unauthorized" } })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R03",
    name: "Upstash 429 (plan limit)",
    arrange: (h) =>
      h.inject(
        redisFault({
          kind: "http",
          status: 429,
          json: { error: "ERR max requests" },
          headers: { "Retry-After": "5" },
        }),
      ),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R04",
    name: "Upstash socket failure on every pipeline",
    arrange: (h) => h.inject(redisFault({ kind: "network" })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R05",
    name: "Upstash black hole (every pipeline hangs) — warm L1, per-pipeline 1.2s timeout",
    arrange: (h) => h.inject(redisFault({ kind: "hang" })),
    expectStatus: 200,
    maxLatencyMs: REDIS_TIMEOUT_MS + 600,
    finding:
      "Upstash outage: a warm request pays REDIS_TIMEOUT_MS per pipeline sequentially (ip INCR, authfail GET, cache GET, user INCR = 4 × 1.2s) with no circuit breaker",
  },
  {
    id: "R06",
    name: "Upstash slow 300ms per pipeline",
    arrange: (h) => h.inject(redisFault({ kind: "slow", ms: 300 })),
    expectStatus: 200,
    maxLatencyMs: 2_500,
  },
  {
    id: "R07",
    name: "Upstash 200 with an HTML body",
    arrange: (h) =>
      h.inject(
        redisFault({
          kind: "http",
          status: 200,
          body: "<html>maintenance</html>",
          headers: { "Content-Type": "text/html" },
        }),
      ),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R08",
    name: "Upstash 200 with an object instead of the pipeline array",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 200, json: { result: "OK" } })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R09",
    name: "Upstash 200 with a SHORT pipeline reply (slots missing)",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 200, json: [{ result: null }] })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R10",
    name: "Upstash 200 with every slot a Redis error",
    arrange: (h) =>
      h.inject(
        redisFault({
          kind: "http",
          status: 200,
          json: [{ error: "ERR" }, { error: "ERR" }, { error: "ERR" }],
        }),
      ),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R11",
    name: "Upstash 200 with an empty body",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 200, body: "" })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R12",
    name: "Upstash 200 with truncated JSON",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 200, body: '[{"result":' })),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R13",
    name: "cold isolate, L2 auth record is not JSON → fall through to Auth",
    cold: true,
    arrange: (h, user) => seedL2(h, user, "not-json"),
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
  {
    id: "R14",
    name: "cold isolate, L2 auth record with expiresAtMs in the past → re-verify",
    cold: true,
    arrange: (h, user) => seedL2(h, user, l2Record(user, { expiresAtMs: Date.now() - 1 })),
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
  {
    id: "R15",
    name: "L2 row gone (TTL -2) while L1 still warm → L1 dropped, re-verify once",
    arrange: (h) => {
      for (const k of authKeys(h)) h.redis.delete(k);
    },
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
  {
    id: "R16",
    name: "revocation marker for the session in L2 → 401 (logout on another device); stays 401 after the marker is gone (L1 read-through)",
    arrange: (h, user) =>
      h.redis.set(`auth:revoked:${user.sessionId}`, {
        value: "1",
        expiresAtMs: Date.now() + 600_000,
      }),
    expectStatus: 401,
    expectAuthCalls: 0,
    maxLatencyMs: 300,
    sticky: true,
  },
  {
    id: "R17",
    name: "L2 window counter already over budget (INCR → 10000) → 429 with Retry-After",
    arrange: (h) =>
      h.inject(
        redisFault(
          { kind: "http", status: 200, json: [{ result: 10_000 }, { result: 1 }] },
          1,
          "INCR",
        ),
      ),
    expectStatus: 429,
    maxLatencyMs: 300,
  },
  {
    id: "R18",
    name: "Upstash 500 on SET only (cache write refused) — request served",
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 500 }, 5, "SET")),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R19",
    name: "Upstash INCR slot returns garbage → in-memory window",
    arrange: (h) =>
      h.inject(
        redisFault(
          { kind: "http", status: 200, json: [{ result: "many" }, { result: 1 }] },
          5,
          "INCR",
        ),
      ),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R20",
    name: "Upstash socket failure once, then healthy",
    arrange: (h) => h.inject(redisFault({ kind: "network" }, 1)),
    expectStatus: 200,
    maxLatencyMs: 300,
  },
  {
    id: "R21",
    name: "Upstash hang once (1.2s), then healthy",
    arrange: (h) => h.inject(redisFault({ kind: "hang" }, 1)),
    expectStatus: 200,
    maxLatencyMs: 1_800,
  },
  {
    id: "R22",
    name: "Upstash down + PostgREST 503 once → library retry, 200",
    arrange: (h) => {
      h.inject(redisFault({ kind: "network" }));
      h.inject({
        upstream: "postgrest",
        spec: {
          kind: "http",
          status: 503,
          json: { message: "down" },
          headers: { "Retry-After": "0" },
        },
      });
    },
    expectStatus: 200,
    maxLatencyMs: 800,
  },
  {
    id: "R23",
    name: "Upstash down + Auth 503 on a cold user → 503",
    cold: true,
    arrange: (h) => {
      h.inject(redisFault({ kind: "network" }));
      h.inject({ upstream: "auth", spec: { kind: "http", status: 503, json: { msg: "down" } } });
    },
    expectStatus: 503,
    maxLatencyMs: 300,
  },
  {
    id: "R24",
    name: "cold isolate, L2 auth record is `{}` (no userId/expiry) → re-verify",
    cold: true,
    arrange: (h, user) => seedL2(h, user, "{}"),
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
  {
    id: "R25",
    name: "Upstash black hole on a COLD user (6 pipelines incl. fence + write)",
    cold: true,
    arrange: (h) => h.inject(redisFault({ kind: "hang" })),
    expectStatus: 200,
    maxLatencyMs: REDIS_TIMEOUT_MS + 600,
    finding:
      "Upstash outage on a cold request: six sequential 1.2s timeouts (ip, authfail, cache GET, fence GET, fenced SET, user INCR)",
    fullOnly: true,
  },
  {
    id: "R26",
    name: "cold isolate, VALID L2 record written by another isolate → served with 0 Auth calls",
    cold: true,
    arrange: (h, user) => seedL2(h, user, l2Record(user)),
    expectStatus: 200,
    expectAuthCalls: 0,
    maxLatencyMs: 300,
  },
  {
    id: "R27",
    name: "cold isolate, L2 GET pipeline 500 → Auth verifies, 200",
    cold: true,
    arrange: (h) => h.inject(redisFault({ kind: "http", status: 500 }, 1, "TTL")),
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
  {
    id: "R28",
    name: "cold isolate, L2 GET returns the record with a slot error for TTL → treated as unknown, re-verify",
    cold: true,
    arrange: async (h, user) => {
      await seedL2(h, user, l2Record(user));
      h.inject(
        redisFault(
          {
            kind: "http",
            status: 200,
            json: [{ result: null }, { result: l2Record(user) }, { error: "WRONGTYPE" }],
          },
          1,
          "TTL",
        ),
      );
    },
    expectStatus: 200,
    expectAuthCalls: 1,
    maxLatencyMs: 300,
  },
];

Deno.test(
  "stress consent-status: redis fault matrix (Upstash configured, failing in turn)",
  async () => {
    const h = await loadStressHarness({ redis: true });
    assert(h.redisEnabled, "Redis-enabled boot");
    const prng = new Prng((STRESS_SEED ^ 0x5ed) >>> 0);
    const invariants: Invariant[] = [];
    const outcomes: Array<Record<string, unknown>> = [];
    for (const c of CASES) {
      if (STRESS_CASE.size > 0 ? !STRESS_CASE.has(c.id) : c.fullOnly && STRESS_ITER < 1000)
        continue;
      h.reset();
      const user = seededUser(prng, 90_000 + outcomes.length);
      const ledger = seededLedger(prng, user.id);
      h.addUser(user, ledger);
      const want = JSON.stringify(oracleFold(ledger));
      if (!c.cold) {
        const warm = await h.request(requestFor(user));
        assertEquals(warm.response.status, 200, `${c.id} warm-up`);
        await warm.response.body?.cancel();
      }
      h.calls.length = 0;
      await c.arrange(h, user);
      let last = await h.request(requestFor(user));
      for (let i = 1; i < (c.requests ?? 1); i += 1) {
        await last.response.body?.cancel();
        last = await h.request(requestFor(user));
      }
      const text = await last.response.text();
      const authCalls = countBy(last.calls, "auth");
      const redisCalls = countBy(last.calls, "redis");
      const problems: string[] = [];
      if (last.response.status !== c.expectStatus)
        problems.push(`status ${last.response.status} ≠ ${c.expectStatus}`);
      if (c.expectStatus === 200 && text !== want) problems.push("body ≠ oracle");
      if (c.expectAuthCalls !== undefined && authCalls !== c.expectAuthCalls)
        problems.push(`auth calls ${authCalls} ≠ ${c.expectAuthCalls}`);
      if (c.maxLatencyMs !== undefined && last.latencyMs > c.maxLatencyMs)
        problems.push(`latency ${last.latencyMs.toFixed(0)}ms > ${c.maxLatencyMs}`);
      if (text.includes("Bearer ") || text.includes("SECRET") || text.includes(user.accessToken))
        problems.push("secret material in body");
      // Recoverability: with faults cleared the same bearer is served again —
      // unless the verdict is sticky by design (a revoked session stays out).
      h.clearFaults();
      for (const k of [...h.redis.keys()]) if (k.startsWith("auth:revoked:")) h.redis.delete(k);
      const after = await h.request(requestFor(user));
      const afterText = await after.response.text();
      if (c.sticky) {
        if (after.response.status !== c.expectStatus)
          problems.push(`verdict not sticky: ${after.response.status}`);
      } else if (after.response.status !== 200 || afterText !== want) {
        problems.push(`not recovered: ${after.response.status}`);
      }
      const holds = problems.length === 0;
      outcomes.push({
        id: c.id,
        name: c.name,
        status: last.response.status,
        expectStatus: c.expectStatus,
        latencyMs: Math.round(last.latencyMs * 100) / 100,
        authCalls,
        postgrestCalls: countBy(last.calls, "postgrest"),
        redisPipelines: redisCalls,
        redisOutcomes: last.calls.filter((x) => x.upstream === "redis").map((x) => x.outcome),
        afterStatus: after.response.status,
        holds,
        problems,
        ...(c.finding ? { finding: c.finding } : {}),
        replay: `STRESS_CASE=${c.id} STRESS_STRICT=1 STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json ${FILE} --filter "redis fault matrix"`,
      });
      invariants.push({
        name: `${c.id} ${c.name}`,
        holds,
        detail:
          problems.join("; ") ||
          `status=${last.response.status} redis=${redisCalls} auth=${authCalls} ${last.latencyMs.toFixed(0)}ms`,
        finding: c.finding,
      });
    }
    const path = await writeJson("redis_fault_matrix", {
      seed: STRESS_SEED,
      cases: outcomes.length,
      outcomes,
    });
    console.log(`[stress] redis fault matrix: ${outcomes.length} cases → ${path}`);
    if (STRESS_CASE.size === 0)
      assert(outcomes.length >= 20, `≥20 redis fault cases executed (got ${outcomes.length})`);
    assertInvariants(invariants, "redis fault matrix");
  },
);

Deno.test(
  "stress consent-status: load with Redis healthy — pipelines per request, p50/p95",
  async () => {
    const h = await loadStressHarness({ redis: true });
    h.reset();
    const prng = new Prng((STRESS_SEED ^ 0x10ad) >>> 0);
    const users: Array<{ user: StressUser; want: string }> = [];
    for (let i = 0; i < 50; i += 1) {
      const user = seededUser(prng, 91_000 + i);
      const ledger = seededLedger(prng, user.id);
      h.addUser(user, ledger);
      users.push({ user, want: JSON.stringify(oracleFold(ledger)) });
    }
    const rows: Array<{
      i: number;
      user: number;
      status: number;
      latencyMs: number;
      auth: number;
      postgrest: number;
      redis: number;
      ok: boolean;
    }> = [];
    let maxRedis = 0;
    let maxSupabase = 0;
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const idx = prng.int(0, users.length - 1);
      const { user, want } = users[idx];
      const r = await h.request(requestFor(user));
      const text = await r.response.text();
      const auth = countBy(r.calls, "auth");
      const postgrest = countBy(r.calls, "postgrest");
      const redis = countBy(r.calls, "redis");
      maxRedis = Math.max(maxRedis, redis);
      maxSupabase = Math.max(maxSupabase, auth + postgrest);
      rows.push({
        i,
        user: idx,
        status: r.response.status,
        latencyMs: Math.round(r.latencyMs * 100) / 100,
        auth,
        postgrest,
        redis,
        ok: r.response.status === 200 && text === want,
      });
    }
    const sorted = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const failed = rows.filter((r) => !r.ok);
    const summary = {
      seed: STRESS_SEED,
      requests: rows.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxRedisPipelinesPerRequest: maxRedis,
      maxSupabaseCallsPerRequest: maxSupabase,
      failed: failed.length,
      replay: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json ${FILE} --filter "load with Redis healthy"`,
    };
    const path = await writeJson("redis_load", { ...summary, rows });
    console.log(
      `[stress] redis load: ${rows.length} req, p50=${summary.p50Ms.toFixed(2)}ms p95=${summary.p95Ms.toFixed(2)}ms, redis pipelines/request max=${maxRedis}, supabase RT max=${maxSupabase}, failed=${failed.length} → ${path}`,
    );
    assertEquals(failed.length, 0, `${failed.length} requests wrong under healthy Redis`);
    assert(maxSupabase <= 3, `supabase round trips ${maxSupabase} > 3`);
    assert(
      maxRedis <= 6,
      `redis pipelines per request ${maxRedis} > 6 (ip, authfail, cache get, fence get, fenced set, user)`,
    );
    const warmMax = Math.max(...rows.filter((r) => r.auth === 0).map((r) => r.redis));
    assert(warmMax <= 4, `warm redis pipelines per request ${warmMax} > 4`);
  },
);
