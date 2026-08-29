import { describe, expect, it } from "vitest";
import {
  firstBandFlip,
  isMonotone,
  ruleOfThreeUpperBound,
  trialsForUpperBound,
  type LadderRow,
} from "../src/f18Analysis.js";
import { F18_VALIDATION_CRITERIA } from "../src/f18ValidationCriteria.js";
import { CAPTURE_ENVELOPE_THRESHOLDS } from "../src/thresholds.js";

describe("f18 validation criteria", () => {
  it("covers every threshold dimension exactly once with matching threshold ids", () => {
    const dims = Object.keys(CAPTURE_ENVELOPE_THRESHOLDS).sort();
    const covered = F18_VALIDATION_CRITERIA.map((c) => c.dimension as string).sort();
    expect(covered).toEqual(dims);
    for (const criteria of F18_VALIDATION_CRITERIA) {
      expect(criteria.thresholdId).toBe(
        CAPTURE_ENVELOPE_THRESHOLDS[criteria.dimension as keyof typeof CAPTURE_ENVELOPE_THRESHOLDS]
          .id,
      );
    }
  });
});

describe("isMonotone", () => {
  it("detects strict monotonicity in both directions", () => {
    expect(isMonotone([1, 2, 3], "increasing")).toBe(true);
    expect(isMonotone([3, 2, 1], "decreasing")).toBe(true);
    expect(isMonotone([1, 1, 2], "increasing")).toBe(false);
    expect(isMonotone([3, 3, 1], "decreasing")).toBe(false);
  });
});

describe("rule of three", () => {
  it("matches the exact zero-event 95% upper bound", () => {
    expect(ruleOfThreeUpperBound(9)).toBeCloseTo(0.2831, 3);
    expect(ruleOfThreeUpperBound(3)).toBeCloseTo(0.6316, 3);
  });
  it("inverts to the minimum trial count", () => {
    expect(trialsForUpperBound(0.1)).toBe(29);
    expect(trialsForUpperBound(0.05)).toBe(59);
    expect(ruleOfThreeUpperBound(trialsForUpperBound(0.1))).toBeLessThanOrEqual(0.1);
  });
});

describe("firstBandFlip", () => {
  const row = (injected: number | null, bandStatus: string): LadderRow => ({
    unitId: "u",
    sessionKey: "s",
    dimension: "camera_motion",
    injected,
    measured: 0,
    bandStatus,
  });
  it("returns the smallest injected magnitude whose status differs from control", () => {
    expect(
      firstBandFlip([
        row(null, "SUPPORTED"),
        row(1, "SUPPORTED"),
        row(4, "DEGRADED"),
        row(2, "SUPPORTED"),
      ]),
    ).toBe(4);
  });
  it("returns null when the status never flips or control is missing", () => {
    expect(firstBandFlip([row(null, "SUPPORTED"), row(1, "SUPPORTED")])).toBeNull();
    expect(firstBandFlip([row(1, "DEGRADED")])).toBeNull();
  });
});
