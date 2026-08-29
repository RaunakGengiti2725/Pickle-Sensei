import { describe, expect, it } from "vitest";
import {
  clipTailFractions,
  meanSpatialGradient,
  motionExtent,
  temporalMeanFrame,
  CLIP_HIGH_LUMA,
  CLIP_LOW_LUMA,
} from "../src/g08EvidenceSignals.js";

describe("g08 bypass-resemblance signal helpers", () => {
  it("clipTailFractions counts crushed and blown pixels", () => {
    const frame = new Uint8Array([0, CLIP_LOW_LUMA, 128, CLIP_HIGH_LUMA, 255]);
    const { low, high } = clipTailFractions(frame);
    expect(low).toBeCloseTo(2 / 5);
    expect(high).toBeCloseTo(2 / 5);
  });

  it("meanSpatialGradient is zero on flat frames and positive on edges", () => {
    const flat = new Uint8Array(16).fill(100);
    expect(meanSpatialGradient(flat, 4, 4)).toBe(0);
    const edged = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
    expect(meanSpatialGradient(edged, 4, 4)).toBeGreaterThan(0);
  });

  it("motionExtent bounds a small moving region", () => {
    const width = 10;
    const height = 10;
    const a = new Uint8Array(width * height).fill(100);
    const b = new Uint8Array(width * height).fill(100);
    b[3 * width + 4] = 200;
    b[4 * width + 4] = 200;
    const extent = motionExtent(a, b, width, height);
    expect(extent.heightFraction).toBeCloseTo(0.2);
    expect(extent.widthFraction).toBeCloseTo(0.1);
    expect(extent.coverage).toBeCloseTo(0.02);
  });

  it("motionExtent reports zero on identical frames", () => {
    const frame = new Uint8Array(16).fill(50);
    expect(motionExtent(frame, frame, 4, 4)).toEqual({
      heightFraction: 0,
      widthFraction: 0,
      coverage: 0,
    });
  });

  it("temporalMeanFrame averages temporally uncorrelated values", () => {
    const mean = temporalMeanFrame([new Uint8Array([0, 200]), new Uint8Array([200, 0])]);
    expect([...mean]).toEqual([100, 100]);
  });
});
