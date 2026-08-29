import { describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope, type CaptureEnvelopeMeasurements } from "../src/envelope.js";
import {
  LATTICE_DIMS_V03,
  LATTICE_DIMS_V04_NEW,
  runAnalyticTrajectories,
  runLatticeSweep,
} from "../src/sweepSurfacesG09.js";

/**
 * g09-f22-surfaces regression pins.
 *
 * 1. The analytic decision surface must be monotone: along every
 *    per-dimension worsening trajectory and across the full 3^9 severity
 *    lattice, a strictly-worse measurement vector must never yield a
 *    strictly-better verdict. Measured 0 violations at
 *    capture-envelope-thresholds-v0.3-provisional (65 trajectory
 *    comparisons, 118098 lattice successor comparisons).
 *
 * 2. KNOWN VIOLATION (pinned, video-level): the camera_motion frame-diff
 *    proxy is content-dependent, so BLURRING or DARKENING an
 *    already-shaken clip (a strictly-worse capture) pulls meanAbsFrameDiff
 *    back under the supported edge and the OVERALL verdict improves
 *    DEGRADED→SUPPORTED. Measured on afn-sasebo-rally1 + synthetic shake
 *    (g09-f22-decision-surfaces.json). These tests pin the violating
 *    measurement pairs verbatim so any change to this surface — fix or
 *    silent drift — is caught. Fixing it requires a background-registered
 *    motion estimate (see thresholds.ts camera_motion note), not band
 *    re-tuning.
 */

describe("g09: analytic decision-surface monotonicity", () => {
  it("per-dimension worsening trajectories never improve a verdict", () => {
    const results = runAnalyticTrajectories();
    const comparisons = results.reduce((acc, r) => acc + r.comparisons, 0);
    expect(comparisons).toBeGreaterThanOrEqual(65);
    for (const result of results) {
      expect(result.violations).toEqual([]);
    }
  });

  it("3^9 severity lattice (v0.3 dims): overall == worst measured dimension; one-step-worse never improves overall", () => {
    const lattice = runLatticeSweep(LATTICE_DIMS_V03);
    expect(lattice.vectors).toBe(19683);
    expect(lattice.successorComparisons).toBe(118098);
    expect(lattice.overallMonotonicityViolations).toBe(0);
    expect(lattice.overallEqualsMaxSeverityViolations).toBe(0);
  });

  it("3^4 severity lattice (thresholds-v0.4 dims: exposure_clipping/exposure_stability/sensor_noise/camera_shake)", () => {
    const lattice = runLatticeSweep(LATTICE_DIMS_V04_NEW);
    expect(lattice.vectors).toBe(81);
    expect(lattice.successorComparisons).toBe(216);
    expect(lattice.overallMonotonicityViolations).toBe(0);
    expect(lattice.overallEqualsMaxSeverityViolations).toBe(0);
  });

  it("STRUCTURAL (known, F22 A5): losing the worst dimension's measurement upgrades the overall verdict", () => {
    const lattice = runLatticeSweep(LATTICE_DIMS_V03);
    expect(lattice.notMeasuredUpgradeChecked).toBeGreaterThan(0);
    // NOT_MEASURED never worsens overall, so nulling the unique worst
    // dimension upgrades the verdict every time. Documented surface
    // property; a fix would flip this expectation.
    expect(lattice.notMeasuredUpgradeCount).toBe(lattice.notMeasuredUpgradeChecked);
  });
});

/**
 * Measured on the shaken afn-sasebo-rally1 control and its strictly-worse
 * variants (g09-f22-decision-surfaces.json, thresholds v0.3). Only the
 * fields that differ between control and variant changed in the real
 * measurements; values are pinned verbatim.
 */
const shakenControl: CaptureEnvelopeMeasurements = {
  frameWidthPx: 1280,
  frameHeightPx: 720,
  avgFrameRateFps: 29.97002997002997,
  brightnessMeanLuma: 104.06067515432099,
  brightnessStdLuma: null,
  clippedPixelFraction: null,
  laplacianVarianceMedian: 2066.986932903704,
  denoiseSurvivalRatio: null,
  meanAbsFrameDiff: 35.435745506535945,
  contrastNormalizedFrameDiff: null,
  frameIntervalCv: 1.4154739438544443e-5,
  clipDurationMs: 4404,
  playerPixelHeightFraction: null,
  playerMeanJointVisibility: null,
};

describe("g09 KNOWN VIOLATION: strictly-worse capture gets strictly-better verdict via the camera_motion proxy", () => {
  it("blurring a shaken clip (strictly worse) improves overall DEGRADED→SUPPORTED", () => {
    const blurred: CaptureEnvelopeMeasurements = {
      ...shakenControl,
      brightnessMeanLuma: 103.56927565586419,
      laplacianVarianceMedian: 249.80547236347257,
      meanAbsFrameDiff: 30.001111111111108,
    };
    expect(evaluateCaptureEnvelope(shakenControl).overall).toBe("DEGRADED");
    // Pinned violation: gblur sigma-1@320w on top of the shake drops the
    // frame-diff proxy below the supported edge (33) while motion_blur
    // stays SUPPORTED, so the strictly-worse capture reads SUPPORTED.
    expect(evaluateCaptureEnvelope(blurred).overall).toBe("SUPPORTED");
  });

  it("darkening a shaken clip (strictly worse) improves overall DEGRADED→SUPPORTED", () => {
    const darkened: CaptureEnvelopeMeasurements = {
      ...shakenControl,
      brightnessMeanLuma: 60.047829861111104,
      laplacianVarianceMedian: 1813.0728064589302,
      meanAbsFrameDiff: 30.670315563725488,
    };
    expect(evaluateCaptureEnvelope(shakenControl).overall).toBe("DEGRADED");
    expect(evaluateCaptureEnvelope(darkened).overall).toBe("SUPPORTED");
  });
});
