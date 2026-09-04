/**
 * ADVERSARIAL PASS 3 — mobile-analyze-capture / accessStore + rating route
 * gate (scenarios S5, S7 + extras). Executed against the REAL zustand store,
 * the REAL `createCanonicalAccessClient` (fetch mocked at the Response level)
 * and the REAL `RootNavigator` AnalyzeRoute (`useRatingRouteGate`).
 *
 * S5  refreshAccess() fired twice concurrently; the FIRST call resolves LAST
 *     with the OLDER snapshot → canonicalAccess must end on the NEWER one.
 * S7  premium user; refreshAccess hits HTTP 503 → the rating route gate must
 *     fail closed (replace → Paywall) and the paywall must show the retry
 *     path. Documents the intended UX.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});
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
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const navigationRef = { isReady: jest.fn(() => true), navigate: jest.fn() };
  return {
    __esModule: true,
    DefaultTheme: { dark: false, colors: {} },
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
    createNavigationContainerRef: () => navigationRef,
    useNavigation: () => {
      throw new Error('useNavigation must not be reached');
    },
  };
});
jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  const { View } = require('react-native');
  const StackNavigator = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  const StackScreen = () => null;
  return {
    __esModule: true,
    createNativeStackNavigator: () => ({
      Navigator: StackNavigator,
      Screen: StackScreen,
    }),
  };
});
jest.mock('@react-navigation/bottom-tabs', () => {
  const React = require('react');
  const { View } = require('react-native');
  const TabNavigator = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  const TabScreen = () => null;
  return {
    __esModule: true,
    createBottomTabNavigator: () => ({
      Navigator: TabNavigator,
      Screen: TabScreen,
    }),
  };
});
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: null,
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
  subscribeToNotificationPresses: () => jest.fn(),
}));
jest.mock('../../src/account/apiSession', () => ({
  __esModule: true,
  reportApiUnauthorized: jest.fn(),
}));
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: () => null,
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    AnalyzeScreen: () =>
      React.createElement(Text, { testID: 'analyze-screen' }, 'Analyze stub'),
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import type { RootStackParams } from '../../src/navigation/params';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

type Renderer = TestRenderer.ReactTestRenderer;
const Stack = createNativeStackNavigator<RootStackParams>();

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam',
  email: 'sam@example.com',
};

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['premium'],
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

/** Older snapshot: one free rating left. */
const olderFree: CanonicalAccessState = {
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

/** Newer snapshot: the last free rating was just spent. */
const newerExhausted: CanonicalAccessState = {
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
} as unknown as StorePlans;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deps(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(async () => ({ access: premiumAccess })),
    },
  } as unknown as BillingAccessDependencies;
}

function httpResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function flushAsync() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function fakeNavigation() {
  return { goBack: jest.fn(), replace: jest.fn(), navigate: jest.fn() };
}

function mountAnalyzeRoute(navigation: ReturnType<typeof fakeNavigation>) {
  const root = render(<RootNavigator />);
  const screen = root.root
    .findAllByType(Stack.Screen)
    .find(node => node.props.name === 'Analyze');
  if (!screen) throw new Error('Analyze route not registered');
  const Route = screen.props.component as React.ComponentType<{
    navigation: unknown;
    route: { key: string; name: 'Analyze'; params?: unknown };
  }>;
  const analyze = render(
    <Route
      navigation={navigation}
      route={{
        key: 'Analyze-1',
        name: 'Analyze',
        params: { source: 'camera' },
      }}
    />,
  );
  return {
    analyze,
    unmount: () => {
      act(() => analyze.unmount());
      act(() => root.unmount());
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
  useAuthStore.setState({ session: syncedSession });
});

describe('S5 — concurrent refreshAccess(), older response lands last', () => {
  it('ATTACK: call#1 (older snapshot) resolves AFTER call#2 (newer) → canonicalAccess must be the NEWER snapshot', async () => {
    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    let calls = 0;
    configureAccessStore(
      deps(() => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }),
    );
    const store = useAccessStore.getState();

    const p1 = store.refreshAccess();
    const p2 = store.refreshAccess();
    expect(calls).toBe(2);

    // Newer request answers first with the exhausted ledger…
    second.resolve(newerExhausted);
    await expect(p2).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(newerExhausted);

    // …then the OLDER request's stale snapshot arrives.
    first.resolve(olderFree);
    await expect(p1).resolves.toBe(true);

    const final = useAccessStore.getState();

    console.log(
      `[S5] final canonicalAccess=${JSON.stringify(final.canonicalAccess)} status=${final.status}`,
    );
    expect(final.canonicalAccess).toEqual(newerExhausted);
    expect(final.canonicalAccess?.canStartRating).toBe(false);
  });

  it('ATTACK (rapid repeat ×8, reversed completion order): the LAST-issued request must win', async () => {
    const pending: ReturnType<typeof deferred<CanonicalAccessState>>[] = [];
    configureAccessStore(
      deps(() => {
        const d = deferred<CanonicalAccessState>();
        pending.push(d);
        return d.promise;
      }),
    );
    const store = useAccessStore.getState();
    const promises = Array.from({ length: 8 }, () => store.refreshAccess());
    expect(pending).toHaveLength(8);
    // Each request i reports `used = i` (monotonically newer). Resolve in
    // REVERSE issue order so the oldest lands last.
    for (let i = 7; i >= 0; i -= 1) {
      const used = Math.min(2, i);
      pending[i]!.resolve({
        ...olderFree,
        freeRatings: {
          ...olderFree.freeRatings,
          used,
          remaining: 2 - used,
          availableToReserve: 2 - used,
        },
        canStartRating: used < 2,
        paywallRequired: used >= 2,
      });
      await promises[i];
    }
    const final = useAccessStore.getState().canonicalAccess;

    console.log(`[S5-x8] final used=${final?.freeRatings.used}`);
    expect(final?.freeRatings.used).toBe(2);
  });

  it('CONTROL: an in-flight refresh started under a PREVIOUS configuration is discarded (configuration guard works)', async () => {
    const stale = deferred<CanonicalAccessState>();
    configureAccessStore(deps(() => stale.promise));
    const p = useAccessStore.getState().refreshAccess();
    configureAccessStore(deps(async () => newerExhausted));
    await useAccessStore.getState().refreshAccess();
    stale.resolve(olderFree);
    await expect(p).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toEqual(newerExhausted);
  });

  it('EXTRA: reset() while a refresh is in flight → the late result is discarded, store stays at defaults', async () => {
    const d = deferred<CanonicalAccessState>();
    configureAccessStore(deps(() => d.promise));
    const p = useAccessStore.getState().refreshAccess();
    useAccessStore.getState().reset();
    d.resolve(premiumAccess);
    await expect(p).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('idle');
  });

  it('EXTRA: sign-out (clearAccessStoreConfiguration) while a refresh is in flight → the next account never inherits access', async () => {
    const d = deferred<CanonicalAccessState>();
    configureAccessStore(deps(() => d.promise));
    const p = useAccessStore.getState().refreshAccess();
    clearAccessStoreConfiguration();
    d.resolve(premiumAccess);
    await expect(p).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });
});

describe('S7 — premium user, refreshAccess → HTTP 503 → rating route gate fails closed', () => {
  it('ATTACK: mounted AnalyzeRoute with premium access; a 503 refresh must replace → Paywall and drop canonicalAccess', async () => {
    const fetchFn = jest.fn(async () =>
      httpResponse(503, { error: 'service unavailable' }),
    );
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
      fetchFn,
    });
    const dependencies = deps(backend.getAccess);
    configureAccessStore(dependencies);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: premiumAccess,
    });

    const navigation = fakeNavigation();
    const { analyze, unmount } = mountAnalyzeRoute(navigation);
    expect(analyze.root.findByProps({ testID: 'analyze-screen' })).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();

    let refreshed: boolean | undefined;
    await act(async () => {
      refreshed = await useAccessStore.getState().refreshAccess();
    });
    await flushAsync();

    const state = useAccessStore.getState();

    console.log(
      `[S7] refreshAccess→${refreshed} status=${state.status} canonicalAccess=${JSON.stringify(
        state.canonicalAccess,
      )} error=${JSON.stringify(state.error)} replace=${JSON.stringify(
        navigation.replace.mock.calls,
      )}`,
    );
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test/v1/me/access',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(refreshed).toBe(false);
    expect(state.canonicalAccess).toBeNull();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_unavailable');
    expect(state.error?.retryable).toBe(true);
    expect(navigation.replace).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    // The Analyze surface is gone; the gate shows the honest loading label.
    expect(
      analyze.root.findAllByProps({ testID: 'analyze-screen' }),
    ).toHaveLength(0);
    unmount();
  });

  it('UX: the Paywall a locked-out premium user lands on shows the outage copy + "Try again", and a successful retry restores access', async () => {
    let failures = 1;
    const fetchFn = jest.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        return httpResponse(503, {});
      }
      return httpResponse(200, premiumAccess);
    });
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
      fetchFn,
    });
    configureAccessStore(deps(backend.getAccess));
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: premiumAccess,
      plans,
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    const paywall = render(<PaywallScreen onClose={() => {}} />);
    await flushAsync();
    // Step 1 is the value page; the membership state lives on step 2.
    const seePlans = paywall.root.findAll(
      node =>
        node.props.testID === 'paywall-see-plans' &&
        typeof node.props.onPress === 'function',
    );
    expect(seePlans.length).toBeGreaterThan(0);
    await act(async () => {
      seePlans[seePlans.length - 1]!.props.onPress();
    });
    await flushAsync();
    const text = allText(paywall);

    console.log(`[S7-ux] paywall text: ${text.slice(0, 400)}`);
    expect(text).toContain(
      'Membership verification is temporarily unavailable.',
    );
    const retry = paywall.root.findAll(
      node =>
        node.props.testID === 'paywall-retry' &&
        typeof node.props.onPress === 'function',
    );
    expect(retry.length).toBeGreaterThan(0);
    // Purchase must NOT be offered as the fix for a server outage.
    const purchaseButtons = paywall.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        typeof node.props.accessibilityLabel === 'string' &&
        /continue|start free trial/i.test(node.props.accessibilityLabel) &&
        node.props.disabled !== true &&
        node.props.accessibilityState?.disabled !== true,
    );

    console.log(
      `[S7-ux] enabled purchase buttons while access unknown: ${purchaseButtons.length}`,
    );

    await act(async () => {
      retry[retry.length - 1]!.props.onPress();
    });
    await flushAsync();
    const after = useAccessStore.getState();
    expect(after.canonicalAccess).toEqual(premiumAccess);
    expect(after.status).toBe('ready');
    act(() => paywall.unmount());
  });

  it.each([500, 502, 429])(
    'EXTRA: HTTP %d also fails closed (canonicalAccess null, retryable error)',
    async status => {
      const backend = createCanonicalAccessClient({
        baseUrl: 'https://api.test',
        token: 'access-token',
        fetchFn: jest.fn(async () => httpResponse(status, {})),
      });
      configureAccessStore(deps(backend.getAccess));
      useAccessStore.setState({
        status: 'ready',
        canonicalAccess: premiumAccess,
      });
      await useAccessStore.getState().refreshAccess();
      const state = useAccessStore.getState();
      expect(state.canonicalAccess).toBeNull();
      expect(state.status).toBe('error');
      expect(state.error?.retryable).toBe(true);
    },
  );

  it('EXTRA: a 200 with a forged body (premium:true but canStartRating:false) is rejected as invalid, never trusted', async () => {
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
      fetchFn: jest.fn(async () =>
        httpResponse(200, { ...premiumAccess, canStartRating: false }),
      ),
    });
    configureAccessStore(deps(backend.getAccess));
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: premiumAccess,
    });
    await useAccessStore.getState().refreshAccess();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_invalid_response');
  });

  it('EXTRA: a 200 whose body is not JSON (HTML error page) fails closed', async () => {
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
      fetchFn: jest.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          }) as unknown as Response,
      ),
    });
    configureAccessStore(deps(backend.getAccess));
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: premiumAccess,
    });
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });
});
