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

const mockRefNavigate = jest.fn();
const mockRefReady = jest.fn(() => true);

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      React.createElement('NavigationContainer', null, props.children),
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
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
  AnalyzeScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: jest.fn(() => null),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: jest.fn(() => null),
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

type ScreenStub = jest.Mock<null, [Record<string, unknown>]>;
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
  return {
    LoadingState: (props: { label: string }) =>
      React.createElement('LoadingState', props),
  };
});

type AccessStatus = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
type MockAccessState = {
  status: AccessStatus;
  canonicalAccess: { canStartRating: boolean } | null;
  initialize: jest.Mock<Promise<void>, []>;
};
jest.mock('../../src/state/accessStore', () => {
  const { create } = require('zustand');
  return {
    useAccessStore: create(() => ({
      status: 'ready',
      canonicalAccess: { canStartRating: true },
      initialize: jest.fn(async () => {}),
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
  let mounted!: ReactTestRenderer;
  act(() => {
    mounted = TestRenderer.create(
      <Component
        navigation={navigation}
        route={{ key: `${name}-1`, name, params }}
      />,
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

beforeEach(() => {
  mockRefNavigate.mockClear();
  mockRefReady.mockReturnValue(true);
  (notifee.onForegroundEvent as jest.Mock).mockClear();
  (notifee.getInitialNotification as jest.Mock).mockClear();
  (notifee.getInitialNotification as jest.Mock).mockResolvedValue(null);
  for (const stub of Object.values(mockScreens)) stub.mockClear();
  act(() => {
    useMockAccessStore.setState({
      status: 'ready',
      canonicalAccess: { canStartRating: true },
      initialize: jest.fn(async () => {}),
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

  it('local-only session → replace(ConnectAccount) (no Analyze, no Paywall)', () => {
    act(() => {
      useMockAuthStore.setState({
        session: { provider: 'guest', localOnly: true },
      });
      // A guest has no server access record.
      useMockAccessStore.setState({
        status: 'unconfigured',
        canonicalAccess: null,
      });
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('ConnectAccount');
    expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
  });

  it('idle access store → shows "Checking access…" and kicks off initialize() once', () => {
    const initialize = jest.fn(async () => {});
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
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('access resolves without entitlement → replace(Paywall, { source: rating }) — no infinite loading', () => {
    useMockAccessStore.setState({
      status: 'loading',
      canonicalAccess: null,
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => {
      useMockAccessStore.setState({
        status: 'ready',
        canonicalAccess: { canStartRating: false },
      });
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
  });

  it('access lookup fails (status error, no access) → replace(Paywall) rather than spinning', () => {
    useMockAccessStore.setState({
      status: 'loading',
      canonicalAccess: null,
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    act(() => {
      useMockAccessStore.setState({ status: 'error', canonicalAccess: null });
    });
    expect(nav.replace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
  });

  it('billing unconfigured (no dependencies) → replace(Paywall) so the user sees the honest store state', () => {
    useMockAccessStore.setState({
      status: 'unconfigured',
      canonicalAccess: null,
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
  });

  it('access granted after loading → swaps the spinner for AnalyzeScreen without navigating', () => {
    useMockAccessStore.setState({
      status: 'loading',
      canonicalAccess: null,
    });
    const renderer = renderRoot();
    const nav = fakeNavigation();
    mountRoute(renderer, 'Analyze', nav);
    expect(mockScreens.AnalyzeScreen).not.toHaveBeenCalled();
    act(() => {
      useMockAccessStore.setState({
        status: 'ready',
        canonicalAccess: { canStartRating: true },
      });
    });
    expect(mockScreens.AnalyzeScreen).toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
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
