import { describe, expect, it } from "vitest";
import {
  DRILL_LIBRARY_V1,
  DRILL_LIBRARY_V1_VERSION,
  evaluateDrillRecommendation,
  FAULT_DRILL_MAPPINGS_V1,
  knownDrillIdsV1,
  mappingsForFault,
  MIN_FAULT_DIAGNOSIS_CONFIDENCE,
  MIN_INDEPENDENT_COACH_ENDORSEMENTS,
  MIN_MAPPING_AGREEMENT,
  validateDrillEntryV1,
  validateDrillLibraryV1,
  validateFaultDrillMappingV1,
  type DrillEntryV1,
  type DrillRecommendationInput,
  type FaultDrillMappingV1,
} from "../src/drillLibrary.js";
import { allFaultIds } from "../src/coachReview.js";
import { TECHNIQUE_ANALYSIS_PROFILES_V1 } from "@pickle/shared-types";

const seedDrill = DRILL_LIBRARY_V1.drills[0]!;
const seedMapping = FAULT_DRILL_MAPPINGS_V1[0]!;

/** A hypothetical fully-validated drill+mapping pair, used ONLY to prove the
 * gate opens when (and only when) real evidence exists. Test fixture — never
 * part of the shipped library. */
function validatedFixture(): { drill: DrillEntryV1; mapping: FaultDrillMappingV1 } {
  const drill: DrillEntryV1 = {
    ...seedDrill,
    coachProvenance: {
      coachId: "coach-a1",
      coachCredentialRef: "cred-2026-001",
      endorsedAtIso: "2026-09-01T00:00:00.000Z",
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
        endorsedAtIso: "2026-09-01T00:00:00.000Z",
      },
      {
        coachId: "coach-b2",
        coachCredentialRef: "cred-2026-002",
        reviewRef: "datasets/coach-review/reviews/wm-x-01-E1.coach-b2.json",
        endorsedAtIso: "2026-09-02T00:00:00.000Z",
      },
    ],
    agreement: { endorsed: 2, asked: 2, fraction: 1 },
    evidenceTier: "GOLD",
    validationState: "COACH_VALIDATED",
    provenance: "coach-endorsed (test fixture)",
  };
  return { drill, mapping };
}

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
      drillMappingVersion: DRILL_LIBRARY_V1_VERSION,
    },
    knownContext: {},
    ...overrides,
  };
}

describe("drill library v1 seeds", () => {
  it("library is structurally valid (referential integrity, per-record checks)", () => {
    expect(validateDrillLibraryV1()).toEqual([]);
  });

  it("every seeded drill is Tier-C UNVALIDATED with no coach provenance", () => {
    expect(DRILL_LIBRARY_V1.drills.length).toBeGreaterThan(0);
    for (const drill of DRILL_LIBRARY_V1.drills) {
      expect(drill.validationState).toBe("UNVALIDATED");
      expect(drill.evidenceTier).toBe("C");
      expect(drill.coachProvenance).toBeNull();
      expect(drill.provenance).toMatch(/NOT coach-validated/);
    }
  });

  it("every seeded mapping is UNVALIDATED with zero endorsements and no agreement claim", () => {
    expect(FAULT_DRILL_MAPPINGS_V1.length).toBeGreaterThan(0);
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      expect(mapping.validationState).toBe("UNVALIDATED");
      expect(mapping.evidenceTier).toBe("C");
      expect(mapping.endorsements).toEqual([]);
      expect(mapping.agreement).toBeNull();
    }
  });

  it("all seeded mappings reference real fault ids and real drills", () => {
    const faultIds = allFaultIds();
    const drillIds = knownDrillIdsV1();
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      expect(faultIds).toContain(mapping.faultId);
      expect(drillIds).toContain(mapping.drillId);
    }
  });

  it("mappingsForFault returns only mappings for that fault", () => {
    const results = mappingsForFault(seedMapping.faultId);
    expect(results.length).toBeGreaterThan(0);
    for (const mapping of results) expect(mapping.faultId).toBe(seedMapping.faultId);
    expect(mappingsForFault("global.nonexistent_fault")).toEqual([]);
  });
});

describe("validators enforce evidence honesty", () => {
  it("rejects COACH_VALIDATED drill without provenance", () => {
    const problems = validateDrillEntryV1({
      ...seedDrill,
      validationState: "COACH_VALIDATED",
      evidenceTier: "GOLD",
    });
    expect(problems.join(" ")).toMatch(/requires coachProvenance/);
  });

  it("rejects UNVALIDATED drill claiming GOLD tier", () => {
    const problems = validateDrillEntryV1({ ...seedDrill, evidenceTier: "GOLD" });
    expect(problems.join(" ")).toMatch(/never be evidenceTier GOLD/);
  });

  it("rejects synthetic coach identities", () => {
    const { drill } = validatedFixture();
    const problems = validateDrillEntryV1({
      ...drill,
      coachProvenance: { ...drill.coachProvenance!, coachId: "synthetic-coach-1" },
    });
    expect(problems.join(" ")).toMatch(/real provisioned coach id/);
  });

  it("rejects COACH_VALIDATED mapping with too few independent endorsements", () => {
    const { mapping } = validatedFixture();
    const problems = validateFaultDrillMappingV1({
      ...mapping,
      endorsements: [
        mapping.endorsements[0]!,
        { ...mapping.endorsements[1]!, coachId: "coach-a1" },
      ],
      agreement: { endorsed: 2, asked: 2, fraction: 1 },
    });
    expect(problems.join(" ")).toMatch(
      new RegExp(`≥${MIN_INDEPENDENT_COACH_ENDORSEMENTS} independent coach endorsements`),
    );
  });

  it("rejects COACH_VALIDATED mapping with agreement below the minimum", () => {
    const { mapping } = validatedFixture();
    const problems = validateFaultDrillMappingV1({
      ...mapping,
      agreement: { endorsed: 2, asked: 4, fraction: 0.5 },
    });
    expect(problems.join(" ")).toMatch(new RegExp(`agreement ≥ ${MIN_MAPPING_AGREEMENT}`));
  });

  it("rejects UNVALIDATED mapping carrying endorsements", () => {
    const { mapping } = validatedFixture();
    const problems = validateFaultDrillMappingV1({
      ...mapping,
      validationState: "UNVALIDATED",
      evidenceTier: "C",
    });
    expect(problems.join(" ")).toMatch(/zero endorsements/);
  });
});

describe("recommendation gate — production safety", () => {
  it("ABSTAINS on every seeded mapping in production mode (the shipped library can never recommend)", () => {
    for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
      const drill = DRILL_LIBRARY_V1.drills.find((entry) => entry.drillId === mapping.drillId)!;
      const decision = evaluateDrillRecommendation(
        gateInput({
          drill,
          mapping,
          fault: {
            faultId: mapping.faultId,
            severity: 2,
            source: "real_coach_review",
            confidence: 0.95,
          },
          techniqueProfile: {
            canonical: "ANY",
            strokeFamily: mapping.strokeFamilies[0]!,
            techniqueEvaluator: "coach-validated-evaluator-v1",
            drillMappingVersion: DRILL_LIBRARY_V1_VERSION,
          },
          knownContext: Object.fromEntries(mapping.contextRestrictions.map((r) => [r, true])),
        }),
      );
      expect(decision.decision).toBe("abstain");
      if (decision.decision === "abstain") {
        expect(decision.reasons.join(" ")).toMatch(/not COACH_VALIDATED/);
      }
    }
  });

  it("ABSTAINS on seeded mappings in research mode too — no mode weakens the evidence requirement", () => {
    const drill = DRILL_LIBRARY_V1.drills.find((entry) => entry.drillId === seedMapping.drillId)!;
    const decision = evaluateDrillRecommendation(
      gateInput({ mode: "research", drill, mapping: seedMapping }),
    );
    expect(decision.decision).toBe("abstain");
  });

  it("abstains for every live TECHNIQUE_ANALYSIS_PROFILES_V1 profile (all BLOCKED_ON_VALIDATION, drillMappingVersion none)", () => {
    const { drill, mapping } = validatedFixture();
    for (const profile of Object.values(TECHNIQUE_ANALYSIS_PROFILES_V1)) {
      const decision = evaluateDrillRecommendation(
        gateInput({
          drill,
          mapping,
          techniqueProfile: {
            canonical: profile.canonical,
            strokeFamily: "dink",
            techniqueEvaluator: profile.techniqueEvaluator,
            drillMappingVersion: profile.drillMappingVersion,
          },
        }),
      );
      expect(decision.decision).toBe("abstain");
      if (decision.decision === "abstain") {
        expect(decision.reasons.join(" ")).toMatch(/BLOCKED_ON_VALIDATION/);
      }
    }
  });

  it("abstains when the fault diagnosis is machine-proposed or engineer-labeled", () => {
    for (const source of ["machine_proposed", "engineer_labeled"] as const) {
      const decision = evaluateDrillRecommendation(
        gateInput({
          fault: { faultId: seedMapping.faultId, severity: 2, source, confidence: 0.99 },
        }),
      );
      expect(decision.decision).toBe("abstain");
      if (decision.decision === "abstain") {
        expect(decision.reasons.join(" ")).toMatch(/not a validated source/);
      }
    }
  });

  it("abstains when diagnosis confidence is below the minimum", () => {
    const decision = evaluateDrillRecommendation(
      gateInput({
        fault: {
          faultId: seedMapping.faultId,
          severity: 2,
          source: "real_coach_review",
          confidence: MIN_FAULT_DIAGNOSIS_CONFIDENCE - 0.01,
        },
      }),
    );
    expect(decision.decision).toBe("abstain");
  });

  it("abstains when severity is outside the endorsed band", () => {
    const { drill, mapping } = validatedFixture();
    const banded = { ...mapping, severityRestriction: { min: 2 as const, max: 2 as const } };
    const decision = evaluateDrillRecommendation(
      gateInput({
        drill,
        mapping: banded,
        fault: {
          faultId: mapping.faultId,
          severity: 3,
          source: "real_coach_review",
          confidence: 0.9,
        },
      }),
    );
    expect(decision.decision).toBe("abstain");
    if (decision.decision === "abstain") {
      expect(decision.reasons.join(" ")).toMatch(/above endorsed band/);
    }
  });

  it("abstains when required context is unknown or false", () => {
    const { drill, mapping } = validatedFixture();
    const restricted = {
      ...mapping,
      contextRestrictions: ["player can sustain a 10-ball cooperative dink rally"],
    };
    const unknown = evaluateDrillRecommendation(
      gateInput({ drill, mapping: restricted, knownContext: {} }),
    );
    expect(unknown.decision).toBe("abstain");
    if (unknown.decision === "abstain") {
      expect(unknown.reasons.join(" ")).toMatch(/required context unknown/);
    }
    const falsy = evaluateDrillRecommendation(
      gateInput({
        drill,
        mapping: restricted,
        knownContext: { "player can sustain a 10-ball cooperative dink rally": false },
      }),
    );
    expect(falsy.decision).toBe("abstain");
  });

  it("abstains when the stroke family is not endorsed by the mapping", () => {
    const decision = evaluateDrillRecommendation(
      gateInput({
        techniqueProfile: {
          canonical: "OVERHEAD",
          strokeFamily: "overhead",
          techniqueEvaluator: "coach-validated-evaluator-v1",
          drillMappingVersion: DRILL_LIBRARY_V1_VERSION,
        },
      }),
    );
    expect(decision.decision).toBe("abstain");
  });

  it("abstains when the mapping evidence is structurally invalid even if state says validated", () => {
    const { drill, mapping } = validatedFixture();
    const forged = {
      ...mapping,
      endorsements: [],
      agreement: { endorsed: 0, asked: 0, fraction: 0 },
    };
    const decision = evaluateDrillRecommendation(gateInput({ drill, mapping: forged }));
    expect(decision.decision).toBe("abstain");
  });

  it("recommends ONLY when every condition holds (hypothetical validated fixture)", () => {
    const decision = evaluateDrillRecommendation(gateInput());
    expect(decision).toEqual({
      decision: "recommend",
      drillId: seedDrill.drillId,
      mappingId: seedMapping.mappingId,
    });
  });
});
