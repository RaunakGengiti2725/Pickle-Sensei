/**
 * Guest / local-only flow — RootNavigator's rating gate and the
 * ConnectAccount route, exercised through the real route components.
 *
 * `useRatingRouteGate` is private to RootNavigator, so the stack navigator is
 * replaced with a tiny in-test double that renders ONE registered screen with
 * a recording `navigation` prop. Everything else (the gate's effect, the
 * LoadingState placeholder, ConnectAccountRoute's auto-dismiss, PaywallRoute's
 * legal links) is production code.
 *
 * Invariants pinned:
 *   - a guest landing on Analyze is `replace`d to ConnectAccount BEFORE the
 *     access store is initialized (no billing/API call, no 401, no spinner
 *     left behind);
 *   - a canonical session without access is initialized once and then sent
 *     to Paywall {source:'rating'} — the "Checking access…" placeholder never
 *     becomes a permanent state, including on `error`/`unconfigured`;
 *   - ConnectAccount pops itself the moment a non-guest provider appears, and
 *     its Back button pops it for a guest who changes their mind;
 *   - PaywallRoute wires close/purchase to goBack and exposes real legal links.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// ─── Navigation doubles ──────────────────────────────────────────────────────

type ScreenEntry = { name: string; component: React.ComponentType<never> };
const mockRegistry: ScreenEntry[] = [];
let mockActiveRoute = 'Analyze';
const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

// React Navigation hands screens a STABLE navigation object; the double must
// too, otherwise effects keyed on it would re-fire on every render.
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

// ─── Heavy screens stubbed; SignIn and Paywall stay real ─────────────────────

jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[HomeScreen]');
  },
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[LibraryScreen]');
  },
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[ProgressScreen]');
  },
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[SettingsScreen]');
  },
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[AnalyzeScreen]');
  },
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[DrillLibraryScreen]');
  },
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(RNText, null, '[ResultScreen]');
  },
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[StreakCalendarScreen]',
    );
  },
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[ManageAccountScreen]',
    );
  },
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[ConsentSettingsScreen]',
    );
  },
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => {
    const { Text: RNText } = require('react-native');
    return require('react').createElement(
      RNText,
      null,
      '[NotificationSettingsScreen]',
    );
  },
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));

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
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../src/config/runtimeConfig', () => ({
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

import { Linking } from 'react-native';
import type { CanonicalAccessState } from '../../src/billing/types';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAccessStore } from '../../src/state/accessStore';
import { clearApiSession } from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

function access(remaining: number): CanonicalAccessState {
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

function setSession(session: AuthSession | null) {
  setActiveDataOwner(
    session?.localOnly ? GUEST_DATA_OWNER : SIGNED_OUT_DATA_OWNER,
  );
  useAuthStore.setState({ hydrated: true, session, busy: false, error: null });
}

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

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  const innermost = matches.filter(
    match =>
      !matches.some(
        other => other !== match && match.findAll(n => n === other).length > 0,
      ),
  );
  if (innermost.length === 0) throw new Error(`No pressable labeled ${label}`);
  return innermost[0]!;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  clearApiSession();
  useAccessStore.getState().reset();
  globalThis.fetch = jest
    .fn()
    .mockRejectedValue(
      new Error('no network in test'),
    ) as unknown as typeof fetch;
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = realFetch;
});

// ─── Analyze route gate ──────────────────────────────────────────────────────

describe('RootNavigator Analyze gate (useRatingRouteGate) — guest', () => {
  it('replaces Analyze with ConnectAccount for a guest, before any access/billing/API work', async () => {
    setSession(guestSession);
    const initializeSpy = jest.spyOn(useAccessStore.getState(), 'initialize');
    const renderer = renderRoute('Analyze');
    await settle();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('ConnectAccount');
    expect(mockReplace).not.toHaveBeenCalledWith('Paywall', expect.anything());
    expect(initializeSpy).not.toHaveBeenCalled();
    expect(useAccessStore.getState().status).toBe('idle');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // The Analyze camera never mounts for a guest.
    expect(allText(renderer)).not.toContain('[AnalyzeScreen]');
    initializeSpy.mockRestore();
    act(() => renderer.unmount());
  });

  it('a guest who gets an access state injected later is still redirected, never given the camera', async () => {
    setSession(guestSession);
    const renderer = renderRoute('Analyze');
    await settle();
    act(() => {
      useAccessStore.setState({ status: 'ready', canonicalAccess: access(2) });
    });
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('ConnectAccount');
    expect(mockReplace).not.toHaveBeenCalledWith('Paywall', expect.anything());
    act(() => renderer.unmount());
  });
});

describe('RootNavigator Analyze gate — canonical sessions (no infinite "Checking access…")', () => {
  it('initializes once, then routes an unconfigured account to Paywall {source:"rating"}', async () => {
    setSession(syncedSession);
    const renderer = renderRoute('Analyze');
    expect(allText(renderer)).toContain('Checking access…');
    await settle();

    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    expect(mockReplace).not.toHaveBeenCalledWith('ConnectAccount');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('an access-store error also leaves the placeholder: Paywall, not a spinner', async () => {
    setSession(syncedSession);
    useAccessStore.setState({
      status: 'error',
      canonicalAccess: null,
      error: {
        code: 'billing.backend_unavailable',
        message: 'Access could not be verified.',
        retryable: true,
      },
    });
    const renderer = renderRoute('Analyze');
    await settle();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    act(() => renderer.unmount());
  });

  it('a session out of free ratings goes to the paywall; one with ratings left mounts Analyze', async () => {
    setSession(syncedSession);
    useAccessStore.setState({ status: 'ready', canonicalAccess: access(0) });
    const exhausted = renderRoute('Analyze');
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('Paywall', { source: 'rating' });
    act(() => exhausted.unmount());

    mockReplace.mockClear();
    useAccessStore.setState({ status: 'ready', canonicalAccess: access(1) });
    const allowed = renderRoute('Analyze');
    await settle();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(allText(allowed)).toContain('[AnalyzeScreen]');
    act(() => allowed.unmount());
  });
});

// ─── ConnectAccount route ────────────────────────────────────────────────────

describe('RootNavigator ConnectAccount route', () => {
  it('renders the real sign-in screen for a guest; Back pops the route', async () => {
    setSession(guestSession);
    const renderer = renderRoute('ConnectAccount');
    await settle();

    expect(allText(renderer)).toContain(
      'A connected account is required for free ratings',
    );
    expect(mockGoBack).not.toHaveBeenCalled();
    const back = pressable(renderer, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    await act(async () => {
      back.props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('pops itself as soon as a canonical provider replaces the guest session', async () => {
    setSession(guestSession);
    const renderer = renderRoute('ConnectAccount');
    await settle();
    expect(mockGoBack).not.toHaveBeenCalled();

    act(() => {
      setSession(syncedSession);
    });
    await settle();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('does not pop for a guest who cancels sign-in (session stays guest)', async () => {
    setSession(guestSession);
    const renderer = renderRoute('ConnectAccount');
    await settle();
    act(() => {
      useAuthStore.setState({
        busy: false,
        error: null,
        session: guestSession,
      });
    });
    await settle();
    expect(mockGoBack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

// ─── Paywall route ───────────────────────────────────────────────────────────

describe('RootNavigator Paywall route', () => {
  it('Close pops the paywall; pricing page exposes real Terms/Privacy links (3.1.2)', async () => {
    setSession(syncedSession);
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const renderer = renderRoute('Paywall');
    await settle();

    // Unconfigured billing in this test: the paywall still renders and stays
    // dismissible rather than spinning.
    expect(useAccessStore.getState().status).toBe('unconfigured');
    const close = pressable(renderer, 'Close membership offer');
    expect(close.props.accessibilityRole).toBe('button');
    await act(async () => {
      close.props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      pressable(renderer, 'See membership plans').props.onPress();
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });
    const terms = pressable(renderer, 'Terms of use');
    const privacy = pressable(renderer, 'Privacy policy');
    expect(terms.props.accessibilityRole).toBe('link');
    expect(privacy.props.accessibilityRole).toBe('link');
    await act(async () => {
      terms.props.onPress();
      privacy.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledWith('https://api.example.test/terms');
    expect(openUrl).toHaveBeenCalledWith('https://api.example.test/privacy');
    openUrl.mockRestore();
    act(() => renderer.unmount());
  });
});
