/**
 * Estimated DUPR — the headline number on every rating surface.
 *
 * Product decision (owner, 2026-09-10; docs/DECISIONS.md D-046): the big
 * number the player reads is an estimated DUPR (Dynamic Universal Pickleball
 * Rating — the 2.000–8.000 scale most players already know), and the 0–10
 * Technique Score it derives from stays visible as the smaller secondary
 * figure ("6.4 /10").
 *
 * THE ENDS OF THE MAP (owner decision, 2026-09-11): the estimate spans
 * DUPR's FULL published scale — 0/10 is the 2.00 floor and a perfect 10/10
 * is 8.00, the top of the scale. Nothing prints above 8.00 (an earlier
 * 6.00 ceiling was withdrawn: a 10 out of 10 must read as the top of the
 * scale it is printed on).
 *
 * THE SHAPE OF THE MAP (owner correction, 2026-09-10, kept): a straight
 * line from 0–10 onto 2–8 is wrong, because DUPR is not spread evenly
 * across its scale — most rated players sit in the 3s and the top of the
 * scale is sparse. A linear map put a failing 5.8/10 swing at 5.48. So the
 * anchors below tie the scoring engine's OWN band boundaries
 * (scoring/src/engine.ts `bandFor`: a checkpoint is red below 65, yellow
 * 65–79, green from 80; the overall score is the weighted mean of
 * checkpoints ÷ 10, and a metric only scores 100 inside its target window)
 * to evenly spaced steps of the 2–8 scale (1.5 DUPR per step), and
 * interpolate linearly between anchors:
 *
 *   score  0.0 → 2.00   nothing measured near any target → the DUPR floor
 *   score  6.5 → 3.50   checkpoints average the red/yellow line (65):
 *                       fundamentals still broken
 *   score  8.0 → 5.00   checkpoints average the green line (80): the
 *                       fundamentals hold
 *   score  9.5 → 6.50   nearly every metric inside its window
 *   score 10.0 → 8.00   every metric inside its window on this swing —
 *                       the top of the DUPR scale; the estimate never goes higher
 *
 * The curve is therefore gentle through the failing range (5.8 → 3.34),
 * one DUPR point per score point through the middle (7.0 → 4.00,
 * 7.8 → 4.80, 9.0 → 6.00) and steep only at the very top (9.5 → 6.50,
 * 10 → 8.00), where the last few tenths of technique are worth the most.
 *
 * Honesty rules, because a real DUPR is computed from match results and no
 * validated form→match mapping exists:
 *   - the figure is always labelled an estimate and never presented as the
 *     player's official DUPR (DUPR_ESTIMATE_LABEL / DUPR_ESTIMATE_NOTE);
 *   - two decimals at most — DUPR's own third decimal would be invented
 *     precision;
 *   - differences are ALWAYS the difference of two converted endpoints
 *     (`duprDelta`), never a rescaled score difference, because the map is
 *     not linear;
 *   - storage, sync, the scoring model and the rank tiers stay on the 0–10
 *     scale. This module converts at the display boundary only, so every
 *     surface agrees and nothing about the data changes.
 */

const MINUS = '\u2212';

export const TECHNIQUE_SCORE_MAX = 10;
/** DUPR's published scale ends. */
export const DUPR_SCALE_MIN = 2;
export const DUPR_SCALE_MAX = 8;
/** The lowest and highest estimate this app will ever print — DUPR's own
 * scale ends: a perfect 10/10 is an 8.00. */
export const DUPR_MIN = DUPR_SCALE_MIN;
export const DUPR_CEILING = DUPR_SCALE_MAX;

/** [technique score, estimated DUPR] anchors, ascending; linear between. */
export const DUPR_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, DUPR_MIN],
  [6.5, 3.5],
  [8, 5],
  [9.5, 6.5],
  [TECHNIQUE_SCORE_MAX, DUPR_CEILING],
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 0–10 Technique Score (or rank rating) → estimated DUPR, two decimals, by
 * piecewise-linear interpolation through DUPR_ANCHORS. Out-of-range input
 * clamps to the scale ends; a non-finite input stays non-finite rather than
 * becoming a number that was never measured.
 */
export function duprFromScore(score: number): number {
  if (!Number.isFinite(score)) return NaN;
  const clamped = Math.max(0, Math.min(TECHNIQUE_SCORE_MAX, score));
  for (let index = 1; index < DUPR_ANCHORS.length; index += 1) {
    const [fromScore, fromDupr] = DUPR_ANCHORS[index - 1]!;
    const [toScore, toDupr] = DUPR_ANCHORS[index]!;
    if (clamped <= toScore) {
      const fraction = (clamped - fromScore) / (toScore - fromScore);
      return round2(fromDupr + fraction * (toDupr - fromDupr));
    }
  }
  return DUPR_CEILING;
}

/** Where a score sits between the app's lowest and highest estimate, 0..1 —
 * the fill of a ring or bar whose printed value is the estimated DUPR. */
export function duprFraction(score: number): number {
  const dupr = duprFromScore(score);
  if (!Number.isFinite(dupr)) return 0;
  return Math.max(
    0,
    Math.min(1, (dupr - DUPR_MIN) / (DUPR_CEILING - DUPR_MIN)),
  );
}

/** The display string of the estimate: 6.4 → "3.48". */
export function formatDupr(score: number): string {
  return duprFromScore(score).toFixed(2);
}

/**
 * The change in estimated DUPR between two scores — the difference of the
 * two converted (displayed) figures, so it always matches what the player
 * sees on either end. Never a rescaled score difference: the map is not
 * linear.
 */
export function duprDelta(fromScore: number, toScore: number): number {
  return round2(duprFromScore(toScore) - duprFromScore(fromScore));
}

/** Signed DUPR change with a real minus sign: "+0.53", "−0.20", "+0.00". */
export function formatDuprDelta(fromScore: number, toScore: number): string {
  const delta = duprDelta(fromScore, toScore);
  const magnitude = Math.abs(delta).toFixed(2);
  return delta < 0 && Number(magnitude) !== 0
    ? `${MINUS}${magnitude}`
    : `+${magnitude}`;
}

/** An unsigned DUPR distance between two scores, e.g. "0.15" to the next tier. */
export function formatDuprDistance(fromScore: number, toScore: number): string {
  return Math.abs(duprDelta(fromScore, toScore)).toFixed(2);
}

/**
 * The smaller secondary reading of the underlying scale: "6.4 /10" for an
 * analysis (tenths), "7.62 /10" for the rank rating (hundredths).
 */
export function formatTechniqueScore(
  score: number,
  decimals: 1 | 2 = 1,
): string {
  return `${score.toFixed(decimals)} /${TECHNIQUE_SCORE_MAX}`;
}

/** What VoiceOver reads wherever a rating is shown. */
export function duprAccessibilityLabel(
  score: number,
  decimals: 1 | 2 = 1,
): string {
  return `Estimated DUPR ${formatDupr(score)}, technique score ${score.toFixed(
    decimals,
  )} out of ${TECHNIQUE_SCORE_MAX}`;
}

/** The unit that follows the big number. */
export const DUPR_LABEL = 'DUPR';
/** The eyebrow / caption label over a DUPR figure. */
export const DUPR_ESTIMATE_LABEL = 'EST. DUPR';
/** The small qualifier under the ring's `DUPR` unit (owner, 2026-09-11). */
export const DUPR_ESTIMATED_EYEBROW = 'ESTIMATED';
/** The disclaimer surfaces with room for a footnote carry. */
export const DUPR_ESTIMATE_NOTE =
  'Estimated DUPR — derived from your technique score, not from match results. Not an official DUPR rating.';
