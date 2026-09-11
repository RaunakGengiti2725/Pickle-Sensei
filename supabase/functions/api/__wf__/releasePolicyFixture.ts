// Test-only ACTIVE release authority: what `read_analysis_release_policy()`
// returns once a policy is installed, both approvals are recorded and the
// deny switch is off (row shape of migration 20260908020000). Harnesses serve
// it by default so the chargeable routes behave as in a released production;
// tests that exercise a missing / withdrawn / corrupt authority override it.

import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";

const artifact = { version: "harness-1", sha256: "c".repeat(64) };
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

const ISSUED_AT = Math.floor(Date.now() / 1000) - 86_400;

export const HARNESS_RELEASE_POLICY: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "harness-policy-1",
  validFrom: ISSUED_AT,
  validUntil: ISSUED_AT + 365 * 86_400,
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
    { shotType: "dink", cameraView: "side", handedness: "right", captureMode: "imported_video" },
  ],
};

let row: Promise<Record<string, unknown>> | null = null;

/** The RPC row for an ACTIVE, approved, non-withdrawn harness policy. */
export function activeReleasePolicyRow(): Promise<Record<string, unknown>> {
  row ??= (async () => ({
    document: HARNESS_RELEASE_POLICY,
    canonicalDocument: canonicalizeOfflineJson(HARNESS_RELEASE_POLICY),
    denyNewAuthorizations: false,
    approval: {
      policy: {
        version: HARNESS_RELEASE_POLICY.version,
        sha256: await digestCanonicalOfflineJson(HARNESS_RELEASE_POLICY),
      },
      mechanicsApprovedAt: ISSUED_AT,
      benchmarkApprovedAt: ISSUED_AT,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  }))();
  return row;
}
