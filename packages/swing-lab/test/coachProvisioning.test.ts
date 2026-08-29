import { describe, expect, it } from "vitest";
import {
  COACH_QUALIFICATION_POLICY_VERSION,
  isEligibleReviewer,
  provisioningActionIdFor,
  scaffoldCoachRegistryV2,
  validateCoachQualification,
  validateCoachRegistry,
  validateCoachRegistryEntry,
  validateProvisioningAction,
  type CoachQualification,
  type CoachRegistryEntryV2,
  type ProvisioningAction,
} from "../src/coachProvisioning.js";

/** TEST-ONLY fixture data. Evidence refs point at nothing; these identities
 * exist nowhere outside this test file and are never persisted. */
function fixtureQualification(): CoachQualification {
  return {
    policyVersion: COACH_QUALIFICATION_POLICY_VERSION,
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "test-admin",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim, not a real coach",
      verification: {
        method: "employer_confirmed",
        verifiedBy: "test-admin",
        verifiedAtIso: "2026-08-29T00:00:00.000Z",
        evidenceRef: "test-evidence-nonexistent",
      },
    },
    competitiveBackground: null,
    affiliation: null,
    yearsCoaching: null,
    specialties: [],
  };
}

function fixtureEntry(): CoachRegistryEntryV2 {
  return {
    coachId: "test-coach-a",
    credentialRef: "test-cred-a",
    status: "active",
    provisionedAtIso: "2026-08-29T00:00:00.000Z",
    provisionedBy: "test-admin",
    qualification: fixtureQualification(),
  };
}

describe("coach registry v2", () => {
  it("scaffolds an EMPTY valid v2 registry (no coaches until real provisioning)", () => {
    const registry = scaffoldCoachRegistryV2();
    expect(registry.coaches).toHaveLength(0);
    expect(validateCoachRegistry(registry)).toHaveLength(0);
  });

  it("accepts a valid qualified entry", () => {
    expect(validateCoachRegistryEntry(fixtureEntry())).toHaveLength(0);
  });

  it("rejects an entry with no qualification record", () => {
    const entry = fixtureEntry() as unknown as Record<string, unknown>;
    delete entry.qualification;
    expect(validateCoachRegistryEntry(entry).join("\n")).toContain("qualification");
  });

  it("rejects an unknown policy version", () => {
    const qualification = { ...fixtureQualification(), policyVersion: "made-up-policy-v9" };
    expect(validateCoachQualification(qualification).join("\n")).toContain("known policy version");
  });

  it('rejects any verdict other than "qualified"', () => {
    const qualification = {
      ...fixtureQualification(),
      verdict: "probably-fine",
    } as unknown as CoachQualification;
    expect(validateCoachQualification(qualification).join("\n")).toContain("verdict");
  });

  it("rejects a criterion claimed on unverified_disclosed evidence only", () => {
    const qualification = fixtureQualification();
    qualification.professionalCoachingHistory!.verification.method = "unverified_disclosed";
    expect(validateCoachQualification(qualification).join("\n")).toContain(
      "without a verified coaching-history record",
    );
  });

  it("requires optional fields to be explicitly null, never missing", () => {
    const qualification = fixtureQualification() as unknown as Record<string, unknown>;
    delete qualification.competitiveBackground;
    delete qualification.yearsCoaching;
    const problems = validateCoachQualification(qualification).join("\n");
    expect(problems).toContain("competitiveBackground");
    expect(problems).toContain("yearsCoaching");
  });

  it("rejects SYNTHETIC coach ids and credential refs", () => {
    const entry = { ...fixtureEntry(), coachId: "synthetic-coach-1" };
    expect(validateCoachRegistryEntry(entry).join("\n")).toContain("SYNTHETIC");
    const credential = { ...fixtureEntry(), credentialRef: "SYNTHETIC-cred" };
    expect(validateCoachRegistryEntry(credential).join("\n")).toContain("SYNTHETIC");
  });

  it("rejects duplicate coachIds in the registry", () => {
    const registry = { ...scaffoldCoachRegistryV2(), coaches: [fixtureEntry(), fixtureEntry()] };
    expect(validateCoachRegistry(registry).join("\n")).toContain("duplicate coachId");
  });
});

describe("reviewer eligibility (production write gate)", () => {
  it("accepts an active, qualified, non-synthetic entry", () => {
    expect(isEligibleReviewer(fixtureEntry())).toBe(true);
  });

  it("rejects missing, suspended, synthetic, and unqualified entries", () => {
    expect(isEligibleReviewer(null)).toBe(false);
    expect(isEligibleReviewer(undefined)).toBe(false);
    expect(isEligibleReviewer({ ...fixtureEntry(), status: "suspended" })).toBe(false);
    expect(isEligibleReviewer({ ...fixtureEntry(), coachId: "synthetic-x" })).toBe(false);
    const unqualified = fixtureEntry();
    unqualified.qualification.professionalCoachingHistory!.verification.method =
      "unverified_disclosed";
    expect(isEligibleReviewer(unqualified)).toBe(false);
  });
});

describe("provisioning audit trail", () => {
  function fixtureAction(): ProvisioningAction {
    return {
      schemaVersion: 1,
      actionId: provisioningActionIdFor("test-coach-a", 1),
      action: "provision",
      coachId: "test-coach-a",
      performedBy: "test-admin",
      performedAtIso: "2026-08-29T00:00:00.000Z",
      reason: "TEST-ONLY fixture provisioning action",
      registryEntry: fixtureEntry(),
    };
  }

  it("accepts a valid first provision action", () => {
    expect(validateProvisioningAction(fixtureAction(), {})).toHaveLength(0);
  });

  it("requires sequential actionIds (append-only history)", () => {
    const problems = validateProvisioningAction(fixtureAction(), {
      existingSequencesByCoachId: { "test-coach-a": [1] },
    });
    expect(problems.join("\n")).toContain("sequential");
  });

  it("requires suspend/reinstate to follow a provision", () => {
    const suspend: ProvisioningAction = {
      ...fixtureAction(),
      action: "suspend",
      registryEntry: null,
    };
    expect(validateProvisioningAction(suspend, {}).join("\n")).toContain("prior provision");
  });

  it("rejects a SYNTHETIC admin identity", () => {
    const action = { ...fixtureAction(), performedBy: "synthetic-admin" };
    expect(validateProvisioningAction(action, {}).join("\n")).toContain("SYNTHETIC");
  });

  it("requires a reason (who/when/why is the audit trail)", () => {
    const action = { ...fixtureAction(), reason: "" };
    expect(validateProvisioningAction(action, {}).join("\n")).toContain("reason");
  });
});
