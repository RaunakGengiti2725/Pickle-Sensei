/**
 * Button ledger for src/navigation/RootNavigator.tsx.
 *
 * RootNavigator owns no <Pressable> of its own; every interactive element it
 * contributes is a handler it hands to a child surface, a route-level effect
 * that navigates on the user's behalf, or the tab bar it mounts:
 *
 *   PaywallRoute        onClose / onPurchased -> navigation.goBack()
 *                       onOpenTerms / onOpenPrivacy -> Linking.openURL(legal)
 *   ConnectAccountRoute onBack -> navigation.goBack(); provider effect -> goBack
 *   AnalyzeRoute        useRatingRouteGate -> replace('ConnectAccount') |
 *                       replace('Paywall', { source: 'rating' }) | initialize()
 *   MainTabs            tabBar -> <PremiumTabBar/> (tab items + Coach FAB)
 *   RootNavigator       notification press -> navigationRef.navigate('Tabs')
 *
 * The navigators are mocked with inert registries so each route component can
 * be rendered with a fake `navigation` prop; the child surfaces that carry the
 * real pressables (PaywallScreen, SignInScreen, PremiumTabBar) are REAL so
 * the tap goes through the same element a user would touch.
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

// Inert navigator doubles: Navigator renders its children, Screen renders
// nothing but keeps name/component/options readable through the test tree.
// Both factories return singletons so the test can look the elements up.
const mockAnalyzeMounted = jest.fn();
const mockScreenNavigation = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
};
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const routeContext = React.createContext({ params: undefined });
  const navigationRef = {
    isReady: jest.fn(() => true),
    navigate: jest.fn(),
  };
  return {
    __esModule: true,
    DefaultTheme: { dark: false, colors: {} },
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      React.createElement(
        View,
        { testID: 'navigation-container' },
        props.children,
      ),
    createNavigationContainerRef: () => navigationRef,
    useNavigation: () => mockScreenNavigation,
    __RouteContext: routeContext,
    useRoute: () => React.useContext(routeContext),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(callback, [callback]);
    },
  };
});
jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  const { View } = require('react-native');
  const StackNavigator = (props: { children?: React.ReactNode }) =>
    React.createElement(View, { testID: 'stack-navigator' }, props.children);
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
    React.createElement(View, { testID: 'tab-navigator' }, props.children);
  const TabScreen = () => null;
  return {
    __esModule: true,
    createBottomTabNavigator: () => ({
      Navigator: TabNavigator,
      Screen: TabScreen,
    }),
  };
});

// The auth store is a plain zustand store here: RootNavigator and the real
// SignInScreen only read `session`/`busy`/`error` and call the sign-in
// actions, so no SQLite/native identity code is loaded.
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

const mockSubscribeToNotificationPresses = jest.fn();
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: (...args: unknown[]) =>
    mockSubscribeToNotificationPresses(...args),
}));

// Screens that RootNavigator only registers (never renders itself) are
// stubbed so their native/data imports stay out of this suite.
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  listShots: jest.fn(async () => []),
  listRealAnalysisFacts: jest.fn(async () => []),
  getKv: jest.fn(async () => null),
  setKv: jest.fn(async () => undefined),
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (state: { profile: null }) => unknown) =>
    selector({ profile: null }),
}));
jest.mock('../../src/consistency/store', () => {
  const state = { snapshot: null, refresh: jest.fn(async () => undefined) };
  return {
    useConsistencyStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/components/PlayerRankBanner', () => ({
  PlayerRankBanner: () => null,
}));
jest.mock('../../src/notifications/NotificationPrimingCard', () => ({
  NotificationPrimingCard: () => null,
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
    AnalyzeScreen: () => {
      const route = require('@react-navigation/native').useRoute();
      React.useEffect(() => {
        mockAnalyzeMounted(route.params?.source ?? 'camera');
      }, []);
      return React.createElement(
        Text,
        { testID: 'analyze-screen' },
        'Analyze stub',
      );
    },
  };
});

import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNavigationContainerRef } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
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
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { RootNavigator } from '../../src/navigation/RootNavigator';

type Renderer = TestRenderer.ReactTestRenderer;
type RouteName = keyof RootStackParams;
type RouteComponent = React.ComponentType<{
  navigation: unknown;
  route: { key: string; name: RouteName; params?: unknown };
}>;

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef =
  createNavigationContainerRef<RootStackParams>() as unknown as {
    isReady: jest.Mock;
    navigate: jest.Mock;
  };

const ROOT_ROUTES: readonly RouteName[] = [
  'Tabs',
  'Analyze',
  'Result',
  'ResultDetails',
  'FormReview',
  'DrillLibrary',
  'StreakCalendar',
  'Paywall',
  'ManageAccount',
  'ConsentSettings',
  'NotificationSettings',
  'ConnectAccount',
];

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

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

const exhaustedAccess: CanonicalAccessState = {
  ...freeAccess,
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

const premiumAccess: CanonicalAccessState = {
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

function billingDependencies(options?: {
  access?: CanonicalAccessState;
  syncedAccess?: CanonicalAccessState;
  purchase?: () => Promise<unknown>;
}): BillingAccessDependencies {
  const access = options?.access ?? freeAccess;
  const synced = options?.syncedAccess ?? premiumAccess;
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(
        options?.purchase ??
          (async () => ({
            premium: true,
            productId: 'pickle_sensei_pro_annual',
            expirationDate: null,
          })),
      ),
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
      getAccess: jest.fn(async () => access),
      syncBilling: jest.fn(async () => ({ access: synced })),
    },
  } as unknown as BillingAccessDependencies;
}

function fakeNavigation() {
  return {
    goBack: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
  };
}

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function flushAsync() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(0);
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

function findPressable(
  renderer: Renderer,
  match: { label?: string; testID?: string },
) {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      (match.label === undefined ||
        node.props.accessibilityLabel === match.label) &&
      (match.testID === undefined || node.props.testID === match.testID),
  );
  if (nodes.length === 0) {
    throw new Error(`No pressable matching ${JSON.stringify(match)}`);
  }
  // PressableScale forwards the same handler to its inner <Pressable>, which
  // is where the resolved accessibilityRole/hitSlop/disabled props live.
  return nodes[nodes.length - 1]!;
}

async function press(
  renderer: Renderer,
  match: { label?: string; testID?: string },
) {
  const node = findPressable(renderer, match);
  await act(async () => {
    node.props.onPress();
  });
}

function stackScreens(renderer: Renderer) {
  return renderer.root.findAllByType(Stack.Screen).map(node => ({
    name: node.props.name as RouteName,
    component: node.props.component as RouteComponent,
    options: node.props.options as Record<string, unknown> | undefined,
  }));
}

function routeComponent(renderer: Renderer, name: RouteName): RouteComponent {
  const screen = stackScreens(renderer).find(entry => entry.name === name);
  if (!screen) throw new Error(`Route ${name} is not registered`);
  return screen.component;
}

function renderRoute(
  renderer: Renderer,
  name: RouteName,
  navigation: ReturnType<typeof fakeNavigation>,
  params?: unknown,
): Renderer {
  const Route = routeComponent(renderer, name);
  const RouteProvider = require('@react-navigation/native').__RouteContext
    .Provider;
  const route = { key: `${name}-1`, name, params };
  return render(
    <RouteProvider value={route}>
      <Route navigation={navigation} route={route} />
    </RouteProvider>,
  );
}

const realInitialize = useAccessStore.getState().initialize;

describe('RootNavigator button ledger', () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    navigationRef.isReady.mockReset().mockReturnValue(true);
    navigationRef.navigate.mockReset();
    mockSubscribeToNotificationPresses.mockReset();
    mockSubscribeToNotificationPresses.mockReturnValue(jest.fn());
    clearAccessStoreConfiguration();
    useAccessStore.setState({ initialize: realInitialize });
    useAuthStore.setState({ session: syncedSession, busy: false, error: null });
    setActiveDataOwner(syncedSession.canonicalAppUserId!);
    mockAnalyzeMounted.mockClear();
    mockScreenNavigation.navigate.mockClear();
    mockScreenNavigation.goBack.mockClear();
    mockScreenNavigation.replace.mockClear();
  });

  afterEach(() => {
    openURL.mockRestore();
    jest.useRealTimers();
  });

  describe('route registry', () => {
    it('registers every RootStackParams route exactly once, headerless', () => {
      const renderer = render(<RootNavigator />);
      const screens = stackScreens(renderer);
      expect(screens.map(entry => entry.name).sort()).toEqual(
        [...ROOT_ROUTES].sort(),
      );
      expect(new Set(screens.map(entry => entry.name)).size).toBe(
        ROOT_ROUTES.length,
      );
      for (const screen of screens) {
        expect(typeof screen.component).toBe('function');
      }
      // Paywall and ConnectAccount present as full-screen modals so their own
      // in-surface Close/Back controls are the only way out (no stack header).
      const paywall = screens.find(entry => entry.name === 'Paywall');
      const connect = screens.find(entry => entry.name === 'ConnectAccount');
      expect(paywall?.options?.presentation).toBe('fullScreenModal');
      expect(connect?.options?.presentation).toBe('fullScreenModal');
      act(() => renderer.unmount());
    });

    it('mounts the five tab routes and the PremiumTabBar as the tab bar', () => {
      const renderer = render(<RootNavigator />);
      const Tabs_ = routeComponent(renderer, 'Tabs');
      const tabs = render(
        <Tabs_
          navigation={fakeNavigation()}
          route={{ key: 'Tabs-1', name: 'Tabs' }}
        />,
      );
      const tabScreens = tabs.root.findAllByType(Tabs.Screen);
      expect(tabScreens.map(node => node.props.name)).toEqual([
        'Home',
        'Library',
        'Add',
        'Performance',
        'Settings',
      ]);
      const navigator = tabs.root.findByType(Tabs.Navigator);
      expect(typeof navigator.props.tabBar).toBe('function');
      // The Add slot is a portal for the Coach FAB; its screen body is
      // intentionally empty and must render without throwing.
      const Add = tabScreens[2]!.props.component as React.ComponentType;
      const portal = render(<Add />);
      expect(portal.root.findAllByType(Text)).toHaveLength(0);
      act(() => portal.unmount());
      act(() => tabs.unmount());
      act(() => renderer.unmount());
    });
  });

  describe('MainTabs tabBar -> PremiumTabBar', () => {
    function tabBarProps(index = 0) {
      const emit = jest.fn(() => ({ defaultPrevented: false }));
      const navigate = jest.fn();
      const rootNavigate = jest.fn();
      const props = {
        state: {
          index,
          routes: [
            { key: 'Home-1', name: 'Home' },
            { key: 'Library-1', name: 'Library' },
            { key: 'Add-1', name: 'Add' },
            { key: 'Performance-1', name: 'Performance' },
            { key: 'Settings-1', name: 'Settings' },
          ],
        },
        navigation: {
          emit,
          navigate,
          getParent: () => ({ navigate: rootNavigate }),
        },
        descriptors: {},
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      } as unknown as BottomTabBarProps;
      return { props, emit, navigate, rootNavigate };
    }

    function renderTabBar(index = 0) {
      const root = render(<RootNavigator />);
      const Tabs_ = routeComponent(root, 'Tabs');
      const tabs = render(
        <Tabs_
          navigation={fakeNavigation()}
          route={{ key: 'Tabs-1', name: 'Tabs' }}
        />,
      );
      const tabBar = tabs.root.findByType(Tabs.Navigator).props.tabBar as (
        props: BottomTabBarProps,
      ) => React.ReactElement;
      const harness = tabBarProps(index);
      const bar = render(tabBar(harness.props));
      expect(bar.root.findAllByType(PremiumTabBar)).toHaveLength(1);
      return {
        bar,
        ...harness,
        unmount: () => {
          act(() => bar.unmount());
          act(() => tabs.unmount());
          act(() => root.unmount());
        },
      };
    }

    it('Home / Library / Progress / Settings tabs emit tabPress and navigate', async () => {
      const { bar, emit, navigate, unmount } = renderTabBar(0);
      for (const [label, route] of [
        ['Library', 'Library'],
        ['Progress', 'Performance'],
        ['Settings', 'Settings'],
      ] as const) {
        const tab = findPressable(bar, { label });
        expect(tab.props.accessibilityRole).toBe('tab');
        await press(bar, { label });
        expect(emit).toHaveBeenCalledWith({
          type: 'tabPress',
          target: `${route}-1`,
          canPreventDefault: true,
        });
        expect(navigate).toHaveBeenLastCalledWith(route, undefined);
      }
      // The focused tab re-emits tabPress but never re-navigates.
      navigate.mockClear();
      await press(bar, { label: 'Home' });
      expect(navigate).not.toHaveBeenCalled();
      unmount();
    });

    it('the Coach FAB opens the action menu and its rows reach root routes', async () => {
      const { bar, rootNavigate, unmount } = renderTabBar(0);
      const fab = findPressable(bar, { label: 'Open coach actions' });
      expect(fab.props.accessibilityRole).toBe('button');
      await press(bar, { label: 'Open coach actions' });
      expect(allText(bar)).toContain('Drill Library');
      await press(bar, { label: 'Drill Library' });
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(rootNavigate).toHaveBeenCalledWith('DrillLibrary');
      unmount();
    });
  });

  describe('PaywallRoute', () => {
    async function renderPaywall(
      navigation: ReturnType<typeof fakeNavigation>,
      deps = billingDependencies(),
    ) {
      configureAccessStore(deps);
      const root = render(<RootNavigator />);
      const paywall = renderRoute(root, 'Paywall', navigation, {
        source: 'rating',
      });
      await flushAsync();
      return {
        paywall,
        unmount: () => {
          act(() => paywall.unmount());
          act(() => root.unmount());
        },
      };
    }

    it('Close membership offer -> navigation.goBack()', async () => {
      const navigation = fakeNavigation();
      const { paywall, unmount } = await renderPaywall(navigation);
      await press(paywall, { label: 'Close membership offer' });
      expect(navigation.goBack).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('Terms / Privacy links -> Linking.openURL(runtime legal URLs)', async () => {
      const { legalTermsUrl, legalPrivacyUrl } = getRuntimePublicConfig();
      expect(legalTermsUrl).toMatch(/^https:\/\/.+\/terms$/);
      expect(legalPrivacyUrl).toMatch(/^https:\/\/.+\/privacy$/);
      const navigation = fakeNavigation();
      const { paywall, unmount } = await renderPaywall(navigation);
      await press(paywall, { testID: 'paywall-see-plans' });
      const terms = findPressable(paywall, { label: 'Terms of use' });
      const privacy = findPressable(paywall, { label: 'Privacy policy' });
      expect(terms.props.accessibilityRole).toBe('link');
      expect(privacy.props.accessibilityRole).toBe('link');
      await press(paywall, { label: 'Terms of use' });
      expect(openURL).toHaveBeenLastCalledWith(legalTermsUrl);
      await press(paywall, { label: 'Privacy policy' });
      expect(openURL).toHaveBeenLastCalledWith(legalPrivacyUrl);
      expect(openURL).toHaveBeenCalledTimes(2);
      expect(navigation.goBack).not.toHaveBeenCalled();
      // WF-ISSUE: Paywall legal links swallow Linking.openURL rejections
      // (RootNavigator.tsx:71,74 use `void Linking.openURL(...)` with no
      // catch, so a failed open shows no copy). The rejection path is not
      // asserted here.
      unmount();
    });

    it('verified purchase -> onPurchased -> navigation.goBack()', async () => {
      const navigation = fakeNavigation();
      const { paywall, unmount } = await renderPaywall(navigation);
      await press(paywall, { testID: 'paywall-see-plans' });
      await press(paywall, { testID: 'paywall-continue' });
      await flushAsync();
      expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
      expect(navigation.goBack).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('failed purchase keeps the paywall open with error copy, never goBack', async () => {
      const navigation = fakeNavigation();
      const deps = billingDependencies({
        purchase: async () => {
          throw new Error('store down');
        },
      });
      const { paywall, unmount } = await renderPaywall(navigation, deps);
      await press(paywall, { testID: 'paywall-see-plans' });
      await press(paywall, { testID: 'paywall-continue' });
      await flushAsync();
      expect(navigation.goBack).not.toHaveBeenCalled();
      expect(useAccessStore.getState().operation).toBe('idle');
      expect(allText(paywall)).toContain(
        'The app store could not complete the purchase.',
      );
      // The CTA is enabled again for a retry.
      expect(
        findPressable(paywall, { testID: 'paywall-continue' }).props.disabled,
      ).not.toBe(true);
      unmount();
    });

    it.each(['Close membership', 'Continue coaching'])(
      'already-premium members use %s to go back once',
      async label => {
        const navigation = fakeNavigation();
        const { paywall, unmount } = await renderPaywall(
          navigation,
          billingDependencies({ access: premiumAccess }),
        );
        await press(paywall, { label });
        await press(paywall, { label });
        expect(navigation.goBack).toHaveBeenCalledTimes(1);
        unmount();
      },
    );
  });

  describe('ConnectAccountRoute', () => {
    function renderConnect(navigation: ReturnType<typeof fakeNavigation>) {
      const root = render(<RootNavigator />);
      const connect = renderRoute(root, 'ConnectAccount', navigation);
      return {
        connect,
        unmount: () => {
          act(() => connect.unmount());
          act(() => root.unmount());
        },
      };
    }

    it('Back -> navigation.goBack() while the session is still local-only', async () => {
      useAuthStore.setState({ session: guestSession });
      const navigation = fakeNavigation();
      const { connect, unmount } = renderConnect(navigation);
      expect(navigation.goBack).not.toHaveBeenCalled();
      const back = findPressable(connect, { label: 'Back' });
      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.hitSlop).toBe(8);
      await press(connect, { label: 'Back' });
      expect(navigation.goBack).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('a synced provider appearing dismisses the sheet automatically', async () => {
      useAuthStore.setState({ session: guestSession });
      const navigation = fakeNavigation();
      const { unmount } = renderConnect(navigation);
      expect(navigation.goBack).not.toHaveBeenCalled();
      await act(async () => {
        useAuthStore.setState({ session: syncedSession });
      });
      expect(navigation.goBack).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('never dismisses for a null or guest session', async () => {
      useAuthStore.setState({ session: null });
      const navigation = fakeNavigation();
      const { unmount } = renderConnect(navigation);
      await act(async () => {
        useAuthStore.setState({ session: guestSession });
      });
      expect(navigation.goBack).not.toHaveBeenCalled();
      unmount();
    });

    it('provider buttons on the mounted SignInScreen call the auth store', async () => {
      useAuthStore.setState({ session: guestSession });
      const navigation = fakeNavigation();
      const { connect, unmount } = renderConnect(navigation);
      await press(connect, { label: 'Continue with Apple' });
      expect(useAuthStore.getState().signInWithApple).toHaveBeenCalledTimes(1);
      await press(connect, { label: 'Continue with Google' });
      expect(useAuthStore.getState().signInWithGoogle).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  describe('AnalyzeRoute (useRatingRouteGate)', () => {
    function renderAnalyze(
      navigation: ReturnType<typeof fakeNavigation>,
      source: 'camera' | 'library' = 'camera',
    ) {
      const root = render(<RootNavigator />);
      const analyze = renderRoute(root, 'Analyze', navigation, { source });
      return {
        analyze,
        unmount: () => {
          act(() => analyze.unmount());
          act(() => root.unmount());
        },
      };
    }

    it('local-only session -> replace(ConnectAccount) before anything loads', () => {
      useAuthStore.setState({ session: guestSession });
      useAccessStore.setState({ initialize: jest.fn(async () => undefined) });
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      expect(navigation.replace).toHaveBeenCalledWith('ConnectAccount');
      expect(navigation.replace).toHaveBeenCalledTimes(1);
      expect(useAccessStore.getState().initialize).not.toHaveBeenCalled();
      expect(
        analyze.root.findAllByProps({ testID: 'analyze-screen' }),
      ).toHaveLength(0);
      unmount();
    });

    it('verified free allowance renders AnalyzeScreen, no navigation', () => {
      useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess });
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      expect(
        analyze.root.findByProps({ testID: 'analyze-screen' }),
      ).toBeTruthy();
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(navigation.goBack).not.toHaveBeenCalled();
      unmount();
    });

    it('idle store -> initialize() once, honest loading copy, no navigation yet', () => {
      const initialize = jest.fn(async () => undefined);
      useAccessStore.setState({
        status: 'idle',
        canonicalAccess: null,
        initialize,
      });
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(allText(analyze)).toContain('Checking access…');
      unmount();
    });

    it('loading store -> waits; ready without allowance -> replace(Paywall, rating)', async () => {
      useAccessStore.setState({
        status: 'loading',
        canonicalAccess: null,
        initialize: jest.fn(async () => undefined),
      });
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(allText(analyze)).toContain('Checking access…');
      await act(async () => {
        useAccessStore.setState({
          status: 'ready',
          canonicalAccess: exhaustedAccess,
        });
      });
      expect(navigation.replace).toHaveBeenCalledWith('Paywall', {
        source: 'rating',
      });
      expect(navigation.replace).toHaveBeenCalledTimes(1);
      unmount();
    });

    it.each(['error', 'unconfigured', 'ready'] as const)(
      'access %s with no canonical state stays fail closed with an accessible retry and cancel, not a sale',
      async status => {
        useAccessStore.setState({
          status,
          canonicalAccess: null,
          initialize: jest.fn(async () => undefined),
        });
        const navigation = fakeNavigation();
        const { analyze, unmount } = renderAnalyze(navigation);
        try {
          expect(navigation.replace).not.toHaveBeenCalled();
          expect(mockAnalyzeMounted).not.toHaveBeenCalled();
          expect(allText(analyze)).toContain(
            'Rating access couldn’t be checked',
          );
          expect(
            analyze.root.findAll(n => n.props.accessibilityRole === 'alert')
              .length,
          ).toBeGreaterThan(0);
          expect(
            findPressable(analyze, { label: 'Retry access check' }),
          ).toBeTruthy();
          await press(analyze, { label: 'Cancel' });
          expect(navigation.goBack).toHaveBeenCalledTimes(1);
        } finally {
          unmount();
        }
      },
    );

    it.each(['camera', 'library'] as const)(
      'an access failure recovers to the intended %s source only after a successful backend retry',
      async source => {
        const deps = billingDependencies();
        const getAccess = deps.backend.getAccess as jest.Mock;
        getAccess.mockRejectedValueOnce(new Error('backend down'));
        configureAccessStore(deps);
        const navigation = fakeNavigation();
        const { analyze, unmount } = renderAnalyze(navigation, source);
        try {
          expect(allText(analyze)).toContain('Checking access…');
          await flushAsync();
          expect(useAccessStore.getState().status).toBe('error');
          expect(allText(analyze)).toContain(
            'Membership verification is temporarily unavailable.',
          );
          expect(navigation.replace).not.toHaveBeenCalled();
          expect(mockAnalyzeMounted).not.toHaveBeenCalled();
          let resolve!: (value: CanonicalAccessState) => void;
          getAccess.mockImplementationOnce(
            () =>
              new Promise<CanonicalAccessState>(r => {
                resolve = r;
              }),
          );
          const retry = findPressable(analyze, { label: 'Retry access check' })
            .props.onPress;
          await act(async () => {
            retry();
            retry();
          });
          expect(getAccess).toHaveBeenCalledTimes(2);
          expect(allText(analyze)).toContain('Checking access…');
          expect(mockAnalyzeMounted).not.toHaveBeenCalled();
          expect(findPressable(analyze, { label: 'Cancel' })).toBeTruthy();
          await act(async () => resolve(freeAccess));
          expect(mockAnalyzeMounted).toHaveBeenCalledTimes(1);
          expect(mockAnalyzeMounted).toHaveBeenCalledWith(source);
          expect(navigation.replace).not.toHaveBeenCalled();
          expect(deps.store.configure).toHaveBeenCalledTimes(1);
          expect(deps.store.loadPlans).toHaveBeenCalledTimes(1);
          expect(deps.store.purchase).not.toHaveBeenCalled();
          expect(deps.store.restore).not.toHaveBeenCalled();
          expect(deps.backend.syncBilling).not.toHaveBeenCalled();
        } finally {
          unmount();
        }
      },
    );

    it.each(['camera', 'library'] as const)(
      'cached allowance cannot start %s while a new access check is still pending',
      async source => {
        const deps = billingDependencies();
        configureAccessStore(deps);
        await act(async () => useAccessStore.getState().initialize());
        let resolve!: (value: CanonicalAccessState) => void;
        (deps.backend.getAccess as jest.Mock).mockImplementationOnce(
          () =>
            new Promise<CanonicalAccessState>(r => {
              resolve = r;
            }),
        );
        const refresh = useAccessStore.getState().refreshAccess();
        const navigation = fakeNavigation();
        const { analyze, unmount } = renderAnalyze(navigation, source);
        try {
          expect(mockAnalyzeMounted).not.toHaveBeenCalled();
          expect(allText(analyze)).toContain('Checking access…');
          await act(async () => {
            resolve(freeAccess);
            await refresh;
          });
          expect(mockAnalyzeMounted).toHaveBeenCalledTimes(1);
          expect(mockAnalyzeMounted).toHaveBeenCalledWith(source);
          expect(navigation.replace).not.toHaveBeenCalled();
          expect(deps.store.purchase).not.toHaveBeenCalled();
          expect(deps.store.restore).not.toHaveBeenCalled();
        } finally {
          unmount();
        }
      },
    );

    it('a store-offering failure never blocks a server-verified free allowance', async () => {
      const deps = billingDependencies();
      (deps.store.loadPlans as jest.Mock).mockRejectedValueOnce(
        new Error('store offline'),
      );
      configureAccessStore(deps);
      const navigation = fakeNavigation();
      const { unmount } = renderAnalyze(navigation, 'library');
      try {
        await flushAsync();
        expect(useAccessStore.getState().status).toBe('error');
        expect(mockAnalyzeMounted).toHaveBeenCalledWith('library');
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(deps.store.purchase).not.toHaveBeenCalled();
        expect(deps.store.restore).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    });

    it('a resolved non-paywall denial is recoverable and is not sold as exhausted quota', async () => {
      useAccessStore.setState({
        status: 'ready',
        canonicalAccess: { ...exhaustedAccess, paywallRequired: false },
      });
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      try {
        expect(mockAnalyzeMounted).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(allText(analyze)).toContain('Rating access couldn’t be checked');
        expect(
          findPressable(analyze, { label: 'Retry access check' }),
        ).toBeTruthy();
      } finally {
        unmount();
      }
    });

    it.each(['owner', 'session'] as const)(
      'a changed %s cannot reuse a pending access retry or resume the prior capture intent',
      async changed => {
        const deps = billingDependencies();
        (deps.backend.getAccess as jest.Mock).mockRejectedValueOnce(
          new Error('offline'),
        );
        configureAccessStore(deps);
        const navigation = fakeNavigation();
        const { analyze, unmount } = renderAnalyze(navigation, 'library');
        try {
          await flushAsync();
          let resolve!: (value: CanonicalAccessState) => void;
          (deps.backend.getAccess as jest.Mock).mockImplementationOnce(
            () =>
              new Promise<CanonicalAccessState>(r => {
                resolve = r;
              }),
          );
          const retry = findPressable(analyze, { label: 'Retry access check' })
            .props.onPress;
          await act(async () => retry());
          const nextDeps = billingDependencies();
          await act(async () => {
            if (changed === 'owner') {
              setActiveDataOwner('22222222-2222-4222-8222-222222222222');
            }
            useAuthStore.setState({ session: { ...syncedSession } });
            configureAccessStore(nextDeps);
            retry();
            resolve(freeAccess);
          });
          await flushAsync();
          expect(nextDeps.backend.getAccess).not.toHaveBeenCalled();
          expect(mockAnalyzeMounted).not.toHaveBeenCalled();
          expect(navigation.replace).not.toHaveBeenCalled();
          await press(analyze, { label: 'Cancel' });
          expect(navigation.goBack).toHaveBeenCalledTimes(1);
        } finally {
          unmount();
        }
      },
    );

    it('unmounting during an access retry ignores the response and disables a retained retry handler', async () => {
      const deps = billingDependencies();
      (deps.backend.getAccess as jest.Mock).mockRejectedValueOnce(
        new Error('offline'),
      );
      configureAccessStore(deps);
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation, 'library');
      await flushAsync();
      let resolve!: (value: CanonicalAccessState) => void;
      (deps.backend.getAccess as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<CanonicalAccessState>(r => {
            resolve = r;
          }),
      );
      const retry = findPressable(analyze, { label: 'Retry access check' })
        .props.onPress;
      await act(async () => retry());
      unmount();
      await act(async () => resolve(freeAccess));
      await act(async () => retry());
      expect(deps.backend.getAccess).toHaveBeenCalledTimes(2);
      expect(mockAnalyzeMounted).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(navigation.goBack).not.toHaveBeenCalled();
    });

    it('cancel during an access retry prevents a late success from mounting Analyze', async () => {
      const deps = billingDependencies();
      const getAccess = deps.backend.getAccess as jest.Mock;
      getAccess.mockRejectedValueOnce(new Error('offline'));
      configureAccessStore(deps);
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation, 'library');
      try {
        await flushAsync();
        let resolve!: (value: CanonicalAccessState) => void;
        getAccess.mockImplementationOnce(
          () =>
            new Promise<CanonicalAccessState>(r => {
              resolve = r;
            }),
        );
        await press(analyze, { label: 'Retry access check' });
        await press(analyze, { label: 'Cancel' });
        await act(async () => resolve(freeAccess));
        expect(mockAnalyzeMounted).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.goBack).toHaveBeenCalledTimes(1);
        expect(deps.store.purchase).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    });

    it('a retry that confirms exhaustion keeps the legitimate Paywall path', async () => {
      const deps = billingDependencies({ access: exhaustedAccess });
      (deps.backend.getAccess as jest.Mock).mockRejectedValueOnce(
        new Error('offline'),
      );
      configureAccessStore(deps);
      const navigation = fakeNavigation();
      const { analyze, unmount } = renderAnalyze(navigation);
      try {
        await flushAsync();
        expect(navigation.replace).not.toHaveBeenCalled();
        await press(analyze, { label: 'Retry access check' });
        await flushAsync();
        expect(navigation.replace).toHaveBeenCalledTimes(1);
        expect(navigation.replace).toHaveBeenCalledWith('Paywall', {
          source: 'rating',
        });
        expect(mockAnalyzeMounted).not.toHaveBeenCalled();
        expect(deps.store.purchase).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    });

    it('Home’s real Stroke Analysis button enters the same recoverable gate with its camera source', async () => {
      const deps = billingDependencies();
      (deps.backend.getAccess as jest.Mock).mockRejectedValueOnce(
        new Error('offline'),
      );
      configureAccessStore(deps);
      const root = render(<RootNavigator />);
      const Tabs_ = routeComponent(root, 'Tabs');
      const tabs = render(
        <Tabs_
          navigation={fakeNavigation()}
          route={{ key: 'Tabs-1', name: 'Tabs' }}
        />,
      );
      const Home = tabs.root
        .findAllByType(Tabs.Screen)
        .find(n => n.props.name === 'Home')!.props.component;
      const home = render(<Home />);
      let analyze: Renderer | null = null;
      try {
        await flushAsync();
        await press(home, {
          label:
            'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
        });
        expect(mockScreenNavigation.navigate).toHaveBeenCalledWith('Analyze', {
          source: 'camera',
        });
        const [route, params] = mockScreenNavigation.navigate.mock.calls[0]!;
        const navigation = fakeNavigation();
        analyze = renderRoute(root, route, navigation, params);
        await flushAsync();
        expect(mockAnalyzeMounted).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(allText(analyze)).toContain('Rating access couldn’t be checked');
        await press(analyze, { label: 'Retry access check' });
        await flushAsync();
        expect(mockAnalyzeMounted).toHaveBeenCalledWith('camera');
        expect(deps.store.purchase).not.toHaveBeenCalled();
        expect(deps.store.restore).not.toHaveBeenCalled();
      } finally {
        if (analyze) act(() => analyze!.unmount());
        act(() => home.unmount());
        act(() => tabs.unmount());
        act(() => root.unmount());
      }
    });
  });

  describe('notification press routing', () => {
    it('subscribes on mount, routes Performance/Home presses to the tab, unsubscribes on unmount', () => {
      const unsubscribe = jest.fn();
      mockSubscribeToNotificationPresses.mockReturnValue(unsubscribe);
      const renderer = render(<RootNavigator />);
      expect(mockSubscribeToNotificationPresses).toHaveBeenCalledTimes(1);
      const onPress = mockSubscribeToNotificationPresses.mock.calls[0]![0] as (
        target: 'Home' | 'Performance',
      ) => void;

      act(() => onPress('Performance'));
      expect(navigationRef.navigate).toHaveBeenLastCalledWith('Tabs', {
        screen: 'Performance',
      });
      act(() => onPress('Home'));
      expect(navigationRef.navigate).toHaveBeenLastCalledWith('Tabs', {
        screen: 'Home',
      });
      expect(navigationRef.navigate).toHaveBeenCalledTimes(2);

      // Presses that arrive before the container is ready are dropped, not
      // thrown.
      navigationRef.isReady.mockReturnValue(false);
      act(() => onPress('Performance'));
      expect(navigationRef.navigate).toHaveBeenCalledTimes(2);

      expect(unsubscribe).not.toHaveBeenCalled();
      act(() => renderer.unmount());
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
