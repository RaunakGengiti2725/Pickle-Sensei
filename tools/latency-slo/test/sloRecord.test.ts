import { describe, expect, it } from "vitest";

import { validateLatencySloRecord } from "../src/sloRecord.js";
import { makeRecord } from "./helpers.js";

describe("validateLatencySloRecord", () => {
  it("accepts a well-formed record", () => {
    expect(validateLatencySloRecord(makeRecord())).toEqual([]);
  });

  it("rejects non-objects", () => {
    expect(validateLatencySloRecord(null)).toEqual(["record: expected object"]);
    expect(validateLatencySloRecord("x")).toEqual(["record: expected object"]);
  });

  it("rejects wrong schema version, metric and provenance", () => {
    const errors = validateLatencySloRecord({
      ...makeRecord(),
      schemaVersion: "v0",
      metric: "OTHER",
      provenance: "GUESSED",
    });
    expect(errors.some((error) => error.includes("schemaVersion"))).toBe(true);
    expect(errors.some((error) => error.includes("metric"))).toBe(true);
    expect(errors.some((error) => error.includes("provenance"))).toBe(true);
  });

  it("requires every slice dimension to be a non-empty string", () => {
    const record = makeRecord();
    const errors = validateLatencySloRecord({
      ...record,
      slice: { ...record.slice, device: "", stroke: 3, phase: "hot" },
    });
    expect(errors.some((error) => error.includes("slice.device"))).toBe(true);
    expect(errors.some((error) => error.includes("slice.stroke"))).toBe(true);
    expect(errors.some((error) => error.includes("slice.phase"))).toBe(true);
  });

  it("rejects negative, non-finite wallMs and bad timestamps", () => {
    expect(
      validateLatencySloRecord({ ...makeRecord(), wallMs: -1 }).some((error) =>
        error.includes("wallMs"),
      ),
    ).toBe(true);
    expect(
      validateLatencySloRecord({ ...makeRecord(), measuredAtIso: "not-a-date" }).some((error) =>
        error.includes("measuredAtIso"),
      ),
    ).toBe(true);
  });

  it("allows null source fields but not wrong types", () => {
    const record = makeRecord();
    expect(
      validateLatencySloRecord({
        ...record,
        source: { file: "f.json", arm: null, clipId: null, gitCommit: null },
      }),
    ).toEqual([]);
    const errors = validateLatencySloRecord({
      ...record,
      source: { file: "", arm: 1, clipId: null, gitCommit: null },
    });
    expect(errors.some((error) => error.includes("source.file"))).toBe(true);
    expect(errors.some((error) => error.includes("source.arm"))).toBe(true);
  });
});
