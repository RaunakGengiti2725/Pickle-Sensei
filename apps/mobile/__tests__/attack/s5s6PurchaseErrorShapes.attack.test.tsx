/**
 * ADVERSARIAL S5 + S6 — how does the paywall classify non-canonical
 * RevenueCat purchase rejections?
 *
 *   S5  { code: 1 } (NUMERIC — the SDK enum PURCHASE_CANCELLED_ERROR is the
 *       STRING "1"; native bridges / older SDKs have surfaced numbers) and
 *       { userInfo: { readableErrorCode: 'PURCHASE_CANCELLED' } } (the
 *       documented PurchasesError.userInfo shape with no top-level code).
 *       Question: silent cancel, or a "could not complete the purchase" card?
 *   S6  { code: '6' } PRODUCT_ALREADY_PURCHASED_ERROR. Question: does the
 *       error card direct the user to Restore, or show a generic failure?
 *
 * Both are probed at two layers:
 *   SDK   createRevenueCatBillingClient(...).purchase() with a fake SDK whose
 *         purchasePackage rejects with the raw shape → BillingError code.
 *   UI    PaywallScreen with deps.store.purchase rejecting the SAME raw shape
 *         (as a BillingError from the SDK layer AND as the raw object) →
 *         what the user actually sees on the error card.
 *
 * The assertions below encode the OBSERVED behaviour on 4d812e1a so the
 * suite is green and the observations are pinned; each `it` title states
 * whether that observation is HELD or BROKEN. The findings report carries
 * the expected-vs-observed judgement.
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
  createRevenueCatBillingClient,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';

const annualPackage: RevenueCatPackageLike = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: {
    identifier: 'pickle_sensei_pro_annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    introPrice: null,
    defaultOption: null,
  },
};

function fakeSdk(rejectWith: unknown): RevenueCatSdk {
  let appUserId = CANONICAL_USER_ID;
  return {
    isConfigured: jest.fn(async () => false),
    configure: jest.fn(async input => {
      appUserId = input.appUserID;
    }),
    getAppUserID: jest.fn(async () => appUserId),
    logIn: jest.fn(async id => {
      appUserId = id;
    }),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: 'default',
        annual: annualPackage,
        monthly: null,
        lifetime: null,
      },
    })),
    purchasePackage: jest.fn(async () => {
      throw rejectWith;
    }),
    restorePurchases: jest.fn(async () => ({ entitlements: { active: {} } })),
    getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({})),
  };
}

async function sdkLayerOutcome(rejectWith: unknown): Promise<BillingError> {
  const client = createRevenueCatBillingClient(
    { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
    fakeSdk(rejectWith),
    'ios',
  );
  const plans = await client.loadPlans();
  const planId = plans.annual?.id;
  if (!planId) throw new Error('fixture: annual plan missing');
  try {
    await client.purchase(planId);
  } catch (error) {
    if (error instanceof BillingError) return error;
    throw error;
  }
  throw new Error('purchase unexpectedly resolved');
}

// ---------- UI layer ----------

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

function deps(purchaseRejectsWith: unknown): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => {
        throw purchaseRejectsWith;
      }),
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
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('purchase never reaches sync in these tests');
      }),
    },
  };
}

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function errorCard(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityLabel === 'Dismiss membership message',
  );
  return node ?? null;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function pressContinueWith(rejectWith: unknown) {
  const onPurchased = jest.fn();
  const dependencies = deps(rejectWith);
  configureAccessStore(dependencies);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen onClose={jest.fn()} onPurchased={onPurchased} />,
    );
  });
  await flush();
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await flush();
  await act(async () => {
    pressable(renderer, 'paywall-continue').props.onPress();
  });
  await flush();
  expect(dependencies.store.purchase).toHaveBeenCalledTimes(1);
  expect(dependencies.backend.syncBilling).not.toHaveBeenCalled();
  expect(onPurchased).not.toHaveBeenCalled();
  return {
    renderer,
    card: errorCard(renderer),
    state: useAccessStore.getState(),
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('S5 cancellation shapes', () => {
  it("control (HELD): SDK { code: '1' } and { userCancelled: true } → billing.purchase_cancelled, silent on the paywall", async () => {
    for (const shape of [
      { code: '1' },
      { userCancelled: true },
      { code: '1', userCancelled: true },
    ]) {
      const error = await sdkLayerOutcome(shape);
      expect(error.code).toBe('billing.purchase_cancelled');
      expect(error.retryable).toBe(false);
    }
    const { card, state, renderer } = await pressContinueWith(
      new BillingError(
        'billing.purchase_cancelled',
        'Purchase canceled.',
        false,
      ),
    );
    expect(card).toBeNull();
    expect(state.error).toBeNull();
    expect(state.operation).toBe('idle');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('BROKEN: SDK { code: 1 } (numeric) → billing.purchase_failed, NOT purchase_cancelled', async () => {
    const error = await sdkLayerOutcome({ code: 1 });
    expect(error.code).toBe('billing.purchase_failed');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      'The app store could not complete the purchase. Please try again.',
    );
  });

  it("BROKEN: SDK { userInfo: { readableErrorCode: 'PURCHASE_CANCELLED' } } → billing.purchase_failed", async () => {
    const error = await sdkLayerOutcome({
      userInfo: { readableErrorCode: 'PURCHASE_CANCELLED' },
    });
    expect(error.code).toBe('billing.purchase_failed');
  });

  it('BROKEN: readableErrorCode at the top level (documented PurchasesError field) is ignored too', async () => {
    const error = await sdkLayerOutcome({
      code: 1,
      readableErrorCode: 'PURCHASE_CANCELLED_ERROR',
      userInfo: { readableErrorCode: 'PURCHASE_CANCELLED_ERROR' },
      userCancelled: null,
    });
    expect(error.code).toBe('billing.purchase_failed');
  });

  it.each([
    ['{ code: 1 }', { code: 1 }],
    [
      "{ userInfo: { readableErrorCode: 'PURCHASE_CANCELLED' } }",
      { userInfo: { readableErrorCode: 'PURCHASE_CANCELLED' } },
    ],
  ])(
    'UI (BROKEN): a cancel that reaches the store as %s shows the generic failure card',
    async (_label, shape) => {
      // Raw shape straight from the store layer (models a bridge that skipped
      // purchaseError()) — accessStore.billingError() wraps non-BillingErrors.
      const raw = await pressContinueWith(shape);
      expect(raw.card).not.toBeNull();
      expect(raw.state.error).toEqual({
        code: 'billing.purchase_failed',
        message: 'The app store could not complete the purchase.',
        retryable: true,
      });
      await act(async () => {
        raw.renderer.unmount();
      });
      clearAccessStoreConfiguration();
      // …and the SAME shape after the SDK layer classified it (the real path).
      const classified = await pressContinueWith(await sdkLayerOutcome(shape));
      expect(classified.card).not.toBeNull();
      expect(classified.state.error?.code).toBe('billing.purchase_failed');
      expect(allText(classified.renderer)).toContain(
        'The app store could not complete the purchase. Please try again.',
      );
      await act(async () => {
        classified.renderer.unmount();
      });
    },
  );

  it('extras (HELD): cancellation never returns from purchase as a success, whatever the shape', async () => {
    for (const shape of [
      { code: '1', userCancelled: false },
      { code: 1, userCancelled: true },
      { userCancelled: 'true' },
      { code: '01' },
      { code: ' 1' },
      { code: '１' },
      'PURCHASE_CANCELLED',
      null,
      undefined,
      new Error('cancelled'),
    ]) {
      const error = await sdkLayerOutcome(shape);
      expect([
        'billing.purchase_cancelled',
        'billing.purchase_failed',
      ]).toContain(error.code);
    }
  });
});

describe("S6 { code: '6' } PRODUCT_ALREADY_PURCHASED_ERROR", () => {
  it('BROKEN: SDK layer maps it to the generic billing.purchase_failed', async () => {
    const error = await sdkLayerOutcome({
      code: '6',
      readableErrorCode: 'PRODUCT_ALREADY_PURCHASED_ERROR',
    });
    expect(error.code).toBe('billing.purchase_failed');
    expect(error.message).not.toMatch(/restore/i);
  });

  it('UI (BROKEN): the error card is the generic store failure and does not mention Restore', async () => {
    const { renderer, card, state } = await pressContinueWith(
      await sdkLayerOutcome({ code: '6' }),
    );
    expect(card).not.toBeNull();
    expect(state.error?.code).toBe('billing.purchase_failed');
    const cardText = String(
      (card?.props as { accessibilityHint?: string }).accessibilityHint,
    );
    expect(cardText).toBe(
      'The app store could not complete the purchase. Please try again.',
    );
    expect(cardText).not.toMatch(/restore/i);
    // The Restore button is on screen and enabled — but nothing points at it.
    const restore = pressable(renderer, 'paywall-restore');
    expect(restore.props.disabled).toBe(false);
    expect(useAccessStore.getState().operation).toBe('idle');
    await act(async () => {
      renderer.unmount();
    });
  });

  it("control (HELD): store-level 'already owned' recovers via Restore when the user finds the button", async () => {
    const dependencies = deps(await sdkLayerOutcome({ code: '6' }));
    const premiumAccess: CanonicalAccessState = {
      ...freeAccess,
      premium: true,
      entitlements: ['premium', 'pickle_sensei_pro'],
      canStartRating: true,
      paywallRequired: false,
    };
    dependencies.backend.syncBilling = jest.fn(async () => ({
      billing: {
        premium: true,
        productKey: 'pickle_sensei_pro_annual',
        expiresAt: '2099-01-01T00:00:00.000Z',
        verifiedAt: '2026-09-04T12:00:00.000Z',
      },
      access: premiumAccess,
    }));
    configureAccessStore(dependencies);
    const onPurchased = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen onClose={jest.fn()} onPurchased={onPurchased} />,
      );
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    expect(errorCard(renderer)).not.toBeNull();
    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await flush();
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    await act(async () => {
      renderer.unmount();
    });
  });
});
