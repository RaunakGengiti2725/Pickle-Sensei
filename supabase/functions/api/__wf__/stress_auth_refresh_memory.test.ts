// STRESS — POST /v1/auth/refresh — per-isolate memory under many distinct users.
//
// This file MUST stay alone in its isolate (Deno gives every test file its
// own), because the campaign models the real module's private rate-limit
// window map (`rateLimit.ts` — MEMORY_WINDOW_MAX = 20_000 keys) from the
// number of refreshes performed here.
//
// The refresh route never touches the auth cache (`cache.ts` L1) — it has
// no bearer to cache — so the only per-isolate state a flood of distinct
// users can grow is the limiter's window map: two keys per distinct IP
// (`rl:ip:*`, `rl:auth_refresh:*`). Stress: STRESS_USERS distinct users
// from distinct IPs (default 2500; the lens asks for 20 000 →
// `STRESS_USERS=20000`), heap sampled every 1000, and a probe of what the
// bounded map does to a client whose budget was ALREADY exhausted when the
// bound is reached.
//
// Evidence: artifacts/stress-auth-refresh/latest/memory_l1_users.json.

import { assert, assertEquals } from "@std/assert";
import {
  awaitWindowHeadroom,
  heapNow,
  histogram,
  ipFor,
  latencySummary,
  loadStressHarness,
  muteConsole,
  refresh,
  refreshRequest,
  STRESS_USERS,
  writeReport,
} from "./stress_auth_refresh_harness.ts";

/** `rateLimit.ts` — the in-memory window map's key bound. */
const MEMORY_WINDOW_MAX = 20_000;
const REFRESH_LIMIT = 30;

Deno.test(
  `stress refresh memory: ${STRESS_USERS} distinct users from distinct IPs — heap, latency drift, and what the 20k-key limiter bound does to an exhausted client`,
  async () => {
    const h = await loadStressHarness();
    const gc = (globalThis as { gc?: () => void }).gc;
    const mute = muteConsole();
    const samples: Array<{
      users: number;
      heapUsedMb: number;
      rssMb: number;
      p50Ms: number;
      p95Ms: number;
    }> = [];
    let keysModelled = 0;
    try {
      // A budget window of 60s: the whole campaign has to sit inside one bucket
      // (otherwise a rolled-over bucket would look exactly like a wiped map).
      await awaitWindowHeadroom(60, Math.min(45_000, 3_000 + STRESS_USERS));
      const bucketAtStart = Math.floor(Date.now() / 60_000);

      // 1. Exhaust one client's refresh budget (30 → 429). Two keys.
      const exhaustedIp = ipFor(1);
      for (let i = 0; i < REFRESH_LIMIT; i += 1)
        await refresh(h, refreshRequest({ ip: exhaustedIp, token: `rt-exhaust-${i}` }));
      const limitedBefore = await refresh(
        h,
        refreshRequest({ ip: exhaustedIp, token: "rt-exhaust-probe-0" }),
      );
      keysModelled += 2;
      assertEquals(limitedBefore.status, 429, "precondition: budget exhausted");

      // 2. Flood: distinct users, distinct IPs → two NEW keys per user.
      gc?.();
      const baseline = heapNow();
      let window: number[] = [];
      const statuses: number[] = [];
      for (let u = 0; u < STRESS_USERS; u += 1) {
        const o = await refresh(
          h,
          refreshRequest({ ip: ipFor(100_000 + u), token: `rt-user-${u}` }),
        );
        statuses.push(o.status);
        window.push(o.latencyMs);
        keysModelled += 2;
        if ((u + 1) % 1_000 === 0 || u + 1 === STRESS_USERS) {
          h.calls = [];
          gc?.();
          const lat = latencySummary(window);
          samples.push({ users: u + 1, ...heapNow(), p50Ms: lat.p50, p95Ms: lat.p95 });
          window = [];
        }
      }

      // 3. Probe the exhausted client again.
      const limitedAfter = await refresh(
        h,
        refreshRequest({ ip: exhaustedIp, token: "rt-exhaust-probe-1" }),
      );
      const bucketAtEnd = Math.floor(Date.now() / 60_000);
      // The map is cleared when a NEW key arrives while it already holds 20k.
      const wipeExpected = keysModelled > MEMORY_WINDOW_MAX;

      // Sample once more after the isolate has idled (full runs only): the
      // difference to the last in-flood sample is transient per-request state
      // the runtime still had to release, the rest is what the flood left behind.
      let settledHeap: { heapUsedMb: number; rssMb: number } | null = null;
      if (STRESS_USERS >= 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 6_500));
        h.calls = [];
        gc?.();
        settledHeap = heapNow();
      }
      const report = {
        campaign: "memory_l1_users",
        mode: "memory-limiter",
        users: STRESS_USERS,
        gcExposed: Boolean(gc),
        statuses: histogram(statuses),
        baselineHeap: baseline,
        samples,
        settledHeapAfterAuthTimeouts: settledHeap,
        limiterKeysModelled: keysModelled,
        memoryWindowMax: MEMORY_WINDOW_MAX,
        sameLimiterBucket: bucketAtStart === bucketAtEnd,
        exhaustedClient: {
          probeBeforeFlood: limitedBefore.status,
          probeAfterFlood: limitedAfter.status,
          wipeExpectedByModel: wipeExpected,
          verdict:
            limitedAfter.status === 429
              ? "budget survived the flood"
              : "FINDING: the 20k-key bound wiped every live window — an exhausted client was re-admitted mid-window",
        },
      };
      const path = await writeReport("memory_l1_users", report);
      console.log(
        `[stress] memory: ${STRESS_USERS} users, heap ${baseline.heapUsedMb}MB → ${samples.at(-1)?.heapUsedMb}MB, ` +
          `p95 first/last 1k ${samples[0]?.p95Ms}/${samples.at(-1)?.p95Ms}ms, exhausted client after flood → ${limitedAfter.status} → ${path}`,
      );

      assertEquals(bucketAtStart, bucketAtEnd, "campaign crossed a 60s limiter bucket — re-run");
      assertEquals(histogram(statuses), { "200": STRESS_USERS }, "every distinct user rotates");
      // Latency must not degrade with map size (Map is O(1); the 20k sweep is O(n) once).
      const firstP95 = samples[0].p95Ms;
      const lastP95 = samples[samples.length - 1].p95Ms;
      assert(
        lastP95 < Math.max(5, firstP95 * 5),
        `p95 drifted ${firstP95}ms → ${lastP95}ms across the flood`,
      );
      // Memory: the map is bounded at 20k keys of (short string + 2 numbers) — tens of MB would be a leak.
      const growth = samples[samples.length - 1].heapUsedMb - baseline.heapUsedMb;
      assert(growth < 60, `heap grew ${growth.toFixed(1)}MB for ${STRESS_USERS} users`);
      // Characterise the bound precisely (what the code does, so a change here is visible):
      //   below the bound the exhausted client stays 429; at/over it the map is
      //   cleared and the client is re-admitted (see the FINDING verdict above).
      assertEquals(
        limitedAfter.status,
        wipeExpected ? 200 : 429,
        `limiter bound model (keys=${keysModelled})`,
      );
    } finally {
      mute.restore();
    }
  },
);
