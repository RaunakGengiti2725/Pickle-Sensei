/**
 * Two-page paywall flow. Page 1 (value): benefits and the free-allowance
 * statement, with NO prices. Page 2 (pricing): the podium layout — three
 * store-priced columns (Monthly / Yearly / Lifetime), yearly pre-selected
 * with BEST VALUE + savings badges, lifetime marked PAY ONCE, a plain-words
 * restatement of the selected plan, and an honest fallback (never an
 * invented price) when store pricing is missing.
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
  StorePlans,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../src/state/accessStore';
import { PaywallScreen } from '../src/screens/PaywallScreen';

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

const paidAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
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

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'premium_annual_3999',
    period: 'annual',
    price: 39.99,
    priceString: '$39.99',
    pricePerMonthString: '$3.33',
    freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'premium_monthly_499',
    period: 'monthly',
    price: 4.99,
    priceString: '$4.99',
    pricePerMonthString: '$4.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'premium_lifetime_15999',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function dependencies(options?: {
  loadPlans?: () => Promise<StorePlans>;
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(options?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
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
      syncBilling: jest.fn(
        options?.syncBilling ??
          (async () => {
            throw new Error('not exercised in these tests');
          }),
      ),
    },
  };
}

const verifiedPremiumSync: BillingAccessDependencies['backend']['syncBilling'] =
  async () => ({
    billing: {
      premium: true,
      productKey: 'premium_annual_3999',
      expiresAt: '2027-08-27T00:00:00.000Z',
      verifiedAt: '2026-08-27T00:00:00.000Z',
    },
    access: paidAccess,
  });

async function renderPaywall(callbacks?: {
  onClose?: () => void;
  onPurchased?: () => void;
}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen
        onClose={callbacks?.onClose ?? jest.fn()}
        onPurchased={callbacks?.onPurchased}
      />,
    );
  });
  // Flush initialize(): configure + getAccess/loadPlans promise chains.
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
  return renderer;
}

/** Step from the value page to the pricing page (the second paywall page). */
async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('PaywallScreen podium', () => {
  it('sells value on page 1: benefits, no prices, and a see-plans step', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();

    // Page 1 is the value pitch: benefits present, prices absent.
    const copy = allText(renderer);
    expect(copy).toContain('A coach for every stroke.');
    expect(copy).toContain('Unlimited validated ratings');
    expect(copy).toContain('Rank and progress from real scores');
    expect(copy).not.toContain('$');
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-continue'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('returns from pricing to the value page via back', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    await act(async () => {
      pressable(renderer, 'paywall-back').props.onPress();
    });
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-continue'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('renders all three podium columns with store prices and badges', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(pressable(renderer, 'paywall-plan-monthly')).toBeTruthy();
    expect(pressable(renderer, 'paywall-plan-annual')).toBeTruthy();
    expect(pressable(renderer, 'paywall-plan-lifetime')).toBeTruthy();
    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    expect(pressable(renderer, 'paywall-restore')).toBeTruthy();

    const copy = allText(renderer);
    // Store-verified prices, never invented.
    expect(copy).toContain('$4.99');
    expect(copy).toContain('$39.99');
    expect(copy).toContain('$159.99');
    // Podium badges and qualifiers.
    expect(copy).toContain('BEST VALUE');
    expect(copy).toContain('PAY ONCE');
    expect(copy).toContain('SAVE 33%');
    expect(copy).toContain('/month · billed monthly');
    expect(copy).toContain('$3.33/mo · billed yearly');
    expect(copy).toContain('one-time · yours forever');

    act(() => renderer.unmount());
  });

  it('pre-selects yearly and restates it in words with trial-first CTA', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(
      pressable(renderer, 'paywall-plan-annual').props.accessibilityState
        ?.selected,
    ).toBe(true);
    const copy = allText(renderer);
    expect(copy).toContain(
      'Yearly · $39.99 per year, auto-renews. Cancel anytime.',
    );
    expect(copy).toContain('Start free trial');
    expect(copy).toContain('After the 7-day free trial,');

    act(() => renderer.unmount());
  });

  it('selecting lifetime updates the summary, CTA, and legal copy', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    await act(async () => {
      pressable(renderer, 'paywall-plan-lifetime').props.onPress();
    });

    expect(
      pressable(renderer, 'paywall-plan-lifetime').props.accessibilityLabel,
    ).toBe('Lifetime membership, $159.99 one-time, selected');
    const copy = allText(renderer);
    expect(copy).toContain(
      'Lifetime · $159.99 one-time payment. No renewal, no subscription.',
    );
    expect(copy).toContain('Continue · $159.99 once');
    expect(copy).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
    expect(copy).not.toContain('automatically renewing');

    act(() => renderer.unmount());
  });

  it('calls onPurchased exactly once when the screen stays mounted through a verified purchase', async () => {
    const clients = dependencies({ syncBilling: verifiedPremiumSync });
    configureAccessStore(clients);
    const onClose = jest.fn();
    const onPurchased = jest.fn();
    const renderer = await renderPaywall({ onClose, onPurchased });
    await openPricing(renderer);

    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });

    expect(clients.store.purchase).toHaveBeenCalledWith('annual-plan');
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    act(() => renderer.unmount());
  });

  it('calls onPurchased exactly once when the screen stays mounted through a verified restore', async () => {
    const clients = dependencies({ syncBilling: verifiedPremiumSync });
    configureAccessStore(clients);
    const onPurchased = jest.fn();
    const renderer = await renderPaywall({ onPurchased });
    await openPricing(renderer);

    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });

    expect(clients.store.restore).toHaveBeenCalledTimes(1);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    act(() => renderer.unmount());
  });

  it('disables Close and Back only while a store operation is in flight', async () => {
    let resolvePurchase!: (value: {
      premium: boolean;
      productId: string | null;
      expirationDate: string | null;
    }) => void;
    const clients = dependencies({ syncBilling: verifiedPremiumSync });
    (clients.store.purchase as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolvePurchase = resolve;
        }),
    );
    configureAccessStore(clients);
    const onClose = jest.fn();
    const onPurchased = jest.fn();
    const renderer = await renderPaywall({ onClose, onPurchased });

    const closeControls = () =>
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Close membership offer' &&
          typeof n.props.onPress === 'function',
      );
    const closeStates = () =>
      closeControls().map(n => ({
        disabled: n.props.disabled,
        announced: n.props.accessibilityState?.disabled,
      }));
    expect(closeStates().every(s => !s.disabled)).toBe(true);
    await openPricing(renderer);
    expect(pressable(renderer, 'paywall-back').props.disabled).toBeFalsy();
    expect(closeStates().every(s => !s.disabled)).toBe(true);

    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(pressable(renderer, 'paywall-back').props.disabled).toBe(true);
    expect(closeStates().every(s => s.disabled === true)).toBe(true);
    // VoiceOver must hear it too (PressableScale mirrors disabled into
    // accessibilityState on the underlying Pressable).
    expect(closeStates().some(s => s.announced === true)).toBe(true);

    resolvePurchase({
      premium: true,
      productId: 'premium_annual_3999',
      expirationDate: null,
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('keeps the honest no-pricing fallback and retry when the store fails', async () => {
    configureAccessStore(
      dependencies({
        loadPlans: async () => {
          throw new Error('store offline');
        },
      }),
    );
    const renderer = await renderPaywall();
    await openPricing(renderer);

    const copy = allText(renderer);
    expect(copy).toContain('Store pricing is unavailable');
    expect(copy).not.toContain('$');
    expect(pressable(renderer, 'paywall-retry')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-plan-annual'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });
});
