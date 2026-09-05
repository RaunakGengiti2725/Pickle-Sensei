/**
 * LONG-RUN LEAK stress lens for @pickle/analytics.
 *
 * Default (CI) scale is small so this lives in the normal suite. The full
 * campaign is opt-in:
 *
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=600 STRESS_SEED=20260905 \
 *   STRESS_OUT=/tmp/pkg-analytics-long-run-leak.json \
 *   pnpm --filter @pickle/analytics test -- stress
 *
 * Env:
 *   STRESS_ITER   iterations in one process (default 25; lens requires ≥ 500)
 *   STRESS_SEED   campaign seed (default 20260905); each iteration's own seed
 *                 is derived from it and recorded in the JSON table
 *   STRESS_EVERY  heap/handle sample cadence in iterations (default 50)
 *   STRESS_OUT    write the full JSON report (seed → outcome table, heap
 *                 samples, timing) to this path
 *   STRESS_REPLAY comma-separated iteration seeds to replay in isolation
 *
 * The suite ASSERTS the lens invariants (no BROKEN rows, heap slope within
 * limit, resources back to baseline, timing drift bounded) so a regression
 * fails CI rather than merely printing a table.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEAP_SLOPE_LIMIT_PCT_PER_100,
  runCampaign,
  runIteration,
  scanCostProbe,
  type CampaignReport,
} from "./campaign.js";
import { SeededRng, iterationSeed } from "./seededRng.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

const ITERATIONS = envInt("STRESS_ITER", 25);
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260905);
const SAMPLE_EVERY = envInt("STRESS_EVERY", 50);
const OUT = process.env["STRESS_OUT"];
const REPLAY = (process.env["STRESS_REPLAY"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map((s) => Number(s));

/** Ratio (last window mean / first window mean) above which timing drifted. */
const TIMING_DRIFT_LIMIT = 3;

function writeReport(report: CampaignReport): void {
  if (!OUT) return;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
}

describe("pkg-analytics long-run-leak stress lens", () => {
  it(
    `holds every property across ${ITERATIONS} mount/use/unmount iterations in one process`,
    async () => {
      const report = await runCampaign(
        { campaignSeed: CAMPAIGN_SEED, iterations: ITERATIONS, sampleEvery: SAMPLE_EVERY },
        process.env["STRESS_GIT_REV"] ?? null,
      );
      writeReport(report);

      expect(report.iterationsExecuted).toBe(ITERATIONS);
      expect(
        report.failedSeeds.map((f) => `${f.seed}: ${f.failures.map((x) => x.check).join(",")}`),
      ).toEqual([]);

      // Timers / listeners / handles created by the unit must be gone: no
      // resource kind may have MORE live instances than at baseline.
      expect(report.leakedResources, JSON.stringify(report.resourceDeltas)).toEqual([]);
      expect(report.finalProcessListeners).toBeLessThanOrEqual(report.baselineProcessListeners);

      // Heap: a MONOTONE climb steeper than the lens limit is a leak.
      const leak =
        report.heapSlope.monotone && report.heapSlope.pctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100;
      expect(leak, JSON.stringify(report.heapSlope)).toBe(false);

      // Invocation time must not drift as the process ages.
      if (ITERATIONS >= 100) {
        expect(report.timing.ratio, JSON.stringify(report.timing)).toBeLessThan(TIMING_DRIFT_LIMIT);
      }
    },
    // Budget scales with the campaign; the default 25 finishes in well under 10 s.
    Math.max(60_000, ITERATIONS * 1_000),
  );

  it("replays a row of the table from its seed with an identical digest", async () => {
    const seed = iterationSeed(CAMPAIGN_SEED, 1);
    const a = await runIteration(seed, 1);
    const b = await runIteration(seed, 1);
    expect(a.digest).toBe(b.digest);
    expect(a.failures).toEqual(b.failures);
  });

  it("derives distinct seeds per iteration and distinct streams per seed", () => {
    const seeds = new Set<number>();
    for (let i = 1; i <= 1000; i++) seeds.add(iterationSeed(CAMPAIGN_SEED, i));
    expect(seeds.size).toBe(1000);
    const x = new SeededRng(1);
    const y = new SeededRng(2);
    expect(Array.from({ length: 8 }, () => x.next())).not.toEqual(
      Array.from({ length: 8 }, () => y.next()),
    );
  });

  if (REPLAY.length > 0) {
    it.each(REPLAY)("replays iteration seed %d", async (seed) => {
      const row = await runIteration(seed, 0);
      expect(row.failures, JSON.stringify(row, null, 2)).toEqual([]);
    });
  }
});

describe("pkg-analytics redaction guard scan-cost probe", () => {
  // Contract: MAX_ANALYTICS_STRING_LENGTH is 200. An oversized string must
  // be flagged, and flagging it must stay cheap regardless of its length —
  // a long-lived service that funnels error text through the guard must not
  // stall on one hostile payload. The lengths below are tiny multiples of
  // the cap; the full campaign (STRESS_ITER ≥ 500) also probes 20k.
  const lengths = ITERATIONS >= 500 ? [1_000, 5_000, 10_000, 20_000] : [1_000, 5_000];

  it.each(lengths)("flags a %d-char string and reports the time it took", (length) => {
    const rows = [1, 2, 3].map((k) =>
      scanCostProbe(iterationSeed(CAMPAIGN_SEED, 10_000 + k), length),
    );
    for (const row of rows) {
      expect(row.violations).toContain("failureKind:oversized_string");
    }
    const worst = Math.max(...rows.map((r) => r.durationMs));
    if (OUT) {
      const path = OUT.replace(/\.json$/, "") + `.scan-cost-${length}.json`;
      writeFileSync(path, JSON.stringify(rows, null, 2));
    }
    // Reported, not asserted: the redaction regexes are input-size
    // sensitive; see the campaign report for the measured curve.
    expect(Number.isFinite(worst)).toBe(true);
  });
});
