// stress — POST /v1/me/consent/withdraw — LOAD + ROUND TRIPS + L1 MEMORY.
//
// Campaign (Redis-less isolate — Upstash is faulted in the redis suite):
//   L1  seeded mixed load: STRESS_ITER requests over STRESS_LOAD_USERS users
//       (fresh IP per request, ≤ 25 consent calls per user so the 30/60s
//       route budget never fires), recording per-request latency, status and
//       upstream round trips. A hot-path request costing > 3 Supabase calls
//       (auth + PostgREST) is a finding.
//   L2  cold vs warm auth: the first request of a user verifies with GoTrue,
//       every later one must be served from the verified-session cache
//       (0 auth round trips) — this is what keeps the hot path at 3.
//   L3  L1 memory under STRESS_USERS distinct users: heap after N distinct
//       verified sessions, versus the 5 000-entry L1 cap in cache.ts.
//
// Defaults are suite-sized (STRESS_ITER=120, STRESS_USERS=600, ~2s). The
// campaign numbers in the report were produced with
//   STRESS_ITER=1000 STRESS_USERS=20000 STRESS_OUT_DIR=… \
//     deno test -A --no-check --config deno.json stress_consent_withdraw_load.test.ts
// Every iteration is replayable: iteration i uses caseSeed(STRESS_SEED, i).

import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  CONSENT_SCOPES,
  freshIp,
  histogram,
  loadStressHarness,
  observe,
  percentile,
  Prng,
  scopesOf,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  withdrawRequest,
  writeJson,
} from "./stress_consent_withdraw_harness.ts";

const LOAD_USERS = Number(Deno.env.get("STRESS_LOAD_USERS") ?? "0") ||
  Math.max(8, Math.ceil(STRESS_ITER / 20));
/** The route's own consent budget is 30 per 60s per user. */
const PER_USER_CAP = 25;
/** cache.ts MEMORY_MAX_ENTRIES */
const L1_MAX_ENTRIES = 5_000;
/** index.ts: auth + read + insert + read */
const HOT_PATH_BUDGET = 4;
const SUPABASE_ROUND_TRIP_BUDGET = 3;

interface Iteration {
  i: number;
  seed: number;
  user: number;
  scope: string;
  status: number;
  durationMs: number;
  auth: number;
  pgGet: number;
  pgPost: number;
  redis: number;
  supabase: number;
  withdrawn: boolean | null;
}

Deno.test({
  name:
    `load: ${STRESS_ITER} withdraws over ${LOAD_USERS} users — p50/p95 + Supabase round trips per request`,
  async fn() {
    const h = await loadStressHarness();
    const tokens: string[] = [];
    const userIds: string[] = [];
    for (let u = 0; u < LOAD_USERS; u++) {
      const prng = new Prng(caseSeed(STRESS_SEED, 1_000_000 + u));
      const id = prng.uuid();
      userIds.push(id);
      tokens.push(h.mintSession(id).accessToken);
    }
    const perUser = new Array(LOAD_USERS).fill(0);
    const iterations: Iteration[] = [];

    for (let i = 0; i < STRESS_ITER; i++) {
      const prng = new Prng(caseSeed(STRESS_SEED, i));
      // pick a user that still has route budget left this window
      let u = prng.int(0, LOAD_USERS - 1);
      for (
        let tries = 0;
        tries < LOAD_USERS && perUser[u] >= PER_USER_CAP;
        tries++
      ) {
        u = (u + 1) % LOAD_USERS;
      }
      assert(
        perUser[u] < PER_USER_CAP,
        "load sizing exceeded the per-user consent budget",
      );
      perUser[u] += 1;
      const scope = prng.pick(CONSENT_SCOPES);
      const before = h.calls.length;
      const observed = await observe(
        h.handler,
        withdrawRequest(tokens[u], {
          scope,
          source: prng.pick(["mobile_settings", "mobile_onboarding"]),
          device: `iPhone${prng.int(12, 18)},${prng.int(1, 4)} iOS ${
            prng.int(17, 26)
          }.0`,
        }, { ip: freshIp() }),
      );
      const during = h.calls.slice(before);
      const auth = during.filter((c) => c.upstream === "auth").length;
      const pgGet = during.filter((c) =>
        c.upstream === "postgrest" && c.method === "GET"
      ).length;
      const pgPost = during.filter((c) =>
        c.upstream === "postgrest" && c.method === "POST"
      ).length;
      const scopes = scopesOf(observed.body);
      iterations.push({
        i,
        seed: caseSeed(STRESS_SEED, i),
        user: u,
        scope,
        status: observed.status,
        durationMs: observed.durationMs,
        auth,
        pgGet,
        pgPost,
        redis: during.filter((c) => c.upstream === "redis").length,
        supabase: auth + pgGet + pgPost,
        withdrawn: scopes
          ? scopes.find((s) => s.scope === scope)?.active === false
          : null,
      });
    }

    const latencies = iterations.map((it) => it.durationMs).sort((a, b) =>
      a - b
    );
    const statuses = histogram(iterations.map((it) => it.status));
    const roundTrips = histogram(iterations.map((it) => it.supabase));
    const overBudget = iterations.filter((it) => it.supabase > HOT_PATH_BUDGET);
    const pgOverBudget = iterations.filter((it) =>
      it.pgGet + it.pgPost > SUPABASE_ROUND_TRIP_BUDGET
    );
    const report = {
      unit: "route-post-v1-me-consent-withdraw",
      lens: "failure-load/load",
      baseSeed: STRESS_SEED,
      iterations: iterations.length,
      users: LOAD_USERS,
      statuses,
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.at(-1) ?? NaN,
        mean: Math.round(
          (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 1000,
        ) / 1000,
      },
      supabaseRoundTripsPerRequest: roundTrips,
      postgrestCallsPerRequest: histogram(
        iterations.map((it) => it.pgGet + it.pgPost),
      ),
      authCallsPerRequest: histogram(iterations.map((it) => it.auth)),
      redisCallsPerRequest: histogram(iterations.map((it) => it.redis)),
      hotPathBudget: HOT_PATH_BUDGET,
      overBudget: overBudget.map((it) => ({
        seed: it.seed,
        supabase: it.supabase,
      })),
      postgrestOverBudget: pgOverBudget.map((it) => ({
        seed: it.seed,
        calls: it.pgGet + it.pgPost,
      })),
      rowsWritten: h.consentRecords.length,
      sample: iterations.slice(0, 50),
    };
    const path = await writeJson("load.json", report);
    console.log(
      `[stress-load] ${iterations.length} req over ${LOAD_USERS} users → p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms ` +
        `statuses=${JSON.stringify(statuses)} supabaseRT=${
          JSON.stringify(roundTrips)
        } (${path})`,
    );

    assertEquals(
      statuses,
      { "200": iterations.length },
      "every load request must answer 200",
    );
    assertEquals(
      overBudget,
      [],
      "a request exceeded the 4-call hot path (auth + 3 PostgREST)",
    );
    assertEquals(
      pgOverBudget,
      [],
      "a request made more than 3 PostgREST round trips",
    );
    assertEquals(
      h.consentRecords.length,
      iterations.length,
      "one ledger row per accepted withdraw",
    );
    assert(
      iterations.every((it) => it.withdrawn === true),
      "every 200 reports the scope withdrawn",
    );
    // Latency of an in-process request against in-memory fakes: a p95 above
    // 25ms means the handler itself (fold, hashing, logging) got expensive.
    assert(
      report.latencyMs.p95 < 25,
      `p95 ${report.latencyMs.p95}ms is above the 25ms in-process budget`,
    );
  },
});

Deno.test({
  name:
    "load: cold request verifies with GoTrue once, warm requests come from the L1 session cache",
  async fn() {
    const h = await loadStressHarness();
    const prng = new Prng(caseSeed(STRESS_SEED, 2_000_001));
    const userId = prng.uuid();
    const token = h.mintSession(userId).accessToken;
    const rows: Array<{ n: number; auth: number; pg: number; status: number }> =
      [];
    for (let n = 1; n <= 20; n++) {
      const before = h.calls.length;
      const observed = await observe(
        h.handler,
        withdrawRequest(token, { scope: prng.pick(CONSENT_SCOPES) }, {
          ip: freshIp(),
        }),
      );
      const during = h.calls.slice(before);
      rows.push({
        n,
        auth: during.filter((c) => c.upstream === "auth").length,
        pg: during.filter((c) => c.upstream === "postgrest").length,
        status: observed.status,
      });
    }
    await writeJson("load_auth_cache.json", {
      baseSeed: STRESS_SEED,
      userId,
      rows,
    });
    assertEquals(rows[0], { n: 1, auth: 1, pg: 3, status: 200 });
    for (const row of rows.slice(1)) {
      assertEquals(
        row.auth,
        0,
        `request ${row.n} re-verified with GoTrue (auth cache miss)`,
      );
      assertEquals(
        row.pg,
        3,
        `request ${row.n} made ${row.pg} PostgREST calls`,
      );
      assertEquals(row.status, 200);
    }
    console.log(
      `[stress-load] auth cache: cold=1 auth call, 19 warm requests=0 auth calls, 3 PostgREST each`,
    );
  },
});

Deno.test({
  name:
    `load: L1 memory under ${STRESS_USERS} distinct users (cap ${L1_MAX_ENTRIES})`,
  async fn() {
    const h = await loadStressHarness();
    const sample: Array<{ users: number; heapUsedMb: number; rssMb: number }> =
      [];
    // With --v8-flags=--expose-gc the samples are RETAINED heap (what a leak
    // would show); without it they include uncollected garbage and are only
    // an upper bound.
    const gc = (globalThis as { gc?: () => void }).gc;
    const snapshot = (users: number) => {
      gc?.();
      const m = Deno.memoryUsage();
      sample.push({
        users,
        heapUsedMb: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
        rssMb: Math.round((m.rss / 1_048_576) * 100) / 100,
      });
    };
    snapshot(0);
    const baselineHeap = sample[0].heapUsedMb;
    let statuses: Record<string, number> = {};
    const stat: number[] = [];
    for (let u = 0; u < STRESS_USERS; u++) {
      const prng = new Prng(caseSeed(STRESS_SEED, 3_000_000 + u));
      const token = h.mintSession(prng.uuid()).accessToken;
      const observed = await observe(
        h.handler,
        withdrawRequest(token, { scope: prng.pick(CONSENT_SCOPES) }, {
          ip: freshIp(),
        }),
      );
      stat.push(observed.status);
      // Drop the per-user fake state so the measurement isolates the edge
      // function's own caches from the harness's row store.
      h.consentRecords.length = 0;
      h.sessions.delete(token);
      h.users.clear();
      h.calls.length = 0;
      if ((u + 1) % Math.max(1, Math.floor(STRESS_USERS / 10)) === 0) {
        snapshot(u + 1);
      }
    }
    statuses = histogram(stat);
    snapshot(STRESS_USERS);
    const peak = Math.max(...sample.map((s) => s.heapUsedMb));
    const report = {
      unit: "route-post-v1-me-consent-withdraw",
      lens: "failure-load/l1-memory",
      baseSeed: STRESS_SEED,
      distinctUsers: STRESS_USERS,
      l1MaxEntries: L1_MAX_ENTRIES,
      statuses,
      baselineHeapMb: baselineHeap,
      peakHeapMb: peak,
      growthMb: Math.round((peak - baselineHeap) * 100) / 100,
      perUserBytes: Math.round(
        ((peak - baselineHeap) * 1_048_576) / STRESS_USERS,
      ),
      samples: sample,
      gcExposed: Boolean(gc),
      note:
        "cache.ts bounds L1 at MEMORY_MAX_ENTRIES=5000 (oldest-inserted evicted); rateLimit.ts bounds its local windows at 20000. Heap is measured for the whole isolate (fakes included), so growthMb is an upper bound on the caches' cost.",
    };
    const path = await writeJson("load_l1_memory.json", report);
    console.log(
      `[stress-load] ${STRESS_USERS} distinct users → heap ${baselineHeap}MB → peak ${peak}MB (+${report.growthMb}MB, ~${report.perUserBytes}B/user) (${path})`,
    );
    assertEquals(
      statuses,
      { "200": STRESS_USERS },
      "every distinct-user withdraw answered 200",
    );
    // A leak would keep RETAINED heap growing linearly in users. Only assert
    // that when GC can be forced; without --expose-gc the numbers include
    // uncollected garbage and are reported, not gated.
    if (gc) {
      assert(
        report.growthMb < 60,
        `retained heap grew ${report.growthMb}MB over ${STRESS_USERS} users — bounded caches should not`,
      );
    }
  },
});
