import {
  ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY,
  isReleasedTechniqueBenchmark,
  isVerifiedEligibilityInput,
  validateAnalysisOutcome,
} from "./analysisOutcome.js";
import { fail, failure, ok, type Result } from "./errors.js";
import { numericalOutputLineagesEqual } from "./techniqueBenchmark.js";

/** The single definition of when an analysis outcome consumes a credit. Every
 * plane (mobile, Edge, SQL fixtures) decides through `decideChargeability` and
 * pins itself to `fixtures/chargeability/joint-chargeability-v1.json`.
 *
 * A credit is consumed only when BOTH the mechanics score AND the benchmark
 * range are independently validated AND durably delivered exactly once, bound
 * to an unconsumed ledger credit under an eligible release. Partial, failed,
 * withheld and replayed outcomes never consume a credit. Unknown or corrupt
 * input fails closed. {@link ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY} still
 * applies: this is consistency validation, not proof. */
export const JOINT_CHARGEABILITY_CONTRACT_VERSION = "joint-chargeability-v1" as const;
export const JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION =
  "joint-chargeability-fixtures-v1" as const;
export const CHARGEABILITY_TRUST_BOUNDARY = ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY;

export const CHARGEABLE_REASON_CODE = "both_outputs_validated_and_durably_delivered" as const;

export const NON_CHARGEABLE_REASON_CODES = [
  "outcome_invalid",
  "outcome_partial",
  "outcome_abstained",
  "outcome_not_durably_published",
  "eligibility_unverified",
  "binding_mismatch",
  "publication_not_verified_once",
  "credit_already_consumed",
  "release_ineligible",
  "lineage_mismatch",
  "benchmark_not_released",
] as const;

export type NonChargeableReasonCode = (typeof NON_CHARGEABLE_REASON_CODES)[number];
export type ChargeabilityReasonCode = typeof CHARGEABLE_REASON_CODE | NonChargeableReasonCode;

export type ChargeabilityDecision =
  | {
      contractVersion: typeof JOINT_CHARGEABILITY_CONTRACT_VERSION;
      chargeable: true;
      reasonCode: typeof CHARGEABLE_REASON_CODE;
      creditsConsumed: 1;
    }
  | {
      contractVersion: typeof JOINT_CHARGEABILITY_CONTRACT_VERSION;
      chargeable: false;
      reasonCode: NonChargeableReasonCode;
      creditsConsumed: 0;
    };

export const CHARGEABILITY_FIXTURE_CATEGORIES = [
  "chargeable",
  "partial",
  "failed",
  "withheld",
  "replayed",
] as const;

export type ChargeabilityFixtureCategory = (typeof CHARGEABILITY_FIXTURE_CATEGORIES)[number];

export interface ChargeabilityFixtureExpectation {
  chargeable: boolean;
  reasonCode: ChargeabilityReasonCode;
  creditsConsumed: 0 | 1;
}

export interface ChargeabilityFixtureCase {
  id: string;
  category: ChargeabilityFixtureCategory;
  description: string;
  outcome: unknown;
  eligibility: unknown;
  expected: ChargeabilityFixtureExpectation;
}

export interface ChargeabilityFixtureTable {
  schemaVersion: typeof JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION;
  contractVersion: typeof JOINT_CHARGEABILITY_CONTRACT_VERSION;
  description: string;
  cases: ChargeabilityFixtureCase[];
}

export function decideChargeability(
  rawOutcome: unknown,
  rawEligibility: unknown,
): ChargeabilityDecision {
  const parsed = validateAnalysisOutcome(rawOutcome);
  if (!parsed.ok) return notChargeable("outcome_invalid");
  const outcome = parsed.value;
  if (outcome.status === "partial") return notChargeable("outcome_partial");
  if (outcome.status === "abstained") return notChargeable("outcome_abstained");
  if (outcome.source !== "real") return notChargeable("outcome_invalid");
  const publication = outcome.publication;
  if (publication.status !== "durably_published") {
    return notChargeable("outcome_not_durably_published");
  }
  if (!isVerifiedEligibilityInput(rawEligibility)) return notChargeable("eligibility_unverified");
  const verified = rawEligibility;
  if (
    verified.binding.analysisId !== outcome.analysisId ||
    verified.binding.operationId !== outcome.operationId ||
    verified.binding.ownerId !== outcome.ownerId ||
    verified.binding.captureId !== outcome.captureId ||
    verified.binding.inputSha256 !== outcome.inputSha256 ||
    verified.binding.publicationId !== publication.publicationId
  ) {
    return notChargeable("binding_mismatch");
  }
  if (verified.publicationState !== "both_outputs_durably_published_once") {
    return notChargeable("publication_not_verified_once");
  }
  if (verified.creditState !== "unconsumed") return notChargeable("credit_already_consumed");
  const release = verified.releaseEligibility;
  if (release.status !== "eligible") return notChargeable("release_ineligible");
  const mechanicsLineage = outcome.mechanics.lineage;
  const benchmarkLineage = outcome.benchmark.lineage;
  if (
    !numericalOutputLineagesEqual(mechanicsLineage, release.mechanics.lineage) ||
    mechanicsLineage.pipeline.version !== benchmarkLineage.pipeline.version ||
    mechanicsLineage.pipeline.sha256 !== benchmarkLineage.pipeline.sha256 ||
    mechanicsLineage.policy.version !== benchmarkLineage.policy.version ||
    mechanicsLineage.policy.sha256 !== benchmarkLineage.policy.sha256
  ) {
    return notChargeable("lineage_mismatch");
  }
  if (!isReleasedTechniqueBenchmark(outcome.benchmark, release)) {
    return notChargeable("benchmark_not_released");
  }
  return {
    contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
    chargeable: true,
    reasonCode: CHARGEABLE_REASON_CODE,
    creditsConsumed: 1,
  };
}

/** Boolean view of {@link decideChargeability}. The eligibility argument is
 * the `IndependentlyVerifiedAnalysisEligibility` record but is typed `unknown`
 * so untrusted records fail closed instead of being cast. */
export function isChargeableAnalysis(
  raw: unknown,
  independentlyVerifiedEligibility: unknown,
): boolean {
  return decideChargeability(raw, independentlyVerifiedEligibility).chargeable;
}

/** Strict reader for the shared fixture table. Rejects any table whose
 * verdicts are internally inconsistent (a non-`chargeable` category marked
 * chargeable, credits that disagree with the verdict, unknown reason codes,
 * duplicate ids) so a drifting copy cannot be consumed by any plane. */
export function parseChargeabilityFixtureTable(raw: unknown): Result<ChargeabilityFixtureTable> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, ["schemaVersion", "contractVersion", "description", "cases"]) ||
    raw.schemaVersion !== JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION ||
    raw.contractVersion !== JOINT_CHARGEABILITY_CONTRACT_VERSION ||
    typeof raw.description !== "string" ||
    !Array.isArray(raw.cases) ||
    raw.cases.length === 0
  ) {
    return invalid("table", "Expected the versioned joint-chargeability fixture table.");
  }
  const ids = new Set<string>();
  const cases: ChargeabilityFixtureCase[] = [];
  for (const entry of raw.cases) {
    if (!isFixtureCase(entry)) {
      return invalid("case", "Every fixture case needs an id, category, inputs and a verdict.");
    }
    if (ids.has(entry.id)) return invalid("duplicate_id", `Duplicate fixture id ${entry.id}.`);
    if (!expectationMatchesCategory(entry)) {
      return invalid(
        "verdict",
        `Fixture ${entry.id}: verdict, credits and category must agree; only the chargeable category may charge.`,
      );
    }
    ids.add(entry.id);
    cases.push(entry);
  }
  return ok({
    schemaVersion: JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
    contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
    description: raw.description,
    cases,
  });
}

function expectationMatchesCategory(entry: ChargeabilityFixtureCase): boolean {
  const { chargeable, reasonCode, creditsConsumed } = entry.expected;
  if (chargeable) {
    return (
      entry.category === "chargeable" &&
      reasonCode === CHARGEABLE_REASON_CODE &&
      creditsConsumed === 1
    );
  }
  return (
    entry.category !== "chargeable" &&
    reasonCode !== CHARGEABLE_REASON_CODE &&
    creditsConsumed === 0
  );
}

function isFixtureCase(value: unknown): value is ChargeabilityFixtureCase {
  return (
    isRecord(value) &&
    hasExactFields(value, [
      "id",
      "category",
      "description",
      "outcome",
      "eligibility",
      "expected",
    ]) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.trim() === value.id &&
    typeof value.category === "string" &&
    (CHARGEABILITY_FIXTURE_CATEGORIES as readonly string[]).includes(value.category) &&
    typeof value.description === "string" &&
    isFixtureExpectation(value.expected)
  );
}

function isFixtureExpectation(value: unknown): value is ChargeabilityFixtureExpectation {
  return (
    isRecord(value) &&
    hasExactFields(value, ["chargeable", "reasonCode", "creditsConsumed"]) &&
    typeof value.chargeable === "boolean" &&
    typeof value.reasonCode === "string" &&
    (value.reasonCode === CHARGEABLE_REASON_CODE ||
      (NON_CHARGEABLE_REASON_CODES as readonly string[]).includes(value.reasonCode)) &&
    (value.creditsConsumed === 0 || value.creditsConsumed === 1)
  );
}

function notChargeable(reasonCode: NonChargeableReasonCode): ChargeabilityDecision {
  return {
    contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
    chargeable: false,
    reasonCode,
    creditsConsumed: 0,
  };
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
  return fail(failure("permanent", `chargeability.invalid_${code}`, message));
}
