import { deepStrictEqual as assertEquals, rejects as assertRejects } from "node:assert/strict";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "./canonicalDigest.ts";
import {
  readVerifiedReleasePolicy,
  eligibilityForVerifiedRelease,
  ReleasePolicyError,
} from "./releasePolicy.ts";
import type { AnalysisReleasePolicyDocument } from "../../../packages/shared-types/src/analysisReleasePolicy.ts";

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
const input = {
  shotType: "forehand_drive",
  cameraView: "side",
  handedness: "right",
  captureMode: "imported_video",
} as const;
const document: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "fixture-policy-1",
  validFrom: 100,
  validUntil: 1000,
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
  supportedInputs: [input],
};

async function authority() {
  return {
    document,
    canonicalDocument: canonicalizeOfflineJson(document),
    denyNewAuthorizations: false,
    approval: {
      policy: { version: document.version, sha256: await digestCanonicalOfflineJson(document) },
      mechanicsApprovedAt: 100,
      benchmarkApprovedAt: 100,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  };
}
Deno.test(
  "release authority: authentic canonical bytes resolve only a supported observed input",
  async () => {
    const data = await authority();
    const policy = await readVerifiedReleasePolicy(() => Promise.resolve({ data, error: null }));
    assertEquals(
      eligibilityForVerifiedRelease(
        policy,
        { ...input, source: "real", intentConfirmed: true },
        200,
      ).status,
      "eligible",
    );
    assertEquals(
      eligibilityForVerifiedRelease(
        policy,
        { ...input, source: "real", intentConfirmed: false },
        200,
      ).status,
      "ineligible",
    );
  },
);
Deno.test("release authority: no installed policy stays unavailable", async () => {
  assertEquals(
    await readVerifiedReleasePolicy(() =>
      Promise.resolve({
        data: { document: null, approval: null, denyNewAuthorizations: true },
        error: null,
      }),
    ),
    null,
  );
});
for (const corruption of [
  "digest",
  "document",
  "canonical",
  "switch",
  "storage",
  "missing",
  "model",
] as const) {
  Deno.test(`release authority: ${corruption} cannot become authorization`, async () => {
    const data = await authority();
    if (corruption === "digest") data.approval.policy.sha256 = "b".repeat(64);
    if (corruption === "document") data.document = { ...document, version: "tampered" };
    if (corruption === "canonical") data.canonicalDocument = JSON.stringify(document, null, 2);
    if (corruption === "switch") data.denyNewAuthorizations = true;
    if (corruption === "model")
      data.document = {
        ...document,
        mechanics: { lineage: { ...lineage, model: { ...artifact, version: "tampered" } } },
      };
    await assertRejects(
      () =>
        readVerifiedReleasePolicy(() =>
          Promise.resolve({
            data: corruption === "missing" ? null : data,
            error: corruption === "storage" ? { code: "database_error" } : null,
          }),
        ),
      ReleasePolicyError,
    );
  });
}
