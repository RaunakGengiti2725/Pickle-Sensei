/**
 * Adversarial pass — mobile-billing-paywall #4 (pass 3/3), plane cloud.
 * Target: entitlement gating at 4d812e1a — RootNavigator's private
 * `useRatingRouteGate` (via the real AnalyzeRoute) and PremiumTabBar's
 * `openRatingFlow`, both driven by the REAL access store configured with a
 * scripted backend.
 *
 * Assigned scenario S5 (navigation half): cold start with the network down —
 * `getAccess` rejects TypeError('Network request failed') — must leave
 * status==='error' / canonicalAccess===null, the tab-bar camera action must
 * route to Paywall, and once a later `refreshAccess()` returns premium the
 * previously blocked Analyze route must be admitted.
 *
 * The stack navigator is replaced with the same in-test double the existing
 * navigator flow tests use (one registered screen, recording navigation).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

// ─── Navigation doubles ──────────────────────────────────────────────────────

type ScreenEntry = { name: string; component: React.ComponentType<never> };
const mockRegistry: ScreenEntry[] = [];
let mockActiveRoute = 'Analyze';
const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

const mockNavigation = {
  replace: (...args: unknown[]) => mockReplace(...args),
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args),
};

jest.mock('@react-navigation/native-stack', () => {
  const ReactLib = require('react');
  const StackNavigator = (props: { children: React.ReactNode }) => {
    mockRegistry.length = 0;
    ReactLib.Children.forEach(
      props.children,
      (child: React.ReactElement<ScreenEntry>) => {
        if (child) mockRegistry.push(child.props);
      },
    );
    const entry = mockRegistry.find(screen => screen.name === mockActiveRoute);
    if (!entry) throw new Error(`No screen registered for ${mockActiveRoute}`);
    const Component = entry.component as React.ComponentType<{
      navigation: unknown;
      route: unknown;
    }>;
    return ReactLib.createElement(Component, {
      navigation: mockNavigation,
      route: { name: mockActiveRoute, params: undefined },
    });
  };
  const Screen = () => null;
  return {
    createNativeStackNavigator: () => ({ Navigator: StackNavigator, Screen }),
  };
});

jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: () => ({
    Navigator: () => null,
    Screen: () => null,
  }),
}));

jest.mock('@react-navigation/native', () => {
  const ReactLib = require('react');
  return {
    DefaultTheme: { colors: {} },
    NavigationContainer: (props: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, props.children),
    createNavigationContainerRef: () => ({
      isReady: () => false,
      navigate: jest.fn(),
    }),
    useNavigation: () => ({
      navigate: mockNavigate,
      goBack: mockGoBack,
      replace: mockReplace,
    }),
  };
});

// ─── Heavy screens stubbed; Paywall + PremiumTabBar stay real ────────────────

jest.mock('../src/screens/HomeScreen', () => ({
  HomeScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[HomeScreen]');
  },
}));
jest.mock('../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[LibraryScreen]');
  },
}));
jest.mock('../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[ProgressScreen]');
  },
}));
jest.mock('../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[SettingsScreen]');
  },
}));
jest.mock('../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[AnalyzeScreen]');
  },
}));
jest.mock('../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[DrillLibraryScreen]');
  },
}));
jest.mock('../src/screens/ResultScreen', () => ({
  ResultScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[ResultScreen]');
  },
}));
jest.mock('../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[ResultDetailsScreen]',
    );
  },
}));
jest.mock('../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[FormReviewScreen]');
  },
}));
jest.mock('../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[StreakCalendarScreen]',
    );
  },
}));
jest.mock('../src/screens/SignInScreen', () => ({
  SignInScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[SignInScreen]');
  },
}));
jest.mock('../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[ManageAccountScreen]',
    );
  },
}));
jest.mock('../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[ConsentSettingsScreen]',
    );
  },
}));
jest.mock('../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[NotificationSettingsScreen]',
    );
  },
}));
jest.mock('../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          ReactLib.createElement(Component, props),
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0',
    legalTermsUrl: 'https://api.example.test/terms',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    appStoreId: null,
  }),
}));

import {
  type BillingAccessDependencies,
  type BillingStoreClient,
  type CanonicalAccessClient,
  type CanonicalAccessState,
  type StoreEntitlementState,
  type StorePlans,
} from '../src/billing';
import { RootNavigator } from '../src/navigation/RootNavigator';
import { PremiumTabBar } from '../src/navigation/PremiumTabBar';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectPaywallRequired,
  useAccessStore,
} from '../src/state/accessStore';
import { clearApiSession } from '../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
};

const paidAccess: CanonicalAccessState = {
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

const exhaustedAccess: CanonicalAccessState = {
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
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

const noEntitlement: StoreEntitlementState = {
  premium: false,
  productId: null,
  expirationDate: null,
};

type Mocked<T> = { [K in keyof T]: jest.Mock };

function makeDeps(backend: Partial<Mocked<CanonicalAccessClient>>) {
  const store: Mocked<BillingStoreClient> = {
    configure: jest.fn(async () => undefined),
    loadPlans: jest.fn(async () => plans),
    purchase: jest.fn(async () => noEntitlement),
    restore: jest.fn(async () => noEntitlement),
    readEntitlement: jest.fn(async () => noEntitlement),
  };
  const backendMock: Mocked<CanonicalAccessClient> = {
    getAccess: jest.fn(async () => exhaustedAccess),
    syncBilling: jest.fn(async () => {
      throw new Error('unexpected syncBilling');
    }),
    ...backend,
  };
  const deps: BillingAccessDependencies = {
    store: store as unknown as BillingStoreClient,
    backend: backendMock as unknown as CanonicalAccessClient,
  };
  return { deps, store, backend: backendMock };
}

const networkDown = () => new TypeError('Network request failed');

function renderRoute(route: string) {
  mockActiveRoute = route;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function settle(ticks = 4) {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) {
      await new Promise<void>(res => setImmediate(res));
    }
  });
}

// ─── Tab bar harness ─────────────────────────────────────────────────────────

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();

function tabBarProps(): BottomTabBarProps {
  return {
    state: {
      index: 0,
      routes: [
        { key: 'Home-1', name: 'Home' },
        { key: 'Library-1', name: 'Library' },
        { key: 'Add-1', name: 'Add' },
        { key: 'Performance-1', name: 'Performance' },
        { key: 'Settings-1', name: 'Settings' },
      ],
    },
    navigation: {
      emit: jest.fn(() => ({ defaultPrevented: false })),
      navigate: mockTabNavigate,
      getParent: () => ({ navigate: mockRootNavigate }),
    },
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
}

function renderTabBar() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PremiumTabBar {...tabBarProps()} />);
  });
  return renderer;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

/** Camera action from the tab bar: open the coach menu, tap Auto Analyze,
 *  let the close animation (real timers) run out. */
async function tapCamera(renderer: TestRenderer.ReactTestRenderer) {
  await pressByLabel(renderer, 'Open coach actions');
  await pressByLabel(renderer, 'Auto Analyze');
  await act(async () => {
    await new Promise<void>(res => setTimeout(res, 450));
  });
}

let mounted: TestRenderer.ReactTestRenderer[] = [];
function track(renderer: TestRenderer.ReactTestRenderer) {
  mounted.push(renderer);
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
  });
});

afterEach(() => {
  for (const renderer of mounted) act(() => renderer.unmount());
  mounted = [];
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

// ─── S5 — cold start offline ─────────────────────────────────────────────────

describe('S5 — cold start offline: fail closed, then admit after a premium refresh', () => {
  it('Analyze route: offline initialize → error/null → replace(Paywall); premium refresh → Analyze mounts without a second navigation', async () => {
    const { deps, backend, store } = makeDeps({
      getAccess: jest.fn(async () => {
        throw networkDown();
      }),
    });
    configureAccessStore(deps);

    const renderer = track(renderRoute('Analyze'));
    expect(allText(renderer)).toContain('Checking access…');
    await settle();

    const offline = useAccessStore.getState();
    expect(offline.status).toBe('error');
    expect(offline.canonicalAccess).toBeNull();
    expect(offline.error).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
    expect(selectPaywallRequired(offline)).toBe(true);
    expect(backend.getAccess).toHaveBeenCalledTimes(1);
    // initialize() drives store configure + loadPlans alongside the GET even
    // when the GET fails — plans are still usable on the paywall.
    expect(store.loadPlans).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(allText(renderer)).not.toContain('[AnalyzeScreen]');

    // Network returns; the app refreshes (Settings focus) and the server says
    // premium. The still-mounted gate must flip to admitted and never emit a
    // second Paywall replace.
    backend.getAccess.mockImplementation(async () => paidAccess);
    let refreshed!: boolean;
    await act(async () => {
      refreshed = await useAccessStore.getState().refreshAccess();
    });
    await settle();
    expect(refreshed).toBe(true);
    const online = useAccessStore.getState();
    expect(online.status).toBe('ready');
    expect(online.canonicalAccess).toEqual(paidAccess);
    expect(online.error).toBeNull();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('[AnalyzeScreen]');
    expect(allText(renderer)).not.toContain('Checking access…');
  });

  it('a fresh Analyze mount after the premium refresh is admitted without any redirect and without re-initializing', async () => {
    const { deps, backend } = makeDeps({
      getAccess: jest.fn(async () => {
        throw networkDown();
      }),
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('error');

    backend.getAccess.mockImplementation(async () => paidAccess);
    await useAccessStore.getState().refreshAccess();

    const renderer = track(renderRoute('Analyze'));
    await settle();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain('[AnalyzeScreen]');
    expect(backend.getAccess).toHaveBeenCalledTimes(2);
  });

  it('an offline refresh AFTER a verified free snapshot fails closed again (null, error) and the gate blocks', async () => {
    const { deps, backend } = makeDeps({
      getAccess: jest.fn(async () => ({
        ...exhaustedAccess,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 0,
          remaining: 1,
          availableToReserve: 1,
        },
        canStartRating: true,
        paywallRequired: false,
      })),
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const renderer = track(renderRoute('Analyze'));
    await settle();
    expect(allText(renderer)).toContain('[AnalyzeScreen]');
    expect(mockReplace).not.toHaveBeenCalled();

    backend.getAccess.mockImplementation(async () => {
      throw networkDown();
    });
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    await settle();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('error');
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(allText(renderer)).not.toContain('[AnalyzeScreen]');
  });

  it('tab bar camera: offline → Paywall {source:"rating"}; after premium refresh → Analyze {source:"camera"}', async () => {
    const { deps, backend } = makeDeps({
      getAccess: jest.fn(async () => {
        throw networkDown();
      }),
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('error');

    const bar = track(renderTabBar());
    await tapCamera(bar);
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });

    backend.getAccess.mockImplementation(async () => paidAccess);
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    mockRootNavigate.mockClear();
    await tapCamera(bar);
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
  });

  it('tab bar camera while the cold-start GET is still in flight defers to the Analyze gate (never opens the camera on null access)', async () => {
    let release!: () => void;
    const pending = new Promise<CanonicalAccessState>((_, reject) => {
      release = () => reject(networkDown());
    });
    const { deps } = makeDeps({ getAccess: jest.fn(() => pending) });
    configureAccessStore(deps);
    const initializing = useAccessStore.getState().initialize();
    await settle(1);
    expect(useAccessStore.getState().status).toBe('loading');

    const bar = track(renderTabBar());
    await tapCamera(bar);
    // While loading the tab bar hands off to the Analyze route...
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    // ...whose gate keeps the camera behind "Checking access…" until the
    // store settles, and then sends it to the paywall when the GET fails.
    const analyze = track(renderRoute('Analyze'));
    expect(allText(analyze)).toContain('Checking access…');
    expect(allText(analyze)).not.toContain('[AnalyzeScreen]');
    await act(async () => {
      release();
      await initializing;
    });
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(allText(analyze)).not.toContain('[AnalyzeScreen]');
  });

  it('a local-only (guest) session is sent to ConnectAccount by both gates and never touches the backend', async () => {
    useAuthStore.setState({
      hydrated: true,
      busy: false,
      error: null,
      session: {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    const { deps, backend } = makeDeps({});
    configureAccessStore(deps);

    const bar = track(renderTabBar());
    await tapCamera(bar);
    expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');

    const analyze = track(renderRoute('Analyze'));
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('ConnectAccount');
    expect(mockReplace).not.toHaveBeenCalledWith('Paywall', expect.anything());
    expect(backend.getAccess).not.toHaveBeenCalled();
    expect(allText(analyze)).not.toContain('[AnalyzeScreen]');
  });
});

// ─── extra — unconfigured store (no dependencies) ────────────────────────────

describe('extra — gate with NO billing configuration', () => {
  it('Analyze route on an unconfigured store initializes once, lands on unconfigured, and routes to Paywall', async () => {
    const renderer = track(renderRoute('Analyze'));
    await settle();
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(allText(renderer)).not.toContain('[AnalyzeScreen]');
  });

  it('a corrupt in-memory snapshot (canonicalAccess with canStartRating:false but premium:true) is still blocked by the gate', async () => {
    // Direct state injection: the gate reads canStartRating only, so a
    // premium flag alone must never open the camera.
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: { ...paidAccess, canStartRating: false },
    });
    const renderer = track(renderRoute('Analyze'));
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(allText(renderer)).not.toContain('[AnalyzeScreen]');
  });
});
