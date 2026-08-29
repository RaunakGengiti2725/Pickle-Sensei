import { describe, expect, it } from "vitest";
import { generateTrialReport } from "../src/generateReport.js";
import type { IphoneTrialV1 } from "../src/trialSchema.js";
import { loadCommittedMatrix } from "./deviceMatrix.test.js";
import { loadSampleTrial } from "./trialSchema.test.js";

const AT = "2026-08-29T12:00:00.000Z";

function deviceTrial(overrides: {
  trialId: string;
  runKind: "cold" | "warm";
  latencyMs: number;
  matrixDeviceId?: string;
  tier?: IphoneTrialV1["device"]["tier"];
}): IphoneTrialV1 {
  const trial = JSON.parse(JSON.stringify(loadSampleTrial())) as IphoneTrialV1;
  trial.trialId = overrides.trialId;
  trial.provenance = "DEVICE_MEASUREMENT";
  if (overrides.matrixDeviceId !== undefined) {
    trial.device.matrixDeviceId = overrides.matrixDeviceId;
  }
  if (overrides.tier !== undefined) {
    trial.device.tier = overrides.tier;
  }
  trial.metrics.analysisLatency.primary = {
    measured: true,
    value: {
      runKind: overrides.runKind,
      trueMovementCompletionAtMs: 1000,
      resultInteractiveAtMs: 1000 + overrides.latencyMs,
      latencyMs: overrides.latencyMs,
      markerSource: "HUMAN_FRAME_MARKED_REFERENCE_RECORDING",
    },
  };
  return trial;
}

describe("generateTrialReport", () => {
  it("produces an honest BLOCKED_EXTERNAL report over an empty trials directory", () => {
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles: [],
      generatedAtIso: AT,
    });
    expect(report.verdict).toBe("BLOCKED_EXTERNAL_NO_DEVICE_TRIALS");
    expect(report.totals).toEqual({
      filesRead: 0,
      deviceMeasurementTrials: 0,
      sampleFixtureTrials: 0,
      invalidFiles: 0,
    });
    expect(report.primaryLatency.cold.summary).toBeNull();
    expect(report.primaryLatency.cold.unmeasuredReason).toMatch(/BLOCKED_EXTERNAL/);
    expect(report.primaryLatency.cold.verdict).toBeNull();
    expect(report.primaryLatency.warm.summary).toBeNull();
    expect(report.tierCoverage.every((t) => !t.covered)).toBe(true);
    expect(report.notes.join("\n")).toMatch(/No physical-iPhone evidence/);
  });

  it("excludes SAMPLE_FIXTURE trials from every statistic and keeps BLOCKED_EXTERNAL", () => {
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "sample-trial.json", data: loadSampleTrial() }],
      generatedAtIso: AT,
    });
    expect(report.verdict).toBe("BLOCKED_EXTERNAL_NO_DEVICE_TRIALS");
    expect(report.totals.sampleFixtureTrials).toBe(1);
    expect(report.totals.deviceMeasurementTrials).toBe(0);
    expect(report.sampleFixtureFiles).toEqual(["sample-trial.json"]);
    expect(report.primaryLatency.cold.summary).toBeNull();
    expect(report.metricCoverage).toEqual([]);
    expect(report.notes.join("\n")).toMatch(/EXCLUDED from every statistic/);
  });

  it("aggregates DEVICE_MEASUREMENT trials into cold/warm percentiles judged against the frozen targets", () => {
    const trialFiles = [
      { fileName: "a.json", data: deviceTrial({ trialId: "a", runKind: "cold", latencyMs: 1800 }) },
      { fileName: "b.json", data: deviceTrial({ trialId: "b", runKind: "cold", latencyMs: 2600 }) },
      { fileName: "c.json", data: deviceTrial({ trialId: "c", runKind: "warm", latencyMs: 1200 }) },
      { fileName: "d.json", data: deviceTrial({ trialId: "d", runKind: "warm", latencyMs: 1400 }) },
    ];
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles,
      generatedAtIso: AT,
    });
    expect(report.totals.deviceMeasurementTrials).toBe(4);
    expect(report.verdict).toBe("PARTIAL_MATRIX_COVERAGE");
    expect(report.primaryLatency.cold.summary).toMatchObject({
      sampleCount: 2,
      p50Ms: 1800,
      p95Ms: 2600,
    });
    expect(report.primaryLatency.cold.verdict).toBe("STRONG");
    expect(report.primaryLatency.warm.summary).toMatchObject({
      sampleCount: 2,
      p95Ms: 1400,
    });
    expect(report.primaryLatency.warm.verdict).toBe("IDEAL");
    const midTier = report.tierCoverage.find((t) => t.tier === "mid");
    expect(midTier?.covered).toBe(true);
    expect(midTier?.measuredTrialCount).toBe(4);
    const launchRow = report.metricCoverage.find(
      (row) => row.metric === "appLaunchToInteractiveMs",
    );
    expect(launchRow).toMatchObject({ measuredCount: 4, unmeasuredCount: 0 });
    const thermalRow = report.metricCoverage.find(
      (row) => row.metric === "stability.timeToThermalSeriousMs",
    );
    expect(thermalRow?.unmeasuredCount).toBe(4);
    expect(thermalRow?.unmeasuredReasons.length).toBeGreaterThan(0);
  });

  it("reports FULL_MATRIX_COVERAGE only when every tier has enough measured trials", () => {
    const trialFiles = [
      {
        fileName: "older.json",
        data: deviceTrial({
          trialId: "older",
          runKind: "cold",
          latencyMs: 5200,
          matrixDeviceId: "iphone-se-3",
          tier: "older",
        }),
      },
      {
        fileName: "mid.json",
        data: deviceTrial({ trialId: "mid", runKind: "cold", latencyMs: 3400 }),
      },
      {
        fileName: "recent.json",
        data: deviceTrial({
          trialId: "recent",
          runKind: "warm",
          latencyMs: 2100,
          matrixDeviceId: "iphone-15",
          tier: "recent",
        }),
      },
      {
        fileName: "flagship.json",
        data: deviceTrial({
          trialId: "flagship",
          runKind: "warm",
          latencyMs: 1600,
          matrixDeviceId: "iphone-16-pro",
          tier: "flagship",
        }),
      },
    ];
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles,
      generatedAtIso: AT,
    });
    expect(report.verdict).toBe("FULL_MATRIX_COVERAGE");
    expect(report.primaryLatency.cold.verdict).toBe("FAIL");
    expect(report.primaryLatency.warm.verdict).toBe("STRONG");
  });

  it("lists invalid files loudly instead of skipping them", () => {
    const broken = JSON.parse(JSON.stringify(loadSampleTrial())) as Record<string, unknown>;
    delete broken["provenance"];
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "broken.json", data: broken }],
      generatedAtIso: AT,
    });
    expect(report.totals.invalidFiles).toBe(1);
    expect(report.invalidFiles[0]?.fileName).toBe("broken.json");
    expect(report.invalidFiles[0]?.errors.join("\n")).toMatch(/provenance/);
  });

  it("rejects trials referencing devices not in the manifest", () => {
    const trial = deviceTrial({ trialId: "x", runKind: "cold", latencyMs: 1000 });
    trial.device.matrixDeviceId = "iphone-99-ultra";
    const report = generateTrialReport({
      matrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "x.json", data: trial }],
      generatedAtIso: AT,
    });
    expect(report.totals.invalidFiles).toBe(1);
    expect(report.invalidFiles[0]?.errors.join("\n")).toMatch(/not in device-matrix\.json/);
  });

  it("throws on an invalid device matrix", () => {
    expect(() => generateTrialReport({ matrix: {}, trialFiles: [], generatedAtIso: AT })).toThrow(
      /invalid device matrix/,
    );
  });
});
