/**
 * App Store compliance sweep — paywall (App Review 3.1.2 / 2.1 / 4.2).
 *
 * Drives PaywallScreen through its buttons the way a reviewer would: close
 * from both pages, Terms and Privacy links (functional, link role), purchase
 * success → onPurchased, user-cancelled purchase → no error card, store
 * failure → honest copy + dismiss, restore failure copy, the operation guard
 * against double taps, no infinite spinner after failures, no external
 * purchase steering copy, and the verified-membership view's exits.
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
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { BrandSpinner } from '../../src/design/components';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
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

const entitled: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dependencies(overrides?: {
  loadPlans?: () => Promise<StorePlans>;
  purchase?: () => Promise<StoreEntitlementState>;
  restore?: () => Promise<StoreEntitlementState>;
  syncBilling?: () => Promise<{ access: CanonicalAccessState }>;
  getAccess?: () => Promise<CanonicalAccessState>;
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(overrides?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(overrides?.purchase ?? (async () => entitled)),
      restore: jest.fn(overrides?.restore ?? (async () => entitled)),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(overrides?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(
        overrides?.syncBilling ??
          (async () => ({
            access: premiumAccess,
            storeSnapshot: entitled,
          })),
      ),
    },
  } as unknown as BillingAccessDependencies;
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

type Handlers = {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
  onOpenTerms: jest.Mock;
  onOpenPrivacy: jest.Mock;
};

async function renderPaywall(withLegal = true) {
  const handlers: Handlers = {
    onClose: jest.fn(),
    onPurchased: jest.fn(),
    onOpenTerms: jest.fn(),
    onOpenPrivacy: jest.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen
        onClose={handlers.onClose}
        onPurchased={handlers.onPurchased}
        {...(withLegal
          ? {
              onOpenTerms: handlers.onOpenTerms,
              onOpenPrivacy: handlers.onOpenPrivacy,
            }
          : {})}
      />,
    );
  });
  await flush();
  return { renderer, handlers };
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

/** The innermost pressable (RN's Pressable) carrying the label, so the
 * resolved accessibility props — not PressableScale's inputs — are asserted. */
function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  const node = nodes[nodes.length - 1];
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function hasLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(n => n.props.accessibilityLabel === label)
    .length;
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    byTestId(renderer, 'paywall-see-plans').props.onPress();
  });
  await flush();
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('Paywall — exits and legal links (3.1.2)', () => {
  it('close is wired on both pages and back returns to the value page', async () => {
    configureAccessStore(dependencies());
    const { renderer, handlers } = await renderPaywall();

    const close = byLabel(renderer, 'Close membership offer');
    expect(close.props.accessibilityRole).toBe('button');
    await act(async () => close.props.onPress());
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    await openPricing(renderer);
    await act(async () =>
      byLabel(renderer, 'Close membership offer').props.onPress(),
    );
    expect(handlers.onClose).toHaveBeenCalledTimes(2);

    const back = byTestId(renderer, 'paywall-back');
    expect(back.props.accessibilityLabel).toBe('Back to membership benefits');
    await act(async () => back.props.onPress());
    expect(byTestId(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('Terms and Privacy are functional link-role controls on the pricing page', async () => {
    configureAccessStore(dependencies());
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    const terms = byLabel(renderer, 'Terms of use');
    const privacy = byLabel(renderer, 'Privacy policy');
    expect(terms.props.accessibilityRole).toBe('link');
    expect(privacy.props.accessibilityRole).toBe('link');
    await act(async () => terms.props.onPress());
    await act(async () => privacy.props.onPress());
    expect(handlers.onOpenTerms).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPrivacy).toHaveBeenCalledTimes(1);

    // Subscription disclosure sits next to the links: price, period,
    // auto-renewal, and where to cancel.
    const copy = allText(renderer);
    expect(copy).toContain('$59.99 per year, automatically renewing');
    expect(copy).toContain('Cancel in your store account settings.');
    act(() => renderer.unmount());
  });

  it('never renders a dead Terms/Privacy control when no handler is supplied', async () => {
    configureAccessStore(dependencies());
    const { renderer } = await renderPaywall(false);
    await openPricing(renderer);
    expect(hasLabel(renderer, 'Terms of use')).toBe(0);
    expect(hasLabel(renderer, 'Privacy policy')).toBe(0);
    act(() => renderer.unmount());
  });

  it('contains no external purchase steering copy', async () => {
    configureAccessStore(dependencies());
    const { renderer } = await renderPaywall();
    const valueCopy = allText(renderer);
    await openPricing(renderer);
    const pricingCopy = allText(renderer);
    for (const copy of [valueCopy, pricingCopy]) {
      expect(copy).not.toMatch(/https?:\/\//i);
      expect(copy).not.toMatch(/\bwebsite\b|\bon the web\b|\bbrowser\b/i);
      expect(copy).not.toMatch(/cheaper|discount code|promo code|paypal/i);
    }
    expect(pricingCopy).toContain(
      'Purchase and renewal are confirmed by your app store.',
    );
    act(() => renderer.unmount());
  });
});

describe('Paywall — purchase branches', () => {
  it('success: purchase → backend verify → onPurchased once, no error card', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    const continueButton = byTestId(renderer, 'paywall-continue');
    expect(continueButton.props.disabled).toBe(false);
    expect(continueButton.props.accessibilityLabel).toBe(
      'Continue · $59.99/yr',
    );
    await act(async () => continueButton.props.onPress());
    await flush();

    expect(deps.store.purchase).toHaveBeenCalledWith('annual-plan');
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    expect(hasLabel(renderer, 'Dismiss membership message')).toBe(0);
    act(() => renderer.unmount());
  });

  it('user cancels the StoreKit sheet: no error card, buttons re-enabled, no onPurchased', async () => {
    const deps = dependencies({
      purchase: async () => {
        throw new BillingError(
          'billing.purchase_cancelled',
          'Purchase cancelled.',
          false,
        );
      },
    });
    configureAccessStore(deps);
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    await act(async () =>
      byTestId(renderer, 'paywall-continue').props.onPress(),
    );
    await flush();

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    expect(hasLabel(renderer, 'Dismiss membership message')).toBe(0);
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('store failure: honest copy, dismissible, spinner cleared, purchase re-enabled', async () => {
    configureAccessStore(
      dependencies({
        purchase: async () => {
          throw new Error('SKErrorDomain 0');
        },
      }),
    );
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    await act(async () =>
      byTestId(renderer, 'paywall-continue').props.onPress(),
    );
    await flush();

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'The app store could not complete the purchase.',
    );
    const dismiss = byLabel(renderer, 'Dismiss membership message');
    expect(dismiss.props.accessibilityLiveRegion).toBe('assertive');
    expect(dismiss.props.accessibilityHint).toBe(
      'The app store could not complete the purchase.',
    );
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);

    await act(async () => dismiss.props.onPress());
    expect(hasLabel(renderer, 'Dismiss membership message')).toBe(0);
    expect(allText(renderer)).not.toContain('could not complete the purchase');
    act(() => renderer.unmount());
  });

  it('store succeeded but backend verification failed: pending copy, Restore stays available', async () => {
    configureAccessStore(
      dependencies({
        syncBilling: async () => {
          throw new Error('503');
        },
      }),
    );
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    await act(async () =>
      byTestId(renderer, 'paywall-continue').props.onPress(),
    );
    await flush();

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'membership verification is still pending. Try Restore purchases.',
    );
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-retry')).toBeTruthy();
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('double tap: while purchasing, Continue/Restore/Retry are disabled and the store is called once', async () => {
    const pending = deferred<StoreEntitlementState>();
    const deps = dependencies({ purchase: () => pending.promise });
    configureAccessStore(deps);
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    const continueButton = byTestId(renderer, 'paywall-continue');
    await act(async () => continueButton.props.onPress());
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(renderer.root.findAllByType(BrandSpinner).length).toBe(1);

    // A second tap (or a programmatic re-entry) is a no-op at the store.
    await act(async () =>
      byTestId(renderer, 'paywall-continue').props.onPress(),
    );
    await act(async () =>
      byTestId(renderer, 'paywall-restore').props.onPress(),
    );
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.store.restore).not.toHaveBeenCalled();

    await act(async () => pending.resolve(entitled));
    await flush();
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('idle');
    act(() => renderer.unmount());
  });
});

describe('Paywall — restore branches', () => {
  it('restore success closes via onPurchased', async () => {
    configureAccessStore(dependencies());
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await act(async () =>
      byTestId(renderer, 'paywall-restore').props.onPress(),
    );
    await flush();
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('restore with no membership: honest copy, nothing unlocked, no spinner', async () => {
    configureAccessStore(
      dependencies({
        syncBilling: async () => ({ access: freeAccess }),
      }),
    );
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await act(async () =>
      byTestId(renderer, 'paywall-restore').props.onPress(),
    );
    await flush();
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'No active Pickle Sensei membership was found for this store account.',
    );
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('restore store failure: failure copy and re-enabled controls', async () => {
    configureAccessStore(
      dependencies({
        restore: async () => {
          throw new Error('network');
        },
      }),
    );
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    await act(async () =>
      byTestId(renderer, 'paywall-restore').props.onPress(),
    );
    await flush();
    expect(allText(renderer)).toContain(
      'The app store could not restore purchases.',
    );
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });
});

describe('Paywall — pricing unavailable and premium states', () => {
  it('pricing unavailable: Continue is disabled with honest label, Retry re-fetches and recovers', async () => {
    let attempts = 0;
    configureAccessStore(
      dependencies({
        loadPlans: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('store offline');
          return plans;
        },
      }),
    );
    const { renderer } = await renderPaywall();
    await openPricing(renderer);

    const continueButton = byTestId(renderer, 'paywall-continue');
    expect(continueButton.props.disabled).toBe(true);
    expect(continueButton.props.accessibilityLabel).toBe(
      'Store pricing unavailable',
    );
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);

    const retry = byTestId(renderer, 'paywall-retry');
    expect(retry.props.accessibilityLabel).toBe('Retry loading membership');
    await act(async () => retry.props.onPress());
    await flush();
    expect(attempts).toBe(2);
    expect(byTestId(renderer, 'paywall-plan-annual')).toBeTruthy();
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('verified members see an honest state with two wired exits and no purchase controls', async () => {
    configureAccessStore(
      dependencies({ getAccess: async () => premiumAccess }),
    );
    const { renderer, handlers } = await renderPaywall();
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-continue'),
    ).toHaveLength(0);
    await act(async () =>
      byLabel(renderer, 'Close membership').props.onPress(),
    );
    await act(async () =>
      byLabel(renderer, 'Continue coaching').props.onPress(),
    );
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});
