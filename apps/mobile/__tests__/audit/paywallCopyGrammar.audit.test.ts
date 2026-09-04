/**
 * Structural audit probes (mobile-billing-paywall, pass 1) for paywallCopy:
 * singular/plural agreement across every reachable ledger cell and the
 * fail-closed (null access) sentence.
 */
import {
  freeRatingAllowanceCopy,
  RATING_CONSUMPTION_RULE,
} from '../../src/screens/paywallCopy';
import type { CanonicalAccessState } from '../../src/billing/types';

function access(used: number, reserved: number): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve === 0,
  };
}

const FORBIDDEN =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best|#1|most accurate/i;

describe('audit: free-rating allowance copy', () => {
  it('null access states the fail-closed sentence without counts', () => {
    expect(freeRatingAllowanceCopy(null)).toBe(
      'Two successful validated ratings are included once your account is verified.',
    );
  });

  it('every reachable ledger cell yields grammatical singular/plural copy', () => {
    const expected: Record<string, string> = {
      '0/0': '2 of your 2 lifetime free ratings remain.',
      '1/0': '1 of your 2 lifetime free ratings remain.',
      '2/0': 'Both lifetime free ratings have been successfully scored.',
      '0/1': '2 free ratings remain, but 1 capture is still being finalized.',
      '0/2': '2 free ratings remain, but 2 captures are still being finalized.',
      '1/1': '1 free rating remains, but 1 capture is still being finalized.',
    };
    const actual: Record<string, string> = {};
    for (const key of Object.keys(expected)) {
      const [used, reserved] = key.split('/').map(Number) as [number, number];
      actual[key] = freeRatingAllowanceCopy(access(used, reserved));
    }
    expect(actual).toEqual(expected);
  });

  it('copy never contains store-policy-forbidden terms', () => {
    const samples = [
      RATING_CONSUMPTION_RULE,
      freeRatingAllowanceCopy(null),
      freeRatingAllowanceCopy(access(0, 0)),
      freeRatingAllowanceCopy(access(1, 1)),
      freeRatingAllowanceCopy(access(2, 0)),
    ];
    for (const sample of samples) {
      expect(sample).not.toMatch(FORBIDDEN);
    }
  });
});
