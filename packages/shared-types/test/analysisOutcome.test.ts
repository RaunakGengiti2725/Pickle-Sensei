import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY,
  ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
  ANALYSIS_OUTCOME_SCHEMA_VERSION,
  MECHANICS_OUTPUT_SCHEMA_VERSION,
  TECHNIQUE_BENCHMARK_INTERPRETATION,
  TECHNIQUE_BENCHMARK_SCALE,
  TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
  isChargeableAnalysis,
  validateAnalysisOutcome,
  validateMechanicsOutput,
  type AnalysisOutcome,
  type IndependentlyVerifiedAnalysisEligibility,
  type NumericalOutputLineage,
} from "../src/index.js";

function lineage(output: "mechanics" | "benchmark"): NumericalOutputLineage {
  return {
    pipeline: { version: "contract-test-pipeline", sha256: "a".repeat(64) },
    definition: { version: `contract-test-${output}-definition`, sha256: "b".repeat(64) },
    model: { version: `contract-test-${output}-model`, sha256: "c".repeat(64) },
    preprocessing: { version: "contract-test-preprocessing", sha256: "d".repeat(64) },
    calibration: { version: `contract-test-${output}-calibration`, sha256: "e".repeat(64) },
    policy: { version: "contract-test-policy", sha256: "f".repeat(64) },
    dataset: { version: "contract-test-dataset", sha256: "1".repeat(64) },
    validationReport: { version: `contract-test-${output}-report`, sha256: "2".repeat(64) },
    supportedDomain: { version: "contract-test-domain", sha256: "3".repeat(64) },
  };
}

function outcome(): Extract<AnalysisOutcome, { status: "complete" }> {
  return {
    schemaVersion: ANALYSIS_OUTCOME_SCHEMA_VERSION,
    analysisId: "contract-test-analysis",
    operationId: "contract-test-operation",
    ownerId: "contract-test-owner",
    captureId: "contract-test-capture",
    inputSha256: "4".repeat(64),
    source: "real",
    status: "complete",
    billingDisposition: "joint_verification_required",
    publication: {
      status: "durably_published",
      publicationId: "contract-test-publication",
      publishedAtIso: "2026-08-29T12:00:00.000Z",
    },
    mechanics: {
      schemaVersion: MECHANICS_OUTPUT_SCHEMA_VERSION,
      scale: "mechanics_0_10",
      status: "validated_score",
      score: 7,
      lineage: lineage("mechanics"),
    },
    benchmark: {
      schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
      interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
      scale: TECHNIQUE_BENCHMARK_SCALE,
      status: "validated_range",
      interval: { lower: 3.5, upper: 4 },
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "marginal",
        calibrationUnit: "player_session",
      },
      lineage: lineage("benchmark"),
    },
  };
}

function eligibility(): IndependentlyVerifiedAnalysisEligibility {
  return {
    schemaVersion: ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
    verificationSource: "independent_release_authority_and_owner_ledger",
    binding: {
      analysisId: "contract-test-analysis",
      operationId: "contract-test-operation",
      ownerId: "contract-test-owner",
      captureId: "contract-test-capture",
      inputSha256: "4".repeat(64),
      publicationId: "contract-test-publication",
    },
    publicationState: "both_outputs_durably_published_once",
    creditState: "unconsumed",
    releaseEligibility: {
      status: "eligible",
      mechanics: { lineage: lineage("mechanics") },
      benchmark: {
        lineage: lineage("benchmark"),
        uncertainty: outcome().benchmark.uncertainty,
        maximumIntervalWidth: 1,
        boundaryStep: 0.5,
        supportedIntervals: [{ lower: 3, upper: 4.5 }],
      },
    },
  };
}

const withheldMechanics = {
  schemaVersion: "mechanics-output-v1",
  scale: "mechanics_0_10",
  status: "blocked_validation",
  reasonCodes: ["validation_not_approved"],
};
const withheldBenchmark = {
  schemaVersion: "technique-benchmark-v1",
  interpretation: "unofficial_single_swing_form_only",
  scale: "dupr_2_8",
  status: "blocked_validation",
  reasonCodes: ["validation_not_approved"],
};

describe("MechanicsOutput stays independently validated on its own 0–10 scale", () => {
  it.each([0, 2, 7, 8, 10])("accepts finite mechanics score %s without converting it", (score) => {
    const value = { ...outcome().mechanics, score };
    expect(validateMechanicsOutput(value)).toEqual({ ok: true, value });
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 10.01, "7", null])(
    "rejects invalid mechanics score %s",
    (score) => {
      expect(validateMechanicsOutput({ ...outcome().mechanics, score }).ok).toBe(false);
    },
  );

  it("requires lineage and rejects numbers hidden in withheld mechanics", () => {
    expect(validateMechanicsOutput(withheldMechanics).ok).toBe(true);
    expect(validateMechanicsOutput({ ...outcome().mechanics, lineage: undefined }).ok).toBe(false);
    expect(validateMechanicsOutput({ ...outcome().mechanics, scale: "dupr_2_8" }).ok).toBe(false);
    for (const extra of [
      { score: 7 },
      { score: null },
      { score: undefined },
      { confidence: 0.9 },
    ]) {
      expect(validateMechanicsOutput({ ...withheldMechanics, ...extra }).ok).toBe(false);
    }
  });
});

describe("AnalysisOutcome discriminants", () => {
  it("round-trips a complete claim without turning structural validity into billing approval", () => {
    const value = outcome();
    expect(validateAnalysisOutcome(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, value });
    expect(value.billingDisposition).toBe("joint_verification_required");
  });

  it("records either independently valid partial output but never a chargeable partial result", () => {
    for (const outputs of [
      { mechanics: outcome().mechanics, benchmark: withheldBenchmark },
      { mechanics: withheldMechanics, benchmark: outcome().benchmark },
    ]) {
      const value = {
        ...outcome(),
        ...outputs,
        status: "partial",
        billingDisposition: "not_chargeable",
      };
      expect(validateAnalysisOutcome(value).ok).toBe(true);
      expect(isChargeableAnalysis(value, eligibility())).toBe(false);
      expect(validateAnalysisOutcome({ ...value, status: "complete" }).ok).toBe(false);
      expect(
        validateAnalysisOutcome({ ...value, billingDisposition: "joint_verification_required" }).ok,
      ).toBe(false);
    }
  });

  it("represents abstention without numerical claims and refuses inconsistent output counts", () => {
    const value = {
      ...outcome(),
      status: "abstained",
      billingDisposition: "not_chargeable",
      mechanics: withheldMechanics,
      benchmark: withheldBenchmark,
    };
    expect(validateAnalysisOutcome(value).ok).toBe(true);
    expect(isChargeableAnalysis(value, eligibility())).toBe(false);
    expect(validateAnalysisOutcome({ ...value, status: "partial" }).ok).toBe(false);
    expect(validateAnalysisOutcome({ ...outcome(), status: "partial" }).ok).toBe(false);
    expect(validateAnalysisOutcome({ ...outcome(), status: "abstained" }).ok).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { ...outcome(), schemaVersion: "legacy" },
    { ...outcome(), ownerId: "" },
    { ...outcome(), inputSha256: "bad" },
    { ...outcome(), source: "fixture" },
    { ...outcome(), source: "synthetic" },
    { ...outcome(), billingDisposition: "chargeable" },
    { ...outcome(), overallScore: 7 },
    { ...outcome(), resultKind: "scored" },
    { ...outcome(), mechanics: { ...outcome().mechanics, score: NaN } },
    { ...outcome(), benchmark: { ...outcome().benchmark, interval: { lower: 4, upper: 3 } } },
    { ...outcome(), publication: { status: "not_published", publicationId: "fake" } },
    {
      ...outcome(),
      publication: { status: "durably_published", publicationId: "test", publishedAtIso: "bad" },
    },
    {
      ...outcome(),
      publication: {
        status: "durably_published",
        publicationId: "test",
        publishedAtIso: "2026-02-30T12:00:00.000Z",
      },
    },
  ])("rejects malformed, legacy or mismatched new-protocol payloads: %j", (value) => {
    expect(validateAnalysisOutcome(value).ok).toBe(false);
    expect(isChargeableAnalysis(value, eligibility())).toBe(false);
  });
});

describe("isChargeableAnalysis consistency predicate (test assertions, not cryptographic proof)", () => {
  it("requires both released outputs, real owned bytes, verified durable publication and an unused credit", () => {
    const value = outcome();
    const independent = eligibility();
    const before = JSON.stringify({ value, independent });
    expect(isChargeableAnalysis(value, independent)).toBe(true);
    expect(isChargeableAnalysis(JSON.parse(JSON.stringify(value)), independent)).toBe(true);
    expect(JSON.stringify({ value, independent })).toBe(before);
    expect(ANALYSIS_CHARGEABILITY_TRUST_BOUNDARY).toContain("not cryptographic proof");
  });

  it.each([
    undefined,
    null,
    true,
    { status: true },
    { status: "eligible" },
    { deploymentStatus: "production" },
    { ...eligibility(), releaseEligibility: null },
    { ...eligibility(), verificationSource: "client_payload" },
    { ...eligibility(), publicationState: "not_verified" },
    { ...eligibility(), creditState: "already_consumed" },
  ])("fails closed without independently supplied, complete verification inputs: %j", (input) => {
    expect(isChargeableAnalysis(outcome(), input as IndependentlyVerifiedAnalysisEligibility)).toBe(
      false,
    );
  });

  it.each(["unverified", "unreleased", "withdrawn", "expired", "unsupported", "lineage_mismatch"])(
    "never charges an ineligible release: %s",
    (reasonCode) => {
      const input = {
        ...eligibility(),
        releaseEligibility: { status: "ineligible", reasonCode },
      };
      expect(
        isChargeableAnalysis(outcome(), input as IndependentlyVerifiedAnalysisEligibility),
      ).toBe(false);
    },
  );

  it("checks every owner, operation, input and publication binding", () => {
    for (const key of Object.keys(eligibility().binding)) {
      const input = eligibility();
      Object.assign(input.binding, { [key]: key === "inputSha256" ? "5".repeat(64) : "other" });
      expect(isChargeableAnalysis(outcome(), input), key).toBe(false);
    }
    expect(
      isChargeableAnalysis(
        { ...outcome(), publication: { status: "not_published" } },
        eligibility(),
      ),
    ).toBe(false);
  });

  it("checks every independently approved lineage version and hash for BOTH outputs", () => {
    for (const output of ["mechanics", "benchmark"] as const) {
      for (const key of Object.keys(lineage(output)) as Array<keyof NumericalOutputLineage>) {
        for (const field of ["version", "sha256"] as const) {
          const input = eligibility();
          if (input.releaseEligibility.status !== "eligible") throw new Error("test setup");
          input.releaseEligibility[output].lineage[key][field] =
            field === "sha256" ? "9".repeat(64) : "other-version";
          expect(isChargeableAnalysis(outcome(), input), `${output}.${key}.${field}`).toBe(false);
        }
      }
    }
  });

  it.each([
    { maximumIntervalWidth: NaN },
    { maximumIntervalWidth: Infinity },
    { maximumIntervalWidth: 0 },
    { maximumIntervalWidth: 6 },
    { maximumIntervalWidth: 0.49 },
    { boundaryStep: NaN },
    { boundaryStep: Infinity },
    { boundaryStep: 0 },
    { boundaryStep: -0.5 },
    { boundaryStep: 6 },
    { boundaryStep: undefined },
    { supportedIntervals: [] },
    { supportedIntervals: [{ lower: 3.6, upper: 5 }] },
    {
      supportedIntervals: [
        { lower: 2, upper: 3.6 },
        { lower: 3.8, upper: 5 },
      ],
    },
    { supportedIntervals: [{ lower: 4, upper: 3 }] },
    { supportedIntervals: [{ lower: NaN, upper: 5 }] },
    { supportedIntervals: [{ lower: 1, upper: 8 }] },
    { uncertainty: { ...outcome().benchmark.uncertainty, nominalCoverage: 0.95 } },
    { uncertainty: { ...outcome().benchmark.uncertainty, coverageScope: "supported_slice" } },
  ])("requires useful width and support for the whole calibrated interval: %j", (override) => {
    const input = eligibility();
    if (input.releaseEligibility.status !== "eligible") throw new Error("test setup");
    Object.assign(input.releaseEligibility.benchmark, override);
    expect(isChargeableAnalysis(outcome(), input)).toBe(false);
  });

  it("requires the independently approved boundary granularity, not an almost-point estimate", () => {
    for (const interval of [
      { lower: 3.5, upper: 3.5000000001 },
      { lower: 3.50001, upper: 4 },
      { lower: 3.6, upper: 4.1 },
    ]) {
      const value = outcome();
      value.benchmark.interval = interval;
      expect(isChargeableAnalysis(value, eligibility())).toBe(false);
    }
    const value = outcome();
    value.benchmark.interval = { lower: 3.2, upper: 3.3 };
    const input = eligibility();
    if (input.releaseEligibility.status !== "eligible") throw new Error("test setup");
    input.releaseEligibility.benchmark.boundaryStep = 0.1;
    expect(isChargeableAnalysis(value, input)).toBe(true);
  });

  it("does not accept a matching benchmark without mechanics or vice versa", () => {
    for (const output of ["mechanics", "benchmark"] as const) {
      const input = eligibility();
      if (input.releaseEligibility.status !== "eligible") throw new Error("test setup");
      Reflect.deleteProperty(input.releaseEligibility, output);
      expect(isChargeableAnalysis(outcome(), input)).toBe(false);
    }
  });
});
