import type {
  EnvelopeDimension,
  EnvelopeDimensionVerdict,
  EnvelopeOverallWithCoverage,
  EnvelopeStatus,
  EnvelopeVerdict,
} from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  type DimensionThreshold,
  type EnvelopeBand,
} from "./thresholds.js";

/**
 * Measurable capture-envelope signals. Video-derived fields come from the
 * clip alone (ffmpeg/ffprobe on-device or offline); pose-derived fields are
 * null unless a pose pass has already run — the checker never fabricates
 * them and reports those dimensions NOT_MEASURED.
 */
export interface CaptureEnvelopeMeasurements {
  frameWidthPx: number | null;
  frameHeightPx: number | null;
  avgFrameRateFps: number | null;
  /** Mean luma over sampled grayscale frames, 0–255. */
  brightnessMeanLuma: number | null;
  /** Std dev of per-frame mean luma over the sampled frames. */
  brightnessStdLuma: number | null;
  /** Median Laplacian variance over sampled 320px-long-side gray frames. */
  laplacianVarianceMedian: number | null;
  /** Mean abs per-pixel luma diff between consecutive sampled frames. */
  meanAbsFrameDiff: number | null;
  /**
   * Ratio of median Laplacian variance after a 3x3 median denoise to the
   * raw value. Genuine detail survives; injected grain collapses.
   */
  denoiseSurvivalRatio: number | null;
  /** Fraction of sampled pixels at/beyond luma clip points (<=16, >=235). */
  clippedPixelFraction: number | null;
  /** meanAbsFrameDiff divided by mean spatial luma std of sampled frames. */
  contrastNormalizedFrameDiff: number | null;
  /**
   * Coefficient of variation of inter-frame presentation intervals
   * (std dev / mean). ~0 for CFR; large for VFR timestamp jitter.
   */
  frameIntervalCv: number | null;
  clipDurationMs: number | null;
  /** Pose-derived; null when no pose is available. */
  playerPixelHeightFraction: number | null;
  /** Pose-derived; null when no pose is available. */
  playerMeanJointVisibility: number | null;
}

function inBand(value: number, band: EnvelopeBand): boolean {
  if (band.min !== undefined && value < band.min) return false;
  if (band.max !== undefined && value > band.max) return false;
  return true;
}

export function classifyDimension(
  value: number | null,
  threshold: DimensionThreshold,
): EnvelopeStatus {
  if (value === null || Number.isNaN(value)) return "NOT_MEASURED";
  if (inBand(value, threshold.supported)) return "SUPPORTED";
  if (inBand(value, threshold.degraded)) return "DEGRADED";
  return "UNSUPPORTED";
}

function measuredValueFor(
  dimension: EnvelopeDimension,
  m: CaptureEnvelopeMeasurements,
): number | null {
  switch (dimension) {
    case "resolution":
      return m.frameWidthPx !== null && m.frameHeightPx !== null
        ? Math.min(m.frameWidthPx, m.frameHeightPx)
        : null;
    case "frame_rate":
      return m.avgFrameRateFps;
    case "brightness":
      return m.brightnessMeanLuma;
    case "exposure_clipping":
      return m.clippedPixelFraction;
    case "exposure_stability":
      return m.brightnessStdLuma;
    case "motion_blur":
      return m.laplacianVarianceMedian;
    case "sensor_noise":
      return m.denoiseSurvivalRatio;
    case "camera_motion":
      return m.meanAbsFrameDiff;
    case "camera_shake":
      return m.contrastNormalizedFrameDiff;
    case "timing_stability":
      return m.frameIntervalCv;
    case "clip_duration":
      return m.clipDurationMs;
    case "player_pixel_height":
      return m.playerPixelHeightFraction;
    case "player_visibility":
      return m.playerMeanJointVisibility;
  }
}

const STATUS_SEVERITY: Record<Exclude<EnvelopeStatus, "NOT_MEASURED">, number> = {
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
};

/**
 * Compute the per-dimension and overall envelope verdict for a capture.
 * `overall` is the WORST status across measured dimensions; NOT_MEASURED
 * dimensions never improve it and are listed so callers see degraded
 * observability instead of a silently narrower check. `overallWithCoverage`
 * additionally distinguishes a fully verified SUPPORTED capture from one
 * whose measured dimensions pass while some dimensions were never measured
 * (SUPPORTED_UNMEASURED) — consumers must not treat the latter as verified.
 */
export function evaluateCaptureEnvelope(m: CaptureEnvelopeMeasurements): EnvelopeVerdict {
  const dimensions: EnvelopeDimensionVerdict[] = [];
  const notMeasured: EnvelopeDimension[] = [];
  let worst: Exclude<EnvelopeStatus, "NOT_MEASURED"> = "SUPPORTED";

  for (const [dimension, threshold] of Object.entries(CAPTURE_ENVELOPE_THRESHOLDS) as Array<
    [EnvelopeDimension, DimensionThreshold]
  >) {
    const measured = measuredValueFor(dimension, m);
    const status = classifyDimension(measured, threshold);
    dimensions.push({
      dimension,
      status,
      measured: measured !== null && !Number.isNaN(measured) ? measured : null,
      unit: threshold.unit,
      thresholdId: threshold.id,
    });
    if (status === "NOT_MEASURED") {
      notMeasured.push(dimension);
    } else if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }

  const overallWithCoverage: EnvelopeOverallWithCoverage =
    worst === "SUPPORTED" && notMeasured.length > 0 ? "SUPPORTED_UNMEASURED" : worst;

  return {
    thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    provisional: CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
    dimensions,
    overall: worst,
    overallWithCoverage,
    notMeasured,
  };
}
