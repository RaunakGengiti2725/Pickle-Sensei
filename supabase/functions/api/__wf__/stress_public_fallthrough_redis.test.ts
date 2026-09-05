// stress · route-get-healthz-privacy-terms-unknown-paths-methods-ro · lens
// CONCURRENCY — Upstash (Redis-backed) rate-limit path.
//
// Same scenarios as stress_public_fallthrough_memory.test.ts, but the
// harness is loaded with UPSTASH_* configured so rateLimit.ts / cache.ts
// pipeline every INCR/GET/SET through the fake Redis in sessionHarness.ts.
// A seeded transport shim sits in front of the fake: every /pipeline call
// waits 0..STRESS_LATENCY_MS (real interleavings between peek, charge and
// response) and, in a seeded fraction of iterations, a seeded fraction of
// pipeline calls answers 503 (Upstash outage → fail-open memory fallback).
// Under an outage the exact-count invariants become bounds (see
// checkPublicBudget `lossy`); every other invariant is unchanged.
//
// Campaign: STRESS_ITER=100 deno test -A --no-check --config deno.json stress_public_fallthrough_redis.test.ts
// Replay:   STRESS_REPLAY_SEED=<seed> … --filter "<scenario>"
// Report:   artifacts/stress-public-fallthrough/redis/stress_public_fallthrough_redis.json

import { loadSessionHarness } from "./sessionHarness.ts";
import {
  assertHeld,
  newReport,
  Prng,
  sleep,
  STRESS_LATENCY_MS,
  writeReport,
} from "./stress_public_fallthrough_lib.ts";
import {
  S1,
  s1,
  S2,
  s2,
  S3,
  s3,
  S3B,
  s3b,
  S4,
  s4,
  S5,
  s5,
  S6,
  s6,
  type ScenarioContext,
  smoke,
} from "./stress_public_fallthrough_scenarios.ts";

const FILE = "stress_public_fallthrough_redis.test.ts";
const report = newReport("redis", FILE, "redis");

// ── seeded transport shim over the fake Upstash ──────────────────────────────

const transport = {
  rng: new Prng(1),
  maxLatencyMs: STRESS_LATENCY_MS,
  outageProb: 0,
  redisCalls: 0,
  redisOutages: 0,
};

let shimInstalled = false;
function installShim(): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const inner = globalThis.fetch;
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.endsWith("/pipeline")) {
      transport.redisCalls += 1;
      if (transport.maxLatencyMs > 0) {
        await sleep(transport.rng.int(0, transport.maxLatencyMs));
      }
      if (
        transport.outageProb > 0 && transport.rng.chance(transport.outageProb)
      ) {
        transport.redisOutages += 1;
        return new Response(
          JSON.stringify({ error: "stress: simulated Upstash outage" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }
    return await inner(input, init);
  };
}

function onIteration(seed: number): Record<string, unknown> {
  transport.rng = new Prng((seed ^ 0x5eed_1234) >>> 0);
  transport.redisCalls = 0;
  transport.redisOutages = 0;
  // 70 % of iterations: healthy Upstash with latency only; 30 %: 2–25 % of
  // pipeline calls fail (fail-open path exercised under load).
  transport.outageProb = transport.rng.chance(0.7)
    ? 0
    : transport.rng.int(2, 25) / 100;
  return {
    redisLatencyMs: transport.maxLatencyMs,
    redisOutageProb: transport.outageProb,
  };
}

function iterationStats(): { redisCalls: number; redisOutages: number } {
  return {
    redisCalls: transport.redisCalls,
    redisOutages: transport.redisOutages,
  };
}

async function ctx(): Promise<ScenarioContext> {
  const h = await loadSessionHarness({ redis: true });
  installShim();
  return { h, report, file: FILE, onIteration, iterationStats };
}

Deno.test("stress public/fallthrough (redis): harness smoke", async () => {
  const c = await ctx();
  onIteration(0);
  transport.outageProb = 0;
  await smoke(c.h);
  if (iterationStats().redisCalls === 0) {
    throw new Error(
      "redis mode not active: no /pipeline traffic observed during smoke",
    );
  }
});

Deno.test(S1, async () => {
  await s1(await ctx(), 11);
  await writeReport(report);
  assertHeld(report, S1);
});

Deno.test(S2, async () => {
  await s2(await ctx(), 12);
  await writeReport(report);
  assertHeld(report, S2);
});

Deno.test(S3, async () => {
  await s3(await ctx(), 13);
  await writeReport(report);
  assertHeld(report, S3);
});

Deno.test(S3B, async () => {
  await s3b(await ctx(), 14);
  await writeReport(report);
  assertHeld(report, S3B);
});

Deno.test(S4, async () => {
  await s4(await ctx(), 15);
  await writeReport(report);
  assertHeld(report, S4);
});

Deno.test(S5, async () => {
  await s5(await ctx(), 16);
  await writeReport(report);
  assertHeld(report, S5);
});

Deno.test(S6, async () => {
  await s6(await ctx(), 17);
  await writeReport(report);
  assertHeld(report, S6);
});
