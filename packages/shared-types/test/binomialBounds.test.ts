import { describe, expect, it } from "vitest";
import {
  independentTrialsForZeroEventUpperBound95,
  zeroEventUpperBound95,
} from "../src/binomialBounds.js";

describe("independent zero-event confidence bounds", () => {
  it("returns the exact one-sided bound, never zero for observed zero events", () => {
    expect(zeroEventUpperBound95(0)).toBe(1);
    expect(zeroEventUpperBound95(1)).toBeCloseTo(0.95, 14);
    expect(zeroEventUpperBound95(50)).toBeCloseTo(0.058155079116972264, 14);
    expect(zeroEventUpperBound95(50)).toBeGreaterThan(0.02);
    expect(zeroEventUpperBound95(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(0);
  });

  it("computes the minimum independent support for a two-percent upper bound", () => {
    const minimum = independentTrialsForZeroEventUpperBound95(0.02);
    expect(minimum).toBe(149);
    expect(zeroEventUpperBound95(minimum)).toBeLessThanOrEqual(0.02);
    expect(zeroEventUpperBound95(minimum - 1)).toBeGreaterThan(0.02);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid independent trial count %s",
    (value) => expect(() => zeroEventUpperBound95(value)).toThrow(RangeError),
  );

  it.each([NaN, Infinity, -Infinity, -1, 0, 1, 2, Number.MIN_VALUE])(
    "rejects invalid or unrepresentable target %s",
    (value) => expect(() => independentTrialsForZeroEventUpperBound95(value)).toThrow(RangeError),
  );
});
