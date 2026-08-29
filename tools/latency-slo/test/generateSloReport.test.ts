import { describe, expect, it } from "vitest";

import {
  LINUX_NOT_DEVICE_DISCLAIMER,
  generateSloReport,
  sliceKeyFor,
} from "../src/generateSloReport.js";
import type { LatencySloRecord } from "../src/sloRecord.js";
import { makeRecord } from "./helpers.js";

function warmRecord(overrides: Partial<LatencySloRecord["slice"]>, wallMs: number) {
  const base = makeRecord({ wallMs });
  return { ...base, slice: { ...base.slice, ...overrides } };
}

describe("generateSloReport", () => {
  it("slices by every dimension plus phase and judges p95 tiers", () => {
    const records = [
      warmRecord({ stroke: "volley", phase: "warm" }, 1500),
      warmRecord({ stroke: "volley", phase: "warm" }, 1800),
      warmRecord({ stroke: "rally-mixed", phase: "warm" }, 4200),
      warmRecord({ stroke: "volley", phase: "cold" }, 6000),
    ];
    const report = generateSloReport(records, { generatedAtIso: "2026-08-29T12:00:00Z" });

    expect(report.schemaVersion).toBe("pickle.latency-slo-report.v1");
    expect(report.recordCounts).toEqual({ LINUX_BENCH_NOT_DEVICE: 4, DEVICE_MEASUREMENT: 0 });
    expect(report.deviceEvidence).toBe("BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS");
    expect(report.linuxNotDeviceDisclaimer).toBe(LINUX_NOT_DEVICE_DISCLAIMER);

    const byKey = new Map(report.slices.map((slice) => [slice.sliceKey, slice]));
    const overallWarm = byKey.get(sliceKeyFor("overall", null, "warm"));
    expect(overallWarm?.summary.sampleCount).toBe(3);
    expect(overallWarm?.summary.p95Ms).toBe(4200);
    expect(overallWarm?.tier).toBe("MAX");

    const volleyWarm = byKey.get(sliceKeyFor("stroke", "volley", "warm"));
    expect(volleyWarm?.summary.sampleCount).toBe(2);
    expect(volleyWarm?.tier).toBe("IDEAL");

    const rallyWarm = byKey.get(sliceKeyFor("stroke", "rally-mixed", "warm"));
    expect(rallyWarm?.tier).toBe("MAX");

    const volleyCold = byKey.get(sliceKeyFor("stroke", "volley", "cold"));
    expect(volleyCold?.tier).toBe("FAIL");

    const deviceWarm = byKey.get(sliceKeyFor("device", "linux-x86_64", "warm"));
    expect(deviceWarm?.summary.sampleCount).toBe(3);
    expect(byKey.has(sliceKeyFor("os", records[0]!.slice.os, "warm"))).toBe(true);
    expect(byKey.has(sliceKeyFor("modelVersion", records[0]!.slice.modelVersion, "warm"))).toBe(
      true,
    );
    expect(byKey.has(sliceKeyFor("captureCondition", "UNLABELED_COMMITTED_DEV_CLIP", "warm"))).toBe(
      true,
    );
  });

  it("keeps cold and warm strictly separate", () => {
    const report = generateSloReport([
      warmRecord({ phase: "cold" }, 9000),
      warmRecord({ phase: "warm" }, 1000),
    ]);
    const byKey = new Map(report.slices.map((slice) => [slice.sliceKey, slice]));
    expect(byKey.get(sliceKeyFor("overall", null, "cold"))?.summary.p95Ms).toBe(9000);
    expect(byKey.get(sliceKeyFor("overall", null, "warm"))?.summary.p95Ms).toBe(1000);
  });

  it("has no disclaimer and DEVICE_TRIALS_PRESENT for pure device evidence", () => {
    const report = generateSloReport([makeRecord({ provenance: "DEVICE_MEASUREMENT" })]);
    expect(report.deviceEvidence).toBe("DEVICE_TRIALS_PRESENT");
    expect(report.linuxNotDeviceDisclaimer).toBeNull();
  });

  it("throws loudly on invalid records", () => {
    expect(() => generateSloReport([{ ...makeRecord(), wallMs: -5 }])).toThrow(/invalid record/);
  });

  it("produces an empty slice list for zero records", () => {
    const report = generateSloReport([]);
    expect(report.slices).toEqual([]);
    expect(report.deviceEvidence).toBe("BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS");
    expect(report.linuxNotDeviceDisclaimer).toBeNull();
  });
});
