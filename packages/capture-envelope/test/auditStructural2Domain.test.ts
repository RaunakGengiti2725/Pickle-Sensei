import { describe, expect, it } from "vitest";
import {
  classifyDimension,
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from "../src/envelope.js";
import { CAPTURE_ENVELOPE_THRESHOLDS } from "../src/thresholds.js";

/**
 * Structural audit #2: `classifyDimension` treats only `null`/`NaN` as
 * unmeasured. The measurement interface is public (clipProbe is one producer;
 * pose-derived fields come from elsewhere), so values outside a dimension's
 * physical domain — non-finite numbers, negative fractions, visibility > 1 —
 * must never be classified SUPPORTED: a one-sided band (`{ min }` or
 * `{ max }`) is otherwise satisfied by ±Infinity or an impossible sign.
 */

const allSupported: CaptureEnvelopeMeasurements = {
  frameWidthPx: 1920,
  frameHeightPx: 1080,
  avgFrameRateFps: 30,
  brightnessMeanLuma: 120,
  brightnessStdLuma: 10,
  laplacianVarianceMedian: 300,
  meanAbsFrameDiff: 5,
  denoiseSurvivalRatio: 0.8,
  clippedPixelFraction: 0.01,
  contrastNormalizedFrameDiff: 0.05,
  frameIntervalCv: 0.01,
  clipDurationMs: 8000,
  playerPixelHeightFraction: 0.4,
  playerMeanJointVisibility: 0.9,
};

describe("structural audit #2: out-of-domain measurements never read as SUPPORTED", () => {
  it("non-finite values are not SUPPORTED on any dimension", () => {
    for (const [dimension, threshold] of Object.entries(CAPTURE_ENVELOPE_THRESHOLDS)) {
      for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect
          .soft(classifyDimension(value, threshold), `${dimension} with ${value}`)
          .not.toBe("SUPPORTED");
      }
    }
  });

  it("a clip probe reporting +Infinity resolution/fps does not produce an overall SUPPORTED verdict", () => {
    const verdict = evaluateCaptureEnvelope({
      ...allSupported,
      frameWidthPx: Number.POSITIVE_INFINITY,
      frameHeightPx: Number.POSITIVE_INFINITY,
      avgFrameRateFps: Number.POSITIVE_INFINITY,
    });
    expect(verdict.overall).not.toBe("SUPPORTED");
    expect(verdict.overallWithCoverage).not.toBe("SUPPORTED");
  });

  it("negative fractions / ratios (impossible measurements) are not SUPPORTED", () => {
    const verdict = evaluateCaptureEnvelope({
      ...allSupported,
      clippedPixelFraction: -0.5,
      contrastNormalizedFrameDiff: -1,
      frameIntervalCv: -3,
      brightnessStdLuma: -20,
      meanAbsFrameDiff: -7,
    });
    const flagged = verdict.dimensions.filter((d) =>
      [
        "exposure_clipping",
        "camera_shake",
        "timing_stability",
        "exposure_stability",
        "camera_motion",
      ].includes(d.dimension),
    );
    for (const d of flagged) expect.soft(d.status, d.dimension).not.toBe("SUPPORTED");
  });

  it("joint visibility above 1.0 (impossible for a mean of [0,1] scores) is not SUPPORTED", () => {
    const verdict = evaluateCaptureEnvelope({ ...allSupported, playerMeanJointVisibility: 1.5 });
    const vis = verdict.dimensions.find((d) => d.dimension === "player_visibility");
    expect(vis?.status).not.toBe("SUPPORTED");
  });
});
