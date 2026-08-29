/**
 * Coach provisioning types + validators for the admin console.
 *
 * MIRROR of the authoritative schema in
 * packages/swing-lab/src/coachProvisioning.ts (registry v2 + provisioning
 * audit trail). The runtime contract between the two is the JSON on disk
 * (datasets/coach-review/coaches.json and
 * datasets/coach-review/provisioning-log/): every write path in the lab API
 * validates against this mirror, and the registry's schemaVersion is checked
 * so the mirror cannot silently drift.
 *
 * TRUTH RULES (mirrored, non-negotiable):
 *   - Qualification fields are OPTIONAL-BUT-RECORDED: verified record with an
 *     off-repo evidenceRef, or explicitly null. Never invented.
 *   - Only verdict-qualified coaches under a known policy version may be
 *     active, and only active coaches can submit production reviews.
 *   - SYNTHETIC identities can never be provisioned or persisted.
 */

export const EXPECTED_REGISTRY_SCHEMA_VERSION = 2 as const;

export const COACH_QUALIFICATION_POLICY_VERSION = "coach-qualification-policy-v1" as const;

export const KNOWN_QUALIFICATION_POLICY_VERSIONS: readonly string[] = [
  COACH_QUALIFICATION_POLICY_VERSION,
];

export const QUALIFICATION_CRITERION_IDS = [
  "criterion.certification",
  "criterion.professional-coaching-history",
  "criterion.competitive-background-plus-teaching",
] as const;

export type QualificationCriterionId = (typeof QUALIFICATION_CRITERION_IDS)[number];

export type VerificationMethod =
  | "issuer_confirmed"
  | "document_reviewed"
  | "employer_confirmed"
  | "public_record"
  | "unverified_disclosed";

export interface VerifiedClaim {
  statement: string;
  verification: {
    method: VerificationMethod;
    verifiedBy: string;
    verifiedAtIso: string;
    evidenceRef: string;
  };
}

export interface CertificationRecord {
  organization: string;
  name: string;
  level: string | null;
  verification: VerifiedClaim["verification"];
}

export interface CoachQualification {
  policyVersion: string;
  satisfiedCriteria: QualificationCriterionId[];
  verdict: "qualified";
  assessedBy: string;
  assessedAtIso: string;
  certifications: CertificationRecord[];
  professionalCoachingHistory: VerifiedClaim | null;
  competitiveBackground: VerifiedClaim | null;
  affiliation: { organization: string; role: string | null; evidenceRef: string | null } | null;
  yearsCoaching: { value: number; basis: string } | null;
  specialties: string[];
}

export interface CoachRegistryEntryV2 {
  coachId: string;
  credentialRef: string;
  status: "active" | "suspended";
  provisionedAtIso: string;
  provisionedBy: string;
  qualification: CoachQualification;
}

export interface CoachRegistryV2 {
  schemaVersion: typeof EXPECTED_REGISTRY_SCHEMA_VERSION;
  note: string;
  qualificationPolicy: { version: string; document: string };
  coaches: CoachRegistryEntryV2[];
}

const COACH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  "issuer_confirmed",
  "document_reviewed",
  "employer_confirmed",
  "public_record",
  "unverified_disclosed",
];

function isIso(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateVerification(
  verification: VerifiedClaim["verification"] | undefined,
  path: string,
  problems: string[],
): void {
  if (!verification || typeof verification !== "object") {
    problems.push(`${path}.verification required`);
    return;
  }
  if (!VERIFICATION_METHODS.includes(verification.method)) {
    problems.push(`${path}.verification.method must be one of ${VERIFICATION_METHODS.join("|")}`);
  }
  if (!verification.verifiedBy || typeof verification.verifiedBy !== "string") {
    problems.push(`${path}.verification.verifiedBy required (admin identity)`);
  }
  if (!isIso(verification.verifiedAtIso)) {
    problems.push(`${path}.verification.verifiedAtIso must be an ISO timestamp`);
  }
  if (!verification.evidenceRef || typeof verification.evidenceRef !== "string") {
    problems.push(`${path}.verification.evidenceRef required (off-repo evidence record id)`);
  }
}

function validateVerifiedClaim(
  claim: VerifiedClaim | null | undefined,
  path: string,
  problems: string[],
): void {
  if (claim === null) return;
  if (claim === undefined) {
    problems.push(`${path} must be present (null or a verified claim) — optional-but-recorded`);
    return;
  }
  if (!claim.statement || claim.statement.trim().length < 5) {
    problems.push(`${path}.statement required (the coach's claim, as stated)`);
  }
  validateVerification(claim.verification, path, problems);
}

export function validateCoachQualification(raw: unknown): string[] {
  const problems: string[] = [];
  const qualification = raw as Partial<CoachQualification> | null;
  if (!qualification || typeof qualification !== "object") {
    return ["qualification must be an object"];
  }
  if (
    typeof qualification.policyVersion !== "string" ||
    !KNOWN_QUALIFICATION_POLICY_VERSIONS.includes(qualification.policyVersion)
  ) {
    problems.push(
      `qualification.policyVersion must be a known policy version (${KNOWN_QUALIFICATION_POLICY_VERSIONS.join("|")})`,
    );
  }
  if (qualification.verdict !== "qualified") {
    problems.push(
      'qualification.verdict must be "qualified" — coaches without a qualified verdict are never provisioned',
    );
  }
  const criteria = qualification.satisfiedCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    problems.push("qualification.satisfiedCriteria must list ≥1 policy criterion");
  } else {
    for (const criterion of criteria) {
      if (!(QUALIFICATION_CRITERION_IDS as readonly string[]).includes(criterion)) {
        problems.push(`qualification.satisfiedCriteria: unknown criterion ${String(criterion)}`);
      }
    }
    if (new Set(criteria).size !== criteria.length) {
      problems.push("qualification.satisfiedCriteria must be unique");
    }
  }
  if (!qualification.assessedBy || typeof qualification.assessedBy !== "string") {
    problems.push("qualification.assessedBy required (admin identity)");
  }
  if (qualification.assessedBy && /synthetic/i.test(qualification.assessedBy)) {
    problems.push("SYNTHETIC assessor identities can never be persisted");
  }
  if (!isIso(qualification.assessedAtIso)) {
    problems.push("qualification.assessedAtIso must be an ISO timestamp");
  }
  if (!Array.isArray(qualification.certifications)) {
    problems.push("qualification.certifications[] required (may be empty)");
  } else {
    for (const [index, certification] of qualification.certifications.entries()) {
      const path = `qualification.certifications[${index}]`;
      if (!certification.organization || typeof certification.organization !== "string") {
        problems.push(`${path}.organization required`);
      }
      if (!certification.name || typeof certification.name !== "string") {
        problems.push(`${path}.name required (as issued, never paraphrased)`);
      }
      if (certification.level !== null && typeof certification.level !== "string") {
        problems.push(`${path}.level must be a string or null`);
      }
      validateVerification(certification.verification, path, problems);
    }
  }
  validateVerifiedClaim(
    qualification.professionalCoachingHistory,
    "qualification.professionalCoachingHistory",
    problems,
  );
  validateVerifiedClaim(
    qualification.competitiveBackground,
    "qualification.competitiveBackground",
    problems,
  );
  const affiliation = qualification.affiliation;
  if (affiliation === undefined) {
    problems.push("qualification.affiliation must be present (null or record)");
  } else if (affiliation !== null) {
    if (!affiliation.organization || typeof affiliation.organization !== "string") {
      problems.push("qualification.affiliation.organization required");
    }
    if (affiliation.role !== null && typeof affiliation.role !== "string") {
      problems.push("qualification.affiliation.role must be a string or null");
    }
    if (affiliation.evidenceRef !== null && typeof affiliation.evidenceRef !== "string") {
      problems.push("qualification.affiliation.evidenceRef must be a string or null");
    }
  }
  const years = qualification.yearsCoaching;
  if (years === undefined) {
    problems.push("qualification.yearsCoaching must be present (null or {value, basis})");
  } else if (years !== null) {
    if (typeof years.value !== "number" || !Number.isFinite(years.value) || years.value < 0) {
      problems.push("qualification.yearsCoaching.value must be a non-negative number");
    }
    if (!years.basis || typeof years.basis !== "string") {
      problems.push("qualification.yearsCoaching.basis required (where the number comes from)");
    }
  }
  if (
    !Array.isArray(qualification.specialties) ||
    qualification.specialties.some((s) => typeof s !== "string" || s.trim().length === 0)
  ) {
    problems.push("qualification.specialties[] must be non-empty strings (may be empty array)");
  }
  const verified = (method: VerificationMethod | undefined) =>
    method !== undefined && method !== "unverified_disclosed";
  if (Array.isArray(criteria)) {
    if (
      criteria.includes("criterion.certification") &&
      !(
        Array.isArray(qualification.certifications) &&
        qualification.certifications.some((c) => verified(c.verification?.method))
      )
    ) {
      problems.push("criterion.certification claimed without a verified certification record");
    }
    if (
      criteria.includes("criterion.professional-coaching-history") &&
      !verified(qualification.professionalCoachingHistory?.verification?.method)
    ) {
      problems.push(
        "criterion.professional-coaching-history claimed without a verified coaching-history record",
      );
    }
    if (
      criteria.includes("criterion.competitive-background-plus-teaching") &&
      !(
        verified(qualification.competitiveBackground?.verification?.method) &&
        (verified(qualification.professionalCoachingHistory?.verification?.method) ||
          (Array.isArray(qualification.certifications) &&
            qualification.certifications.some((c) => verified(c.verification?.method))))
      )
    ) {
      problems.push(
        "criterion.competitive-background-plus-teaching requires verified competitive background AND verified teaching evidence",
      );
    }
  }
  return problems;
}

export function validateCoachRegistryEntry(raw: unknown): string[] {
  const problems: string[] = [];
  const entry = raw as Partial<CoachRegistryEntryV2> | null;
  if (!entry || typeof entry !== "object") return ["registry entry must be an object"];
  if (!entry.coachId || !COACH_ID_PATTERN.test(entry.coachId)) {
    problems.push("coachId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (entry.coachId && /synthetic/i.test(entry.coachId)) {
    problems.push("SYNTHETIC coach ids are dev fixtures and may never be provisioned");
  }
  if (!entry.credentialRef || typeof entry.credentialRef !== "string") {
    problems.push("credentialRef required (off-repo credential record id)");
  }
  if (entry.credentialRef && /synthetic/i.test(entry.credentialRef)) {
    problems.push("SYNTHETIC credential refs are dev fixtures and may never be provisioned");
  }
  if (entry.status !== "active" && entry.status !== "suspended") {
    problems.push('status must be "active" or "suspended"');
  }
  if (!isIso(entry.provisionedAtIso)) problems.push("provisionedAtIso must be an ISO timestamp");
  if (!entry.provisionedBy || typeof entry.provisionedBy !== "string") {
    problems.push("provisionedBy required (admin identity)");
  }
  if (entry.provisionedBy && /synthetic/i.test(entry.provisionedBy)) {
    problems.push("SYNTHETIC provisioner identities can never be persisted");
  }
  problems.push(...validateCoachQualification(entry.qualification));
  return problems;
}

export function validateCoachRegistry(raw: unknown): string[] {
  const problems: string[] = [];
  const registry = raw as Partial<CoachRegistryV2> | null;
  if (!registry || typeof registry !== "object") return ["registry must be an object"];
  if (registry.schemaVersion !== EXPECTED_REGISTRY_SCHEMA_VERSION) {
    problems.push(`registry schemaVersion must be ${EXPECTED_REGISTRY_SCHEMA_VERSION}`);
  }
  if (
    !registry.qualificationPolicy ||
    !KNOWN_QUALIFICATION_POLICY_VERSIONS.includes(registry.qualificationPolicy.version)
  ) {
    problems.push(
      `registry.qualificationPolicy.version must be a known policy version (${KNOWN_QUALIFICATION_POLICY_VERSIONS.join("|")})`,
    );
  }
  if (!Array.isArray(registry.coaches)) {
    problems.push("registry.coaches[] required");
    return problems;
  }
  const seen = new Set<string>();
  for (const [index, entry] of registry.coaches.entries()) {
    for (const problem of validateCoachRegistryEntry(entry)) {
      problems.push(`coaches[${index}]: ${problem}`);
    }
    if (entry?.coachId) {
      if (seen.has(entry.coachId)) problems.push(`coaches[${index}]: duplicate coachId`);
      seen.add(entry.coachId);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * PROVISIONING AUDIT TRAIL — append-only, one file per action
 * ------------------------------------------------------------------------ */

export const PROVISIONING_ACTION_SCHEMA_VERSION = 1 as const;

export type ProvisioningActionKind = "provision" | "suspend" | "reinstate";

export function provisioningActionIdFor(coachId: string, sequence: number): string {
  return `${coachId}.a${sequence}`;
}

export interface ProvisioningAction {
  schemaVersion: typeof PROVISIONING_ACTION_SCHEMA_VERSION;
  actionId: string;
  action: ProvisioningActionKind;
  coachId: string;
  performedBy: string;
  performedAtIso: string;
  reason: string;
  registryEntry: CoachRegistryEntryV2 | null;
}

export function validateProvisioningAction(
  raw: unknown,
  context?: {
    existingSequencesByCoachId?: Record<string, number[]>;
    registryCoachIds?: string[];
  },
): string[] {
  const problems: string[] = [];
  const action = raw as Partial<ProvisioningAction> | null;
  if (!action || typeof action !== "object") return ["provisioning action must be an object"];
  if (action.schemaVersion !== PROVISIONING_ACTION_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${PROVISIONING_ACTION_SCHEMA_VERSION}`);
  }
  if (
    action.action !== "provision" &&
    action.action !== "suspend" &&
    action.action !== "reinstate"
  ) {
    problems.push("action must be provision | suspend | reinstate");
  }
  if (!action.coachId || !COACH_ID_PATTERN.test(action.coachId)) {
    problems.push("coachId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (action.coachId && /synthetic/i.test(action.coachId)) {
    problems.push("SYNTHETIC coach ids are dev fixtures and may never be provisioned");
  }
  if (!action.performedBy || typeof action.performedBy !== "string") {
    problems.push("performedBy required (admin identity)");
  }
  if (action.performedBy && /synthetic/i.test(action.performedBy)) {
    problems.push("SYNTHETIC admin identities can never be persisted");
  }
  if (!isIso(action.performedAtIso)) problems.push("performedAtIso must be an ISO timestamp");
  if (!action.reason || action.reason.trim().length < 10) {
    problems.push("reason required (≥10 chars)");
  }
  const sequences = context?.existingSequencesByCoachId?.[action.coachId ?? ""] ?? [];
  const nextSequence = sequences.reduce((max, s) => Math.max(max, s), 0) + 1;
  if (action.coachId && action.actionId !== provisioningActionIdFor(action.coachId, nextSequence)) {
    problems.push(
      `actionId must be ${provisioningActionIdFor(action.coachId ?? "<coachId>", nextSequence)} (sequential, append-only)`,
    );
  }
  if (action.action === "provision") {
    if (!action.registryEntry || typeof action.registryEntry !== "object") {
      problems.push("provision requires the full registryEntry being installed");
    } else {
      if (action.registryEntry.coachId !== action.coachId) {
        problems.push("registryEntry.coachId must equal action.coachId");
      }
      if (action.registryEntry.status !== "active") {
        problems.push('provision must install status "active"');
      }
      for (const problem of validateCoachRegistryEntry(action.registryEntry)) {
        problems.push(`registryEntry: ${problem}`);
      }
    }
    if (sequences.length > 0) {
      problems.push("provision must be the FIRST action for a coachId (append-only history)");
    }
  } else if (action.action === "suspend" || action.action === "reinstate") {
    if (action.registryEntry !== null && action.registryEntry !== undefined) {
      problems.push(`${action.action} must carry registryEntry: null (status-only action)`);
    }
    if (
      context?.registryCoachIds &&
      action.coachId &&
      !context.registryCoachIds.includes(action.coachId)
    ) {
      problems.push(`${action.action} targets unknown coachId ${action.coachId}`);
    }
    if (sequences.length === 0) {
      problems.push(`${action.action} requires a prior provision action for this coachId`);
    }
  }
  return problems;
}

/** True when a registry entry may submit production reviews: active,
 * non-synthetic, and verdict-qualified under a known policy version. */
export function isEligibleReviewer(entry: CoachRegistryEntryV2 | undefined | null): boolean {
  if (!entry) return false;
  if (entry.status !== "active") return false;
  if (/synthetic/i.test(entry.coachId) || /synthetic/i.test(entry.credentialRef)) return false;
  if (validateCoachRegistryEntry(entry).length > 0) return false;
  return true;
}
