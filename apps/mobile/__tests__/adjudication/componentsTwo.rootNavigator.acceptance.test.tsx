/**
 * ADJUDICATION acceptance pins — stress area `components-2`, navigation.
 *
 * Every test states the INTENDED behaviour as a plain `it` and is RED on the
 * baseline 1fb0efd7 (independently reproduced from the tester's attack
 * branch `devin/stress-cmp-navigation-rapid-interaction`, seeds 3986518828
 * and 3036828500). They go green once RootNavigator is fixed:
 *
 *   C2-NAV-1  notification routing must land on the ONE existing Tabs host
 *             (navigationRef.navigate('Tabs', …) from a pushed route pushes a
 *             second MainTabs → two PremiumTabBars mount).
 *   C2-NAV-2  useRatingRouteGate / the local-only gate must act on the route
 *             that OWNS the effect (Analyze), never on whichever route is
 *             focused (navigation.replace without `target` replaces the
 *             covering Paywall/Result and leaves Analyze orphaned).
 *   C2-NAV-3  Paywall onClose delivered twice must pop exactly one screen
 *             (bare navigation.goBack() from an already-popped route pops the
 *             screen underneath).
 *
 * Real React Navigation 7 router; only the screens are stubbed.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const shared = actual.createNavigationContainerRef();
  return { ...actual, createNavigationContainerRef: () => shared };
});

const stubScreen = (name: string) =>
  Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: name },
  );
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: stubScreen('HomeScreen'),
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: stubScreen('LibraryScreen'),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: stubScreen('ProgressScreen'),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: stubScreen('SettingsScreen'),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: stubScreen('AnalyzeScreen'),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: stubScreen('DrillLibraryScreen'),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: stubScreen('ResultScreen'),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: stubScreen('ResultDetailsScreen'),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: stubScreen('FormReviewScreen'),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: stubScreen('StreakCalendarScreen'),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: stubScreen('PaywallScreen'),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: stubScreen('SignInScreen'),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: stubScreen('ManageAccountScreen'),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: stubScreen('ConsentSettingsScreen'),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: stubScreen('NotificationSettingsScreen'),
}));

let mockNotificationPress: ((target: 'Home' | 'Performance') => void) | null =
  null;
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: (
    cb: (target: 'Home' | 'Performance') => void,
  ) => {
    mockNotificationPress = cb;
    return () => {
      mockNotificationPress = null;
    };
  },
}));

type AccessStatus = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
type MockAccessState = {
  status: AccessStatus;
  canonicalAccess: { canStartRating: boolean } | null;
  initialize: () => Promise<void>;
};
jest.mock('../../src/state/accessStore', () => {
  const { create } = require('zustand');
  return {
    useAccessStore: create(() => ({
      status: 'ready',
      canonicalAccess: { canStartRating: true },
      initialize: async () => {},
    })),
  };
});
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
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    legalTermsUrl: 'https://api.example.test/terms',
    legalPrivacyUrl: 'https://api.example.test/privacy',
  }),
}));

import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  createNavigationContainerRef,
  type NavigationState,
} from '@react-navigation/native';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import type { RootStackParams } from '../../src/navigation/params';

const navigationRef = createNavigationContainerRef<RootStackParams>();
const useMockAccessStore = (
  jest.requireMock('../../src/state/accessStore') as {
    useAccessStore: UseBoundStore<StoreApi<MockAccessState>>;
  }
).useAccessStore;
const useMockAuthStore = (
  jest.requireMock('../../src/auth/authStore') as {
    useAuthStore: UseBoundStore<StoreApi<MockAuthState>>;
  }
).useAuthStore;
type ScreenStub = jest.Mock<null, [Record<string, unknown>]>;
const PaywallScreen = (
  jest.requireMock('../../src/screens/PaywallScreen') as {
    PaywallScreen: ScreenStub;
  }
).PaywallScreen;
const AnalyzeScreen = (
  jest.requireMock('../../src/screens/AnalyzeScreen') as {
    AnalyzeScreen: ScreenStub;
  }
).AnalyzeScreen;

type Renderer = TestRenderer.ReactTestRenderer;

function rootState(): NavigationState<RootStackParams> {
  return navigationRef.getRootState() as NavigationState<RootStackParams>;
}
function names(): string[] {
  return rootState().routes.map(r => r.name);
}
function focusedKey(): string {
  const state = rootState();
  return state.routes[state.index]!.key;
}
function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(t =>
      Array.isArray(t.props.children)
        ? t.props.children.join('')
        : String(t.props.children ?? ''),
    )
    .join('|');
}
function insideModal(node: TestRenderer.ReactTestInstance): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === Modal) return true;
  return false;
}
/** Outermost pressables carrying the coach-menu toggle label — one per
 * mounted PremiumTabBar. */
function tabBarHosts(renderer: Renderer) {
  const all = renderer.root.findAll(
    n =>
      (n.props.accessibilityLabel === 'Open coach actions' ||
        n.props.accessibilityLabel === 'Close coach actions') &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityState?.expanded !== undefined &&
      !insideModal(n),
  );
  const set = new Set(all);
  return all.filter(node => {
    for (let p = node.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}
function navigate(route: keyof RootStackParams, params?: unknown) {
  (navigationRef.navigate as (name: string, params?: unknown) => void)(
    route,
    params,
  );
}

let renderer: Renderer;
let consoleErrors: string[];
let originalError: typeof console.error;

beforeEach(() => {
  jest.useFakeTimers();
  PaywallScreen.mockClear();
  AnalyzeScreen.mockClear();
  useMockAccessStore.setState({
    status: 'ready',
    canonicalAccess: { canStartRating: true },
    initialize: async () => {},
  });
  useMockAuthStore.setState({
    session: { provider: 'apple', localOnly: false },
  });
  consoleErrors = [];
  originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  act(() => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  console.error = originalError;
  jest.useRealTimers();
});

describe('components-2 adjudication: RootNavigator acceptance (RED on 1fb0efd7)', () => {
  it('C2-NAV-1: a reminder press while a screen is pushed returns to the ONE existing Tabs host', () => {
    act(() => navigate('DrillLibrary'));
    expect(names()).toEqual(['Tabs', 'DrillLibrary']);
    act(() => mockNotificationPress!('Performance'));
    expect(names()).toEqual(['Tabs']);
    expect(tabBarHosts(renderer)).toHaveLength(1);
    const tabs = rootState().routes[0]!.state!;
    expect(tabs.routes[tabs.index!]!.name).toBe('Performance');
    expect(consoleErrors).toEqual([]);
  });

  it('C2-NAV-1b: two reminder presses in one frame while a screen is pushed still leave exactly one Tabs host', () => {
    act(() => navigate('StreakCalendar'));
    act(() => {
      mockNotificationPress!('Home');
      mockNotificationPress!('Performance');
    });
    expect(names().filter(n => n === 'Tabs')).toHaveLength(1);
    expect(tabBarHosts(renderer)).toHaveLength(1);
  });

  it('C2-NAV-2: access flipping to a non-startable state while Analyze is covered by Paywall must not orphan Analyze nor re-create the covering Paywall', () => {
    act(() => navigate('Analyze', { source: 'camera' }));
    expect(AnalyzeScreen).toHaveBeenCalled();
    act(() => navigate('Paywall', { source: 'rating' }));
    expect(names()).toEqual(['Tabs', 'Analyze', 'Paywall']);
    const paywallKey = focusedKey();
    act(() => {
      useMockAccessStore.setState({ status: 'error', canonicalAccess: null });
    });
    expect(allText(renderer)).not.toContain('Checking access…');
    expect(focusedKey()).toBe(paywallKey);
    expect(names()).not.toContain('Analyze');
    expect(consoleErrors).toEqual([]);
  });

  it('C2-NAV-2b: the session becoming local-only while Analyze is covered by Result must replace ANALYZE, not the focused Result', () => {
    act(() => navigate('Analyze', { source: 'library' }));
    act(() => navigate('Result', { analysisId: 'a-1' }));
    expect(names()).toEqual(['Tabs', 'Analyze', 'Result']);
    act(() => {
      useMockAuthStore.setState({
        session: { provider: 'guest', localOnly: true },
      });
    });
    expect(names()).toEqual(['Tabs', 'ConnectAccount', 'Result']);
  });

  it('C2-NAV-3: Paywall onClose delivered twice in one frame pops exactly one screen', () => {
    act(() => navigate('Analyze', { source: 'camera' }));
    act(() => navigate('Paywall', { source: 'rating' }));
    const props = PaywallScreen.mock.calls.at(-1)![0];
    act(() => {
      (props.onClose as () => void)();
      (props.onClose as () => void)();
    });
    expect(names()).toEqual(['Tabs', 'Analyze']);
    expect(consoleErrors).toEqual([]);
  });
});
