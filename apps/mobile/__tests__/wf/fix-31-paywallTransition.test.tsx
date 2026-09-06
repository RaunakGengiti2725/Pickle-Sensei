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

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import React from 'react';
import { Animated, StyleSheet } from 'react-native';
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
  mockReducedMotion = false;
  clearAccessStoreConfiguration();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  jest.restoreAllMocks();
});

function renderPhaseUpdates() {
  return consoleError.mock.calls.filter(args =>
    String(args[0]).includes('while rendering a different component'),
  );
}

function expectPageAtRest(renderer: TestRenderer.ReactTestRenderer) {
  const page = renderer.root.findByProps({ testID: 'paywall-page-body' });
  const style = StyleSheet.flatten(page.props.style);
  const value = (animated: number | { __getValue: () => number }) =>
    typeof animated === 'number' ? animated : animated.__getValue();
  expect(value(style.opacity)).toBe(1);
  expect(value(style.transform[0].translateX)).toBe(0);
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

  it('uses the native 220ms transition only while motion is enabled', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    const timing = jest.spyOn(Animated, 'timing');
    await press(renderer, 'paywall-see-plans');
    expect(timing).toHaveBeenCalledTimes(2);
    for (const [, config] of timing.mock.calls) {
      expect(config).toMatchObject({ duration: 220, useNativeDriver: true });
    }
    await press(renderer, 'paywall-back');
    expect(timing).toHaveBeenCalledTimes(4);
    expect(renderPhaseUpdates()).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('changes pages at rest under reduced motion and leaves purchase and restore untouched', async () => {
    mockReducedMotion = true;
    const deps = dependencies();
    configureAccessStore(deps);
    const renderer = await renderPaywall();
    const timing = jest.spyOn(Animated, 'timing');
    await press(renderer, 'paywall-see-plans');
    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    expectPageAtRest(renderer);
    await press(renderer, 'paywall-back');
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expectPageAtRest(renderer);
    expect(timing).not.toHaveBeenCalled();
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(renderPhaseUpdates()).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('settles an active page when reduced motion is enabled after mounting', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await press(renderer, 'paywall-see-plans');
    mockReducedMotion = true;
    const timing = jest.spyOn(Animated, 'timing');
    await act(async () =>
      renderer.update(<PaywallScreen onClose={jest.fn()} />),
    );
    expectPageAtRest(renderer);
    await press(renderer, 'paywall-back');
    expectPageAtRest(renderer);
    expect(timing).not.toHaveBeenCalled();
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
