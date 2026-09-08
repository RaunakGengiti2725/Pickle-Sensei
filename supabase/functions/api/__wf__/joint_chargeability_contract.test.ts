// Edge consumer of the shared joint-chargeability contract fixture table
// (packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json).
// The Edge function, the mobile app and the SQL fixtures all decide through
// packages/shared-types/src/chargeability.ts, so a credit is consumed on every
// plane only when BOTH the mechanics score AND the benchmark range are
// independently validated AND durably delivered once.
//   (cd supabase/functions/api/__wf__ && deno task test)

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  CHARGEABILITY_FIXTURE_CATEGORIES,
  type ChargeabilityFixtureTable,
  CHARGEABLE_REASON_CODE,
  decideChargeability,
  isChargeableAnalysis,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
  NON_CHARGEABLE_REASON_CODES,
  parseChargeabilityFixtureTable,
} from "../../../../packages/shared-types/src/chargeability.ts";
import type { IndependentlyVerifiedAnalysisEligibility } from "../../../../packages/shared-types/src/analysisOutcome.ts";
import { eligibilityForVerifiedRelease, readVerifiedReleasePolicy } from "../releasePolicy.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";

const FIXTURE_URL = new URL(
  "../../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json",
  import.meta.url,
);

async function loadTable(): Promise<ChargeabilityFixtureTable> {
  const parsed = parseChargeabilityFixtureTable(JSON.parse(await Deno.readTextFile(FIXTURE_URL)));
  if (!parsed.ok) throw new Error(`fixture table rejected: ${parsed.failure.code}`);
  return parsed.value;
}

Deno.test("edge consumes the versioned canonical chargeability fixture table", async () => {
  const table = await loadTable();
  assertEquals(table.schemaVersion, JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION);
  assertEquals(table.contractVersion, JOINT_CHARGEABILITY_CONTRACT_VERSION);
  for (const category of CHARGEABILITY_FIXTURE_CATEGORIES) {
    assert(
      table.cases.some((entry) => entry.category === category),
      `fixture table must cover category ${category}`,
    );
  }
});

Deno.test("every fixture case decides exactly as the shared contract declares", async () => {
  const table = await loadTable();
  for (const entry of table.cases) {
    assertEquals(
      decideChargeability(entry.outcome, entry.eligibility),
      {
        contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
        chargeable: entry.expected.chargeable,
        reasonCode: entry.expected.reasonCode,
        creditsConsumed: entry.expected.creditsConsumed,
      },
      entry.id,
    );
    assertEquals(
      isChargeableAnalysis(entry.outcome, entry.eligibility),
      entry.expected.chargeable,
      entry.id,
    );
  }
});

Deno.test("partial, failed, withheld and replayed outcomes never consume a credit", async () => {
  const table = await loadTable();
  const nonChargeable = table.cases.filter((entry) => entry.category !== "chargeable");
  assert(nonChargeable.length > 0);
  for (const entry of nonChargeable) {
    const decision = decideChargeability(entry.outcome, entry.eligibility);
    assertEquals(decision.chargeable, false, entry.id);
    assertEquals(decision.creditsConsumed, 0, entry.id);
    assertNotEquals(decision.reasonCode, CHARGEABLE_REASON_CODE, entry.id);
    assert(
      (NON_CHARGEABLE_REASON_CODES as readonly string[]).includes(decision.reasonCode),
      entry.id,
    );
  }
  const chargeable = table.cases.filter((entry) => entry.category === "chargeable");
  assertEquals(chargeable.length, 1);
});

Deno.test(
  "the Edge release authority verdict feeds the shared contract: charge once, only when both outputs are delivered",
  async () => {
    const policy = await readVerifiedReleasePolicy(async () => ({
      data: await activeReleasePolicyRow(),
      error: null,
    }));
    assert(policy !== null);
    const now = Math.floor(Date.now() / 1000);
    const releaseEligibility = eligibilityForVerifiedRelease(
      policy,
      {
        shotType: "dink",
        cameraView: "side",
        handedness: "right",
        captureMode: "imported_video",
        source: "real",
        intentConfirmed: true,
      },
      now,
    );
    assertEquals(releaseEligibility.status, "eligible");
    if (releaseEligibility.status !== "eligible") return;

    const binding = {
      analysisId: "edge-analysis-1",
      operationId: "edge-operation-1",
      ownerId: "edge-owner-1",
      captureId: "edge-capture-1",
      inputSha256: "4".repeat(64),
      publicationId: "edge-publication-1",
    };
    const eligibility: IndependentlyVerifiedAnalysisEligibility = {
      schemaVersion: "analysis-eligibility-input-v1",
      verificationSource: "independent_release_authority_and_owner_ledger",
      binding,
      publicationState: "both_outputs_durably_published_once",
      creditState: "unconsumed",
      releaseEligibility,
    };
    const mechanics = {
      schemaVersion: "mechanics-output-v1",
      scale: "mechanics_0_10",
      status: "validated_score",
      score: 7,
      lineage: releaseEligibility.mechanics.lineage,
    };
    const benchmark = {
      schemaVersion: "technique-benchmark-v1",
      interpretation: "unofficial_single_swing_form_only",
      scale: "dupr_2_8",
      status: "validated_range",
      interval: { lower: 3.5, upper: 4 },
      uncertainty: HARNESS_RELEASE_POLICY.benchmark.uncertainty,
      lineage: releaseEligibility.benchmark.lineage,
    };
    const publication = {
      status: "durably_published",
      publicationId: binding.publicationId,
      publishedAtIso: new Date(now * 1000).toISOString(),
    };
    const complete = {
      schemaVersion: "analysis-outcome-v1",
      analysisId: binding.analysisId,
      operationId: binding.operationId,
      ownerId: binding.ownerId,
      captureId: binding.captureId,
      inputSha256: binding.inputSha256,
      source: "real",
      status: "complete",
      billingDisposition: "joint_verification_required",
      publication,
      mechanics,
      benchmark,
    };

    assertEquals(decideChargeability(complete, eligibility), {
      contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
      chargeable: true,
      reasonCode: CHARGEABLE_REASON_CODE,
      creditsConsumed: 1,
    });

    const mechanicsWithheld = {
      ...complete,
      status: "partial",
      billingDisposition: "not_chargeable",
      mechanics: {
        schemaVersion: "mechanics-output-v1",
        scale: "mechanics_0_10",
        status: "insufficient_evidence",
        reasonCodes: ["form_not_observable"],
      },
    };
    assertEquals(decideChargeability(mechanicsWithheld, eligibility), {
      contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
      chargeable: false,
      reasonCode: "outcome_partial",
      creditsConsumed: 0,
    });

    const benchmarkWithheld = {
      ...complete,
      status: "partial",
      billingDisposition: "not_chargeable",
      benchmark: {
        schemaVersion: "technique-benchmark-v1",
        interpretation: "unofficial_single_swing_form_only",
        scale: "dupr_2_8",
        status: "insufficient_evidence",
        reasonCodes: ["uncertainty_not_useful"],
      },
    };
    assertEquals(decideChargeability(benchmarkWithheld, eligibility), {
      contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
      chargeable: false,
      reasonCode: "outcome_partial",
      creditsConsumed: 0,
    });

    const replayed: IndependentlyVerifiedAnalysisEligibility = {
      ...eligibility,
      creditState: "already_consumed",
    };
    assertEquals(decideChargeability(complete, replayed), {
      contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
      chargeable: false,
      reasonCode: "credit_already_consumed",
      creditsConsumed: 0,
    });

    const withdrawn = eligibilityForVerifiedRelease(
      { ...policy, approval: { ...policy.approval, denyNewAuthorizations: true } },
      {
        shotType: "dink",
        cameraView: "side",
        handedness: "right",
        captureMode: "imported_video",
        source: "real",
        intentConfirmed: true,
      },
      now,
    );
    assertEquals(withdrawn.status, "ineligible");
    assertEquals(decideChargeability(complete, { ...eligibility, releaseEligibility: withdrawn }), {
      contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
      chargeable: false,
      reasonCode: "release_ineligible",
      creditsConsumed: 0,
    });
  },
);
