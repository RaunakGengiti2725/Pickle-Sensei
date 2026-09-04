/**
 * Structural audit #2 (mobile-billing-paywall) — PaywallScreen probes:
 * close-while-busy, late onPurchased after dismissal, Settings-first (store
 * already 'ready' with plans null) mount, savings chip arithmetic,
 * lifetime-only podium, and copy that must never show an estimated price.
 *
 * Renders the real screen over the real access store with mocked billing
 * dependencies (same harness shape as wf/PaywallScreen.buttons.test.tsx).
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
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlan,
  type StorePlans,
} from '../../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import { PressableScale } from '../../../src/design/components';
import {
  PaywallScreen,
  type PaywallScreenProps,
} from '../../../src/screens/PaywallScreen';

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

function plan(
  period: StorePlan['period'],
  price: number,
  priceString: string,
  extra?: Partial<StorePlan>,
): StorePlan {
  return {
    id: `${period}-plan`,
    productId: `pickle_sensei_pro_${period}`,
    period,
    price,
    priceString,
    pricePerMonthString: period === 'lifetime' ? null : priceString,
    freeTrial: null,
    ...extra,
  };
}

const standardPlans: StorePlans = {
  offeringId: 'default',
  annual: plan('annual', 59.99, '$59.99', { pricePerMonthString: '$5.00' }),
  monthly: plan('monthly', 7.99, '$7.99'),
  lifetime: plan('lifetime', 159.99, '$159.99'),
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

function dependencies(
  overrides?: Partial<{
    plans: StorePlans;
    purchase: () => Promise<StoreEntitlementState>;
    syncBilling: () => Promise<CanonicalBillingSync>;
    getAccess: () => Promise<CanonicalAccessState>;
  }>,
): BillingAccessDependencies & {
  store: { loadPlans: jest.Mock; purchase: jest.Mock };
  backend: { syncBilling: jest.Mock; getAccess: jest.Mock };
} {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => overrides?.plans ?? standardPlans),
      purchase: jest.fn(overrides?.purchase ?? (async () => storeEntitlement)),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(overrides?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(
        overrides?.syncBilling ?? (async () => premiumSync()),
      ),
    },
  };
}

function screenProps() {
  return { onClose: jest.fn(), onPurchased: jest.fn() };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderPaywall(props: PaywallScreenProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen {...props} />);
  });
  await flush();
  mounted.push(renderer);
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
  const index = mounted.indexOf(renderer);
  if (index >= 0) mounted.splice(index, 1);
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

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.type === PressableScale && n.props.testID === testID,
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
    n => n.type === PressableScale && n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

beforeEach(async () => {
  await act(async () => {
    clearAccessStoreConfiguration();
  });
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  await act(async () => {
    clearAccessStoreConfiguration();
  });
});

describe('probe A — close controls while a purchase is pending', () => {
  it('"Close membership offer" is disabled while operation === purchasing (like Continue/Restore)', async () => {
    const pending = deferred<StoreEntitlementState>();
    const deps = dependencies({ purchase: () => pending.promise });
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

    // The two navigation-away controls on the pricing page.
    expect(byLabel(renderer, 'Close membership offer').props.disabled).toBe(
      true,
    );
    expect(byTestId(renderer, 'paywall-back').props.disabled).toBe(true);

    pending.resolve(storeEntitlement);
    await flush();
    await unmount(renderer);
  });

  it('onPurchased must not fire after the screen was closed and unmounted mid-purchase', async () => {
    const pending = deferred<StoreEntitlementState>();
    const deps = dependencies({ purchase: () => pending.promise });
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    // User taps X (enabled — see previous probe); RootNavigator pops the route.
    await act(async () => {
      byLabel(renderer, 'Close membership offer').props.onPress();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await unmount(renderer);

    // StoreKit completes after the paywall is gone.
    pending.resolve(storeEntitlement);
    await flush();
    await flush();

    // Backend verified premium — correct and desirable.
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // But the popped route's callback (RootNavigator: navigation.goBack()) fires too.
    expect(props.onPurchased).not.toHaveBeenCalled();
  });

  it('"Back to membership benefits" while purchasing must not leave the pricing page (pending op loses its UI)', async () => {
    const pending = deferred<StoreEntitlementState>();
    const deps = dependencies({ purchase: () => pending.promise });
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
    // Still purchasing, but Continue/Restore (the disabled controls) are gone.
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);
    // Expected: page stays on pricing while the purchase is pending.
    expect(maybeByTestId(renderer, 'paywall-see-plans')).toHaveLength(0);
    pending.resolve(storeEntitlement);
    await flush();
    await unmount(renderer);
  });
});

describe('probe C (UI) — Settings-first: refreshAccess() ran before the paywall mounted', () => {
  it('mounting with status ready and plans null must load store plans (not show "Store pricing is unavailable")', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    // SettingsScreen useFocusEffect → refreshAccess() (no initialize()).
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      plans: null,
    });

    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    // Observed on 4d812e1a: PaywallScreen only initialises when status==='idle',
    // so plans never load; the user sees the unavailable card + Try again, and
    // Continue is disabled with the label "Store pricing unavailable".
    expect(deps.store.loadPlans).toHaveBeenCalled();
    expect(allText(renderer)).not.toContain('Store pricing is unavailable');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    await unmount(renderer);
  });

  it('Try again on that screen recovers (documents the manual recovery path)', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().refreshAccess();
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    if (maybeByTestId(renderer, 'paywall-retry').length > 0) {
      await act(async () => {
        byTestId(renderer, 'paywall-retry').props.onPress();
      });
      await flush();
    }
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(allText(renderer)).toContain('$59.99');
    await unmount(renderer);
  });
});

describe('savings chip arithmetic (store prices only)', () => {
  async function chipFor(plans: StorePlans): Promise<string | null> {
    configureAccessStore(dependencies({ plans }));
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    const text = allText(renderer);
    await unmount(renderer);
    const match = /SAVE \d+%/.exec(text);
    return match ? match[0] : null;
  }

  it('$59.99/yr vs $7.99/mo → SAVE 37% (95.88 → 59.99)', async () => {
    expect(await chipFor(standardPlans)).toBe('SAVE 37%');
  });

  it('no chip when the yearly price is not cheaper than 12 months', async () => {
    expect(
      await chipFor({
        ...standardPlans,
        annual: plan('annual', 95.88, '$95.88'),
      }),
    ).toBeNull();
    expect(
      await chipFor({
        ...standardPlans,
        annual: plan('annual', 120, '$120.00'),
      }),
    ).toBeNull();
  });

  it('no chip when savings round to 0% or the monthly price is 0/invalid', async () => {
    expect(
      await chipFor({
        ...standardPlans,
        annual: plan('annual', 95.5, '$95.50'),
      }),
    ).toBeNull();
    expect(
      await chipFor({
        ...standardPlans,
        monthly: plan('monthly', 0, '$0.00'),
      }),
    ).toBeNull();
  });

  it('no chip without a monthly plan to compare against', async () => {
    expect(await chipFor({ ...standardPlans, monthly: null })).toBeNull();
  });
});

describe('lifetime-only offering through the podium', () => {
  const lifetimeOnly: StorePlans = {
    offeringId: 'default',
    annual: null,
    monthly: null,
    lifetime: plan('lifetime', 159.99, '$159.99'),
  };

  it('renders one column, selects lifetime, shows one-time copy and no /mo, trial, BEST VALUE or SAVE chip', async () => {
    configureAccessStore(dependencies({ plans: lifetimeOnly }));
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(maybeByTestId(renderer, 'paywall-plan-lifetime')).toHaveLength(1);
    expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-plan-monthly')).toHaveLength(0);
    const text = allText(renderer);
    expect(text).toContain(
      'Lifetime · $159.99 one-time payment. No renewal, no subscription.',
    );
    expect(text).not.toMatch(/\/mo/);
    expect(text).not.toContain('free trial');
    expect(text).not.toContain('BEST VALUE');
    expect(text).not.toMatch(/SAVE \d+%/);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $159.99 once');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    await unmount(renderer);
  });
});

describe('pricing copy sourcing', () => {
  it('value page shows no price and no estimated price ever appears while plans are unavailable', async () => {
    const deps = dependencies();
    deps.store.loadPlans.mockRejectedValue(new Error('offerings down'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    expect(allText(renderer)).not.toMatch(/\$\d/);
    await openPricing(renderer);
    const text = allText(renderer);
    expect(text).not.toMatch(/\$\d/);
    expect(text).toContain('Store pricing is unavailable');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Store pricing unavailable');
    await unmount(renderer);
  });

  it('the pricing page never mentions prohibited store/marketing terms', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());
    const valueText = allText(renderer);
    await openPricing(renderer);
    const text = `${valueText} ${allText(renderer)}`;
    for (const banned of [
      'Android',
      'Google Play',
      'guest mode',
      'Live Court',
      'DUPR',
      'SwingVision',
      'PB Vision',
      'Selkirk',
      'JOOLA',
      '% accurate',
      'best coach',
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(text).not.toMatch(/\b\d{2,3}% accura/i);
    await unmount(renderer);
  });
});
