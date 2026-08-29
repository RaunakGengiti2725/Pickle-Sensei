import {
  DRILL_LIBRARY_V1,
  MIN_INDEPENDENT_COACH_ENDORSEMENTS,
  MIN_MAPPING_AGREEMENT,
  evaluateDrillRecommendation,
  validateFaultDrillMappingV1,
  type DrillEntryV1,
  type DrillRecommendationDecision,
  type DrillRecommendationInput,
  type FaultDrillMappingV1,
} from "./drillLibrary.js";

/**
 * DRILL-MAPPING GOVERNANCE v1 — the change-control layer over the v1 drill
 * library (wave h05).
 *
 * The v1 library defines WHAT a fault→drill mapping is and the evidence it
 * needs. This module defines HOW a mapping is allowed to CHANGE:
 *
 *  - Every governed mapping lives as an append-only chain of REVISIONS.
 *    Revision 1 is the initial record; every later revision must state a
 *    change reason, carry its own provenance, and bump the revision number
 *    by exactly one. Nothing is ever edited in place or deleted.
 *  - Re-pointing a fault to a DIFFERENT drill (FAULT X: DRILL A → DRILL B)
 *    is the highest-risk change. It requires: a revision bump, NEW
 *    provenance (the old provenance string may not be reused), and FRESH
 *    endorsements — endorsements from the previous revision may not be
 *    carried over, because coaches endorsed the OLD pairing, not the new one.
 *  - A mapping that loses support (endorsements withdrawn, agreement below
 *    threshold, media rights lost, taxonomy change) is DISABLED via a new
 *    disabled revision — never removed. Historical Results reference
 *    (mappingId, revision) and stay explainable forever: resolution returns
 *    the exact revision content plus the mapping's current lifecycle state.
 *  - Media rights are first-class evidence: every mediaRef on the mapped
 *    drill needs a CLEARED rights record before the governed gate will
 *    recommend. Rights are never assumed; missing records block, and a
 *    DENIED/expired record is a disable-worthy loss of support.
 *
 * TRUTH CONTRACT (inherited from drillLibrary.ts): nothing here fabricates
 * coach evidence. Governance only constrains transitions; the underlying
 * evidence requirements of the v1 validators and recommendation gate apply
 * unchanged, and today — with zero real coach endorsements — every governed
 * mapping remains UNVALIDATED and unrecommendable.
 */

export const DRILL_GOVERNANCE_V1_VERSION = "drill-governance-v1" as const;

/** Validation-process version a revision was checked under. Bumps when the
 * governance rules themselves change, so old approvals are auditable against
 * the rules that were in force at the time. */
export const GOVERNANCE_VALIDATION_VERSION = "drill-governance-validation-v1" as const;

/* ------------------------------------------------------------------------ *
 * MEDIA RIGHTS
 * ------------------------------------------------------------------------ */

export type MediaRightsLicense =
  "owned_first_party" | "licensed_written" | "public_domain" | "creative_commons";

export type MediaRightsStatus = "CLEARED" | "PENDING" | "DENIED" | "EXPIRED";

/** Rights record for one media asset referenced by a drill. CLEARED requires
 * a rights holder, a license basis, and an off-repo clearance record. */
export interface MediaRightsRecord {
  /** The drill mediaRef this record clears (exact match). */
  mediaRef: string;
  rightsHolder: string;
  license: MediaRightsLicense;
  /** Off-repo clearance record reference (e.g. "rights-2026-011"). */
  clearanceRef: string | null;
  clearedAtIso: string | null;
  /** null = perpetual; otherwise the record EXPIRES and must be renewed. */
  expiresAtIso: string | null;
  status: MediaRightsStatus;
}

export function validateMediaRightsRecord(record: MediaRightsRecord): string[] {
  const problems: string[] = [];
  if (record.mediaRef.trim().length === 0) problems.push("mediaRef required");
  if (record.status === "CLEARED") {
    if (record.rightsHolder.trim().length === 0) {
      problems.push(`${record.mediaRef}: CLEARED requires rightsHolder`);
    }
    if (record.clearanceRef === null || record.clearanceRef.trim().length === 0) {
      problems.push(`${record.mediaRef}: CLEARED requires clearanceRef`);
    }
    if (record.clearedAtIso === null || Number.isNaN(Date.parse(record.clearedAtIso))) {
      problems.push(`${record.mediaRef}: CLEARED requires ISO clearedAtIso`);
    }
  }
  if (record.expiresAtIso !== null && Number.isNaN(Date.parse(record.expiresAtIso))) {
    problems.push(`${record.mediaRef}: expiresAtIso must be null or an ISO timestamp`);
  }
  return problems;
}

/** A record is usable only while CLEARED and unexpired at the given moment. */
export function mediaRightsUsable(record: MediaRightsRecord, atIso: string): boolean {
  if (record.status !== "CLEARED") return false;
  if (record.expiresAtIso !== null && Date.parse(record.expiresAtIso) <= Date.parse(atIso)) {
    return false;
  }
  return true;
}

/** Every mediaRef on the drill must have a usable rights record. Drills with
 * no media need no records. Returns blocking problems (empty = clear). */
export function checkDrillMediaRights(
  drill: DrillEntryV1,
  rights: readonly MediaRightsRecord[],
  atIso: string,
): string[] {
  const problems: string[] = [];
  for (const mediaRef of drill.mediaRefs) {
    const record = rights.find((candidate) => candidate.mediaRef === mediaRef);
    if (!record) {
      problems.push(`no media-rights record for ${mediaRef}`);
      continue;
    }
    problems.push(...validateMediaRightsRecord(record));
    if (!mediaRightsUsable(record, atIso)) {
      problems.push(`media rights for ${mediaRef} not usable (status ${record.status})`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * GOVERNED REVISIONS
 * ------------------------------------------------------------------------ */

export type MappingLifecycleStatus = "active" | "superseded" | "disabled";

export type MappingDisableReason =
  | "endorsement_withdrawn"
  | "agreement_below_threshold"
  | "media_rights_lost"
  | "fault_taxonomy_change"
  | "coach_retraction"
  | "safety_concern";

export interface MappingDisableRecord {
  reason: MappingDisableReason;
  detail: string;
  disabledAtIso: string;
  /** Who/what decided the disable (e.g. "governance sweep 2026-09", a coach
   * retraction reviewRef). Never empty. */
  decidedBy: string;
}

/** One immutable revision of a governed fault→drill mapping. The chain for a
 * mappingId is append-only; content of past revisions never changes. */
export interface GovernedMappingRevision {
  /** Stable across revisions: the identity of the governed mapping. */
  mappingId: string;
  /** 1-based, bumps by exactly 1 per revision. */
  revision: number;
  /** Full mapping content AT this revision (its mappingId must match). */
  mapping: FaultDrillMappingV1;
  status: MappingLifecycleStatus;
  createdAtIso: string;
  /** Provenance of THIS revision — who proposed/authored the change. */
  provenance: string;
  /** Required for every revision > 1; null only on revision 1. */
  changeReason: string | null;
  /** revision - 1 for revision > 1; null on revision 1. */
  previousRevision: number | null;
  /** Present iff status === "disabled". */
  disabled: MappingDisableRecord | null;
  /** Rights records for the mapped drill's media, as evaluated for this
   * revision. Empty when the drill has no media. */
  mediaRights: MediaRightsRecord[];
  validationVersion: typeof GOVERNANCE_VALIDATION_VERSION;
  governanceVersion: typeof DRILL_GOVERNANCE_V1_VERSION;
}

export function validateGovernedRevision(revision: GovernedMappingRevision): string[] {
  const problems: string[] = [];
  if (revision.governanceVersion !== DRILL_GOVERNANCE_V1_VERSION) {
    problems.push(`governanceVersion must be ${DRILL_GOVERNANCE_V1_VERSION}`);
  }
  if (revision.validationVersion !== GOVERNANCE_VALIDATION_VERSION) {
    problems.push(`validationVersion must be ${GOVERNANCE_VALIDATION_VERSION}`);
  }
  if (!Number.isInteger(revision.revision) || revision.revision < 1) {
    problems.push("revision must be an integer ≥ 1");
  }
  if (revision.mapping.mappingId !== revision.mappingId) {
    problems.push(
      `mapping content id ${revision.mapping.mappingId} must match governed id ${revision.mappingId}`,
    );
  }
  if (Number.isNaN(Date.parse(revision.createdAtIso))) {
    problems.push("createdAtIso must be an ISO timestamp");
  }
  if (revision.provenance.trim().length < 10) {
    problems.push("provenance required (≥10 chars, stated plainly)");
  }
  if (revision.revision === 1) {
    if (revision.previousRevision !== null)
      problems.push("revision 1 must have previousRevision null");
    if (revision.changeReason !== null) problems.push("revision 1 must have changeReason null");
  } else {
    if (revision.previousRevision !== revision.revision - 1) {
      problems.push("previousRevision must be revision - 1");
    }
    if (revision.changeReason === null || revision.changeReason.trim().length < 10) {
      problems.push("revisions > 1 require an explicit changeReason (≥10 chars)");
    }
  }
  if (revision.status === "disabled") {
    if (revision.disabled === null) {
      problems.push("disabled revisions require a disable record");
    } else {
      if (revision.disabled.detail.trim().length < 10) {
        problems.push("disable record requires detail (≥10 chars)");
      }
      if (revision.disabled.decidedBy.trim().length === 0) {
        problems.push("disable record requires decidedBy");
      }
      if (Number.isNaN(Date.parse(revision.disabled.disabledAtIso))) {
        problems.push("disable record disabledAtIso must be an ISO timestamp");
      }
    }
  } else if (revision.disabled !== null) {
    problems.push(`status ${revision.status} must not carry a disable record`);
  }
  for (const record of revision.mediaRights) {
    problems.push(...validateMediaRightsRecord(record));
  }
  problems.push(
    ...validateFaultDrillMappingV1(revision.mapping).map((problem) => `mapping: ${problem}`),
  );
  return problems;
}

/* ------------------------------------------------------------------------ *
 * TRANSITION RULES — how one revision may follow another
 * ------------------------------------------------------------------------ */

function endorsementKey(endorsement: FaultDrillMappingV1["endorsements"][number]): string {
  return `${endorsement.coachId}|${endorsement.reviewRef}`;
}

/**
 * Rules for `next` directly succeeding `previous` in a mapping's chain:
 *  1. same mappingId, revision bumps by exactly 1, previousRevision links back;
 *  2. the fault never changes (a different fault is a DIFFERENT mapping);
 *  3. re-pointing to a different drill requires NEW provenance (the previous
 *     provenance string may not be reused) and FRESH endorsements — no
 *     endorsement (coachId + reviewRef) from the previous revision may be
 *     carried over, and validation state resets with them;
 *  4. any content change requires a stated changeReason;
 *  5. a disabled revision may only be followed by a revision that states the
 *     re-enable in its changeReason (nothing silently resurrects).
 */
export function validateRevisionTransition(
  previous: GovernedMappingRevision,
  next: GovernedMappingRevision,
): string[] {
  const problems: string[] = [];
  if (next.mappingId !== previous.mappingId) {
    problems.push("transition must stay within one mappingId chain");
  }
  if (next.revision !== previous.revision + 1) {
    problems.push(
      `revision must bump by exactly 1 (${previous.revision} → ${next.revision} rejected)`,
    );
  }
  if (next.previousRevision !== previous.revision) {
    problems.push("next.previousRevision must reference the previous revision");
  }
  if (next.mapping.faultId !== previous.mapping.faultId) {
    problems.push("faultId may never change across revisions — a different fault is a new mapping");
  }
  if (Date.parse(next.createdAtIso) < Date.parse(previous.createdAtIso)) {
    problems.push("next.createdAtIso must not precede previous.createdAtIso");
  }
  if (next.changeReason === null || next.changeReason.trim().length < 10) {
    problems.push("every successor revision requires an explicit changeReason (≥10 chars)");
  }

  const drillChanged = next.mapping.drillId !== previous.mapping.drillId;
  if (drillChanged) {
    if (next.provenance.trim() === previous.provenance.trim()) {
      problems.push(
        "re-pointing the fault to a different drill requires NEW provenance — the previous provenance may not be reused",
      );
    }
    const previousKeys = new Set(previous.mapping.endorsements.map(endorsementKey));
    for (const endorsement of next.mapping.endorsements) {
      if (previousKeys.has(endorsementKey(endorsement))) {
        problems.push(
          `endorsement ${endorsement.coachId}/${endorsement.reviewRef} was given for ${previous.mapping.drillId} and may not be carried over to ${next.mapping.drillId}`,
        );
      }
    }
    if (
      next.mapping.validationState === "COACH_VALIDATED" &&
      next.mapping.endorsements.length === 0
    ) {
      problems.push("a re-pointed mapping cannot be COACH_VALIDATED without fresh endorsements");
    }
  }

  if (previous.status === "disabled" && next.status !== "disabled") {
    const reason = next.changeReason ?? "";
    if (!/re-?enable/i.test(reason)) {
      problems.push(
        "a revision following a disabled revision must state the re-enable explicitly in changeReason",
      );
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * LEDGER — append-only chains per mappingId
 * ------------------------------------------------------------------------ */

export interface GovernedMappingLedger {
  governanceVersion: typeof DRILL_GOVERNANCE_V1_VERSION;
  /** All revisions, all mappings. Append-only. */
  revisions: GovernedMappingRevision[];
}

export function createLedger(): GovernedMappingLedger {
  return { governanceVersion: DRILL_GOVERNANCE_V1_VERSION, revisions: [] };
}

export function revisionsFor(
  ledger: GovernedMappingLedger,
  mappingId: string,
): GovernedMappingRevision[] {
  return ledger.revisions
    .filter((revision) => revision.mappingId === mappingId)
    .sort((a, b) => a.revision - b.revision);
}

export function headRevision(
  ledger: GovernedMappingLedger,
  mappingId: string,
): GovernedMappingRevision | null {
  const chain = revisionsFor(ledger, mappingId);
  return chain.length > 0 ? chain[chain.length - 1]! : null;
}

export type AppendResult =
  { ok: true; revision: GovernedMappingRevision } | { ok: false; problems: string[] };

/** The ONLY sanctioned write path. Validates the revision in isolation, then
 * the transition from the current head. On success the previous head is
 * marked superseded (lifecycle only — its content is untouched). */
export function appendRevision(
  ledger: GovernedMappingLedger,
  revision: GovernedMappingRevision,
): AppendResult {
  const problems = validateGovernedRevision(revision);
  const head = headRevision(ledger, revision.mappingId);
  if (head === null) {
    if (revision.revision !== 1) {
      problems.push(`first revision of ${revision.mappingId} must be revision 1`);
    }
  } else {
    problems.push(...validateRevisionTransition(head, revision));
  }
  if (problems.length > 0) return { ok: false, problems };
  if (head !== null && head.status === "active") {
    head.status = "superseded";
  }
  ledger.revisions.push(revision);
  return { ok: true, revision };
}

/** Register a library mapping under governance as revision 1. */
export function registerMapping(
  ledger: GovernedMappingLedger,
  mapping: FaultDrillMappingV1,
  input: { createdAtIso: string; provenance: string; mediaRights?: MediaRightsRecord[] },
): AppendResult {
  return appendRevision(ledger, {
    mappingId: mapping.mappingId,
    revision: 1,
    mapping,
    status: "active",
    createdAtIso: input.createdAtIso,
    provenance: input.provenance,
    changeReason: null,
    previousRevision: null,
    disabled: null,
    mediaRights: input.mediaRights ?? [],
    validationVersion: GOVERNANCE_VALIDATION_VERSION,
    governanceVersion: DRILL_GOVERNANCE_V1_VERSION,
  });
}

/** Propose the next revision of an existing governed mapping. */
export function proposeRevision(
  ledger: GovernedMappingLedger,
  mappingId: string,
  input: {
    mapping: FaultDrillMappingV1;
    createdAtIso: string;
    provenance: string;
    changeReason: string;
    mediaRights?: MediaRightsRecord[];
  },
): AppendResult {
  const head = headRevision(ledger, mappingId);
  if (head === null) {
    return { ok: false, problems: [`no governed mapping ${mappingId} to revise`] };
  }
  return appendRevision(ledger, {
    mappingId,
    revision: head.revision + 1,
    mapping: input.mapping,
    status: "active",
    createdAtIso: input.createdAtIso,
    provenance: input.provenance,
    changeReason: input.changeReason,
    previousRevision: head.revision,
    disabled: null,
    mediaRights: input.mediaRights ?? head.mediaRights,
    validationVersion: GOVERNANCE_VALIDATION_VERSION,
    governanceVersion: DRILL_GOVERNANCE_V1_VERSION,
  });
}

/** Safe disable: appends a disabled revision preserving the head's mapping
 * content verbatim. Historical revisions and Results stay resolvable. */
export function disableMapping(
  ledger: GovernedMappingLedger,
  mappingId: string,
  input: {
    reason: MappingDisableReason;
    detail: string;
    decidedBy: string;
    disabledAtIso: string;
  },
): AppendResult {
  const head = headRevision(ledger, mappingId);
  if (head === null) {
    return { ok: false, problems: [`no governed mapping ${mappingId} to disable`] };
  }
  if (head.status === "disabled") {
    return { ok: false, problems: [`${mappingId} is already disabled`] };
  }
  return appendRevision(ledger, {
    mappingId,
    revision: head.revision + 1,
    mapping: head.mapping,
    status: "disabled",
    createdAtIso: input.disabledAtIso,
    provenance: `disable decision by ${input.decidedBy}`,
    changeReason: `disabled (${input.reason}): ${input.detail}`,
    previousRevision: head.revision,
    disabled: {
      reason: input.reason,
      detail: input.detail,
      disabledAtIso: input.disabledAtIso,
      decidedBy: input.decidedBy,
    },
    mediaRights: head.mediaRights,
    validationVersion: GOVERNANCE_VALIDATION_VERSION,
    governanceVersion: DRILL_GOVERNANCE_V1_VERSION,
  });
}

/* ------------------------------------------------------------------------ *
 * SUPPORT SWEEP — detect mappings that lost support (never auto-fabricates)
 * ------------------------------------------------------------------------ */

export interface LostSupportFinding {
  mappingId: string;
  revision: number;
  reason: MappingDisableReason;
  detail: string;
}

/** Report ACTIVE heads whose claimed validation no longer has the evidence
 * behind it: endorsements below minimum, agreement below threshold, or media
 * rights no longer usable. UNVALIDATED mappings claim nothing and are never
 * flagged. Reporting only — disabling stays an explicit, attributed act. */
export function findLostSupport(
  ledger: GovernedMappingLedger,
  atIso: string,
  drills: readonly DrillEntryV1[] = DRILL_LIBRARY_V1.drills,
): LostSupportFinding[] {
  const findings: LostSupportFinding[] = [];
  const mappingIds = [...new Set(ledger.revisions.map((revision) => revision.mappingId))];
  for (const mappingId of mappingIds) {
    const head = headRevision(ledger, mappingId);
    if (head === null || head.status !== "active") continue;
    if (head.mapping.validationState !== "COACH_VALIDATED") continue;
    const coachIds = new Set(head.mapping.endorsements.map((endorsement) => endorsement.coachId));
    if (coachIds.size < MIN_INDEPENDENT_COACH_ENDORSEMENTS) {
      findings.push({
        mappingId,
        revision: head.revision,
        reason: "endorsement_withdrawn",
        detail: `independent endorsements ${coachIds.size} below required ${MIN_INDEPENDENT_COACH_ENDORSEMENTS}`,
      });
    }
    if (
      head.mapping.agreement === null ||
      head.mapping.agreement.fraction < MIN_MAPPING_AGREEMENT
    ) {
      findings.push({
        mappingId,
        revision: head.revision,
        reason: "agreement_below_threshold",
        detail: `agreement ${head.mapping.agreement?.fraction ?? "null"} below required ${MIN_MAPPING_AGREEMENT}`,
      });
    }
    const drill = drills.find((entry) => entry.drillId === head.mapping.drillId);
    if (drill) {
      const rightsProblems = checkDrillMediaRights(drill, head.mediaRights, atIso);
      if (rightsProblems.length > 0) {
        findings.push({
          mappingId,
          revision: head.revision,
          reason: "media_rights_lost",
          detail: rightsProblems.join("; "),
        });
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------------ *
 * HISTORICAL EXPLAINABILITY — Results outlive lifecycle changes
 * ------------------------------------------------------------------------ */

/** How a historical Result references the mapping that produced it. */
export interface HistoricalMappingRef {
  mappingId: string;
  revision: number;
}

export interface HistoricalMappingExplanation {
  /** The exact revision content that was in force when the Result was made. */
  revisionRecord: GovernedMappingRevision;
  /** Lifecycle state of that specific revision NOW. */
  revisionStatusNow: MappingLifecycleStatus;
  /** Lifecycle state of the mapping's current head NOW. */
  mappingStatusNow: MappingLifecycleStatus;
  /** Plain-language explanation suitable for showing next to an old Result. */
  explanation: string;
}

export type HistoricalResolution =
  { resolved: true; value: HistoricalMappingExplanation } | { resolved: false; problems: string[] };

/** Resolve a historical Result's mapping reference. Always succeeds for any
 * revision that ever existed — disabling never breaks explainability. */
export function explainHistoricalMapping(
  ledger: GovernedMappingLedger,
  ref: HistoricalMappingRef,
): HistoricalResolution {
  const chain = revisionsFor(ledger, ref.mappingId);
  if (chain.length === 0) {
    return { resolved: false, problems: [`unknown mappingId ${ref.mappingId}`] };
  }
  const revisionRecord = chain.find((revision) => revision.revision === ref.revision);
  if (!revisionRecord) {
    return {
      resolved: false,
      problems: [`mapping ${ref.mappingId} has no revision ${ref.revision}`],
    };
  }
  const head = chain[chain.length - 1]!;
  const parts = [
    `Recommendation used ${ref.mappingId} revision ${ref.revision} ` +
      `(fault ${revisionRecord.mapping.faultId} → drill ${revisionRecord.mapping.drillId}, ` +
      `validation state ${revisionRecord.mapping.validationState}).`,
  ];
  if (head.status === "disabled" && head.disabled !== null) {
    parts.push(
      `This mapping was later disabled on ${head.disabled.disabledAtIso} ` +
        `(${head.disabled.reason}): ${head.disabled.detail}. ` +
        "The historical result above remains a faithful record of what was recommended at the time.",
    );
  } else if (revisionRecord.revision !== head.revision) {
    parts.push(
      `The mapping has since moved to revision ${head.revision} ` +
        `(fault ${head.mapping.faultId} → drill ${head.mapping.drillId}).`,
    );
  }
  return {
    resolved: true,
    value: {
      revisionRecord,
      revisionStatusNow: revisionRecord.status,
      mappingStatusNow: head.status,
      explanation: parts.join(" "),
    },
  };
}

/* ------------------------------------------------------------------------ *
 * GOVERNED RECOMMENDATION GATE
 * ------------------------------------------------------------------------ */

export type GovernedRecommendationDecision =
  | { decision: "recommend"; drillId: string; mappingId: string; revision: number }
  | { decision: "abstain"; reasons: string[] };

/** The governed gate: everything the v1 gate requires, PLUS the mapping must
 * be the ACTIVE head of its governed chain with usable media rights at the
 * time of recommendation. Disabled or superseded revisions never recommend. */
export function evaluateGovernedRecommendation(
  ledger: GovernedMappingLedger,
  input: DrillRecommendationInput,
  atIso: string,
): GovernedRecommendationDecision {
  const reasons: string[] = [];
  const head = headRevision(ledger, input.mapping.mappingId);
  if (head === null) {
    reasons.push(`mapping ${input.mapping.mappingId} is not under governance`);
  } else {
    if (head.status !== "active") {
      reasons.push(`mapping ${input.mapping.mappingId} head is ${head.status}, not active`);
    }
    if (
      head.mapping !== input.mapping &&
      JSON.stringify(head.mapping) !== JSON.stringify(input.mapping)
    ) {
      reasons.push("input mapping does not match the governed head revision content");
    }
    reasons.push(...checkDrillMediaRights(input.drill, head.mediaRights, atIso));
  }
  const base: DrillRecommendationDecision = evaluateDrillRecommendation(input);
  if (base.decision === "abstain") reasons.push(...base.reasons);
  if (head === null || reasons.length > 0) return { decision: "abstain", reasons };
  return {
    decision: "recommend",
    drillId: input.drill.drillId,
    mappingId: input.mapping.mappingId,
    revision: head.revision,
  };
}
