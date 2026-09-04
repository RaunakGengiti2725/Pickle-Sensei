import { describe, expect, it } from "vitest";
import { ApiSloRecorder, LatencyWindow, QueueSloMonitor, evaluateApiSlos } from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). Contract (slo/src/index.ts):
 * percentile p must be in (0, 100] (throws otherwise); a metric that cannot
 * be measured is `not_evaluable`, never a fabricated pass.
 */

describe("audit: LatencyWindow.percentile argument validation", () => {
  it("rejects a NaN percentile instead of returning a bogus null", () => {
    const window = new LatencyWindow(10);
    window.record(5);
    expect(() => window.percentile(Number.NaN)).toThrow();
  });

  it("nearest-rank p100 is the max and p1 is the min", () => {
    const window = new LatencyWindow(10);
    for (const v of [30, 10, 20]) window.record(v);
    expect(window.percentile(100)).toBe(30);
    expect(window.percentile(1)).toBe(10);
  });

  it("count() never exceeds capacity after wraparound", () => {
    const window = new LatencyWindow(3);
    for (let i = 0; i < 10; i += 1) window.record(i);
    expect(window.count()).toBe(3);
    expect(window.percentile(100)).toBe(9);
  });
});

describe("audit: rate SLOs under the sample floor", () => {
  it("100% 5xx on 99 requests is still not_evaluable (floor is honest both ways)", () => {
    const recorder = new ApiSloRecorder();
    for (let i = 0; i < 99; i += 1) {
      recorder.recordRequest({ route: "/v1/x", statusCode: 500, latencyMs: 10 });
    }
    const evals = evaluateApiSlos(recorder.snapshot());
    expect(evals.find((e) => e.slo === "api_5xx_rate")?.status).toBe("not_evaluable");
    expect(evals.find((e) => e.slo === "api_availability")?.status).toBe("not_evaluable");
  });
});

describe("audit: QueueSloMonitor with depth unknown (-1)", () => {
  it("visible-but-unhandled work still trips the no_progress stall when depth is unreported", () => {
    const monitor = new QueueSloMonitor({
      queue: "audit",
      stalledAfterIdleCycles: 2,
      maxOldestJobAgeMs: null,
    });
    monitor.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 });
    const alert = monitor.observe({ depth: -1, oldestJobAgeMs: null, jobsHandled: 0, jobsSeen: 1 });
    expect(alert?.reason).toBe("no_progress");
  });
});
