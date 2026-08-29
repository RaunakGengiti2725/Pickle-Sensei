import type { CanonicalAccessState } from '../billing/types';

export const RATING_CONSUMPTION_RULE =
  'Only a successful validated score uses a free rating. Every unscored outcome returns the allowance.';

export function freeRatingAllowanceCopy(
  access: CanonicalAccessState | null,
): string {
  if (!access) {
    return 'Two successful validated ratings are included once your account is verified.';
  }

  const { freeRatings } = access;
  if (freeRatings.used >= freeRatings.limit) {
    return 'Both lifetime free ratings have been successfully scored.';
  }

  const remainingLabel = `${freeRatings.remaining} free rating${
    freeRatings.remaining === 1 ? '' : 's'
  } remain`;

  if (freeRatings.reserved > 0) {
    return `${remainingLabel}, but ${freeRatings.reserved} capture${
      freeRatings.reserved === 1 ? ' is' : 's are'
    } still being finalized.`;
  }

  return `${freeRatings.remaining} of your 2 lifetime free ratings remain.`;
}
