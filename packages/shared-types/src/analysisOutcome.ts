import type { AnalysisSource } from "./domain.js";
import { fail, failure, ok, type Result } from "./errors.js";
import {
  isNumericalOutputLineage,
  isNumericalWithholding,
  isTechniqueBenchmarkInterval,
  isTechniqueBenchmarkUncertainty,
  numericalOutputLineagesEqual,
  validateTechniqueBenchmark,
  type NumericalOutputLineage,
  type NumericalWithholding,
  type TechniqueBenchmarkInterval,
  type TechniqueBenchmarkUncertainty,
  type ValidatedTechniqueBenchmark,
  type WithheldTechniqueBenchmark,
} from "./techniqueBenchmark.js";

export const MECHANICS_OUTPUT_SCHEMA_VERSION = "mechanics-output-v1" as const;
export const ANALYSIS_OUTCOME_SCHEMA_VERSION = "analysis-outcome-v1" as const;
export const ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION = "analysis-eligibility-input-v1" as const;
export const ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY =
  "Consistency only, not cryptographic proof: the caller must independently verify current release authority, supported observed input and confirmed intent, ownership, the exact durably published outputs, and atomic unconsumed-ledger state. Never construct eligibility from result status, deployment flags or untrusted client JSON.";

interface MechanicsOutputBase {
  schemaVersion: typeof MECHANICS_OUTPUT_SCHEMA_VERSION;
  scale: "mechanics_0_10";
}

export interface ValidatedMechanicsOutput extends MechanicsOutputBase {
  status: "validated_score";
  score: number;
  lineage: NumericalOutputLineage;
  reasonCodes?: never;
}

export type WithheldMechanicsOutput = MechanicsOutputBase &
  NumericalWithholding & {
    score?: never;
    lineage?: never;
  };

export type MechanicsOutput = ValidatedMechanicsOutput | WithheldMechanicsOutput;

export type AnalysisPublication =
  | { status: "not_published"; publicationId?: never; publishedAtIso?: never }
  | { status: "durably_published"; publicationId: string; publishedAtIso: string };

interface AnalysisOutcomeBase {
  schemaVersion: typeof ANALYSIS_OUTCOME_SCHEMA_VERSION;
  analysisId: string;
  operationId: string;
  ownerId: string;
  captureId: string;
  inputSha256: string;
  source: AnalysisSource;
  publication: AnalysisPublication;
}

export type AnalysisOutcome = AnalysisOutcomeBase &
  (
    | {
        status: "complete";
        mechanics: ValidatedMechanicsOutput;
        benchmark: ValidatedTechniqueBenchmark;
        billingDisposition: "joint_verification_required";
      }
    | ({
        status: "partial";
        billingDisposition: "not_chargeable";
      } & (
        | { mechanics: ValidatedMechanicsOutput; benchmark: WithheldTechniqueBenchmark }
        | { mechanics: WithheldMechanicsOutput; benchmark: ValidatedTechniqueBenchmark }
      ))
    | {
        status: "abstained";
        mechanics: WithheldMechanicsOutput;
        benchmark: WithheldTechniqueBenchmark;
        billingDisposition: "not_chargeable";
      }
  );

export type AnalysisReleaseEligibility =
  | {
      status: "ineligible";
      reasonCode:
        "unverified" | "unreleased" | "withdrawn" | "expired" | "unsupported" | "lineage_mismatch";
    }
  | {
      status: "eligible";
      mechanics: { lineage: NumericalOutputLineage };
      benchmark: {
        lineage: NumericalOutputLineage;
        uncertainty: TechniqueBenchmarkUncertainty;
        maximumIntervalWidth: number;
        boundaryStep: number;
        supportedIntervals: TechniqueBenchmarkInterval[];
      };
    };

export interface IndependentlyVerifiedAnalysisEligibility {
  schemaVersion: typeof ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION;
  verificationSource: "independent_release_authority_and_owner_ledger";
  binding: {
    analysisId: string;
    operationId: string;
    ownerId: string;
    captureId: string;
    inputSha256: string;
    publicationId: string;
  };
  publicationState: "both_outputs_durably_published_once" | "not_verified";
  creditState: "unconsumed" | "already_consumed";
  releaseEligibility: AnalysisReleaseEligibility;
}

export function validateMechanicsOutput(raw: unknown): Result<MechanicsOutput> {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== MECHANICS_OUTPUT_SCHEMA_VERSION ||
    raw.scale !== "mechanics_0_10"
  ) {
    return invalid("mechanics_schema", "Expected a versioned, separate mechanics output.");
  }
  const baseFields = ["schemaVersion", "scale", "status"];
  if (raw.status === "validated_score") {
    if (
      !hasExactFields(raw, [...baseFields, "score", "lineage"]) ||
      typeof raw.score !== "number" ||
      !Number.isFinite(raw.score) ||
      raw.score < 0 ||
      raw.score > 10 ||
      !isNumericalOutputLineage(raw.lineage)
    ) {
      return invalid(
        "mechanics_score",
        "Require a finite 0–10 mechanics score with complete lineage.",
      );
    }
  } else if (
    !hasExactFields(raw, [...baseFields, "reasonCodes"]) ||
    !isNumericalWithholding({ status: raw.status, reasonCodes: raw.reasonCodes })
  ) {
    return invalid(
      "mechanics_withholding",
      "Withheld mechanics must have reason codes and no numerical fields.",
    );
  }
  return ok(raw as unknown as MechanicsOutput);
}

export function validateAnalysisOutcome(raw: unknown): Result<AnalysisOutcome> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, [
      "schemaVersion",
      "analysisId",
      "operationId",
      "ownerId",
      "captureId",
      "inputSha256",
      "source",
      "status",
      "billingDisposition",
      "publication",
      "mechanics",
      "benchmark",
    ]) ||
    raw.schemaVersion !== ANALYSIS_OUTCOME_SCHEMA_VERSION ||
    ![raw.analysisId, raw.operationId, raw.ownerId, raw.captureId].every(isIdentifier) ||
    typeof raw.inputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.inputSha256) ||
    (raw.source !== "real" && raw.source !== "fixture") ||
    !isAnalysisPublication(raw.publication)
  ) {
    return invalid(
      "schema",
      "Require a versioned owner-bound outcome and explicit publication state.",
    );
  }
  const mechanics = validateMechanicsOutput(raw.mechanics);
  if (!mechanics.ok) return mechanics;
  const benchmark = validateTechniqueBenchmark(raw.benchmark);
  if (!benchmark.ok) return benchmark;
  const numericalCount =
    Number(mechanics.value.status === "validated_score") +
    Number(benchmark.value.status === "validated_range");
  if (raw.source !== "real" && numericalCount !== 0) {
    return invalid("source", "Fixture inputs cannot claim validated numerical outputs.");
  }
  const expectedStatus =
    numericalCount === 2 ? "complete" : numericalCount === 1 ? "partial" : "abstained";
  const expectedBilling = numericalCount === 2 ? "joint_verification_required" : "not_chargeable";
  if (raw.status !== expectedStatus || raw.billingDisposition !== expectedBilling) {
    return invalid(
      "disposition",
      "Completion and billing disposition must match both output variants.",
    );
  }
  return ok(raw as unknown as AnalysisOutcome);
}

/** Publication uses the same approved boundaries and lineage as charging.
 * Release eligibility must come from verified authority, never client status. */
export function isReleasedTechniqueBenchmark(
  raw: unknown,
  release: AnalysisReleaseEligibility | null | undefined,
): raw is ValidatedTechniqueBenchmark {
  const parsed = validateTechniqueBenchmark(raw);
  if (
    !parsed.ok ||
    parsed.value.status !== "validated_range" ||
    !isAnalysisReleaseEligibility(release) ||
    release.status !== "eligible"
  )
    return false;
  const benchmark = parsed.value;
  const uncertainty = benchmark.uncertainty;
  const approvedUncertainty = release.benchmark.uncertainty;
  const interval = benchmark.interval;
  return (
    numericalOutputLineagesEqual(benchmark.lineage, release.benchmark.lineage) &&
    uncertainty.nominalCoverage === approvedUncertainty.nominalCoverage &&
    uncertainty.coverageScope === approvedUncertainty.coverageScope &&
    intervalUsesApprovedBoundaries(interval, release.benchmark.boundaryStep) &&
    interval.upper - interval.lower <=
      release.benchmark.maximumIntervalWidth + Number.EPSILON * 16 &&
    release.benchmark.supportedIntervals.some(
      (supported) => interval.lower >= supported.lower && interval.upper <= supported.upper,
    )
  );
}

function intervalUsesApprovedBoundaries(
  interval: TechniqueBenchmarkInterval,
  step: number,
): boolean {
  const lower = (interval.lower - 2) / step;
  const upper = (interval.upper - 2) / step;
  const lowerIndex = Math.round(lower);
  const upperIndex = Math.round(upper);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(lower), Math.abs(upper)) * 4;
  return (
    Number.isSafeInteger(lowerIndex) &&
    Number.isSafeInteger(upperIndex) &&
    lowerIndex < upperIndex &&
    Math.abs(lower - lowerIndex) <= tolerance &&
    Math.abs(upper - upperIndex) <= tolerance
  );
}

export function isVerifiedEligibilityInput(
  value: unknown,
): value is IndependentlyVerifiedAnalysisEligibility {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "schemaVersion",
      "verificationSource",
      "binding",
      "publicationState",
      "creditState",
      "releaseEligibility",
    ]) ||
    value.schemaVersion !== ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION ||
    value.verificationSource !== "independent_release_authority_and_owner_ledger" ||
    !isRecord(value.binding) ||
    !hasExactFields(value.binding, [
      "analysisId",
      "operationId",
      "ownerId",
      "captureId",
      "inputSha256",
      "publicationId",
    ]) ||
    !Object.values(value.binding).every(isIdentifier) ||
    typeof value.binding.inputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.binding.inputSha256) ||
    (value.publicationState !== "both_outputs_durably_published_once" &&
      value.publicationState !== "not_verified") ||
    (value.creditState !== "unconsumed" && value.creditState !== "already_consumed")
  ) {
    return false;
  }
  return isAnalysisReleaseEligibility(value.releaseEligibility);
}

export function isAnalysisReleaseEligibility(
  release: unknown,
): release is AnalysisReleaseEligibility {
  if (!isRecord(release)) return false;
  if (release.status === "ineligible") {
    return (
      hasExactFields(release, ["status", "reasonCode"]) &&
      [
        "unverified",
        "unreleased",
        "withdrawn",
        "expired",
        "unsupported",
        "lineage_mismatch",
      ].includes(release.reasonCode as string)
    );
  }
  return (
    release.status === "eligible" &&
    hasExactFields(release, ["status", "mechanics", "benchmark"]) &&
    isRecord(release.mechanics) &&
    hasExactFields(release.mechanics, ["lineage"]) &&
    isNumericalOutputLineage(release.mechanics.lineage) &&
    isRecord(release.benchmark) &&
    hasExactFields(release.benchmark, [
      "lineage",
      "uncertainty",
      "maximumIntervalWidth",
      "boundaryStep",
      "supportedIntervals",
    ]) &&
    isNumericalOutputLineage(release.benchmark.lineage) &&
    isTechniqueBenchmarkUncertainty(release.benchmark.uncertainty) &&
    typeof release.benchmark.maximumIntervalWidth === "number" &&
    Number.isFinite(release.benchmark.maximumIntervalWidth) &&
    release.benchmark.maximumIntervalWidth > 0 &&
    release.benchmark.maximumIntervalWidth < 6 &&
    typeof release.benchmark.boundaryStep === "number" &&
    Number.isFinite(release.benchmark.boundaryStep) &&
    release.benchmark.boundaryStep > 0 &&
    release.benchmark.boundaryStep <= release.benchmark.maximumIntervalWidth &&
    Array.isArray(release.benchmark.supportedIntervals) &&
    release.benchmark.supportedIntervals.length > 0 &&
    release.benchmark.supportedIntervals.length <= 256 &&
    Array.from(release.benchmark.supportedIntervals).every(isTechniqueBenchmarkInterval)
  );
}

function isAnalysisPublication(value: unknown): value is AnalysisPublication {
  if (!isRecord(value)) return false;
  if (value.status === "not_published") return hasExactFields(value, ["status"]);
  return (
    value.status === "durably_published" &&
    hasExactFields(value, ["status", "publicationId", "publishedAtIso"]) &&
    isIdentifier(value.publicationId) &&
    isIsoInstant(value.publishedAtIso)
  );
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  return (
    match !== null &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
  );
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
  return fail(failure("permanent", `analysis_outcome.invalid_${code}`, message));
}
