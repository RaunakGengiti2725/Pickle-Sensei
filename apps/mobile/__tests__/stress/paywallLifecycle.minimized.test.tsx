/**
 * Minimized, deterministic replays of the interleavings the seeded campaign
 * (paywallLifecycle.stress.test.tsx) found. Each `it` is the shortest schedule
 * that reproduces one seed's failure, written against the REAL PaywallScreen,
 * REAL accessStore / billing clients and (where the navigator matters) the
 * REAL RootNavigator, with only native modules and fetch replaced.
 *
 *   F1  seed 1065146965 / 1022710107 / 2123626214 (I4):
 *       tapping "Restore purchases" while the paywall is still loading, then
 *       letting initialize() finish, flips accessStore.operation back to
 *       'idle' although the StoreKit restore is still in flight — the
 *       Continue / Restore buttons re-enable mid-operation.
 *   F2  seed 1797730804 / 2068844899 (I5/I8):
 *       closing the paywall while a purchase is being verified makes the
 *       verified purchase call navigation.goBack() from the popped route.
 *       GO_BACK carries the stale route as `source` but no `target`, so
 *       StackRouter pops whatever is on top of the stack now — the screen
 *       the user navigated to afterwards disappears (or, with nothing above
 *       Home, React Navigation logs an unhandled GO_BACK dev error).
 *
 * These tests encode the EXPECTED behaviour and therefore fail on 1fb0efd7.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
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
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
    withDelay: (_delay: number, value: unknown) => value,
  };
});
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: { provider: 'apple', localOnly: false },
    busy: false,
    error: null,
    signInWithApple: jest.fn(async () => undefined),
    signInWithGoogle: jest.fn(async () => undefined),
    clearError: jest.fn(),
  }));
  return { __esModule: true, useAuthStore };
});
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: jest.fn(() => jest.fn()),
}));
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  const HomeScreen = () => {
    const navigation = useNavigation();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Text, null, 'HOME_STUB'),
      React.createElement(
        Pressable,
        {
          testID: 'home-open-paywall',
          onPress: () => navigation.navigate('Paywall', { source: 'settings' }),
        },
        React.createElement(Text, null, 'paywall'),
      ),
      React.createElement(
        Pressable,
        {
          testID: 'home-open-drills',
          onPress: () => navigation.navigate('DrillLibrary'),
        },
        React.createElement(Text, null, 'drills'),
      ),
    );
  };
  return { __esModule: true, HomeScreen };
});
jest.mock('../../src/screens/DrillLibraryScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const DrillLibraryScreen = () =>
    React.createElement(Text, null, 'DRILLS_STUB');
  return { __esModule: true, DrillLibraryScreen };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  __esModule: true,
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  __esModule: true,
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  __esModule: true,
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  __esModule: true,
  AnalyzeScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  __esModule: true,
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  __esModule: true,
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  __esModule: true,
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  __esModule: true,
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  __esModule: true,
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  __esModule: true,
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  __esModule: true,
  NotificationSettingsScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  __esModule: true,
  SignInScreen: () => null,
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createBillingAccessDependencies,
  type BillingFetch,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { deferred, type Deferred } from '../../testing/xcBehavioral/deferred';

const API_BASE_URL = 'https://api.example.test/functions/v1/api';
const USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';

function accessPayload(premium: boolean) {
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: {
      limit: 2,
      used: 2,
      reserved: 0,
      remaining: 0,
      availableToReserve: 0,
    },
    canStartRating: premium,
    paywallRequired: !premium,
  };
}

function syncPayload(premium: boolean) {
  return {
    billing: {
      premium,
      productKey: premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: accessPayload(premium),
  };
}

const annual: RevenueCatPackageLike = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: {
    identifier: 'pickle_sensei_pro_annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    introPrice: null,
    defaultOption: null,
  },
};

function customerInfo(premium: boolean): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            pickle_sensei_pro: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: null,
            },
          }
        : {},
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface Backdoor {
  offerings: Deferred<Awaited<ReturnType<RevenueCatSdk['getOfferings']>>>;
  access: Deferred<Response>;
  restore: Deferred<RevenueCatCustomerInfoLike>;
  purchase: Deferred<{ customerInfo: RevenueCatCustomerInfoLike }>;
  sync: Deferred<Response>;
  syncRequests: number;
}

/** Real billing clients over a controllable store SDK and backend. */
function installSession(): Backdoor {
  const backdoor: Backdoor = {
    offerings: deferred(),
    access: deferred(),
    restore: deferred(),
    purchase: deferred(),
    sync: deferred(),
    syncRequests: 0,
  };
  const sdk: RevenueCatSdk = {
    isConfigured: async () => false,
    configure: () => undefined,
    getAppUserID: async () => USER_ID,
    logIn: async () => ({}),
    getOfferings: () => backdoor.offerings.promise,
    purchasePackage: () => backdoor.purchase.promise,
    restorePurchases: () => backdoor.restore.promise,
    getCustomerInfo: async () => customerInfo(false),
    checkTrialOrIntroductoryPriceEligibility: async () => ({}),
  };
  const fetchFn: BillingFetch = async (input, init) => {
    if (input === `${API_BASE_URL}/v1/me/access` && init?.method === 'GET') {
      return backdoor.access.promise;
    }
    if (
      input === `${API_BASE_URL}/v1/billing/sync` &&
      init?.method === 'POST'
    ) {
      backdoor.syncRequests += 1;
      return backdoor.sync.promise;
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${input}`);
  };
  establishApiSession({
    apiBaseUrl: API_BASE_URL,
    bearerToken: 'bearer-A-1',
    canonicalAppUserId: USER_ID,
    provider: 'apple',
    refreshToken: 'refresh-A',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: getRuntimePublicConfig().revenueCatPublicSdkKey,
      canonicalAppUserId: USER_ID,
      apiBaseUrl: API_BASE_URL,
      get apiToken() {
        return bearerTokenFor(USER_ID);
      },
      fetchFn,
      revenueCatSdk: sdk,
      platform: 'ios',
    }),
  );
  return backdoor;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function tap(node: TestRenderer.ReactTestInstance | null) {
  expect(node).not.toBeNull();
  expect(node!.props.disabled).not.toBe(true);
  await act(async () => {
    (node!.props.onPress as () => void)();
  });
  await flush();
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (renderer) {
    const current = renderer;
    renderer = null;
    await act(async () => current.unmount());
  }
  clearAccessStoreConfiguration();
  clearApiSession();
  consoleErrorSpy.mockRestore();
});

describe('F1 — restore tapped while the paywall is still loading (seed 1065146965 minimized)', () => {
  it('keeps operation=restoring (buttons disabled) until StoreKit answers, even after initialize() completes (BROKEN on 1fb0efd7)', async () => {
    const backdoor = installSession();
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen
          onClose={() => undefined}
          onPurchased={() => undefined}
        />,
      );
    });
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    // Offerings arrive first; access is still pending, so status stays loading.
    await act(async () => {
      backdoor.offerings.resolve({
        current: {
          identifier: 'default',
          annual,
          monthly: null,
          lifetime: null,
        },
      });
    });
    await flush();
    await tap(pressable(renderer!, 'paywall-see-plans'));
    expect(useAccessStore.getState().status).toBe('loading');

    // The restore button is enabled while loading — the user taps it.
    await tap(pressable(renderer!, 'paywall-restore'));
    expect(useAccessStore.getState().operation).toBe('restoring');
    expect(pressable(renderer!, 'paywall-restore')?.props.disabled).toBe(true);

    // initialize() now completes while StoreKit restore is still in flight.
    await act(async () => {
      backdoor.access.resolve(jsonResponse(200, accessPayload(false)));
    });
    await flush();
    expect(backdoor.restore.settled).toBe(false);
    expect(useAccessStore.getState().status).toBe('ready');

    // Expected: still restoring. Observed on 1fb0efd7: 'idle' — initialize()
    // writes operation:'idle' unconditionally (accessStore.ts:169), and the
    // Continue / Restore buttons re-enable while the App Store sheet is up.
    expect(useAccessStore.getState().operation).toBe('restoring');
    expect(pressable(renderer!, 'paywall-restore')?.props.disabled).toBe(true);
    expect(pressable(renderer!, 'paywall-continue')?.props.disabled).toBe(true);
  });

  it('never lets a purchase start while a restore is still at the store (BROKEN on 1fb0efd7)', async () => {
    const backdoor = installSession();
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen
          onClose={() => undefined}
          onPurchased={() => undefined}
        />,
      );
    });
    await flush();
    await act(async () => {
      backdoor.offerings.resolve({
        current: {
          identifier: 'default',
          annual,
          monthly: null,
          lifetime: null,
        },
      });
    });
    await flush();
    await tap(pressable(renderer!, 'paywall-see-plans'));
    await tap(pressable(renderer!, 'paywall-restore'));
    await act(async () => {
      backdoor.access.resolve(jsonResponse(200, accessPayload(false)));
    });
    await flush();

    const continueButton = pressable(renderer!, 'paywall-continue');
    if (continueButton && continueButton.props.disabled !== true) {
      await tap(continueButton);
    }
    // Expected: purchasePackage is never called while restorePurchases is
    // pending. Observed: both StoreKit operations run concurrently.
    expect(backdoor.restore.settled).toBe(false);
    expect(useAccessStore.getState().operation).toBe('restoring');
  });
});

describe('F2 — paywall closed while the purchase is being verified (seed 1797730804 minimized)', () => {
  async function driveToPendingSync(): Promise<Backdoor> {
    const backdoor = installSession();
    await act(async () => {
      renderer = TestRenderer.create(<RootNavigator />);
    });
    await flush();
    await tap(pressable(renderer!, 'home-open-paywall'));
    await act(async () => {
      backdoor.offerings.resolve({
        current: {
          identifier: 'default',
          annual,
          monthly: null,
          lifetime: null,
        },
      });
      backdoor.access.resolve(jsonResponse(200, accessPayload(false)));
    });
    await flush();
    await tap(pressable(renderer!, 'paywall-see-plans'));
    await tap(pressable(renderer!, 'paywall-continue'));
    expect(useAccessStore.getState().operation).toBe('purchasing');
    // StoreKit confirms; the backend verification (sync) is now in flight.
    await act(async () => {
      backdoor.purchase.resolve({ customerInfo: customerInfo(true) });
    });
    await flush();
    expect(backdoor.syncRequests).toBe(1);
    // The close button is enabled during verification; the user leaves.
    await tap(byLabel(renderer!, 'Close membership offer'));
    expect(texts(renderer!)).toContain('HOME_STUB');
    return backdoor;
  }

  it('does not pop the screen the user navigated to afterwards (BROKEN on 1fb0efd7)', async () => {
    const backdoor = await driveToPendingSync();
    await tap(pressable(renderer!, 'home-open-drills'));
    expect(texts(renderer!)).toContain('DRILLS_STUB');
    await act(async () => {
      backdoor.sync.resolve(jsonResponse(200, syncPayload(true)));
    });
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // Expected: Drill Library is still on screen. Observed on 1fb0efd7: the
    // paywall's onPurchased -> navigation.goBack() pops Drill Library.
    expect(texts(renderer!)).toContain('DRILLS_STUB');
  });

  it('does not dispatch goBack from the already-popped paywall route (BROKEN on 1fb0efd7)', async () => {
    const backdoor = await driveToPendingSync();
    await act(async () => {
      backdoor.sync.resolve(jsonResponse(200, syncPayload(true)));
    });
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // Expected: no navigation action from an unmounted paywall. Observed on
    // 1fb0efd7: React Navigation logs "The action 'GO_BACK' was not handled
    // by any navigator" (dev-only; a production no-op).
    const goBackErrors = consoleErrorSpy.mock.calls.filter(call =>
      String(call[0]).includes("The action 'GO_BACK' was not handled"),
    );
    expect(goBackErrors).toHaveLength(0);
  });
});
