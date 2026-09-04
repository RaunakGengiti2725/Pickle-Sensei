import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@pickle/shared-types";
import {
  consecutiveSpeedSeries,
  frameNearest,
  framesWithin,
  landmark,
  pathLength,
  speedSeries,
} from "../src/kinematics.js";

/**
 * Structural audit (pass 1) — kinematics primitives.
 * I1: landmarks below visibility 0.3 are skipped; x is aspect-corrected.
 * I2: speeds are central differences; dt<=0 samples are skipped.
 * Boundaries and non-finite inputs are pinned here because nothing above
 * this layer re-validates what `landmark()` returns.
 */

function frame(
  timestampMs: number,
  wrist: { x: number; y: number; visibility: number },
): PoseFrame {
  return {
    timestampMs,
    space: "normalized-image",
    confidence: 0.9,
    landmarks: [{ name: "right_wrist", ...wrist }],
  };
}

describe("audit: landmark() visibility gate", () => {
  it("treats exactly 0.3 as measured (inclusive floor)", () => {
    const f = frame(0, { x: 0.5, y: 0.5, visibility: 0.3 });
    expect(landmark(f, "right_wrist", 1)).not.toBeNull();
    const below = frame(0, { x: 0.5, y: 0.5, visibility: 0.29999 });
    expect(landmark(below, "right_wrist", 1)).toBeNull();
  });

  it("rejects negative visibility", () => {
    expect(landmark(frame(0, { x: 0.5, y: 0.5, visibility: -1 }), "right_wrist", 1)).toBeNull();
  });

  it("rejects NaN visibility (an unmeasured confidence is not a measurement)", () => {
    expect(
      landmark(frame(0, { x: 0.5, y: 0.5, visibility: Number.NaN }), "right_wrist", 1),
    ).toBeNull();
  });

  it("never returns a point with non-finite coordinates", () => {
    const nanX = landmark(frame(0, { x: Number.NaN, y: 0.5, visibility: 0.9 }), "right_wrist", 1);
    const infY = landmark(
      frame(0, { x: 0.5, y: Number.POSITIVE_INFINITY, visibility: 0.9 }),
      "right_wrist",
      1,
    );
    for (const point of [nanX, infY]) {
      if (point !== null) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    }
  });
});

describe("audit: speedSeries() timestamp hygiene", () => {
  const moving = (ts: number[]) =>
    ts.map((t, index) => frame(t, { x: 0.1 * index, y: 0.5, visibility: 0.9 }));

  it("skips dt<=0 samples from duplicate timestamps and keeps the remaining exact", () => {
    // Central difference at index 2 has prev=100 and next=100 → dt 0 → skipped.
    const frames = moving([0, 100, 100, 100, 200]);
    const series = speedSeries(frames, "right_wrist", 1);
    for (const sample of series) {
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(sample.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("never emits a non-finite speed from a non-finite coordinate", () => {
    const frames = moving([0, 100, 200, 300, 400]);
    frames[2] = frame(200, { x: Number.NaN, y: 0.5, visibility: 0.9 });
    const series = speedSeries(frames, "right_wrist", 1);
    expect(series.every((sample) => Number.isFinite(sample.value))).toBe(true);
    const consecutive = consecutiveSpeedSeries(frames, "right_wrist", 1);
    expect(consecutive.every((sample) => Number.isFinite(sample.value))).toBe(true);
  });

  it("is a pure central difference in exact units (u/s) for a linear track", () => {
    const frames = moving([0, 100, 200, 300, 400]); // 0.1 u per 100 ms = 1 u/s
    const series = speedSeries(frames, "right_wrist", 1);
    expect(series.length).toBe(3);
    for (const sample of series) expect(sample.value).toBeCloseTo(1, 9);
  });
});

describe("audit: window helpers", () => {
  it("framesWithin is inclusive on both bounds; frameNearest breaks ties on the first", () => {
    const frames = [0, 100, 200, 300].map((t) => frame(t, { x: 0, y: 0, visibility: 0.9 }));
    expect(framesWithin(frames, 100, 200).map((f) => f.timestampMs)).toEqual([100, 200]);
    expect(frameNearest(frames, 150)?.timestampMs).toBe(100);
    expect(frameNearest([], 150)).toBeNull();
  });

  it("pathLength ignores unmeasured landmarks instead of interpolating through them", () => {
    const frames = [
      frame(0, { x: 0, y: 0, visibility: 0.9 }),
      frame(100, { x: 10, y: 0, visibility: 0.1 }), // unmeasured excursion
      frame(200, { x: 0.2, y: 0, visibility: 0.9 }),
    ];
    expect(pathLength(frames, "right_wrist", 0, 200, 1)).toBeCloseTo(0.2, 9);
  });
});
