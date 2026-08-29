import { describe, expect, it } from "vitest";
import type { CaptureEnvelopeMeasurements } from "../src/index.js";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  classifyDimension,
  evaluateCaptureEnvelope,
  laplacianVariance,
  meanAbsDiff,
  meanLuma,
} from "../src/index.js";

const supportedMeasurements: CaptureEnvelopeMeasurements = {
  frameWidthPx: 1920,
  frameHeightPx: 1080,
  avgFrameRateFps: 30,
  brightnessMeanLuma: 120,
  brightnessStdLuma: 10,
  laplacianVarianceMedian: 250,
  meanAbsFrameDiff: 3,
  frameIntervalCv: 0.02,
  clipDurationMs: 8000,
  playerPixelHeightFraction: 0.4,
  playerMeanJointVisibility: 0.8,
};

describe("evaluateCaptureEnvelope", () => {
  it("reports SUPPORTED overall when every dimension is inside the supported band", () => {
    const verdict = evaluateCaptureEnvelope(supportedMeasurements);
    expect(verdict.overall).toBe("SUPPORTED");
    expect(verdict.notMeasured).toEqual([]);
    expect(verdict.dimensions).toHaveLength(9);
    expect(verdict.dimensions.every((d) => d.status === "SUPPORTED")).toBe(true);
  });

  it("is versioned and marked provisional — verdicts never masquerade as validated", () => {
    const verdict = evaluateCaptureEnvelope(supportedMeasurements);
    expect(verdict.thresholdsVersion).toBe(CAPTURE_ENVELOPE_THRESHOLDS_VERSION);
    expect(verdict.thresholdsVersion).toMatch(/provisional/);
    expect(verdict.provisional).toBe(true);
    for (const dimension of verdict.dimensions) {
      expect(dimension.thresholdId).toMatch(/v0\.\d+/);
    }
  });

  it("overall is the WORST measured dimension (one UNSUPPORTED dominates)", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      brightnessMeanLuma: 20, // below degraded floor of 40
      avgFrameRateFps: 25, // degraded
    });
    expect(verdict.overall).toBe("UNSUPPORTED");
    expect(verdict.dimensions.find((d) => d.dimension === "brightness")?.status).toBe(
      "UNSUPPORTED",
    );
    expect(verdict.dimensions.find((d) => d.dimension === "frame_rate")?.status).toBe("DEGRADED");
  });

  it("degraded-only inputs yield DEGRADED overall", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      laplacianVarianceMedian: 50,
    });
    expect(verdict.overall).toBe("DEGRADED");
  });

  it("null pose signals become NOT_MEASURED and never upgrade or downgrade overall", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      playerPixelHeightFraction: null,
      playerMeanJointVisibility: null,
    });
    expect(verdict.notMeasured).toEqual(["player_pixel_height", "player_visibility"]);
    expect(verdict.overall).toBe("SUPPORTED");
    const pose = verdict.dimensions.find((d) => d.dimension === "player_pixel_height");
    expect(pose?.status).toBe("NOT_MEASURED");
    expect(pose?.measured).toBeNull();
  });

  it("resolution uses the SHORT side (portrait and landscape are equivalent)", () => {
    const portrait = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      frameWidthPx: 1080,
      frameHeightPx: 1920,
    });
    const landscape = evaluateCaptureEnvelope(supportedMeasurements);
    expect(portrait.dimensions.find((d) => d.dimension === "resolution")?.measured).toBe(1080);
    expect(landscape.dimensions.find((d) => d.dimension === "resolution")?.measured).toBe(1080);
  });

  it("camera motion is a max-bounded band: excessive global diff is UNSUPPORTED", () => {
    expect(classifyDimension(20, CAPTURE_ENVELOPE_THRESHOLDS.camera_motion)).toBe("UNSUPPORTED");
    expect(classifyDimension(10, CAPTURE_ENVELOPE_THRESHOLDS.camera_motion)).toBe("DEGRADED");
    expect(classifyDimension(2, CAPTURE_ENVELOPE_THRESHOLDS.camera_motion)).toBe("SUPPORTED");
  });

  it("VFR timestamp jitter is flagged via timing_stability even when avg fps passes", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      avgFrameRateFps: 29.9,
      frameIntervalCv: 0.75,
    });
    expect(verdict.dimensions.find((d) => d.dimension === "frame_rate")?.status).toBe("SUPPORTED");
    expect(verdict.dimensions.find((d) => d.dimension === "timing_stability")?.status).toBe(
      "UNSUPPORTED",
    );
    expect(verdict.overall).toBe("UNSUPPORTED");
  });

  it("timing_stability is NOT_MEASURED when interval data is unavailable", () => {
    const verdict = evaluateCaptureEnvelope({
      ...supportedMeasurements,
      frameIntervalCv: null,
    });
    expect(verdict.notMeasured).toContain("timing_stability");
    expect(verdict.overall).toBe("SUPPORTED");
  });

  it("clip duration bands are two-sided", () => {
    expect(classifyDimension(500, CAPTURE_ENVELOPE_THRESHOLDS.clip_duration)).toBe("UNSUPPORTED");
    expect(classifyDimension(1500, CAPTURE_ENVELOPE_THRESHOLDS.clip_duration)).toBe("DEGRADED");
    expect(classifyDimension(8000, CAPTURE_ENVELOPE_THRESHOLDS.clip_duration)).toBe("SUPPORTED");
    expect(classifyDimension(200_000, CAPTURE_ENVELOPE_THRESHOLDS.clip_duration)).toBe(
      "UNSUPPORTED",
    );
  });
});

describe("pixel math", () => {
  it("meanLuma is the plain average", () => {
    expect(meanLuma(new Uint8Array([0, 100, 200]))).toBe(100);
  });

  it("laplacianVariance is 0 on a flat frame and positive on an edge", () => {
    const flat = new Uint8Array(16).fill(128);
    expect(laplacianVariance(flat, 4, 4)).toBe(0);
    const edge = new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    expect(laplacianVariance(edge, 4, 4)).toBeGreaterThan(0);
  });

  it("meanAbsDiff is 0 for identical frames and exact for a known shift", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(meanAbsDiff(a, a)).toBe(0);
    const b = new Uint8Array([20, 10, 40, 30]);
    expect(meanAbsDiff(a, b)).toBe(10);
  });
});
