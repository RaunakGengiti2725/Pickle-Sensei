/**
 * stress — POST /v1/me/consent/withdraw with UPSTASH faulted.
 *
 * The route touches Upstash only through the rate limiter (rateLimit.ts →
 * cache.ts redisWindowIncr/Get on `{REDIS_URL}/pipeline`); consent rows
 * themselves never go through Redis. cache.ts reads UPSTASH_* at import, so
 * this lives in its own module (the harness boots the function once per
 * process) and it asserts the documented posture:
 *
 *   "Limits fail OPEN on backend errors: a Redis outage must never lock users
 *    out."  (supabase/functions/api/rateLimit.ts:1-7)
 *
 * Every case is replayable:
 *   STRESS_OUT_DIR=/tmp/stress-out deno test -A --no-check --config deno.json \
 *     stress_consent_withdraw_redis.test.ts --filter "<case id>"
 * Slow cases (Upstash hang → REDIS_TIMEOUT_MS abort) only run with STRESS_SLOW=1.
 */
import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  CONSENT_SCOPES,
  type Fault,
  type FaultContext,
  leaksInternalDetail,
  loadStressHarness,
  observe,
  observeWithin,
  Prng,
  scopesOf,
  STRESS_SEED,
  type StressHarness,
  withdrawRequest,
  writeJson,
} from "./stress_consent_withdraw_harness.ts";

const SLOW = Deno.env.get("STRESS_SLOW") === "1";
/** cache.ts bounds every Redis call by REDIS_TIMEOUT_MS; the route must answer
 * well inside this budget even when Upstash never replies. */
const HANG_BUDGET_MS = 30_000;

interface RedisCase {
  id: string;
  detail: string;
  fault: (ctx: FaultContext) => Fault | null;
  slow?: boolean;
  /** Faulted request must still succeed (fail-open) unless stated otherwise. */
  expectStatus?: number;
  /** Set when `expectStatus` pins REPRODUCED broken behaviour, not the contract. */
  knownBroken?: string;
}

const CASES: RedisCase[] = [
  {
    id: "U01-redis-500",
    detail: "Upstash 500 on every pipeline",
    fault: () => ({ kind: "status", status: 500, body: { error: "internal" } }),
  },
  {
    id: "U02-redis-502-html",
    detail: "Upstash 502 HTML (proxy error page)",
    fault: () => ({
      kind: "raw",
      status: 502,
      text: "<html><body>502 Bad Gateway</body></html>",
      contentType: "text/html",
    }),
  },
  {
    id: "U03-redis-401",
    detail: "Upstash 401 (rotated token)",
    fault: () => ({
      kind: "status",
      status: 401,
      body: { error: "unauthorized" },
    }),
  },
  {
    id: "U04-redis-429",
    detail: "Upstash 429 (Upstash's own quota)",
    fault: () => ({
      kind: "status",
      status: 429,
      body: { error: "max requests" },
    }),
  },
  {
    id: "U05-redis-network-error",
    detail: "TCP failure reaching Upstash",
    fault: () => ({ kind: "throw", message: "connection reset by peer" }),
  },
  {
    id: "U06-redis-200-non-json",
    detail: "Upstash 200 with a non-JSON body",
    fault: () => ({ kind: "raw", status: 200, text: "not json at all" }),
  },
  {
    id: "U07-redis-200-object",
    detail: "Upstash 200 with an object instead of the pipeline array",
    fault: () => ({ kind: "status", status: 200, body: { result: 1 } }),
  },
  {
    id: "U08-redis-200-empty-array",
    detail: "Upstash 200 with an empty pipeline array",
    fault: () => ({ kind: "status", status: 200, body: [] }),
  },
  {
    id: "U09-redis-200-command-error",
    detail: "Upstash reports a per-command error",
    fault: () => ({
      kind: "status",
      status: 200,
      body: [{ error: "ERR wrong type" }, { result: 1 }],
    }),
  },
  {
    id: "U10-redis-200-string-result",
    detail:
      "Upstash answers every GET/INCR with a string — the revocation-marker read treats ANY string as 'revoked'",
    fault: () => ({
      kind: "status",
      status: 200,
      body: [{ result: "nope" }, { result: 1 }],
    }),
    // REPRODUCED: cache.ts:179 / cache.ts:218 read slot 0 of the pipeline as the
    // revocation marker and accept any string, so a wrong-shaped or
    // wrong-keyed L2 answer forces a sign-out instead of degrading.
    expectStatus: 401,
    knownBroken:
      "a malformed/colliding Upstash value at the revocation key signs the user out (401) instead of failing open",
  },
  {
    id: "U11-redis-200-null-count",
    detail: "INCR result is null",
    fault: () => ({
      kind: "status",
      status: 200,
      body: [{ result: null }, { result: 1 }],
    }),
  },
  {
    id: "U12-redis-200-huge-count",
    detail:
      "INCR returns a count far past every limit (a poisoned/shared bucket)",
    fault: () => ({
      kind: "status",
      status: 200,
      body: [{ result: 10_000_000 }, { result: 1 }],
    }),
    // A real count over the limit MUST be honoured: this is the limiter working.
    expectStatus: 429,
  },
  {
    id: "U13-redis-200-negative-count",
    detail: "INCR returns a negative count",
    fault: () => ({
      kind: "status",
      status: 200,
      body: [{ result: -5 }, { result: 1 }],
    }),
  },
  {
    id: "U14-redis-hang",
    detail:
      "Upstash never answers — every pipeline burns the full REDIS_TIMEOUT_MS in series (no circuit breaker)",
    fault: () => ({ kind: "hang" }),
    slow: true,
  },
  {
    id: "U15-redis-slow-then-ok",
    detail: "Upstash answers just under its timeout",
    fault: () => ({ kind: "delay", ms: 120 }),
    slow: true,
  },
  {
    id: "U16-redis-first-call-only",
    detail: "Only the first pipeline of the request fails (partial outage)",
    fault: (
      ctx,
    ) => (ctx.nth === 1
      ? { kind: "status", status: 503, body: {} }
      : null),
  },
];

const results: Array<Record<string, unknown>> = [];

async function runCase(h: StressHarness, index: number, testCase: RedisCase) {
  h.reset();
  const seed = caseSeed(STRESS_SEED, 3_000_000 + index);
  const prng = new Prng(seed);
  const scope = prng.pick(CONSENT_SCOPES);
  const session = h.mintSession(prng.uuid());
  h.fault = (ctx) => (ctx.upstream === "redis" ? testCase.fault(ctx) : null);

  const request = withdrawRequest(session.accessToken, {
    scope,
    source: "mobile_settings",
  });
  const raced = await observeWithin(h.handler, request, HANG_BUDGET_MS);
  const expected = testCase.expectStatus ?? 200;
  assert(
    raced !== "hung",
    `${testCase.id}: the route never answered within ${HANG_BUDGET_MS}ms — a Redis fault must not stall it`,
  );
  const seen = raced;

  const row = {
    id: testCase.id,
    seed,
    scope,
    detail: testCase.detail,
    status: seen.status,
    expectedStatus: expected,
    errorCode: seen.code,
    retryAfter: seen.retryAfter,
    durationMs: seen.durationMs,
    redisCalls: h.callsTo("redis").length,
    authCalls: h.callsTo("auth").length,
    postgrestCalls: h.callsTo("postgrest").length,
    verdict: seen.status !== expected
      ? "BROKEN"
      : testCase.knownBroken
      ? "BROKEN(known)"
      : "HELD",
    knownBroken: testCase.knownBroken ?? null,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_SLOW=1 deno test -A --no-check --config deno.json stress_consent_withdraw_redis.test.ts --filter "${testCase.id}"`,
  };
  results.push(row);

  assertEquals(
    seen.status,
    expected,
    `${testCase.id}: ${testCase.detail} → ${seen.status} ${
      JSON.stringify(seen.body)
    }`,
  );
  assert(
    h.callsTo("redis").length > 0,
    `${testCase.id}: the route must have reached Upstash`,
  );
  assert(
    !leaksInternalDetail(JSON.stringify(seen.body)),
    `${testCase.id}: response body must not expose upstream detail: ${
      JSON.stringify(seen.body)
    }`,
  );
  if (expected === 200) {
    // Fail-open: the consent write still happened and the fold reflects it.
    const status = scopesOf(seen.body)?.find((s) => s.scope === scope);
    assertEquals(
      status?.active,
      false,
      `${testCase.id}: scope must read withdrawn`,
    );
    assertEquals(
      status?.lastAction,
      "withdrawn",
      `${testCase.id}: lastAction must be withdrawn`,
    );
    assertEquals(
      h.rowsFor(session.userId).length,
      1,
      `${testCase.id}: exactly one ledger row`,
    );
    assertEquals(
      h.callsTo("postgrest").length,
      3,
      `${testCase.id}: 3 PostgREST round trips`,
    );
  } else if (expected === 429) {
    assertEquals(
      seen.code,
      "rate_limited",
      `${testCase.id}: 429 must carry rate_limited`,
    );
    assertEquals(
      h.rowsFor(session.userId).length,
      0,
      `${testCase.id}: a 429 must not write a row`,
    );
    assert(
      seen.retryAfter !== null,
      `${testCase.id}: a 429 must carry Retry-After`,
    );
  } else {
    // Pinned known-broken status (U10): no consent row may have been written.
    assertEquals(
      h.rowsFor(session.userId).length,
      0,
      `${testCase.id}: a rejected request writes nothing`,
    );
  }

  if (testCase.id === "U14-redis-hang") {
    // Serialized Redis timeouts, not a single one: the request cost is
    // (#pipelines × REDIS_TIMEOUT_MS). Pinned so a circuit breaker shows up here.
    const redisCalls = h.callsTo("redis").length;
    assert(
      redisCalls >= 4,
      `${testCase.id}: expected several Redis pipelines, saw ${redisCalls}`,
    );
    assert(
      seen.durationMs > 3_000,
      `${testCase.id}: hung Upstash used to cost ~${redisCalls}×1.2s; it now took ${seen.durationMs}ms — re-classify`,
    );
  }
}

CASES.forEach((testCase, index) => {
  Deno.test({
    name: `redis-fault ${testCase.id}: ${testCase.detail}`,
    ignore: Boolean(testCase.slow) && !SLOW,
    async fn() {
      const h = await loadStressHarness({ redis: true });
      await runCase(h, index, testCase);
    },
  });
});

Deno.test({
  name:
    "redis-fault: a poisoned revocation marker survives Upstash recovery in L1 (sticky 401)",
  async fn() {
    const h = await loadStressHarness({ redis: true });
    h.reset();
    const scope = CONSENT_SCOPES[2];
    const session = h.mintSession(
      new Prng(caseSeed(STRESS_SEED, 3_000_098)).uuid(),
    );

    // One request while Upstash answers a string for the revocation key.
    h.fault = (ctx) =>
      ctx.upstream === "redis"
        ? { kind: "status", status: 200, body: [{ result: "nope" }] }
        : null;
    const poisoned = await observe(
      h.handler,
      withdrawRequest(session.accessToken, { scope }),
    );
    assertEquals(
      poisoned.status,
      401,
      "the poisoned marker is read as a revocation",
    );

    // Upstash is healthy again; the marker was copied into L1 for
    // L1_READTHROUGH_TTL_SECONDS, so the 401 outlives the fault.
    h.fault = null;
    const after = await observe(
      h.handler,
      withdrawRequest(session.accessToken, { scope }),
    );
    const sticky = after.status === 401;
    assertEquals(
      after.status,
      401,
      "REPRODUCED: the L1 copy of the poisoned marker keeps signing this session out after recovery",
    );
    assertEquals(
      h.rowsFor(session.userId).length,
      0,
      "no consent row is written while poisoned",
    );
    results.push({
      id: "U17-poisoned-marker-sticky",
      seed: caseSeed(STRESS_SEED, 3_000_098),
      scope,
      detail:
        "string at the revocation key → 401, then still 401 after Upstash recovers",
      status: after.status,
      expectedStatus: 401,
      errorCode: after.code,
      redisCalls: h.callsTo("redis").length,
      authCalls: h.callsTo("auth").length,
      postgrestCalls: h.callsTo("postgrest").length,
      verdict: "BROKEN(known)",
      knownBroken: sticky
        ? "the poisoned revocation marker is cached in L1, so the forced sign-out persists for L1_READTHROUGH_TTL_SECONDS after Upstash is healthy"
        : "recovered once Upstash was healthy",
      replay:
        `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_consent_withdraw_redis.test.ts --filter "poisoned revocation marker"`,
    });
  },
});

Deno.test({
  name: "redis-fault: Upstash recovers → the limiter resumes counting in Redis",
  async fn() {
    const h = await loadStressHarness({ redis: true });
    h.reset();
    const scope = CONSENT_SCOPES[0];
    const session = h.mintSession(
      new Prng(caseSeed(STRESS_SEED, 3_000_099)).uuid(),
    );

    // Outage, then recovery on the same session.
    h.fault = (
      ctx,
    ) => (ctx.upstream === "redis"
      ? { kind: "throw", message: "reset" }
      : null);
    const during = await observe(
      h.handler,
      withdrawRequest(session.accessToken, { scope }),
    );
    assertEquals(
      during.status,
      200,
      "a Redis outage must not lock the user out",
    );
    assertEquals(
      h.redis.size,
      0,
      "nothing can have been written to the faulted Redis",
    );

    h.fault = null;
    const after = await observe(
      h.handler,
      withdrawRequest(session.accessToken, { scope }),
    );
    assertEquals(after.status, 200);
    assert(
      h.redis.size > 0,
      "the limiter must resume writing windows once Upstash recovers",
    );
    assertEquals(
      h.rowsFor(session.userId).length,
      2,
      "both withdraws are appended",
    );

    const report = {
      unit: "route-post-v1-me-consent-withdraw",
      lens: "failure-load/upstash",
      baseSeed: STRESS_SEED,
      slowEnabled: SLOW,
      cases: results.length,
      verdicts: results.reduce<Record<string, number>>((acc, r) => {
        const v = String(r.verdict);
        acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {}),
      redisKeysAfterRecovery: [...h.redis.keys()].map((k) =>
        k.replace(/:[^:]+$/, ":<id>")
      ),
      rows: results,
    };
    const path = await writeJson("redis_faults.json", report);
    console.log(
      `[stress-redis] ${results.length} Upstash fault cases → ${
        JSON.stringify(report.verdicts)
      } (${path})`,
    );
  },
});
