import { describe, expect, it } from "vitest";
import {
  resolveAnalysisReleaseEligibility,
  validateAnalysisReleasePolicy,
  type AnalysisReleasePolicyDocument,
  type AnalysisReleaseApproval,
  type ObservedAnalysisReleaseInput,
} from "../src/analysisReleasePolicy.js";

const artifact = { version: "fixture-1", sha256: "a".repeat(64) };
const lineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};
const policy: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "fixture-policy-1",
  validFrom: 1_788_768_000,
  validUntil: 1_791_360_000,
  mechanics: { lineage },
  benchmark: {
    lineage,
    uncertainty: {
      kind: "calibrated_prediction_interval",
      nominalCoverage: 0.9,
      coverageScope: "supported_slice",
      calibrationUnit: "player_session",
    },
    maximumIntervalWidth: 1.5,
    boundaryStep: 0.25,
    supportedIntervals: [{ lower: 3, upper: 5 }],
  },
  supportedInputs: [
    {
      shotType: "forehand_drive",
      cameraView: "side",
      handedness: "right",
      captureMode: "imported_video",
    },
  ],
};
const input: ObservedAnalysisReleaseInput = {
  ...policy.supportedInputs[0]!,
  source: "real",
  intentConfirmed: true,
};
const approval: AnalysisReleaseApproval = {
  policy: { version: policy.version, sha256: "b".repeat(64) },
  mechanicsApprovedAt: policy.validFrom,
  benchmarkApprovedAt: policy.validFrom,
  withdrawnAt: null,
  denyNewAuthorizations: false,
};
const now = policy.validFrom + 1;

describe("release policy authority", () => {
  it("joins independently approved outputs to the exact content-addressed policy", () => {
    expect(validateAnalysisReleasePolicy(policy)).toBe(true);
    expect(resolveAnalysisReleaseEligibility(policy, approval, input, now)).toEqual({
      status: "eligible",
      mechanics: { lineage: { ...lineage, policy: approval.policy } },
      benchmark: { ...policy.benchmark, lineage: { ...lineage, policy: approval.policy } },
    });
  });
  it.each([
    null,
    undefined,
    {},
    { ...approval, benchmarkApprovedAt: null },
    { ...approval, mechanicsApprovedAt: null },
  ])("does not infer missing approval from deployment or valid model metadata: %j", (state) => {
    expect(resolveAnalysisReleaseEligibility(policy, state, input, now).status).toBe("ineligible");
  });
  it.each([policy.validFrom - 1, policy.validUntil, policy.validUntil + 1, NaN, Infinity])(
    "rejects invalid or out-of-window time %s",
    (at) => {
      expect(resolveAnalysisReleaseEligibility(policy, approval, input, at).status).toBe(
        "ineligible",
      );
    },
  );
  it("withdrawal and deny-new both stop issuance, without modifying historical policy bytes", () => {
    expect(
      resolveAnalysisReleaseEligibility(policy, { ...approval, withdrawnAt: now }, input, now),
    ).toEqual({ status: "ineligible", reasonCode: "withdrawn" });
    expect(
      resolveAnalysisReleaseEligibility(
        policy,
        { ...approval, denyNewAuthorizations: true },
        input,
        now,
      ).status,
    ).toBe("ineligible");
    expect(
      resolveAnalysisReleaseEligibility(
        policy,
        { ...approval, mechanicsApprovedAt: now + 1 },
        input,
        now,
      ).status,
    ).toBe("ineligible");
  });
  it.each([
    { shotType: "backhand_drive" },
    { cameraView: "rear_oblique" },
    { handedness: "left" },
    { captureMode: "automatic_pose_trigger" },
    { source: "fixture" },
    { intentConfirmed: false },
  ])("requires supported observed input and confirmed intent %j", (change) => {
    expect(
      resolveAnalysisReleaseEligibility(policy, approval, { ...input, ...change }, now),
    ).toEqual({ status: "ineligible", reasonCode: "unsupported" });
  });
  it("rejects an approval for another policy version", () => {
    expect(
      resolveAnalysisReleaseEligibility(
        policy,
        { ...approval, policy: { ...approval.policy, version: "other" } },
        input,
        now,
      ),
    ).toEqual({ status: "ineligible", reasonCode: "lineage_mismatch" });
  });
  it.each([
    null,
    {},
    { ...policy, validUntil: policy.validFrom },
    { ...policy, supportedInputs: [] },
    { ...policy, supportedInputs: [input] },
    { ...policy, mechanics: { lineage: { ...lineage, policy: artifact } } },
    { ...policy, benchmark: { ...policy.benchmark, maximumIntervalWidth: 6 } },
    { ...policy, benchmark: { ...policy.benchmark, boundaryStep: 0 } },
    {
      ...policy,
      benchmark: {
        ...policy.benchmark,
        lineage: { ...lineage, pipeline: { ...artifact, version: "different" } },
      },
    },
  ])("rejects a malformed or inconsistent policy %j", (value) => {
    expect(validateAnalysisReleasePolicy(value)).toBe(false);
  });
});
