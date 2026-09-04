/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  ApiSloRecorder,
  DEFAULT_API_SLO_TARGETS,
  DEFAULT_QUEUE_SLO_CONFIG,
  LatencyWindow,
  QueueSloMonitor,
  evaluateApiSlos,
} from "../src/index.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function nearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

describe("audit: latency bookkeeping", () => {
  it.fails(
    "FINDING: requests with NaN/negative latency are counted as requests but their latency is silently dropped",
    () => {
      const rec = new ApiSloRecorder();
      for (let i = 0; i < 200; i++)
        rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: NaN });
      const snap = rec.snapshot();
      // 200 requests observed; a timer bug producing NaN must not present as
      // "no latency samples" (indistinguishable from an idle API).
      const p95 = evaluateApiSlos(snap).find((e) => e.slo === "api_latency_p95")!;
      expect(snap.requestCount).toBe(200);
      expect(p95.reason).not.toBe("no latency samples");
    },
  );

  it("evidence: 200 NaN-latency requests → requestCount 200, latency.count 0, reason 'no latency samples'", () => {
    const rec = new ApiSloRecorder();
    for (let i = 0; i < 200; i++)
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: -1 });
    const snap = rec.snapshot();
    expect(snap.requestCount).toBe(200);
    expect(snap.latency.sampleCount).toBe(0);
    const p95 = evaluateApiSlos(snap).find((e) => e.slo === "api_latency_p95")!;
    expect(p95.status).toBe("not_evaluable");
    expect(p95.reason).toBe("no latency samples");
  });

  it.fails(
    "FINDING: latency SLOs breach on a single sample while rate SLOs require minRequestSamples",
    () => {
      const rec = new ApiSloRecorder();
      rec.recordRequest({ route: "/v1/x", statusCode: 200, latencyMs: 2001 });
      const evals = evaluateApiSlos(rec.snapshot());
      expect(evals.find((e) => e.slo === "api_availability")!.status).toBe("not_evaluable");
      expect(evals.find((e) => e.slo === "api_latency_p99")!.status).toBe("not_evaluable");
    },
  );

  it("fuzz: LatencyWindow percentiles equal brute-force nearest-rank over the retained ring", () => {
    const rand = lcg(11);
    for (let run = 0; run < 200; run++) {
      const capacity = 1 + Math.floor(rand() * 50);
      const n = Math.floor(rand() * 150);
      const window = new LatencyWindow(capacity);
      const all: number[] = [];
      for (let i = 0; i < n; i++) {
        const v = Math.floor(rand() * 5000);
        window.record(v);
        all.push(v);
      }
      const retained = all.slice(-capacity).sort((a, b) => a - b);
      expect(window.count()).toBe(retained.length);
      for (const p of [1, 50, 95, 99, 100]) {
        expect(window.percentile(p)).toBe(retained.length === 0 ? null : nearestRank(retained, p));
      }
    }
  });

  it("holds: percentile rejects p outside (0,100], capacity < 1 rejected", () => {
    const w = new LatencyWindow(3);
    w.record(1);
    expect(() => w.percentile(0)).toThrow();
    expect(() => w.percentile(101)).toThrow();
    expect(() => new LatencyWindow(0)).toThrow();
  });

  it("holds: 5xx accounting, media route attribution, and pool saturation arithmetic", () => {
    const rec = new ApiSloRecorder();
    for (let i = 0; i < 100; i++)
      rec.recordRequest({ route: "/v1/other", statusCode: 200, latencyMs: 10 });
    rec.recordRequest({ route: "/v1/media/upload", statusCode: 503, latencyMs: 10 });
    rec.recordRequest({ route: "/v1/mediafoo", statusCode: 500, latencyMs: 10 });
    rec.recordRequest({ route: "/v1/x", statusCode: 499, latencyMs: 10 });
    rec.recordPoolSample({ totalCount: 10, idleCount: 2, waitingCount: 4, maxSize: 10 });
    const snap = rec.snapshot();
    expect(snap.requestCount).toBe(103);
    expect(snap.fiveXxCount).toBe(2);
    expect(snap.mediaFiveXxCount).toBe(2);
    expect(snap.poolSaturation).toBeCloseTo(1.2);
    const evals = evaluateApiSlos(snap, DEFAULT_API_SLO_TARGETS);
    expect(evals.find((e) => e.slo === "api_5xx_rate")!.status).toBe("breached");
    expect(evals.find((e) => e.slo === "pool_saturation")!.status).toBe("breached");
    expect(evals.find((e) => e.slo === "db_latency_p95")!.status).toBe("not_evaluable");
    rec.recordPoolSample({ totalCount: 10, idleCount: 2, waitingCount: 0, maxSize: null });
    expect(rec.snapshot().poolSaturation).toBeNull();
    rec.recordPoolSample({ totalCount: 10, idleCount: 2, waitingCount: 0, maxSize: 0 });
    expect(rec.snapshot().poolSaturation).toBeNull();
  });
});

describe("audit: QueueSloMonitor", () => {
  it("holds: alerts on the Nth idle cycle, repeats while stalled, resets on progress", () => {
    const mon = new QueueSloMonitor({ ...DEFAULT_QUEUE_SLO_CONFIG, stalledAfterIdleCycles: 3 });
    const idle = { depth: 5, oldestJobAgeMs: 1000, jobsHandled: 0, jobsSeen: 5 };
    expect(mon.observe(idle)).toBeNull();
    expect(mon.observe(idle)).toBeNull();
    expect(mon.observe(idle)?.reason).toBe("no_progress");
    expect(mon.observe(idle)?.consecutiveIdleCycles).toBe(4);
    expect(mon.observe({ ...idle, jobsHandled: 1 })).toBeNull();
    expect(mon.consecutiveIdleCycles()).toBe(0);
  });

  it("holds: oldest-job age fires immediately and takes precedence; null disables it", () => {
    const mon = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 3,
      maxOldestJobAgeMs: 100,
    });
    const alert = mon.observe({ depth: 1, oldestJobAgeMs: 101, jobsHandled: 5, jobsSeen: 5 });
    expect(alert?.reason).toBe("oldest_job_age_exceeded");
    const off = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 3,
      maxOldestJobAgeMs: null,
    });
    expect(off.observe({ depth: 1, oldestJobAgeMs: 1e12, jobsHandled: 5, jobsSeen: 5 })).toBeNull();
  });

  it("observed: a backend that reports neither depth (-1) nor age (null) with no visible jobs never alerts (blind, not a finding — depth -1 is emitted via queue_backlog by the worker)", () => {
    const mon = new QueueSloMonitor();
    for (let i = 0; i < 100; i++) {
      expect(
        mon.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 0 }),
      ).toBeNull();
    }
  });

  it("holds: depth -1 with visible-but-unhandled jobs still counts as idle", () => {
    const mon = new QueueSloMonitor({
      queue: "q",
      stalledAfterIdleCycles: 1,
      maxOldestJobAgeMs: null,
    });
    expect(
      mon.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 2 })?.reason,
    ).toBe("no_progress");
  });
});
