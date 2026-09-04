/**
 * stress — POST /v1/me/delete-request × concurrency. Real handler in-process,
 * modelled Supabase, seeded interleavings.
 *
 *   deno test -A --no-check --config deno.json stress_delete_request_concurrency.test.ts
 *   STRESS_ITER=40 STRESS_OUT_DIR=/tmp/stress/ deno test -A …  # campaign, 7 × 40
 *   STRESS_REDIS=1 STRESS_ITER=40 deno test -A …               # same, budgets on L2 Redis
 *   STRESS_SEED=<seed> STRESS_ITER=1 … --filter "dup-burst"    # replay one iteration
 *
 * STRESS_REDIS is per-process on purpose: cache.ts reads the Upstash env at
 * module load, so one process is one mode — the campaign runs the file twice.
 *
 * Writes <STRESS_OUT_DIR>/delete_request_<mode>.json — one row per iteration
 * (seed, inputs, per-lane status/body, applied writes, invariants, replay).
 * Scenarios: stress_delete_request_scenarios.ts.
 */
import { assert } from "@std/assert";
import {
  envInt,
  type IterationRow,
  loadStressHarness,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  writeRows,
} from "./stress_delete_request_harness.ts";
import { runIteration, SCENARIOS } from "./stress_delete_request_scenarios.ts";

const FILE = "stress_delete_request_concurrency.test.ts";
const REDIS = envInt("STRESS_REDIS", 0) === 1;
const MODE = REDIS ? "redis" : "memory";
const rows: IterationRow[] = [];
const scenarioNames = Object.keys(SCENARIOS);

for (const scenario of scenarioNames) {
  Deno.test(
    `STRESS delete-request/concurrency [${MODE}] ${scenario} × ${STRESS_ITER}`,
    async () => {
      const h = await loadStressHarness({ redis: REDIS });
      const mine: IterationRow[] = [];
      for (let i = 0; i < STRESS_ITER; i++) {
        const row = await runIteration(h, FILE, scenario, STRESS_SEED + i, i);
        mine.push(row);
        rows.push(row);
      }
      const broken = mine.filter((r) => !r.held);
      for (const r of broken) {
        console.error(
          `[stress] BROKEN ${scenario} seed=${r.seed}\n  ${r.invariants
            .filter((i) => !i.holds)
            .map((i) => `${i.name}: ${i.detail}`)
            .join("\n  ")}\n  replay: ${r.replay}`,
        );
      }
      const lanes = mine.reduce((n, r) => n + r.lanes.length, 0);
      console.log(
        `[stress] ${scenario}: ${mine.length - broken.length}/${mine.length} held, ${lanes} lanes, max ${Math.max(
          ...mine.map((r) => r.durationMs),
        )}ms`,
      );
      // Rewritten after every scenario so a --filter run or an early failure
      // still leaves the accumulated table on disk.
      const path = await writeRows(`delete_request_${MODE}`, rows, {
        file: FILE,
        mode: MODE,
        seed: STRESS_SEED,
        iterationsPerScenario: STRESS_ITER,
        latencyMs: STRESS_LATENCY_MS,
        upstreamCalls: h.upstreamCalls.length,
      });
      console.log(`[stress] report: ${path}`);
      assert(
        broken.length === 0,
        `${broken.length} broken iteration(s): seeds ${broken.map((r) => r.seed).join(",")}`,
      );
    },
  );
}
