/**
 * DUPR-style estimate — a familiarity aid, not a rating claim.
 *
 * Product decision (2026-09-01): every "/ 10" rating also shows a smaller
 * parenthetical DUPR-style figure, because DUPR numbers are what many
 * players already know. The mapping is a plain linear rescale of the 0–10
 * Technique Score onto a 1–7 span:
 *
 *   estimate = 1 + (score / 10) * 6      (0 → 1.0, 5 → 4.0, 10 → 7.0)
 *
 * It is NOT a verified DUPR: DUPR measures match outcomes, this measures
 * stroke form, and no validated mapping between the two exists. Two rules
 * keep the display honest:
 *   1. one decimal only — two would imply precision the mapping lacks;
 *   2. every surface pairs the figure with the ≈ sign, and surfaces with
 *      room also show DUPR_ESTIMATE_NOTE.
 */

export function duprEstimate(score: number): number {
  const clamped = Math.max(0, Math.min(10, score));
  return Math.round((1 + clamped * 0.6) * 10) / 10;
}

/** Inline parenthetical, e.g. "(≈ DUPR 5.6)". */
export function formatDuprEstimate(score: number): string {
  return `(≈ DUPR ${duprEstimate(score).toFixed(1)})`;
}

/** The accompanying notice for surfaces with room for a footnote. */
export const DUPR_ESTIMATE_NOTE =
  'DUPR figure is a rough estimate — technique doesn’t directly transfer to match rating.';
