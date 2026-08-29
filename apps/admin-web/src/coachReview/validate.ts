import { EXPECTED_SCHEMA_VERSION, queueItemIdFor, reviewIdFor, type CoachReview } from "./types";

/**
 * Structural validator for coach review records.
 *
 * MIRROR of validateCoachReview in packages/swing-lab/src/coachReview.ts —
 * kept in the admin app so BOTH the form (live feedback) and the dev-server
 * persistence endpoint (vite.config.ts) enforce the same rules. The context
 * ids come from the emitted datasets/coach-review artifacts at runtime, so
 * enum drift is impossible.
 */

export interface ValidationContext {
  knownQueueItemIds: string[];
  knownFaultIds: string[];
  knownDrillIds: string[];
  strokeTaxonomyVersion: string;
  strokeLabels: string[];
  faultTaxonomyVersion: string;
  qualityScaleId: string;
}

const COACH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export function validateReview(raw: unknown, context: ValidationContext): string[] {
  const problems: string[] = [];
  const review = raw as Partial<CoachReview> | null;
  if (!review || typeof review !== "object") return ["review must be an object"];
  if (review.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${EXPECTED_SCHEMA_VERSION}`);
  }
  if (!review.coachId || !COACH_ID_PATTERN.test(review.coachId)) {
    problems.push("coachId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (review.coachId && /synthetic/i.test(review.coachId)) {
    problems.push("SYNTHETIC coach ids are dev fixtures and may never be persisted");
  }
  if (!review.coachCredentialRef || typeof review.coachCredentialRef !== "string") {
    problems.push("coachCredentialRef required (opaque credential record reference)");
  }
  if (!review.queueItemId) problems.push("queueItemId required");
  if (review.queueItemId && !context.knownQueueItemIds.includes(review.queueItemId)) {
    problems.push(`queueItemId ${review.queueItemId} not in the current queue`);
  }
  if (
    review.queueItemId &&
    review.coachId &&
    review.reviewId !== reviewIdFor(review.queueItemId, review.coachId)
  ) {
    problems.push("reviewId must equal `${queueItemId}.${coachId}`");
  }
  if (!review.eventRef?.caseId || typeof review.eventRef.eventIndex !== "number") {
    problems.push("eventRef {caseId, eventIndex} required");
  } else if (
    review.queueItemId &&
    queueItemIdFor(review.eventRef.caseId, review.eventRef.eventIndex) !== review.queueItemId
  ) {
    problems.push("eventRef must resolve to queueItemId");
  }
  if (review.strokeTaxonomyVersion !== context.strokeTaxonomyVersion) {
    problems.push(`strokeTaxonomyVersion must be ${context.strokeTaxonomyVersion}`);
  }
  if (review.faultTaxonomyVersion !== context.faultTaxonomyVersion) {
    problems.push(`faultTaxonomyVersion must be ${context.faultTaxonomyVersion}`);
  }
  const confirmation = review.strokeConfirmation;
  if (!confirmation) problems.push("strokeConfirmation required");
  else if (confirmation.kind === "cannot_judge") {
    if (!confirmation.reason || confirmation.reason.trim().length < 5) {
      problems.push("strokeConfirmation.cannot_judge requires a reason");
    }
  } else {
    if (!context.strokeLabels.includes(confirmation.stroke)) {
      problems.push(`stroke ${confirmation.stroke} not in ${context.strokeTaxonomyVersion}`);
    }
    if (
      confirmation.kind === "corrected" &&
      (!confirmation.note || confirmation.note.trim().length < 5)
    ) {
      problems.push("corrected stroke requires a note");
    }
  }
  const cannotEvaluate = review.cannotEvaluate;
  if (cannotEvaluate !== null && cannotEvaluate !== undefined) {
    if (!cannotEvaluate.reason || cannotEvaluate.reason.trim().length < 10) {
      problems.push("cannotEvaluate.reason required (≥10 chars)");
    }
  } else if (cannotEvaluate === undefined) {
    problems.push(
      "cannotEvaluate must be present (null or {reason}) — it is a first-class outcome",
    );
  }
  const quality = review.overallQuality;
  if (quality !== null && quality !== undefined) {
    if (quality.scaleId !== context.qualityScaleId) {
      problems.push(`overallQuality.scaleId must be ${context.qualityScaleId}`);
    }
    if (![1, 2, 3, 4, 5].includes(quality.value))
      problems.push("overallQuality.value must be 1..5");
  } else if (quality === undefined) {
    problems.push("overallQuality must be present (null or anchored value)");
  }
  if (!cannotEvaluate && quality === null && (review.faults?.length ?? 0) === 0) {
    problems.push("a review without cannotEvaluate must carry overallQuality and/or faults");
  }
  if (!Array.isArray(review.faults)) problems.push("faults[] required (may be empty)");
  else {
    for (const [index, fault] of review.faults.entries()) {
      if (!fault.faultId) problems.push(`faults[${index}].faultId required`);
      else if (!context.knownFaultIds.includes(fault.faultId)) {
        problems.push(
          `faults[${index}].faultId ${fault.faultId} not in ${context.faultTaxonomyVersion}`,
        );
      }
      if (![1, 2, 3].includes(fault.severity as number))
        problems.push(`faults[${index}].severity must be 1..3`);
      if (
        !fault.evidence ||
        !Array.isArray(fault.evidence.timestampsMs) ||
        fault.evidence.timestampsMs.length === 0
      ) {
        problems.push(`faults[${index}].evidence.timestampsMs requires ≥1 video timestamp`);
      } else if (
        fault.evidence.timestampsMs.some(
          (t) => typeof t !== "number" || !Number.isFinite(t) || t < 0,
        )
      ) {
        problems.push(`faults[${index}].evidence.timestampsMs must be non-negative ms numbers`);
      }
      const region = fault.evidence?.region;
      if (region !== null && region !== undefined) {
        const values = [region.x, region.y, region.w, region.h];
        if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
          problems.push(`faults[${index}].evidence.region must be normalized 0..1 {x,y,w,h}`);
        }
      }
      if (!fault.rationale || fault.rationale.trim().length < 10) {
        problems.push(`faults[${index}].rationale required (≥10 chars)`);
      }
    }
  }
  if (!Array.isArray(review.drillSuggestions))
    problems.push("drillSuggestions[] required (may be empty)");
  else {
    for (const [index, suggestion] of review.drillSuggestions.entries()) {
      if (suggestion.drillId !== null && !context.knownDrillIds.includes(suggestion.drillId)) {
        problems.push(
          `drillSuggestions[${index}].drillId ${suggestion.drillId} not in the drill library`,
        );
      }
      if (
        suggestion.drillId === null &&
        (!suggestion.freeText || suggestion.freeText.trim().length < 5)
      ) {
        problems.push(`drillSuggestions[${index}] needs a drillId or free text`);
      }
    }
  }
  if (
    typeof review.confidence !== "number" ||
    !Number.isFinite(review.confidence) ||
    review.confidence < 0 ||
    review.confidence > 1
  ) {
    problems.push("confidence must be 0..1");
  }
  if (
    !cannotEvaluate &&
    (typeof review.rationale !== "string" || review.rationale.trim().length < 20)
  ) {
    problems.push("rationale required (≥20 chars — the prose is the signal)");
  }
  for (const field of ["createdAtIso", "submittedAtIso"] as const) {
    const value = review[field];
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      problems.push(`${field} must be an ISO timestamp`);
    }
  }
  return problems;
}
