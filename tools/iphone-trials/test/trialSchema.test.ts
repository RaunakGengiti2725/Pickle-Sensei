import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateIphoneTrial, type IphoneTrialV1 } from "../src/trialSchema.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadSampleTrial(): IphoneTrialV1 {
  return JSON.parse(readFileSync(join(fixturesDir, "sample-trial.json"), "utf8")) as IphoneTrialV1;
}

function clone(trial: IphoneTrialV1): IphoneTrialV1 {
  return JSON.parse(JSON.stringify(trial)) as IphoneTrialV1;
}

describe("validateIphoneTrial", () => {
  it("accepts the committed sample fixture", () => {
    expect(validateIphoneTrial(loadSampleTrial())).toEqual([]);
  });

  it("rejects a missing/invalid provenance", () => {
    const trial = clone(loadSampleTrial());
    (trial as { provenance?: unknown }).provenance = "REAL_TOTALLY_TRUST_ME";
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/provenance/);
  });

  it("rejects an unmeasured metric without a reason (no silent absence)", () => {
    const trial = clone(loadSampleTrial());
    trial.metrics.appLaunchToInteractiveMs = {
      measured: false,
      unmeasuredReason: "",
    };
    expect(validateIphoneTrial(trial).join("\n")).toMatch(
      /appLaunchToInteractiveMs.*unmeasuredReason/,
    );
  });

  it("rejects a measured metric that also carries an unmeasuredReason", () => {
    const trial = clone(loadSampleTrial());
    (trial.metrics.resultRenderMs as Record<string, unknown>) = {
      measured: true,
      value: 100,
      unmeasuredReason: "both",
    };
    expect(validateIphoneTrial(trial).join("\n")).toMatch(
      /resultRenderMs.*must be absent when measured/,
    );
  });

  it("rejects a primary latency whose latencyMs does not equal the marker delta", () => {
    const trial = clone(loadSampleTrial());
    const primary = trial.metrics.analysisLatency.primary;
    if (!primary.measured) throw new Error("fixture must be measured");
    primary.value.latencyMs = 1;
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/latencyMs.*!=.*resultInteractiveAtMs/);
  });

  it("rejects a primary latency not human frame-marked (the app may not mark its own ground truth)", () => {
    const trial = clone(loadSampleTrial());
    const primary = trial.metrics.analysisLatency.primary;
    if (!primary.measured) throw new Error("fixture must be measured");
    (primary.value as { markerSource: string }).markerSource = "APP_COMPLETION_DETECTOR";
    expect(validateIphoneTrial(trial).join("\n")).toMatch(
      /markerSource.*HUMAN_FRAME_MARKED_REFERENCE_RECORDING/,
    );
  });

  it("rejects a result-interactive instant that precedes movement completion", () => {
    const trial = clone(loadSampleTrial());
    const primary = trial.metrics.analysisLatency.primary;
    if (!primary.measured) throw new Error("fixture must be measured");
    primary.value.resultInteractiveAtMs = 100;
    primary.value.latencyMs =
      primary.value.resultInteractiveAtMs - primary.value.trueMovementCompletionAtMs;
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/precedes/);
  });

  it("rejects a crash without a crash report reference", () => {
    const trial = clone(loadSampleTrial());
    trial.metrics.stability.crashed = true;
    trial.metrics.stability.crashReportRef = null;
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/crashReportRef.*required when crashed/);
  });

  it("rejects empty modelVersions (trial builds must record live contract versions)", () => {
    const trial = clone(loadSampleTrial());
    trial.modelVersions = {};
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/modelVersions.*empty/);
  });

  it("rejects a Debug-vs-Release-less build configuration", () => {
    const trial = clone(loadSampleTrial());
    (trial.app as { buildConfiguration: string }).buildConfiguration = "AdHoc";
    expect(validateIphoneTrial(trial).join("\n")).toMatch(/buildConfiguration/);
  });
});
