import { describe, expect, it } from "vitest";
import { DEFAULT_PASS1_ROI_CONFIG, planPass1Roi, type Pass1RoiInput } from "../src/paddleRoi.js";

/** Pure-plan tests: pose in, rectangle (or an abstention reason) out. */

const SPAN = { startMs: 1000, endMs: 4000 };

function frames(
  entries: Array<{ t: number; wrists: Array<{ x: number; y: number }> }>,
): Pass1RoiInput["wrists"] {
  return entries.map((entry) => ({ timestampMs: entry.t, wrists: entry.wrists }));
}

describe("planPass1Roi", () => {
  it("builds a padded, clamped rectangle around BOTH wrists over the span", () => {
    const plan = planPass1Roi({
      wrists: frames([
        {
          t: 1500,
          wrists: [
            { x: 0.4, y: 0.5 },
            { x: 0.5, y: 0.55 },
          ],
        },
        { t: 2500, wrists: [{ x: 0.45, y: 0.6 }] },
        { t: 3500, wrists: [{ x: 0.5, y: 0.5 }] },
      ]),
      detectSpan: SPAN,
    });
    expect(plan.status).toBe("roi");
    if (plan.status !== "roi") return;
    const pad = DEFAULT_PASS1_ROI_CONFIG.padNorm;
    const expected = [0.4 - pad, 0.5 - pad, 0.5 + pad, 0.6 + pad];
    for (const [index, value] of plan.roiNorm.entries()) {
      expect(value).toBeCloseTo(expected[index]!, 6);
    }
    expect(plan.wristCoverage).toBe(1);
    expect(plan.areaFraction).toBeCloseTo((0.1 + 2 * pad) * (0.1 + 2 * pad), 6);
  });

  it("clamps the rectangle to the frame", () => {
    const plan = planPass1Roi({
      wrists: frames([
        { t: 1500, wrists: [{ x: 0.02, y: 0.03 }] },
        { t: 2500, wrists: [{ x: 0.05, y: 0.05 }] },
      ]),
      detectSpan: SPAN,
    });
    expect(plan.status).toBe("roi");
    if (plan.status !== "roi") return;
    expect(plan.roiNorm[0]).toBe(0);
    expect(plan.roiNorm[1]).toBe(0);
  });

  it("ignores wrist samples outside the detect span", () => {
    const plan = planPass1Roi({
      wrists: frames([
        { t: 100, wrists: [{ x: 0.05, y: 0.05 }] }, // outside — must not widen
        { t: 1500, wrists: [{ x: 0.5, y: 0.5 }] },
        { t: 2500, wrists: [{ x: 0.55, y: 0.5 }] },
      ]),
      detectSpan: SPAN,
    });
    expect(plan.status).toBe("roi");
    if (plan.status !== "roi") return;
    expect(plan.roiNorm[0]).toBeCloseTo(0.5 - DEFAULT_PASS1_ROI_CONFIG.padNorm, 6);
  });

  it("falls back on an empty span", () => {
    const plan = planPass1Roi({ wrists: frames([]), detectSpan: SPAN });
    expect(plan).toMatchObject({ status: "full_frame", reason: "empty_span" });
  });

  it("falls back when wrist coverage over the span is insufficient", () => {
    const plan = planPass1Roi({
      wrists: frames([
        { t: 1500, wrists: [{ x: 0.5, y: 0.5 }] },
        { t: 2000, wrists: [] },
        { t: 2500, wrists: [] },
        { t: 3000, wrists: [] },
      ]),
      detectSpan: SPAN,
    });
    expect(plan).toMatchObject({
      status: "full_frame",
      reason: "insufficient_wrist_coverage",
      wristCoverage: 0.25,
    });
  });

  it("falls back when the rectangle is not meaningfully smaller than the frame", () => {
    const plan = planPass1Roi({
      wrists: frames([
        { t: 1500, wrists: [{ x: 0.05, y: 0.05 }] },
        { t: 2500, wrists: [{ x: 0.95, y: 0.95 }] },
      ]),
      detectSpan: SPAN,
    });
    expect(plan).toMatchObject({ status: "full_frame", reason: "roi_not_smaller" });
  });
});
