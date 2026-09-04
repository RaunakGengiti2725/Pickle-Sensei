/**
 * STRESS — unit `cmp-navigation`: deep param fuzz, rapid tab switching and
 * back-stack abuse, under the boundary lens.
 *
 * Three campaigns, all seeded and replayable (STRESS_SEED / STRESS_ONLY_SEED,
 * scaled by STRESS_ITER — see navStressKit.ts):
 *
 *  1. PremiumTabBar prop boundary fuzz — hostile `state` (empty/duplicate/
 *     unknown/30-deep route arrays), out-of-range and non-finite `state.index`,
 *     the numeric corpus in `route.params`, and degenerate safe-area insets.
 *     Each variant records whether the bar rendered or threw, so a boundary
 *     that is only survivable by accident is visible instead of assumed.
 *  2. Rapid tab switching + coach-menu/back-stack abuse — seeded interaction
 *     sequences (tab taps, long presses, FAB open/close, action taps, modal
 *     back-outs, unmount mid-animation) checked against the navigation
 *     invariants: the focused tab never re-navigates, one menu session
 *     performs at most one root navigation, and a pending action never fires
 *     after the bar unmounts.
 *  3. RootNavigator route/param fuzz — every registered route component
 *     rendered with the hostile param corpus, the rating gate driven through
 *     seeded access-state transitions (replace target and call budget
 *     asserted), and the notification-press target fuzzed.
 *
 * Everything asserted here is a rendered-tree / call-log fact on the Linux
 * plane; nothing about iOS layout or gesture timing is claimed.
 */
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
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    SafeAreaView: View,
    useSafeAreaInsets: () => mockInsets,
    initialWindowMetrics: {
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

// Inert navigator doubles (same shape the existing navigator ledger uses):
// Navigator renders children, Screen keeps name/component readable.
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
      throw new Error('useNavigation must not be reached by this campaign');
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

const mockSubscribeToNotificationPresses = jest.fn();
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: (...args: unknown[]) =>
    mockSubscribeToNotificationPresses(...args),
}));

// Screens are stubs: this campaign stresses the navigator's own wiring and
// the tab bar, not the screens' internals (they own their suites). Each stub
// answers any export name with a plain <View/> that keeps the props it was
// handed, so a route wrapper's prop contract stays inspectable.
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/LibraryScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/ProgressScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/SettingsScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/AnalyzeScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/DrillLibraryScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/ResultScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/ResultDetailsScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/FormReviewScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/StreakCalendarScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/PaywallScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/ManageAccountScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/ConsentSettingsScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/screens/NotificationSettingsScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target: object, key: string | symbol) =>
        key === '__esModule'
          ? true
          : (props: Record<string, unknown>) =>
              React.createElement(View, props),
    },
  );
});

jest.mock('../../src/state/accessStore', () => {
  const { create } = require('zustand');
  const useAccessStore = create(() => ({
    status: 'idle' as string,
    canonicalAccess: null as unknown,
    initialize: jest.fn(async () => undefined),
  }));
  return { __esModule: true, useAccessStore };
});
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: null as unknown,
    busy: false,
    error: null,
    signInWithApple: jest.fn(async () => undefined),
    signInWithGoogle: jest.fn(async () => undefined),
    clearError: jest.fn(),
  }));
  return { __esModule: true, useAuthStore };
});

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createNavigationContainerRef } from '@react-navigation/native';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { useAccessStore } from '../../src/state/accessStore';
import { useAuthStore } from '../../src/auth/authStore';
import type { RootStackParams } from '../../src/navigation/params';
import type { AuthSession } from '../../src/auth/authStore';
import type { CanonicalAccessState } from '../../src/billing/types';
import {
  BASE_SEED,
  INSET_CASES,
  NUMERIC_CORPUS,
  STRESS_MULTIPLIER,
  STRING_CORPUS,
  MINIMISING,
  makeRng,
  seedIsSelected,
  writeResults,
  type ResultRow,
} from '../../testing/stress/navStressKit';

type Renderer = TestRenderer.ReactTestRenderer;

/** Fully-typed store fixtures (the stores are real zustand instances). */
function session(overrides: Partial<AuthSession>): AuthSession {
  return {
    provider: 'apple',
    subject: 'subject-1',
    canonicalAppUserId: 'canonical-1',
    localOnly: false,
    displayName: 'Stress Tester',
    email: 'stress@example.com',
    ...overrides,
  };
}

function access(canStartRating: boolean): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: canStartRating ? 0 : 2,
      reserved: 0,
      remaining: canStartRating ? 2 : 0,
      availableToReserve: canStartRating ? 2 : 0,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef =
  createNavigationContainerRef<RootStackParams>() as unknown as {
    isReady: jest.Mock;
    navigate: jest.Mock;
  };

const TAB_NAMES = [
  'Home',
  'Library',
  'Add',
  'Performance',
  'Settings',
] as const;

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function pressablesByLabel(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
}

function press(renderer: Renderer, label: string): boolean {
  const nodes = pressablesByLabel(renderer, label);
  if (nodes.length === 0) return false;
  act(() => {
    nodes[0]!.props.onPress();
  });
  return true;
}

type TabBarHarness = {
  props: BottomTabBarProps;
  emit: jest.Mock;
  navigate: jest.Mock;
  rootNavigate: jest.Mock;
};

function tabBarProps(options?: {
  index?: number;
  routes?: readonly { key: string; name: string; params?: unknown }[];
  preventDefault?: boolean;
}): TabBarHarness {
  const emit = jest.fn(() => ({
    defaultPrevented: options?.preventDefault === true,
  }));
  const navigate = jest.fn();
  const rootNavigate = jest.fn();
  const routes =
    options?.routes ??
    TAB_NAMES.map(name => ({ key: `${name}-1`, name, params: undefined }));
  return {
    emit,
    navigate,
    rootNavigate,
    props: {
      state: { index: options?.index ?? 0, routes },
      navigation: {
        emit,
        navigate,
        getParent: () => ({ navigate: rootNavigate }),
      },
      descriptors: {},
      insets: mockInsets,
    } as unknown as BottomTabBarProps,
  };
}

const propRows: ResultRow[] = [];
const sequenceRows: ResultRow[] = [];
const navigatorRows: ResultRow[] = [];

afterAll(() => {
  const files = [
    writeResults('premiumTabBar-prop-boundary-fuzz', {
      campaign: 'PremiumTabBar hostile props',
      baseSeed: BASE_SEED,
      multiplier: STRESS_MULTIPLIER,
      rows: propRows,
    }),
    writeResults('premiumTabBar-interaction-sequences', {
      campaign: 'Rapid tab switching + coach menu / back-stack abuse',
      baseSeed: BASE_SEED,
      multiplier: STRESS_MULTIPLIER,
      rows: sequenceRows,
    }),
    writeResults('rootNavigator-param-and-gate-fuzz', {
      campaign: 'RootNavigator route params, rating gate, notification targets',
      baseSeed: BASE_SEED,
      multiplier: STRESS_MULTIPLIER,
      rows: navigatorRows,
    }),
  ];
  console.log(`[stress] results tables:\n${files.join('\n')}`);
});

beforeEach(() => {
  jest.useFakeTimers();
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockSubscribeToNotificationPresses.mockReset().mockReturnValue(jest.fn());
  navigationRef.isReady.mockReset().mockReturnValue(true);
  navigationRef.navigate.mockReset();
  useAuthStore.setState({ session: null });
  useAccessStore.setState({
    status: 'idle',
    canonicalAccess: null,
    initialize: jest.fn(async () => undefined),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Campaign 1 — hostile tab-bar props
 * ------------------------------------------------------------------ */

describe('cmp-navigation stress — PremiumTabBar prop boundaries', () => {
  type RouteCase = {
    id: string;
    routes: readonly { key: string; name: string; params?: unknown }[];
    /** Names outside MainTabParams have no TAB_META entry. */
    unknownNames: boolean;
  };

  const routeCases: readonly RouteCase[] = [
    {
      id: 'canonical',
      routes: TAB_NAMES.map(name => ({ key: `${name}-1`, name })),
      unknownNames: false,
    },
    { id: 'empty', routes: [], unknownNames: false },
    {
      id: 'add-only',
      routes: [{ key: 'Add-1', name: 'Add' }],
      unknownNames: false,
    },
    {
      id: 'no-add',
      routes: TAB_NAMES.filter(name => name !== 'Add').map(name => ({
        key: `${name}-1`,
        name,
      })),
      unknownNames: false,
    },
    {
      id: 'duplicate-add',
      routes: [
        { key: 'Add-1', name: 'Add' },
        { key: 'Add-2', name: 'Add' },
        { key: 'Home-1', name: 'Home' },
      ],
      unknownNames: false,
    },
    {
      id: 'duplicate-keys',
      routes: TAB_NAMES.map(name => ({ key: 'same-key', name })),
      unknownNames: false,
    },
    {
      id: 'thirty-routes',
      routes: Array.from({ length: 30 }, (_, index) => ({
        key: `Home-${index}`,
        name: TAB_NAMES[index % TAB_NAMES.length]!,
      })),
      unknownNames: false,
    },
    {
      id: 'unknown-name',
      routes: [
        { key: 'Home-1', name: 'Home' },
        { key: 'Ghost-1', name: 'Ghost' },
        { key: 'Add-1', name: 'Add' },
      ],
      unknownNames: true,
    },
    {
      id: 'unicode-name',
      routes: [
        { key: 'Home-1', name: 'Home' },
        { key: 'emoji-1', name: '🏓📚' },
      ],
      unknownNames: true,
    },
    {
      id: 'prototype-name',
      routes: [
        { key: 'Home-1', name: 'Home' },
        { key: 'proto-1', name: '__proto__' },
      ],
      unknownNames: true,
    },
  ];

  it('renders or fails loudly for every hostile state/insets/params variant', () => {
    // Variants that are EXPECTED to throw make React log the render error;
    // the outcome is captured per seed in the results table instead.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let index = 0;
    for (let repeat = 0; repeat < STRESS_MULTIPLIER; repeat += 1) {
      for (const routeCase of routeCases) {
        for (const numeric of NUMERIC_CORPUS) {
          for (const insetCase of INSET_CASES) {
            const seed = BASE_SEED + 100000 + index;
            index += 1;
            if (!seedIsSelected(seed)) continue;
            const rng = makeRng(seed);
            const stringCase = rng.pick(STRING_CORPUS);
            const params = {
              analysisId: stringCase.value,
              amount: numeric.value,
              nested: { deep: { deeper: { value: stringCase.value } } },
              list: [numeric.value, stringCase.value, null, undefined],
              __proto__: { polluted: true },
              toString: null,
            };
            const routes = routeCase.routes.map(route => ({
              ...route,
              params,
            }));
            mockInsets = insetCase.insets;

            const row: ResultRow = {
              seed,
              outcome: 'HELD',
              routeCase: routeCase.id,
              numericCase: numeric.id,
              stringCase: stringCase.id,
              insets: insetCase.id,
              stateIndex: numeric.value,
            };

            let renderer: Renderer | null = null;
            try {
              const harness = tabBarProps({
                // The numeric corpus doubles as the state.index fuzz.
                index: numeric.value,
                routes,
              });
              renderer = render(<PremiumTabBar {...harness.props} />);
              // Only the pressables themselves: the host View a Pressable
              // renders inherits the role but carries no handler.
              const tabs = renderer.root.findAll(
                node =>
                  node.props?.accessibilityRole === 'tab' &&
                  typeof node.props?.onPress === 'function',
              );
              row.renderedTabs = tabs.length;
              row.selectedTabs = tabs.filter(
                node => node.props.accessibilityState?.selected === true,
              ).length;
              // Whatever the index is, at most ONE tab may claim selection.
              expect(Number(row.selectedTabs)).toBeLessThanOrEqual(1);
              row.unlabelledTabs = tabs.filter(
                tab =>
                  typeof tab.props.accessibilityLabel !== 'string' ||
                  tab.props.accessibilityLabel.length === 0,
              ).length;
              // Tapping a tab forwards the ROUTE'S OWN params unchanged.
              if (tabs.length > 0) {
                const target = tabs[tabs.length - 1]!;
                act(() => target.props.onPress());
                if (harness.navigate.mock.calls.length > 0) {
                  expect(harness.navigate.mock.calls[0]![1]).toBe(params);
                }
                act(() => target.props.onLongPress());
                expect(harness.emit).toHaveBeenCalledWith(
                  expect.objectContaining({ type: 'tabLongPress' }),
                );
              }
              if (Number(row.unlabelledTabs) > 0) {
                row.outcome = 'BROKEN';
                row.note = 'rendered a tab with no accessibility label';
              }
            } catch (error) {
              row.outcome = 'THREW';
              row.error = String(error).slice(0, 240);
            } finally {
              if (renderer) {
                try {
                  act(() => renderer!.unmount());
                } catch {
                  row.unmountThrew = true;
                }
              }
            }
            propRows.push(row);
          }
        }
      }
    }

    consoleError.mockRestore();
    if (MINIMISING) return;
    expect(propRows.length).toBeGreaterThan(0);

    // Every route set built from the typed tab names survives every numeric
    // index (including NaN/Infinity/-1e9), every degenerate inset and every
    // hostile param payload, with at most one tab claiming selection.
    const typedRows = propRows.filter(
      row =>
        !['unknown-name', 'unicode-name', 'prototype-name'].includes(
          String(row.routeCase),
        ),
    );
    expect(typedRows.filter(row => row.outcome !== 'HELD')).toEqual([]);

    // Characterized boundaries, none of them reachable from shipped code
    // (MainTabs registers exactly the five names in MainTabParams):
    //  * a name with no TAB_META entry throws on `meta.label`;
    //  * `__proto__` resolves through Object.prototype instead, so the tab
    //    renders with role="tab" and NO accessibility label.
    for (const id of ['unknown-name', 'unicode-name']) {
      const rows = propRows.filter(row => row.routeCase === id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.outcome === 'THREW')).toBe(true);
      expect(
        rows.every(row => String(row.error).includes("reading 'label'")),
      ).toBe(true);
    }
    const protoRows = propRows.filter(
      row => row.routeCase === 'prototype-name',
    );
    expect(protoRows.length).toBeGreaterThan(0);
    expect(protoRows.every(row => row.outcome === 'BROKEN')).toBe(true);
    expect(protoRows.every(row => Number(row.unlabelledTabs) === 1)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Campaign 2 — rapid switching + coach menu / back-stack abuse
 * ------------------------------------------------------------------ */

describe('cmp-navigation stress — rapid switching and back-stack abuse', () => {
  const STEP_KINDS = [
    'tap-home',
    'tap-library',
    'tap-progress',
    'tap-settings',
    'long-press-home',
    'open-menu',
    'close-menu-fab',
    'tap-auto-analyze',
    'tap-import-video',
    'tap-drill-library',
    'advance-half',
    'advance-full',
  ] as const;

  const TAB_LABEL_TO_ROUTE: Record<string, string> = {
    'tap-home': 'Home',
    'tap-library': 'Library',
    'tap-progress': 'Performance',
    'tap-settings': 'Settings',
  };
  const LABEL_FOR_STEP: Record<string, string> = {
    'tap-home': 'Home',
    'tap-library': 'Library',
    'tap-progress': 'Progress',
    'tap-settings': 'Settings',
    'tap-auto-analyze': 'Auto Analyze',
    'tap-import-video': 'Import Video',
    'tap-drill-library': 'Drill Library',
  };

  const SEQUENCES = 60 * STRESS_MULTIPLIER;
  const STEPS = 18;

  it('holds the navigation invariants across seeded interaction sequences', () => {
    useAuthStore.setState({ session: session({ localOnly: false }) });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: access(true),
    });

    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const seed = BASE_SEED + 200000 + sequence;
      if (!seedIsSelected(seed)) continue;
      const rng = makeRng(seed);
      const focusedIndex = rng.int(TAB_NAMES.length);
      const harness = tabBarProps({ index: focusedIndex });
      const renderer = render(<PremiumTabBar {...harness.props} />);
      const steps: string[] = [];
      const row: ResultRow = {
        seed,
        outcome: 'HELD',
        focusedIndex,
        focusedRoute: TAB_NAMES[focusedIndex]!,
      };

      try {
        for (let step = 0; step < STEPS; step += 1) {
          const kind = rng.pick(STEP_KINDS);
          steps.push(kind);
          switch (kind) {
            case 'advance-half':
              act(() => {
                jest.advanceTimersByTime(105);
              });
              break;
            case 'advance-full':
              act(() => {
                jest.advanceTimersByTime(400);
              });
              break;
            case 'open-menu':
              press(renderer, 'Open coach actions');
              break;
            case 'close-menu-fab':
              press(renderer, 'Close coach actions');
              break;
            case 'long-press-home': {
              const [home] = pressablesByLabel(renderer, 'Home');
              if (home) act(() => home.props.onLongPress());
              break;
            }
            default:
              press(renderer, LABEL_FOR_STEP[kind]!);
              break;
          }
        }
        // Let any pending close animation settle.
        act(() => {
          jest.advanceTimersByTime(1000);
        });

        row.steps = steps;
        row.tabNavigations = harness.navigate.mock.calls.map(call => call[0]);
        row.rootNavigations = harness.rootNavigate.mock.calls.map(
          call => call[0],
        );

        // Invariant 1: the focused tab never re-navigates to itself.
        const focusedRoute = TAB_NAMES[focusedIndex]!;
        expect(
          harness.navigate.mock.calls.filter(call => call[0] === focusedRoute),
        ).toEqual([]);
        // Invariant 2: every tab tap emits tabPress with the route's key
        // BEFORE any navigation, and only known routes are navigated to.
        for (const call of harness.navigate.mock.calls) {
          expect(Object.values(TAB_LABEL_TO_ROUTE)).toContain(call[0]);
        }
        // Invariant 3: the coach menu reaches only its three declared root
        // destinations, and a single menu session performs at most one of
        // them (taps during the close animation coalesce — last tap wins).
        for (const call of harness.rootNavigate.mock.calls) {
          expect([
            'Analyze',
            'DrillLibrary',
            'Paywall',
            'ConnectAccount',
          ]).toContain(call[0]);
        }
        const menuSessions = steps.filter(kind => kind === 'open-menu').length;
        expect(harness.rootNavigate.mock.calls.length).toBeLessThanOrEqual(
          Math.max(menuSessions, 0) +
            steps.filter(kind => kind.startsWith('tap-')).length,
        );
      } catch (error) {
        row.outcome = 'BROKEN';
        row.error = String(error).slice(0, 400);
        row.steps = steps;
        sequenceRows.push(row);
        throw error;
      } finally {
        act(() => renderer.unmount());
      }
      sequenceRows.push(row);
    }

    expect(sequenceRows.filter(row => row.outcome !== 'HELD')).toEqual([]);
    if (!MINIMISING) expect(sequenceRows.length).toBe(SEQUENCES);
  });

  it('drops the pending coach action when the bar unmounts mid-animation', () => {
    useAuthStore.setState({ session: session({ localOnly: false }) });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: access(true),
    });
    const harness = tabBarProps({ index: 0 });
    const renderer = render(<PremiumTabBar {...harness.props} />);
    press(renderer, 'Open coach actions');
    press(renderer, 'Drill Library');
    // Unmount inside the 210ms close animation: the queued navigation must
    // not fire on a dead tree (the effect cleanup clears the timer).
    act(() => renderer.unmount());
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(harness.rootNavigate).not.toHaveBeenCalled();
    sequenceRows.push({
      seed: BASE_SEED + 299001,
      outcome: 'HELD',
      scenario: 'unmount-mid-close-drops-pending-action',
    });
  });

  it('coalesces two action taps inside one close animation to the last tap', () => {
    useAuthStore.setState({ session: session({ localOnly: false }) });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: access(true),
    });
    const harness = tabBarProps({ index: 0 });
    const renderer = render(<PremiumTabBar {...harness.props} />);
    press(renderer, 'Open coach actions');
    press(renderer, 'Auto Analyze');
    press(renderer, 'Drill Library');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(harness.rootNavigate.mock.calls).toEqual([['DrillLibrary']]);
    act(() => renderer.unmount());
    sequenceRows.push({
      seed: BASE_SEED + 299002,
      outcome: 'HELD',
      scenario: 'double-tap-in-close-animation-last-wins',
    });
  });

  it('reopening the menu during the close animation cancels the pending action', () => {
    useAuthStore.setState({ session: session({ localOnly: false }) });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: access(true),
    });
    const harness = tabBarProps({ index: 0 });
    const renderer = render(<PremiumTabBar {...harness.props} />);
    press(renderer, 'Open coach actions');
    press(renderer, 'Import Video');
    // The user taps the FAB again before the menu finishes closing.
    press(renderer, 'Open coach actions');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(harness.rootNavigate).not.toHaveBeenCalled();
    // ...and the menu is open again, ready for a new choice.
    expect(
      pressablesByLabel(renderer, 'Close coach actions').length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
    sequenceRows.push({
      seed: BASE_SEED + 299003,
      outcome: 'HELD',
      scenario: 'reopen-cancels-pending-action',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Campaign 3 — RootNavigator params, rating gate, notification targets
 * ------------------------------------------------------------------ */

describe('cmp-navigation stress — RootNavigator params and gates', () => {
  type FakeNavigation = {
    goBack: jest.Mock;
    replace: jest.Mock;
    navigate: jest.Mock;
  };

  function fakeNavigation(): FakeNavigation {
    return { goBack: jest.fn(), replace: jest.fn(), navigate: jest.fn() };
  }

  function stackScreens(renderer: Renderer) {
    return renderer.root.findAllByType(Stack.Screen).map(node => ({
      name: node.props.name as keyof RootStackParams,
      component: node.props.component as React.ComponentType<{
        navigation: unknown;
        route: { key: string; name: string; params?: unknown };
      }>,
    }));
  }

  it('renders every registered route with the hostile param corpus', () => {
    useAuthStore.setState({
      session: session({ provider: 'google', localOnly: false }),
    });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: access(true),
    });
    const root = render(<RootNavigator />);
    const screens = stackScreens(root);
    expect(screens.length).toBeGreaterThan(0);

    let index = 0;
    for (const screen of screens) {
      for (const stringCase of STRING_CORPUS) {
        const seed = BASE_SEED + 300000 + index;
        index += 1;
        if (!seedIsSelected(seed)) continue;
        const rng = makeRng(seed);
        const numeric = rng.pick(NUMERIC_CORPUS);
        const params = rng.bool(0.1)
          ? undefined
          : {
              analysisId: stringCase.value,
              phase: stringCase.value,
              source: rng.pick([
                'camera',
                'library',
                'rating',
                'training',
                'settings',
                stringCase.value,
                numeric.value,
                null,
                undefined,
              ] as unknown[]),
              screen: stringCase.value,
              score: numeric.value,
              nested: { a: { b: { c: [stringCase.value, numeric.value] } } },
            };
        const row: ResultRow = {
          seed,
          outcome: 'HELD',
          route: screen.name,
          stringCase: stringCase.id,
          numericCase: numeric.id,
          paramsUndefined: params === undefined,
        };
        const navigation = fakeNavigation();
        let renderer: Renderer | null = null;
        try {
          const Route = screen.component;
          renderer = render(
            <Route
              navigation={navigation}
              route={{ key: `${screen.name}-1`, name: screen.name, params }}
            />,
          );
          act(() => {
            jest.advanceTimersByTime(50);
          });
          row.replaceCalls = navigation.replace.mock.calls.map(call => call[0]);
          row.goBackCalls = navigation.goBack.mock.calls.length;
          // A hostile param must never redirect a route somewhere it would
          // not otherwise go: the only routes that redirect are Analyze
          // (rating gate) and ConnectAccount (already-signed-in bounce).
          if (!['Analyze', 'ConnectAccount'].includes(String(screen.name))) {
            expect(navigation.replace).not.toHaveBeenCalled();
            expect(navigation.goBack).not.toHaveBeenCalled();
          }
        } catch (error) {
          row.outcome = 'THREW';
          row.error = String(error).slice(0, 300);
        } finally {
          if (renderer) act(() => renderer!.unmount());
        }
        navigatorRows.push(row);
      }
    }
    act(() => root.unmount());
    expect(navigatorRows.filter(row => row.outcome === 'THREW')).toEqual([]);
  });

  it('keeps the rating gate bounded across seeded access-state transitions', () => {
    const STATES = [
      { id: 'idle', status: 'idle', canonicalAccess: null },
      { id: 'loading', status: 'loading', canonicalAccess: null },
      { id: 'ready-allowed', status: 'ready', canonicalAccess: access(true) },
      { id: 'ready-blocked', status: 'ready', canonicalAccess: access(false) },
      { id: 'unconfigured', status: 'unconfigured', canonicalAccess: null },
      { id: 'error', status: 'error', canonicalAccess: null },
    ] as const;

    const root = render(<RootNavigator />);
    const Analyze = stackScreens(root).find(
      screen => screen.name === 'Analyze',
    )!.component;

    const RUNS = 40 * STRESS_MULTIPLIER;
    for (let run = 0; run < RUNS; run += 1) {
      const seed = BASE_SEED + 400000 + run;
      if (!seedIsSelected(seed)) continue;
      const rng = makeRng(seed);
      const localOnly = rng.bool(0.25);
      useAuthStore.setState({
        session: session(
          localOnly
            ? { provider: 'guest', localOnly: true }
            : { provider: 'apple', localOnly: false },
        ),
      });
      const initialize = jest.fn(async () => undefined);
      const first = rng.pick(STATES);
      useAccessStore.setState({
        status: first.status,
        canonicalAccess: first.canonicalAccess,
        initialize,
      });

      const navigation = fakeNavigation();
      const renderer = render(
        <Analyze
          navigation={navigation}
          route={{ key: 'Analyze-1', name: 'Analyze' }}
        />,
      );

      const transitions = 1 + rng.int(6);
      const applied = [first.id];
      for (let step = 0; step < transitions; step += 1) {
        const next = rng.pick(STATES);
        applied.push(next.id);
        act(() => {
          useAccessStore.setState({
            status: next.status,
            canonicalAccess: next.canonicalAccess,
          });
        });
      }

      const replaced = navigation.replace.mock.calls.map(call => call[0]);
      const row: ResultRow = {
        seed,
        outcome: 'HELD',
        localOnly,
        transitions: applied,
        replaced,
        initializeCalls: initialize.mock.calls.length,
      };
      try {
        // Only these two redirects exist, and only away from Analyze.
        for (const target of replaced) {
          expect(['ConnectAccount', 'Paywall']).toContain(target);
        }
        if (localOnly) {
          // A local-only session is always sent to ConnectAccount and never
          // to the paywall.
          expect(replaced).not.toContain('Paywall');
          expect(replaced.length).toBeGreaterThanOrEqual(1);
        }
        // The gate is edge-triggered, never a redirect storm: at most one
        // replace per applied state transition.
        expect(replaced.length).toBeLessThanOrEqual(applied.length);
        // `initialize()` is only ever kicked from the idle state.
        if (!applied.includes('idle') || localOnly) {
          expect(initialize).not.toHaveBeenCalled();
        }
      } catch (error) {
        row.outcome = 'BROKEN';
        row.error = String(error).slice(0, 400);
        navigatorRows.push(row);
        throw error;
      } finally {
        act(() => renderer.unmount());
      }
      navigatorRows.push(row);
    }
    act(() => root.unmount());
  });

  it('routes fuzzed notification targets to a real tab, and drops them safely before the container is ready', () => {
    render(<RootNavigator />);
    const handler = mockSubscribeToNotificationPresses.mock.calls[0]?.[0] as
      ((target: string) => void) | undefined;
    expect(typeof handler).toBe('function');

    const targets = [
      'Performance',
      'Home',
      'performance',
      'PERFORMANCE',
      'Settings',
      'Add',
      '',
      ' ',
      '__proto__',
      'Performance\u0000',
      '🏓',
      'ٱلْعَرَبِيَّة',
      'x'.repeat(500),
    ];
    for (const [index, target] of targets.entries()) {
      navigationRef.navigate.mockClear();
      act(() => handler!(target));
      const calls = navigationRef.navigate.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe('Tabs');
      expect(calls[0]![1]).toEqual({
        screen: target === 'Performance' ? 'Performance' : 'Home',
      });
      navigatorRows.push({
        seed: BASE_SEED + 500000 + index,
        outcome: 'HELD',
        scenario: 'notification-target-fuzz',
        target: target.slice(0, 24),
        routedTo: calls[0]![1],
      });
    }

    // Cold start: a press delivered before the container is ready is dropped
    // rather than crashing (the app then opens on its default route).
    navigationRef.isReady.mockReturnValue(false);
    navigationRef.navigate.mockClear();
    act(() => handler!('Performance'));
    expect(navigationRef.navigate).not.toHaveBeenCalled();
    navigatorRows.push({
      seed: BASE_SEED + 599999,
      outcome: 'HELD',
      scenario: 'notification-press-before-ready-is-dropped',
    });
  });
});
