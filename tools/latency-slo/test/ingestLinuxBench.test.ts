import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateSloReport } from "../src/generateSloReport.js";
import { ingestLinuxBenchResults } from "../src/ingestLinuxBench.js";
import { validateLatencySloRecord } from "../src/sloRecord.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "linux-bench-results.json");
const REAL_ARTIFACT_PATH = join(
  HERE,
  "..",
  "..",
  "latency-bench",
  "artifacts",
  "bench-results.json",
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
}

describe("ingestLinuxBenchResults", () => {
  it("converts runs into valid LINUX_BENCH_NOT_DEVICE records", () => {
    const { records, skippedNonZeroExit } = ingestLinuxBenchResults(loadFixture(), "fixture.json");
    expect(records.length).toBe(4);
    expect(skippedNonZeroExit).toBe(1);
    for (const record of records) {
      expect(validateLatencySloRecord(record)).toEqual([]);
      expect(record.provenance).toBe("LINUX_BENCH_NOT_DEVICE");
      expect(record.slice.device).toBe("linux-x86_64");
      expect(record.slice.captureCondition).toBe("UNLABELED_COMMITTED_DEV_CLIP");
    }
  });

  it("maps warm-up runs to cold and reps to warm", () => {
    const { records } = ingestLinuxBenchResults(loadFixture(), "fixture.json");
    const cold = records.filter((record) => record.slice.phase === "cold");
    const warm = records.filter((record) => record.slice.phase === "warm");
    expect(cold.length).toBe(1);
    expect(warm.length).toBe(3);
  });

  it("labels strokes from the frozen clip map and never guesses unknown clips", () => {
    const { records } = ingestLinuxBenchResults(loadFixture(), "fixture.json");
    const strokes = new Set(records.map((record) => record.slice.stroke));
    expect(strokes.has("volley")).toBe(true);
    expect(strokes.has("UNLABELED_CLIP")).toBe(true);
  });

  it("slices model versions apart by arm and commit", () => {
    const { records } = ingestLinuxBenchResults(loadFixture(), "fixture.json");
    const versions = new Set(records.map((record) => record.slice.modelVersion));
    expect(versions.has("baseline-pre-integration@aaaaaaaaaaaa")).toBe(true);
    expect(versions.has("integrated-default@bbbbbbbbbbbb")).toBe(true);
  });

  it("refuses non-Linux hosts instead of mislabeling", () => {
    const fixture = loadFixture() as { host: { platform: string } };
    fixture.host.platform = "macOS-14.5-arm64";
    expect(() => ingestLinuxBenchResults(fixture, "fixture.json")).toThrow(/not Linux/);
  });

  it("throws on malformed documents", () => {
    expect(() => ingestLinuxBenchResults(null, "f")).toThrow(/expected object/);
    expect(() => ingestLinuxBenchResults({ host: { platform: "Linux-x" } }, "f")).toThrow(
      /machine/,
    );
  });

  it("ingests the real committed bench artifact end-to-end", () => {
    const document = JSON.parse(readFileSync(REAL_ARTIFACT_PATH, "utf8")) as unknown;
    const { records } = ingestLinuxBenchResults(
      document,
      "tools/latency-bench/artifacts/bench-results.json",
    );
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(validateLatencySloRecord(record)).toEqual([]);
    }
    const report = generateSloReport(records);
    expect(report.deviceEvidence).toBe("BLOCKED_EXTERNAL_NO_DEVICE_MEASUREMENTS");
    expect(report.linuxNotDeviceDisclaimer).not.toBeNull();
    expect(report.slices.length).toBeGreaterThan(0);
  });
});
