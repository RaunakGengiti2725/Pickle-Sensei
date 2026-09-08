// Adversarial tests for W01-04 (candidate 654695aa): the Edge release authority
// verdict is the only source of `releaseEligibility`, so clock boundaries,
// clock rollback and corrupt authority rows must all end in a non-chargeable
// decision of the shared contract. Every assertion is the SECURE expectation.
//   (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_joint_chargeability_clock.test.ts)

import { assert, assertEquals } from "@std/assert";
import {
  CHARGEABLE_REASON_CODE,
  decideChargeability,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  NON_CHARGEABLE_REASON_CODES,
} from "../../../../packages/shared-types/src/chargeability.ts";
import type { IndependentlyVerifiedAnalysisEligibility } from "../../../../packages/shared-types/src/analysisOutcome.ts";
import type { ObservedAnalysisReleaseInput } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import type { AnalysisReleaseEligibility } from "../../../../packages/shared-types/src/analysisOutcome.ts";
import {
  eligibilityForVerifiedRelease,
  readVerifiedReleasePolicy,
  ReleasePolicyError,
  type VerifiedReleasePolicy,
} from "../releasePolicy.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";

const INPUT = {
  shotType: "dink",
  cameraView: "side",
  handedness: "right",
  captureMode: "imported_video",
  source: "real",
  intentConfirmed: true,
} as const;

const BINDING = {
  analysisId: "attack-analysis-1",
  operationId: "attack-operation-1",
  ownerId: "attack-owner-1",
  captureId: "attack-capture-1",
  inputSha256: "5".repeat(64),
  publicationId: "attack-publication-1",
};

async function verifiedPolicy(): Promise<VerifiedReleasePolicy> {
  const policy = await readVerifiedReleasePolicy(async () => ({
    data: await activeReleasePolicyRow(),
    error: null,
  }));
  if (policy === null) throw new Error("harness policy must be active");
  return policy;
}

function eligibilityFrom(
  releaseEligibility: AnalysisReleaseEligibility,
): IndependentlyVerifiedAnalysisEligibility {
  return {
    schemaVersion: "analysis-eligibility-input-v1",
    verificationSource: "independent_release_authority_and_owner_ledger",
    binding: BINDING,
    publicationState: "both_outputs_durably_published_once",
    creditState: "unconsumed",
    releaseEligibility,
  };
}

function completeOutcome(
  release: Extract<AnalysisReleaseEligibility, { status: "eligible" }>,
): Record<string, unknown> {
  return {
    schemaVersion: "analysis-outcome-v1",
    analysisId: BINDING.analysisId,
    operationId: BINDING.operationId,
    ownerId: BINDING.ownerId,
    captureId: BINDING.captureId,
    inputSha256: BINDING.inputSha256,
    source: "real",
    status: "complete",
    billingDisposition: "joint_verification_required",
    publication: {
      status: "durably_published",
      publicationId: BINDING.publicationId,
      publishedAtIso: "2026-09-08T12:00:00.000Z",
    },
    mechanics: {
      schemaVersion: "mechanics-output-v1",
      scale: "mechanics_0_10",
      status: "validated_score",
      score: 6.5,
      lineage: release.mechanics.lineage,
    },
    benchmark: {
      schemaVersion: "technique-benchmark-v1",
      interpretation: "unofficial_single_swing_form_only",
      scale: "dupr_2_8",
      status: "validated_range",
      interval: { lower: 3.5, upper: 4.25 },
      uncertainty: HARNESS_RELEASE_POLICY.benchmark.uncertainty,
      lineage: release.benchmark.lineage,
    },
  };
}

function assertDenied(decision: ReturnType<typeof decideChargeability>, label: string): void {
  assertEquals(decision.chargeable, false, label);
  assertEquals(decision.creditsConsumed, 0, label);
  assertEquals(decision.contractVersion, JOINT_CHARGEABILITY_CONTRACT_VERSION, label);
  assert(
    (NON_CHARGEABLE_REASON_CODES as readonly string[]).includes(decision.reasonCode),
    `${label}: ${decision.reasonCode}`,
  );
}

Deno.test("control: inside the validity window the harness release charges exactly once", async () => {
  const policy = await verifiedPolicy();
  const now = HARNESS_RELEASE_POLICY.validFrom + 60;
  const release = eligibilityForVerifiedRelease(policy, INPUT, now);
  assertEquals(release.status, "eligible");
  if (release.status !== "eligible") return;
  const decision = decideChargeability(completeOutcome(release), eligibilityFrom(release));
  assertEquals(decision, {
    contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
    chargeable: true,
    reasonCode: CHARGEABLE_REASON_CODE,
    creditsConsumed: 1,
  });
});

Deno.test("clock boundaries: validFrom-1, validUntil, far future, far past, NaN, negative never charge", async () => {
  const policy = await verifiedPolicy();
  const inWindow = eligibilityForVerifiedRelease(
    policy,
    INPUT,
    HARNESS_RELEASE_POLICY.validFrom + 60,
  );
  if (inWindow.status !== "eligible") throw new Error("control release must be eligible");
  const outcome = completeOutcome(inWindow);
  const clocks: Array<[string, number]> = [
    ["validFrom - 1", HARNESS_RELEASE_POLICY.validFrom - 1],
    ["validUntil (exclusive)", HARNESS_RELEASE_POLICY.validUntil],
    ["validUntil + 1", HARNESS_RELEASE_POLICY.validUntil + 1],
    ["far future", 4_102_444_800 * 1000],
    ["epoch", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["fractional before validFrom", HARNESS_RELEASE_POLICY.validFrom - 0.5],
    ["milliseconds mistaken for seconds", HARNESS_RELEASE_POLICY.validFrom * 1000],
  ];
  for (const [label, now] of clocks) {
    const release = eligibilityForVerifiedRelease(policy, INPUT, now);
    assertEquals(release.status, "ineligible", label);
    assertDenied(decideChargeability(outcome, eligibilityFrom(release)), label);
  }
});

Deno.test("clock rollback: a device clock behind the approval instants never charges", async () => {
  const policy = await verifiedPolicy();
  const approvedAt = policy.approval.mechanicsApprovedAt;
  if (typeof approvedAt !== "number") throw new Error("harness approval must be timestamped");
  const rolledBack = eligibilityForVerifiedRelease(policy, INPUT, approvedAt - 1);
  assertEquals(rolledBack.status, "ineligible");
  const control = eligibilityForVerifiedRelease(policy, INPUT, approvedAt + 1);
  if (control.status !== "eligible") throw new Error("control release must be eligible");
  const outcome = completeOutcome(control);
  const decision = decideChargeability(outcome, eligibilityFrom(rolledBack));
  assertDenied(decision, "rolled back clock");
  assertEquals(decision.reasonCode, "release_ineligible");
});

Deno.test("withdrawal boundary: withdrawnAt <= now denies, even one second after approval", async () => {
  const policy = await verifiedPolicy();
  const now = HARNESS_RELEASE_POLICY.validFrom + 60;
  const control = eligibilityForVerifiedRelease(policy, INPUT, now);
  if (control.status !== "eligible") throw new Error("control release must be eligible");
  const outcome = completeOutcome(control);
  for (const withdrawnAt of [now, now - 1, HARNESS_RELEASE_POLICY.validFrom, 0]) {
    const withdrawn = eligibilityForVerifiedRelease(
      { ...policy, approval: { ...policy.approval, withdrawnAt } },
      INPUT,
      now,
    );
    assertEquals(withdrawn.status, "ineligible", `withdrawnAt=${withdrawnAt}`);
    assertDenied(
      decideChargeability(outcome, eligibilityFrom(withdrawn)),
      `withdrawnAt=${withdrawnAt}`,
    );
  }
  const denySwitch = eligibilityForVerifiedRelease(
    { ...policy, approval: { ...policy.approval, denyNewAuthorizations: true } },
    INPUT,
    now,
  );
  assertDenied(decideChargeability(outcome, eligibilityFrom(denySwitch)), "denyNewAuthorizations");
});

Deno.test("a release verdict from one policy version never charges an outcome produced under another", async () => {
  const policy = await verifiedPolicy();
  const now = HARNESS_RELEASE_POLICY.validFrom + 60;
  const control = eligibilityForVerifiedRelease(policy, INPUT, now);
  if (control.status !== "eligible") throw new Error("control release must be eligible");
  const outcome = completeOutcome(control);
  const rotated: AnalysisReleaseEligibility = {
    ...control,
    mechanics: {
      lineage: {
        ...control.mechanics.lineage,
        policy: { version: "harness-policy-2", sha256: control.mechanics.lineage.policy.sha256 },
      },
    },
    benchmark: {
      ...control.benchmark,
      lineage: {
        ...control.benchmark.lineage,
        policy: { version: "harness-policy-2", sha256: control.benchmark.lineage.policy.sha256 },
      },
    },
  };
  const decision = decideChargeability(outcome, eligibilityFrom(rotated));
  assertDenied(decision, "rotated policy version");
  assertEquals(decision.reasonCode, "lineage_mismatch");
});

Deno.test("unsupported or unconfirmed observed input never charges", async () => {
  const policy = await verifiedPolicy();
  const now = HARNESS_RELEASE_POLICY.validFrom + 60;
  const control = eligibilityForVerifiedRelease(policy, INPUT, now);
  if (control.status !== "eligible") throw new Error("control release must be eligible");
  const outcome = completeOutcome(control);
  const variants: Array<[string, Record<string, unknown>]> = [
    ["fixture source", { ...INPUT, source: "fixture" }],
    ["intent not confirmed", { ...INPUT, intentConfirmed: false }],
    ["intent as string", { ...INPUT, intentConfirmed: "true" }],
    ["unsupported shot type", { ...INPUT, shotType: "serve" }],
    ["unsupported camera", { ...INPUT, cameraView: "front" }],
    ["left handed", { ...INPUT, handedness: "left" }],
    ["live capture", { ...INPUT, captureMode: "live_camera" }],
    ["extra key", { ...INPUT, sessionId: "x" }],
  ];
  for (const [label, observed] of variants) {
    // Hostile client input is untyped at the network boundary; the authority must reject it.
    const release = eligibilityForVerifiedRelease(
      policy,
      observed as unknown as ObservedAnalysisReleaseInput,
      now,
    );
    assertEquals(release.status, "ineligible", label);
    assertDenied(decideChargeability(outcome, eligibilityFrom(release)), label);
  }
});

Deno.test("corrupt authority rows fail closed: tampered canonical document, digest or version", async () => {
  const row = await activeReleasePolicyRow();
  const approval = row.approval as Record<string, unknown>;
  const policyRef = approval.policy as Record<string, unknown>;
  const corruptRows: Array<[string, Record<string, unknown>]> = [
    ["digest mismatch", {
      ...row,
      approval: { ...approval, policy: { ...policyRef, sha256: "0".repeat(64) } },
    }],
    ["version mismatch", {
      ...row,
      approval: { ...approval, policy: { ...policyRef, version: "harness-policy-9" } },
    }],
    ["canonical document drift", {
      ...row,
      canonicalDocument: `${String(row.canonicalDocument)} `,
    }],
    [
      "document validity widened after approval",
      {
        ...row,
        document: {
          ...HARNESS_RELEASE_POLICY,
          validUntil: HARNESS_RELEASE_POLICY.validUntil + 86_400,
        },
      },
    ],
    ["deny flag disagreement", { ...row, denyNewAuthorizations: true }],
    ["approval missing", { ...row, approval: null }],
    ["document missing", { ...row, document: null }],
    ["empty row", {}],
  ];
  for (const [label, data] of corruptRows) {
    try {
      const policy = await readVerifiedReleasePolicy(() => Promise.resolve({ data, error: null }));
      const release = eligibilityForVerifiedRelease(
        policy,
        INPUT,
        HARNESS_RELEASE_POLICY.validFrom + 60,
      );
      assertEquals(release.status, "ineligible", label);
    } catch (error) {
      assert(error instanceof ReleasePolicyError, `${label}: unexpected ${String(error)}`);
    }
  }
});

Deno.test("an unavailable authority (storage error) is never eligibility", async () => {
  let threw = false;
  try {
    await readVerifiedReleasePolicy(() =>
      Promise.resolve({ data: null, error: { message: "timeout", code: "57014" } })
    );
  } catch (error) {
    threw = error instanceof ReleasePolicyError;
  }
  assert(threw, "storage error must surface as ReleasePolicyError, not a verdict");
  const nullPolicy = eligibilityForVerifiedRelease(
    null,
    INPUT,
    HARNESS_RELEASE_POLICY.validFrom + 60,
  );
  assertEquals(nullPolicy.status, "ineligible");
});
