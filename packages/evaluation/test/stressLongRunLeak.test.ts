/**
 * Long-run leak stress (lens `long-run-leak`) for the regression runner and
 * comparator — vitest wrapper around test/stress/longRunLeak.ts.
 *
 * Every campaign invokes its unit STRESS_ITER times in this worker process,
 * probing heap / active libuv resources / signal listeners with a forced GC
 * every `probeEvery` iterations. Defaults are sized to keep the suite fast;
 * the full 500+ iteration campaign is
 *
 *   STRESS_ITER=500 pnpm --filter @pickle/evaluation test -- stressLongRunLeak
 *
 * or, with per-campaign JSON artifacts, the standalone CLI documented at the
 * top of test/stress/longRunLeak.ts. STRESS_SEED replays a campaign; every
 * failing row carries its own seed (`deriveSeed(STRESS_SEED, index)`).
 */
import { describe, expect, it } from "vitest";
import {
  CAMPAIGNS,
  HEAP_SLOPE_LIMIT_PCT_PER_100,
  analyseHeap,
  analyseTiming,
  deriveSeed,
  loadCommittedBaseline,
  loadCommittedTolerances,
  metricDomainViolations,
  mulberry32,
  mutateCandidate,
  nonFinitePaths,
  type CampaignName,
  type CampaignReport,
  type ResourceProbe,
} from "./stress/longRunLeak.js";

const STRESS_ITER = process.env.STRESS_ITER === undefined ? null : Number(process.env.STRESS_ITER);
const SEED = Number(process.env.STRESS_SEED ?? 20260904);

/** Small defaults keep the whole file under ~30s; STRESS_ITER overrides all. */
const DEFAULT_ITERATIONS: Record<CampaignName, number> = {
  runner_in_process: 8,
  runner_subprocess: 3,
  runner_cancel: 4,
  comparator: 200,
  validator_fuzz: 300,
};

function iterationsFor(name: CampaignName): number {
  if (STRESS_ITER !== null && Number.isFinite(STRESS_ITER) && STRESS_ITER > 0) return STRESS_ITER;
  return DEFAULT_ITERATIONS[name];
}

/** Probe often enough for a slope even at the small defaults. */
function probeEveryFor(iterations: number): number {
  return Math.max(1, Math.min(50, Math.floor(iterations / 4)));
}

function describeFailure(report: CampaignReport): string {
  const rows = report.failingSeeds
    .slice(0, 5)
    .map((r) => `  #${r.index} seed=${r.seed} ${r.outcome}: ${r.detail.slice(0, 300)}`);
  return [
    `${report.campaign}: ${report.verdict}`,
    ...report.reasons.map((reason) => `  - ${reason}`),
    ...rows,
    `  heap: ${JSON.stringify(report.heap)}`,
    `  timing: ${JSON.stringify(report.timing)}`,
  ].join("\n");
}

function expectHeld(report: CampaignReport, expectedIterations: number): void {
  expect(report.iterationsExecuted).toBe(expectedIterations);
  expect(report.failingSeeds, describeFailure(report)).toEqual([]);
  expect(
    report.resourceDeltas.filter((d) => d.leaked),
    describeFailure(report),
  ).toEqual([]);
  for (const check of report.extraChecks) {
    expect(check.ok, `${report.campaign}: ${check.name}: ${check.detail}`).toBe(true);
  }
  expect(report.heap.verdict, describeFailure(report)).not.toBe("BROKEN");
  if (report.heap.verdict === "HELD") {
    expect(report.heap.slopePctPer100Iterations).toBeLessThanOrEqual(HEAP_SLOPE_LIMIT_PCT_PER_100);
  }
  // Timing drift is reported, and only enforced once the sample is large
  // enough for medians to be meaningful.
  if (report.timing.verdict !== "INSUFFICIENT_SAMPLES" && report.iterationsExecuted >= 100) {
    expect(report.timing.verdict, describeFailure(report)).toBe("HELD");
  }
  expect(report.verdict, describeFailure(report)).toBe("HELD");
}

describe("long-run leak: analysis helpers", () => {
  const probeAt = (iteration: number, heapUsedBytes: number): ResourceProbe => ({
    iteration,
    heapUsedBytes,
    heapTotalBytes: heapUsedBytes * 2,
    rssBytes: heapUsedBytes * 4,
    externalBytes: 0,
    arrayBuffersBytes: 0,
    activeResources: {},
    signalListeners: { SIGINT: 0, SIGTERM: 0 },
  });

  it("flags a monotone heap slope above 5% per 100 iterations", () => {
    // 10 MiB growing 5% every 50 iterations = 10% per 100, over 500 iterations.
    const probes = Array.from({ length: 11 }, (_, i) =>
      probeAt(i * 50, 10_000_000 * (1 + i * 0.05)),
    );
    const analysis = analyseHeap(probes, 2);
    expect(analysis.verdict).toBe("BROKEN");
    expect(analysis.monotoneIncreasing).toBe(true);
    // 10k bytes/iteration relative to the first post-warmup sample (11 MiB) ≈ 9.1%/100.
    expect(analysis.slopePctPer100Iterations).toBeCloseTo(9.09, 1);
  });

  it("holds a flat heap with noise and reports insufficient samples honestly", () => {
    const flat = [0, 50, 100, 150, 200, 250].map((i, k) => probeAt(i, 10_000_000 + (k % 2) * 2000));
    expect(analyseHeap(flat, 2).verdict).toBe("HELD");
    expect(analyseHeap(flat.slice(0, 3), 2).verdict).toBe("INSUFFICIENT_SAMPLES");
    // A steep slope over a span < 100 iterations is warm-up, not a per-100 statement.
    const shortSpan = [0, 2, 4, 6, 8].map((i) => probeAt(i, 10_000_000 + i * 100_000));
    expect(analyseHeap(shortSpan, 1).verdict).toBe("INSUFFICIENT_SAMPLES");
  });

  it("measures invocation time drift between the first and last fifth", () => {
    const steady = Array.from({ length: 50 }, () => 10);
    expect(analyseTiming(steady).driftRatio).toBe(1);
    const drifting = Array.from({ length: 50 }, (_, i) => 10 + i);
    const drift = analyseTiming(drifting);
    expect(drift.verdict).toBe("DRIFT");
    expect(drift.driftRatio).toBeGreaterThan(1.5);
  });

  it("derives replayable per-iteration seeds and a deterministic RNG", () => {
    expect(deriveSeed(SEED, 7)).toBe(deriveSeed(SEED, 7));
    expect(deriveSeed(SEED, 7)).not.toBe(deriveSeed(SEED, 8));
    const a = mulberry32(deriveSeed(SEED, 7));
    const b = mulberry32(deriveSeed(SEED, 7));
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });

  it("finds NaN / Infinity anywhere in a JSON-like value", () => {
    expect(nonFinitePaths({ a: [1, { b: Number.NaN }], c: Number.POSITIVE_INFINITY })).toEqual([
      "$.a[1].b",
      "$.c",
    ]);
    expect(nonFinitePaths(loadCommittedBaseline())).toEqual([]);
  });

  it("accepts the committed baseline's metric domains", () => {
    expect(metricDomainViolations(loadCommittedBaseline().metrics)).toEqual([]);
    expect(metricDomainViolations({ "contact_replay.coverage": 1.2 })).toHaveLength(1);
    expect(
      metricDomainViolations({
        "contact_replay.target_events": 5,
        "contact_replay.estimated": 3,
        "contact_replay.abstained": 3,
      }),
    ).toHaveLength(1);
  });

  it("mutates candidates deterministically from a seed", () => {
    const baseline = loadCommittedBaseline();
    const config = loadCommittedTolerances();
    const first = mutateCandidate(baseline, config, mulberry32(deriveSeed(SEED, 3)));
    const second = mutateCandidate(baseline, config, mulberry32(deriveSeed(SEED, 3)));
    expect(first).toEqual(second);
    expect(baseline).toEqual(loadCommittedBaseline());
  });
});

describe("long-run leak: campaigns (STRESS_ITER overrides the iteration count)", () => {
  it("comparator: compareSummaries/formatCompareReport/cli compare hold across seeded candidates", async () => {
    const iterations = iterationsFor("comparator");
    const report = await CAMPAIGNS.comparator({
      iterations,
      campaignSeed: SEED,
      probeEvery: probeEveryFor(iterations),
      warmupSamples: 1,
    });
    expectHeld(report, iterations);
    // The seeded candidate space must actually exercise every exit path.
    expect(Object.keys(report.outcomeCounts).sort()).toEqual(["ok_exit0", "ok_exit1", "ok_exit3"]);
  }, 120_000);

  it("validator fuzz: validateRegressionSummary/validateToleranceConfig never throw", async () => {
    const iterations = iterationsFor("validator_fuzz");
    const report = await CAMPAIGNS.validator_fuzz({
      iterations,
      campaignSeed: SEED,
      probeEvery: probeEveryFor(iterations),
      warmupSamples: 1,
    });
    expectHeld(report, iterations);
  }, 120_000);

  it("runner (in-process benches): deterministic, finite, bounded, no leaked handles", async () => {
    const iterations = iterationsFor("runner_in_process");
    const report = await CAMPAIGNS.runner_in_process({
      iterations,
      campaignSeed: SEED,
      probeEvery: probeEveryFor(iterations),
      warmupSamples: 1,
    });
    expectHeld(report, iterations);
  }, 900_000);

  it("runner (subprocess benches): child processes, scratch dirs and datasets/ are clean", async () => {
    const iterations = iterationsFor("runner_subprocess");
    const report = await CAMPAIGNS.runner_subprocess({
      iterations,
      campaignSeed: SEED,
      probeEvery: probeEveryFor(iterations),
      warmupSamples: 1,
    });
    expectHeld(report, iterations);
  }, 900_000);

  it("runner cancellation: SIGINT/SIGTERM mid-run is honoured, nothing survives", async () => {
    const iterations = iterationsFor("runner_cancel");
    const report = await CAMPAIGNS.runner_cancel({
      iterations,
      campaignSeed: SEED,
      probeEvery: probeEveryFor(iterations),
      warmupSamples: 1,
    });
    expectHeld(report, iterations);
    expect(Object.keys(report.outcomeCounts).sort()).toEqual(
      expect.arrayContaining(["interrupted"]),
    );
  }, 900_000);
});
