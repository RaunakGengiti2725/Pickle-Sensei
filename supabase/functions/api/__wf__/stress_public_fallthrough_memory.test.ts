// stress · route-get-healthz-privacy-terms-unknown-paths-methods-ro · lens
// CONCURRENCY — per-isolate (memory) rate-limit path.
//
// Real ../index.ts handler in-process; Supabase Auth / PostgREST faked by
// sessionHarness.ts; NO Upstash configured so rateLimit.ts uses its memory
// windows (the deploy without UPSTASH_* secrets). Seeded Promise.all bursts:
//   S1 one IP, GET/HEAD across /healthz /support /privacy /terms, jitter, aborts
//   S2 2–6 IPs interleaved (XFF hop shapes + cf-connecting-ip)
//   S3 unknown paths × unsupported methods × every bearer kind (+ authfail probe)
//   S3b auth-failure budget under concurrent bad bearers (two waves)
//   S4 logout racing an unknown-route burst on the same session
//   S5 clock skew across a fixed-window edge (forward and backward)
//   S6 duplicate public calls (shared X-Request-Id) are byte-identical
//   S7 20 000 spoofed IPs vs a limited victim (memory-window eviction contract)
//
// Scale: STRESS_ITER (default 12) iterations per scenario. Campaign:
//   STRESS_ITER=100 deno test -A --no-check --config deno.json stress_public_fallthrough_memory.test.ts
// Replay one row: STRESS_REPLAY_SEED=<seed> … --filter "<scenario>"
// Report: artifacts/stress-public-fallthrough/memory/stress_public_fallthrough_memory.json
// (override with STRESS_OUT_DIR).

import { loadSessionHarness } from "./sessionHarness.ts";
import {
  assertHeld,
  newReport,
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
  S7,
  s7,
  type ScenarioContext,
  smoke,
} from "./stress_public_fallthrough_scenarios.ts";

const FILE = "stress_public_fallthrough_memory.test.ts";
const report = newReport("memory", FILE, "memory");

async function ctx(): Promise<ScenarioContext> {
  const h = await loadSessionHarness({ redis: false });
  return { h, report, file: FILE };
}

Deno.test("stress public/fallthrough (memory): harness smoke", async () => {
  await smoke((await ctx()).h);
});

Deno.test(S1, async () => {
  await s1(await ctx(), 1);
  await writeReport(report);
  assertHeld(report, S1);
});

Deno.test(S2, async () => {
  await s2(await ctx(), 2);
  await writeReport(report);
  assertHeld(report, S2);
});

Deno.test(S3, async () => {
  await s3(await ctx(), 3);
  await writeReport(report);
  assertHeld(report, S3);
});

Deno.test(S3B, async () => {
  await s3b(await ctx(), 4);
  await writeReport(report);
  assertHeld(report, S3B);
});

Deno.test(S4, async () => {
  await s4(await ctx(), 5);
  await writeReport(report);
  assertHeld(report, S4);
});

Deno.test(S5, async () => {
  await s5(await ctx(), 6);
  await writeReport(report);
  assertHeld(report, S5);
});

Deno.test(S6, async () => {
  await s6(await ctx(), 7);
  await writeReport(report);
  assertHeld(report, S6);
});

// ~20k in-process requests and it wipes every live memory window on this
// isolate, so it runs LAST and only when asked for (STRESS_FLOOD=1).
Deno.test({
  name: S7,
  ignore: Deno.env.get("STRESS_FLOOD") !== "1",
  async fn() {
    await s7(await ctx(), 8);
    await writeReport(report);
    assertHeld(report, S7);
  },
});
