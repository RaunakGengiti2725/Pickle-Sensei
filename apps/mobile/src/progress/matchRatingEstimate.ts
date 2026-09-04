/**
 * Match-rating estimate — a familiarity aid, not a rating claim.
 *
 * Product decision (2026-09-01): every "/ 10" rating also shows a smaller
 * parenthetical match-rating figure, because match-rating scales are what
 * many players already know. The mapping is a plain linear rescale of the
 * 0–10 Technique Score onto a 1–7 span:
 *
 *   estimate = 1 + (score / 10) * 6      (0 → 1.0, 5 → 4.0, 10 → 7.0)
 *
 * It is NOT a verified match rating: match ratings measure match outcomes,
 * this measures stroke form, and no validated mapping between the two
 * exists. The label is deliberately generic — no third-party rating
 * trademark appears anywhere in user-facing copy (docs/APP_STORE_SUBMISSION.md
 * §1.4 / §2). Two rules keep the display honest:
 *   1. one decimal only — two would imply precision the mapping lacks;
 *   2. every surface pairs the figure with the ≈ sign, and surfaces with
 *      room also show MATCH_RATING_ESTIMATE_NOTE.
 */

export function matchRatingEstimate(score: number): number {
  const clamped = Math.max(0, Math.min(10, score));
  return Math.round((1 + clamped * 0.6) * 10) / 10;
}

/** Inline parenthetical, e.g. "(≈ match rating 5.6)". */
export function formatMatchRatingEstimate(score: number): string {
  return `(≈ match rating ${matchRatingEstimate(score).toFixed(1)})`;
}

/** The accompanying notice for surfaces with room for a footnote. */
export const MATCH_RATING_ESTIMATE_NOTE =
  'Match-rating figure is a rough estimate — technique doesn’t directly transfer to match results.';
