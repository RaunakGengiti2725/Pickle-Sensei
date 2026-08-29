import { describe, expect, it } from "vitest";
import { nearestRankPercentile, summarizeLatencies } from "../src/latencyStats.js";
import { IPHONE_LATENCY_TARGETS, latencyVerdict } from "../src/latencyTargets.js";

describe("nearestRankPercentile", () => {
  it("computes nearest-rank percentiles on a known set", () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(nearestRankPercentile(sorted, 50)).toBe(500);
    expect(nearestRankPercentile(sorted, 75)).toBe(800);
    expect(nearestRankPercentile(sorted, 90)).toBe(900);
    expect(nearestRankPercentile(sorted, 95)).toBe(1000);
  });

  it("is defined for n=1", () => {
    expect(nearestRankPercentile([42], 50)).toBe(42);
    expect(nearestRankPercentile([42], 95)).toBe(42);
  });

  it("rejects empty sets and out-of-range percentiles", () => {
    expect(() => nearestRankPercentile([], 50)).toThrow(/empty/);
    expect(() => nearestRankPercentile([1], 0)).toThrow(/out of/);
  });
});

describe("summarizeLatencies", () => {
  it("returns null for zero samples (absence, not zeros)", () => {
    expect(summarizeLatencies([])).toBeNull();
  });

  it("summarizes with P50/P75/P90/P95 and sampleCount", () => {
    const summary = summarizeLatencies([3000, 1000, 2000, 4000]);
    expect(summary).toMatchObject({
      sampleCount: 4,
      minMs: 1000,
      maxMs: 4000,
      meanMs: 2500,
      p50Ms: 2000,
      p75Ms: 3000,
      p90Ms: 4000,
      p95Ms: 4000,
    });
  });

  it("rejects negative or non-finite samples", () => {
    expect(() => summarizeLatencies([-1])).toThrow(/invalid sample/);
    expect(() => summarizeLatencies([Number.NaN])).toThrow(/invalid sample/);
  });
});

describe("frozen iphone latency targets", () => {
  it("are frozen at 2000/3000/5000 judged at p95", () => {
    expect(IPHONE_LATENCY_TARGETS).toEqual({
      version: "iphone-latency-targets-v1",
      metric: "TRUE_MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE",
      judgedPercentile: "p95",
      idealMs: 2000,
      strongMs: 3000,
      maxMs: 5000,
    });
  });

  it("maps latencies to verdict bands with inclusive boundaries", () => {
    expect(latencyVerdict(1999)).toBe("IDEAL");
    expect(latencyVerdict(2000)).toBe("IDEAL");
    expect(latencyVerdict(2001)).toBe("STRONG");
    expect(latencyVerdict(3000)).toBe("STRONG");
    expect(latencyVerdict(4999)).toBe("MAX");
    expect(latencyVerdict(5000)).toBe("MAX");
    expect(latencyVerdict(5001)).toBe("FAIL");
  });

  it("rejects invalid judged values", () => {
    expect(() => latencyVerdict(-1)).toThrow(/invalid/);
    expect(() => latencyVerdict(Number.NaN)).toThrow(/invalid/);
  });
});
