import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { heapVerdict, linearFit, median, percentile } from "./soakStats.js";
import {
  TRANSCODER_VARIANTS,
  controlAdjust,
  createScratchRoot,
  deriveWorkerFindings,
  removeScratchRoot,
  runVariant,
  scratchStats,
  type VariantReport,
} from "./workerSoak.js";

const verdictOptions = { warmupCycles: 0, windowCycles: 10, thresholdPer100CyclesPct: 5, gc: true };

describe("media-worker soak — statistics", () => {
  it("linearFit / median / percentile", () => {
    const fit = linearFit([0, 1, 2, 3].map((x) => ({ x, y: 2 * x + 1 })));
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(1, 10);
    expect(linearFit([]).slope).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });

  it("heapVerdict flags only monotone growth above threshold with gc exposed", () => {
    const growing = Array.from({ length: 40 }, (_, i) => 1_000_000 * (1 + 0.001 * i));
    expect(heapVerdict(growing, verdictOptions).leakSuspected).toBe(true);
    expect(heapVerdict(growing, { ...verdictOptions, gc: false }).leakSuspected).toBe(false);
    const flat = heapVerdict(
      Array.from({ length: 40 }, () => 1_000_000),
      verdictOptions,
    );
    expect(flat.leakSuspected).toBe(false);
    expect(flat.slopeBytesPerCycle).toBe(0);
    expect(flat.windows).toHaveLength(4);
  });
});

async function run(
  variant: (typeof TRANSCODER_VARIANTS)[number],
  cycles: number,
  control = false,
): Promise<{ report: VariantReport; residualAtEnd: number }> {
  const scratchRoot = createScratchRoot();
  try {
    const report = await runVariant({
      variant,
      cycles,
      warmupCycles: 1,
      windowCycles: 5,
      thresholdPer100CyclesPct: 5,
      scratchRoot,
      control,
    });
    return { report, residualAtEnd: scratchStats(scratchRoot).files };
  } finally {
    removeScratchRoot(scratchRoot);
    expect(existsSync(scratchRoot)).toBe(false);
  }
}

describe("media-worker soak — lifecycle matrix at small scale", () => {
  it("none (production wiring): every job handled, asset marked ready, nothing on disk", async () => {
    const { report, residualAtEnd } = await run("none", 10);
    expect(report.jobsHandled).toBe(10);
    expect(report.jobsLeftOnQueue).toBe(0);
    expect(report.readyUpdates).toBe(10);
    expect(report.failedUpdates).toBe(0);
    expect(report.objectDeletes).toBe(0);
    expect(report.exceptions).toBe(0);
    expect(residualAtEnd).toBe(0);
    expect(Object.keys(report.outcomes)).toEqual([
      "no transcoder configured; master kept as playback source",
    ]);
  });

  it("clean transcoder: derived keys accepted, scratch removed by the implementation", async () => {
    const { report, residualAtEnd } = await run("clean", 10);
    expect(report.readyUpdates).toBe(10);
    expect(report.failedUpdates).toBe(0);
    expect(report.objectDeletes).toBe(0);
    expect(residualAtEnd).toBe(0);
    expect(report.records.every((r) => r.scratch.files === 0)).toBe(true);
  });

  it("throw_after_scratch: asset failed, job acked, scratch left behind grows linearly (seam has no cleanup hook)", async () => {
    const { report, residualAtEnd } = await run("throw_after_scratch", 10);
    expect(report.exceptions).toBe(0);
    expect(report.jobsHandled).toBe(10);
    expect(report.failedUpdates).toBe(10);
    expect(report.readyUpdates).toBe(0);
    expect(residualAtEnd).toBe(30);
    expect(report.residualFilesPerCycle).toBe(3);
    expect(report.records.map((r) => r.scratch.files)).toEqual(
      Array.from({ length: 10 }, (_, i) => 3 * (i + 1)),
    );
    const findings = deriveWorkerFindings([report], null);
    expect(findings.some((f) => f.criterion.startsWith("scratch files survive"))).toBe(true);
  });

  it("bad_prefix: derived objects deleted and asset failed", async () => {
    const { report } = await run("bad_prefix", 10);
    expect(report.objectDeletes).toBe(20);
    expect(report.failedUpdates).toBe(10);
    expect(report.readyUpdates).toBe(0);
    expect(report.jobsLeftOnQueue).toBe(0);
  });

  it("deleted_mid_transcode: derived objects deleted, no failure marked", async () => {
    const { report } = await run("deleted_mid_transcode", 10);
    expect(report.objectDeletes).toBe(20);
    expect(report.readyUpdates).toBe(10);
    expect(report.failedUpdates).toBe(0);
    expect(report.jobsLeftOnQueue).toBe(0);
  });

  it("control drains the queue without runOnce and records the same shape", async () => {
    const { report } = await run("none", 6, true);
    expect(report.control).toBe(true);
    expect(report.jobsHandled).toBe(0);
    expect(report.jobsLeftOnQueue).toBe(0);
    expect(report.poolQueries).toBe(0);
    expect(report.records).toHaveLength(6);
    const adjusted = controlAdjust([report], report);
    expect(adjusted[0]?.adjustedSlopeBytesPerCycle).toBeCloseTo(0, 6);
  });

  it("deriveWorkerFindings promotes exceptions, unacked jobs and control-adjusted leaks", async () => {
    const { report } = await run("clean", 6);
    const leakyHeap = heapVerdict(
      Array.from({ length: 30 }, (_, i) => 1_000_000 * (1 + 0.002 * i)),
      verdictOptions,
    );
    const findings = deriveWorkerFindings(
      [
        { ...report, exceptions: 2 },
        { ...report, variant: "bad_prefix", jobsLeftOnQueue: 1 },
        { ...report, variant: "deleted_mid_transcode", heap: leakyHeap },
      ],
      null,
    );
    expect(findings.map((f) => f.criterion)).toEqual([
      "runOnce threw (poison job must never escape the cycle)",
      "media.process jobs left unacked on the queue",
      "monotone gc'd heap growth > 5% per 100 cycles",
    ]);
    expect(deriveWorkerFindings([report], null)).toEqual([]);
  });
});
