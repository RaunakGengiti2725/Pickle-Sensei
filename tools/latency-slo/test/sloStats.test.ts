import { describe, expect, it } from "vitest";

import { nearestRankPercentile, summarizeLatencies } from "../src/sloStats.js";

describe("nearestRankPercentile", () => {
  it("matches the nearest-rank definition on a known set", () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(nearestRankPercentile(sorted, 50)).toBe(500);
    expect(nearestRankPercentile(sorted, 75)).toBe(800);
    expect(nearestRankPercentile(sorted, 90)).toBe(900);
    expect(nearestRankPercentile(sorted, 95)).toBe(1000);
  });

  it("is defined for n = 1", () => {
    expect(nearestRankPercentile([42], 50)).toBe(42);
    expect(nearestRankPercentile([42], 95)).toBe(42);
  });

  it("rejects empty sets and out-of-range percentiles", () => {
    expect(() => nearestRankPercentile([], 50)).toThrow(/empty/);
    expect(() => nearestRankPercentile([1], 0)).toThrow(/out of/);
    expect(() => nearestRankPercentile([1], 101)).toThrow(/out of/);
  });
});

describe("summarizeLatencies", () => {
  it("returns null for empty input", () => {
    expect(summarizeLatencies([])).toBeNull();
  });

  it("summarizes with P50/P75/P90/P95 and carries sampleCount", () => {
    const summary = summarizeLatencies([300, 100, 200, 500, 400]);
    expect(summary).not.toBeNull();
    expect(summary?.sampleCount).toBe(5);
    expect(summary?.minMs).toBe(100);
    expect(summary?.maxMs).toBe(500);
    expect(summary?.meanMs).toBe(300);
    expect(summary?.p50Ms).toBe(300);
    expect(summary?.p75Ms).toBe(400);
    expect(summary?.p90Ms).toBe(500);
    expect(summary?.p95Ms).toBe(500);
  });

  it("rejects negative and non-finite samples", () => {
    expect(() => summarizeLatencies([100, -1])).toThrow(/invalid sample/);
    expect(() => summarizeLatencies([Number.NaN])).toThrow(/invalid sample/);
  });
});
