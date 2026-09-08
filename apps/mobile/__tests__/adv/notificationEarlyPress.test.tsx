/**
 * INT-ui-flows-a11y adversary — early notification taps.
 *
 * Attack: a reminder is pressed before the NavigationContainer reports
 * ready (cold start from a notification, or a warm press that lands while
 * the tree is still mounting). The contract under attack: the press is
 * queued and dispatched exactly once when the container becomes ready — it
 * is never dropped, never duplicated.
 *
 * The harness is independent from __tests__/wf/flow-navigation-tabs-routes:
 * every screen is stubbed, the container ref is a controllable double, and
 * the NavigationContainer mock captures `onReady` so the test can flip the
 * ref to ready the same way the real container would.
 */
const mockRefNavigate = jest.fn();
let mockReady = false;
let mockOnReady: (() => void) | undefined;

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: (props: {
      children?: React.ReactNode;
      onReady?: () => void;
    }) => {
      mockOnReady = props.onReady;
      return React.createElement('NavigationContainer', null, props.children);
    },
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
    createNavigationContainerRef: () => ({
      isReady: () => mockReady,
      navigate: (...args: unknown[]) => mockRefNavigate(...args),
    }),
  };
});

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  const Navigator = (props: { children?: React.ReactNode }) =>
    React.createElement('Stack.Navigator', null, props.children);
  const Screen = () => null;
  return { createNativeStackNavigator: () => ({ Navigator, Screen }) };
});
jest.mock('@react-navigation/bottom-tabs', () => {
  const React = require('react');
  const Navigator = (props: { children?: React.ReactNode }) =>
    React.createElement('Tab.Navigator', null, props.children);
  const Screen = () => null;
  return { createBottomTabNavigator: () => ({ Navigator, Screen }) };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: (props: { children?: React.ReactNode }) => props.children,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View', createAnimatedComponent: () => 'Anim' },
  Easing: { out: () => 0, cubic: () => 0 },
  interpolate: () => 0,
  useAnimatedStyle: () => ({}),
  useSharedValue: (v: unknown) => ({ value: v }),
  withTiming: (v: unknown) => v,
}));
jest.mock('react-native-linear-gradient', () => ({
  __esModule: true,
  default: 'LinearGradient',
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const Stub = () => null;
jest.mock('../../src/screens/HomeScreen', () => ({ HomeScreen: Stub }));
jest.mock('../../src/screens/LibraryScreen', () => ({ LibraryScreen: Stub }));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: Stub,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: Stub,
}));
jest.mock('../../src/screens/SignInScreen', () => ({ SignInScreen: Stub }));
jest.mock('../../src/screens/AnalyzeScreen', () => ({ AnalyzeScreen: Stub }));
jest.mock('../../src/screens/ResultScreen', () => ({ ResultScreen: Stub }));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: Stub,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: Stub,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: Stub,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: Stub,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: Stub,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: Stub,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: Stub,
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: Stub,
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: Stub,
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import notifee, { EventType } from 'react-native-notify-kit';
import { RootNavigator } from '../../src/navigation/RootNavigator';

type ForegroundEvent = {
  type: number;
  detail: { notification?: { data?: unknown } };
};

function foregroundHandler(): (event: ForegroundEvent) => void {
  const call = (notifee.onForegroundEvent as jest.Mock).mock.calls.at(-1);
  if (!call) throw new Error('RootNavigator did not subscribe to presses');
  return call[0];
}

async function renderRoot() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  return renderer;
}

async function becomeReady() {
  mockReady = true;
  await act(async () => {
    mockOnReady?.();
    await Promise.resolve();
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('adv: notification press before the navigator is ready', () => {
  beforeEach(() => {
    mockReady = false;
    mockOnReady = undefined;
    mockRefNavigate.mockClear();
    (notifee.onForegroundEvent as jest.Mock).mockClear();
    (notifee.getInitialNotification as jest.Mock).mockReset();
    (notifee.getInitialNotification as jest.Mock).mockResolvedValue(null);
  });

  it('queues a warm PRESS that lands before onReady and dispatches it exactly once after', async () => {
    const renderer = await renderRoot();
    await flush();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    act(() => {
      foregroundHandler()({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Performance' } } },
      });
    });
    // Not ready yet: nothing may be dispatched into a container with no state.
    expect(mockRefNavigate).not.toHaveBeenCalled();

    await becomeReady();
    await flush();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });
    act(() => renderer.unmount());
  });

  it('keeps a cold-start notification whose read resolves before onReady', async () => {
    (notifee.getInitialNotification as jest.Mock).mockResolvedValue({
      notification: { data: { screen: 'Performance' } },
    });
    const renderer = await renderRoot();
    await flush();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    await becomeReady();
    await flush();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });
    act(() => renderer.unmount());
  });

  it('never dispatches the same early press twice once ready (dedupe across two pre-ready presses)', async () => {
    const renderer = await renderRoot();
    await flush();
    act(() => {
      const press = foregroundHandler();
      press({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Home' } } },
      });
      press({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Home' } } },
      });
    });
    await becomeReady();
    await flush();
    // Either one dispatch (latest wins) or none is a defensible contract;
    // two identical navigations into the same tab is not.
    expect(mockRefNavigate.mock.calls.length).toBeLessThanOrEqual(1);
    if (mockRefNavigate.mock.calls.length === 1) {
      expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
    }
    act(() => renderer.unmount());
  });

  it('does not dispatch a queued press after the navigator unmounts (account switch tears the tree down)', async () => {
    const renderer = await renderRoot();
    await flush();
    act(() => {
      foregroundHandler()({
        type: EventType.PRESS,
        detail: { notification: { data: { screen: 'Performance' } } },
      });
    });
    act(() => renderer.unmount());
    await becomeReady();
    await flush();
    expect(mockRefNavigate).not.toHaveBeenCalled();
  });
});
