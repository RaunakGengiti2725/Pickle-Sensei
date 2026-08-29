import { describe, expect, it } from "vitest";

import { generateSloReport } from "../src/generateSloReport.js";
import { compareSloReports } from "../src/regressionAlerts.js";
import type { LatencySloRecord } from "../src/sloRecord.js";
import { makeRecord } from "./helpers.js";

function records(stroke: string, phase: "cold" | "warm", wallMs: number[]): LatencySloRecord[] {
  return wallMs.map((value) => {
    const base = makeRecord({ wallMs: value });
    return { ...base, slice: { ...base.slice, stroke, phase } };
  });
}

const CALM = [1000, 1100, 1200, 1300, 1400];

describe("compareSloReports", () => {
  it("reports no alerts when nothing changed", () => {
    const baseline = generateSloReport(records("volley", "warm", CALM));
    const current = generateSloReport(records("volley", "warm", CALM));
    const comparison = compareSloReports(baseline, current);
    expect(comparison.alerts).toEqual([]);
    expect(comparison.cleanSliceKeys.length).toBeGreaterThan(0);
  });

  it("ignores regressions below the frozen floors", () => {
    const baseline = generateSloReport(records("volley", "warm", [2400, 2450, 2500, 2550, 2600]));
    // +150ms on p95: above 0ms but below the 200ms absolute floor.
    const current = generateSloReport(records("volley", "warm", [2500, 2550, 2650, 2700, 2750]));
    const comparison = compareSloReports(baseline, current);
    expect(comparison.alerts.filter((alert) => alert.kind === "P95_REGRESSION")).toEqual([]);
  });

  it("alerts on p95 regressions exceeding both frozen floors", () => {
    const baseline = generateSloReport(records("volley", "warm", [1000, 1050, 1100, 1150, 1200]));
    const current = generateSloReport(records("volley", "warm", [1400, 1450, 1500, 1550, 1600]));
    const comparison = compareSloReports(baseline, current);
    const regressions = comparison.alerts.filter((alert) => alert.kind === "P95_REGRESSION");
    expect(regressions.length).toBeGreaterThan(0);
    expect(regressions.every((alert) => alert.severity === "ALERT")).toBe(true);
  });

  it("alerts on tier degradation even without a large p95 delta", () => {
    const baseline = generateSloReport(records("volley", "warm", [1900, 1920, 1940, 1960, 1990]));
    const current = generateSloReport(records("volley", "warm", [1950, 1990, 2010, 2030, 2050]));
    const comparison = compareSloReports(baseline, current);
    const degradations = comparison.alerts.filter((alert) => alert.kind === "TIER_DEGRADED");
    expect(degradations.length).toBeGreaterThan(0);
    expect(degradations[0]?.detail).toContain("IDEAL -> STRONG");
  });

  it("alerts when a slice exceeds the frozen max (FAIL tier)", () => {
    const baseline = generateSloReport(records("volley", "warm", CALM));
    const current = generateSloReport(records("volley", "warm", [5200, 5300, 5400, 5500, 5600]));
    const comparison = compareSloReports(baseline, current);
    const fails = comparison.alerts.filter((alert) => alert.kind === "MAX_THRESHOLD_EXCEEDED");
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0]?.detail).toContain("5000");
  });

  it("downgrades small-sample findings to WARNING", () => {
    const baseline = generateSloReport(records("volley", "warm", [1000, 1100]));
    const current = generateSloReport(records("volley", "warm", [6000, 6100]));
    const comparison = compareSloReports(baseline, current);
    expect(comparison.alerts.length).toBeGreaterThan(0);
    expect(comparison.alerts.every((alert) => alert.severity === "WARNING")).toBe(true);
    expect(comparison.alerts[0]?.detail).toContain("LOW_SAMPLE");
  });

  it("flags disappeared slices instead of staying silent", () => {
    const baseline = generateSloReport([
      ...records("volley", "warm", CALM),
      ...records("rally-mixed", "warm", CALM),
    ]);
    const current = generateSloReport(records("volley", "warm", CALM));
    const comparison = compareSloReports(baseline, current);
    const disappeared = comparison.alerts.filter((alert) => alert.kind === "SLICE_DISAPPEARED");
    expect(disappeared.length).toBe(1);
    expect(disappeared[0]?.sliceKey).toBe("stroke=rally-mixed|phase=warm");
  });
});
