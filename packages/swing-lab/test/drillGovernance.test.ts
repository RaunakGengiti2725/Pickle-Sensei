import { describe, expect, it } from "vitest";
import {
  DRILL_LIBRARY_V1,
  FAULT_DRILL_MAPPINGS_V1,
  type DrillEntryV1,
  type DrillRecommendationInput,
  type FaultDrillMappingV1,
} from "../src/drillLibrary.js";
import {
  DRILL_GOVERNANCE_V1_VERSION,
  GOVERNANCE_VALIDATION_VERSION,
  appendRevision,
  checkDrillMediaRights,
  createLedger,
  disableMapping,
  evaluateGovernedRecommendation,
  explainHistoricalMapping,
  findLostSupport,
  headRevision,
  mediaRightsUsable,
  proposeRevision,
  registerMapping,
  revisionsFor,
  validateGovernedRevision,
  validateMediaRightsRecord,
  validateRevisionTransition,
  type GovernedMappingLedger,
  type GovernedMappingRevision,
  type MediaRightsRecord,
} from "../src/drillGovernance.js";

const seedDrill = DRILL_LIBRARY_V1.drills[0]!;
const seedMapping = FAULT_DRILL_MAPPINGS_V1[0]!;

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";
const T2 = "2026-09-03T00:00:00.000Z";

const SEED_GOV_PROVENANCE =
  "governance registration of the Tier-C engineering seed from drill-library v1";

/** Fixture mirror of drillLibrary.test.ts: a hypothetical validated pair used
 * ONLY to exercise transitions that require real evidence. Never shipped. */
function validatedFixture(): { drill: DrillEntryV1; mapping: FaultDrillMappingV1 } {
  const drill: DrillEntryV1 = {
    ...seedDrill,
    coachProvenance: {
      coachId: "coach-a1",
      coachCredentialRef: "cred-2026-001",
      endorsedAtIso: T0,
      reviewRef: "datasets/coach-review/reviews/wm-x-01-E1.coach-a1.json",
    },
    provenance: "coach-authored (test fixture)",
    evidenceTier: "GOLD",
    validationState: "COACH_VALIDATED",
  };
  const mapping: FaultDrillMappingV1 = {
    ...seedMapping,
    endorsements: [
      {
        coachId: "coach-a1",
        coachCredentialRef: "cred-2026-001",
        reviewRef: "datasets/coach-review/reviews/wm-x-01-E1.coach-a1.json",
        endorsedAtIso: T0,
      },
      {
        coachId: "coach-b2",
        coachCredentialRef: "cred-2026-002",
        reviewRef: "datasets/coach-review/reviews/wm-x-01-E1.coach-b2.json",
        endorsedAtIso: T0,
      },
    ],
    agreement: { endorsed: 2, asked: 2, fraction: 1 },
    evidenceTier: "GOLD",
    validationState: "COACH_VALIDATED",
    provenance: "coach-endorsed (test fixture)",
  };
  return { drill, mapping };
}

function registeredLedger(mapping: FaultDrillMappingV1 = seedMapping): GovernedMappingLedger {
  const ledger = createLedger();
  const result = registerMapping(ledger, mapping, {
    createdAtIso: T0,
    provenance: SEED_GOV_PROVENANCE,
  });
  expect(result.ok).toBe(true);
  return ledger;
}

function clearedRights(mediaRef: string): MediaRightsRecord {
  return {
    mediaRef,
    rightsHolder: "Pickle Sensei first-party media",
    license: "owned_first_party",
    clearanceRef: "rights-2026-001",
    clearedAtIso: T0,
    expiresAtIso: null,
    status: "CLEARED",
  };
}

describe("governed revision validation", () => {
  it("accepts a well-formed revision 1 of a library seed", () => {
    const ledger = registeredLedger();
    const head = headRevision(ledger, seedMapping.mappingId)!;
    expect(validateGovernedRevision(head)).toEqual([]);
    expect(head.governanceVersion).toBe(DRILL_GOVERNANCE_V1_VERSION);
    expect(head.validationVersion).toBe(GOVERNANCE_VALIDATION_VERSION);
  });

  it("rejects revision 1 carrying a changeReason or previousRevision", () => {
    const ledger = registeredLedger();
    const head = headRevision(ledger, seedMapping.mappingId)!;
    const bad: GovernedMappingRevision = {
      ...head,
      changeReason: "sneaky pre-filled change reason",
      previousRevision: 0,
    };
    const problems = validateGovernedRevision(bad);
    expect(problems.some((p) => p.includes("changeReason null"))).toBe(true);
    expect(problems.some((p) => p.includes("previousRevision null"))).toBe(true);
  });

  it("rejects a disabled revision without a disable record and vice versa", () => {
    const ledger = registeredLedger();
    const head = headRevision(ledger, seedMapping.mappingId)!;
    expect(
      validateGovernedRevision({ ...head, status: "disabled", disabled: null }).some((p) =>
        p.includes("disable record"),
      ),
    ).toBe(true);
    expect(
      validateGovernedRevision({
        ...head,
        disabled: {
          reason: "safety_concern",
          detail: "detail long enough here",
          disabledAtIso: T1,
          decidedBy: "governance sweep",
        },
      }).some((p) => p.includes("must not carry a disable record")),
    ).toBe(true);
  });

  it("registers every seeded library mapping cleanly under governance", () => {
    const ledger = createLedger();
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      const result = registerMapping(ledger, mapping, {
        createdAtIso: T0,
        provenance: SEED_GOV_PROVENANCE,
      });
      expect(result.ok, mapping.mappingId).toBe(true);
    }
    expect(ledger.revisions).toHaveLength(FAULT_DRILL_MAPPINGS_V1.length);
  });
});

describe("revision transitions: FAULT X → DRILL A into DRILL B", () => {
  it("re-pointing to a different drill with reused provenance is rejected", () => {
    const ledger = registeredLedger();
    const head = headRevision(ledger, seedMapping.mappingId)!;
    const repointed: FaultDrillMappingV1 = {
      ...seedMapping,
      drillId: "drill.dink-target-boxes",
    };
    const result = proposeRevision(ledger, seedMapping.mappingId, {
      mapping: repointed,
      createdAtIso: T1,
      provenance: head.provenance,
      changeReason: "swap to the target-box drill instead",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.includes("NEW provenance"))).toBe(true);
    }
  });

  it("re-pointing with new provenance and fresh (empty) evidence succeeds and bumps the revision", () => {
    const ledger = registeredLedger();
    const repointed: FaultDrillMappingV1 = {
      ...seedMapping,
      drillId: "drill.dink-target-boxes",
    };
    const result = proposeRevision(ledger, seedMapping.mappingId, {
      mapping: repointed,
      createdAtIso: T1,
      provenance:
        "engineering re-proposal after coach feedback session 2026-09 — pending fresh endorsements",
      changeReason: "coaches preferred target-box work for out-front contact",
    });
    expect(result.ok).toBe(true);
    const chain = revisionsFor(ledger, seedMapping.mappingId);
    expect(chain.map((r) => r.revision)).toEqual([1, 2]);
    expect(chain[0]!.status).toBe("superseded");
    expect(chain[1]!.status).toBe("active");
    expect(chain[1]!.mapping.drillId).toBe("drill.dink-target-boxes");
  });

  it("carrying endorsements from DRILL A over to DRILL B is rejected", () => {
    const { mapping: validated } = validatedFixture();
    const ledger = registeredLedger(validated);
    const head = headRevision(ledger, validated.mappingId)!;
    const repointed: FaultDrillMappingV1 = {
      ...validated,
      drillId: "drill.dink-target-boxes",
    };
    const next: GovernedMappingRevision = {
      ...head,
      revision: 2,
      previousRevision: 1,
      createdAtIso: T1,
      provenance: "re-proposal with different drill but stolen endorsements",
      changeReason: "attempt to keep old endorsements on a new drill",
      mapping: repointed,
    };
    const problems = validateRevisionTransition(head, next);
    expect(problems.some((p) => p.includes("may not be carried over"))).toBe(true);
  });

  it("a re-pointed mapping cannot claim COACH_VALIDATED without fresh endorsements", () => {
    const { mapping: validated } = validatedFixture();
    const ledger = registeredLedger(validated);
    const head = headRevision(ledger, validated.mappingId)!;
    const repointed: FaultDrillMappingV1 = {
      ...validated,
      drillId: "drill.dink-target-boxes",
      endorsements: [],
      agreement: null,
    };
    const next: GovernedMappingRevision = {
      ...head,
      revision: 2,
      previousRevision: 1,
      createdAtIso: T1,
      provenance: "re-proposal claiming validation with zero evidence",
      changeReason: "attempt to keep validated state on a new drill",
      mapping: repointed,
    };
    const problems = validateRevisionTransition(head, next);
    expect(problems.some((p) => p.includes("fresh endorsements"))).toBe(true);
  });

  it("rejects revision skips, fault changes, and missing changeReason", () => {
    const ledger = registeredLedger();
    const head = headRevision(ledger, seedMapping.mappingId)!;
    const skipped: GovernedMappingRevision = {
      ...head,
      revision: 3,
      previousRevision: 1,
      createdAtIso: T1,
      changeReason: "long enough change reason",
    };
    expect(
      validateRevisionTransition(head, skipped).some((p) => p.includes("bump by exactly 1")),
    ).toBe(true);

    const faultChanged: GovernedMappingRevision = {
      ...head,
      revision: 2,
      previousRevision: 1,
      createdAtIso: T1,
      changeReason: "long enough change reason",
      mapping: { ...seedMapping, faultId: "dink.lifting_trajectory" },
    };
    expect(
      validateRevisionTransition(head, faultChanged).some((p) =>
        p.includes("faultId may never change"),
      ),
    ).toBe(true);

    const noReason: GovernedMappingRevision = {
      ...head,
      revision: 2,
      previousRevision: 1,
      createdAtIso: T1,
      changeReason: null,
    };
    expect(validateRevisionTransition(head, noReason).some((p) => p.includes("changeReason"))).toBe(
      true,
    );
  });

  it("appendRevision refuses a first revision that is not revision 1", () => {
    const ledger = createLedger();
    const result = appendRevision(ledger, {
      mappingId: seedMapping.mappingId,
      revision: 2,
      mapping: seedMapping,
      status: "active",
      createdAtIso: T0,
      provenance: SEED_GOV_PROVENANCE,
      changeReason: "long enough change reason",
      previousRevision: 1,
      disabled: null,
      mediaRights: [],
      validationVersion: GOVERNANCE_VALIDATION_VERSION,
      governanceVersion: DRILL_GOVERNANCE_V1_VERSION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.includes("must be revision 1"))).toBe(true);
    }
  });
});

describe("safe disable + historical explainability", () => {
  it("disabling appends a revision, keeps history, and blocks double-disable", () => {
    const ledger = registeredLedger();
    const result = disableMapping(ledger, seedMapping.mappingId, {
      reason: "agreement_below_threshold",
      detail: "panel re-review dropped agreement below the required threshold",
      decidedBy: "governance sweep 2026-09",
      disabledAtIso: T1,
    });
    expect(result.ok).toBe(true);
    const chain = revisionsFor(ledger, seedMapping.mappingId);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.status).toBe("superseded");
    expect(chain[1]!.status).toBe("disabled");
    expect(chain[1]!.disabled?.reason).toBe("agreement_below_threshold");

    const again = disableMapping(ledger, seedMapping.mappingId, {
      reason: "safety_concern",
      detail: "second disable attempt should be rejected",
      decidedBy: "governance sweep 2026-09",
      disabledAtIso: T2,
    });
    expect(again.ok).toBe(false);
  });

  it("a historical Result referencing a later-disabled mapping stays explainable", () => {
    const ledger = registeredLedger();
    disableMapping(ledger, seedMapping.mappingId, {
      reason: "endorsement_withdrawn",
      detail: "endorsing coach withdrew after re-reviewing new footage",
      decidedBy: "coach retraction datasets/coach-review/reviews/wm-x-02.coach-a1.json",
      disabledAtIso: T1,
    });
    const resolution = explainHistoricalMapping(ledger, {
      mappingId: seedMapping.mappingId,
      revision: 1,
    });
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.value.revisionRecord.mapping.drillId).toBe(seedMapping.drillId);
      expect(resolution.value.mappingStatusNow).toBe("disabled");
      expect(resolution.value.explanation).toContain("later disabled");
      expect(resolution.value.explanation).toContain("faithful record");
    }
  });

  it("resolving an unknown mapping or revision fails loudly instead of guessing", () => {
    const ledger = registeredLedger();
    expect(
      explainHistoricalMapping(ledger, { mappingId: "map.nope.nope", revision: 1 }).resolved,
    ).toBe(false);
    expect(
      explainHistoricalMapping(ledger, { mappingId: seedMapping.mappingId, revision: 9 }).resolved,
    ).toBe(false);
  });

  it("re-enabling after a disable must say so explicitly in the changeReason", () => {
    const ledger = registeredLedger();
    disableMapping(ledger, seedMapping.mappingId, {
      reason: "media_rights_lost",
      detail: "instruction clip license expired without renewal",
      decidedBy: "governance sweep 2026-09",
      disabledAtIso: T1,
    });
    const silent = proposeRevision(ledger, seedMapping.mappingId, {
      mapping: seedMapping,
      createdAtIso: T2,
      provenance: "engineering proposal after rights renewal negotiation",
      changeReason: "rights renewed with the media vendor",
    });
    expect(silent.ok).toBe(false);
    if (!silent.ok) {
      expect(silent.problems.some((p) => p.includes("re-enable"))).toBe(true);
    }
    const explicit = proposeRevision(ledger, seedMapping.mappingId, {
      mapping: seedMapping,
      createdAtIso: T2,
      provenance: "engineering proposal after rights renewal negotiation",
      changeReason: "re-enable: rights renewed with the media vendor (rights-2026-014)",
    });
    expect(explicit.ok).toBe(true);
  });
});

describe("media rights", () => {
  it("CLEARED requires holder, clearanceRef and clearedAtIso", () => {
    const bad: MediaRightsRecord = {
      mediaRef: "media/dink-clip.mp4",
      rightsHolder: "",
      license: "licensed_written",
      clearanceRef: null,
      clearedAtIso: null,
      expiresAtIso: null,
      status: "CLEARED",
    };
    const problems = validateMediaRightsRecord(bad);
    expect(problems.some((p) => p.includes("rightsHolder"))).toBe(true);
    expect(problems.some((p) => p.includes("clearanceRef"))).toBe(true);
    expect(problems.some((p) => p.includes("clearedAtIso"))).toBe(true);
  });

  it("expired or non-CLEARED records are not usable", () => {
    const expired: MediaRightsRecord = {
      ...clearedRights("media/dink-clip.mp4"),
      expiresAtIso: T0,
    };
    expect(mediaRightsUsable(expired, T1)).toBe(false);
    expect(mediaRightsUsable({ ...clearedRights("m"), status: "PENDING" }, T1)).toBe(false);
    expect(mediaRightsUsable(clearedRights("media/dink-clip.mp4"), T1)).toBe(true);
  });

  it("drills with media need a usable record per mediaRef; media-free drills need none", () => {
    expect(checkDrillMediaRights(seedDrill, [], T1)).toEqual([]);
    const drillWithMedia: DrillEntryV1 = { ...seedDrill, mediaRefs: ["media/dink-clip.mp4"] };
    expect(
      checkDrillMediaRights(drillWithMedia, [], T1).some((p) =>
        p.includes("no media-rights record"),
      ),
    ).toBe(true);
    expect(
      checkDrillMediaRights(drillWithMedia, [clearedRights("media/dink-clip.mp4")], T1),
    ).toEqual([]);
  });
});

describe("lost-support sweep", () => {
  it("never flags UNVALIDATED seeds — they claim nothing", () => {
    const ledger = createLedger();
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      registerMapping(ledger, mapping, { createdAtIso: T0, provenance: SEED_GOV_PROVENANCE });
    }
    expect(findLostSupport(ledger, T1)).toEqual([]);
  });

  it("flags a validated mapping whose endorsements dropped below minimum", () => {
    const { mapping: validated } = validatedFixture();
    const withdrawn: FaultDrillMappingV1 = {
      ...validated,
      endorsements: validated.endorsements.slice(0, 1),
      agreement: { endorsed: 1, asked: 2, fraction: 0.5 },
    };
    // Such a record cannot be APPENDED (the validators reject a
    // COACH_VALIDATED mapping without the evidence), but a ledger loaded from
    // storage can contain one after an off-ledger withdrawal — exactly what
    // the sweep exists to catch.
    const ledger = registeredLedger(validated);
    const head = headRevision(ledger, validated.mappingId)!;
    ledger.revisions[ledger.revisions.indexOf(head)] = { ...head, mapping: withdrawn };
    const findings = findLostSupport(ledger, T2);
    expect(findings.some((f) => f.reason === "endorsement_withdrawn")).toBe(true);
    expect(findings.some((f) => f.reason === "agreement_below_threshold")).toBe(true);
    expect(findings.every((f) => f.mappingId === validated.mappingId)).toBe(true);
  });

  it("flags a validated mapping whose drill media rights expired", () => {
    const { mapping: validated } = validatedFixture();
    const ledger = createLedger();
    registerMapping(ledger, validated, {
      createdAtIso: T0,
      provenance: "test fixture registration with expiring media rights",
      mediaRights: [{ ...clearedRights("media/dink-clip.mp4"), expiresAtIso: T1 }],
    });
    const drillWithMedia: DrillEntryV1 = { ...seedDrill, mediaRefs: ["media/dink-clip.mp4"] };
    const before = findLostSupport(ledger, T0, [drillWithMedia]);
    expect(before.some((f) => f.reason === "media_rights_lost")).toBe(false);
    const after = findLostSupport(ledger, T2, [drillWithMedia]);
    expect(after.some((f) => f.reason === "media_rights_lost")).toBe(true);
  });
});

describe("governed recommendation gate", () => {
  function gateInput(overrides?: Partial<DrillRecommendationInput>): DrillRecommendationInput {
    const { drill, mapping } = validatedFixture();
    return {
      mode: "production",
      drill,
      mapping,
      fault: {
        faultId: mapping.faultId,
        severity: 2,
        source: "real_coach_review",
        confidence: 0.9,
      },
      techniqueProfile: {
        canonical: "FOREHAND_DINK",
        strokeFamily: "dink",
        techniqueEvaluator: "coach-validated-evaluator-v1",
        drillMappingVersion: "drill-library-v1",
      },
      knownContext: {},
      ...overrides,
    };
  }

  it("abstains on ungoverned mappings even when the base gate would recommend", () => {
    const ledger = createLedger();
    const decision = evaluateGovernedRecommendation(ledger, gateInput(), T1);
    expect(decision.decision).toBe("abstain");
    if (decision.decision === "abstain") {
      expect(decision.reasons.some((r) => r.includes("not under governance"))).toBe(true);
    }
  });

  it("recommends only from the active governed head, with its revision", () => {
    const input = gateInput();
    const ledger = registeredLedger(input.mapping);
    const decision = evaluateGovernedRecommendation(ledger, input, T1);
    expect(decision).toEqual({
      decision: "recommend",
      drillId: input.drill.drillId,
      mappingId: input.mapping.mappingId,
      revision: 1,
    });
  });

  it("abstains once the mapping is disabled, while history stays explainable", () => {
    const input = gateInput();
    const ledger = registeredLedger(input.mapping);
    disableMapping(ledger, input.mapping.mappingId, {
      reason: "coach_retraction",
      detail: "endorsing coach retracted after reviewing injury-risk feedback",
      decidedBy: "coach retraction datasets/coach-review/reviews/wm-x-03.coach-a1.json",
      disabledAtIso: T1,
    });
    const decision = evaluateGovernedRecommendation(ledger, input, T2);
    expect(decision.decision).toBe("abstain");
    const history = explainHistoricalMapping(ledger, {
      mappingId: input.mapping.mappingId,
      revision: 1,
    });
    expect(history.resolved).toBe(true);
  });

  it("abstains when the drill's media rights are missing or expired", () => {
    const base = gateInput();
    const drillWithMedia: DrillEntryV1 = { ...base.drill, mediaRefs: ["media/dink-clip.mp4"] };
    const input = { ...base, drill: drillWithMedia };
    const ledger = createLedger();
    registerMapping(ledger, input.mapping, {
      createdAtIso: T0,
      provenance: "test fixture registration with expiring media rights",
      mediaRights: [{ ...clearedRights("media/dink-clip.mp4"), expiresAtIso: T1 }],
    });
    const okBefore = evaluateGovernedRecommendation(ledger, input, T0);
    expect(okBefore.decision).toBe("recommend");
    const afterExpiry = evaluateGovernedRecommendation(ledger, input, T2);
    expect(afterExpiry.decision).toBe("abstain");
    if (afterExpiry.decision === "abstain") {
      expect(afterExpiry.reasons.some((r) => r.includes("not usable"))).toBe(true);
    }
  });

  it("abstains on every seeded library mapping — zero coach evidence exists", () => {
    const ledger = createLedger();
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      registerMapping(ledger, mapping, { createdAtIso: T0, provenance: SEED_GOV_PROVENANCE });
    }
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      const drill = DRILL_LIBRARY_V1.drills.find((entry) => entry.drillId === mapping.drillId)!;
      const decision = evaluateGovernedRecommendation(
        ledger,
        {
          mode: "production",
          drill,
          mapping,
          fault: {
            faultId: mapping.faultId,
            severity: 2,
            source: "real_coach_review",
            confidence: 0.9,
          },
          techniqueProfile: {
            canonical: "FOREHAND_DINK",
            strokeFamily: mapping.strokeFamilies[0]!,
            techniqueEvaluator: "coach-validated-evaluator-v1",
            drillMappingVersion: "drill-library-v1",
          },
          knownContext: {},
        },
        T1,
      );
      expect(decision.decision, mapping.mappingId).toBe("abstain");
    }
  });
});
