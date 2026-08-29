/**
 * GOLD-LABEL ADMISSION + RELEASE-STATUS DEMOTION (no-self-confirmation-v1).
 *
 * Red-team hardening of the continuous-learning loop against unsupervised
 * self-confirmation. Two independent mechanisms:
 *
 *  1. GOLD ADMISSION — a single choke point that decides which tier a
 *     candidate label may enter. Machine output (model predictions,
 *     heuristic outputs, auto-resolutions) can NEVER be admitted to the
 *     GOLD tier, under any flag combination. Pseudo-labels are a distinct,
 *     explicitly-declared source; they are never GOLD either, and they may
 *     enter the non-gold TRAINING_POOL tier only under a complete
 *     scientific-control record (human spot-check reference, pre-registered
 *     protocol, holdout-disjointness attestation). Human sources (expert
 *     annotators, provisioned coaches) must carry a verifiable human
 *     reference and must not be machine identities in disguise.
 *
 *  2. RELEASE-STATUS LEDGER — release status is never a mutable flag. It is
 *     a pure fold over an append-only evidence ledger: any negative
 *     evidence observed after the latest promotion demotes RELEASE_GREEN
 *     immediately, demotion needs no quorum, and re-promotion requires NEW
 *     positive evidence (a previously-consumed evidenceRef can never
 *     re-promote — one-shot, mirroring the g08 gate's one-shot rule).
 *
 * Consent note: consent for analysis is separate from consent for training
 * (consentRef.ts); admission here is orthogonal to and never substitutes
 * for that check — a label without model_training consent stays out of
 * every tier regardless of provenance.
 */

export const GOLD_ADMISSION_VERSION = "no-self-confirmation-v1";

/** Where a candidate label came from. Declared, never inferred. */
export const LABEL_SOURCES = [
  /** A human expert annotation (annotationSchema.ts SwingAnnotation). */
  "human_annotator",
  /** A provisioned coach's review (coachReview.ts CoachReview). */
  "coach_review",
  /** Output of any model / heuristic / classifier — Tier-C machine output. */
  "model_prediction",
  /** Machine output explicitly declared as a pseudo-label for training. */
  "pseudo_label",
] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const HUMAN_LABEL_SOURCES: readonly LabelSource[] = ["human_annotator", "coach_review"];

/** Dataset tiers a candidate can be admitted to. GOLD supervises evaluation
 * and release gates; TRAINING_POOL never does. */
export type DatasetTier = "GOLD" | "TRAINING_POOL";

/** Identity patterns that mark a claimed "human" as machine output in
 * disguise (label laundering). Mirrors coachReview.ts's synthetic-id rule. */
const MACHINE_IDENTITY_PATTERN =
  /synthetic|demo|model|classifier|heuristic|auto[-_]?resolve|pipeline|pseudo|bot\b/i;

/**
 * Scientific controls a pseudo-label batch MUST carry to enter the
 * TRAINING_POOL tier. All fields are references to pre-existing artifacts —
 * the admission check can not manufacture any of them.
 */
export interface PseudoLabelControls {
  /** Pre-registered protocol document (frozen before the batch existed). */
  protocolRef: string;
  /** Human spot-check record covering this batch (who, when, sample size). */
  humanSpotCheckRef: string;
  /** Fraction of the batch a human actually inspected, 0..1 (must be > 0). */
  humanSpotCheckFraction: number;
  /** Attestation that the batch is disjoint from every locked holdout. */
  holdoutDisjointnessRef: string;
  /** The model that produced the labels — recorded so downstream evaluation
   * can never score that same model family on its own pseudo-labels. */
  producingModelVersion: string;
}

export interface GoldCandidate {
  candidateId: string;
  source: LabelSource;
  /** Tier the submitter is requesting. */
  requestedTier: DatasetTier;
  /** Human identity behind the label (annotatorId / coachId); null for
   * machine sources. */
  humanId: string | null;
  /** Reference to the human review artifact (review file, annotation file);
   * null when none exists. */
  humanArtifactRef: string | null;
  /** Version of the model that produced the label, when machine-produced. */
  producingModelVersion: string | null;
  /** Present only when source === "pseudo_label". */
  pseudoLabelControls: PseudoLabelControls | null;
}

export interface AdmissionVerdict {
  candidateId: string;
  admitted: boolean;
  /** Tier actually granted; null when rejected. Never wider than requested. */
  admittedTier: DatasetTier | null;
  reasons: string[];
}

/**
 * The single admission decision. Pure — no I/O, no mutation — so every
 * property is testable exhaustively.
 */
export function evaluateGoldAdmission(candidate: GoldCandidate): AdmissionVerdict {
  const reasons: string[] = [];
  const reject = (): AdmissionVerdict => ({
    candidateId: candidate.candidateId,
    admitted: false,
    admittedTier: null,
    reasons,
  });

  if (!LABEL_SOURCES.includes(candidate.source)) {
    reasons.push(`unknown label source ${String(candidate.source)} — undeclared provenance`);
    return reject();
  }

  if (candidate.source === "model_prediction") {
    reasons.push(
      "model predictions are Tier-C machine output and are never admissible to any label tier; " +
        "route through a human review (coach_review / human_annotator) or an explicit pseudo_label batch",
    );
    return reject();
  }

  if (candidate.source === "pseudo_label") {
    if (candidate.requestedTier === "GOLD") {
      reasons.push("pseudo-labels are never GOLD — machine output must never become gold labels");
    }
    const controls = candidate.pseudoLabelControls;
    if (!controls) {
      reasons.push("pseudo_label without a scientific-control record is inadmissible");
    } else {
      if (!controls.protocolRef.trim()) reasons.push("pseudoLabelControls.protocolRef required");
      if (!controls.humanSpotCheckRef.trim()) {
        reasons.push("pseudoLabelControls.humanSpotCheckRef required");
      }
      if (
        !Number.isFinite(controls.humanSpotCheckFraction) ||
        controls.humanSpotCheckFraction <= 0 ||
        controls.humanSpotCheckFraction > 1
      ) {
        reasons.push("pseudoLabelControls.humanSpotCheckFraction must be in (0, 1]");
      }
      if (!controls.holdoutDisjointnessRef.trim()) {
        reasons.push("pseudoLabelControls.holdoutDisjointnessRef required");
      }
      if (!controls.producingModelVersion.trim()) {
        reasons.push("pseudoLabelControls.producingModelVersion required");
      }
    }
    if (reasons.length > 0) return reject();
    return {
      candidateId: candidate.candidateId,
      admitted: true,
      admittedTier: "TRAINING_POOL",
      reasons: [],
    };
  }

  // Human sources: human_annotator / coach_review.
  if (!candidate.humanId || !candidate.humanId.trim()) {
    reasons.push(`${candidate.source} requires a humanId (annotatorId / coachId)`);
  } else if (MACHINE_IDENTITY_PATTERN.test(candidate.humanId)) {
    reasons.push(
      `humanId "${candidate.humanId}" matches a machine/synthetic identity pattern — ` +
        "machine output may not be laundered through a human source",
    );
  }
  if (!candidate.humanArtifactRef || !candidate.humanArtifactRef.trim()) {
    reasons.push(`${candidate.source} requires a humanArtifactRef (review/annotation file)`);
  }
  if (candidate.producingModelVersion !== null) {
    reasons.push(
      `${candidate.source} declares producingModelVersion=${candidate.producingModelVersion} — ` +
        "a machine-produced label may not claim a human source",
    );
  }
  if (reasons.length > 0) return reject();
  return {
    candidateId: candidate.candidateId,
    admitted: true,
    admittedTier: candidate.requestedTier,
    reasons: [],
  };
}

/* ------------------------------------------------------------------------ *
 * RELEASE-STATUS LEDGER — GREEN is demotable, always.
 * ------------------------------------------------------------------------ */

export type ReleaseStatus = "RELEASE_GREEN" | "RELEASE_BLOCKED" | "NOT_EVALUABLE";

export type ReleaseEvidenceKind = "positive" | "negative";

export interface ReleaseEvidenceEvent {
  /** Unique reference to the evidence artifact (gate report, red-team
   * finding, regression record). The same ref can never promote twice. */
  evidenceRef: string;
  kind: ReleaseEvidenceKind;
  /** Strictly increasing per-ledger sequence number (append order). */
  seq: number;
  detail: string;
}

export interface ReleaseStatusDerivation {
  status: ReleaseStatus;
  /** The promotion currently in force, or null. */
  activePromotion: ReleaseEvidenceEvent | null;
  /** Negative evidence at-or-after the latest promotion (what demoted it). */
  demotingEvidence: ReleaseEvidenceEvent[];
  /** Positive events ignored because their evidenceRef was already consumed
   * by an earlier promotion attempt (one-shot rule). */
  replayedPositiveRefs: string[];
}

/**
 * Derive release status as a pure fold over an append-only ledger.
 *
 * Rules (each covered by a dedicated test):
 *  - empty ledger → NOT_EVALUABLE: status without evidence does not exist;
 *  - a positive event promotes only if its evidenceRef has never been used
 *    by any earlier positive event (one-shot);
 *  - ANY negative event with seq >= the active promotion's seq demotes to
 *    RELEASE_BLOCKED — a single negative is sufficient, no quorum;
 *  - re-promotion after demotion requires a NEW positive event with seq
 *    strictly greater than every prior negative event's seq;
 *  - the fold never mutates its input and status is a function of the
 *    ledger alone, so no code path can hold GREEN by editing state.
 */
export function deriveReleaseStatus(
  ledger: readonly ReleaseEvidenceEvent[],
): ReleaseStatusDerivation {
  const sorted = [...ledger].sort((a, b) => a.seq - b.seq);
  for (const [index, event] of sorted.entries()) {
    if (index > 0 && event.seq <= sorted[index - 1]!.seq) {
      throw new Error(
        `release ledger seq must be strictly increasing (seq ${event.seq} after ${sorted[index - 1]!.seq})`,
      );
    }
  }

  const consumedRefs = new Set<string>();
  const replayedPositiveRefs: string[] = [];
  let activePromotion: ReleaseEvidenceEvent | null = null;
  let demotingEvidence: ReleaseEvidenceEvent[] = [];

  for (const event of sorted) {
    if (event.kind === "positive") {
      if (consumedRefs.has(event.evidenceRef)) {
        replayedPositiveRefs.push(event.evidenceRef);
        continue;
      }
      consumedRefs.add(event.evidenceRef);
      activePromotion = event;
      demotingEvidence = [];
    } else if (activePromotion !== null) {
      demotingEvidence.push(event);
    }
  }

  let status: ReleaseStatus;
  if (sorted.length === 0) status = "NOT_EVALUABLE";
  else if (activePromotion !== null && demotingEvidence.length === 0) status = "RELEASE_GREEN";
  else status = "RELEASE_BLOCKED";

  return { status, activePromotion, demotingEvidence, replayedPositiveRefs };
}
