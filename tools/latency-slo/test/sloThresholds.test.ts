import { describe, expect, it } from "vitest";

import {
  LATENCY_SLO_ALERT_CONFIG,
  LATENCY_SLO_THRESHOLDS,
  isTierDegradation,
  sloTier,
} from "../src/sloThresholds.js";

describe("frozen thresholds", () => {
  it("v1 numbers are frozen at 2000/3000/5000 judged at p95", () => {
    expect(LATENCY_SLO_THRESHOLDS).toEqual({
      version: "latency-slo-thresholds-v1",
      metric: "MOVEMENT_COMPLETION_TO_RESULT_INTERACTIVE",
      judgedPercentile: "p95",
      idealMs: 2000,
      strongMs: 3000,
      maxMs: 5000,
    });
  });

  it("v1 alert config is frozen", () => {
    expect(LATENCY_SLO_ALERT_CONFIG).toEqual({
      version: "latency-slo-regression-alerts-v1",
      p95RegressionPct: 10,
      p95RegressionAbsMs: 200,
      minSamplesForAlert: 5,
    });
  });
});

describe("sloTier", () => {
  it("maps values to tiers with inclusive boundaries", () => {
    expect(sloTier(0)).toBe("IDEAL");
    expect(sloTier(2000)).toBe("IDEAL");
    expect(sloTier(2000.1)).toBe("STRONG");
    expect(sloTier(3000)).toBe("STRONG");
    expect(sloTier(3000.1)).toBe("MAX");
    expect(sloTier(5000)).toBe("MAX");
    expect(sloTier(5000.1)).toBe("FAIL");
  });

  it("rejects invalid values", () => {
    expect(() => sloTier(-1)).toThrow(/invalid/);
    expect(() => sloTier(Number.NaN)).toThrow(/invalid/);
  });
});

describe("isTierDegradation", () => {
  it("only flags strictly worse tiers", () => {
    expect(isTierDegradation("IDEAL", "STRONG")).toBe(true);
    expect(isTierDegradation("STRONG", "FAIL")).toBe(true);
    expect(isTierDegradation("STRONG", "STRONG")).toBe(false);
    expect(isTierDegradation("MAX", "IDEAL")).toBe(false);
  });
});
