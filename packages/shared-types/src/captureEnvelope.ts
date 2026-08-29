/**
 * Supported-capture-envelope verdict types (Wave C / C12).
 *
 * The envelope is defined empirically: every threshold behind a verdict is
 * VERSIONED and PROVISIONAL until learned from labeled evidence. Consumers
 * (mobile capture guidance) must surface DEGRADED/UNSUPPORTED honestly and
 * must never treat a PROVISIONAL verdict as validated device support.
 */

export const ENVELOPE_DIMENSIONS = [
  "resolution",
  "frame_rate",
  "brightness",
  "motion_blur",
  "camera_motion",
  "timing_stability",
  "clip_duration",
  "player_pixel_height",
  "player_visibility",
] as const;
export type EnvelopeDimension = (typeof ENVELOPE_DIMENSIONS)[number];

export const ENVELOPE_STATUSES = ["SUPPORTED", "DEGRADED", "UNSUPPORTED", "NOT_MEASURED"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export interface EnvelopeDimensionVerdict {
  dimension: EnvelopeDimension;
  status: EnvelopeStatus;
  /** Measured value the verdict was computed from; null when NOT_MEASURED. */
  measured: number | null;
  unit: string;
  /** Identifier of the exact threshold rule applied (versioned). */
  thresholdId: string;
}

export interface EnvelopeVerdict {
  /** Version of the threshold set that produced this verdict. */
  thresholdsVersion: string;
  /** True until thresholds are learned from evidence; today always true. */
  provisional: boolean;
  dimensions: EnvelopeDimensionVerdict[];
  /** Worst status across MEASURED dimensions (NOT_MEASURED never upgrades). */
  overall: Exclude<EnvelopeStatus, "NOT_MEASURED">;
  /** Dimensions that could not be measured for this capture. */
  notMeasured: EnvelopeDimension[];
}
