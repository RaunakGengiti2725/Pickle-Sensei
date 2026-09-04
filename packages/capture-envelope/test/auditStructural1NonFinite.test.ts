import { describe, expect, it } from "vitest";
import type { CaptureEnvelopeMeasurements } from "../src/index.js";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  classifyDimension,
  evaluateCaptureEnvelope,
} from "../src/index.js";

/**
 * Structural audit #1 (storage-media-worker / capture-envelope): the input
 * contract of `classifyDimension` / `evaluateCaptureEnvelope`. `null` and
 * `NaN` are documented as NOT_MEASURED; the other two non-finite doubles
 * (±Infinity) are what a divide-by-zero in a producer yields (e.g. fps from
 * a zero-duration clip, a ratio with an empty denominator). A non-finite
 * measurement is not a measurement and must never read as SUPPORTED.
 */

const supported: CaptureEnvelopeMeasurements = {
  frameWidthPx: 1920,
  frameHeightPx: 1080,
  avgFrameRateFps: 30,
  brightnessMeanLuma: 120,
  brightnessStdLuma: 10,
  laplacianVarianceMedian: 250,
  meanAbsFrameDiff: 3,
  denoiseSurvivalRatio: 0.85,
  clippedPixelFraction: 0.01,
  contrastNormalizedFrameDiff: 0.05,
  frameIntervalCv: 0.02,
  clipDurationMs: 8000,
  playerPixelHeightFraction: 0.4,
  playerMeanJointVisibility: 0.8,
};

describe("audit-structural1: non-finite measurements", () => {
  it("VERIFY null and NaN classify as NOT_MEASURED for every dimension", () => {
    for (const threshold of Object.values(CAPTURE_ENVELOPE_THRESHOLDS)) {
      expect(classifyDimension(null, threshold)).toBe("NOT_MEASURED");
      expect(classifyDimension(Number.NaN, threshold)).toBe("NOT_MEASURED");
    }
  });

  it("+Infinity must not classify as SUPPORTED on min-only bands (frame_rate, resolution, motion_blur, ...)", () => {
    for (const [dimension, threshold] of Object.entries(CAPTURE_ENVELOPE_THRESHOLDS)) {
      expect(
        classifyDimension(Number.POSITIVE_INFINITY, threshold),
        `${dimension}: +Infinity`,
      ).not.toBe("SUPPORTED");
    }
  });

  it("-Infinity must not classify as SUPPORTED on max-only bands (camera_motion, exposure_clipping, ...)", () => {
    for (const [dimension, threshold] of Object.entries(CAPTURE_ENVELOPE_THRESHOLDS)) {
      expect(
        classifyDimension(Number.NEGATIVE_INFINITY, threshold),
        `${dimension}: -Infinity`,
      ).not.toBe("SUPPORTED");
    }
  });

  it("an infinite frame rate (zero-duration clip) must not yield a fully verified SUPPORTED verdict", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supported,
      avgFrameRateFps: Number.POSITIVE_INFINITY,
    });
    const frameRate = verdict.dimensions.find((d) => d.dimension === "frame_rate")!;
    expect(frameRate.status).not.toBe("SUPPORTED");
    expect(verdict.overallWithCoverage).not.toBe("SUPPORTED");
  });

  it("a -Infinity camera_motion proxy (empty denominator) must not yield a fully verified SUPPORTED verdict", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supported,
      meanAbsFrameDiff: Number.NEGATIVE_INFINITY,
    });
    const motion = verdict.dimensions.find((d) => d.dimension === "camera_motion")!;
    expect(motion.status).not.toBe("SUPPORTED");
    expect(verdict.overallWithCoverage).not.toBe("SUPPORTED");
  });
});
