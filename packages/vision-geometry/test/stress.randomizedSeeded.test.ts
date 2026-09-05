import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executePlan,
  planSequence,
  runCampaign,
  stableJson,
  type CampaignConfig,
} from "./support/randomizedSeededStress.js";

/**
 * Seeded randomized long-run stress campaign over the vision-geometry +
 * vision-contracts public API (lens: randomized-seeded).
 *
 * Suite default is small (STRESS_ITER=25 sequences, each replayed twice for
 * the determinism check). The long campaign is opt-in:
 *
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/stress/randomized-seeded.json \
 *     pnpm --filter @pickle/vision-geometry test -- stress.randomizedSeeded
 *
 * Knobs (all optional):
 *   STRESS_ITER     number of sequences (default 25)
 *   STRESS_SEED     base seed that derives the per-sequence seeds (default 20260905)
 *   STRESS_MIN_LEN  / STRESS_MAX_LEN  action-sequence length bounds (default 5 / 60)
 *   STRESS_SEEDS    comma-separated explicit seeds to replay (overrides ITER/SEED)
 *   STRESS_OUT      path for the JSON results table (seed → outcome); not written when unset
 *   STRESS_REPEAT   extra replays per seed for flake-rate measurement (default 0)
 *
 * Every row is replayable from its seed alone: `planSequence(seed, min, max)`
 * regenerates the exact swing + action list, `executePlan` re-runs it.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

function configFromEnv(): CampaignConfig {
  const config: CampaignConfig = {
    iterations: envInt("STRESS_ITER", 25),
    baseSeed: envInt("STRESS_SEED", 20260905),
    minLen: envInt("STRESS_MIN_LEN", 5),
    maxLen: envInt("STRESS_MAX_LEN", 60),
  };
  const explicit = process.env["STRESS_SEEDS"];
  if (explicit && explicit.trim() !== "") {
    config.seeds = explicit
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((s) => Number.isFinite(s));
  }
  return config;
}

describe("randomized-seeded stress: vision-geometry public API", () => {
  it(
    "holds every documented invariant and replays deterministically for every seed",
    async () => {
      const config = configFromEnv();
      const repeat = envInt("STRESS_REPEAT", 0);
      const started = Date.now();
      let lastLog = started;
      const result = await runCampaign(config, (done, total) => {
        const now = Date.now();
        if (now - lastLog > 15_000 || done === total) {
          lastLog = now;
          process.stdout.write(
            `[stress] ${done}/${total} sequences (${((now - started) / 1000).toFixed(0)}s)\n`,
          );
        }
      });

      // Flake-rate measurement for every failing seed: replay N more times.
      const flakeRates: Record<string, { runs: number; violated: number; traceHashes: string[] }> =
        {};
      if (repeat > 0) {
        for (const failure of result.failures) {
          const plan = planSequence(failure.seed, config.minLen, config.maxLen);
          const hashes = new Set<string>();
          let violated = 0;
          for (let i = 0; i < repeat; i += 1) {
            const outcome = await executePlan(plan);
            hashes.add(outcome.traceHash);
            if (outcome.outcome === "violated") violated += 1;
          }
          flakeRates[String(failure.seed)] = { runs: repeat, violated, traceHashes: [...hashes] };
        }
      }

      const out = process.env["STRESS_OUT"];
      if (out && out.trim() !== "") {
        mkdirSync(dirname(out), { recursive: true });
        const table = result.rows.map((row) => ({
          seed: row.seed,
          length: row.length,
          queries: row.queries,
          outcome: row.outcome,
          deterministic: row.deterministic,
          traceHash: row.traceHash,
          replayTraceHash: row.replayTraceHash,
          violations: row.violations,
          durationMs: Math.round(row.durationMs * 1000) / 1000,
        }));
        writeFileSync(
          out,
          stableJson({
            harness: "vision-geometry randomized-seeded stress v1",
            config,
            totals: result.totals,
            cancellation:
              "not_applicable: no public provider method accepts an AbortSignal (vision-contracts/src/contracts.ts)",
            flakeRates,
            failures: result.failures.map((f) => ({
              seed: f.seed,
              originalLength: f.original.length,
              originalViolations: f.original.violations,
              minimizedLength: f.minimized.actions.length,
              minimizedPlan: f.minimized,
              minimizedViolations: f.minimizedOutcome.violations,
              minimizedTrace: f.minimizedOutcome.trace,
            })),
            table,
          }),
        );
        process.stdout.write(`[stress] wrote ${out}\n`);
      }

      const nondeterministic = result.rows.filter((r) => !r.deterministic).map((r) => r.seed);
      const violated = result.failures.map((f) => ({
        seed: f.seed,
        invariants: [...new Set(f.original.violations.map((v) => v.invariant))],
        minimizedLength: f.minimized.actions.length,
        first: f.minimizedOutcome.violations[0],
      }));
      expect(result.totals.sequences).toBe(config.seeds?.length ?? config.iterations);
      expect(nondeterministic, `non-deterministic seeds: ${nondeterministic.join(",")}`).toEqual(
        [],
      );
      expect(violated, `violating seeds (minimized): ${stableJson(violated)}`).toEqual([]);
    },
    { timeout: 6 * 60 * 60 * 1000 },
  );
});
