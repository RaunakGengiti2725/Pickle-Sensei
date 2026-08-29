import { describe, expect, it } from "vitest";
import {
  nearestRankPercentile,
  summarizeLatencies,
  summarizeStages,
  type StageSample,
} from "../src/latencyStats.js";

describe("nearestRankPercentile", () => {
  it("computes nearest-rank percentiles on a known set", () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(nearestRankPercentile(sorted, 50)).toBe(500);
    expect(nearestRankPercentile(sorted, 90)).toBe(900);
    expect(nearestRankPercentile(sorted, 95)).toBe(1000);
    expect(nearestRankPercentile(sorted, 100)).toBe(1000);
  });

  it("is defined for n=1 (all percentiles = the sample)", () => {
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
  it("returns null for no samples (absence is honest, never zeros)", () => {
    expect(summarizeLatencies([])).toBeNull();
  });

  it("summarizes min/max/mean and percentiles", () => {
    const summary = summarizeLatencies([300, 100, 200]);
    expect(summary).toEqual({
      sampleCount: 3,
      minMs: 100,
      maxMs: 300,
      meanMs: 200,
      p50Ms: 200,
      p90Ms: 300,
      p95Ms: 300,
    });
  });

  it("rejects negative or non-finite samples", () => {
    expect(() => summarizeLatencies([-1])).toThrow(/invalid/);
    expect(() => summarizeLatencies([Number.NaN])).toThrow(/invalid/);
  });
});

describe("summarizeStages", () => {
  const samples: StageSample[] = [
    { stage: "e2e", caseId: "a", phase: "cold", iteration: 1, wallMs: 50000 },
    { stage: "e2e", caseId: "a", phase: "warm", iteration: 1, wallMs: 17000 },
    { stage: "e2e", caseId: "a", phase: "warm", iteration: 2, wallMs: 18000 },
    { stage: "paddleDetect", caseId: "a", phase: "warm", iteration: 1, wallMs: 6000 },
  ];

  it("groups by stage with separate cold/warm summaries", () => {
    const stages = summarizeStages(samples);
    expect(stages.map((stage) => stage.stage)).toEqual(["e2e", "paddleDetect"]);
    expect(stages[0]?.cold?.sampleCount).toBe(1);
    expect(stages[0]?.warm?.sampleCount).toBe(2);
    expect(stages[0]?.warm?.p50Ms).toBe(17000);
    expect(stages[1]?.cold).toBeNull();
    expect(stages[1]?.warm?.p50Ms).toBe(6000);
  });

  it("keeps raw samples verbatim for auditability", () => {
    const stages = summarizeStages(samples);
    expect(stages[0]?.samples).toHaveLength(3);
    expect(stages[0]?.samples[0]).toEqual(samples[0]);
  });
});
