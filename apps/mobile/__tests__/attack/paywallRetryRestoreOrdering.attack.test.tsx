/**
 * UI-level adversarial reproduction for the MBP-1 ordering hole reached via
 * PaywallScreen's "Try again" (initialize) button rather than refreshAccess().
 *
 * Path: signed-in user opens Settings first (useFocusEffect → refreshAccess,
 * status ready, plans never loaded) → Membership → PaywallScreen shows "Try
 * again" → taps it (initialize(): GET /v1/me/access + loadPlans in flight on
 * a slow link) → taps "Restore purchases" (enabled; busy === false) → backend
 * verifies premium → the stale GET lands and must NOT revert the verified
 * membership.
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
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

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

const paidAccess: CanonicalAccessState = {
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
    productId: 'pickle_sensei_pro_yearly',
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
  lifetime: null,
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

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

function dependencies(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  const entitlement = {
    premium: true,
    productId: 'pickle_sensei_pro_yearly',
    expirationDate: '2027-09-04T00:00:00.000Z',
  };
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(async () => ({
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: '2027-09-04T00:00:00.000Z',
          verifiedAt: '2026-09-04T00:00:00.000Z',
        },
        access: paidAccess,
      })),
    },
  };
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function hasLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return (
    renderer.root.findAll(n => n.props.accessibilityLabel === label).length > 0
  );
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

it('Paywall "Try again" then "Restore purchases": the retry GET that started first must not revert the restored membership', async () => {
  const stalledGet = deferred<CanonicalAccessState>();
  let calls = 0;
  const clients = dependencies(() =>
    ++calls === 2 ? stalledGet.promise : Promise.resolve(freeAccess),
  );
  configureAccessStore(clients);

  // Settings-first: refreshAccess() completed, plans never loaded.
  await useAccessStore.getState().refreshAccess();
  expect(useAccessStore.getState().status).toBe('ready');
  expect(useAccessStore.getState().plans).toBeNull();

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

  // "Try again" → initialize(); its GET stalls on the wire.
  await act(async () => {
    pressable(renderer, 'paywall-retry').props.onPress();
  });
  await flush();
  expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
  expect(useAccessStore.getState().status).toBe('loading');

  // Restore is still enabled while that read is in flight; the user taps it
  // and the backend verifies premium.
  const restore = pressable(renderer, 'paywall-restore');
  expect(restore.props.disabled).toBe(false);
  await act(async () => {
    restore.props.onPress();
  });
  await flush();
  expect(onPurchased).toHaveBeenCalledTimes(1);
  expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  expect(hasLabel(renderer, 'Continue coaching')).toBe(true);

  // The older read lands last.
  stalledGet.resolve(freeAccess);
  await flush();

  const state = useAccessStore.getState();
  expect({
    canonicalAccess: state.canonicalAccess,
    premium: selectHasPremium(state),
    canStartRating: selectCanStartRating(state),
    paywallRequired: selectPaywallRequired(state),
    membershipVerifiedScreen: hasLabel(renderer, 'Continue coaching'),
  }).toEqual({
    canonicalAccess: paidAccess,
    premium: true,
    canStartRating: true,
    paywallRequired: false,
    membershipVerifiedScreen: true,
  });
  act(() => renderer.unmount());
});
