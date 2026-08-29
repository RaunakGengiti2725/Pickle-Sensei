import type { CoachReview, QualityValue } from "./types";
import { validateReview, type ValidationContext } from "./validate";

/**
 * Lab-owned records that sit AROUND the mirrored CoachReview v2 schema
 * (which is owned by packages/swing-lab and stays untouched):
 *
 *  - assignments: which provisioned coaches are asked to review which
 *    queue items (admin-managed config, not review evidence);
 *  - amendments: append-only review versioning — the original review file
 *    is revision 1 and is never edited; each amendment is a full
 *    replacement CoachReview at revision N+1 in its own file;
 *  - adjudications: the docs/COACHING.md §6 record, one per queue item,
 *    written by a third coach who was not an original reviewer;
 *  - drill-mapping proposals: coach-endorsed fault→drill mapping evidence
 *    (the only path by which drill validatedFaultMappings can ever fill).
 *
 * All write paths share the review rules: provisioned identity required,
 * SYNTHETIC ids refused, storage append-only.
 */

const COACH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export interface AssignmentEntry {
  queueItemId: string;
  coachIds: string[];
  assignedAtIso: string;
  assignedBy: string;
}

export interface AssignmentsFile {
  schemaVersion: 1;
  note: string;
  assignments: AssignmentEntry[];
}

export const EMPTY_ASSIGNMENTS: AssignmentsFile = {
  schemaVersion: 1,
  note:
    "Admin-managed multi-coach assignment per queue item. coachIds must be active entries in coaches.json; " +
    "with an empty registry no assignment can exist. Assignments are workflow config, not review evidence.",
  assignments: [],
};

export function validateAssignment(
  entry: AssignmentEntry,
  context: { knownQueueItemIds: string[]; activeCoachIds: string[] },
): string[] {
  const problems: string[] = [];
  if (!context.knownQueueItemIds.includes(entry.queueItemId)) {
    problems.push(`queueItemId ${entry.queueItemId} not in the current queue`);
  }
  if (!Array.isArray(entry.coachIds) || entry.coachIds.length === 0) {
    problems.push("coachIds must list ≥1 provisioned coach");
  } else {
    for (const coachId of entry.coachIds) {
      if (/synthetic/i.test(coachId))
        problems.push(`SYNTHETIC coach ${coachId} can never be assigned`);
      else if (!context.activeCoachIds.includes(coachId)) {
        problems.push(`coach ${coachId} is not an active entry in coaches.json`);
      }
    }
    if (new Set(entry.coachIds).size !== entry.coachIds.length)
      problems.push("coachIds must be unique");
  }
  if (typeof entry.assignedAtIso !== "string" || Number.isNaN(Date.parse(entry.assignedAtIso))) {
    problems.push("assignedAtIso must be an ISO timestamp");
  }
  if (!entry.assignedBy || typeof entry.assignedBy !== "string")
    problems.push("assignedBy required");
  return problems;
}

export function amendmentIdFor(reviewId: string, revision: number): string {
  return `${reviewId}.r${revision}`;
}

export interface ReviewAmendment {
  schemaVersion: 1;
  amendmentId: string;
  reviewId: string;
  /** Revision 1 is the original review file; amendments start at 2. */
  revision: number;
  reason: string;
  review: CoachReview;
  createdAtIso: string;
}

export function validateAmendment(
  amendment: ReviewAmendment,
  context: ValidationContext,
): string[] {
  const problems: string[] = [];
  if (amendment.schemaVersion !== 1) problems.push("amendment schemaVersion must be 1");
  if (!Number.isInteger(amendment.revision) || amendment.revision < 2) {
    problems.push("revision must be an integer ≥2 (revision 1 is the original review)");
  }
  if (amendment.amendmentId !== amendmentIdFor(amendment.reviewId, amendment.revision)) {
    problems.push("amendmentId must equal `${reviewId}.r${revision}`");
  }
  if (!amendment.reason || amendment.reason.trim().length < 10) {
    problems.push("amendment reason required (≥10 chars)");
  }
  if (
    typeof amendment.createdAtIso !== "string" ||
    Number.isNaN(Date.parse(amendment.createdAtIso))
  ) {
    problems.push("createdAtIso must be an ISO timestamp");
  }
  if (!amendment.review || typeof amendment.review !== "object") {
    problems.push("review (full replacement record) required");
    return problems;
  }
  if (amendment.review.reviewId !== amendment.reviewId) {
    problems.push("embedded review.reviewId must equal the amended reviewId");
  }
  problems.push(...validateReview(amendment.review, context).map((p) => `review: ${p}`));
  return problems;
}

export type AdjudicationOutcome =
  | { kind: "uphold"; reviewId: string }
  | {
      kind: "new_verdict";
      stroke: string | null;
      overallQuality: QualityValue | null;
      primaryFaultId: string | null;
      note: string;
    }
  | { kind: "unresolvable"; reason: string };

export interface AdjudicationRecord {
  schemaVersion: 1;
  queueItemId: string;
  adjudicatorId: string;
  adjudicatorCredentialRef: string;
  /** The frozen disagreeing reviews this adjudication considered. */
  reviewedReviewIds: string[];
  outcome: AdjudicationOutcome;
  rationale: string;
  evidenceTimestampsMs: number[];
  createdAtIso: string;
}

export function validateAdjudication(
  record: AdjudicationRecord,
  context: ValidationContext & { reviewerCoachIdsByReviewId: Record<string, string> },
): string[] {
  const problems: string[] = [];
  if (record.schemaVersion !== 1) problems.push("adjudication schemaVersion must be 1");
  if (!record.queueItemId || !context.knownQueueItemIds.includes(record.queueItemId)) {
    problems.push(`queueItemId ${record.queueItemId ?? "(missing)"} not in the current queue`);
  }
  if (!record.adjudicatorId || !COACH_ID_PATTERN.test(record.adjudicatorId)) {
    problems.push("adjudicatorId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (record.adjudicatorId && /synthetic/i.test(record.adjudicatorId)) {
    problems.push("SYNTHETIC adjudicator ids are dev fixtures and may never be persisted");
  }
  if (!record.adjudicatorCredentialRef || typeof record.adjudicatorCredentialRef !== "string") {
    problems.push("adjudicatorCredentialRef required");
  }
  if (!Array.isArray(record.reviewedReviewIds) || record.reviewedReviewIds.length < 2) {
    problems.push("reviewedReviewIds must list the ≥2 disagreeing reviews");
  } else {
    for (const reviewId of record.reviewedReviewIds) {
      const reviewer = context.reviewerCoachIdsByReviewId[reviewId];
      if (reviewer === undefined)
        problems.push(`reviewedReviewIds: no persisted review ${reviewId}`);
      else if (reviewer === record.adjudicatorId) {
        problems.push("adjudicator must not be one of the original reviewers");
      }
    }
  }
  const outcome = record.outcome;
  if (!outcome || typeof outcome !== "object") problems.push("outcome required");
  else if (outcome.kind === "uphold") {
    if (!record.reviewedReviewIds?.includes(outcome.reviewId)) {
      problems.push("uphold outcome must name one of reviewedReviewIds");
    }
  } else if (outcome.kind === "new_verdict") {
    if (outcome.stroke !== null && !context.strokeLabels.includes(outcome.stroke)) {
      problems.push(`new_verdict stroke ${outcome.stroke} not in ${context.strokeTaxonomyVersion}`);
    }
    if (outcome.overallQuality !== null && ![1, 2, 3, 4, 5].includes(outcome.overallQuality)) {
      problems.push("new_verdict overallQuality must be null or 1..5");
    }
    if (
      outcome.primaryFaultId !== null &&
      !context.knownFaultIds.includes(outcome.primaryFaultId)
    ) {
      problems.push(
        `new_verdict primaryFaultId ${outcome.primaryFaultId} not in ${context.faultTaxonomyVersion}`,
      );
    }
    if (!outcome.note || outcome.note.trim().length < 5)
      problems.push("new_verdict requires a note");
  } else if (outcome.kind === "unresolvable") {
    if (!outcome.reason || outcome.reason.trim().length < 10) {
      problems.push("unresolvable outcome requires a reason (≥10 chars)");
    }
  } else {
    problems.push("outcome.kind must be uphold | new_verdict | unresolvable");
  }
  if (!record.rationale || record.rationale.trim().length < 20) {
    problems.push("adjudication rationale required (≥20 chars)");
  }
  if (
    !Array.isArray(record.evidenceTimestampsMs) ||
    record.evidenceTimestampsMs.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)
  ) {
    problems.push("evidenceTimestampsMs must be non-negative ms numbers (may be empty)");
  }
  if (typeof record.createdAtIso !== "string" || Number.isNaN(Date.parse(record.createdAtIso))) {
    problems.push("createdAtIso must be an ISO timestamp");
  }
  return problems;
}

export function mappingProposalIdFor(drillId: string, faultId: string, coachId: string): string {
  return `${drillId}.${faultId}.${coachId}`;
}

export interface DrillMappingProposal {
  schemaVersion: 1;
  proposalId: string;
  drillId: string;
  faultId: string;
  coachId: string;
  coachCredentialRef: string;
  /** Evidence references, e.g. reviewIds whose rationale supports the mapping. */
  evidence: string[];
  rationale: string;
  createdAtIso: string;
}

export function validateMappingProposal(
  proposal: DrillMappingProposal,
  context: ValidationContext,
): string[] {
  const problems: string[] = [];
  if (proposal.schemaVersion !== 1) problems.push("proposal schemaVersion must be 1");
  if (!proposal.drillId || !context.knownDrillIds.includes(proposal.drillId)) {
    problems.push(`drillId ${proposal.drillId ?? "(missing)"} not in the drill library`);
  }
  if (!proposal.faultId || !context.knownFaultIds.includes(proposal.faultId)) {
    problems.push(
      `faultId ${proposal.faultId ?? "(missing)"} not in ${context.faultTaxonomyVersion}`,
    );
  }
  if (!proposal.coachId || !COACH_ID_PATTERN.test(proposal.coachId)) {
    problems.push("coachId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (proposal.coachId && /synthetic/i.test(proposal.coachId)) {
    problems.push("SYNTHETIC coach ids are dev fixtures and may never be persisted");
  }
  if (!proposal.coachCredentialRef || typeof proposal.coachCredentialRef !== "string") {
    problems.push("coachCredentialRef required");
  }
  if (
    proposal.drillId &&
    proposal.faultId &&
    proposal.coachId &&
    proposal.proposalId !==
      mappingProposalIdFor(proposal.drillId, proposal.faultId, proposal.coachId)
  ) {
    problems.push("proposalId must equal `${drillId}.${faultId}.${coachId}`");
  }
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    problems.push("evidence requires ≥1 reference (e.g. a reviewId)");
  }
  if (!proposal.rationale || proposal.rationale.trim().length < 20) {
    problems.push("mapping rationale required (≥20 chars)");
  }
  if (
    typeof proposal.createdAtIso !== "string" ||
    Number.isNaN(Date.parse(proposal.createdAtIso))
  ) {
    problems.push("createdAtIso must be an ISO timestamp");
  }
  return problems;
}
