import type { ShotAnalysis } from '@pickle/shared-types';
import {
  SHOT_FAMILY,
  recommendDrills,
  type LibraryFocus,
} from '../library/libraryFocus';
import { fixList } from './formReviewModel';

/**
 * RECOMMENDED DRILLS model — pure selectors that turn ONE scored analysis
 * into a drill-library focus and pick catalog drills for it.
 *
 * HONESTY CONTRACT: the focus is the analysis' own worst measured fault
 * (fixList — the engine's priorityFix first, else the lowest score below
 * green); with no scored fault there is no focus and nothing is recommended.
 * Drills are matched by stroke FAMILY only — the catalog carries no
 * coach-validated checkpoint mapping today, and the copy says so.
 *
 * Pure (no React, no IO) so jest pins it directly.
 */

export const DRILL_MATCH_NOTE =
  'Matched by stroke family from the drill catalog — not yet coach-validated ' +
  'for this exact checkpoint.';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Focus from one analysis: the top fixList item, else the engine's own
 * `priorityFix` checkpoint when it carries an applicable, finite score.
 * `sampleCount` is honestly 1 — this is one read, not a form window.
 */
export function drillFocusFromAnalysis(
  analysis: ShotAnalysis,
): LibraryFocus | null {
  const top = fixList(analysis, 1)[0] ?? null;
  let checkpoint: string | null = top?.key ?? null;
  let score: number | null = top?.score ?? null;
  if (checkpoint === null) {
    const priority = analysis.priorityFix?.checkpoint ?? null;
    const raw = Array.isArray(analysis.checkpoints) ? analysis.checkpoints : [];
    const named = priority
      ? raw.find(
          cp =>
            cp &&
            cp.key === priority &&
            cp.applicable !== false &&
            finite(cp.score),
        )
      : undefined;
    if (named && finite(named.score)) {
      checkpoint = named.key;
      score = named.score;
    }
  }
  if (checkpoint === null || score === null) return null;
  return {
    shotType: analysis.shotType,
    checkpoint,
    averageScore: Math.round(score),
    sampleCount: 1,
    family: SHOT_FAMILY[analysis.shotType] ?? 'global',
  };
}

/** Family drills first (catalog order), whole-game drills as fill — exactly
 * the library's own recommendation rule, so both surfaces agree. */
export function pickRecommendedDrills<
  T extends { slug: string; families: readonly string[] },
>(drills: readonly T[], focus: LibraryFocus, limit = 3): T[] {
  return recommendDrills(drills, focus, limit);
}
