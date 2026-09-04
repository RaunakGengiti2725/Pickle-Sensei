/**
 * Structural audit probes (mobile-billing-paywall, pass 1) for PaywallScreen
 * lifecycle: dismissal while an operation is pending, the Settings-first
 * mount order, lifetime-only offerings and savings-chip edge cases.
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
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StoreEntitlementState,
  StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PressableScale } from '../../src/design/components';
import {
  PaywallScreen,
  type PaywallScreenProps,
} from '../../src/screens/PaywallScreen';

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

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['premium', 'pickle_sensei_pro'],
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

const fullPlans: StorePlans = {
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

const lifetimeOnlyPlans: StorePlans = {
  offeringId: 'default',
  annual: null,
  monthly: null,
  lifetime: fullPlans.lifetime,
};

const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

function premiumSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: premiumAccess,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Deps = BillingAccessDependencies & {
  store: {
    configure: jest.Mock<Promise<void>, []>;
    loadPlans: jest.Mock<Promise<StorePlans>, []>;
    purchase: jest.Mock<Promise<StoreEntitlementState>, [string]>;
    restore: jest.Mock<Promise<StoreEntitlementState>, []>;
    readEntitlement: jest.Mock<Promise<StoreEntitlementState>, []>;
  };
  backend: {
    getAccess: jest.Mock<Promise<CanonicalAccessState>, []>;
    syncBilling: jest.Mock<Promise<CanonicalBillingSync>, []>;
  };
};

function dependencies(plans: StorePlans = fullPlans): Deps {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn<Promise<StoreEntitlementState>, [string]>(
        async () => storeEntitlement,
      ),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => premiumSync()),
    },
  };
}

function screenProps(): {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
} {
  return { onClose: jest.fn(), onPurchased: jest.fn() };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function renderPaywall(props: PaywallScreenProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen {...props} />);
  });
  await flush();
  return renderer;
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.type === PressableScale &&
      n.props.testID === testID &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function maybeByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n => n.type === PressableScale && n.props.testID === testID,
  );
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.type === PressableScale &&
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    byTestId(renderer, 'paywall-see-plans').props.onPress();
  });
  await flush();
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('audit: dismissal while an operation is pending (probe A)', () => {
  it('Close is not actionable while purchasing, or a purchase that completes after dismissal does not call onPurchased', async () => {
    const deps = dependencies();
    const slowPurchase = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementationOnce(() => slowPurchase.promise);
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);

    const close = byLabel(renderer, 'Close membership offer');
    const closeDisabled = close.props.disabled === true;
    if (!closeDisabled) {
      // The user dismisses the paywall (RootNavigator: goBack()) mid-purchase.
      await act(async () => {
        close.props.onPress();
      });
      expect(props.onClose).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer.unmount();
      });
    }

    slowPurchase.resolve(storeEntitlement);
    await flush();
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);

    // Invariant: a dismissed paywall must not fire a second navigation
    // callback (RootNavigator wires onPurchased → goBack() unconditionally).
    if (!closeDisabled) {
      expect(props.onPurchased).not.toHaveBeenCalled();
    } else {
      expect(props.onClose).not.toHaveBeenCalled();
    }
  });

  it('Back-to-value (pricing page) is unaffected: it does not dismiss and purchase still completes', async () => {
    const deps = dependencies();
    const slowPurchase = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementationOnce(() => slowPurchase.promise);
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    await act(async () => {
      byTestId(renderer, 'paywall-back').props.onPress();
    });
    await flush();
    expect(props.onClose).not.toHaveBeenCalled();
    slowPurchase.resolve(storeEntitlement);
    await flush();
    await flush();
    expect(props.onPurchased).toHaveBeenCalledTimes(1);
  });
});

describe('audit: Settings-first mount order (probe C, UI)', () => {
  it('after refreshAccess() ran first, the pricing page shows store plans instead of an unavailable card', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    // SettingsScreen focus refresh on a fresh launch.
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('ready');

    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);
    await flush();

    const text = allText(renderer);
    // Invariant: a healthy store must render store-returned prices, not the
    // unavailable card, and Continue must be purchasable.
    expect(text).not.toContain('Store pricing is unavailable');
    expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(1);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $59.99/yr');
  });
});

describe('audit: lifetime-only offering through the podium', () => {
  it('renders a single lifetime column, one-time copy, no /mo, no trial, no savings chip', async () => {
    const deps = dependencies(lifetimeOnlyPlans);
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(maybeByTestId(renderer, 'paywall-plan-lifetime')).toHaveLength(1);
    expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-plan-monthly')).toHaveLength(0);

    const text = allText(renderer);
    expect(text).toContain('$159.99');
    expect(text).toContain('one-time');
    expect(text).not.toMatch(/\/mo\b/);
    expect(text).not.toMatch(/free trial/i);
    expect(text).not.toContain('SAVE');
    expect(text).not.toContain('BEST VALUE');
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $159.99 once');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(text).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
  });

  it('a purchase of the lifetime plan verifies through the backend before onPurchased', async () => {
    const deps = dependencies(lifetimeOnlyPlans);
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    await flush();
    expect(deps.store.purchase).toHaveBeenCalledWith('lifetime-plan');
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(props.onPurchased).toHaveBeenCalledTimes(1);
  });
});

describe('audit: savings chip arithmetic', () => {
  it('shows a rounded SAVE chip only when annual is cheaper than 12 × monthly', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    // 7.99 * 12 = 95.88; (95.88 - 59.99) / 95.88 = 37.4% → 37
    expect(allText(renderer)).toContain('SAVE 37%');
  });

  it('never shows a negative or zero savings chip', async () => {
    const deps = dependencies({
      ...fullPlans,
      annual: { ...fullPlans.annual!, price: 99.99, priceString: '$99.99' },
    });
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    expect(allText(renderer)).not.toMatch(/SAVE/);
  });

  it('a free monthly price (0) never divides into a savings chip', async () => {
    const deps = dependencies({
      ...fullPlans,
      monthly: { ...fullPlans.monthly!, price: 0, priceString: '$0.00' },
    });
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    expect(allText(renderer)).not.toMatch(/SAVE/);
    expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
  });
});

describe('audit: value page never shows a price', () => {
  it('value page copy contains no currency amounts even with plans loaded', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    expect(allText(renderer)).not.toMatch(/\$\d/);
    expect(allText(renderer)).not.toMatch(/\d+\.\d{2}/);
  });
});
