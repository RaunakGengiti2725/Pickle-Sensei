/**
 * Adjudication reproductions for area `mobile-billing-paywall` at 4d812e1a.
 *
 * Every test here was written independently of the auditor branches and is
 * phrased as the CURRENT (defective) behaviour so that it passes on the
 * baseline and starts FAILING once a fix lands. A fixer must invert the
 * assertions marked `BASELINE:` (see the acceptance criteria in the
 * adjudication report), not delete the test.
 *
 * MBP-1, MBP-2 and MBP-3 are FIXED: their cases below are inverted and now
 * pin the corrected behaviour (request-ordered canonicalAccess, initialize()
 * deduped only against itself, paywall dismiss controls disabled while a
 * store operation is in flight and no onPurchased after dismissal).
 *
 * Deliberately NOT reproduced here (rejected, see report):
 *  - fail-closed nulling of canonicalAccess on refresh/sync failure — pinned
 *    as intended behaviour by `accessStore.test.ts`;
 *  - RevenueCat "numeric cancel code" shapes — the installed SDK (10.8.1)
 *    bridge rejects with a STRING code and sets `userCancelled` itself.
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
  RevenueCatPackageLike,
  RevenueCatSdk,
  StorePlans,
} from '../../src/billing';
import {
  createCanonicalAccessClient,
  createRevenueCatBillingClient,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { freeRatingAllowanceCopy } from '../../src/screens/paywallCopy';

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

function dependencies(options?: {
  getAccess?: () => Promise<CanonicalAccessState>;
  purchase?: BillingAccessDependencies['store']['purchase'];
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
}): BillingAccessDependencies {
  const entitlement = {
    premium: true,
    productId: 'pickle_sensei_pro_yearly',
    expirationDate: '2027-09-04T00:00:00.000Z',
  };
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(options?.purchase ?? (async () => entitlement)),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(options?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(
        options?.syncBilling ??
          (async () => ({
            billing: {
              premium: true,
              productKey: 'pickle_sensei_pro_yearly',
              expiresAt: '2027-09-04T00:00:00.000Z',
              verifiedAt: '2026-09-04T00:00:00.000Z',
            },
            access: paidAccess,
          })),
      ),
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

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('MBP-1 stale refreshAccess GET overwrites a verified purchase', () => {
  it('FIXED: a slow in-flight GET /v1/me/access that started before the purchase never reverts premium to free', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    let calls = 0;
    const clients = dependencies({
      getAccess: () =>
        ++calls === 2 ? slowGet.promise : Promise.resolve(freeAccess),
    });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    // Settings focus / Analyze unmount fires refreshAccess(); the request stalls.
    const staleRefresh = useAccessStore.getState().refreshAccess();

    // Meanwhile the user buys on the paywall and the backend verifies it.
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    // The stale response lands last and is discarded: it began before the
    // backend-verified purchase snapshot landed.
    slowGet.resolve(freeAccess);
    await expect(staleRefresh).resolves.toBe(true);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
    expect(state.canonicalAccess?.paywallRequired).toBe(false);
    expect(state.canonicalAccess?.canStartRating).toBe(true);
  });

  it('FIXED: refreshAccess started before restore never clobbers the restored premium', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    let calls = 0;
    configureAccessStore(
      dependencies({
        getAccess: () =>
          ++calls === 2 ? slowGet.promise : Promise.resolve(freeAccess),
      }),
    );
    await useAccessStore.getState().initialize();
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    slowGet.resolve(freeAccess);
    await staleRefresh;
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
  });
});

describe('MBP-2 initialize() is starved by an in-flight refreshAccess()', () => {
  it('FIXED: Settings-first refresh no longer starves initialize(); plans load exactly once', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    let calls = 0;
    const clients = dependencies({
      getAccess: () =>
        ++calls === 1 ? slowGet.promise : Promise.resolve(freeAccess),
    });
    configureAccessStore(clients);

    // SettingsScreen.useFocusEffect: status is 'idle' (not 'loading') so it refreshes.
    expect(useAccessStore.getState().status).toBe('idle');
    const refresh = useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('loading');

    // User taps Membership → PaywallScreen mounts → initialize() must still
    // configure the store and load plans even though a refresh is in flight.
    const initialize = useAccessStore.getState().initialize();
    // A second concurrent initialize() (route gate + paywall) is deduped.
    await Promise.all([initialize, useAccessStore.getState().initialize()]);
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().plans).toEqual(plans);

    slowGet.resolve(freeAccess);
    await refresh;
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(freeAccess);
    expect(state.plans).toEqual(plans);
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
  });

  it('FIXED: PaywallScreen mounted in that state loads store pricing and shows the plan columns', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    const clients = dependencies({ getAccess: () => slowGet.promise });
    configureAccessStore(clients);
    const refresh = useAccessStore.getState().refreshAccess();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
    });
    await flush();
    slowGet.resolve(freeAccess);
    await act(async () => {
      await refresh;
    });
    await flush();

    expect(useAccessStore.getState().status).toBe('ready');
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().plans).toEqual(plans);
    await act(async () => {
      pressable(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-plan-annual'),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
    ).toHaveLength(0);
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $59.99/yr');
    // Only the two paywall buttons may reach StoreKit; mounting never does.
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('MBP-3 Close stays enabled during purchase; onPurchased fires after dismissal', () => {
  it('FIXED: close/back are disabled while purchasing and a late verification never fires onPurchased after onClose', async () => {
    const storePurchase = deferred<{
      premium: boolean;
      productId: string | null;
      expirationDate: string | null;
    }>();
    const clients = dependencies({ purchase: () => storePurchase.promise });
    configureAccessStore(clients);
    const onClose = jest.fn();
    const onPurchased = jest.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen onClose={onClose} onPurchased={onPurchased} />,
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
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(true);

    const close = byLabel(renderer, 'Close membership offer');
    const back = pressable(renderer, 'paywall-back');
    expect(close.props.disabled).toBe(true);
    expect(back.props.disabled).toBe(true);

    // Should the paywall still be dismissed mid-purchase (RootNavigator →
    // navigation.goBack()), the dismissal itself is honoured once…
    await act(async () => {
      close.props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // …and when the store then completes and the backend verifies, the store
    // state still becomes premium but the dismissed screen must NOT fire the
    // success callback (RootNavigator would run a SECOND navigation.goBack()).
    storePurchase.resolve({
      premium: true,
      productId: 'pickle_sensei_pro_yearly',
      expirationDate: null,
    });
    await flush();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(onPurchased).toHaveBeenCalledTimes(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('FIXED: a purchase that verifies after the screen unmounted updates the store but not the navigator', async () => {
    const storePurchase = deferred<{
      premium: boolean;
      productId: string | null;
      expirationDate: string | null;
    }>();
    const clients = dependencies({ purchase: () => storePurchase.promise });
    configureAccessStore(clients);
    const onClose = jest.fn();
    const onPurchased = jest.fn();

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen onClose={onClose} onPurchased={onPurchased} />,
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
    expect(useAccessStore.getState().operation).toBe('purchasing');

    act(() => renderer.unmount());
    storePurchase.resolve({
      premium: true,
      productId: 'pickle_sensei_pro_yearly',
      expirationDate: null,
    });
    await flush();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(onPurchased).toHaveBeenCalledTimes(0);
    expect(onClose).toHaveBeenCalledTimes(0);
  });
});

describe('MBP-4 Android free-trial phase type mismatch (non-shipping platform)', () => {
  const CANONICAL_USER_ID = '2f5d1f0e-4a4c-4f38-9d3e-0f6b6a1a2b3c';

  function androidPackage(): RevenueCatPackageLike {
    return {
      identifier: '$rc_annual',
      packageType: 'ANNUAL',
      product: {
        identifier: 'pickle_sensei_pro_yearly',
        price: 59.99,
        priceString: '$59.99',
        pricePerMonthString: '$5.00',
        introPrice: null,
        defaultOption: {
          // Shape emitted by react-native-purchases 10.8.1 on Android:
          // PricingPhase.billingPeriod is a Period object, not an ISO string.
          freePhase: {
            billingPeriod: {
              unit: 'DAY',
              value: 7,
              iso8601: 'P7D',
            } as unknown as string,
            billingCycleCount: 1,
            price: { amountMicros: 0 },
          },
        },
      },
    };
  }

  function sdk(): RevenueCatSdk {
    let appUserId = CANONICAL_USER_ID;
    return {
      isConfigured: async () => false,
      configure: async input => {
        appUserId = input.appUserID;
      },
      getAppUserID: async () => appUserId,
      logIn: async id => {
        appUserId = id;
      },
      getOfferings: async () => ({
        current: {
          identifier: 'default',
          annual: androidPackage(),
          monthly: null,
          lifetime: null,
        },
      }),
      purchasePackage: async () => {
        throw new Error('not exercised');
      },
      restorePurchases: async () => {
        throw new Error('not exercised');
      },
      getCustomerInfo: async () => {
        throw new Error('not exercised');
      },
      checkTrialOrIntroductoryPriceEligibility: async () => ({}),
    };
  }

  it('BASELINE: loadPlans throws TypeError on the SDK Period object instead of rendering the trial', async () => {
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'test_key', canonicalAppUserId: CANONICAL_USER_ID },
      sdk(),
      'android',
    );
    await expect(client.loadPlans()).rejects.toThrow(TypeError); // FIX: resolves with a 7-day trial
  });
});

describe('MBP-5 billing requests carry no AbortSignal / timeout', () => {
  it('BASELINE: fetchFn receives no signal so a stalled GET keeps the store in loading forever', async () => {
    const stalled = deferred<Response>();
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
      () => stalled.promise,
    );
    const client = createCanonicalAccessClient({
      baseUrl: 'https://example.invalid',
      token: 'access-token',
      fetchFn,
    });
    const pending = client.getAccess();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.signal).toBeUndefined(); // FIX: an AbortSignal with a bounded timeout
    // Other API clients in this app (account/bootstrap.ts, progress/api.ts) do bound their requests.
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    stalled.reject(new Error('teardown'));
    await pending.catch(() => undefined);
  });
});

describe('P3 candidates (deferred, reproduced for the record)', () => {
  it('BASELINE: freeRatingAllowanceCopy says "1 free rating remain" when one capture is reserved', () => {
    expect(
      freeRatingAllowanceCopy({
        ...freeAccess,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 1,
          remaining: 1,
          availableToReserve: 0,
        },
        canStartRating: false,
        paywallRequired: false,
      }),
    ).toBe('1 free rating remain, but 1 capture is still being finalized.'); // FIX: "remains"
  });
});
