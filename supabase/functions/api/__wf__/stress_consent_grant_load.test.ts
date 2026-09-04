/**
 * stress-consent-grant-load — LOAD for POST /v1/me/consent/grant.
 *
 * The REAL handler runs in-process (stress_consent_grant_harness.ts) with NO
 * Upstash configured, so every cache and rate-limit window lives in the
 * function's own L1 memory — exactly the per-isolate state this campaign
 * measures. Three campaigns, all seeded and replayable:
 *
 *   hot      STRESS_ITER  grants spread over STRESS_HOT_USERS users (each stays
 *            under the 30/60s consent budget): p50/p95 latency and the
 *            Supabase round trips of every request, split cold (first request
 *            of a user: Auth + insert + read-back) vs warm (insert + read-back).
 *            A warm grant spending >3 Supabase round trips is a finding.
 *   churn    STRESS_USERS distinct users, one grant each (distinct IPs): heap
 *            before/after with the fake's own state dropped, so the delta is
 *            the function's L1 auth cache + rate-limit windows; plus a probe
 *            that the L1 auth cache is bounded (an early user must be evicted
 *            → its next request goes back to Auth) and that the churn did not
 *            corrupt an unrelated user's consent status.
 *   burst    STRESS_BURST concurrent grants for one user: the ledger gets
 *            exactly N rows, the fold is consistent, nothing 5xx.
 *
 *   deno test -A --no-check --config deno.json stress_consent_grant_load.test.ts
 *   STRESS_ITER=1000 STRESS_USERS=20000 STRESS_BURST=64 …     # the full campaign
 *   deno test -A --no-check --v8-flags=--expose-gc …          # precise heap numbers
 *
 * Results → <STRESS_OUT_DIR>/load_{hot,churn,burst}.json (seed → outcome).
 */
import { assert, assertEquals } from "@std/assert";
import {
  activeScopes,
  call,
  CONSENT_SCOPES,
  envInt,
  expectedActive,
  fnv1a,
  grantBody,
  grantRequest,
  heapNow,
  histogram,
  loadStressHarness,
  percentile,
  Prng,
  seededActor,
  statusRequest,
  validStatusBody,
  writeJson,
} from "./stress_consent_grant_harness.ts";

const SEED = envInt("STRESS_SEED", 20260904);
const ITER = envInt("STRESS_ITER", 120);
const HOT_USERS = envInt("STRESS_HOT_USERS", Math.max(4, Math.ceil(ITER / 25)));
const USERS = envInt("STRESS_USERS", 600);
const BURST = envInt("STRESS_BURST", 16);
const WARM_ROUND_TRIP_BUDGET = envInt("STRESS_ROUND_TRIP_BUDGET", 3);
const P95_BUDGET_MS = envInt("STRESS_P95_BUDGET_MS", 50);

const replay = (extra: string) =>
  `STRESS_SEED=${SEED} STRESS_ITER=${ITER} STRESS_HOT_USERS=${HOT_USERS} STRESS_USERS=${USERS} STRESS_BURST=${BURST} ${extra}deno test -A --no-check --config deno.json stress_consent_grant_load.test.ts`;

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? NaN,
    mean: sorted.length
      ? sorted.reduce((a, b) => a + b, 0) / sorted.length
      : NaN,
  };
};

Deno.test("stress-consent-grant-load: hot path — p50/p95 latency and Supabase round trips per request", async () => {
  const h = await loadStressHarness({ redis: false });
  h.reset();
  h.recordCalls = false;
  const rng = new Prng((SEED ^ fnv1a("hot")) >>> 0);
  const actors = Array.from({ length: HOT_USERS }, () => seededActor(h, rng));
  const perUser = new Map<string, number>();
  const rows: Array<Record<string, unknown>> = [];
  const latencies: number[] = [];
  const coldTrips: number[] = [];
  const warmTrips: number[] = [];
  const statuses: number[] = [];
  const failures: string[] = [];

  for (let i = 0; i < ITER; i += 1) {
    const actor = actors[i % actors.length];
    const scope = rng.pick(CONSENT_SCOPES);
    const nth = (perUser.get(actor.userId) ?? 0) + 1;
    perUser.set(actor.userId, nth);
    if (nth > 30) {
      throw new Error(
        "campaign sizing error: a user would exceed the consent budget",
      );
    }
    const out = await call(
      h,
      grantRequest(
        actor,
        grantBody(scope, { consentVersion: `v${rng.int(1, 9)}` }),
      ),
    );
    latencies.push(out.latencyMs);
    statuses.push(out.status);
    (nth === 1 ? coldTrips : warmTrips).push(out.counts.supabase);
    const observed = activeScopes(out.body);
    const expected = expectedActive(h, actor.userId);
    const ok = out.status === 200 &&
      validStatusBody(out.body) &&
      observed !== null &&
      Object.keys(expected).every((s) => observed[s] === expected[s]) &&
      out.counts.revenuecat === 0 &&
      out.counts.redis === 0;
    if (!ok) {
      failures.push(
        `iter ${i} user ${actor.userId} → ${out.status} ${
          out.text.slice(0, 120)
        }`,
      );
    }
    rows.push({
      iter: i,
      userId: actor.userId,
      nth,
      scope,
      status: out.status,
      latencyMs: Number(out.latencyMs.toFixed(3)),
      supabaseRoundTrips: out.counts.supabase,
      auth: out.counts.auth,
      restInsert: out.counts.restInsert,
      restSelect: out.counts.restSelect,
    });
  }

  const warmOverBudget = rows.filter(
    (r) =>
      (r.nth as number) > 1 &&
      (r.supabaseRoundTrips as number) > WARM_ROUND_TRIP_BUDGET,
  );
  const report = {
    campaign: "stress-consent-grant-load/hot",
    seed: SEED,
    iterations: ITER,
    users: HOT_USERS,
    statusHistogram: histogram(statuses),
    latencyMs: summarize(latencies),
    supabaseRoundTrips: {
      cold: histogram(coldTrips),
      warm: histogram(warmTrips),
      warmBudget: WARM_ROUND_TRIP_BUDGET,
      warmOverBudget: warmOverBudget.length,
    },
    ledgerRows: h.consentRows.length,
    failures,
    rows,
    replay: replay(""),
  };
  const path = await writeJson("load_hot.json", report);
  console.log(
    `stress-consent-grant-load/hot: n=${ITER} p50=${
      report.latencyMs.p50.toFixed(2)
    }ms p95=${report.latencyMs.p95.toFixed(2)}ms cold=${
      JSON.stringify(report.supabaseRoundTrips.cold)
    } warm=${JSON.stringify(report.supabaseRoundTrips.warm)} → ${path}`,
  );

  assertEquals(failures, [], `hot-path grants failed (see ${path})`);
  assertEquals(
    h.consentRows.length,
    ITER,
    "every accepted grant appended exactly one ledger row",
  );
  assertEquals(
    warmOverBudget.map((r) =>
      `iter ${r.iter}: ${r.supabaseRoundTrips} round trips`
    ),
    [],
    `warm grants exceeded ${WARM_ROUND_TRIP_BUDGET} Supabase round trips`,
  );
  assert(
    report.latencyMs.p95 <= P95_BUDGET_MS,
    `p95 ${
      report.latencyMs.p95.toFixed(2)
    }ms exceeds the in-process budget of ${P95_BUDGET_MS}ms (fake upstreams answer instantly, so this is pure function overhead)`,
  );
});

Deno.test("stress-consent-grant-load: churn — L1 cache memory and boundedness under distinct users", async () => {
  const h = await loadStressHarness({ redis: false });
  h.reset();
  h.recordCalls = false;
  const rng = new Prng((SEED ^ fnv1a("churn")) >>> 0);

  // A bystander whose consent state must survive the churn untouched.
  const bystander = seededActor(h, rng);
  const bystanderGrant = await call(
    h,
    grantRequest(bystander, grantBody("video_analysis")),
  );
  assertEquals(bystanderGrant.status, 200);
  assertEquals(
    bystanderGrant.counts.supabase,
    3,
    "cold grant = Auth + insert + read-back",
  );
  // Warm: the bystander is now cached in L1.
  const bystanderWarm = await call(h, statusRequest(bystander));
  assertEquals(
    bystanderWarm.counts.auth,
    0,
    "second request served from the L1 auth cache",
  );

  const heapStart = heapNow();
  const statuses: number[] = [];
  const trips: number[] = [];
  const latencies: number[] = [];
  const failures: string[] = [];
  const sampleRows: Array<Record<string, unknown>> = [];
  const heapSamples: Array<{ users: number; heapUsed: number; rss: number }> =
    [];
  const firstUsers: Array<ReturnType<typeof seededActor>> = [];
  const started = performance.now();

  for (let i = 0; i < USERS; i += 1) {
    const actor = seededActor(h, rng);
    if (i < 3) firstUsers.push(actor);
    const out = await call(
      h,
      grantRequest(actor, grantBody(rng.pick(CONSENT_SCOPES))),
    );
    statuses.push(out.status);
    trips.push(out.counts.supabase);
    latencies.push(out.latencyMs);
    if (out.status !== 200 || out.counts.supabase !== 3) {
      failures.push(
        `user #${i} ${actor.userId} → ${out.status} trips=${out.counts.supabase}`,
      );
    }
    if (i % Math.max(1, Math.floor(USERS / 40)) === 0 || i === USERS - 1) {
      sampleRows.push({
        i,
        userId: actor.userId,
        status: out.status,
        latencyMs: Number(out.latencyMs.toFixed(3)),
        supabaseRoundTrips: out.counts.supabase,
      });
    }
    if (i % Math.max(1, Math.floor(USERS / 10)) === 0 || i === USERS - 1) {
      const mem = Deno.memoryUsage();
      heapSamples.push({ users: i + 1, heapUsed: mem.heapUsed, rss: mem.rss });
    }
  }
  const durationMs = performance.now() - started;

  // Boundedness probe: with more distinct users than the L1 cap, an early user
  // must have been evicted (its next request goes back to Supabase Auth).
  const probe = await call(h, statusRequest(firstUsers[0]));
  const evicted = probe.counts.auth === 1;
  const bystanderStatus = await call(h, statusRequest(bystander));
  const bystanderTrips = bystanderStatus.counts.auth;

  // Heap with the fake's own bulk state dropped: what remains is the
  // function's L1 (auth cache + rate-limit windows + module state).
  const heapWithFake = heapNow();
  const ledgerRows = h.consentRows.length;
  h.dropFakeState();
  const heapFunctionOnly = heapNow();

  const report = {
    campaign: "stress-consent-grant-load/churn",
    seed: SEED,
    users: USERS,
    durationMs: Number(durationMs.toFixed(0)),
    statusHistogram: histogram(statuses),
    supabaseRoundTrips: histogram(trips),
    latencyMs: summarize(latencies),
    ledgerRows,
    l1: {
      firstUserEvictedFromAuthCache: evicted,
      firstUserProbeAuthCalls: probe.counts.auth,
      bystanderStatusAfterChurn: activeScopes(bystanderStatus.body),
      bystanderAuthCallsAfterChurn: bystanderTrips,
    },
    heap: {
      gcExposed: typeof (globalThis as { gc?: unknown }).gc === "function",
      start: heapStart,
      afterCampaignWithFakeState: heapWithFake,
      afterCampaignFunctionOnly: heapFunctionOnly,
      deltaFunctionOnlyBytes: heapFunctionOnly.heapUsed - heapStart.heapUsed,
      deltaWithFakeStateBytes: heapWithFake.heapUsed - heapStart.heapUsed,
      samples: heapSamples,
    },
    failures,
    sampleRows,
    replay: replay(""),
  };
  const path = await writeJson("load_churn.json", report);
  console.log(
    `stress-consent-grant-load/churn: users=${USERS} p50=${
      report.latencyMs.p50.toFixed(2)
    }ms p95=${report.latencyMs.p95.toFixed(2)}ms heapΔ(function only)=${
      (report.heap.deltaFunctionOnlyBytes / 1e6).toFixed(1)
    }MB evicted=${evicted} → ${path}`,
  );

  assertEquals(failures, [], `churn grants failed (see ${path})`);
  assertEquals(
    ledgerRows,
    USERS + 1,
    "one ledger row per user plus the bystander",
  );
  assertEquals(
    activeScopes(bystanderStatus.body),
    {
      video_analysis: true,
      model_training: false,
      evaluation_telemetry: false,
    },
    "an unrelated user's consent status survives the churn",
  );
  if (USERS > 5_000) {
    assert(
      evicted,
      "L1 auth cache must be bounded: an early user is evicted after >5000 distinct users",
    );
  }
  // The function's own retained memory per distinct user must stay small even
  // when the campaign exceeds every L1 cap (caps: 5000 auth entries, 20000
  // rate-limit windows).
  const perUserBytes = report.heap.deltaFunctionOnlyBytes / USERS;
  assert(
    report.heap.deltaFunctionOnlyBytes < 64 * 1024 * 1024,
    `function-only heap grew ${report.heap.deltaFunctionOnlyBytes} bytes (${
      perUserBytes.toFixed(0)
    } B/user)`,
  );
});

Deno.test("stress-consent-grant-load: burst — concurrent grants for one user append exactly N rows", async () => {
  const h = await loadStressHarness({ redis: false });
  h.reset();
  h.recordCalls = false;
  const rng = new Prng((SEED ^ fnv1a("burst")) >>> 0);
  const actor = seededActor(h, rng);
  const n = Math.min(BURST, 30);
  const scopes = Array.from({ length: n }, () => rng.pick(CONSENT_SCOPES));
  // Per-request windows overlap under concurrency, so upstream calls are
  // attributed to the burst as a whole (counter deltas around Promise.all).
  const countsBefore = { ...h.counts };
  const started = performance.now();
  const outs = await Promise.all(
    scopes.map((scope) => call(h, grantRequest(actor, grantBody(scope)))),
  );
  const durationMs = performance.now() - started;
  const burstCounts = {
    auth: h.counts.auth - countsBefore.auth,
    restInsert: h.counts.restInsert - countsBefore.restInsert,
    restSelect: h.counts.restSelect - countsBefore.restSelect,
    supabase: h.counts.supabase - countsBefore.supabase,
    revenuecat: h.counts.revenuecat - countsBefore.revenuecat,
  };
  const statuses = outs.map((o) => o.status);
  const final = await call(h, statusRequest(actor));
  const report = {
    campaign: "stress-consent-grant-load/burst",
    seed: SEED,
    burst: n,
    durationMs: Number(durationMs.toFixed(1)),
    statusHistogram: histogram(statuses),
    upstreamCallsForBurst: burstCounts,
    ledgerRows: h.rowsFor(actor.userId).length,
    finalStatus: activeScopes(final.body),
    expected: expectedActive(h, actor.userId),
    replay: replay(""),
  };
  const path = await writeJson("load_burst.json", report);
  console.log(
    `stress-consent-grant-load/burst: n=${n} ${
      JSON.stringify(report.statusHistogram)
    } → ${path}`,
  );

  assertEquals(
    histogram(statuses),
    { "200": n },
    `burst statuses (see ${path})`,
  );
  assertEquals(
    h.rowsFor(actor.userId).length,
    n,
    "exactly one ledger row per concurrent grant",
  );
  assertEquals(activeScopes(final.body), expectedActive(h, actor.userId));
  for (const scope of new Set(scopes)) {
    assertEquals(activeScopes(final.body)?.[scope], true);
  }
  // Concurrent cold requests for the same token all miss the cache and each
  // verify with Auth — bounded by the burst, never amplified.
  assert(
    burstCounts.auth <= n,
    `auth calls ${burstCounts.auth} exceed the burst ${n}`,
  );
  assertEquals(burstCounts.restInsert, n, "one insert per grant");
  assertEquals(burstCounts.restSelect, n, "one read-back per grant");
  assertEquals(burstCounts.revenuecat, 0);
});
