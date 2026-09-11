import { fail, failure, ok, type Result } from "./errors.js";

export const TECHNIQUE_BENCHMARK_SCHEMA_VERSION = "technique-benchmark-v1" as const;
export const TECHNIQUE_BENCHMARK_INTERPRETATION = "unofficial_single_swing_form_only" as const;
export const TECHNIQUE_BENCHMARK_SCALE = "dupr_2_8" as const;

export interface VersionedArtifactReference {
  version: string;
  sha256: string;
}

const NUMERICAL_OUTPUT_LINEAGE_KEYS = [
  "pipeline",
  "definition",
  "model",
  "preprocessing",
  "calibration",
  "policy",
  "dataset",
  "validationReport",
  "supportedDomain",
] as const;

export type NumericalOutputLineage = {
  [Key in (typeof NUMERICAL_OUTPUT_LINEAGE_KEYS)[number]]: VersionedArtifactReference;
};

export const NUMERICAL_WITHHOLDING_REASONS = {
  blocked_validation: [
    "validation_not_approved",
    "release_policy_missing",
    "release_policy_expired",
    "release_policy_withdrawn",
    "lineage_unverified",
  ],
  unsupported: [
    "technique_unsupported",
    "capture_unsupported",
    "input_out_of_domain",
    "fixture_input",
  ],
  insufficient_evidence: [
    "form_not_observable",
    "uncertainty_not_useful",
    "calibration_support_missing",
    "interval_not_supported",
  ],
} as const;

export type NumericalWithholding = {
  [Status in keyof typeof NUMERICAL_WITHHOLDING_REASONS]: {
    status: Status;
    reasonCodes: readonly [
      (typeof NUMERICAL_WITHHOLDING_REASONS)[Status][number],
      ...(typeof NUMERICAL_WITHHOLDING_REASONS)[Status][number][],
    ];
  };
}[keyof typeof NUMERICAL_WITHHOLDING_REASONS];

export interface TechniqueBenchmarkInterval {
  lower: number;
  upper: number;
}

export interface TechniqueBenchmarkUncertainty {
  kind: "calibrated_prediction_interval";
  nominalCoverage: number;
  coverageScope: "marginal" | "supported_slice";
  calibrationUnit: "player_session";
}

interface TechniqueBenchmarkBase {
  schemaVersion: typeof TECHNIQUE_BENCHMARK_SCHEMA_VERSION;
  interpretation: typeof TECHNIQUE_BENCHMARK_INTERPRETATION;
  scale: typeof TECHNIQUE_BENCHMARK_SCALE;
}

export interface ValidatedTechniqueBenchmark extends TechniqueBenchmarkBase {
  status: "validated_range";
  interval: TechniqueBenchmarkInterval;
  uncertainty: TechniqueBenchmarkUncertainty;
  lineage: NumericalOutputLineage;
  reasonCodes?: never;
  pointEstimate?: never;
}

export type WithheldTechniqueBenchmark = TechniqueBenchmarkBase &
  NumericalWithholding & {
    interval?: never;
    uncertainty?: never;
    lineage?: never;
    pointEstimate?: never;
  };

export type TechniqueBenchmark = WithheldTechniqueBenchmark | ValidatedTechniqueBenchmark;

export function isVersionedArtifactReference(value: unknown): value is VersionedArtifactReference {
  return (
    isRecord(value) &&
    hasExactFields(value, ["version", "sha256"]) &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    value.version.length <= 128 &&
    value.version.trim() === value.version &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

export function isNumericalOutputLineage(value: unknown): value is NumericalOutputLineage {
  return (
    isRecord(value) &&
    hasExactFields(value, NUMERICAL_OUTPUT_LINEAGE_KEYS) &&
    NUMERICAL_OUTPUT_LINEAGE_KEYS.every((key) => isVersionedArtifactReference(value[key]))
  );
}

export function numericalOutputLineagesEqual(
  left: NumericalOutputLineage,
  right: NumericalOutputLineage,
): boolean {
  return NUMERICAL_OUTPUT_LINEAGE_KEYS.every(
    (key) => left[key].version === right[key].version && left[key].sha256 === right[key].sha256,
  );
}

export function isNumericalWithholding(value: unknown): value is NumericalWithholding {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["status", "reasonCodes"]) ||
    typeof value.status !== "string" ||
    !Object.hasOwn(NUMERICAL_WITHHOLDING_REASONS, value.status) ||
    !Array.isArray(value.reasonCodes)
  ) {
    return false;
  }
  const allowed: readonly string[] =
    NUMERICAL_WITHHOLDING_REASONS[value.status as keyof typeof NUMERICAL_WITHHOLDING_REASONS];
  return (
    value.reasonCodes.length > 0 &&
    value.reasonCodes.length <= allowed.length &&
    new Set(value.reasonCodes).size === value.reasonCodes.length &&
    Reflect.ownKeys(value.reasonCodes).length === value.reasonCodes.length + 1 &&
    Array.from(value.reasonCodes).every(
      (reason: unknown) => typeof reason === "string" && allowed.includes(reason),
    )
  );
}

export function isTechniqueBenchmarkInterval(value: unknown): value is TechniqueBenchmarkInterval {
  return (
    isRecord(value) &&
    hasExactFields(value, ["lower", "upper"]) &&
    typeof value.lower === "number" &&
    Number.isFinite(value.lower) &&
    typeof value.upper === "number" &&
    Number.isFinite(value.upper) &&
    value.lower >= 2 &&
    value.upper <= 8 &&
    value.lower < value.upper
  );
}

export function isTechniqueBenchmarkUncertainty(
  value: unknown,
): value is TechniqueBenchmarkUncertainty {
  return (
    isRecord(value) &&
    hasExactFields(value, ["kind", "nominalCoverage", "coverageScope", "calibrationUnit"]) &&
    value.kind === "calibrated_prediction_interval" &&
    typeof value.nominalCoverage === "number" &&
    Number.isFinite(value.nominalCoverage) &&
    value.nominalCoverage > 0 &&
    value.nominalCoverage < 1 &&
    (value.coverageScope === "marginal" || value.coverageScope === "supported_slice") &&
    value.calibrationUnit === "player_session"
  );
}

export function validateTechniqueBenchmark(raw: unknown): Result<TechniqueBenchmark> {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== TECHNIQUE_BENCHMARK_SCHEMA_VERSION ||
    raw.interpretation !== TECHNIQUE_BENCHMARK_INTERPRETATION ||
    raw.scale !== TECHNIQUE_BENCHMARK_SCALE
  ) {
    return invalid("schema", "Expected the versioned, unofficial single-swing technique contract.");
  }
  const baseFields = ["schemaVersion", "interpretation", "scale", "status"];
  if (raw.status === "validated_range") {
    if (!hasExactFields(raw, [...baseFields, "interval", "uncertainty", "lineage"])) {
      return invalid("fields", "A validated range must contain only the declared range fields.");
    }
    if (
      !isTechniqueBenchmarkInterval(raw.interval) ||
      raw.interval.upper - raw.interval.lower >= 6
    ) {
      return invalid(
        "interval",
        "Require finite 2–8 bounds with positive width below the full scale.",
      );
    }
    if (!isTechniqueBenchmarkUncertainty(raw.uncertainty)) {
      return invalid(
        "uncertainty",
        "Require calibrated, scoped interval uncertainty, not tracking or rating reliability.",
      );
    }
    if (!isNumericalOutputLineage(raw.lineage)) {
      return invalid("lineage", "Every numerical output requires exact versioned artifact hashes.");
    }
  } else if (
    !hasExactFields(raw, [...baseFields, "reasonCodes"]) ||
    !isNumericalWithholding({ status: raw.status, reasonCodes: raw.reasonCodes })
  ) {
    return invalid(
      "withholding",
      "A withheld result requires compatible reason codes and no numerical fields.",
    );
  }
  return ok(raw as unknown as TechniqueBenchmark);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key))
  );
}

function invalid(code: string, message: string): Result<never> {
  return fail(failure("permanent", `technique_benchmark.invalid_${code}`, message));
}
