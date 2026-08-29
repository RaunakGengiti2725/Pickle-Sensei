import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  admitDeviceOs,
  COMPAT_CAPABILITIES,
  NEW_DEVICE_OS_YELLOW_REASON,
  validateCompatMatrix,
  type CompatMatrixV1,
} from "../src/compatMatrix.js";
import { loadCommittedMatrix } from "./deviceMatrix.test.js";

export function loadCommittedCompatMatrix(): CompatMatrixV1 {
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "ios-compat-matrix.json"),
    "utf8",
  );
  return JSON.parse(raw) as CompatMatrixV1;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstEntry(matrix: CompatMatrixV1) {
  const entry = matrix.entries[0];
  if (entry === undefined) throw new Error("expected a nonempty compat matrix");
  return entry;
}

describe("committed ios-compat-matrix.json", () => {
  it("validates against pickle.ios-compat-matrix.v1", () => {
    expect(validateCompatMatrix(loadCommittedCompatMatrix(), loadCommittedMatrix())).toEqual([]);
  });

  it("covers every device in device-matrix.json from its minIosMajor", () => {
    const compat = loadCommittedCompatMatrix();
    for (const device of loadCommittedMatrix().devices) {
      const entry = compat.entries.find(
        (e) => e.deviceId === device.deviceId && e.iosMajor === device.minIosMajor,
      );
      expect(entry, `${device.deviceId}@ios${device.minIosMajor}`).toBeDefined();
    }
  });

  it("is honestly all-YELLOW: no device evidence exists in this program", () => {
    for (const entry of loadCommittedCompatMatrix().entries) {
      for (const capability of COMPAT_CAPABILITIES) {
        const cell = entry.capabilities[capability];
        expect(cell.state).toBe("YELLOW");
        if (cell.state === "YELLOW") {
          expect(cell.reason).toMatch(/BLOCKED_EXTERNAL/);
        }
      }
    }
  });
});

describe("admitDeviceOs", () => {
  it("admits a new device/OS combination all-YELLOW with the mandatory reason", () => {
    const entry = admitDeviceOs({
      deviceId: "iphone-16-pro",
      iosMajor: 19,
      admittedAtIso: "2026-08-29T00:00:00.000Z",
    });
    expect(Object.keys(entry.capabilities).sort()).toEqual([...COMPAT_CAPABILITIES].sort());
    for (const capability of COMPAT_CAPABILITIES) {
      expect(entry.capabilities[capability]).toEqual({
        state: "YELLOW",
        reason: NEW_DEVICE_OS_YELLOW_REASON,
      });
    }
  });
});

describe("validateCompatMatrix", () => {
  it("rejects a wrong schemaVersion", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (matrix as { schemaVersion: string }).schemaVersion = "v0";
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.startsWith("schemaVersion:"))).toBe(true);
  });

  it("rejects a deviceId absent from device-matrix.json", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    firstEntry(matrix).deviceId = "iphone-99";
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes('"iphone-99" not in device-matrix.json'))).toBe(true);
  });

  it("rejects duplicate device/OS combinations", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    matrix.entries.push(clone(firstEntry(matrix)));
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("duplicate device/OS combination"))).toBe(true);
  });

  it("rejects a missing capability cell", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    delete (firstEntry(matrix).capabilities as Record<string, unknown>).camera;
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("capabilities.camera: missing"))).toBe(true);
  });

  it("rejects an unknown capability cell", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (firstEntry(matrix).capabilities as Record<string, unknown>).teleport = {
      state: "YELLOW",
      reason: "x",
    };
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("capabilities.teleport: unknown capability"))).toBe(true);
  });

  it("rejects GREEN without evidence: state changes require device evidence", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (firstEntry(matrix).capabilities as Record<string, unknown>).camera = { state: "GREEN" };
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("evidenceTrialIds: GREEN requires"))).toBe(true);
    expect(errors.some((e) => e.includes("validatedAtIso: GREEN requires"))).toBe(true);
    expect(errors.some((e) => e.includes("evidenceNote: GREEN requires"))).toBe(true);
  });

  it("rejects RED without evidence: broken verdicts also require device evidence", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (firstEntry(matrix).capabilities as Record<string, unknown>).thermal = {
      state: "RED",
      evidenceTrialIds: [],
      validatedAtIso: "not-a-date",
      evidenceNote: "",
    };
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("evidenceTrialIds: RED requires"))).toBe(true);
    expect(errors.some((e) => e.includes("validatedAtIso: RED requires"))).toBe(true);
    expect(errors.some((e) => e.includes("evidenceNote: RED requires"))).toBe(true);
  });

  it("rejects YELLOW without a reason and YELLOW carrying evidence fields", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (firstEntry(matrix).capabilities as Record<string, unknown>).memory = {
      state: "YELLOW",
      reason: "",
      evidenceTrialIds: ["t-1"],
    };
    const errors = validateCompatMatrix(matrix, loadCommittedMatrix());
    expect(errors.some((e) => e.includes("reason: required nonempty while YELLOW"))).toBe(true);
    expect(errors.some((e) => e.includes("evidenceTrialIds: must be absent while YELLOW"))).toBe(
      true,
    );
  });

  it("accepts GREEN with complete evidence fields (schema level only)", () => {
    const matrix = clone(loadCommittedCompatMatrix());
    (firstEntry(matrix).capabilities as Record<string, unknown>).camera = {
      state: "GREEN",
      evidenceTrialIds: ["trial-1"],
      validatedAtIso: "2026-08-29T00:00:00.000Z",
      evidenceNote: "Camera started and streamed at requested settings on device.",
    };
    expect(validateCompatMatrix(matrix, loadCommittedMatrix())).toEqual([]);
  });

  it("propagates device-matrix errors instead of validating against garbage", () => {
    const errors = validateCompatMatrix(loadCommittedCompatMatrix(), { nope: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith("device matrix:"))).toBe(true);
  });
});
