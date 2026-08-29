import {
  EXPECTED_SCHEMA_VERSION,
  SKILL_LEVEL_RELEVANCE,
  STROKE_PHASES,
  queueItemIdFor,
  reviewIdFor,
  type CoachReview,
} from "./types";

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
  const knownPhaseIds = STROKE_PHASES.map((phase) => phase.id) as string[];
  if (!Array.isArray(review.phaseEvaluations)) {
    problems.push("phaseEvaluations[] required (may be empty only with cannotEvaluate)");
  } else {
    if (!cannotEvaluate && review.phaseEvaluations.length === 0) {
      problems.push(
        "phaseEvaluations requires ≥1 entry unless cannotEvaluate (use not_observable per phase)",
      );
    }
    const seenPhases = new Set<string>();
    for (const [index, evaluation] of review.phaseEvaluations.entries()) {
      if (!knownPhaseIds.includes(evaluation.phaseId)) {
        problems.push(`phaseEvaluations[${index}].phaseId ${evaluation.phaseId} unknown`);
      } else if (seenPhases.has(evaluation.phaseId)) {
        problems.push(`phaseEvaluations[${index}] duplicates phase ${evaluation.phaseId}`);
      } else {
        seenPhases.add(evaluation.phaseId);
      }
      if (
        !["good", "minor_issue", "major_issue", "not_observable"].includes(evaluation.assessment)
      ) {
        problems.push(
          `phaseEvaluations[${index}].assessment must be good|minor_issue|major_issue|not_observable`,
        );
      }
      if (typeof evaluation.note !== "string") {
        problems.push(`phaseEvaluations[${index}].note must be a string (may be empty)`);
      } else if (
        (evaluation.assessment === "minor_issue" || evaluation.assessment === "major_issue") &&
        evaluation.note.trim().length < 5
      ) {
        problems.push(`phaseEvaluations[${index}].note required (≥5 chars) when flagging an issue`);
      }
    }
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
      const frames = fault.evidence?.frames;
      if (!Array.isArray(frames)) {
        problems.push(`faults[${index}].evidence.frames must be an array (may be empty)`);
      } else if (frames.some((f) => !Number.isInteger(f) || f < 0)) {
        problems.push(`faults[${index}].evidence.frames must be non-negative frame indices`);
      }
      if (!fault.rationale || fault.rationale.trim().length < 10) {
        problems.push(`faults[${index}].rationale required (≥10 chars)`);
      }
    }
  }
  if (review.primaryFaultId === undefined) {
    problems.push("primaryFaultId must be present (null only when faults is empty)");
  } else if (Array.isArray(review.faults)) {
    if (review.faults.length === 0 && review.primaryFaultId !== null) {
      problems.push("primaryFaultId must be null when faults is empty");
    }
    if (review.faults.length > 0 && review.primaryFaultId === null) {
      problems.push("primaryFaultId required when faults are present");
    }
    if (
      review.primaryFaultId !== null &&
      !review.faults.some((fault) => fault.faultId === review.primaryFaultId)
    ) {
      problems.push("primaryFaultId must be one of faults[].faultId");
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
      if (!suggestion.whyApplies || suggestion.whyApplies.trim().length < 10) {
        problems.push(`drillSuggestions[${index}].whyApplies required (≥10 chars)`);
      }
      if (suggestion.role !== "recommended" && suggestion.role !== "alternative") {
        problems.push(`drillSuggestions[${index}].role must be recommended|alternative`);
      }
      for (const field of ["progressionNote", "regressionNote", "equipmentNote"] as const) {
        const value = suggestion[field];
        if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
          problems.push(`drillSuggestions[${index}].${field} must be null or non-empty text`);
        }
      }
      if (!SKILL_LEVEL_RELEVANCE.includes(suggestion.skillLevelRelevance)) {
        problems.push(
          `drillSuggestions[${index}].skillLevelRelevance must be one of ${SKILL_LEVEL_RELEVANCE.join("|")}`,
        );
      }
    }
    if (
      review.drillSuggestions.some((s) => s.role === "alternative") &&
      !review.drillSuggestions.some((s) => s.role === "recommended")
    ) {
      problems.push("an alternative drill requires at least one recommended drill");
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
  problems.push(...validateProvenance(review));
  return problems;
}

function validateProvenance(review: Partial<CoachReview>): string[] {
  const problems: string[] = [];
  const provenance = review.provenance;
  if (!provenance || typeof provenance !== "object") {
    return [
      "provenance required (qualification snapshot, videoRef, analysisVersions, rawLabelsShown, adjudicationState)",
    ];
  }
  const snapshot = provenance.coachQualificationSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    problems.push("provenance.coachQualificationSnapshot required");
  } else {
    if (review.coachId && snapshot.coachId !== review.coachId) {
      problems.push("provenance.coachQualificationSnapshot.coachId must match review.coachId");
    }
    if (review.coachCredentialRef && snapshot.credentialRef !== review.coachCredentialRef) {
      problems.push(
        "provenance.coachQualificationSnapshot.credentialRef must match review.coachCredentialRef",
      );
    }
    if (snapshot.registryStatus !== "active") {
      problems.push("provenance.coachQualificationSnapshot.registryStatus must be 'active'");
    }
    for (const field of ["provisionedAtIso", "snapshotAtIso"] as const) {
      const value = snapshot[field];
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        problems.push(`provenance.coachQualificationSnapshot.${field} must be an ISO timestamp`);
      }
    }
    if (typeof snapshot.provisionedBy !== "string" || snapshot.provisionedBy.trim().length === 0) {
      problems.push("provenance.coachQualificationSnapshot.provisionedBy required");
    }
  }
  const videoRef = provenance.videoRef;
  if (!videoRef || typeof videoRef !== "object") {
    problems.push("provenance.videoRef required");
  } else {
    if (typeof videoRef.path !== "string" || videoRef.path.trim().length === 0) {
      problems.push("provenance.videoRef.path required");
    }
    if (videoRef.annotatorId !== null && typeof videoRef.annotatorId !== "string") {
      problems.push("provenance.videoRef.annotatorId must be null or a string");
    }
    if (videoRef.annotationRevision !== null && !Number.isInteger(videoRef.annotationRevision)) {
      problems.push("provenance.videoRef.annotationRevision must be null or an integer");
    }
  }
  const analysisVersions = provenance.analysisVersions;
  if (
    !analysisVersions ||
    typeof analysisVersions !== "object" ||
    Array.isArray(analysisVersions)
  ) {
    problems.push("provenance.analysisVersions required (record of tool → version; may be empty)");
  } else if (Object.values(analysisVersions).some((v) => typeof v !== "string" || v.length === 0)) {
    problems.push("provenance.analysisVersions values must be non-empty strings");
  }
  const rawLabels = provenance.rawLabelsShown;
  if (rawLabels === undefined) {
    problems.push("provenance.rawLabelsShown must be present (null when the coach saw no labels)");
  } else if (rawLabels !== null) {
    if (rawLabels.annotatedStrokeV3 !== null && typeof rawLabels.annotatedStrokeV3 !== "string") {
      problems.push("provenance.rawLabelsShown.annotatedStrokeV3 must be null or a string");
    }
    if (rawLabels.contactMs !== null && typeof rawLabels.contactMs !== "number") {
      problems.push("provenance.rawLabelsShown.contactMs must be null or a number");
    }
    if (
      rawLabels.windowMs !== null &&
      (typeof rawLabels.windowMs?.start !== "number" || typeof rawLabels.windowMs?.end !== "number")
    ) {
      problems.push("provenance.rawLabelsShown.windowMs must be null or {start, end} in ms");
    }
  }
  if (provenance.adjudicationState !== "unadjudicated") {
    problems.push(
      "provenance.adjudicationState must be 'unadjudicated' at submission — adjudication is a separate append-only record",
    );
  }
  return problems;
}
