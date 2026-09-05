// STRESS — POST /v1/auth/refresh — load (memory limiter, no Upstash).
//
// Real handler in-process, fake GoTrue answering instantly, so the latency
// measured is the edge function's OWN cost per refresh (parsing, limiter,
// auth call plumbing, response shaping) and the round-trip count is exact.
//
//   STRESS_LOAD_N   requests per campaign (default 300; full run 1000+)
//   STRESS_SEED     seed for the mixed-outcome campaign
//
// Evidence: artifacts/stress-auth-refresh/latest/load_*.json.

import { assert, assertEquals } from "@std/assert";
import {
  GOTRUE_REFUSAL,
  heapNow,
  histogram,
  ipFor,
  jsonResponse,
  latencySummary,
  loadStressHarness,
  muteConsole,
  type Observed,
  Prng,
  refresh,
  refreshRequest,
  socketFailure,
  STRESS_LOAD_N,
  STRESS_SEED,
  validSession,
  writeReport,
} from "./stress_auth_refresh_harness.ts";

/** ≤ 25 refreshes per IP per campaign keeps every request under the 30/min budget. */
const PER_IP = 25;

interface LoadRow {
  i: number;
  status: number;
  latencyMs: number;
  gotrue: number;
  upstash: number;
  postgrest: number;
  revenuecat: number;
}

function row(i: number, o: Observed): LoadRow {
  return {
    i,
    status: o.status,
    latencyMs: o.latencyMs,
    gotrue: o.gotrueAttempts,
    upstash: o.upstashCalls,
    postgrest: o.postgrestCalls,
    revenuecat: o.revenuecatCalls,
  };
}

function summarizeLoad(rows: LoadRow[], wallMs: number) {
  return {
    requests: rows.length,
    wallMs: Math.round(wallMs),
    throughputRps: Math.round((rows.length / wallMs) * 1000 * 10) / 10,
    statuses: histogram(rows.map((r) => r.status)),
    latencyMs: latencySummary(rows.map((r) => r.latencyMs)),
    supabaseRoundTripsPerRequest: histogram(rows.map((r) => r.gotrue)),
    otherUpstreamCallsPerRequest: histogram(
      rows.map((r) => r.upstash + r.postgrest + r.revenuecat),
    ),
  };
}

Deno.test(
  `stress refresh load: ${STRESS_LOAD_N} sequential refreshes — exactly ONE Supabase round trip each, p50/p95 recorded`,
  async () => {
    const h = await loadStressHarness();
    const mute = muteConsole();
    const rows: LoadRow[] = [];
    const started = performance.now();
    try {
      for (let i = 0; i < STRESS_LOAD_N; i += 1) {
        const ip = ipFor(1_000 + Math.floor(i / PER_IP));
        rows.push(row(i, await refresh(h, refreshRequest({ ip, token: `rt-seq-${i}` }))));
      }
    } finally {
      mute.restore();
    }
    const summary = summarizeLoad(rows, performance.now() - started);
    const totalUpstream = h.calls.length;
    const path = await writeReport("load_sequential", {
      campaign: "load_sequential",
      mode: "memory-limiter",
      summary,
      totalUpstreamCalls: totalUpstream,
      rows,
    });
    console.log(
      `[stress] sequential: n=${summary.requests} p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms max=${summary.latencyMs.max}ms → ${path}`,
    );
    assertEquals(summary.statuses, { "200": STRESS_LOAD_N });
    assertEquals(
      summary.supabaseRoundTripsPerRequest,
      { "1": STRESS_LOAD_N },
      "hot path must be one GoTrue call per refresh",
    );
    assertEquals(
      summary.otherUpstreamCallsPerRequest,
      { "0": STRESS_LOAD_N },
      "no PostgREST / RevenueCat / Upstash traffic without Redis configured",
    );
    assertEquals(totalUpstream, STRESS_LOAD_N, "total upstream fetches == requests");
    assert(
      summary.latencyMs.p95 < 50,
      `p95 ${summary.latencyMs.p95}ms — the function's own cost per refresh should be well under 50ms in-process`,
    );
  },
);

Deno.test(
  `stress refresh load: ${STRESS_LOAD_N} refreshes in bursts of 50 — every request still one round trip, no cross-talk`,
  async () => {
    const h = await loadStressHarness();
    h.reset();
    const mute = muteConsole();
    const rows: LoadRow[] = [];
    const started = performance.now();
    try {
      for (let offset = 0; offset < STRESS_LOAD_N; offset += 50) {
        const batch = Array.from(
          { length: Math.min(50, STRESS_LOAD_N - offset) },
          (_, j) => offset + j,
        );
        const observed = await Promise.all(
          batch.map((i) =>
            refresh(
              h,
              refreshRequest({ ip: ipFor(5_000 + Math.floor(i / PER_IP)), token: `rt-burst-${i}` }),
            ),
          ),
        );
        observed.forEach((o, j) => rows.push(row(batch[j], o)));
      }
    } finally {
      mute.restore();
    }
    const summary = summarizeLoad(rows, performance.now() - started);
    const gotrueTotal = h.callsTo("gotrue").length;
    const path = await writeReport("load_burst", {
      campaign: "load_burst",
      mode: "memory-limiter",
      summary,
      gotrueTotal,
      rows,
    });
    console.log(
      `[stress] burst: n=${summary.requests} p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms → ${path}`,
    );
    assertEquals(summary.statuses, { "200": STRESS_LOAD_N });
    assertEquals(summary.supabaseRoundTripsPerRequest, { "1": STRESS_LOAD_N });
    assertEquals(gotrueTotal, STRESS_LOAD_N);
  },
);

Deno.test(
  "stress refresh load: concurrent responses are never crossed — each refresh gets the session GoTrue minted for ITS token",
  async () => {
    const h = await loadStressHarness();
    h.reset();
    const mute = muteConsole();
    try {
      const n = Math.min(STRESS_LOAD_N, 200);
      // GoTrue echoes the presented token inside the access token so the
      // response can be attributed without shared state.
      h.gotrue = (ctx) =>
        jsonResponse(
          200,
          validSession("33333333-3333-4333-8333-333333333333", {
            access_token: `at-for-${ctx.body.refresh_token}`,
            expires_at: 1_900_000_000,
          }),
        );
      const observed = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          refresh(
            h,
            refreshRequest({ ip: ipFor(7_000 + Math.floor(i / PER_IP)), token: `rt-cross-${i}` }),
          ),
        ),
      );
      const crossed = observed
        .map((o, i) => ({
          i,
          accessToken: (o.body.session as Record<string, unknown> | undefined)?.accessToken,
        }))
        .filter((x) => x.accessToken !== `at-for-rt-cross-${x.i}`);
      await writeReport("load_no_crosstalk", {
        n,
        crossed,
        statuses: histogram(observed.map((o) => o.status)),
      });
      assertEquals(histogram(observed.map((o) => o.status)), { "200": n });
      assertEquals(crossed, []);
    } finally {
      mute.restore();
      h.gotrue = null;
    }
  },
);

Deno.test(
  `stress refresh load: seeded mixed outcomes (${STRESS_LOAD_N}) — refusals/outages/flaky sockets never add Supabase round trips beyond the retry contract`,
  async () => {
    const h = await loadStressHarness();
    h.reset();
    const mute = muteConsole();
    const rng = new Prng(STRESS_SEED ^ 0x10ad);
    const rows: Array<LoadRow & { kind: string; seed: number }> = [];
    const started = performance.now();
    try {
      for (let i = 0; i < STRESS_LOAD_N; i += 1) {
        const seed = rng.child(i);
        const r = new Prng(seed);
        const roll = r.next();
        const kind =
          roll < 0.7
            ? "ok"
            : roll < 0.8
              ? "refusal"
              : roll < 0.9
                ? "service"
                : "flaky_socket_then_ok";
        const token = `rt-mixed-${i}`;
        h.gotrue =
          kind === "ok"
            ? null
            : kind === "refusal"
              ? () => GOTRUE_REFUSAL()
              : kind === "service"
                ? () =>
                    jsonResponse(
                      503,
                      { msg: "maintenance" },
                      { "Retry-After": String(r.int(1, 30)) },
                    )
                : (ctx) =>
                    ctx.attempt === 0
                      ? socketFailure()(ctx)
                      : jsonResponse(
                          200,
                          validSession(`44444444-4444-4444-8444-${String(i).padStart(12, "0")}`),
                        );
        const o = await refresh(
          h,
          refreshRequest({ ip: ipFor(9_000 + Math.floor(i / PER_IP)), token }),
        );
        rows.push({ ...row(i, o), kind, seed });
        const want =
          kind === "ok" || kind === "flaky_socket_then_ok" ? 200 : kind === "refusal" ? 401 : 503;
        if (o.status !== want || o.gotrueAttempts !== (kind === "flaky_socket_then_ok" ? 2 : 1)) {
          throw new Error(
            `seed ${seed} (${kind}): status ${o.status} attempts ${o.gotrueAttempts} — replay by re-running with STRESS_SEED=${STRESS_SEED} STRESS_LOAD_N=${STRESS_LOAD_N}`,
          );
        }
      }
    } finally {
      mute.restore();
      h.gotrue = null;
    }
    const summary = summarizeLoad(rows, performance.now() - started);
    const path = await writeReport("load_mixed_seeded", {
      campaign: "load_mixed_seeded",
      mode: "memory-limiter",
      masterSeed: STRESS_SEED ^ 0x10ad,
      kinds: histogram(rows.map((r) => r.kind)),
      summary,
      byKind: Object.fromEntries(
        ["ok", "refusal", "service", "flaky_socket_then_ok"].map((k) => [
          k,
          latencySummary(rows.filter((r) => r.kind === k).map((r) => r.latencyMs)),
        ]),
      ),
      rows,
    });
    console.log(
      `[stress] mixed: ${JSON.stringify(summary.statuses)} round-trips ${JSON.stringify(summary.supabaseRoundTripsPerRequest)} → ${path}`,
    );
    const flaky = rows.filter((r) => r.kind === "flaky_socket_then_ok").length;
    assertEquals(
      summary.supabaseRoundTripsPerRequest,
      flaky ? { "1": STRESS_LOAD_N - flaky, "2": flaky } : { "1": STRESS_LOAD_N },
    );
    assertEquals(summary.otherUpstreamCallsPerRequest, { "0": STRESS_LOAD_N });
  },
);

Deno.test(
  "stress refresh load: heap does not grow with request count once warm (1k refreshes, sampled every 100)",
  async () => {
    const h = await loadStressHarness();
    h.reset();
    const mute = muteConsole();
    const gc = (globalThis as { gc?: () => void }).gc;
    const samples: Array<{ requests: number; heapUsedMb: number; rssMb: number }> = [];
    try {
      const n = 1_000;
      for (let i = 0; i < n; i += 1) {
        await refresh(
          h,
          refreshRequest({ ip: ipFor(12_000 + Math.floor(i / PER_IP)), token: `rt-heap-${i}` }),
        );
        if ((i + 1) % 100 === 0) {
          h.calls = [];
          gc?.();
          samples.push({ requests: i + 1, ...heapNow() });
        }
      }
    } finally {
      mute.restore();
    }
    await writeReport("load_heap_samples", { gcExposed: Boolean(gc), samples });
    const first = samples[0].heapUsedMb;
    const last = samples[samples.length - 1].heapUsedMb;
    console.log(
      `[stress] heap: ${first}MB @100 → ${last}MB @1000 (gc ${gc ? "forced" : "not exposed"})`,
    );
    // Without a forced GC the heap wanders with V8's schedule; a run-away leak
    // would still show as monotone growth by tens of MB across 900 requests.
    assert(last - first < 40, `heapUsed grew ${(last - first).toFixed(1)}MB over 900 refreshes`);
  },
);
