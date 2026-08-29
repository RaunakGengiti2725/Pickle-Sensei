import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CHECKLIST,
  generateCompatChecklist,
  type CompatChecklistReportV1,
} from "../src/compatChecklist.js";
import { COMPAT_CAPABILITIES, type CompatMatrixV1 } from "../src/compatMatrix.js";
import type { IphoneTrialV1 } from "../src/trialSchema.js";
import { loadCommittedMatrix } from "./deviceMatrix.test.js";
import { loadCommittedCompatMatrix } from "./compatMatrix.test.js";
import { loadSampleTrial } from "./trialSchema.test.js";

const AT = "2026-08-29T12:00:00.000Z";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deviceTrial(overrides: { trialId: string; iosVersion?: string }): IphoneTrialV1 {
  const trial = clone(loadSampleTrial());
  trial.trialId = overrides.trialId;
  trial.provenance = "DEVICE_MEASUREMENT";
  if (overrides.iosVersion !== undefined) {
    trial.device.iosVersion = overrides.iosVersion;
  }
  return trial;
}

function emptyReport(): CompatChecklistReportV1 {
  return generateCompatChecklist({
    compatMatrix: loadCommittedCompatMatrix(),
    deviceMatrix: loadCommittedMatrix(),
    trialFiles: [],
    generatedAtIso: AT,
  });
}

describe("CAPABILITY_CHECKLIST", () => {
  it("covers every capability exactly once with nonempty steps", () => {
    expect(CAPABILITY_CHECKLIST.map((s) => s.capability).sort()).toEqual(
      [...COMPAT_CAPABILITIES].sort(),
    );
    for (const spec of CAPABILITY_CHECKLIST) {
      expect(spec.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("generateCompatChecklist", () => {
  it("reports every cell BLOCKED_EXTERNAL over an empty trials directory", () => {
    const report = emptyReport();
    expect(report.totals.deviceMeasurementTrials).toBe(0);
    expect(report.integrityFailures).toEqual([]);
    expect(report.combinations.length).toBe(loadCommittedCompatMatrix().entries.length);
    for (const combo of report.combinations) {
      expect(combo.matchingDeviceTrialCount).toBe(0);
      for (const cap of combo.capabilities) {
        expect(cap.matrixState).toBe("YELLOW");
        expect(cap.evidenceStatus).toBe("BLOCKED_EXTERNAL_NO_DEVICE_TRIALS");
        expect(cap.blockedReason).toMatch(/BLOCKED_EXTERNAL/);
      }
    }
    expect(report.notes.join("\n")).toMatch(/No physical-iPhone evidence/);
  });

  it("excludes SAMPLE_FIXTURE trials from all evidence", () => {
    const report = generateCompatChecklist({
      compatMatrix: loadCommittedCompatMatrix(),
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "sample.json", data: loadSampleTrial() }],
      generatedAtIso: AT,
    });
    expect(report.totals.sampleFixtureTrials).toBe(1);
    expect(report.totals.deviceMeasurementTrials).toBe(0);
    for (const combo of report.combinations) {
      expect(combo.matchingDeviceTrialCount).toBe(0);
    }
    expect(report.notes.join("\n")).toMatch(/EXCLUDED from all evidence/);
  });

  it("lists invalid trial files loudly instead of skipping them", () => {
    const report = generateCompatChecklist({
      compatMatrix: loadCommittedCompatMatrix(),
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "broken.json", data: { nope: true } }],
      generatedAtIso: AT,
    });
    expect(report.totals.invalidFiles).toBe(1);
    expect(report.invalidFiles[0]?.fileName).toBe("broken.json");
    expect(report.invalidFiles[0]?.errors.length).toBeGreaterThan(0);
  });

  it("matches device trials only on the same device AND iOS major", () => {
    // Sample trial fixture: iphone-13 on iOS 17.x.
    const report = generateCompatChecklist({
      compatMatrix: loadCommittedCompatMatrix(),
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [
        { fileName: "t17.json", data: deviceTrial({ trialId: "t-17", iosVersion: "17.5.1" }) },
        { fileName: "t18.json", data: deviceTrial({ trialId: "t-18", iosVersion: "18.1" }) },
      ],
      generatedAtIso: AT,
    });
    const combo17 = report.combinations.find(
      (c) => c.deviceId === "iphone-13" && c.iosMajor === 17,
    );
    const combo18 = report.combinations.find(
      (c) => c.deviceId === "iphone-13" && c.iosMajor === 18,
    );
    const combo16 = report.combinations.find(
      (c) => c.deviceId === "iphone-13" && c.iosMajor === 16,
    );
    expect(combo17?.matchingDeviceTrialCount).toBe(1);
    expect(combo17?.capabilities[0]?.matchingDeviceTrialIds).toEqual(["t-17"]);
    expect(combo18?.matchingDeviceTrialCount).toBe(1);
    expect(combo16?.matchingDeviceTrialCount).toBe(0);
  });

  it("distinguishes measured evidence from unmeasured metrics on matching trials", () => {
    const trial = deviceTrial({ trialId: "t-17", iosVersion: "17.5.1" });
    trial.metrics.cameraStartToFirstFrameMs = {
      measured: false,
      unmeasuredReason: "camera timing instrumentation was not attached in this trial",
    };
    const report = generateCompatChecklist({
      compatMatrix: loadCommittedCompatMatrix(),
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [{ fileName: "t17.json", data: trial }],
      generatedAtIso: AT,
    });
    const combo = report.combinations.find((c) => c.deviceId === "iphone-13" && c.iosMajor === 17);
    const camera = combo?.capabilities.find((c) => c.capability === "camera");
    expect(camera?.evidenceStatus).toBe("DEVICE_TRIALS_PRESENT_METRIC_UNMEASURED");
    expect(camera?.measuredEvidenceTrialIds).toEqual([]);
    const frameTiming = combo?.capabilities.find((c) => c.capability === "frameTiming");
    expect(frameTiming?.evidenceStatus).toBe("DEVICE_EVIDENCE_PRESENT");
    expect(frameTiming?.measuredEvidenceTrialIds).toEqual(["t-17"]);
    const sessionCap = combo?.capabilities.find((c) => c.capability === "session");
    expect(sessionCap?.evidenceStatus).toBe("MANUAL_EVIDENCE_REQUIRED");
  });

  it("fails GREEN cells whose cited evidence does not resolve to real device trials", () => {
    const compat = clone(loadCommittedCompatMatrix()) as CompatMatrixV1;
    const entry = compat.entries.find((e) => e.deviceId === "iphone-13" && e.iosMajor === 17);
    if (entry === undefined) throw new Error("expected iphone-13@ios17 in committed matrix");
    entry.capabilities.camera = {
      state: "GREEN",
      evidenceTrialIds: ["ghost-trial"],
      validatedAtIso: AT,
      evidenceNote: "claims evidence that does not exist",
    };
    const report = generateCompatChecklist({
      compatMatrix: compat,
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [],
      generatedAtIso: AT,
    });
    expect(report.integrityFailures).toHaveLength(1);
    expect(report.integrityFailures[0]).toMatchObject({
      deviceId: "iphone-13",
      iosMajor: 17,
      capability: "camera",
    });
    expect(report.integrityFailures[0]?.error).toMatch(/ghost-trial/);
    expect(report.notes.join("\n")).toMatch(/integrity failure/);
  });

  it("accepts GREEN cells whose evidence resolves to a matching device trial", () => {
    const compat = clone(loadCommittedCompatMatrix()) as CompatMatrixV1;
    const entry = compat.entries.find((e) => e.deviceId === "iphone-13" && e.iosMajor === 17);
    if (entry === undefined) throw new Error("expected iphone-13@ios17 in committed matrix");
    entry.capabilities.camera = {
      state: "GREEN",
      evidenceTrialIds: ["t-17"],
      validatedAtIso: AT,
      evidenceNote: "camera started and streamed on device",
    };
    const report = generateCompatChecklist({
      compatMatrix: compat,
      deviceMatrix: loadCommittedMatrix(),
      trialFiles: [
        { fileName: "t17.json", data: deviceTrial({ trialId: "t-17", iosVersion: "17.5.1" }) },
      ],
      generatedAtIso: AT,
    });
    expect(report.integrityFailures).toEqual([]);
    const combo = report.combinations.find((c) => c.deviceId === "iphone-13" && c.iosMajor === 17);
    const camera = combo?.capabilities.find((c) => c.capability === "camera");
    expect(camera?.matrixState).toBe("GREEN");
    expect(camera?.evidenceStatus).toBe("DEVICE_EVIDENCE_PRESENT");
  });

  it("throws on an invalid compat matrix instead of reporting over garbage", () => {
    expect(() =>
      generateCompatChecklist({
        compatMatrix: { nope: true },
        deviceMatrix: loadCommittedMatrix(),
        trialFiles: [],
        generatedAtIso: AT,
      }),
    ).toThrow(/invalid compat matrix/);
  });
});
