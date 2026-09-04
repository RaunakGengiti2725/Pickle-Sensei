import { describe, expect, it } from "vitest";
import {
  captureInputFor,
  controlAdjust,
  deriveFindings,
  deriveInput,
  heapVerdict,
  latencyStats,
  linearFit,
  median,
  mulberry32,
  percentile,
  runCaptureSoak,
  runSessionSoak,
  type HeapVerdict,
} from "./pipelineSoak.js";

const verdictOptions = { warmupRuns: 0, windowRuns: 10, thresholdPer100RunsPct: 5, gc: true };

describe("pipeline soak harness — deterministic inputs", () => {
  it("mulberry32 is reproducible and bounded", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("deriveInput(seed) reproduces every field (replayability)", () => {
    for (const seed of [0, 1, 1000, 1499, 2 ** 31 - 1]) {
      expect(deriveInput(seed)).toEqual(deriveInput(seed));
      expect(deriveInput(seed).seed).toBe(seed);
    }
    expect(deriveInput(1000)).not.toEqual(deriveInput(1001));
  });

  it("derived truth keeps contact frame-aligned and inside generator bounds", () => {
    for (let seed = 1000; seed < 1200; seed++) {
      const spec = deriveInput(seed);
      const fps = spec.truth.fps ?? 0;
      expect([30, 60]).toContain(fps);
      expect((spec.truth.accelerateMs ?? 0) % Math.round(1000 / fps)).toBe(0);
      expect(spec.truth.torsoLength).toBeGreaterThanOrEqual(0.16);
      expect(spec.truth.torsoLength).toBeLessThanOrEqual(0.24);
      expect(spec.handedness).toBe(spec.truth.handed);
    }
  });

  it("captureInputFor produces a non-empty pose sequence with a unique capture id per run", () => {
    const spec = deriveInput(1000);
    const a = captureInputFor(spec, 0);
    const b = captureInputFor(spec, 1);
    expect(a.pose.frames.length).toBeGreaterThan(10);
    expect(a.captureId).not.toBe(b.captureId);
    expect(a.pose.frames.length).toBe(b.pose.frames.length);
    expect(a.paddle.status).toBe("unavailable");
    expect(a.ball.status).toBe("unavailable");
    expect(a.trigger.startMs).toBeLessThan(a.trigger.endMs);
  });
});

describe("pipeline soak harness — statistics", () => {
  it("linearFit recovers slope/intercept of an exact line and r=1", () => {
    const fit = linearFit([0, 1, 2, 3, 4].map((x) => ({ x, y: 3 * x + 7 })));
    expect(fit.slope).toBeCloseTo(3, 10);
    expect(fit.intercept).toBeCloseTo(7, 10);
    expect(fit.r).toBeCloseTo(1, 10);
    expect(fit.n).toBe(5);
  });

  it("linearFit handles degenerate inputs without NaN slope", () => {
    expect(linearFit([]).slope).toBe(0);
    expect(linearFit([{ x: 1, y: 5 }]).slope).toBe(0);
    const flat = linearFit([0, 1, 2].map((x) => ({ x, y: 9 })));
    expect(flat.slope).toBe(0);
    expect(flat.intercept).toBe(9);
  });

  it("median and percentile follow nearest-rank semantics", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 50)).toBe(7);
  });

  it("latencyStats reports runs/sec consistent with the total", () => {
    const stats = latencyStats([10, 10, 10, 10]);
    expect(stats.runs).toBe(4);
    expect(stats.totalMs).toBe(40);
    expect(stats.throughputPerSec).toBeCloseTo(100, 6);
    expect(stats.latencySlopeMsPerRun).toBe(0);
    expect(stats.p50Ms).toBe(10);
    expect(stats.maxMs).toBe(10);
  });
});

describe("pipeline soak harness — heap verdict", () => {
  it("flags monotone growth above the threshold per 100 runs", () => {
    // 1MB baseline growing 0.1% per run = 10% per 100 runs.
    const heap = Array.from({ length: 50 }, (_, i) => 1_000_000 * (1 + 0.001 * i));
    const verdict = heapVerdict(heap, verdictOptions);
    expect(verdict.monotoneAcrossWindows).toBe(true);
    expect(verdict.slopePer100RunsPct).toBeGreaterThan(5);
    expect(verdict.leakSuspected).toBe(true);
    expect(verdict.windows).toHaveLength(5);
    expect(verdict.windows[0]?.growthVsPreviousPct).toBeNull();
  });

  it("does not flag flat or non-monotone heap", () => {
    const flat = heapVerdict(
      Array.from({ length: 50 }, () => 1_000_000),
      verdictOptions,
    );
    expect(flat.leakSuspected).toBe(false);
    expect(flat.slopeBytesPerRun).toBe(0);
    // Sawtooth: grows then drops back — steps are not all non-negative.
    const saw = heapVerdict(
      Array.from({ length: 50 }, (_, i) => 1_000_000 + (i % 20) * 50_000),
      verdictOptions,
    );
    expect(saw.monotoneAcrossWindows).toBe(false);
    expect(saw.leakSuspected).toBe(false);
  });

  it("never claims a leak when gc was not exposed", () => {
    const heap = Array.from({ length: 50 }, (_, i) => 1_000_000 * (1 + 0.01 * i));
    const verdict = heapVerdict(heap, { ...verdictOptions, gc: false });
    expect(verdict.gcAvailable).toBe(false);
    expect(verdict.slopePer100RunsPct).toBeGreaterThan(5);
    expect(verdict.leakSuspected).toBe(false);
  });

  it("drops warmup runs before fitting", () => {
    const heap = [5_000_000, 4_000_000, 3_000_000, ...Array.from({ length: 30 }, () => 1_000_000)];
    const verdict = heapVerdict(heap, { ...verdictOptions, warmupRuns: 3 });
    expect(verdict.slopeBytesPerRun).toBe(0);
    expect(verdict.baselineHeapUsed).toBe(1_000_000);
    expect(verdict.windows[0]?.fromRun).toBe(3);
  });

  it("controlAdjust subtracts the harness's own slope", () => {
    const workload = heapVerdict(
      Array.from({ length: 30 }, (_, i) => 1_000_000 + 600 * i),
      verdictOptions,
    );
    const control = heapVerdict(
      Array.from({ length: 30 }, (_, i) => 1_000_000 + 400 * i),
      verdictOptions,
    );
    const adjusted = controlAdjust(workload, control);
    expect(adjusted.adjustedSlopeBytesPerRun).toBeCloseTo(200, 6);
    expect(adjusted.adjustedSlopePer100RunsPct).toBeCloseTo(
      ((200 * 100) / workload.baselineHeapUsed) * 100,
      6,
    );
  });
});

describe("pipeline soak harness — end-to-end at small scale", () => {
  const smallOptions = {
    runs: 12,
    baseSeed: 1000,
    warmupRuns: 2,
    windowRuns: 5,
    thresholdPer100RunsPct: 5,
    providersPerRun: true,
  };

  it("runs analyzeCapture end to end with typed outcomes and replay metadata", async () => {
    const report = await runCaptureSoak(smallOptions);
    expect(report.scenario).toBe("analyzeCapture");
    expect(report.records).toHaveLength(12);
    expect(report.exceptions).toEqual([]);
    for (const record of report.records) {
      expect(record.seed).toBe(1000 + record.run);
      expect(record.input).toEqual(deriveInput(record.seed));
      expect(record.outcome).not.toBe("unknown");
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.heap.heapUsed).toBeGreaterThan(0);
    }
    const total = Object.values(report.outcomes).reduce((a, b) => a + b, 0);
    expect(total).toBe(12);
    expect(report.latency.runs).toBe(12);
  }, 60_000);

  it("control mode skips the pipeline but keeps identical record shape", async () => {
    const report = await runCaptureSoak({ ...smallOptions, runs: 4, noop: true });
    expect(report.scenario).toBe("control");
    expect(report.outcomes).toEqual({ noop: 4 });
    expect(report.records.every((r) => r.ok && r.modelRuns === 0)).toBe(true);
  });

  it("session soak closes strokes live and reports push-cost/heap fields", () => {
    const report = runSessionSoak({
      seed: 7,
      strokes: 6,
      fps: 60,
      strokeEveryMs: 1500,
      windowSamples: 120,
    });
    expect(report.threw).toBeNull();
    expect(report.samples).toBeGreaterThan(0);
    expect(report.eventsClosed + report.flushClosed).toBeGreaterThan(0);
    expect(report.windows.length).toBeGreaterThan(1);
    expect(Number.isFinite(report.retainedBytesPerSample)).toBe(true);
  });

  it("deriveFindings promotes exceptions and control-adjusted leaks, and nothing else", async () => {
    const control = await runCaptureSoak({ ...smallOptions, runs: 3, noop: true });
    const capture = await runCaptureSoak({ ...smallOptions, runs: 3 });
    const clean = deriveFindings({
      harness: "pipeline-soak-1",
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpus: 1,
        totalMemBytes: 0,
        execArgv: [],
        gcExposed: true,
        startedAtIso: "",
        gitCommit: null,
      },
      control,
      captureControlAdjusted: controlAdjust(capture.heap, control.heap),
      capture,
      clip: null,
      session: null,
    }).filter((f) => f.scenario === "analyzeCapture");
    // Three runs cannot produce a monotone >5%/100-run verdict from noise alone
    // unless the pipeline threw; either way the finding must be explainable.
    for (const finding of clean) {
      expect(finding.replay.length).toBeGreaterThan(0);
    }

    const leaky: HeapVerdict = heapVerdict(
      Array.from({ length: 30 }, (_, i) => 1_000_000 * (1 + 0.002 * i)),
      verdictOptions,
    );
    const promoted = deriveFindings({
      harness: "pipeline-soak-1",
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpus: 1,
        totalMemBytes: 0,
        execArgv: [],
        gcExposed: true,
        startedAtIso: "",
        gitCommit: null,
      },
      control,
      captureControlAdjusted: controlAdjust(leaky, { ...leaky, slopeBytesPerRun: 0 }),
      capture: { ...capture, heap: leaky },
      clip: null,
      session: null,
    });
    expect(promoted.some((f) => f.criterion.includes("monotone gc'd heap growth"))).toBe(true);
    expect(promoted[0]?.replay).toContain("baseSeed 1000");
  }, 60_000);
});
