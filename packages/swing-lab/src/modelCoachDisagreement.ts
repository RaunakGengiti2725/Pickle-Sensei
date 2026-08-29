import {
  type CoachReview,
  validateCoachReview,
  COACH_REVIEW_SCHEMA_VERSION,
  TECHNIQUE_QUALITY_SCALE_V1,
} from "./coachReview.js";
import { isSyntheticIdentity, strokeVerdict, CANNOT_JUDGE } from "./coachAgreement.js";
import { STROKE_TAXONOMY_V3 } from "./strokeHeuristic.js";

/**
 * MODEL-vs-COACH DISAGREEMENT ADJUDICATION
 *
 * When a HIGH-CONFIDENCE model output later conflicts with a qualified coach
 * review, neither side may be treated as truth. Each conflict opens a
 * priority INVESTIGATION CASE that:
 *
 *   1. records both verdicts verbatim (nothing averaged away),
 *   2. enumerates the full hypothesis space for WHY they disagree
 *      (perception / contact / phase / feature / score / taxonomy /
 *      coach_variance — every hypothesis starts OPEN),
 *   3. requires MULTI-REVIEW ADJUDICATION — >= MIN_ADJUDICATION_REVIEWS
 *      additional independent qualified coach reviews of the same item —
 *      before either side can be upheld.
 *
 * Until adjudication resolves, truthStatusFor() reports
 * NEITHER_SIDE_IS_TRUTH: downstream consumers (training data, calibration,
 * gold labels) must exclude the item. Machine output never silently becomes
 * a gold label, and a single coach review never silently overrides a
 * high-confidence model output either — both are evidence, not verdicts.
 *
 * Storage contract (append-only, same discipline as reviews/):
 *   datasets/coach-review/investigations/<caseId>.json — one file per case;
 *   state transitions append new records via pure functions here; original
 *   conflict + all adjudication inputs stay frozen inside the record.
 *
 * Root-cause hypotheses are NOT auto-closed by adjudication: knowing which
 * verdict stands does not by itself prove which subsystem failed. Hypothesis
 * status changes are explicit, attributed, and carry written rationale.
 */

export const MODEL_COACH_DISAGREEMENT_VERSION = "model-coach-disagreement-v1" as const;

/** Model outputs at/above this confidence are "high-confidence": a conflict
 * with a qualified coach review is anomalous and must be investigated. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** Additional independent qualified reviews required before adjudication. */
export const MIN_ADJUDICATION_REVIEWS = 2;

/* ------------------------------------------------------------------------ *
 * HYPOTHESIS SPACE — why a high-confidence model and a coach can disagree
 * ------------------------------------------------------------------------ */

export const DISAGREEMENT_HYPOTHESES = [
  "perception",
  "contact",
  "phase",
  "feature",
  "score",
  "taxonomy",
  "coach_variance",
] as const;

export type DisagreementHypothesisId = (typeof DISAGREEMENT_HYPOTHESES)[number];

export const HYPOTHESIS_DESCRIPTIONS: Readonly<Record<DisagreementHypothesisId, string>> = {
  perception:
    "upstream perception failed (ball/paddle/player tracking, pose) and the model reasoned over bad inputs",
  contact: "contact-frame localization is wrong, so the model analyzed the wrong instant",
  phase:
    "phase segmentation misaligned the stroke window (wrong preparation/contact/follow-through bounds)",
  feature: "feature extraction produced wrong values from otherwise-correct inputs",
  score: "scoring/calibration mapped correct features to the wrong verdict or confidence",
  taxonomy:
    "the model's label space and the coach's vocabulary mean different things for this stroke (definition mismatch)",
  coach_variance:
    "legitimate coach-side variance — this review is an outlier relative to other qualified coaches",
};

export type HypothesisStatus = "open" | "supported" | "ruled_out";

export interface HypothesisState {
  hypothesisId: DisagreementHypothesisId;
  status: HypothesisStatus;
  /** Empty while open; mandatory written evidence for any status change. */
  rationale: string;
  /** Who changed the status (null while open — nobody has concluded anything). */
  changedBy: string | null;
  changedAtIso: string | null;
}

/* ------------------------------------------------------------------------ *
 * MODEL OUTPUT SNAPSHOT — what the model claimed, frozen verbatim
 * ------------------------------------------------------------------------ */

export interface ModelStrokeAssessment {
  queueItemId: string;
  eventRef: { caseId: string; eventIndex: number };
  /** Tool → version for every model/pipeline stage that produced this. */
  modelVersions: Record<string, string>;
  /** v3 stroke label the model committed to; null when it abstained. */
  strokeV3: string | null;
  /** Anchored 1..5 technique quality if the model emitted one; null otherwise. */
  techniqueQuality: {
    scaleId: typeof TECHNIQUE_QUALITY_SCALE_V1.id;
    value: 1 | 2 | 3 | 4 | 5;
  } | null;
  /** Model's own confidence 0..1 in this assessment. */
  confidence: number;
  generatedAtIso: string;
}

/* ------------------------------------------------------------------------ *
 * CONFLICT DETECTION
 * ------------------------------------------------------------------------ */

export type ConflictDimension = "stroke_identity" | "technique_quality";

export interface ModelCoachConflict {
  queueItemId: string;
  dimension: ConflictDimension;
  /** Both sides verbatim — the record adjudication starts from. */
  modelVerdict: string;
  modelConfidence: number;
  modelVersions: Record<string, string>;
  coachVerdict: string;
  coachId: string;
  coachConfidence: number;
  reviewId: string;
  detail: string;
}

export function qualityVerdict(review: CoachReview): string {
  if (review.cannotEvaluate !== null) return "CANNOT_EVALUATE";
  return review.overallQuality === null ? "NOT_RATED" : String(review.overallQuality.value);
}

/** Detects conflicts between HIGH-CONFIDENCE model assessments and qualified
 * coach reviews of the same queue item. Coach declines (cannot_judge /
 * cannotEvaluate / not rated) are honest outcomes, not conflicts. Synthetic
 * coach identities never produce investigation cases. */
export function detectModelCoachConflicts(
  assessments: ModelStrokeAssessment[],
  reviews: CoachReview[],
  highConfidenceThreshold: number = HIGH_CONFIDENCE_THRESHOLD,
): ModelCoachConflict[] {
  const conflicts: ModelCoachConflict[] = [];
  const byItem = new Map<string, ModelStrokeAssessment>();
  for (const assessment of assessments) {
    if (assessment.confidence >= highConfidenceThreshold) {
      byItem.set(assessment.queueItemId, assessment);
    }
  }
  const orderedReviews = [...reviews].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  for (const review of orderedReviews) {
    if (isSyntheticIdentity(review.coachId)) continue;
    const assessment = byItem.get(review.queueItemId);
    if (!assessment) continue;

    const coachStroke = strokeVerdict(review);
    if (
      assessment.strokeV3 !== null &&
      coachStroke !== CANNOT_JUDGE &&
      coachStroke !== assessment.strokeV3
    ) {
      conflicts.push({
        queueItemId: review.queueItemId,
        dimension: "stroke_identity",
        modelVerdict: assessment.strokeV3,
        modelConfidence: assessment.confidence,
        modelVersions: assessment.modelVersions,
        coachVerdict: coachStroke,
        coachId: review.coachId,
        coachConfidence: review.confidence,
        reviewId: review.reviewId,
        detail: `model ${assessment.strokeV3} (confidence ${assessment.confidence}) vs coach ${coachStroke}`,
      });
    }

    const coachQuality = qualityVerdict(review);
    if (
      assessment.techniqueQuality !== null &&
      review.cannotEvaluate === null &&
      review.overallQuality !== null &&
      Math.abs(assessment.techniqueQuality.value - review.overallQuality.value) >= 2
    ) {
      conflicts.push({
        queueItemId: review.queueItemId,
        dimension: "technique_quality",
        modelVerdict: String(assessment.techniqueQuality.value),
        modelConfidence: assessment.confidence,
        modelVersions: assessment.modelVersions,
        coachVerdict: coachQuality,
        coachId: review.coachId,
        coachConfidence: review.confidence,
        reviewId: review.reviewId,
        detail: `model quality ${assessment.techniqueQuality.value} vs coach ${coachQuality} (|Δ| >= 2)`,
      });
    }
  }
  return conflicts;
}

/* ------------------------------------------------------------------------ *
 * INVESTIGATION CASE — priority record; append-only lifecycle
 * ------------------------------------------------------------------------ */

export type InvestigationPriority = "high" | "critical";

export type AdjudicationOutcome = "model_upheld" | "coach_upheld" | "new_verdict" | "unresolved";

export interface AdjudicationEntry {
  /** Full additional review, frozen verbatim (append-only evidence). */
  review: CoachReview;
  /** The adjudicator's verdict on the conflicting dimension. */
  verdict: string;
  recordedAtIso: string;
}

export interface AdjudicationResolution {
  outcome: AdjudicationOutcome;
  /** The verdict that stands; null when unresolved (neither side is truth). */
  adjudicatedVerdict: string | null;
  adjudicatorIds: string[];
  rationale: string;
  adjudicatedAtIso: string;
}

export interface InvestigationCase {
  version: typeof MODEL_COACH_DISAGREEMENT_VERSION;
  /** `inv.${queueItemId}.${dimension}` — also the filename stem. */
  investigationId: string;
  priority: InvestigationPriority;
  status: "open" | "resolved";
  conflict: ModelCoachConflict;
  hypotheses: HypothesisState[];
  requiredAdjudicationReviews: number;
  adjudicationEntries: AdjudicationEntry[];
  resolution: AdjudicationResolution | null;
  openedAtIso: string;
}

export function investigationIdFor(queueItemId: string, dimension: ConflictDimension): string {
  return `inv.${queueItemId}.${dimension}`;
}

/** Opens a priority investigation case for a detected conflict. Every
 * hypothesis starts OPEN — detection categorizes the hypothesis SPACE, it
 * never concludes which hypothesis holds. */
export function openInvestigationCase(
  conflict: ModelCoachConflict,
  nowIso: string,
): InvestigationCase {
  return {
    version: MODEL_COACH_DISAGREEMENT_VERSION,
    investigationId: investigationIdFor(conflict.queueItemId, conflict.dimension),
    priority:
      conflict.modelConfidence >= 0.9 && conflict.coachConfidence >= 0.9 ? "critical" : "high",
    status: "open",
    conflict,
    hypotheses: DISAGREEMENT_HYPOTHESES.map((hypothesisId) => ({
      hypothesisId,
      status: "open",
      rationale: "",
      changedBy: null,
      changedAtIso: null,
    })),
    requiredAdjudicationReviews: MIN_ADJUDICATION_REVIEWS,
    adjudicationEntries: [],
    resolution: null,
    openedAtIso: nowIso,
  };
}

function adjudicatorVerdict(
  dimension: ConflictDimension,
  review: CoachReview,
): { verdict: string; usable: boolean } {
  if (dimension === "stroke_identity") {
    const verdict = strokeVerdict(review);
    return { verdict, usable: verdict !== CANNOT_JUDGE };
  }
  const verdict = qualityVerdict(review);
  return { verdict, usable: verdict !== "CANNOT_EVALUATE" && verdict !== "NOT_RATED" };
}

/** Records one additional independent qualified review on an open case.
 * Pure: returns a NEW case (append-only), never mutates. Refuses reviews
 * that are invalid, synthetic, off-item, from the original coach, or from a
 * coach who already adjudicated this case. An honest decline (cannot_judge /
 * cannotEvaluate on the conflicting dimension) is refused as adjudication
 * input — it is a valid review but carries no verdict to adjudicate with. */
export function recordAdjudicationReview(
  investigation: InvestigationCase,
  review: CoachReview,
  nowIso: string,
): { investigation: InvestigationCase; problems: string[] } {
  const problems: string[] = [];
  if (investigation.status === "resolved") {
    problems.push("case already resolved — open a new case for new conflicts");
  }
  problems.push(...validateCoachReview(review));
  if (isSyntheticIdentity(review.coachId)) {
    problems.push("synthetic coach identities may never adjudicate");
  }
  if (review.queueItemId !== investigation.conflict.queueItemId) {
    problems.push(
      `review is for ${review.queueItemId}, case is for ${investigation.conflict.queueItemId}`,
    );
  }
  if (review.coachId === investigation.conflict.coachId) {
    problems.push("adjudicator must be independent of the original reviewing coach");
  }
  if (investigation.adjudicationEntries.some((entry) => entry.review.coachId === review.coachId)) {
    problems.push(`coach ${review.coachId} already adjudicated this case`);
  }
  const { verdict, usable } = adjudicatorVerdict(investigation.conflict.dimension, review);
  if (!usable) {
    problems.push(
      `review carries no ${investigation.conflict.dimension} verdict (honest decline) — not usable as adjudication input`,
    );
  }
  if (problems.length > 0) return { investigation, problems };
  return {
    investigation: {
      ...investigation,
      adjudicationEntries: [
        ...investigation.adjudicationEntries,
        { review, verdict, recordedAtIso: nowIso },
      ],
    },
    problems: [],
  };
}

/** Attempts adjudication. Requires >= requiredAdjudicationReviews entries and
 * a UNANIMOUS adjudicator verdict; anything less leaves the case open with
 * outcome "unresolved" recorded nowhere — the disagreement stays live data.
 * Resolution never closes root-cause hypotheses: knowing which verdict
 * stands does not prove which subsystem failed. */
export function adjudicateCase(
  investigation: InvestigationCase,
  nowIso: string,
): InvestigationCase {
  if (investigation.status === "resolved") return investigation;
  const entries = investigation.adjudicationEntries;
  if (entries.length < investigation.requiredAdjudicationReviews) return investigation;
  const verdicts = [...new Set(entries.map((entry) => entry.verdict))];
  const adjudicatorIds = entries.map((entry) => entry.review.coachId).sort();
  if (verdicts.length > 1) {
    return {
      ...investigation,
      resolution: {
        outcome: "unresolved",
        adjudicatedVerdict: null,
        adjudicatorIds,
        rationale: `adjudicators split (${verdicts.sort().join(" vs ")}); disagreement preserved, neither side is truth`,
        adjudicatedAtIso: nowIso,
      },
    };
  }
  const agreed = verdicts[0]!;
  const { modelVerdict, coachVerdict } = investigation.conflict;
  const outcome: AdjudicationOutcome =
    agreed === modelVerdict
      ? "model_upheld"
      : agreed === coachVerdict
        ? "coach_upheld"
        : "new_verdict";
  return {
    ...investigation,
    status: "resolved",
    resolution: {
      outcome,
      adjudicatedVerdict: agreed,
      adjudicatorIds,
      rationale:
        outcome === "new_verdict"
          ? `adjudicators unanimously reached ${agreed}, differing from both the model (${modelVerdict}) and the original coach (${coachVerdict})`
          : `adjudicators unanimously reached ${agreed}, upholding the ${outcome === "model_upheld" ? "model" : "original coach"}; the other side's verdict is preserved as data`,
      adjudicatedAtIso: nowIso,
    },
  };
}

/** Explicit, attributed hypothesis status change with mandatory rationale.
 * Pure — returns a new case. */
export function updateHypothesis(
  investigation: InvestigationCase,
  hypothesisId: DisagreementHypothesisId,
  status: HypothesisStatus,
  rationale: string,
  changedBy: string,
  nowIso: string,
): { investigation: InvestigationCase; problems: string[] } {
  const problems: string[] = [];
  if (!investigation.hypotheses.some((h) => h.hypothesisId === hypothesisId)) {
    problems.push(`unknown hypothesis ${hypothesisId}`);
  }
  if (status !== "open" && rationale.trim().length < 10) {
    problems.push("hypothesis status change requires written rationale (>=10 chars)");
  }
  if (changedBy.trim().length === 0) problems.push("changedBy required");
  if (problems.length > 0) return { investigation, problems };
  return {
    investigation: {
      ...investigation,
      hypotheses: investigation.hypotheses.map((h) =>
        h.hypothesisId === hypothesisId
          ? { hypothesisId, status, rationale, changedBy, changedAtIso: nowIso }
          : h,
      ),
    },
    problems: [],
  };
}

/* ------------------------------------------------------------------------ *
 * TRUTH STATUS — what downstream consumers are allowed to believe
 * ------------------------------------------------------------------------ */

export type TruthStatus =
  | { kind: "NEITHER_SIDE_IS_TRUTH"; reason: string }
  | { kind: "ADJUDICATED"; verdict: string; outcome: AdjudicationOutcome };

/** Until multi-review adjudication resolves, NEITHER the model output NOR
 * the coach review may be treated as truth for this item/dimension. */
export function truthStatusFor(investigation: InvestigationCase): TruthStatus {
  const resolution = investigation.resolution;
  if (investigation.status !== "resolved" || resolution === null) {
    const remaining =
      investigation.requiredAdjudicationReviews - investigation.adjudicationEntries.length;
    return {
      kind: "NEITHER_SIDE_IS_TRUTH",
      reason:
        resolution?.outcome === "unresolved"
          ? "adjudicators split — disagreement preserved; escalate with further independent reviews"
          : `awaiting multi-review adjudication (${Math.max(remaining, 0)} more independent qualified review(s) required)`,
    };
  }
  if (resolution.outcome === "unresolved" || resolution.adjudicatedVerdict === null) {
    return {
      kind: "NEITHER_SIDE_IS_TRUTH",
      reason:
        "adjudicators split — disagreement preserved; escalate with further independent reviews",
    };
  }
  return {
    kind: "ADJUDICATED",
    verdict: resolution.adjudicatedVerdict,
    outcome: resolution.outcome,
  };
}

/* ------------------------------------------------------------------------ *
 * RECORD VALIDATION — for the append-only investigations/ store
 * ------------------------------------------------------------------------ */

export function validateInvestigationCase(raw: unknown): string[] {
  const problems: string[] = [];
  const record = raw as Partial<InvestigationCase> | null;
  if (!record || typeof record !== "object") return ["investigation case must be an object"];
  if (record.version !== MODEL_COACH_DISAGREEMENT_VERSION) {
    problems.push(`version must be ${MODEL_COACH_DISAGREEMENT_VERSION}`);
  }
  const conflict = record.conflict;
  if (!conflict || typeof conflict !== "object") {
    problems.push("conflict required (both verdicts verbatim)");
  } else {
    if (conflict.dimension !== "stroke_identity" && conflict.dimension !== "technique_quality") {
      problems.push("conflict.dimension must be stroke_identity|technique_quality");
    }
    if (
      record.investigationId !== undefined &&
      conflict.queueItemId !== undefined &&
      conflict.dimension !== undefined &&
      record.investigationId !== investigationIdFor(conflict.queueItemId, conflict.dimension)
    ) {
      problems.push("investigationId must equal `inv.${queueItemId}.${dimension}`");
    }
    if (
      typeof conflict.modelConfidence !== "number" ||
      conflict.modelConfidence < HIGH_CONFIDENCE_THRESHOLD
    ) {
      problems.push(
        `conflict.modelConfidence must be >= ${HIGH_CONFIDENCE_THRESHOLD} — only high-confidence conflicts open cases`,
      );
    }
    if (conflict.coachId && isSyntheticIdentity(conflict.coachId)) {
      problems.push("synthetic coach identities may never open investigation cases");
    }
    if (
      conflict.dimension === "stroke_identity" &&
      conflict.modelVerdict !== undefined &&
      !(STROKE_TAXONOMY_V3.labels as readonly string[]).includes(conflict.modelVerdict)
    ) {
      problems.push(
        `conflict.modelVerdict ${conflict.modelVerdict} not in ${STROKE_TAXONOMY_V3.version}`,
      );
    }
  }
  if (record.priority !== "high" && record.priority !== "critical") {
    problems.push("priority must be high|critical");
  }
  if (record.status !== "open" && record.status !== "resolved") {
    problems.push("status must be open|resolved");
  }
  if (!Array.isArray(record.hypotheses)) {
    problems.push("hypotheses[] required — the full hypothesis space must be enumerated");
  } else {
    const present = new Set(record.hypotheses.map((h) => h.hypothesisId));
    for (const hypothesisId of DISAGREEMENT_HYPOTHESES) {
      if (!present.has(hypothesisId)) {
        problems.push(`hypothesis ${hypothesisId} missing — the space may not be narrowed at open`);
      }
    }
    for (const [index, h] of record.hypotheses.entries()) {
      if (!DISAGREEMENT_HYPOTHESES.includes(h.hypothesisId)) {
        problems.push(`hypotheses[${index}].hypothesisId ${h.hypothesisId} unknown`);
      }
      if (!["open", "supported", "ruled_out"].includes(h.status)) {
        problems.push(`hypotheses[${index}].status must be open|supported|ruled_out`);
      }
      if (
        h.status !== "open" &&
        (typeof h.rationale !== "string" || h.rationale.trim().length < 10)
      ) {
        problems.push(`hypotheses[${index}] status change requires written rationale (>=10 chars)`);
      }
    }
  }
  if (
    typeof record.requiredAdjudicationReviews !== "number" ||
    record.requiredAdjudicationReviews < MIN_ADJUDICATION_REVIEWS
  ) {
    problems.push(`requiredAdjudicationReviews must be >= ${MIN_ADJUDICATION_REVIEWS}`);
  }
  if (!Array.isArray(record.adjudicationEntries)) {
    problems.push("adjudicationEntries[] required (may be empty while awaiting reviews)");
  } else {
    for (const [index, entry] of record.adjudicationEntries.entries()) {
      const review = entry.review as Partial<CoachReview> | undefined;
      if (!review || review.schemaVersion !== COACH_REVIEW_SCHEMA_VERSION) {
        problems.push(
          `adjudicationEntries[${index}].review must be a schema v${COACH_REVIEW_SCHEMA_VERSION} coach review`,
        );
      }
    }
  }
  if (record.status === "resolved") {
    const resolution = record.resolution;
    if (
      !resolution ||
      resolution.outcome === "unresolved" ||
      resolution.adjudicatedVerdict === null
    ) {
      problems.push("a resolved case requires a resolution with a standing verdict");
    }
    if (
      Array.isArray(record.adjudicationEntries) &&
      typeof record.requiredAdjudicationReviews === "number" &&
      record.adjudicationEntries.length < record.requiredAdjudicationReviews
    ) {
      problems.push(
        "a case may not resolve with fewer adjudication reviews than requiredAdjudicationReviews",
      );
    }
  }
  if (typeof record.openedAtIso !== "string" || Number.isNaN(Date.parse(record.openedAtIso))) {
    problems.push("openedAtIso must be an ISO timestamp");
  }
  return problems;
}
