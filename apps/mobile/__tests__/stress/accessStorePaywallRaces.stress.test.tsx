/**
 * STRESS / CONCURRENCY — accessStore races as the PaywallScreen actually
 * exposes them (companion to accessStoreConcurrency.stress.test.ts, which
 * drives the store directly).
 *
 * The store-level campaign found I3/I4/I9 broken. These tests confirm that
 * the real screen reaches those states through user-reachable paths, with
 * controllable (deferred) billing dependencies:
 *
 *   - I9 (sequential): a Settings-focus `refreshAccess()` that completes
 *     before the user ever opens the paywall leaves `status: 'ready'` with no
 *     plans. PaywallScreen only auto-initializes on `status === 'idle'`, so
 *     the paywall opens on "Store pricing unavailable" + "Try again" and the
 *     store SDK is never even configured until the user taps retry.
 *   - I3: "Try again" (initialize) is loading; the Restore button is only
 *     disabled by `operation`, so a tap starts `store.restore`; initialize
 *     lands and writes `operation: 'idle'`; the button re-enables while the
 *     restore is still in flight; a second tap calls `store.restore` again.
 *
 * Both are pinned inverted (`test.failing`) — they assert the EXPECTED
 * behaviour on 1fb0efd7 and must flip to plain `test` with the fix.
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
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
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

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDependencies() {
  const configureGate = deferred<void>();
  const restoreGates: ReturnType<typeof deferred<void>>[] = [];
  const deps: BillingAccessDependencies = {
    store: {
      configure: jest.fn(() => configureGate.promise),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_yearly',
        expirationDate: null,
      })),
      restore: jest.fn(() => {
        const gate = deferred<void>();
        restoreGates.push(gate);
        return gate.promise.then(() => ({
          premium: true,
          productId: 'pickle_sensei_pro_yearly',
          expirationDate: null,
        }));
      }),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => ({
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: null,
          verifiedAt: '2026-09-05T00:00:00.000Z',
        },
        access: {
          ...freeAccess,
          premium: true,
          entitlements: ['pickle_sensei_pro'],
          canStartRating: true,
          paywallRequired: false,
        },
      })),
    },
  };
  return { deps, configureGate, restoreGates };
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

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
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

describe('PaywallScreen × accessStore races', () => {
  test.failing(
    'I9 (sequential): a Settings refresh that completes before the first paywall visit still lets the paywall load plans',
    async () => {
      const { deps, configureGate } = makeDependencies();
      configureAccessStore(deps);
      configureGate.resolve();

      // Settings focus → refreshAccess() → 'ready' with plans null, before the
      // user ever hits the rating gate.
      await act(async () => {
        await useAccessStore.getState().refreshAccess();
      });
      expect(useAccessStore.getState().status).toBe('ready');
      expect(useAccessStore.getState().plans).toBeNull();

      const renderer = await renderPaywall();
      await openPricing(renderer);

      // Observed on 1fb0efd7: initialize() never fires (status !== 'idle'),
      // the store SDK is never configured, and the pricing page opens on the
      // fallback copy with a manual "Try again".
      const copy = allText(renderer);
      try {
        expect(deps.store.configure).toHaveBeenCalledTimes(1);
        expect(deps.store.loadPlans).toHaveBeenCalledTimes(1);
        expect(copy).toContain('$59.99');
        expect(copy).not.toContain('Store pricing unavailable');
        expect(
          renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
        ).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  test.failing(
    'I3: initialize() landing during a restore keeps the Restore button busy and never issues a second store.restore',
    async () => {
      const { deps, configureGate, restoreGates } = makeDependencies();
      configureAccessStore(deps);

      // Reach the paywall with a stalled initialize(): configure never
      // resolves, so status stays 'loading' and plans stay null. Paywall
      // auto-initializes (status was 'idle').
      const renderer = await renderPaywall();
      expect(deps.store.configure).toHaveBeenCalledTimes(1);
      expect(useAccessStore.getState().status).toBe('loading');
      await openPricing(renderer);

      try {
        // Restore is enabled (operation 'idle') → first tap.
        expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(
          false,
        );
        await act(async () => {
          pressable(renderer, 'paywall-restore').props.onPress();
        });
        await flush();
        expect(deps.store.restore).toHaveBeenCalledTimes(1);
        expect(useAccessStore.getState().operation).toBe('restoring');
        expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(
          true,
        );

        // initialize() lands (configure → getAccess + loadPlans) while the
        // restore is still in flight.
        await act(async () => {
          configureGate.resolve();
        });
        await flush();
        expect(useAccessStore.getState().plans).not.toBeNull();

        // EXPECTED: the mutex survives; the button stays disabled; a second
        // tap is a no-op. OBSERVED on 1fb0efd7: initialize() wrote
        // operation:'idle', the button re-enabled, and store.restore ran twice.
        expect(useAccessStore.getState().operation).toBe('restoring');
        expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(
          true,
        );
        await act(async () => {
          pressable(renderer, 'paywall-restore').props.onPress();
        });
        await flush();
        expect(deps.store.restore).toHaveBeenCalledTimes(1);
      } finally {
        for (const gate of restoreGates) gate.resolve();
        await flush();
        act(() => renderer.unmount());
      }
    },
  );
});
