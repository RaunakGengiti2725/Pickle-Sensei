import {
  freeRatingAllowanceCopy,
  RATING_CONSUMPTION_RULE,
} from '../src/screens/paywallCopy';
import { FREE_RATING_LIMIT } from '../src/billing/freeRatings';
import type { CanonicalAccessState } from '../src/billing/types';

function access(
  used: number,
  reserved: number,
  remaining: number,
  availableToReserve: number,
  limit = FREE_RATING_LIMIT,
): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit,
      used,
      reserved,
      remaining,
      availableToReserve,
    },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve === 0,
  };
}

describe('paywall free-rating copy', () => {
  it('the product allowance is one lifetime free rating', () => {
    expect(FREE_RATING_LIMIT).toBe(1);
  });

  it('states the successful-score rule without counting attempts', () => {
    expect(RATING_CONSUMPTION_RULE).toContain('completed rating');
    expect(RATING_CONSUMPTION_RULE).toMatch(
      /unscored attempts are not charged/i,
    );
    expect(RATING_CONSUMPTION_RULE).toContain('reserved');
    expect(RATING_CONSUMPTION_RULE).not.toContain('returns the allowance');
  });

  it('before verification states the product allowance, in words', () => {
    expect(freeRatingAllowanceCopy(null)).toBe(
      'One lifetime free rating is included once your account is verified.',
    );
  });

  it('reports the canonical remaining allowance', () => {
    expect(freeRatingAllowanceCopy(access(0, 0, 1, 1))).toBe(
      'Your lifetime free rating is still available.',
    );
    // The copy follows the SERVER's allowance, whatever it declares.
    expect(freeRatingAllowanceCopy(access(1, 0, 1, 1, 2))).toBe(
      '1 of your 2 lifetime free ratings remain.',
    );
  });

  it('does not describe reserved captures as consumed ratings', () => {
    expect(freeRatingAllowanceCopy(access(0, 1, 1, 0))).toBe(
      '1 free rating remains, but 1 capture is still being finalized.',
    );
    expect(freeRatingAllowanceCopy(access(0, 2, 2, 0, 2))).toBe(
      '2 free ratings remain, but 2 captures are still being finalized.',
    );
  });

  it('shows the hard boundary only after the successful score', () => {
    expect(freeRatingAllowanceCopy(access(1, 0, 0, 0))).toBe(
      'Your lifetime free rating has been successfully scored.',
    );
    expect(freeRatingAllowanceCopy(access(2, 0, 0, 0, 2))).toBe(
      'Both lifetime free ratings have been successfully scored.',
    );
    expect(freeRatingAllowanceCopy(access(3, 0, 0, 0, 3))).toBe(
      'All 3 lifetime free ratings have been successfully scored.',
    );
  });
});
