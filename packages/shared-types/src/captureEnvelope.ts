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
  "exposure_clipping",
  "exposure_stability",
  "motion_blur",
  "sensor_noise",
  "camera_motion",
  "camera_shake",
  "timing_stability",
  "clip_duration",
  "player_pixel_height",
  "player_visibility",
] as const;
export type EnvelopeDimension = (typeof ENVELOPE_DIMENSIONS)[number];

export const ENVELOPE_STATUSES = ["SUPPORTED", "DEGRADED", "UNSUPPORTED", "NOT_MEASURED"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/**
 * Overall verdict including measurement coverage: SUPPORTED means every
 * dimension was measured and passed; SUPPORTED_UNMEASURED means every
 * MEASURED dimension passed but at least one dimension was NOT_MEASURED —
 * the capture is NOT fully verified and consumers must not treat it as such.
 */
export const ENVELOPE_OVERALL_WITH_COVERAGE = [
  "SUPPORTED",
  "SUPPORTED_UNMEASURED",
  "DEGRADED",
  "UNSUPPORTED",
] as const;
export type EnvelopeOverallWithCoverage = (typeof ENVELOPE_OVERALL_WITH_COVERAGE)[number];

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
  /**
   * Overall verdict that also accounts for coverage: a capture whose
   * measured dimensions all pass but with unmeasured dimensions reports
   * SUPPORTED_UNMEASURED, never plain SUPPORTED.
   */
  overallWithCoverage: EnvelopeOverallWithCoverage;
  /** Dimensions that could not be measured for this capture. */
  notMeasured: EnvelopeDimension[];
}
