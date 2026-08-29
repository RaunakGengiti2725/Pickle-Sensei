import { describe, expect, it } from "vitest";
import type { PoseFrame } from "@pickle/shared-types";
import {
  angularDifferenceDeg,
  interiorAngleDeg,
  landmark,
  median,
  movingAverage,
  pathLength,
  segmentAngleDeg,
  speedSeries,
  standardDeviation,
} from "../src/kinematics.js";

const point = (x: number, y: number) => ({ x, y, visibility: 1 });

function frame(timestampMs: number, x: number, y: number): PoseFrame {
  return {
    timestampMs,
    space: "normalized-image",
    confidence: 1,
    landmarks: [{ name: "right_wrist", x, y, visibility: 0.9 }],
  };
}

describe("kinematics primitives", () => {
  it("computes interior angles against hand-worked cases", () => {
    // Right angle at the vertex.
    expect(interiorAngleDeg(point(1, 0), point(0, 0), point(0, 1))).toBeCloseTo(90, 6);
    // Straight leg: 180° (zero flexion).
    expect(interiorAngleDeg(point(0, 0), point(0, 1), point(0, 2))).toBeCloseTo(180, 6);
    // 3-4-5 triangle angle at origin: atan2(3,4) vs x-axis.
    expect(interiorAngleDeg(point(4, 3), point(0, 0), point(1, 0))).toBeCloseTo(36.8699, 3);
  });

  it("measures segment direction and wrapped angular difference", () => {
    expect(segmentAngleDeg(point(0, 0), point(1, 0))).toBeCloseTo(0);
    expect(segmentAngleDeg(point(0, 0), point(0, 1))).toBeCloseTo(90);
    expect(angularDifferenceDeg(179, -179)).toBeCloseTo(2, 6);
    expect(angularDifferenceDeg(10, 350)).toBeCloseTo(20, 6);
  });

  it("aspect-corrects landmark x and hides low-visibility joints", () => {
    const wide: PoseFrame = {
      timestampMs: 0,
      space: "normalized-image",
      confidence: 1,
      landmarks: [
        { name: "right_wrist", x: 0.5, y: 0.5, visibility: 0.9 },
        { name: "left_wrist", x: 0.5, y: 0.5, visibility: 0.1 },
      ],
    };
    expect(landmark(wide, "right_wrist", 9 / 16)?.x).toBeCloseTo(0.5 * (9 / 16));
    expect(landmark(wide, "left_wrist", 9 / 16)).toBeNull();
  });

  it("derives speeds by central differences with exact units", () => {
    // Constant velocity: 0.06 units per 100ms = 0.6 units/second.
    const frames = [0, 100, 200, 300, 400].map((t, i) => frame(t, 0.1 + 0.06 * i, 0.5));
    const speeds = speedSeries(frames, "right_wrist", 1);
    expect(speeds).toHaveLength(3);
    for (const sample of speeds) expect(sample.value).toBeCloseTo(0.6, 9);
  });

  it("accumulates path length only over measured frames in range", () => {
    const frames = [
      frame(0, 0.1, 0.5),
      frame(100, 0.2, 0.5),
      frame(200, 0.2, 0.6),
      frame(300, 0.5, 0.6),
    ];
    expect(pathLength(frames, "right_wrist", 0, 200, 1)).toBeCloseTo(0.2, 9);
    expect(pathLength(frames, "right_wrist", 0, 300, 1)).toBeCloseTo(0.5, 9);
  });

  it("keeps statistics honest on edge cases", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBeCloseTo(2.5);
    expect(standardDeviation([5])).toBe(0);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 3);
    expect(movingAverage([0, 10, 0], 3)).toEqual([5, 10 / 3, 5]);
  });
});
