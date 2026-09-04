// STRESS — public reads + router fallthrough with Upstash CONFIGURED (L2 rate
// limits + L2 auth cache): every Redis failure mode in turn against every
// public read and against the fallthrough, asserting the degraded class and
// the Redis / Supabase round trips per request.
//
//   deno test -A --no-check --config deno.json stress_public_fallthrough_redis.test.ts
//
// Env: STRESS_ITER (randomized iterations, default 100), STRESS_LOAD_N
// (requests per route, default 150), STRESS_SEED, STRESS_OUT_DIR.
//
// cache.ts reads UPSTASH_* at import, so this module boots its own copy of
// the handler with the fake Upstash wired (deno test runs each module in a
// fresh isolate).

import { assert, assertEquals } from "@std/assert";
import {
  apiRequest,
  envInt,
  type Fault,
  freshIp,
  iterationSeed,
  latencySummary,
  loadStressHarness,
  NO_FAULT,
  observe,
  type Observed,
  type RedisReplyShape,
  Rng,
  type StressHarness,
  type Upstream,
  UPSTREAMS,
  userOf,
  writeArtifact,
} from "./stress_fallthrough_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 100);
const STRESS_LOAD_N = envInt("STRESS_LOAD_N", 150);
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const AUTH_TIMEOUT_MS = 300;
const REDIS_TIMEOUT_MS = 1_200;

type RedisFault =
  | { kind: "fault"; name: string; fault: Fault }
  | { kind: "shape"; name: string; shape: RedisReplyShape };

/** Every way Upstash can misbehave for the pre-route pipeline. */
const REDIS_FAULTS: RedisFault[] = [
  { kind: "fault", name: "reject", fault: { kind: "reject" } },
  {
    kind: "fault",
    name: "hang-past-timeout",
    fault: { kind: "hang", hangMs: 5_000 },
  },
  {
    kind: "fault",
    name: "slow-400ms",
    fault: { kind: "slow_ok", delayMs: 400 },
  },
  { kind: "fault", name: "http500", fault: { kind: "http", status: 500 } },
  { kind: "fault", name: "http401", fault: { kind: "http", status: 401 } },
  {
    kind: "fault",
    name: "http429",
    fault: { kind: "http", status: 429, retryAfter: "9" },
  },
  { kind: "fault", name: "malformed_body", fault: { kind: "malformed_body" } },
  { kind: "fault", name: "empty_body", fault: { kind: "empty_body" } },
  { kind: "shape", name: "non_array", shape: "non_array" },
  { kind: "shape", name: "command_error", shape: "command_error" },
  { kind: "shape", name: "short_reply", shape: "short_reply" },
  { kind: "shape", name: "garbage_count", shape: "garbage_count" },
  { kind: "shape", name: "huge_count", shape: "huge_count" },
  { kind: "shape", name: "negative_count", shape: "negative_count" },
  { kind: "shape", name: "string_count", shape: "string_count" },
];

type BearerKind = "none" | "session" | "provider";

interface RouteCase {
  name: string;
  method: string;
  path: string;
  bearer: BearerKind;
  healthyStatus: number;
}

const ROUTES: RouteCase[] = [
  {
    name: "GET /healthz",
    method: "GET",
    path: "/healthz",
    bearer: "none",
    healthyStatus: 200,
  },
  {
    name: "HEAD /healthz",
    method: "HEAD",
    path: "/healthz",
    bearer: "none",
    healthyStatus: 200,
  },
  {
    name: "GET /privacy",
    method: "GET",
    path: "/privacy",
    bearer: "none",
    healthyStatus: 200,
  },
  {
    name: "GET /terms",
    method: "GET",
    path: "/terms",
    bearer: "none",
    healthyStatus: 200,
  },
  {
    name: "POST /healthz (no bearer)",
    method: "POST",
    path: "/healthz",
    bearer: "none",
    healthyStatus: 401,
  },
  {
    name: "GET /v1/nope (session)",
    method: "GET",
    path: "/v1/nope",
    bearer: "session",
    healthyStatus: 404,
  },
  {
    name: "DELETE /terms (provider)",
    method: "DELETE",
    path: "/terms",
    bearer: "provider",
    healthyStatus: 404,
  },
];

/** Redis is authoritative for what it answers: a reply that PARSES as a
 * count is believed (a huge counter means "over budget" → 429), a string in
 * a session's revocation-marker slot means "revoked" (→ 401 for a session
 * bearer; cache.ts cacheGetUnlessRevoked), and anything that does not parse
 * or fails outright falls back to the per-isolate L1 / re-verification. */
function expectedStatus(route: RouteCase, rf: RedisFault): number {
  if (rf.kind === "shape" && rf.shape === "huge_count") return 429;
  // garbage_count answers EVERY GET with a string, including the revocation
  // marker GET (string_count only re-types real numeric counts, so the
  // marker's null stays null).
  if (
    rf.kind === "shape" && rf.shape === "garbage_count" &&
    route.bearer === "session"
  ) return 401;
  return route.healthyStatus;
}

function applyRedisFault(h: StressHarness, rf: RedisFault): void {
  h.faults.redis = rf.kind === "fault" ? rf.fault : NO_FAULT;
  h.redisReply = rf.kind === "shape" ? rf.shape : "real";
}

function clearRedisFault(h: StressHarness): void {
  h.faults.redis = NO_FAULT;
  h.redisReply = "real";
}

function counts(h: StressHarness, from: number): Record<Upstream, number> {
  const c = { auth_user: 0, auth_token: 0, rest: 0, redis: 0, revenuecat: 0 };
  for (const call of h.calls.slice(from)) c[call.upstream] += 1;
  return c;
}

function bearerFor(
  h: StressHarness,
  kind: BearerKind,
  index: number,
): string | null {
  if (kind === "none") return null;
  if (kind === "session") return h.sessionFor(userOf(index));
  return h.providerTokenFor(userOf(index, "google"));
}

interface Row {
  id: string;
  route: string;
  redisFault: string;
  expectedStatus: number;
  observed: Observed & { calls: Record<Upstream, number> };
  recovery: {
    status: number;
    sameBearerStatus: number;
    calls: Record<Upstream, number>;
  };
  outcome: "HELD" | "MISMATCH";
  detail?: string;
}

Deno.test("redis fault matrix: every Upstash failure mode × every public/fallthrough route", async () => {
  const h = await loadStressHarness({
    redis: true,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  assert(h.redisEnabled);
  const rows: Row[] = [];
  let index = 800_000;
  for (const route of ROUTES) {
    for (const rf of REDIS_FAULTS) {
      // A hang costs one REDIS_TIMEOUT_MS per pipeline; the dedicated hang test
      // below covers the public read and the bearer-less fallthrough, so the
      // matrix only pays for it on the pipeline-heaviest route.
      if (rf.name === "hang-past-timeout" && route.bearer !== "session") {
        continue;
      }
      index += 1;
      // Fresh bearer per case so the auth cache never hides the Redis path.
      const token = bearerFor(h, route.bearer, index);
      applyRedisFault(h, rf);
      const from = h.calls.length;
      const observed = await observe(
        h,
        apiRequest(route.method, route.path, { token }),
      );
      const calls = counts(h, from);
      clearRedisFault(h);
      // Recovery is judged with a FRESH bearer (a session whose revocation
      // marker was believed stays out for L1_READTHROUGH_TTL_SECONDS by
      // design); what the same bearer gets afterwards is recorded alongside.
      const sameBearer = await observe(
        h,
        apiRequest(route.method, route.path, { token }),
      );
      const recoveryFrom = h.calls.length;
      const recovered = await observe(
        h,
        apiRequest(route.method, route.path, {
          token: bearerFor(h, route.bearer, index + 50_000),
        }),
      );
      const row: Row = {
        id: `${route.name} × redis:${rf.name}`,
        route: route.name,
        redisFault: rf.name,
        expectedStatus: expectedStatus(route, rf),
        observed: {
          ...observed,
          bodyText: observed.bodyText.slice(0, 160),
          calls,
        },
        recovery: {
          status: recovered.status,
          sameBearerStatus: sameBearer.status,
          calls: counts(h, recoveryFrom),
        },
        outcome: "HELD",
      };
      if (observed.status !== row.expectedStatus) {
        row.outcome = "MISMATCH";
        row.detail =
          `status ${observed.status} ≠ ${row.expectedStatus} (${observed.message})`;
      } else if (recovered.status !== route.healthyStatus) {
        row.outcome = "MISMATCH";
        row.detail = `recovery ${recovered.status} ≠ ${route.healthyStatus}`;
      } else if (calls.rest !== 0 || calls.revenuecat !== 0) {
        row.outcome = "MISMATCH";
        row.detail = `PostgREST/RevenueCat touched: ${JSON.stringify(calls)}`;
      } else if (
        route.bearer === "none" && calls.auth_user + calls.auth_token !== 0
      ) {
        row.outcome = "MISMATCH";
        row.detail = `bearer-less request reached Supabase Auth: ${
          JSON.stringify(calls)
        }`;
      } else if (calls.redis === 0 && observed.status !== 429) {
        row.outcome = "MISMATCH";
        row.detail = "Redis configured but never consulted";
      } else if (observed.status >= 500) {
        row.outcome = "MISMATCH";
        row.detail = `Redis failure surfaced as ${observed.status}`;
      } else if (
        rf.name === "hang-past-timeout" &&
        observed.ms > (calls.redis + 0.5) * REDIS_TIMEOUT_MS
      ) {
        row.outcome = "MISMATCH";
        row.detail = `hung Redis held the request ${
          Math.round(observed.ms)
        }ms over ${calls.redis} pipelines`;
      } else if (
        rf.name !== "hang-past-timeout" && rf.name !== "slow-400ms" &&
        observed.ms > 500
      ) {
        row.outcome = "MISMATCH";
        row.detail = `fast-failing Redis fault still took ${
          Math.round(observed.ms)
        }ms`;
      }
      rows.push(row);
      assertEquals(row.outcome, "HELD", `${row.id}: ${row.detail}`);
    }
  }
  const path = await writeArtifact("fault_matrix_redis.json", {
    mode: "redis",
    redisTimeoutMs: REDIS_TIMEOUT_MS,
    cases: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    redisRoundTripsPerRequest: Object.fromEntries(
      ROUTES.map((r) => [
        r.name,
        rows.find((row) =>
          row.route === r.name && row.redisFault === "string_count"
        )?.recovery.calls
          .redis,
      ]),
    ),
    rows,
  });
  console.warn(`[stress] redis fault matrix: ${rows.length} cases → ${path}`);
});

Deno.test("redis: a hung Upstash is bounded by REDIS_TIMEOUT_MS on /healthz and the fallthrough", async () => {
  const h = await loadStressHarness({
    redis: true,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  h.faults.redis = { kind: "hang", hangMs: 10_000 };
  const started = performance.now();
  const healthz = await observe(h, apiRequest("GET", "/healthz"));
  const healthzMs = performance.now() - started;
  assertEquals(healthz.status, 200);
  assert(
    healthzMs >= REDIS_TIMEOUT_MS - 50 && healthzMs < REDIS_TIMEOUT_MS + 400,
    `${healthzMs}ms`,
  );
  const t2 = performance.now();
  const fallthrough = await observe(h, apiRequest("POST", "/healthz"));
  const fallthroughMs = performance.now() - t2;
  assertEquals(fallthrough.status, 401);
  // Three Redis pipelines run in sequence (ip INCR, authfail GET, authfail
  // INCR) — each waits its own timeout, so a hung Redis costs ~3×1.2s here.
  const pipelines = h.callsTo("redis").length;
  assert(fallthroughMs < REDIS_TIMEOUT_MS * 4, `${fallthroughMs}ms`);
  clearRedisFault(h);
  const path = await writeArtifact("redis_hang_latency.json", {
    healthzMs: Math.round(healthzMs),
    fallthroughNoBearerMs: Math.round(fallthroughMs),
    redisPipelinesObserved: pipelines,
  });
  console.warn(
    `[stress] redis hang: healthz ${Math.round(healthzMs)}ms, fallthrough ${
      Math.round(fallthroughMs)
    }ms → ${path}`,
  );
});

Deno.test("redis: shared budgets hold across faults — the L2 count is what limits", async () => {
  const h = await loadStressHarness({
    redis: true,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const ip = freshIp();
  // 60 public reads per minute per IP; the 61st is 429 with Retry-After.
  const statuses: number[] = [];
  for (let i = 0; i < 62; i += 1) {
    statuses.push(
      (await observe(h, apiRequest("GET", "/healthz", { ip }))).status,
    );
  }
  assertEquals(statuses.slice(0, 60).every((s) => s === 200), true);
  assertEquals(statuses.slice(60), [429, 429]);
  // Redis down mid-window: the isolate falls back to its own (empty) window,
  // so the IP is let through again — fail-open is the documented trade.
  h.faults.redis = { kind: "reject" };
  const failOpen = await observe(h, apiRequest("GET", "/healthz", { ip }));
  assertEquals(failOpen.status, 200);
  clearRedisFault(h);
  // Redis back: the shared count is still over budget.
  const again = await observe(h, apiRequest("GET", "/healthz", { ip }));
  assertEquals(again.status, 429);
  // A rate-limited public read never consults Supabase.
  assertEquals(
    h.callsTo("auth_user").length + h.callsTo("auth_token").length,
    0,
  );
});

Deno.test(`redis randomized: ${STRESS_ITER} seeded iterations of route × redis fault × bearer`, async () => {
  const h = await loadStressHarness({
    redis: true,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const fast = REDIS_FAULTS.filter((f) =>
    f.name !== "hang-past-timeout" && f.name !== "slow-400ms"
  );
  const rows: Array<{
    seed: number;
    route: string;
    redisFault: string;
    authFault: Fault;
    expected: number;
    observed: number;
    ms: number;
    calls: Record<Upstream, number>;
    outcome: "HELD" | "MISMATCH";
    detail?: string;
  }> = [];
  for (let i = 0; i < STRESS_ITER; i += 1) {
    const seed = iterationSeed(CAMPAIGN_SEED ^ 0x5eed, i);
    const rng = new Rng(seed);
    const route = rng.pick(ROUTES);
    const rf = rng.pick(fast);
    const authFault: Fault = rng.chance(0.25)
      ? rng.pick<Fault>([
        { kind: "reject" },
        { kind: "http", status: 503 },
        { kind: "malformed_body" },
        { kind: "http", status: 401 },
      ])
      : NO_FAULT;
    const token = bearerFor(h, route.bearer, 900_000 + i);
    applyRedisFault(h, rf);
    h.faults.auth_user = authFault;
    h.faults.auth_token = authFault;
    const from = h.calls.length;
    const o = await observe(h, apiRequest(route.method, route.path, { token }));
    const calls = counts(h, from);
    clearRedisFault(h);
    h.faults.auth_user = NO_FAULT;
    h.faults.auth_token = NO_FAULT;

    let expected = expectedStatus(route, rf);
    if (
      expected === route.healthyStatus && route.bearer !== "none" &&
      authFault.kind !== "none"
    ) {
      const refusal = authFault.kind === "http" && authFault.status === 401;
      // Session bearer: outage → 503, refusal → 401. Provider bearer: 401
      // either way today (F1, pinned in the memory-mode module).
      expected = route.bearer === "session" && !refusal ? 503 : 401;
    }
    const row = {
      seed,
      route: route.name,
      redisFault: rf.name,
      authFault,
      expected,
      observed: o.status,
      ms: Math.round(o.ms * 1000) / 1000,
      calls,
      outcome: "HELD" as "HELD" | "MISMATCH",
      detail: undefined as string | undefined,
    };
    if (o.status !== expected) {
      row.outcome = "MISMATCH";
      row.detail = `status ${o.status} ≠ ${expected} (${o.message})`;
    } else if (calls.rest + calls.revenuecat !== 0) {
      row.outcome = "MISMATCH";
      row.detail = "PostgREST/RevenueCat touched";
    }
    rows.push(row);
  }
  const mismatches = rows.filter((r) => r.outcome === "MISMATCH");
  // Flake triage: a mismatching seed is replayed 10× (same route, fault and
  // bearer kind; fresh bearer) and the reproduction rate recorded.
  const replays: Array<{ seed: number; reproduced: number; of: number }> = [];
  for (const m of mismatches) {
    let reproduced = 0;
    for (let k = 0; k < 10; k += 1) {
      const rng = new Rng(m.seed);
      const route = rng.pick(ROUTES);
      const rf = rng.pick(fast);
      const token = bearerFor(h, route.bearer, 990_000 + k);
      applyRedisFault(h, rf);
      h.faults.auth_user = m.authFault;
      h.faults.auth_token = m.authFault;
      const o = await observe(
        h,
        apiRequest(route.method, route.path, { token }),
      );
      clearRedisFault(h);
      h.faults.auth_user = NO_FAULT;
      h.faults.auth_token = NO_FAULT;
      if (o.status === m.observed) reproduced += 1;
    }
    replays.push({ seed: m.seed, reproduced, of: 10 });
  }
  const byOutcome: Record<string, number> = {};
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const path = await writeArtifact("random_campaign_redis.json", {
    mode: "redis",
    campaignSeed: CAMPAIGN_SEED ^ 0x5eed,
    iterations: rows.length,
    byOutcome,
    mismatchSeeds: mismatches.map((m) => m.seed),
    replays,
    rows,
  });
  console.warn(
    `[stress] redis random: ${rows.length} iterations → ${
      JSON.stringify(byOutcome)
    } → ${path}`,
  );
  assertEquals(mismatches.map((m) => `${m.seed}: ${m.detail}`), []);
});

Deno.test(`redis load: ${STRESS_LOAD_N} requests per route — latency + Redis/Supabase round trips`, async () => {
  const h = await loadStressHarness({
    redis: true,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const report: Record<string, unknown> = {};
  let total = 0;
  for (const route of ROUTES) {
    const chunkTokens = new Map<number, string | null>();
    const tokenForChunk = (chunk: number): string | null => {
      if (!chunkTokens.has(chunk)) {
        chunkTokens.set(
          chunk,
          bearerFor(
            h,
            route.bearer,
            950_000 + ROUTES.indexOf(route) * 1_000 + chunk,
          ),
        );
      }
      return chunkTokens.get(chunk) ?? null;
    };
    const samples: number[] = [];
    const statuses: Record<string, number> = {};
    const perRequest: Record<Upstream, number[]> = {
      auth_user: [],
      auth_token: [],
      rest: [],
      redis: [],
      revenuecat: [],
    };
    for (let i = 0; i < STRESS_LOAD_N; i += 1) {
      const from = h.calls.length;
      // Fresh IP per request keeps the per-IP budgets out of the way; the
      // per-user budget (240/min) is what a single bearer would hit, so the
      // authenticated routes rotate users every 200 requests.
      const bearer = tokenForChunk(Math.floor(i / 200));
      const o = await observe(
        h,
        apiRequest(route.method, route.path, { token: bearer }),
      );
      samples.push(o.ms);
      statuses[o.status] = (statuses[o.status] ?? 0) + 1;
      const c = counts(h, from);
      for (const u of UPSTREAMS) perRequest[u].push(c[u]);
      total += 1;
    }
    const max = Object.fromEntries(
      UPSTREAMS.map((u) => [u, Math.max(...perRequest[u])]),
    );
    const steady = Object.fromEntries(
      UPSTREAMS.map((u) => [u, perRequest[u][perRequest[u].length - 1]]),
    );
    report[route.name] = {
      latency: latencySummary(samples),
      statuses,
      roundTripsPerRequest: {
        max,
        steadyState: steady,
        first: Object.fromEntries(UPSTREAMS.map((u) => [u, perRequest[u][0]])),
      },
    };
    assertEquals(
      statuses,
      { [route.healthyStatus]: STRESS_LOAD_N },
      route.name,
    );
    assert(
      max.auth_user + max.auth_token + max.rest <= 3,
      `${route.name}: >3 Supabase round trips in one request`,
    );
    if (route.bearer === "none") {
      assertEquals(max.auth_user + max.auth_token, 0);
    }
  }
  const path = await writeArtifact("load_redis.json", {
    mode: "redis",
    perRoute: STRESS_LOAD_N,
    totalRequests: total,
    routes: report,
  });
  console.warn(`[stress] load (redis): ${total} requests → ${path}`);
});
