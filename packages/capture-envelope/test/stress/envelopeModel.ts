import {
  ENVELOPE_DIMENSIONS,
  type EnvelopeDimension,
  type EnvelopeStatus,
  type EnvelopeVerdict,
} from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  type CaptureEnvelopeMeasurements,
  type DimensionThreshold,
  type EnvelopeBand,
} from "../../src/index.js";
import { stableJson } from "./prng.js";

/**
 * Independent model of the capture-envelope evaluator, written from the
 * documented contract (src/thresholds.ts header + src/envelope.ts comments):
 *
 *  - supported bounds are inclusive; degraded bounds are inclusive; else UNSUPPORTED
 *  - null / NaN → NOT_MEASURED (never a fabricated pass or fail)
 *  - `resolution` is the SHORT side, so both frame dimensions are required
 *  - `overall` is the worst MEASURED status
 *  - `overallWithCoverage` is SUPPORTED_UNMEASURED iff worst measured is
 *    SUPPORTED and at least one dimension is NOT_MEASURED
 *  - `notMeasured` lists exactly the NOT_MEASURED dimensions, in emit order
 *  - every emitted number is finite (no NaN / Infinity leaks)
 */

export const STATUS_RANK: Record<EnvelopeStatus, number> = {
  NOT_MEASURED: -1,
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
};

export const MEASUREMENT_FIELDS = [
  "frameWidthPx",
  "frameHeightPx",
  "avgFrameRateFps",
  "brightnessMeanLuma",
  "brightnessStdLuma",
  "laplacianVarianceMedian",
  "meanAbsFrameDiff",
  "denoiseSurvivalRatio",
  "clippedPixelFraction",
  "contrastNormalizedFrameDiff",
  "frameIntervalCv",
  "clipDurationMs",
  "playerPixelHeightFraction",
  "playerMeanJointVisibility",
] as const satisfies ReadonlyArray<keyof CaptureEnvelopeMeasurements>;

export type MeasurementField = (typeof MEASUREMENT_FIELDS)[number];

/** Which measurement field(s) feed each dimension (mirrors measuredValueFor). */
export const DIMENSION_SOURCES: Record<EnvelopeDimension, readonly MeasurementField[]> = {
  resolution: ["frameWidthPx", "frameHeightPx"],
  frame_rate: ["avgFrameRateFps"],
  brightness: ["brightnessMeanLuma"],
  exposure_clipping: ["clippedPixelFraction"],
  exposure_stability: ["brightnessStdLuma"],
  motion_blur: ["laplacianVarianceMedian"],
  sensor_noise: ["denoiseSurvivalRatio"],
  camera_motion: ["meanAbsFrameDiff"],
  camera_shake: ["contrastNormalizedFrameDiff"],
  timing_stability: ["frameIntervalCv"],
  clip_duration: ["clipDurationMs"],
  player_pixel_height: ["playerPixelHeightFraction"],
  player_visibility: ["playerMeanJointVisibility"],
};

/** Loose measurement record: the campaign deliberately injects near-legal values. */
export type LooseMeasurements = Partial<Record<MeasurementField, unknown>>;

export function isUsableNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

export function inBandModel(value: number, band: EnvelopeBand): boolean {
  if (band.min !== undefined && value < band.min) return false;
  if (band.max !== undefined && value > band.max) return false;
  return true;
}

export function expectedStatus(value: unknown, threshold: DimensionThreshold): EnvelopeStatus {
  if (!isUsableNumber(value)) return "NOT_MEASURED";
  if (inBandModel(value, threshold.supported)) return "SUPPORTED";
  if (inBandModel(value, threshold.degraded)) return "DEGRADED";
  return "UNSUPPORTED";
}

/** Value the evaluator should feed into classification for a dimension, per the contract. */
export function expectedMeasuredValue(dimension: EnvelopeDimension, m: LooseMeasurements): unknown {
  if (dimension === "resolution") {
    const w = m.frameWidthPx;
    const h = m.frameHeightPx;
    if (!isUsableNumber(w) || !isUsableNumber(h)) return null;
    return Math.min(w, h);
  }
  const [field] = DIMENSION_SOURCES[dimension];
  if (field === undefined) throw new Error(`no source for ${dimension}`);
  return m[field];
}

function hasNonFiniteNumber(value: unknown, path: string, out: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`non-finite number at ${path}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => hasNonFiniteNumber(item, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      hasNonFiniteNumber(item, `${path}.${key}`, out);
    }
  }
}

/**
 * Model-check one verdict against the contract. Returns a list of violated
 * invariants (empty = HELD).
 */
export function checkVerdict(m: LooseMeasurements, verdict: EnvelopeVerdict): string[] {
  const violations: string[] = [];

  if (verdict.thresholdsVersion !== CAPTURE_ENVELOPE_THRESHOLDS_VERSION) {
    violations.push(`thresholdsVersion ${verdict.thresholdsVersion} != exported constant`);
  }
  if (verdict.provisional !== CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL) {
    violations.push(`provisional ${String(verdict.provisional)} != exported constant`);
  }

  hasNonFiniteNumber(verdict, "verdict", violations);

  const emitted = verdict.dimensions.map((d) => d.dimension);
  if (stableJson(emitted) !== stableJson([...ENVELOPE_DIMENSIONS])) {
    violations.push(`dimension order/coverage mismatch: ${emitted.join(",")}`);
  }

  let worst: EnvelopeStatus = "SUPPORTED";
  const expectedNotMeasured: EnvelopeDimension[] = [];
  for (const entry of verdict.dimensions) {
    const threshold = CAPTURE_ENVELOPE_THRESHOLDS[entry.dimension];
    const oracleValue = expectedMeasuredValue(entry.dimension, m);
    const oracleStatus = expectedStatus(oracleValue, threshold);
    if (entry.status !== oracleStatus) {
      violations.push(
        `${entry.dimension}: status ${entry.status} but model expects ${oracleStatus} for value ${stableJson(oracleValue)}`,
      );
    }
    if (entry.thresholdId !== threshold.id) {
      violations.push(`${entry.dimension}: thresholdId ${entry.thresholdId} != ${threshold.id}`);
    }
    if (entry.unit !== threshold.unit) {
      violations.push(`${entry.dimension}: unit ${entry.unit} != ${threshold.unit}`);
    }
    if (oracleStatus === "NOT_MEASURED") {
      if (entry.measured !== null) {
        violations.push(
          `${entry.dimension}: NOT_MEASURED must carry measured=null, got ${stableJson(entry.measured)}`,
        );
      }
      expectedNotMeasured.push(entry.dimension);
    } else {
      if (entry.measured !== oracleValue) {
        violations.push(
          `${entry.dimension}: measured ${stableJson(entry.measured)} != model ${stableJson(oracleValue)}`,
        );
      }
      if (entry.status !== "NOT_MEASURED" && STATUS_RANK[entry.status] > STATUS_RANK[worst]) {
        worst = entry.status;
      }
    }
  }

  if (stableJson(verdict.notMeasured) !== stableJson(expectedNotMeasured)) {
    violations.push(
      `notMeasured ${verdict.notMeasured.join(",")} != model ${expectedNotMeasured.join(",")}`,
    );
  }
  if (verdict.overall !== worst) {
    violations.push(`overall ${verdict.overall} != worst measured ${worst}`);
  }
  const expectedCoverage =
    worst === "SUPPORTED" && expectedNotMeasured.length > 0 ? "SUPPORTED_UNMEASURED" : worst;
  if (verdict.overallWithCoverage !== expectedCoverage) {
    violations.push(
      `overallWithCoverage ${verdict.overallWithCoverage} != model ${expectedCoverage}`,
    );
  }
  return violations;
}

/**
 * Monotonicity contract for a single-sided band: for min-only thresholds a
 * larger value can never be worse; for max-only thresholds a larger value can
 * never be better. Two-sided bands are only checked through the oracle.
 */
export function bandShape(threshold: DimensionThreshold): "min" | "max" | "both" | "none" {
  const hasMin = threshold.supported.min !== undefined || threshold.degraded.min !== undefined;
  const hasMax = threshold.supported.max !== undefined || threshold.degraded.max !== undefined;
  if (hasMin && hasMax) return "both";
  if (hasMin) return "min";
  if (hasMax) return "max";
  return "none";
}
