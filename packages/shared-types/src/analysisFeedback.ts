/**
 * Lightweight user feedback on a delivered analysis (Wave I,
 * i08-user-feedback).
 *
 * "Was this analysis accurate?" is a FAILURE-MINING signal, never gold:
 * a user's tap can be wrong, biased, or adversarial, so feedback only ever
 * nominates hard cases for qualified review — it never becomes a label and
 * never overrides a score. Review eligibility is a separate, stricter
 * question than storage: feedback is stored for any analysis the user owns,
 * but only footage covered by an ACTIVE model_training consent grant (the
 * real consent ledger, not a cached flag) may enter the human-review queue.
 */

import { isModelTrainingConsentActive, type ConsentRecord } from "./consent.js";

export const ANALYSIS_FEEDBACK_RATINGS = ["accurate", "not_quite"] as const;
export type AnalysisFeedbackRating = (typeof ANALYSIS_FEEDBACK_RATINGS)[number];

export const ANALYSIS_FEEDBACK_CATEGORIES = [
  "wrong_stroke",
  "wrong_player",
  "contact_looks_wrong",
  "feedback_mismatch",
  "other",
] as const;
export type AnalysisFeedbackCategory = (typeof ANALYSIS_FEEDBACK_CATEGORIES)[number];

/**
 * Provenance marker persisted with every feedback row. There is exactly one
 * value: user feedback is user feedback. No code path may re-tag it as a
 * label source.
 */
export const ANALYSIS_FEEDBACK_SIGNAL_KIND = "user_feedback_failure_mining" as const;

export interface AnalysisFeedbackRecord {
  id: string;
  /** Client analysis id — the shot the user was looking at. */
  analysisId: string;
  rating: AnalysisFeedbackRating;
  /** Required when rating is `not_quite`; null when `accurate`. */
  category: AnalysisFeedbackCategory | null;
  signalKind: typeof ANALYSIS_FEEDBACK_SIGNAL_KIND;
  /** Version vector the analysis was produced under, copied server-side
   * from the shot row — never trusted from the feedback request. */
  versionVector: Record<string, string>;
  /**
   * Whether the underlying footage may enter the human-review queue.
   * Derived from the consent ledger at submission time; consent for
   * analysis is separate from consent for model improvement.
   */
  reviewEligible: boolean;
  createdAtIso: string;
}

/**
 * The single review-eligibility rule: feedback may feed the hard-case
 * review queue only when the subject's ledger shows an ACTIVE
 * model_training grant. Absence of records, video_analysis-only consent,
 * evaluation_telemetry consent, or a withdrawn model_training grant all
 * mean NOT eligible.
 */
export function isFeedbackReviewEligible(records: readonly ConsentRecord[]): boolean {
  return isModelTrainingConsentActive(records);
}

/** A hard-case queue candidate: negative, review-eligible feedback. */
export function feedsHardCaseQueue(
  record: Pick<AnalysisFeedbackRecord, "rating" | "reviewEligible">,
): boolean {
  return record.rating === "not_quite" && record.reviewEligible;
}
