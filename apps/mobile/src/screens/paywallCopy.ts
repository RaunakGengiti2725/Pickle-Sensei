import {
  allowanceWord,
  FREE_RATING_LIMIT,
  freeRatingNoun,
} from '../billing/freeRatings';
import type { MembershipState } from '../billing/membershipState';
import type { CanonicalAccessState } from '../billing/types';

export { FREE_PLAY_EYEBROW } from '../billing/freeRatings';

export interface MembershipHeroCopy {
  eyebrow: string;
  title: string;
  detail: string;
}

export const MEMBERSHIP_VERIFICATION_HERO: MembershipHeroCopy = {
  eyebrow: 'MEMBERSHIP VERIFICATION',
  title: 'Verify your membership.',
  detail:
    'Verification is pending, not another purchase. Retry with our server without opening the app store.',
};

/**
 * Hero copy for the non-member paywall pages. Returns null when the ordinary
 * sales copy applies (free / unverified); otherwise names the server-derived
 * pending, HOLD or expired state — never a price.
 */
export function membershipHeroCopy(
  membership: MembershipState,
  recoveryRequired: boolean,
): MembershipHeroCopy | null {
  if (
    membership.kind === 'pending' ||
    membership.kind === 'hold' ||
    membership.kind === 'expired'
  ) {
    return {
      eyebrow: membership.eyebrow,
      title: membership.title,
      detail: membership.detail,
    };
  }
  return recoveryRequired ? MEMBERSHIP_VERIFICATION_HERO : null;
}

export const RATING_CONSUMPTION_RULE =
  'A completed rating uses one free rating. Unscored attempts are not charged. Pending work may keep a rating reserved until it is reconciled.';

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The allowance line on the paywall. Before a server answer exists it states
 * the product's allowance (FREE_RATING_LIMIT); with one, every number comes
 * from the server's own `freeRatings` so the copy follows whatever allowance
 * the account was actually given.
 */
export function freeRatingAllowanceCopy(
  access: CanonicalAccessState | null,
): string {
  if (!access) {
    return FREE_RATING_LIMIT === 1
      ? 'One lifetime free rating is included once your account is verified.'
      : `${capitalize(allowanceWord(FREE_RATING_LIMIT))} lifetime free ratings are included once your account is verified.`;
  }

  const { freeRatings } = access;
  const { limit, remaining, reserved } = freeRatings;
  if (freeRatings.used >= limit) {
    if (limit === 1) {
      return 'Your lifetime free rating has been successfully scored.';
    }
    return `${limit === 2 ? 'Both' : `All ${limit}`} lifetime free ratings have been successfully scored.`;
  }

  const remainingLabel = `${remaining} ${freeRatingNoun(remaining)} ${
    remaining === 1 ? 'remains' : 'remain'
  }`;

  if (reserved > 0) {
    return `${remainingLabel}, but ${reserved} capture${
      reserved === 1 ? ' is' : 's are'
    } still being finalized.`;
  }

  if (limit === 1) {
    return 'Your lifetime free rating is still available.';
  }
  return `${remaining} of your ${limit} lifetime free ratings remain.`;
}
