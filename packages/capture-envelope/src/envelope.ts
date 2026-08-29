import type {
  EnvelopeDimension,
  EnvelopeDimensionVerdict,
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
  /** Median Laplacian variance over sampled 320px-wide grayscale frames. */
  laplacianVarianceMedian: number | null;
  /** Mean abs per-pixel luma diff between consecutive sampled frames. */
  meanAbsFrameDiff: number | null;
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
    case "motion_blur":
      return m.laplacianVarianceMedian;
    case "camera_motion":
      return m.meanAbsFrameDiff;
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
 * Overall is the WORST status across measured dimensions; NOT_MEASURED
 * dimensions never improve it and are listed so callers see degraded
 * observability instead of a silently narrower check.
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

  return {
    thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    provisional: CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
    dimensions,
    overall: worst,
    notMeasured,
  };
}
