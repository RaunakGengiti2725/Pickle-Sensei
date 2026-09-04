import { describe, expect, it } from "vitest";
import { landmark, midpoint, pathLength, speedSeries } from "../../../src/kinematics.js";
import { wristFrame } from "./support/wristFrames.js";

/**
 * Adversarial pass 3 — scenario 1: `landmark()` visibility gate at the
 * boundary and with non-numeric visibility.
 *
 * Tests marked `it.fails` are reproductions of findings against 4d812e1a:
 * they PASS while the defect is present and will start failing once
 * production is fixed (then flip them to plain `it`).
 */
describe("landmark() visibility gate (attack pass 3 / S1)", () => {
  it("HELD: exactly 0.3 is visible, 0.29999 and -1 are not, nothing throws", () => {
    const at = (visibility: number) =>
      landmark(wristFrame(0, 0.5, 0.5, { visibility }), "right_wrist", 1);

    expect(() => at(0.3)).not.toThrow();
    expect(() => at(0.29999)).not.toThrow();
    expect(() => at(Number.NaN)).not.toThrow();
    expect(() => at(-1)).not.toThrow();

    expect(at(0.3)).toEqual({ x: 0.5, y: 0.5, visibility: 0.3 });
    expect(at(0.29999)).toBeNull();
    expect(at(-1)).toBeNull();
    expect(at(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("HELD: aspect ratio scales x only", () => {
    const point = landmark(wristFrame(0, 0.5, 0.25, { visibility: 0.3 }), "right_wrist", 1.5);
    expect(point).toEqual({ x: 0.75, y: 0.25, visibility: 0.3 });
  });

  // FINDING (P3): `found.visibility < MIN_LANDMARK_VISIBILITY` is false for NaN,
  // so an unmeasured / corrupt visibility passes the gate and NaN propagates
  // into Point.visibility (kinematics.ts:26).
  it.fails("BROKEN: NaN visibility must be treated as not visible", () => {
    const point = landmark(wristFrame(0, 0.5, 0.5, { visibility: Number.NaN }), "right_wrist", 1);
    expect(point).toBeNull();
  });

  it("evidence: NaN visibility propagates through midpoint and is counted by pathLength", () => {
    const nanPoint = landmark(
      wristFrame(0, 0.5, 0.5, { visibility: Number.NaN }),
      "right_wrist",
      1,
    );
    expect(nanPoint).not.toBeNull();
    expect(Number.isNaN(nanPoint!.visibility)).toBe(true);
    const mid = midpoint(nanPoint!, { x: 0, y: 0, visibility: 1 });
    expect(Number.isNaN(mid.visibility)).toBe(true);

    // A frame whose wrist visibility is NaN contributes distance as if measured.
    const frames = [
      wristFrame(0, 0.1, 0.5),
      wristFrame(20, 0.9, 0.5, { visibility: Number.NaN }),
      wristFrame(40, 0.1, 0.5),
    ];
    expect(pathLength(frames, "right_wrist", 0, 40, 1)).toBeCloseTo(1.6, 12);
    expect(speedSeries(frames, "right_wrist", 1)).toHaveLength(1);
  });

  it("HELD: non-finite coordinates with a valid visibility do not throw (but are not rejected)", () => {
    const frames = [
      wristFrame(0, 0.1, 0.5),
      wristFrame(20, Number.POSITIVE_INFINITY, 0.5),
      wristFrame(40, 0.1, 0.5),
    ];
    expect(() => speedSeries(frames, "right_wrist", 1)).not.toThrow();
    expect(() => pathLength(frames, "right_wrist", 0, 40, 1)).not.toThrow();
  });
});
