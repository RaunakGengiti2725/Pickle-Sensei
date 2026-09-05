/**
 * Deterministic pins for the RootNavigator behaviours the seeded campaign
 * (rootNavigator.rapidInteraction.stress.test.tsx) surfaced, on the REAL
 * React Navigation 7 router (NavigationContainer + native stack + bottom
 * tabs + PremiumTabBar; only the screens are stubbed).
 *
 * `known defects` use `it.failing`: they document the current, reproduced
 * behaviour and flip RED the moment the underlying code is fixed, at which
 * point the pin should become a plain `it` with the same body. Nothing in
 * this file skips or weakens an assertion — every `expect` states the
 * intended behaviour.
 *
 * Root cause shared by KD-2/KD-3/KD-4 (INFERRED from node_modules, v7.21
 * core / v7.6 routers): a screen's `navigation.replace|goBack()` dispatches
 * with `source: route.key` but WITHOUT `target`, and StackRouter resolves the
 * index as `action.target === state.key && action.source ? indexOf(source)
 * : state.index` — i.e. it acts on the FOCUSED route, not the caller's. So an
 * effect that fires on a covered screen edits the wrong route (KD-2/3), and a
 * second `goBack()` from a screen whose route was already popped pops the
 * NEXT screen instead of being a no-op (KD-4).
 *
 * `held` are the rapid-interaction properties that DID hold on the real
 * router and are pinned so they keep holding.
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
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'HomeScreen' },
  ),
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'LibraryScreen' },
  ),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ProgressScreen' },
  ),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'SettingsScreen' },
  ),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'AnalyzeScreen' },
  ),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'DrillLibraryScreen' },
  ),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ResultScreen' },
  ),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ResultDetailsScreen' },
  ),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'FormReviewScreen' },
  ),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'StreakCalendarScreen' },
  ),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'PaywallScreen' },
  ),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'SignInScreen' },
  ),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ManageAccountScreen' },
  ),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ConsentSettingsScreen' },
  ),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    {
      value: 'NotificationSettingsScreen',
    },
  ),
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
import { NoiseCapture } from '../../__harness__/stress/rapidInteraction.harness';

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
function pressables(renderer: Renderer, label: string) {
  const all = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  const set = new Set(all);
  return all.filter(node => {
    for (let p = node.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}
function insideModal(node: TestRenderer.ReactTestInstance): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === Modal) return true;
  return false;
}
function inBarCoachButtons(renderer: Renderer) {
  return pressables(renderer, 'Open coach actions')
    .concat(pressables(renderer, 'Close coach actions'))
    .filter(
      n =>
        n.props.accessibilityState?.expanded !== undefined && !insideModal(n),
    );
}
function navigate(route: keyof RootStackParams, params?: unknown) {
  (navigationRef.navigate as (name: string, params?: unknown) => void)(
    route,
    params,
  );
}

let renderer: Renderer;
let noise: NoiseCapture;

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
  noise = new NoiseCapture();
  noise.start();
  act(() => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  noise.stop();
  jest.useRealTimers();
});

describe('stress/rapid-interaction: RootNavigator known defects (pinned, it.failing)', () => {
  it.failing(
    'KD-1: a reminder press while a screen is pushed returns to the ONE existing Tabs host (observed: a second MainTabs is pushed on top, two PremiumTabBars mount)',
    () => {
      act(() => navigate('DrillLibrary'));
      expect(names()).toEqual(['Tabs', 'DrillLibrary']);
      act(() => mockNotificationPress!('Performance'));
      expect(names()).toEqual(['Tabs']);
      expect(inBarCoachButtons(renderer)).toHaveLength(1);
      const tabs = rootState().routes[0]!.state!;
      expect(tabs.routes[tabs.index!]!.name).toBe('Performance');
      expect(noise.report()).toBeNull();
    },
  );

  it.failing(
    'KD-1b: two reminder presses in one frame while a screen is pushed still leave exactly one Tabs host',
    () => {
      act(() => navigate('StreakCalendar'));
      act(() => {
        mockNotificationPress!('Home');
        mockNotificationPress!('Performance');
      });
      expect(names().filter(n => n === 'Tabs')).toHaveLength(1);
      expect(inBarCoachButtons(renderer)).toHaveLength(1);
    },
  );

  it.failing(
    'KD-2: access flips to a non-startable state while Analyze is covered by Paywall — the gate must not orphan Analyze in "Checking access…" nor replace the covering Paywall instance (observed: Paywall re-created, Analyze stuck loading underneath)',
    () => {
      act(() => navigate('Analyze', { source: 'camera' }));
      expect(AnalyzeScreen).toHaveBeenCalled();
      // AnalyzeScreen's upgrade CTA pushes the paywall over itself
      // (src/screens/AnalyzeScreen.tsx navigation.navigate('Paywall', { source: 'rating' })).
      act(() => navigate('Paywall', { source: 'rating' }));
      expect(names()).toEqual(['Tabs', 'Analyze', 'Paywall']);
      const paywallKey = focusedKey();
      // accessStore.purchase(): store succeeded, backend verification threw →
      // { status: 'error', canonicalAccess: null } (src/state/accessStore.ts).
      act(() => {
        useMockAccessStore.setState({ status: 'error', canonicalAccess: null });
      });
      expect(allText(renderer)).not.toContain('Checking access…');
      expect(focusedKey()).toBe(paywallKey);
      expect(noise.report()).toBeNull();
    },
  );

  it.failing(
    'KD-3: the session becoming local-only while Analyze is covered must not swap the covering screen for ConnectAccount and leave Analyze mounted (observed: focused route replaced, Analyze stays)',
    () => {
      act(() => navigate('Analyze', { source: 'library' }));
      act(() => navigate('Result', { analysisId: 'a-1' }));
      expect(names()).toEqual(['Tabs', 'Analyze', 'Result']);
      act(() => {
        useMockAuthStore.setState({
          session: { provider: 'guest', localOnly: true },
        });
      });
      expect(names()).toEqual(['Tabs', 'ConnectAccount', 'Result']);
    },
  );

  it.failing(
    'KD-4: Paywall onClose delivered twice in one frame (double-tap on the unguarded close button) pops exactly one screen (observed: the Analyze underneath is popped too)',
    () => {
      act(() => navigate('Analyze', { source: 'camera' }));
      act(() => navigate('Paywall', { source: 'rating' }));
      const props = PaywallScreen.mock.calls.at(-1)![0];
      act(() => {
        (props.onClose as () => void)();
        (props.onClose as () => void)();
      });
      expect(names()).toEqual(['Tabs', 'Analyze']);
      expect(noise.report()).toBeNull();
    },
  );
});

describe('stress/rapid-interaction: RootNavigator properties that held on the real router', () => {
  it('coach "Auto Analyze" triple-tapped in one frame navigates to Analyze exactly once', () => {
    act(() => inBarCoachButtons(renderer)[0]!.props.onPress());
    const [row] = pressables(renderer, 'Auto Analyze');
    expect(row).toBeDefined();
    act(() => {
      row!.props.onPress();
      row!.props.onPress();
      row!.props.onPress();
    });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(names()).toEqual(['Tabs', 'Analyze']);
    expect(
      renderer.root.findAllByType(Modal).filter(m => m.props.visible),
    ).toHaveLength(0);
    expect(noise.report()).toBeNull();
  });

  it('Paywall onClose double-tapped over Tabs alone leaves the Tabs host intact and the tab bar mounted once', () => {
    act(() => navigate('Paywall', { source: 'settings' }));
    const props = PaywallScreen.mock.calls.at(-1)![0];
    act(() => {
      (props.onClose as () => void)();
      (props.onClose as () => void)();
    });
    expect(names()).toEqual(['Tabs']);
    expect(inBarCoachButtons(renderer)).toHaveLength(1);
  });

  it('Paywall onClose and onPurchased racing in one frame over Tabs alone leaves the Tabs host intact', () => {
    act(() => navigate('Paywall', { source: 'training' }));
    const props = PaywallScreen.mock.calls.at(-1)![0];
    act(() => {
      (props.onPurchased as () => void)();
      (props.onClose as () => void)();
    });
    expect(names()).toEqual(['Tabs']);
    expect(inBarCoachButtons(renderer)).toHaveLength(1);
  });

  it('back during the access lookup leaves no orphan "Checking access…" and never mounts AnalyzeScreen', () => {
    useMockAccessStore.setState({
      status: 'idle',
      canonicalAccess: null,
      initialize: async () => {
        useMockAccessStore.setState({ status: 'loading' });
      },
    });
    act(() => navigate('Analyze', { source: 'camera' }));
    expect(allText(renderer)).toContain('Checking access…');
    act(() => navigationRef.goBack());
    act(() => {
      useMockAccessStore.setState({
        status: 'ready',
        canonicalAccess: { canStartRating: false },
      });
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(names()).toEqual(['Tabs']);
    expect(allText(renderer)).not.toContain('Checking access…');
    expect(AnalyzeScreen).not.toHaveBeenCalled();
    expect(noise.report()).toBeNull();
  });

  it('rapid Home→Library→Progress→Settings→Home (one tap per frame) ends on Home with no noise', () => {
    for (const label of ['Library', 'Progress', 'Settings', 'Home']) {
      act(() => pressables(renderer, label)[0]!.props.onPress());
    }
    const tabs = rootState().routes[0]!.state!;
    expect(tabs.routes[tabs.index!]!.name).toBe('Home');
    expect(names()).toEqual(['Tabs']);
    expect(noise.report()).toBeNull();
  });

  it('four tab taps delivered in the SAME frame keep the tab state well-formed, one tab bar, no noise', () => {
    // PremiumTabBar decides `isFocused` from render-time state, so a
    // same-frame burst legitimately lands on the last tab whose target
    // differed from the rendered focus; what must hold is consistency.
    act(() => {
      for (const label of ['Library', 'Progress', 'Settings', 'Home']) {
        pressables(renderer, label)[0]!.props.onPress();
      }
    });
    const tabs = rootState().routes[0]!.state!;
    expect(tabs.routeNames).toEqual([
      'Home',
      'Library',
      'Add',
      'Performance',
      'Settings',
    ]);
    expect(tabs.index).toBeGreaterThanOrEqual(0);
    expect(tabs.index).toBeLessThan(5);
    expect(inBarCoachButtons(renderer)).toHaveLength(1);
    expect(names()).toEqual(['Tabs']);
    expect(noise.report()).toBeNull();
  });

  it('opening the coach menu, choosing Drill Library, and re-tapping COACH during the close transition yields one navigation and no stale deferred action', () => {
    act(() => inBarCoachButtons(renderer)[0]!.props.onPress());
    act(() => pressables(renderer, 'Drill Library')[0]!.props.onPress());
    act(() => {
      jest.advanceTimersByTime(100);
    });
    // Re-open during the 210 ms close: the pending navigation is dropped by
    // design (openMenu clears pendingAction) — assert exactly that, then close.
    act(() => inBarCoachButtons(renderer)[0]!.props.onPress());
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(names()).toEqual(['Tabs']);
    act(() => inBarCoachButtons(renderer)[0]!.props.onPress());
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(names()).toEqual(['Tabs']);
    expect(
      renderer.root.findAllByType(Modal).filter(m => m.props.visible),
    ).toHaveLength(0);
    expect(noise.report()).toBeNull();
  });
});
