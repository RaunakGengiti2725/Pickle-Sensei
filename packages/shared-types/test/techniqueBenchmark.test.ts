import { describe, expect, expectTypeOf, it } from "vitest";
import {
  TECHNIQUE_BENCHMARK_INTERPRETATION,
  TECHNIQUE_BENCHMARK_SCALE,
  TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
  isNumericalOutputLineage,
  validateTechniqueBenchmark,
  type NumericalOutputLineage,
  type TechniqueBenchmark,
  type ValidatedTechniqueBenchmark,
} from "../src/index.js";

function lineage(): NumericalOutputLineage {
  return {
    pipeline: { version: "contract-test-pipeline", sha256: "a".repeat(64) },
    definition: { version: "contract-test-definition", sha256: "b".repeat(64) },
    model: { version: "contract-test-model", sha256: "c".repeat(64) },
    preprocessing: { version: "contract-test-preprocessing", sha256: "d".repeat(64) },
    calibration: { version: "contract-test-calibration", sha256: "e".repeat(64) },
    policy: { version: "contract-test-policy", sha256: "f".repeat(64) },
    dataset: { version: "contract-test-dataset", sha256: "1".repeat(64) },
    validationReport: { version: "contract-test-report", sha256: "2".repeat(64) },
    supportedDomain: { version: "contract-test-domain", sha256: "3".repeat(64) },
  };
}

function benchmark(): ValidatedTechniqueBenchmark {
  return {
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
    lineage: lineage(),
  };
}

const withheld = [
  { status: "blocked_validation", reasonCodes: ["validation_not_approved"] },
  { status: "unsupported", reasonCodes: ["technique_unsupported"] },
  { status: "insufficient_evidence", reasonCodes: ["calibration_support_missing"] },
] as const;

describe("TechniqueBenchmark contract (test payloads, not release evidence)", () => {
  it("round-trips one unofficial form-only range, never a player rating or per-format score", () => {
    const result = validateTechniqueBenchmark(JSON.parse(JSON.stringify(benchmark())));
    expect(result).toEqual({ ok: true, value: benchmark() });
    expect(TECHNIQUE_BENCHMARK_INTERPRETATION).toBe("unofficial_single_swing_form_only");
    expect(TECHNIQUE_BENCHMARK_SCALE).toBe("dupr_2_8");
  });

  it("narrows numerical fields to the validated-range discriminant", () => {
    type Range = Extract<TechniqueBenchmark, { status: "validated_range" }>;
    type Blocked = Extract<TechniqueBenchmark, { status: "blocked_validation" }>;
    expectTypeOf<Range["interval"]>().toEqualTypeOf<{ lower: number; upper: number }>();
    expectTypeOf<Blocked["interval"]>().toEqualTypeOf<undefined>();
  });

  it.each([
    { lower: 2, upper: 2.5 },
    { lower: 7.5, upper: 8 },
  ])("accepts supported scale endpoints without clipping: %j", (interval) => {
    expect(validateTechniqueBenchmark({ ...benchmark(), interval }).ok).toBe(true);
  });

  it.each([
    { lower: NaN, upper: 4 },
    { lower: 3.5, upper: NaN },
    { lower: -Infinity, upper: 4 },
    { lower: 3.5, upper: Infinity },
    { lower: 4, upper: 3.5 },
    { lower: 4, upper: 4 },
    { lower: 1.99, upper: 3 },
    { lower: 7, upper: 8.01 },
    { lower: 2, upper: 8 },
    { lower: "3.5", upper: 4 },
    { lower: 3.5, upper: 4, midpoint: 3.75 },
  ])("rejects invalid, point-like, vacuous or secretly extended intervals: %j", (interval) => {
    expect(validateTechniqueBenchmark({ ...benchmark(), interval }).ok).toBe(false);
  });

  it.each([NaN, Infinity, -0.1, 0, 1, 1.01, "0.9", null])(
    "rejects non-probabilistic nominal coverage %s",
    (nominalCoverage) => {
      expect(
        validateTechniqueBenchmark({
          ...benchmark(),
          uncertainty: { ...benchmark().uncertainty, nominalCoverage },
        }).ok,
      ).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { kind: "pose_confidence", nominalCoverage: 0.99 },
    { kind: "dupr_reliability", nominalCoverage: 0.99 },
    { ...benchmark().uncertainty, calibrationUnit: "frame" },
    { ...benchmark().uncertainty, coverageScope: "individual_guarantee" },
    { ...benchmark().uncertainty, poseConfidence: 0.99 },
    { ...benchmark().uncertainty, reliabilityScore: 90 },
  ])("requires calibrated, correctly scoped uncertainty: %j", (uncertainty) => {
    expect(validateTechniqueBenchmark({ ...benchmark(), uncertainty }).ok).toBe(false);
  });

  it("requires every version and exact artifact hash, with no unknown lineage fields", () => {
    expect(isNumericalOutputLineage(lineage())).toBe(true);
    for (const key of Object.keys(lineage()) as Array<keyof NumericalOutputLineage>) {
      const missing: Partial<NumericalOutputLineage> = lineage();
      delete missing[key];
      expect(validateTechniqueBenchmark({ ...benchmark(), lineage: missing }).ok, key).toBe(false);
      for (const artifact of [
        null,
        { version: "", sha256: "a".repeat(64) },
        { version: " ", sha256: "a".repeat(64) },
        { version: "test", sha256: "not-a-hash" },
        { version: "test", sha256: "A".repeat(64) },
        { version: "test", sha256: "a".repeat(64), approved: true },
      ]) {
        expect(
          validateTechniqueBenchmark({ ...benchmark(), lineage: { ...lineage(), [key]: artifact } })
            .ok,
          key,
        ).toBe(false);
      }
    }
    expect(
      validateTechniqueBenchmark({
        ...benchmark(),
        lineage: { ...lineage(), deploymentStatus: "production" },
      }).ok,
    ).toBe(false);
  });

  it.each(withheld)("accepts an explicitly withheld $status without numerical fields", (state) => {
    const value = {
      schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
      interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
      scale: TECHNIQUE_BENCHMARK_SCALE,
      ...state,
    };
    expect(validateTechniqueBenchmark(value)).toEqual({ ok: true, value });
    for (const field of [
      { interval: { lower: 3.5, upper: 4 } },
      { interval: null },
      { interval: undefined },
      { pointEstimate: 3.75 },
      { score: 7 },
      { uncertainty: benchmark().uncertainty },
      { lineage: lineage() },
      { debug: { level: 3.75 } },
      { reasonCodes: [3.75] },
      { reasonCodes: [] },
      { reasonCodes: new Array<string>(1) },
      { reasonCodes: Object.assign([...state.reasonCodes], { score: 3.75 }) },
      { reasonCodes: ["made_up_reason"] },
      { reasonCodes: [...state.reasonCodes, ...state.reasonCodes] },
    ]) {
      expect(validateTechniqueBenchmark({ ...value, ...field }).ok).toBe(false);
    }
  });

  it("rejects incompatible reason codes rather than treating every withheld status alike", () => {
    expect(
      validateTechniqueBenchmark({
        schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
        interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
        scale: TECHNIQUE_BENCHMARK_SCALE,
        status: "blocked_validation",
        reasonCodes: ["technique_unsupported"],
      }).ok,
    ).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { ...benchmark(), schemaVersion: "technique-benchmark-v0" },
    { ...benchmark(), status: "validated_point" },
    { ...benchmark(), status: true },
    { ...benchmark(), interpretation: "official_player_rating" },
    { ...benchmark(), scale: "mechanics_0_10" },
    { ...benchmark(), pointEstimate: 3.75 },
    { ...benchmark(), ratingType: "singles" },
    { ...benchmark(), playerRating: 4.2 },
    { ...benchmark(), singles: { lower: 3.5, upper: 4 } },
    { ...benchmark(), doubles: { lower: 4, upper: 4.5 } },
    { ...benchmark(), reasonCodes: [] },
  ])("rejects schema drift, runtime rating metadata and unsupported claims: %j", (value) => {
    expect(validateTechniqueBenchmark(value).ok).toBe(false);
  });
});
