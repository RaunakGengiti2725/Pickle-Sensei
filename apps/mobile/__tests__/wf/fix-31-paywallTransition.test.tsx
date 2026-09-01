/**
 * Page transitions on the paywall must not run Animated side effects inside
 * a React state updater: React re-runs updaters during render for every
 * mount after the first, which logged "Cannot update a component
 * (Animated(View)) while rendering a different component (PaywallScreen)".
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
import TestRenderer, { act } from 'react-test-renderer';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

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

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'premium_annual_3999',
    period: 'annual',
    price: 39.99,
    priceString: '$39.99',
    pricePerMonthString: '$3.33',
    freeTrial: null,
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

function dependencies(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
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
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised in these tests');
      }),
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function renderPaywall() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
  });
  await flush();
  return renderer;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    pressable(renderer, testID).props.onPress();
  });
  await flush();
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  clearAccessStoreConfiguration();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

function renderPhaseUpdates() {
  return consoleError.mock.calls.filter(args =>
    String(args[0]).includes('while rendering a different component'),
  );
}

describe('PaywallScreen page transition', () => {
  // The warning only surfaces on a re-opened paywall (second mounted
  // instance against a reconfigured access store), so the first case is
  // the setup the second one depends on.
  it('mounts and unmounts a first paywall instance cleanly', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(renderPhaseUpdates()).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('never dispatches Animated updates from a render-phase state updater on a re-opened paywall', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await press(renderer, 'paywall-see-plans');
    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    await press(renderer, 'paywall-back');
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    await press(renderer, 'paywall-see-plans');
    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();

    expect(renderPhaseUpdates()).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
