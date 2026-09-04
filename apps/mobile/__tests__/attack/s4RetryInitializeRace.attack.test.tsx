/**
 * ADVERSARIAL S4 — "Retry loading membership" pressed three times while
 * initialize() is still pending must NOT re-enter the store: configure() and
 * getAccess() each exactly once.
 *
 * Two attack layers:
 *   UI  — render PaywallScreen with the FIRST initialize failing so the
 *         `paywall-retry` button exists, capture its onPress handler, then
 *         fire it 3× back-to-back while the retried initialize() is parked
 *         on store.configure(). (The button unmounts on the loading re-render,
 *         so the captured handler models touches queued before React commits
 *         — the realistic rapid-tap race.)
 *   store — initialize() ×3 concurrently from cold, plus a 50-call seeded
 *         interleaving of initialize()/refreshAccess() while parked.
 *
 * Expected: 1 configure, 1 getAccess for the retried cycle; the store lands
 * on status 'ready' with plans + access, and no error card.
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
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

const SEED = 0x5e7a1; // recorded; drives the interleaving order only
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

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
  lifetime: null,
};

interface Gate {
  release(): void;
  promise: Promise<void>;
}
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(r => (release = r));
  return { release, promise };
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

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('S4 triple Retry while initialize() is pending', () => {
  it('UI: 3 rapid retry presses → configure ×1, getAccess ×1 for the retried cycle', async () => {
    // Cycle 1 fails fast (backend down) so the retry button renders.
    // Cycle 2 parks on configure() so retries 2 and 3 land while pending.
    const configureGate = gate();
    let configureCalls = 0;
    const deps: BillingAccessDependencies = {
      store: {
        configure: jest.fn(async () => {
          configureCalls += 1;
          if (configureCalls >= 2) await configureGate.promise;
        }),
        loadPlans: jest.fn(async () => plans),
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
        getAccess: jest.fn(async () => {
          if (configureCalls === 1) {
            throw new BillingError(
              'billing.backend_unavailable',
              'Membership verification is temporarily unavailable.',
              true,
            );
          }
          return freeAccess;
        }),
        syncBilling: jest.fn(async () => {
          throw new Error('not exercised');
        }),
      },
    };
    configureAccessStore(deps);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
    });
    await flush();
    expect(useAccessStore.getState().status).toBe('error');
    expect(deps.store.configure).toHaveBeenCalledTimes(1);
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1);

    await act(async () => {
      pressable(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    const retry = pressable(renderer, 'paywall-retry');
    expect(retry.props.disabled).toBe(false);
    expect(retry.props.accessibilityLabel).toBe('Retry loading membership');

    // Three taps landing before React commits the loading re-render.
    const onPress = retry.props.onPress as () => void;
    await act(async () => {
      onPress();
      onPress();
      onPress();
    });
    expect(useAccessStore.getState().status).toBe('loading');
    expect(deps.store.configure).toHaveBeenCalledTimes(2); // cycle1 + ONE retry
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1); // retry parked on configure

    // While parked the retry button is gone (loading) — a 4th press is impossible.
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
    ).toHaveLength(0);

    configureGate.release();
    await flush();
    await flush();
    expect(deps.store.configure).toHaveBeenCalledTimes(2);
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(2); // cycle1 + retry
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(2);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.canonicalAccess).toEqual(freeAccess);
    expect(state.plans).toEqual(plans);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('store: initialize() ×3 concurrently from cold → configure ×1, getAccess ×1, loadPlans ×1', async () => {
    const configureGate = gate();
    const deps: BillingAccessDependencies = {
      store: {
        configure: jest.fn(async () => configureGate.promise),
        loadPlans: jest.fn(async () => plans),
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
        getAccess: jest.fn(async () => freeAccess),
        syncBilling: jest.fn(async () => {
          throw new Error('not exercised');
        }),
      },
    };
    configureAccessStore(deps);
    const { initialize } = useAccessStore.getState();
    const all = Promise.all([initialize(), initialize(), initialize()]);
    expect(useAccessStore.getState().status).toBe('loading');
    configureGate.release();
    await all;
    expect(deps.store.configure).toHaveBeenCalledTimes(1);
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('store: seeded 50-call initialize()/refreshAccess() storm while parked → initialize deduped; refreshAccess is NOT (documented)', async () => {
    const configureGate = gate();
    const deps: BillingAccessDependencies = {
      store: {
        configure: jest.fn(async () => configureGate.promise),
        loadPlans: jest.fn(async () => plans),
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
        getAccess: jest.fn(async () => freeAccess),
        syncBilling: jest.fn(async () => {
          throw new Error('not exercised');
        }),
      },
    };
    configureAccessStore(deps);
    const random = seeded(SEED);
    const { initialize, refreshAccess } = useAccessStore.getState();
    const pending: Promise<unknown>[] = [initialize()];
    const script: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      if (random() < 0.5) {
        script.push('initialize');
        pending.push(initialize());
      } else {
        script.push('refreshAccess');
        pending.push(refreshAccess());
      }
    }
    configureGate.release();
    await Promise.all(pending);
    const refreshCalls = script.filter(s => s === 'refreshAccess').length;
    expect(deps.store.configure).toHaveBeenCalledTimes(1);
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(1);
    // refreshAccess() has no in-flight guard: every call hits the backend.
    // (Callers in Settings/Analyze guard it themselves; the paywall never
    // calls it.) Recorded, not asserted as a defect of the Retry button.
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1 + refreshCalls);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(script).toHaveLength(50); // seed 0x5e7a1 recorded above
  });

  it('store interleaving: a refreshAccess() that settles while initialize() is parked flips status to ready and lets a second initialize() re-run configure()', async () => {
    const configureGate = gate();
    const deps: BillingAccessDependencies = {
      store: {
        configure: jest.fn(async () => configureGate.promise),
        loadPlans: jest.fn(async () => plans),
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
        getAccess: jest.fn(async () => freeAccess),
        syncBilling: jest.fn(async () => {
          throw new Error('not exercised');
        }),
      },
    };
    configureAccessStore(deps);
    const { initialize, refreshAccess } = useAccessStore.getState();
    const first = initialize();
    expect(useAccessStore.getState().status).toBe('loading');
    await refreshAccess(); // e.g. AnalyzeScreen unmount cleanup / Settings focus
    // The guard `if (status === 'loading') return` is now open again.
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans).toBeNull();
    const second = initialize();
    expect(deps.store.configure).toHaveBeenCalledTimes(2);
    configureGate.release();
    await Promise.all([first, second]);
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState().status).toBe('ready');
  });
});
