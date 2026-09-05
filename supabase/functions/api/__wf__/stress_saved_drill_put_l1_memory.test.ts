// stress — `PUT /v1/me/saved-drills/:slug` per-isolate L1 memory under
// STRESS_USERS distinct users with NO Upstash configured (the deploy shape
// AGENTS.md describes when UPSTASH_REDIS_REST_URL is unset: auth cache and
// rate-limit windows live only in the isolate's Maps).
//
// Every user makes one cold request (Auth verify + upsert + read-back).
// Recorded: heapUsed/rss sampled every 1 000 users, p50/p95 latency of the
// flood, and two canaries that make the bounded Maps observable from outside:
//
//   sentinel — verified before the flood; if its next request re-verifies
//              with Auth, the auth L1 (MEMORY_MAX_ENTRIES = 5 000) evicted
//              it, i.e. the cache is bounded and eviction is safe (re-verify,
//              not 401);
//   canary   — spent its whole 240/min budget before the flood (241st = 429);
//              if a request AFTER the flood is 200, the memory rate limiter
//              wiped every window (MEMORY_WINDOW_MAX = 20 000 keys reached:
//              2 keys — rl:ip + rl:user — per distinct user).
//
// Default STRESS_USERS=1500 keeps the suite fast; the campaign runs 20 000.
// Run with --v8-flags=--expose-gc for GC'd heap samples (recorded either way).
//
//   STRESS_USERS=20000 deno test -A --no-check --config deno.json \
//     --v8-flags=--expose-gc stress_saved_drill_put_l1_memory.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  drive,
  envInt,
  FakeUpstreams,
  histogram,
  latencySummary,
  loadStressHarness,
  Prng,
  putSavedDrill,
  STRESS_SEED,
  writeArtifact,
} from "./stress_saved_drill_put_harness.ts";

const USERS = envInt("STRESS_USERS", 1_500);
const h = await loadStressHarness({ redis: false });

const gc = (globalThis as { gc?: () => void }).gc;
function heap(): { heapUsedMb: number; rssMb: number; gc: boolean } {
  gc?.();
  const m = Deno.memoryUsage();
  return {
    heapUsedMb: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
    rssMb: Math.round((m.rss / 1_048_576) * 100) / 100,
    gc: gc !== undefined,
  };
}

Deno.test({
  name:
    `stress/saved-drill PUT L1 memory: ${USERS} distinct users, no Upstash — heap, eviction, rate-limit windows`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = h.fake;
    fake.reset(STRESS_SEED);
    const prng = new Prng(STRESS_SEED ^ 0x5eed);
    assertEquals(h.redisConfigured, false);

    // Canary: exhaust the general per-user budget (240/60 s) on its own IP.
    const canary = fake.mintSession(prng.uuid());
    const canaryIp = prng.ip();
    const canaryStatuses: Array<number | "pending"> = [];
    for (let i = 0; i < 241; i++) {
      canaryStatuses.push(
        (await drive(
          h,
          putSavedDrill(prng.slug(), {
            token: canary.accessToken,
            ip: canaryIp,
          }),
        )).status,
      );
    }
    const canaryBefore = histogram(canaryStatuses);
    const canaryRetryAfter = (await drive(
      h,
      putSavedDrill("dink-drill", {
        token: canary.accessToken,
        ip: canaryIp,
      }),
    ))
      .headers["retry-after"] ?? null;

    // Sentinel: verified once (Auth consulted), so it sits in the auth L1.
    const sentinel = fake.mintSession(prng.uuid());
    const sentinelIp = prng.ip();
    fake.calls.length = 0;
    const sentinelFirst = await drive(
      h,
      putSavedDrill("third-shot-drop", {
        token: sentinel.accessToken,
        ip: sentinelIp,
      }),
    );
    const sentinelFirstTally = FakeUpstreams.tally(fake.calls);

    // Pre-mint every user so the flood measures the isolate, not the fake.
    const flood = Array.from({ length: USERS }, () => ({
      token: fake.mintSession(prng.uuid()).accessToken,
      ip: prng.ip(),
      slug: prng.slug(),
    }));
    fake.calls.length = 0;
    const before = heap();
    const samples: Array<{ users: number } & ReturnType<typeof heap>> = [{
      users: 0,
      ...before,
    }];
    const latencies: number[] = [];
    const statuses: Array<number | "pending"> = [];
    let gotrueCalls = 0;
    let postgrestCalls = 0;
    let maxSupabasePerRequest = 0;
    const started = performance.now();
    for (let i = 0; i < flood.length; i++) {
      const u = flood[i];
      const answer = await drive(
        h,
        putSavedDrill(u.slug, { token: u.token, ip: u.ip }),
      );
      latencies.push(answer.ms);
      statuses.push(answer.status);
      const tally = FakeUpstreams.tally(answer.calls);
      gotrueCalls += tally.gotrue;
      postgrestCalls += tally.postgrest;
      maxSupabasePerRequest = Math.max(maxSupabasePerRequest, tally.supabase);
      fake.calls.length = 0;
      if ((i + 1) % 1_000 === 0) samples.push({ users: i + 1, ...heap() });
    }
    const floodMs = Math.round(performance.now() - started);
    const after = heap();
    if (samples[samples.length - 1].users !== USERS) {
      samples.push({ users: USERS, ...after });
    }

    // Sentinel again: an Auth round trip means the L1 evicted it (bounded).
    fake.calls.length = 0;
    const sentinelAgain = await drive(
      h,
      putSavedDrill("third-shot-drop", {
        token: sentinel.accessToken,
        ip: sentinelIp,
      }),
    );
    const sentinelAgainTally = FakeUpstreams.tally(fake.calls);
    const sentinelEvicted = sentinelAgainTally.gotrue > 0;

    // Canary again: a 200 means every rate-limit window was wiped.
    const canaryAfter = await drive(
      h,
      putSavedDrill("dink-drill", { token: canary.accessToken, ip: canaryIp }),
    );
    const windowsWiped = canaryAfter.status === 200;

    const bytesPerUser = Math.round(
      ((after.heapUsedMb - before.heapUsedMb) * 1_048_576) / USERS,
    );
    const report = {
      users: USERS,
      campaignSeed: STRESS_SEED,
      redisConfigured: h.redisConfigured,
      gcExposed: gc !== undefined,
      heap: {
        before,
        after,
        deltaMb: Math.round((after.heapUsedMb - before.heapUsedMb) * 100) / 100,
        bytesPerUser,
        samples,
      },
      heapCaveat:
        "delta includes the fake's own per-user growth (one saved_drills row + counters); fake sessions were pre-minted before `before`",
      flood: {
        wallMs: floodMs,
        statuses: histogram(statuses),
        latencyMs: latencySummary(latencies),
        gotrueCalls,
        postgrestCalls,
        maxSupabaseRoundTripsPerRequest: maxSupabasePerRequest,
      },
      sentinel: {
        firstStatus: sentinelFirst.status,
        firstGotrueCalls: sentinelFirstTally.gotrue,
        afterFloodStatus: sentinelAgain.status,
        afterFloodGotrueCalls: sentinelAgainTally.gotrue,
        evictedFromL1: sentinelEvicted,
        l1Cap: 5_000,
      },
      canary: {
        budget: { limit: 240, windowSeconds: 60 },
        statusesBeforeFlood: canaryBefore,
        retryAfterOn429: canaryRetryAfter,
        afterFloodStatus: canaryAfter.status,
        windowsWipedByFlood: windowsWiped,
        windowCap: 20_000,
        keysPerDistinctUser: 2,
      },
      classification: {
        l1AuthCacheBounded: sentinelEvicted
          ? "HELD: sentinel re-verified with Auth after the flood (evicted, not 401)"
          : `not observable at ${USERS} users (< 5 000 cap) — sentinel served from L1`,
        rateLimitWindows: windowsWiped
          ? "DEGRADED: canary's exhausted 240/min budget was reset by the flood (memory limiter clears all windows when full)"
          : "HELD: canary still 429 after the flood",
      },
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${USERS} deno test -A --no-check --config deno.json --v8-flags=--expose-gc stress_saved_drill_put_l1_memory.test.ts`,
    };
    const path = await writeArtifact(`l1_memory_${USERS}_users`, report);
    console.log(
      `[stress] l1-memory: users=${USERS} heap ${before.heapUsedMb}→${after.heapUsedMb} MB (${bytesPerUser} B/user, gc=${
        gc !== undefined
      }) ` +
        `p50=${report.flood.latencyMs.p50}ms p95=${report.flood.latencyMs.p95}ms sentinelEvicted=${sentinelEvicted} windowsWiped=${windowsWiped} → ${path}`,
    );

    // Invariants a correct route must hold at any scale.
    assertEquals(
      report.flood.statuses,
      { "200": USERS },
      "every distinct user's cold save must succeed",
    );
    assertEquals(
      gotrueCalls,
      USERS,
      "exactly one Auth verify per distinct user",
    );
    assertEquals(postgrestCalls, USERS * 2, "upsert + read-back per save");
    assert(maxSupabasePerRequest <= 3);
    assertEquals(
      canaryBefore,
      { "200": 240, "429": 1 },
      "241st request in the window is 429",
    );
    assert(canaryRetryAfter !== null, "429 carries Retry-After");
    assertEquals(sentinelFirst.status, 200);
    assertEquals(sentinelFirstTally.gotrue, 1);
    assertEquals(
      sentinelAgain.status,
      200,
      "eviction must re-verify, never refuse",
    );
    if (USERS >= 5_001) {
      assert(sentinelEvicted, "auth L1 must stay bounded at 5 000 entries");
    }
    // The rate-limit wipe past 20 000 keys is by design in rateLimit.ts
    // (memoryIncr clears the Map when full); recorded, not asserted, so the
    // campaign report carries it as a finding rather than the suite failing.
    if (USERS * 2 < 20_000) {
      assertEquals(
        canaryAfter.status,
        429,
        "budget must survive a flood below the window cap",
      );
    }
    assertEquals(fake.counters["revenuecat"] ?? 0, 0);
  },
});
