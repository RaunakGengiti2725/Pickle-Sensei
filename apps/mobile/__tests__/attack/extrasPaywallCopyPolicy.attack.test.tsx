/**
 * ADVERSARIAL EXTRAS — paywallCopy over every reachable canonical state, and
 * the APP_STORE_SUBMISSION.md copy policy over every rendered paywall string.
 *
 *   E1  freeRatingAllowanceCopy for all 6 valid (used, reserved) states the
 *       parser can admit (0 ≤ used ≤ 2, 0 ≤ reserved ≤ remaining) — grammar
 *       and numerals must agree with the numbers.
 *   E2  Policy: no Android / Google Play / guest mode / Live Court / DUPR /
 *       competitor names, no accuracy percentages, no superlatives or
 *       AI-coach-equivalence claims in any rendered paywall text (value page,
 *       pricing page, error states, verified state).
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import {
  RATING_CONSUMPTION_RULE,
  freeRatingAllowanceCopy,
} from '../../src/screens/paywallCopy';

function access(
  used: 0 | 1 | 2,
  reserved: number,
  premium = false,
): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: premium || availableToReserve > 0,
    paywallRequired: !(premium || availableToReserve > 0),
  };
}

/** Every (used, reserved) pair parseAccess admits. */
const VALID_STATES: Array<[0 | 1 | 2, number]> = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [2, 0],
];

const FORBIDDEN = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  // accuracy percentages (a store-derived "SAVE 37%" savings badge is allowed)
  /\d+(\.\d+)?\s?%[^.\n]{0,40}\b(accura|precis|correct)/i,
  /\b(accura|precis|correct)[^.\n]{0,40}\d+(\.\d+)?\s?%/i,
  // superlatives ("BEST VALUE" plan badge is sanctioned: docs/APP_STORE_SUBMISSION.md:547)
  /\b(the best|most accurate|#1|number one|world[- ]class|perfect|guaranteed)\b/i,
  /\b(as good as|replaces?|equivalent to|like having)\b[^.]*\bcoach/i,
];

describe('E1 freeRatingAllowanceCopy over all admissible states', () => {
  it.each(VALID_STATES)(
    'used=%i reserved=%i → numerals agree and sentence is well-formed',
    (used, reserved) => {
      const copy = freeRatingAllowanceCopy(access(used, reserved));
      expect(copy.length).toBeGreaterThan(20);
      expect(copy.endsWith('.')).toBe(true);
      if (used >= 2) {
        expect(copy).toBe(
          'Both lifetime free ratings have been successfully scored.',
        );
        return;
      }
      const remaining = 2 - used;
      expect(copy).toContain(String(remaining));
      if (remaining === 1) expect(copy).not.toMatch(/1 free ratings\b/);
      if (remaining === 2) expect(copy).not.toMatch(/2 free rating\b/);
      if (reserved > 0) {
        expect(copy).toContain(String(reserved));
        expect(copy).toMatch(
          reserved === 1 ? /1 capture is/ : /\d captures are/,
        );
      }
    },
  );

  it('BROKEN (P3 copy): remaining=1 with a reserved capture reads "1 free rating remain" (verb should be "remains")', () => {
    const copy = freeRatingAllowanceCopy(access(1, 1));
    expect(copy).toBe(
      '1 free rating remain, but 1 capture is still being finalized.',
    );
    expect(copy).toMatch(/\b1 free rating remain,/); // pinned observed grammar slip
  });

  it('HELD: null access uses the pre-verification sentence; consumption rule counts successes only', () => {
    expect(freeRatingAllowanceCopy(null)).toBe(
      'Two successful validated ratings are included once your account is verified.',
    );
    expect(RATING_CONSUMPTION_RULE).toMatch(/successful validated score/);
    expect(RATING_CONSUMPTION_RULE).not.toMatch(/attempt/i);
  });

  it('policy: allowance copy never contains forbidden terms', () => {
    const all = [
      freeRatingAllowanceCopy(null),
      RATING_CONSUMPTION_RULE,
      ...VALID_STATES.map(([u, r]) => freeRatingAllowanceCopy(access(u, r))),
    ].join('\n');
    for (const pattern of FORBIDDEN) expect(all).not.toMatch(pattern);
  });
});

// ---------- E2 rendered paywall ----------

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function deps(options: {
  access?: CanonicalAccessState;
  getAccess?: () => Promise<CanonicalAccessState>;
  loadPlans?: () => Promise<StorePlans>;
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(options.loadPlans ?? (async () => plans)),
      purchase: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(
        options.getAccess ?? (async () => options.access ?? access(1, 0)),
      ),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised');
      }),
    },
  };
}

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const texts = renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string');
  const labels = renderer.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => String(n.props.accessibilityLabel));
  const hints = renderer.root
    .findAll(n => typeof n.props.accessibilityHint === 'string')
    .map(n => String(n.props.accessibilityHint));
  return [...texts, ...labels, ...hints].join('\n');
}

async function render(dependencies: BillingAccessDependencies) {
  configureAccessStore(dependencies);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
  });
  await flush();
  return renderer;
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.testID === 'paywall-see-plans' &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error('no see-plans');
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('E2 rendered paywall copy policy (APP_STORE_SUBMISSION.md)', () => {
  it('value page + pricing page (all three plans, trial badge) contain no forbidden terms', async () => {
    const renderer = await render(deps({ access: access(0, 0) }));
    const value = allText(renderer);
    expect(value.length).toBeGreaterThan(100);
    for (const pattern of FORBIDDEN) expect(value).not.toMatch(pattern);
    await openPricing(renderer);
    const pricing = allText(renderer);
    expect(pricing).toContain('$59.99');
    expect(pricing).toContain('$159.99');
    for (const pattern of FORBIDDEN) expect(pricing).not.toMatch(pattern);
    // Only store-returned prices — nothing the store did not send.
    const prices = pricing.match(/\$\d+(\.\d{2})?/g) ?? [];
    for (const price of prices) {
      expect([
        '$59.99',
        '$7.99',
        '$159.99',
        '$5.00',
        '$95.88',
        '$35.89',
        '$36',
      ]).toContain(price);
    }
    await act(async () => {
      renderer.unmount();
    });
  });

  it('error + unavailable states: backend down and store offerings missing → no forbidden terms, no invented price', async () => {
    const renderer = await render(
      deps({
        getAccess: async () => {
          throw new BillingError(
            'billing.backend_unavailable',
            'Membership verification is temporarily unavailable.',
            true,
          );
        },
        loadPlans: async () => {
          throw new BillingError(
            'billing.offerings_unavailable',
            'Membership pricing is unavailable from the app store right now.',
            true,
          );
        },
      }),
    );
    await openPricing(renderer);
    const text = allText(renderer);
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    expect(text).not.toMatch(/\$\d/);
    expect(text).toContain('Store pricing is unavailable');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('verified (premium) state: no forbidden terms; both-used state renders the hard-boundary sentence', async () => {
    const premium = await render(deps({ access: access(2, 0, true) }));
    const text = allText(premium);
    expect(text).toContain('MEMBERSHIP VERIFIED');
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    await act(async () => {
      premium.unmount();
    });
    clearAccessStoreConfiguration();
    const exhausted = await render(deps({ access: access(2, 0) }));
    await openPricing(exhausted);
    expect(allText(exhausted)).toContain(
      'Both lifetime free ratings have been successfully scored.',
    );
    await act(async () => {
      exhausted.unmount();
    });
  });
});
