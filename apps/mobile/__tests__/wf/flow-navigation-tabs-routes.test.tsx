/**
 * navigation-tabs workflow: RootNavigator route integrity. Renders the real
 * RootNavigator against stub navigators so we can assert that every route in
 * src/navigation/params.ts is registered exactly once, that the Analyze /
 * Paywall / ConnectAccount route wrappers replace or pop the way the user
 * expects (including the local-only, no-entitlement, and access-error
 * branches), and that a pressed reminder routes into the Tabs navigator.
 */
import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { AccessStoreState } from '../../src/state/accessStore';
import type { CanonicalAccessState } from '../../src/billing/types';
import { ErrorState } from '../../src/design/components';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockRefNavigate = jest.fn();
const mockRefReady = jest.fn(() => true);
const mockRouteContext = React.createContext<{
  key: string;
  name: keyof RootStackParams;
  params: unknown;
} | null>(null);

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      React.createElement('NavigationContainer', null, props.children),
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
    useRoute: () => React.useContext(mockRouteContext),
    // The ref is created at RootNavigator module scope, so forward lazily.
    createNavigationContainerRef: () => ({
      isReady: () => mockRefReady(),
      navigate: (...args: unknown[]) => mockRefNavigate(...args),
    }),
  };
});
jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: (props: { children?: React.ReactNode }) =>
        React.createElement('StackNavigator', null, props.children),
      Screen: (props: Record<string, unknown>) =>
        React.createElement('StackScreen', props),
    }),
  };
});
jest.mock('@react-navigation/bottom-tabs', () => {
  const React = require('react');
  return {
    createBottomTabNavigator: () => ({
      Navigator: (props: { children?: React.ReactNode }) =>
        React.createElement('TabNavigator', null, props.children),
      Screen: (props: Record<string, unknown>) =>
        React.createElement('TabScreen', props),
    }),
  };
});

// Screens are out of scope here; jest.fn stubs that record their props let
// the route wrappers' callbacks be exercised without any native imports.
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: jest.fn(() => {
    const React = require('react');
    const { useRoute } = require('@react-navigation/native');
    return React.createElement('AnalyzeScreen', { route: useRoute() });
  }),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: jest.fn(() => null),
}));

type ScreenStub = jest.Mock<
  React.ReactElement | null,
  [Record<string, unknown>]
>;
function stub<Name extends string>(module: string, name: Name): ScreenStub {
  return (jest.requireMock(module) as Record<Name, ScreenStub>)[name];
}
const mockScreens = {
  HomeScreen: stub('../../src/screens/HomeScreen', 'HomeScreen'),
  LibraryScreen: stub('../../src/screens/LibraryScreen', 'LibraryScreen'),
  ProgressScreen: stub('../../src/screens/ProgressScreen', 'ProgressScreen'),
  SettingsScreen: stub('../../src/screens/SettingsScreen', 'SettingsScreen'),
  AnalyzeScreen: stub('../../src/screens/AnalyzeScreen', 'AnalyzeScreen'),
  DrillLibraryScreen: stub(
    '../../src/screens/DrillLibraryScreen',
    'DrillLibraryScreen',
  ),
  ResultScreen: stub('../../src/screens/ResultScreen', 'ResultScreen'),
  ResultDetailsScreen: stub(
    '../../src/screens/ResultDetailsScreen',
    'ResultDetailsScreen',
  ),
  FormReviewScreen: stub(
    '../../src/screens/FormReviewScreen',
    'FormReviewScreen',
  ),
  StreakCalendarScreen: stub(
    '../../src/screens/StreakCalendarScreen',
    'StreakCalendarScreen',
  ),
  PaywallScreen: stub('../../src/screens/PaywallScreen', 'PaywallScreen'),
  SignInScreen: stub('../../src/screens/SignInScreen', 'SignInScreen'),
  ManageAccountScreen: stub(
    '../../src/screens/ManageAccountScreen',
    'ManageAccountScreen',
  ),
  ConsentSettingsScreen: stub(
    '../../src/screens/ConsentSettingsScreen',
    'ConsentSettingsScreen',
  ),
  NotificationSettingsScreen: stub(
    '../../src/screens/NotificationSettingsScreen',
    'NotificationSettingsScreen',
  ),
};
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));
jest.mock('../../src/design/components', () => {
  const React = require('react');
  const actual = jest.requireActual('../../src/design/components');
  return {
    ...actual,
    LoadingState: (props: { label: string }) =>
      React.createElement('LoadingState', props),
  };
});

type MockAccessState = Pick<
  AccessStoreState,
  'status' | 'operation' | 'canonicalAccess' | 'error'
> & {
  initialize: jest.Mock<Promise<void>, []>;
  refreshAccess: jest.Mock<Promise<boolean>, []>;
  purchaseSelected: jest.Mock<Promise<boolean>, []>;
  restorePurchases: jest.Mock<Promise<boolean>, []>;
  syncBilling: jest.Mock<Promise<boolean>, []>;
};
jest.mock('../../src/state/accessStore', () => {
  const { create } = require('zustand');
  return {
    useAccessStore: create(() => ({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
      error: null,
      initialize: jest.fn(async () => {}),
      refreshAccess: jest.fn(async () => false),
      purchaseSelected: jest.fn(async () => false),
      restorePurchases: jest.fn(async () => false),
      syncBilling: jest.fn(async () => false),
    })),
  };
});
const useMockAccessStore = (
  jest.requireMock('../../src/state/accessStore') as {
    useAccessStore: UseBoundStore<StoreApi<MockAccessState>>;
  }
).useAccessStore;

type MockAuthState = {
  session: { provider: string; localOnly: boolean } | null;
};
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  return {
    useAuthStore: create(() => ({
      session: { provider: 'apple', localOnly: false },
    })),
  };
});
const useMockAuthStore = (
  jest.requireMock('../../src/auth/authStore') as {
    useAuthStore: UseBoundStore<StoreApi<MockAuthState>>;
  }
).useAuthStore;

const mockRuntimeConfig = {
  legalTermsUrl: 'https://api.example.test/terms' as string | null,
  legalPrivacyUrl: 'https://api.example.test/privacy' as string | null,
};
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => mockRuntimeConfig,
}));

// The notification module is lazily required by RootNavigator; the
// auto-mock in __mocks__/react-native-notify-kit.ts backs it.
import notifee, { EventType } from 'react-native-notify-kit';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { color } from '../../src/design/tokens';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';

// Compile-time exhaustiveness: adding a route to params.ts without listing it
// here fails tsc, and the render test below fails if it is not registered.
const ROOT_ROUTES: Record<keyof RootStackParams, true> = {
  Tabs: true,
  Analyze: true,
  Result: true,
  ResultDetails: true,
  FormReview: true,
  DrillLibrary: true,
  StreakCalendar: true,
  ConnectAccount: true,
  ManageAccount: true,
  ConsentSettings: true,
  NotificationSettings: true,
  Paywall: true,
};
const TAB_ROUTES: Record<keyof MainTabParams, true> = {
  Home: true,
  Library: true,
  Add: true,
  Performance: true,
  Settings: true,
};

// Every tree is unmounted in afterEach so a failing assertion never leaves a
// store subscriber alive to pollute the next test.
const live: ReactTestRenderer[] = [];

function renderRoot(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  live.push(renderer);
  return renderer;
}

function stackScreens(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(n => (n.type as unknown) === 'StackScreen');
}

function stackScreen(
  renderer: ReactTestRenderer,
  name: keyof RootStackParams,
): ReactTestInstance {
  const node = stackScreens(renderer).find(n => n.props.name === name);
  if (!node) throw new Error(`Stack route ${name} is not registered`);
  return node;
}

/** Mounts a registered route's component with a fake navigation prop. */
function mountRoute(
  renderer: ReactTestRenderer,
  name: keyof RootStackParams,
  navigation: Record<string, jest.Mock>,
  params?: unknown,
): ReactTestRenderer {
  const Component = stackScreen(renderer, name).props
    .component as React.ComponentType<{
    navigation: unknown;
    route: unknown;
  }>;
  const route = { key: `${name}-1`, name, params };
  let mounted!: ReactTestRenderer;
  act(() => {
    mounted = TestRenderer.create(
      <mockRouteContext.Provider value={route}>
        <Component navigation={navigation} route={route} />
      </mockRouteContext.Provider>,
    );
  });
  live.push(mounted);
  return mounted;
}

function fakeNavigation() {
  return {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    popToTop: jest.fn(),
  };
}

function ratingAccess(remaining: number): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 2 - remaining,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: remaining === 0,
  };
}

const ACCESS_ERROR: NonNullable<AccessStoreState['error']> = {
  code: 'billing.backend_unavailable',
  message: 'Access could not be verified.',
  retryable: true,
};

function gateButton(renderer: ReactTestRenderer, label: string) {
  const [button] = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      node.props.accessibilityRole === 'button' &&
      typeof node.props.onPress === 'function',
  );
  if (!button) throw new Error(`No gate button labeled ${label}`);
  expect(button.props.disabled).toBeFalsy();
  return button;
}

function expectRetryGate(renderer: ReactTestRenderer) {
  const error = renderer.root.findByType(ErrorState);
  expect(error.props.title).toBe('Rating access couldn’t be checked');
  expect(
    renderer.root.findAll(n => (n.type as unknown) === 'LoadingState'),
  ).toHaveLength(0);
  expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
  expect(gateButton(renderer, 'Retry access check')).toBeDefined();
  expect(gateButton(renderer, 'Cancel')).toBeDefined();
  return error;
}

function deferredAccessRefresh() {
  let finish!: (access: CanonicalAccessState | null) => void;
  const refreshAccess = jest.fn(async () => {
    useMockAccessStore.setState({ status: 'loading', error: null });
    const access = await new Promise<CanonicalAccessState | null>(resolve => {
      finish = resolve;
    });
    useMockAccessStore.setState({
      status: access ? 'ready' : 'error',
      canonicalAccess: access,
      error: access ? null : ACCESS_ERROR,
    });
    return access !== null;
  });
  useMockAccessStore.setState({ refreshAccess });
  return {
    refreshAccess,
    resolve: async (access: CanonicalAccessState | null) => {
      await act(async () => finish(access));
    },
  };
}

beforeEach(() => {
  setActiveDataOwner('11111111-1111-4111-8111-111111111111');
  mockRefNavigate.mockClear();
  mockRefReady.mockReturnValue(true);
  (notifee.onForegroundEvent as jest.Mock).mockClear();
  (notifee.getInitialNotification as jest.Mock).mockClear();
  (notifee.getInitialNotification as jest.Mock).mockResolvedValue(null);
  for (const stub of Object.values(mockScreens)) stub.mockClear();
  act(() => {
    useMockAccessStore.setState({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: ratingAccess(2),
      error: null,
      initialize: jest.fn(async () => {}),
      refreshAccess: jest.fn(async () => false),
      purchaseSelected: jest.fn(async () => false),
      restorePurchases: jest.fn(async () => false),
      syncBilling: jest.fn(async () => false),
    });
    useMockAuthStore.setState({
      session: { provider: 'apple', localOnly: false },
    });
  });
  mockRuntimeConfig.legalTermsUrl = 'https://api.example.test/terms';
  mockRuntimeConfig.legalPrivacyUrl = 'https://api.example.test/privacy';
});

afterEach(() => {
  act(() => {
    for (const renderer of live.splice(0)) renderer.unmount();
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  const access = useMockAccessStore.getState();
  expect(access.purchaseSelected).not.toHaveBeenCalled();
  expect(access.restorePurchases).not.toHaveBeenCalled();
  expect(access.syncBilling).not.toHaveBeenCalled();
});

describe('navigation-tabs: route table integrity', () => {
  it('registers every RootStackParams route exactly once and nothing else', () => {
    const renderer = renderRoot();
    const names = stackScreens(renderer).map(n => n.props.name as string);
    expect([...names].sort()).toEqual(Object.keys(ROOT_ROUTES).sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers every MainTabParams tab exactly once, in tab-bar order, with headers hidden', () => {
    const renderer = renderRoot();
    // The Tabs route's component is the nested tab navigator.
    const tabsTree = mountRoute(renderer, 'Tabs', fakeNavigation());
    const tabs = tabsTree.root.findAll(
      n => (n.type as unknown) === 'TabScreen',
    );
    expect(tabs.map(n => n.props.name)).toEqual(Object.keys(TAB_ROUTES));
    // Every tab route has a real component; the Add slot is the COACH portal
    // placeholder (the tab bar intercepts its press and opens the menu).
    for (const tab of tabs) {
      expect(typeof tab.props.component).toBe('function');
    }
    expect(mockScreens.HomeScreen).toBe(
      tabs.find(n => n.props.name === 'Home')?.props.component,
    );
    expect(mockScreens.LibraryScreen).toBe(
      tabs.find(n => n.props.name === 'Library')?.props.component,
    );
    expect(mockScreens.ProgressScreen).toBe(
      tabs.find(n => n.props.name === 'Performance')?.props.component,
    );
    expect(mockScreens.SettingsScreen).toBe(
      tabs.find(n => n.props.name === 'Settings')?.props.component,
    );
  });

  it('Paywall and ConnectAccount are full-screen modals; Tabs is the un-animated root', () => {
    const renderer = renderRoot();
    expect(stackScreen(renderer, 'Paywall').props.options).toMatchObject({
      presentation: 'fullScreenModal',
      animation: 'slide_from_bottom',
    });
    expect(stackScreen(renderer, 'ConnectAccount').props.options).toMatchObject(
      { presentation: 'fullScreenModal', animation: 'slide_from_bottom' },
    );
    expect(stackScreen(renderer, 'Tabs').props.options).toMatchObject({
      animation: 'none',
      headerShown: false,
    });
    // Plain sub-pages bind directly to their screen components (each screen
    // renders its own ScreenHeader back control).
    expect(stackScreen(renderer, 'Result').props.component).toBe(
      mockScreens.ResultScreen,
    );
    // The Result guide keeps its dark shell; the full breakdown (ResultDetails)
    // is the light evidence sheet; the form review replays on the dark stage.
    expect(stackScreen(renderer, 'Result').props.options).toMatchObject({
      contentStyle: { backgroundColor: color.surfaceDark },
    });
    expect(stackScreen(renderer, 'ResultDetails').props.component).toBe(
      mockScreens.ResultDetailsScreen,
    );
    expect(stackScreen(renderer, 'ResultDetails').props.options).toMatchObject({
      title: 'Full breakdown',
      contentStyle: { backgroundColor: color.surface },
    });
    expect(stackScreen(renderer, 'FormReview').props.component).toBe(
      mockScreens.FormReviewScreen,
    );
    expect(stackScreen(renderer, 'FormReview').props.options).toMatchObject({
      title: 'Form review',
      contentStyle: { backgroundColor: color.surfaceDark },
    });
    expect(stackScreen(renderer, 'DrillLibrary').props.component).toBe(
      mockScreens.DrillLibraryScreen,
    );
    expect(stackScreen(renderer, 'StreakCalendar').props.component).toBe(
      mockScreens.StreakCalendarScreen,
    );
    expect(stackScreen(renderer, 'ManageAccount').props.component).toBe(
      mockScreens.ManageAccountScreen,
    );
    expect(stackScreen(renderer, 'ConsentSettings').props.component).toBe(
      mockScreens.ConsentSettingsScreen,
    );
    expect(stackScreen(renderer, 'NotificationSettings').props.component).toBe(
      mockScreens.NotificationSettingsScreen,
    );
  });
});

describe('navigation-tabs: Analyze route access gate', () => {
  it('renders AnalyzeScreen immediately when rating access is already granted', () => {
    const renderer = renderRoot();
    const nav = fakeNavigation();
    const mounted = mountRoute(renderer, 'Analyze', nav, { source: 'camera' });
    expect(mockScreens.AnalyzeScreen).toHaveBeenCalled();
    expect(
      mounted.root.findAll(n => (n.type as unknown) === 'LoadingState'),
    ).toHaveLength(0);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each(['guest', 'signed-out'] as const)(
    '%s session → replace(ConnectAccount), no Analyze, Paywall or access lookup',
    session => {
      setActiveDataOwner(
        session === 'guest' ? GUEST_DATA_OWNER : SIGNED_OUT_DATA_OWNER,
      );
      useMockAuthStore.setState({
        session:
          session === 'guest' ? { provider: 'guest', localOnly: true } : null,
      });
      // A guest has no server access record.
      useMockAccessStore.setState({
        status: 'unconfigured',
        canonicalAccess: null,
      });
      const renderer = renderRoot();
      const nav = fakeNavigation();
      mountRoute(renderer, 'Analyze', nav);
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(nav.replace).toHaveBeenCalledWith('ConnectAccount');
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
      expect(useMockAccessStore.getState().initialize).not.toHaveBeenCalled();
      expect(
        useMockAccessStore.getState().refreshAccess,
      ).not.toHaveBeenCalled();
    },
  );

  it('idle access store → shows "Checking access…" with Cancel and initializes once', () => {
    const initialize = jest.fn(async () => {
      useMockAccessStore.setState({ status: 'loading' });
    });
    useMockAccessStore.setState({
      status: 'idle',
      canonicalAccess: null,
      initialize,
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    const mounted = mountRoute(renderer, 'Analyze', nav);
    const loading = mounted.root.findAll(
      n => (n.type as unknown) === 'LoadingState',
    );
    expect(loading).toHaveLength(1);
    expect(loading[0]!.props.label).toBe('Checking access…');
    expect(gateButton(mounted, 'Cancel')).toBeDefined();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('verified exhaustion → replace(Paywall, { source: rating }) without mounting Analyze', () => {
    useMockAccessStore.setState({ status: 'loading', canonicalAccess: null });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => {
      useMockAccessStore.setState({
        status: 'ready',
        canonicalAccess: ratingAccess(0),
      });
    });
    // Honest paywall, no loop.
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
  });

  it('an access lookup failure leaves loading for honest Retry/Cancel, never Paywall', () => {
    useMockAccessStore.setState({ status: 'loading', canonicalAccess: null });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    const mounted = mountRoute(renderer, 'Analyze', nav);
    act(() => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
    });
    expect(expectRetryGate(mounted).props.detail).toBe(ACCESS_ERROR.message);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  it.each(['ready', 'error', 'unconfigured'] as const)(
    '%s without canonical access stays fail closed with a working Cancel',
    status => {
      useMockAccessStore.setState({ status, canonicalAccess: null });
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav);
      expectRetryGate(mounted);
      expect(nav.replace).not.toHaveBeenCalled();
      const cancel = gateButton(mounted, 'Cancel').props.onPress;
      act(() => {
        cancel();
        cancel();
      });
      expect(nav.goBack).toHaveBeenCalledTimes(1);
      expect(
        useMockAccessStore.getState().refreshAccess,
      ).not.toHaveBeenCalled();
    },
  );

  it('a non-paywall denial stays blocked rather than inventing an upsell', () => {
    useMockAccessStore.setState({
      canonicalAccess: { ...ratingAccess(0), paywallRequired: false },
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    const mounted = mountRoute(renderer, 'Analyze', nav);
    expectRetryGate(mounted);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('access granted after loading → swaps the spinner for AnalyzeScreen without navigating', () => {
    useMockAccessStore.setState({ status: 'loading', canonicalAccess: null });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
    act(() => {
      useMockAccessStore.setState({
        status: 'ready',
        canonicalAccess: ratingAccess(1),
      });
    });
    expect(mockScreens.AnalyzeScreen).toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each(['error', 'unconfigured'] as const)(
    'a pricing-only %s cannot erase a verified free allowance',
    status => {
      useMockAccessStore.setState({
        status,
        canonicalAccess: ratingAccess(1),
        error: {
          code: 'billing.offerings_unavailable',
          message: 'Store unavailable.',
          retryable: true,
        },
      });
      const renderer = renderRoot();
      const nav = fakeNavigation();
      mountRoute(renderer, 'Analyze', nav);
      expect(mockScreens.AnalyzeScreen).toHaveBeenCalled();
      expect(nav.replace).not.toHaveBeenCalled();
    },
  );

  describe.each(['camera', 'library'] as const)('%s recovery', source => {
    beforeEach(() => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
    });

    it('Retry checks once, waits, then resumes the original route/intent when allowed', async () => {
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const params = { source };
      const mounted = mountRoute(renderer, 'Analyze', nav, params);
      expectRetryGate(mounted);
      const retry = gateButton(mounted, 'Retry access check').props.onPress;
      act(() => {
        retry();
        retry();
      });
      expect(refresh.refreshAccess).toHaveBeenCalledTimes(1);
      expect(useMockAccessStore.getState().initialize).not.toHaveBeenCalled();
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
      expect(
        mounted.root.findAll(n => (n.type as unknown) === 'LoadingState'),
      ).toHaveLength(1);
      expect(gateButton(mounted, 'Cancel')).toBeDefined();

      await refresh.resolve(ratingAccess(1));
      expect(mockScreens.AnalyzeScreen).toHaveBeenCalledTimes(1);
      const screen = mounted.root.find(
        n => (n.type as unknown) === 'AnalyzeScreen',
      );
      expect(screen.props.route.params).toBe(params);
      expect(screen.props.route).toEqual({
        key: 'Analyze-1',
        name: 'Analyze',
        params: { source },
      });
      expect(mounted.root.findAllByType(ErrorState)).toHaveLength(0);
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.goBack).not.toHaveBeenCalled();
    });

    it('Retry reaches Paywall only after a verified paywallRequired verdict', async () => {
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav, { source });
      expectRetryGate(mounted);
      const cancel = gateButton(mounted, 'Cancel').props.onPress;
      act(() => gateButton(mounted, 'Retry access check').props.onPress());
      expect(nav.replace).not.toHaveBeenCalled();
      await refresh.resolve(ratingAccess(0));
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(nav.replace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
      act(() => cancel());
      expect(nav.goBack).not.toHaveBeenCalled();
    });

    it('a failed Retry remains recoverable; Cancel is final even for a retained retry callback', async () => {
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav, { source });
      const retry = gateButton(mounted, 'Retry access check').props.onPress;
      act(() => retry());
      await refresh.resolve(null);
      expectRetryGate(mounted);
      const cancel = gateButton(mounted, 'Cancel').props.onPress;
      act(() => {
        cancel();
        cancel();
        retry();
      });
      expect(nav.goBack).toHaveBeenCalledTimes(1);
      expect(refresh.refreshAccess).toHaveBeenCalledTimes(1);
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.navigate).not.toHaveBeenCalled();
    });
  });

  it.each([0, 1])(
    'Cancel during Retry ignores a late verdict with %i free ratings left',
    async remaining => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav, {
        source: 'library',
      });
      act(() => gateButton(mounted, 'Retry access check').props.onPress());
      const cancel = gateButton(mounted, 'Cancel').props.onPress;
      act(() => {
        cancel();
        cancel();
      });
      await refresh.resolve(ratingAccess(remaining));
      expect(nav.goBack).toHaveBeenCalledTimes(1);
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])(
    'unmount during Retry ignores a late verdict with %i free ratings left',
    async remaining => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav, {
        source: 'camera',
      });
      const retry = gateButton(mounted, 'Retry access check').props.onPress;
      act(() => retry());
      act(() => {
        live.splice(live.indexOf(mounted), 1)[0]!.unmount();
      });
      await refresh.resolve(ratingAccess(remaining));
      act(() => retry());
      expect(refresh.refreshAccess).toHaveBeenCalledTimes(1);
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.goBack).not.toHaveBeenCalled();
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'owner'] as const)(
    'a changed %s invalidates an in-flight gate and allows only Cancel',
    async changed => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
      const refresh = deferredAccessRefresh();
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav, {
        source: 'camera',
      });
      const retry = gateButton(mounted, 'Retry access check').props.onPress;
      act(() => retry());
      act(() => {
        if (changed === 'owner') {
          setActiveDataOwner('22222222-2222-4222-8222-222222222222');
        } else {
          useMockAuthStore.setState({
            session: { ...useMockAuthStore.getState().session! },
          });
        }
      });
      await refresh.resolve(ratingAccess(1));
      const error = mounted.root.findByType(ErrorState);
      expect(error.props.detail).toBe(
        'Your account changed. Go back and start a new rating.',
      );
      expect(error.props.onRetry).toBeUndefined();
      act(() => retry());
      expect(refresh.refreshAccess).toHaveBeenCalledTimes(1);
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
      expect(nav.replace).not.toHaveBeenCalled();
      act(() => gateButton(mounted, 'Cancel').props.onPress());
      expect(nav.goBack).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['purchasing', 'restoring', 'syncing'] as const)(
    'Retry cannot start another access operation while %s; Cancel remains available',
    operation => {
      useMockAccessStore.setState({
        status: 'error',
        canonicalAccess: null,
        error: ACCESS_ERROR,
      });
      const renderer = renderRoot();
      const nav = fakeNavigation();
      const mounted = mountRoute(renderer, 'Analyze', nav);
      const retry = gateButton(mounted, 'Retry access check').props.onPress;
      act(() => useMockAccessStore.setState({ operation }));
      expect(mounted.root.findByType(ErrorState).props.onRetry).toBeUndefined();
      act(() => retry());
      expect(
        useMockAccessStore.getState().refreshAccess,
      ).not.toHaveBeenCalled();
      expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
      act(() => gateButton(mounted, 'Cancel').props.onPress());
      expect(nav.goBack).toHaveBeenCalledTimes(1);
      expect(nav.replace).not.toHaveBeenCalled();
    },
  );
});

describe('navigation-tabs: Paywall route wrapper', () => {
  it('close and purchase both pop the modal; legal links open the configured URLs', () => {
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(async () => {});
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Paywall', nav, { source: 'rating' });
    const props = mockScreens.PaywallScreen.mock.calls.at(-1)?.[0] as {
      onClose: () => void;
      onPurchased: () => void;
      onOpenTerms?: () => void;
      onOpenPrivacy?: () => void;
    };
    props.onClose();
    expect(nav.goBack).toHaveBeenCalledTimes(1);
    props.onPurchased();
    expect(nav.goBack).toHaveBeenCalledTimes(2);
    expect(props.onOpenTerms).toBeDefined();
    expect(props.onOpenPrivacy).toBeDefined();
    props.onOpenTerms?.();
    props.onOpenPrivacy?.();
    expect(openUrl).toHaveBeenCalledWith('https://api.example.test/terms');
    expect(openUrl).toHaveBeenCalledWith('https://api.example.test/privacy');
    openUrl.mockRestore();
  });

  it('omits legal handlers (rather than passing broken ones) when no API base URL is configured', () => {
    mockRuntimeConfig.legalTermsUrl = null;
    mockRuntimeConfig.legalPrivacyUrl = null;
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Paywall', nav);
    const props = mockScreens.PaywallScreen.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect('onOpenTerms' in props).toBe(false);
    expect('onOpenPrivacy' in props).toBe(false);
  });
});

describe('navigation-tabs: ConnectAccount route wrapper', () => {
  it('renders SignInScreen whose Back pops the modal (cancel branch)', () => {
    useMockAuthStore.setState({
      session: { provider: 'guest', localOnly: true },
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'ConnectAccount', nav);
    expect(nav.goBack).not.toHaveBeenCalled();
    const props = mockScreens.SignInScreen.mock.calls.at(-1)?.[0] as {
      onBack: () => void;
    };
    props.onBack();
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });

  it('pops itself automatically once a non-guest session arrives (success branch)', () => {
    useMockAuthStore.setState({
      session: { provider: 'guest', localOnly: true },
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'ConnectAccount', nav);
    act(() => {
      useMockAuthStore.setState({
        session: { provider: 'apple', localOnly: false },
      });
    });
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });

  it('stays put while the session is still guest or signed out', () => {
    useMockAuthStore.setState({ session: null });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'ConnectAccount', nav);
    act(() => {
      useMockAuthStore.setState({
        session: { provider: 'guest', localOnly: true },
      });
    });
    expect(nav.goBack).not.toHaveBeenCalled();
  });
});

describe('navigation-tabs: notification press routing', () => {
  function foregroundHandler(): (event: {
    type: number;
    detail: { notification?: { data?: unknown } };
  }) => void {
    const call = (notifee.onForegroundEvent as jest.Mock).mock.calls.at(-1);
    if (!call) throw new Error('RootNavigator did not subscribe to presses');
    return call[0];
  }

  it('subscribes on mount and unsubscribes on unmount', () => {
    const unsubscribe = jest.fn();
    (notifee.onForegroundEvent as jest.Mock).mockReturnValueOnce(unsubscribe);
    const renderer = renderRoot();
    expect(notifee.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    act(() => {
      live.splice(live.indexOf(renderer), 1)[0]!.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a pressed Performance reminder navigates into Tabs → Performance', () => {
    renderRoot();
    act(() => {
      foregroundHandler()({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Performance' } } },
      });
    });
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });
  });

  it('a pressed Home reminder navigates into Tabs → Home', () => {
    renderRoot();
    act(() => {
      foregroundHandler()({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Home' } } },
      });
    });
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
  });

  it('ignores dismissals, unknown targets, and missing data', () => {
    renderRoot();
    act(() => {
      const handler = foregroundHandler();
      handler({
        type: EventType.DISMISSED,
        detail: { notification: { data: { screen: 'Performance' } } },
      });
      handler({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'LiveCourt' } } },
      });
      handler({ type: EventType.PRESS, detail: {} });
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();
  });

  it('drops the press when the container is not ready yet (no crash)', () => {
    mockRefReady.mockReturnValue(false);
    renderRoot();
    act(() => {
      foregroundHandler()({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Home' } } },
      });
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();
  });

  it('routes a cold-start (initial) notification press once the promise resolves', async () => {
    (notifee.getInitialNotification as jest.Mock).mockResolvedValueOnce({
      notification: { data: { screen: 'Performance' } },
    });
    renderRoot();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });
  });

  it('a failed initial-notification read is swallowed (no unhandled rejection)', async () => {
    (notifee.getInitialNotification as jest.Mock).mockRejectedValueOnce(
      new Error('native unavailable'),
    );
    renderRoot();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();
  });
});
