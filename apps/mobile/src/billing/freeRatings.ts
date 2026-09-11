/**
 * The lifetime free-rating allowance per sign-in identity, as the PRODUCT
 * states it before any server answer exists (welcome, onboarding, the
 * walkthrough, the paywall's pre-verification line). ONE since 2026-09-10 —
 * two before. Mirrors the database's public.free_rating_limit() (migration
 * 20260910170000) and the Edge Function's FREE_RATING_LIMIT.
 *
 * Everything that has a server access snapshot reads
 * `access.freeRatings.limit` instead: the server is authoritative, and the
 * app renders whatever allowance it was actually given (parseAccess accepts
 * any positive limit and checks the counters against it), so a build and a
 * deployment that disagree for a moment degrade to honest copy, never to a
 * refused response.
 */
export const FREE_RATING_LIMIT: number = 1;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'] as const;

/** "one" / "two" / … for small allowances, the numeral otherwise. */
export function allowanceWord(limit: number): string {
  return WORDS[limit] ?? String(limit);
}

/** "free rating" / "free ratings" for the given count. */
export function freeRatingNoun(count: number): string {
  return count === 1 ? 'free rating' : 'free ratings';
}

/** The paywall's value-page eyebrow for a verified non-member, phrased for
 * the allowance the product states (never a count the server may differ on). */
export const FREE_PLAY_EYEBROW: string =
  FREE_RATING_LIMIT === 1
    ? 'PLAY PAST YOUR FREE RATING'
    : `PLAY PAST THE FIRST ${allowanceWord(FREE_RATING_LIMIT).toUpperCase()}`;
