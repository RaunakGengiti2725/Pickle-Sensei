import {
  freeRatingAllowanceCopy,
  RATING_CONSUMPTION_RULE,
} from '../src/screens/paywallCopy';
import type { CanonicalAccessState } from '../src/billing/types';

function access(
  used: number,
  reserved: number,
  remaining: number,
  availableToReserve: number,
): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
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
  it('states the successful-score rule without counting attempts', () => {
    expect(RATING_CONSUMPTION_RULE).toContain('successful validated score');
    expect(RATING_CONSUMPTION_RULE).toContain('unscored');
  });

  it('reports the canonical remaining allowance', () => {
    expect(freeRatingAllowanceCopy(access(1, 0, 1, 1))).toBe(
      '1 of your 2 lifetime free ratings remain.',
    );
  });

  it('does not describe reserved captures as consumed ratings', () => {
    expect(freeRatingAllowanceCopy(access(0, 2, 2, 0))).toBe(
      '2 free ratings remain, but 2 captures are still being finalized.',
    );
  });

  it('shows the hard boundary only after both successful scores', () => {
    expect(freeRatingAllowanceCopy(access(2, 0, 0, 0))).toBe(
      'Both lifetime free ratings have been successfully scored.',
    );
  });
});
