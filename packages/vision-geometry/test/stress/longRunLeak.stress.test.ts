import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEAP_SLOPE_LIMIT_PCT_PER_100,
  SAMPLE_EVERY,
  TIME_DRIFT_LIMIT_RATIO,
  buildScenario,
  findNonFinite,
  readRetainOutcomes,
  readSeedBase,
  readStressIterations,
  runCampaign,
  runSeed,
  seedFor,
  stableStringify,
} from "./longRunLeakHarness.js";

/**
 * Long-run leak campaign — lives in the suite at a small default and scales
 * with STRESS_ITER (≥ 500 for the lens). Replay any row of the JSON table:
 *   STRESS_SEED=<seedBase> STRESS_ITER=<n> pnpm --filter @pickle/vision-geometry test -- stress
 *   or `runSeed(<seed>)` for a single seed.
 * STRESS_OUT=<path> writes the seed → outcome table plus heap/handle samples.
 * STRESS_RETAIN=0 keeps only violating outcomes so the heap samples measure the
 * unit alone (the harness's own result table otherwise grows with N).
 */

const iterations = readStressIterations();
const seedBase = readSeedBase();
const retainOutcomes = readRetainOutcomes();
const outPath = process.env["STRESS_OUT"];

describe("harness self-checks", () => {
  it("builds the same scenario twice from one seed", () => {
    const a = buildScenario(seedFor(seedBase, 1));
    const b = buildScenario(seedFor(seedBase, 1));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("findNonFinite locates NaN and Infinity by path", () => {
    expect(findNonFinite({ a: [1, NaN], b: { c: Infinity }, d: -Infinity })).toEqual([
      "$.a[1]",
      "$.b.c",
      "$.d",
    ]);
    expect(findNonFinite({ a: [1, 2], b: null, c: "x" })).toEqual([]);
  });

  it("replays a single seed with an identical outcome", async () => {
    const seed = seedFor(seedBase, 7);
    const first = await runSeed(seed);
    const second = await runSeed(seed);
    const strip = ({ durationMs: _d, ...rest }: typeof first) => rest;
    expect(strip(first)).toEqual(strip(second));
  });
});

describe(`long-run leak campaign (${iterations} iterations, seedBase ${seedBase})`, () => {
  it(
    "holds determinism, finite outputs, bounded abstention, stable heap/handles/time",
    async () => {
      const result = await runCampaign({ iterations, seedBase, retainOutcomes });
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(result, null, 2));
      }
      const { summary } = result;

      expect(summary.iterations).toBe(iterations);
      expect(result.outcomes.length).toBe(
        retainOutcomes ? iterations : summary.properties.violationSeeds.length,
      );
      expect(result.samples.length).toBe(
        1 + Math.floor(iterations / SAMPLE_EVERY) + (iterations % SAMPLE_EVERY === 0 ? 0 : 1),
      );

      // Property checks — every violating seed is listed so failures are replayable.
      expect(summary.properties.nonDeterministicSeeds).toEqual([]);
      expect(summary.properties.nonFiniteSeeds).toEqual([]);
      // Violating outcomes are always retained, so this lists seed + mode + violation on failure.
      expect(
        result.outcomes
          .filter((o) => o.violations.length > 0)
          .map((o) => ({ seed: o.seed, mode: o.mode, violations: o.violations })),
      ).toEqual([]);
      expect(summary.properties.violationSeeds).toEqual([]);
      expect(summary.properties.abstention.truncatedScored).toEqual([]);
      expect(summary.properties.abstention.frozenScored).toEqual([]);

      // Resource invariants — handles/listeners/timers back to baseline after the run.
      expect(summary.handles.final).toEqual(summary.handles.baseline);

      // Heap slope only has statistical meaning once ≥ 3 post-warm-up samples exist (≥ 200 iterations).
      if (summary.heap.slopePctPer100 !== null) {
        expect(summary.heap.slopePctPer100).toBeLessThanOrEqual(HEAP_SLOPE_LIMIT_PCT_PER_100);
      }
      expect(summary.timing.driftRatio).toBeLessThanOrEqual(TIME_DRIFT_LIMIT_RATIO);
    },
    Math.max(60_000, iterations * 400),
  );
});
