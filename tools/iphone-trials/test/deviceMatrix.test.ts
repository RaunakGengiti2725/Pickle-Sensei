import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDeviceMatrix, type DeviceMatrixV1 } from "../src/deviceMatrix.js";

const matrixPath = join(dirname(fileURLToPath(import.meta.url)), "..", "device-matrix.json");

export function loadCommittedMatrix(): DeviceMatrixV1 {
  return JSON.parse(readFileSync(matrixPath, "utf8")) as DeviceMatrixV1;
}

function clone(matrix: DeviceMatrixV1): DeviceMatrixV1 {
  return JSON.parse(JSON.stringify(matrix)) as DeviceMatrixV1;
}

describe("device-matrix.json", () => {
  it("is a valid pickle.iphone-device-matrix.v1 document", () => {
    expect(validateDeviceMatrix(loadCommittedMatrix())).toEqual([]);
  });

  it("covers all four tiers", () => {
    const tiers = new Set(loadCommittedMatrix().devices.map((d) => d.tier));
    expect([...tiers].sort()).toEqual(["flagship", "mid", "older", "recent"]);
  });

  it("honestly records that no device is acquired", () => {
    for (const device of loadCommittedMatrix().devices) {
      expect(device.acquisition.state).toBe("NOT_ACQUIRED");
      expect(device.acquisition.blockedReason).toBeTruthy();
    }
  });
});

describe("validateDeviceMatrix", () => {
  it("rejects a NOT_ACQUIRED entry without a blockedReason", () => {
    const matrix = clone(loadCommittedMatrix());
    const first = matrix.devices[0];
    if (!first) throw new Error("matrix has no devices");
    first.acquisition.blockedReason = null;
    expect(validateDeviceMatrix(matrix).join("\n")).toMatch(/blockedReason/);
  });

  it("rejects duplicate device ids", () => {
    const matrix = clone(loadCommittedMatrix());
    const first = matrix.devices[0];
    if (!first) throw new Error("matrix has no devices");
    matrix.devices.push(JSON.parse(JSON.stringify(first)));
    expect(validateDeviceMatrix(matrix).join("\n")).toMatch(/duplicate/);
  });

  it("rejects a matrix missing a tier", () => {
    const matrix = clone(loadCommittedMatrix());
    matrix.devices = matrix.devices.filter((d) => d.tier !== "flagship");
    expect(validateDeviceMatrix(matrix).join("\n")).toMatch(/tier "flagship" has no entries/);
  });
});
