import type { MembershipState } from '../billing/membershipState';
import type { CanonicalAccessState } from '../billing/types';

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

export function freeRatingAllowanceCopy(
  access: CanonicalAccessState | null,
): string {
  if (!access) {
    return 'Two lifetime free ratings are included once your account is verified.';
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
