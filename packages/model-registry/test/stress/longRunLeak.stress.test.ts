import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_SCENARIOS,
  acquireGc,
  harnessControl,
  iterationSeed,
  runCampaign,
  type CampaignResult,
  type Scenario,
} from "./longRunLeakHarness.js";

/**
 * Long-run leak / soak campaign for @pickle/model-registry.
 *
 * Fast by default (STRESS_ITER=60 per scenario, ~1s). The full campaign:
 *
 *   STRESS_ITER=500 STRESS_OUT=/tmp/model-registry-stress \
 *     NODE_OPTIONS=--expose-gc pnpm --filter @pickle/model-registry test -- stress
 *
 * Every iteration's seed is `iterationSeed(STRESS_SEED, scenario, index)`;
 * replay one with `STRESS_REPLAY=<scenario>:<seed>`. When STRESS_OUT is set
 * the seed → outcome table, heap samples and handle counts are written there
 * as JSON (one file per scenario + summary.json).
 */

const ITERATIONS = Number.parseInt(process.env["STRESS_ITER"] ?? "60", 10);
const CAMPAIGN_SEED = Number.parseInt(process.env["STRESS_SEED"] ?? "20260904", 10);
const OUT_DIR = process.env["STRESS_OUT"];
const REPLAY = process.env["STRESS_REPLAY"];

/** Monotone heap slope above this (% of post-warmup heap per 100 iterations) is a leak finding. */
const MAX_HEAP_SLOPE_PCT_PER_100 = 5;
/** Late-window median invocation time may not exceed this multiple of the early window. */
const MAX_TIME_DRIFT_RATIO = 2.5;
/** Long-lived controller: append-only journal entries must stay small. */
const MAX_RETAINED_BYTES_PER_JOURNAL_ENTRY = 1024;

const results: CampaignResult[] = [];
let control: CampaignResult | null = null;

function toTable(result: CampaignResult): Record<string, unknown> {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      seed: row.seed,
      index: row.index,
      outcome: row.failures.length === 0 ? "HELD" : "BROKEN",
      digest: row.digest,
      ms: Number(row.ms.toFixed(4)),
      invocations: row.invocations,
      abstentions: row.abstentions,
      failures: row.failures,
      counters: row.counters,
    })),
  };
}

afterAll(() => {
  if (!OUT_DIR || results.length === 0) return;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const result of results) {
    writeFileSync(
      join(OUT_DIR, `${result.scenario}.json`),
      JSON.stringify(toTable(result), null, 2),
    );
  }
  const summary = {
    package: "@pickle/model-registry",
    lens: "long-run-leak",
    node: process.version,
    campaignSeed: CAMPAIGN_SEED,
    iterationsPerScenario: ITERATIONS,
    gcExposed: acquireGc() !== null,
    thresholds: {
      MAX_HEAP_SLOPE_PCT_PER_100,
      MAX_TIME_DRIFT_RATIO,
      MAX_RETAINED_BYTES_PER_JOURNAL_ENTRY,
    },
    harnessControl:
      control === null
        ? null
        : {
            slopeBytesPerIteration: control.heap.slopeBytesPerIteration,
            slopePctPer100: control.heap.slopePctPer100,
            heapSamples: control.samples.map((s) => ({
              iteration: s.iteration,
              heapUsed: s.heapUsed,
            })),
          },
    scenarios: results.map((r) => ({
      scenario: r.scenario,
      unitSlopeBytesPerIterationNetOfHarness:
        control === null
          ? null
          : r.heap.slopeBytesPerIteration - control.heap.slopeBytesPerIteration,
      iterationsExecuted: r.iterationsExecuted,
      replaysExecuted: r.replaysExecuted,
      invocations: r.totals.invocations,
      abstentions: r.totals.abstentions,
      nonFiniteOutputs: r.totals.nonFiniteOutputs,
      failures: r.failures.length,
      determinismMismatches: r.determinism.mismatches.length,
      handlesReturnedToBaseline: r.handlesReturnedToBaseline,
      baseline: r.baseline,
      final: r.final,
      heap: r.heap,
      timing: r.timing,
      heapSamples: r.samples.map((s) => ({
        iteration: s.iteration,
        heapUsed: s.heapUsed,
        rss: s.rss,
        timers: s.timers,
        listeners: s.processListeners,
        retainedUnits: s.retainedUnits,
      })),
      counters: r.totals.counters,
    })),
  };
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
});

function runAndRecord(scenario: Scenario): CampaignResult {
  const result = runCampaign(scenario, {
    iterations: ITERATIONS,
    campaignSeed: CAMPAIGN_SEED,
    sampleEvery: 50,
  });
  results.push(result);
  return result;
}

const CAMPAIGN_TIMEOUT_MS = 20 * 60 * 1000;

describe("model-registry long-run leak campaign", () => {
  it("runs with an exposed GC so heap samples are post-collection", () => {
    // acquireGc falls back to v8 flags + a fresh context when --expose-gc is
    // absent; either way the campaign must have a collector to call.
    expect(acquireGc()).not.toBeNull();
  });

  it(
    "measures the harness's own per-iteration retention (control, no unit calls)",
    () => {
      control = runCampaign(harnessControl, {
        iterations: ITERATIONS,
        campaignSeed: CAMPAIGN_SEED,
        sampleEvery: 50,
      });
      expect(control.iterationsExecuted).toBe(ITERATIONS);
      expect(control.totals.invocations).toBe(0);
      expect(control.handlesReturnedToBaseline).toBe(true);
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  for (const scenario of ALL_SCENARIOS()) {
    describe(scenario.name, () => {
      let result: CampaignResult;
      beforeAll(() => {
        result = runAndRecord(scenario);
      }, CAMPAIGN_TIMEOUT_MS);

      it(`executes every iteration (${ITERATIONS}) and replays each seed deterministically`, () => {
        expect(result.iterationsExecuted).toBe(ITERATIONS);
        expect(result.replaysExecuted).toBe(ITERATIONS);
        expect(result.determinism.mismatches).toEqual([]);
      });

      it("holds every per-iteration invariant (oracle agreement, bounded abstention, clean rejection)", () => {
        expect(result.failures).toEqual([]);
        expect(result.totals.invocations).toBeGreaterThan(ITERATIONS);
      });

      it("never emits NaN/Infinity", () => {
        expect(result.totals.nonFiniteOutputs).toBe(0);
        for (const key of [
          "deltaPct",
          "slopeBytesPerIteration",
          "slopePctPer100",
          "maxHeapUsed",
        ] as const) {
          expect(Number.isFinite(result.heap[key])).toBe(true);
        }
        for (const key of [
          "earlyMedianMs",
          "lateMedianMs",
          "driftRatio",
          "meanMs",
          "p99Ms",
          "totalMs",
        ] as const) {
          expect(Number.isFinite(result.timing[key])).toBe(true);
        }
      });

      it("returns timers, handles and process listeners to baseline", () => {
        expect(result.final.timers).toBe(result.baseline.timers);
        expect(result.final.processListeners).toBe(result.baseline.processListeners);
        expect(result.final.activeResources).toEqual(result.baseline.activeResources);
        expect(result.handlesReturnedToBaseline).toBe(true);
      });

      if (scenario.retainsStateAcrossIterations) {
        it("retains only the append-only journal (bounded bytes per entry)", () => {
          expect(result.heap.retainedBytesPerUnit).not.toBeNull();
          expect(result.heap.retainedBytesPerUnit).toBeLessThan(
            MAX_RETAINED_BYTES_PER_JOURNAL_ENTRY,
          );
        });
      } else {
        it(`keeps post-GC heap slope ≤ ${MAX_HEAP_SLOPE_PCT_PER_100}% per 100 iterations`, () => {
          expect(result.samples.length).toBeGreaterThanOrEqual(2);
          expect(result.heap.slopePctPer100).toBeLessThanOrEqual(MAX_HEAP_SLOPE_PCT_PER_100);
        });
      }

      it(`keeps invocation-time drift ≤ ${MAX_TIME_DRIFT_RATIO}× (late vs early median)`, () => {
        expect(result.timing.driftRatio).toBeLessThanOrEqual(MAX_TIME_DRIFT_RATIO);
      });
    });
  }

  it("replays a single seed on demand (STRESS_REPLAY=<scenario>:<seed>)", () => {
    if (!REPLAY) return;
    const [name, seedText] = REPLAY.split(":");
    const scenario = ALL_SCENARIOS().find((s) => s.name === name);
    expect(scenario, `unknown scenario ${String(name)}`).toBeDefined();
    const seed = Number.parseInt(seedText ?? "", 10);
    expect(Number.isInteger(seed)).toBe(true);
    const first = scenario!.run(seed);
    const second = scenario!.run(seed);
    expect(second.digest).toBe(first.digest);
    expect(first.failures).toEqual([]);
  });

  it("derives replayable per-iteration seeds from the campaign seed", () => {
    expect(iterationSeed(CAMPAIGN_SEED, "registry-lifecycle", 0)).toBe(
      iterationSeed(CAMPAIGN_SEED, "registry-lifecycle", 0),
    );
    expect(iterationSeed(CAMPAIGN_SEED, "registry-lifecycle", 0)).not.toBe(
      iterationSeed(CAMPAIGN_SEED, "registry-lifecycle", 1),
    );
    expect(iterationSeed(CAMPAIGN_SEED, "registry-lifecycle", 0)).not.toBe(
      iterationSeed(CAMPAIGN_SEED, "from-json-fuzz", 0),
    );
  });
});
