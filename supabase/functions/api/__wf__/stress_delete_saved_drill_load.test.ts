// stress — LOAD for DELETE /v1/me/saved-drills/:slug against the REAL handler
// with in-memory upstreams (Redis OFF → per-isolate L1 + memory rate limits,
// the mode the function runs in without UPSTASH_* secrets).
//
//   A. sequential latency campaign: STRESS_LOAD_N requests (default 1000),
//      p50/p95/p99 wall time per request and the EXACT number of Supabase
//      round trips (Auth + PostgREST) each request cost. The lens flags a hot
//      path doing >3 round trips; the contract here is 1 (warm bearer) or 2
//      (first sight of a bearer).
//   B. concurrent burst: 200 in-flight requests across 20 warm users.
//   C. L1 memory under STRESS_USERS distinct users (default 2000; the campaign
//      ran 20 000): one DELETE per never-seen user, heap/RSS before/after,
//      and the observable consequences of the per-isolate caps —
//      cache.ts MEMORY_MAX_ENTRIES (5 000 auth rows, drop-oldest-third) and
//      rateLimit.ts MEMORY_WINDOW_MAX (20 000 windows, CLEARED when full).
//
// Replay:
//   STRESS_SEED=<seed> STRESS_LOAD_N=1000 STRESS_USERS=20000 \
//     deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_delete_saved_drill_load.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  deleteSavedDrillRequest,
  FakeUpstream,
  type FakeUser,
  fnv1a,
  histogram,
  loadStressHarness,
  percentile,
  Prng,
  STRESS_LOAD_N,
  STRESS_SEED,
  STRESS_USERS,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const gc = (globalThis as { gc?: () => void }).gc;
// V8 sweeps lazily after a full GC; two collections with a macrotask in
// between give a stable heapUsed.
const memory = async () => {
  gc?.();
  await new Promise((r) => setTimeout(r, 0));
  gc?.();
  const m = Deno.memoryUsage();
  return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
};
const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 100) / 100;

const seedFor = (label: string) => (STRESS_SEED ^ fnv1a(`load:${label}`)) >>> 0;

Deno.test({
  name: `stress load A: ${STRESS_LOAD_N} sequential DELETEs — p50/p95 latency + Supabase round trips per request`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const seed = seedFor("sequential");
    const prng = new Prng(seed);
    // 200 requests per user keeps every user under the 240/min general budget.
    const perUser = 200;
    const users: Array<{ user: FakeUser; token: string; ip: string }> = Array.from(
      { length: Math.ceil(STRESS_LOAD_N / perUser) },
      () => {
        const user = fake.newUser(prng);
        return { user, token: fake.sessionToken(user, prng), ip: prng.ip() };
      },
    );
    fake.reset();
    const latencies: number[] = [];
    const roundTrips: number[] = [];
    const statuses: number[] = [];
    const perRequest: Array<{
      i: number;
      user: number;
      ms: number;
      supabase: number;
      auth: number;
      delete: number;
      status: number;
    }> = [];
    for (let i = 0; i < STRESS_LOAD_N; i++) {
      const u = users[Math.floor(i / perUser)];
      const slug = prng.slug();
      fake.seedSavedDrill(u.user.id, slug);
      const before = fake.calls.length;
      const started = performance.now();
      const response = await h.handler(
        deleteSavedDrillRequest({ token: u.token, ip: u.ip, rawSlug: slug }),
      );
      const ms = performance.now() - started;
      await response.text();
      const calls = fake.calls.slice(before);
      const supabase = calls.filter((c) => c.target !== "redis" && c.target !== "rc").length;
      latencies.push(ms);
      roundTrips.push(supabase);
      statuses.push(response.status);
      perRequest.push({
        i,
        user: Math.floor(i / perUser),
        ms: Math.round(ms * 1000) / 1000,
        supabase,
        auth: calls.filter((c) => c.target === "auth_user").length,
        delete: calls.filter((c) => c.target === "rest_delete").length,
        status: response.status,
      });
      assert(fake.hasSavedDrill(u.user.id, slug) === false, `request ${i}: row deleted`);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const coldRequests = perRequest.filter((r) => r.i % perUser === 0);
    const warmRequests = perRequest.filter((r) => r.i % perUser !== 0);
    const summary = {
      seed,
      requests: STRESS_LOAD_N,
      users: users.length,
      statusHistogram: histogram(statuses),
      latencyMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1],
        mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      },
      supabaseRoundTrips: {
        histogram: histogram(roundTrips),
        max: Math.max(...roundTrips),
        perRequestMean: roundTrips.reduce((a, b) => a + b, 0) / roundTrips.length,
        coldMax: Math.max(...coldRequests.map((r) => r.supabase)),
        warmMax: Math.max(...warmRequests.map((r) => r.supabase)),
        authCallsTotal: fake.callsTo("auth_user").length,
        deleteCallsTotal: fake.callsTo("rest_delete").length,
        revenueCatCalls: fake.callsTo("rc").length,
      },
    };
    const path = await writeJson("load_sequential", { ...summary, perRequest });
    console.log(`[stress] load A: ${JSON.stringify(summary)} → ${path}`);

    assertEquals(summary.statusHistogram, { "204": STRESS_LOAD_N }, "every DELETE is 204");
    assert(
      summary.supabaseRoundTrips.max <= 3,
      `hot path >3 Supabase round trips: ${JSON.stringify(summary.supabaseRoundTrips.histogram)}`,
    );
    assertEquals(
      summary.supabaseRoundTrips.warmMax,
      1,
      "a warm bearer costs exactly one PostgREST round trip",
    );
    assertEquals(
      summary.supabaseRoundTrips.coldMax,
      2,
      "first sight of a bearer costs Auth + PostgREST",
    );
    assertEquals(
      summary.supabaseRoundTrips.authCallsTotal,
      users.length,
      "Supabase Auth consulted once per bearer",
    );
    assertEquals(summary.supabaseRoundTrips.revenueCatCalls, 0);
  },
});

Deno.test({
  name: "stress load B: 200 concurrent DELETEs across 20 warm users",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const seed = seedFor("burst");
    const prng = new Prng(seed);
    const users = Array.from({ length: 20 }, () => {
      const user = fake.newUser(prng);
      return { user, token: fake.sessionToken(user, prng), ip: prng.ip() };
    });
    for (const u of users) {
      const r = await h.handler(
        deleteSavedDrillRequest({ token: u.token, ip: u.ip, rawSlug: "warm" }),
      );
      assertEquals(r.status, 204);
      await r.text();
    }
    fake.reset();
    const jobs = Array.from({ length: 200 }, (_, i) => {
      const u = users[i % users.length];
      const slug = prng.slug();
      fake.seedSavedDrill(u.user.id, slug);
      return { u, slug };
    });
    const started = performance.now();
    const responses = await Promise.all(
      jobs.map(async ({ u, slug }) => {
        const t0 = performance.now();
        const r = await h.handler(
          deleteSavedDrillRequest({ token: u.token, ip: u.ip, rawSlug: slug }),
        );
        await r.text();
        return { status: r.status, ms: performance.now() - t0 };
      }),
    );
    const wallMs = performance.now() - started;
    const sorted = responses.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      seed,
      inFlight: 200,
      users: users.length,
      wallMs,
      perRequestMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1],
      },
      statusHistogram: histogram(responses.map((r) => r.status)),
      supabaseRoundTrips: fake.supabaseCalls().length,
      authCalls: fake.callsTo("auth_user").length,
      deleteCalls: fake.callsTo("rest_delete").length,
      rowsRemaining: jobs.filter(({ u, slug }) => fake.hasSavedDrill(u.user.id, slug)).length,
    };
    const path = await writeJson("load_burst", summary);
    console.log(`[stress] load B: ${JSON.stringify(summary)} → ${path}`);
    assertEquals(summary.statusHistogram, { "204": 200 });
    assertEquals(summary.authCalls, 0, "warm bearers: no Auth traffic under the burst");
    assertEquals(summary.deleteCalls, 200, "one PostgREST round trip per request");
    assertEquals(summary.rowsRemaining, 0);
  },
});

Deno.test({
  name: `stress load C: ${STRESS_USERS} distinct users — L1 auth cache + memory rate-limit windows`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: false });
    const { fake } = h;
    const seed = seedFor("users");
    const prng = new Prng(seed);

    // Sentinel: a user who exhausted the 240/min general budget BEFORE the flood.
    const sentinel = fake.newUser(prng);
    const sentinelToken = fake.sessionToken(sentinel, prng);
    const sentinelIp = prng.ip();
    const sentinelStatuses: number[] = [];
    for (let i = 0; i < 241; i++) {
      const r = await h.handler(
        deleteSavedDrillRequest({ token: sentinelToken, ip: sentinelIp, rawSlug: prng.slug() }),
      );
      sentinelStatuses.push(r.status);
      await r.text();
    }
    assertEquals(sentinelStatuses[240], 429, "sentinel budget exhausted before the flood");
    // First flood user, revisited after the flood to observe L1 auth eviction.
    const first = fake.newUser(prng);
    const firstToken = fake.sessionToken(first, prng);
    const firstIp = prng.ip();

    // Control: what the FAKE alone retains for STRESS_USERS users (sessions,
    // rows, recorded filters) — subtracted from the flood delta to bound the
    // handler-side L1 growth.
    const controlBefore = await memory();
    let control: FakeUpstream | null = new FakeUpstream();
    {
      const cprng = new Prng(seed ^ 0x5bd1e995);
      for (let i = 0; i < STRESS_USERS; i++) {
        const u = control.newUser(cprng);
        control.sessionToken(u, cprng);
        control.seedSavedDrill(u.id, cprng.slug());
        control.deleteFilters.push({ user_id: u.id, slug: cprng.slug(), bearerSub: u.id });
      }
    }
    const controlAfter = await memory();
    // Read the control AFTER measuring: V8 collects an object whose variable
    // is never read again, which would zero the control delta.
    const controlRetained = {
      sessions: control.sessions.size,
      filters: control.deleteFilters.length,
    };
    const controlHeapDelta = controlAfter.heapUsed - controlBefore.heapUsed;
    control = null;

    fake.reset();
    const before = await memory();
    const t0 = performance.now();
    const batch = 100;
    const statuses: Record<string, number> = {};
    let roundTrips = 0;
    let done = 0;
    const flood = async (i: number) => {
      const user = i === 0 ? first : fake.newUser(prng);
      const token = i === 0 ? firstToken : fake.sessionToken(user, prng);
      const ip = i === 0 ? firstIp : prng.ip();
      const slug = prng.slug();
      fake.seedSavedDrill(user.id, slug);
      const r = await h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: slug }));
      await r.text();
      statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
      if (r.status === 204) assert(!fake.hasSavedDrill(user.id, slug), `user ${i}: row deleted`);
    };
    for (let start = 0; start < STRESS_USERS; start += batch) {
      const n = Math.min(batch, STRESS_USERS - start);
      await Promise.all(Array.from({ length: n }, (_, k) => flood(start + k)));
      done += n;
      // The fake keeps every session/row for replay fidelity; keep its call log bounded.
      roundTrips += fake.supabaseCalls().length;
      fake.calls = [];
    }
    const wallMs = performance.now() - t0;
    const after = await memory();

    // Post-flood probes.
    fake.reset();
    const firstAgain = await h.handler(
      deleteSavedDrillRequest({ token: firstToken, ip: firstIp, rawSlug: "probe-first" }),
    );
    await firstAgain.text();
    const firstAgainAuthCalls = fake.callsTo("auth_user").length;
    fake.reset();
    const sentinelAgain = await h.handler(
      deleteSavedDrillRequest({ token: sentinelToken, ip: sentinelIp, rawSlug: "probe-sentinel" }),
    );
    await sentinelAgain.text();
    const settled = await memory();

    const summary = {
      seed,
      users: STRESS_USERS,
      requestsDone: done,
      statusHistogram: statuses,
      wallMs,
      supabaseRoundTrips: roundTrips,
      roundTripsPerUser: roundTrips / done,
      memoryBytes: { controlBefore, controlAfter, before, after, settled },
      memoryMb: {
        heapUsedBefore: mb(before.heapUsed),
        heapUsedAfter: mb(after.heapUsed),
        heapUsedDelta: mb(after.heapUsed - before.heapUsed),
        rssBefore: mb(before.rss),
        rssAfter: mb(after.rss),
        rssDelta: mb(after.rss - before.rss),
        controlFakeOnlyHeapDelta: mb(controlHeapDelta),
        controlRetained,
        handlerL1HeapDeltaEstimate: mb(after.heapUsed - before.heapUsed - controlHeapDelta),
        gcForced: Boolean(gc),
        note: "the fake upstream retains every minted session + saved-drill row + recorded filter (replay fidelity); controlFakeOnlyHeapDelta measures that retention alone for the same user count, so handlerL1HeapDeltaEstimate ≈ the handler's own per-isolate state (auth L1 rows, rate-limit windows, generation counters)",
      },
      l1AuthCache: {
        firstUserRevisitedAuthCalls: firstAgainAuthCalls,
        firstUserRevisitedStatus: firstAgain.status,
        expectation:
          STRESS_USERS > 5_000
            ? "MEMORY_MAX_ENTRIES=5000 → first user's row evicted → 1 Auth call"
            : "under MEMORY_MAX_ENTRIES → first user's row still cached → 0 Auth calls",
      },
      memoryRateLimitWindows: {
        sentinelExhaustedBeforeFlood: sentinelStatuses[240],
        sentinelAfterFlood: sentinelAgain.status,
        contract: "the sentinel's 60 s window has not elapsed → still 429",
        windowsCreatedByFlood: 2 * STRESS_USERS,
        cap: "MEMORY_WINDOW_MAX=20000; when full and nothing expired, rateLimit.ts clears the whole map",
      },
    };
    const path = await writeJson("load_users_l1", summary);
    console.log(
      `[stress] load C: ${JSON.stringify({ ...summary, memoryBytes: undefined })} → ${path}`,
    );

    assertEquals(statuses, { "204": STRESS_USERS }, "every never-seen user's DELETE is 204");
    assertEquals(
      roundTrips,
      2 * STRESS_USERS,
      "each never-seen user costs exactly Auth + PostgREST",
    );
    assert(firstAgain.status === 204);
    if (STRESS_USERS > 5_000) {
      assertEquals(firstAgainAuthCalls, 1, "L1 auth cache is bounded (oldest rows evicted)");
    } else {
      assertEquals(firstAgainAuthCalls, 0, "L1 auth cache still holds the first user");
    }
    // Heap growth must stay bounded: well under 1 KB of HANDLER-side state per
    // user would be invisible next to the fake's own retention, so the bound
    // is deliberately generous and catches only unbounded growth.
    assert(
      after.heapUsed - before.heapUsed < 4_096 * STRESS_USERS + 64 * 1_048_576,
      `heap grew ${mb(after.heapUsed - before.heapUsed)} MB for ${STRESS_USERS} users`,
    );
    if (2 * STRESS_USERS + 2 < 20_000) {
      assertEquals(
        sentinelAgain.status,
        429,
        "sentinel still throttled: its window is untouched below MEMORY_WINDOW_MAX",
      );
    } else {
      // Pinned OBSERVED behaviour past the cap (see summary.memoryRateLimitWindows.cap):
      // the sentinel's exhausted window is wiped with everything else.
      assertEquals(
        sentinelAgain.status,
        204,
        "DEFECT PIN: 20k distinct rate-limit keys within one window clear every memory window, including an exhausted user's — the 241st+ request is served",
      );
    }
  },
});
