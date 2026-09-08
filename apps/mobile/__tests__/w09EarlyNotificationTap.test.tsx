/**
 * W09-03: a reminder tap that reaches the app before RootNavigator can
 * navigate (cold start while the container is still mounting, a warm start
 * that remounts the navigator, or a tap delivered on the background channel
 * before anything subscribed) must be held — bounded and deduplicated — and
 * dispatched exactly once as soon as navigation is ready. Base behaviour
 * dropped the press (`if (!navigationRef.isReady()) return;`) and ignored the
 * background channel entirely.
 */
import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/screens/HomeScreen', () => ({ HomeScreen: () => null }));
jest.mock('../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => null,
}));
jest.mock('../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../src/screens/ResultScreen', () => ({ ResultScreen: () => null }));
jest.mock('../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../src/screens/PaywallScreen', () => ({
  PaywallScreen: () => null,
}));
jest.mock('../src/screens/SignInScreen', () => ({ SignInScreen: () => null }));
jest.mock('../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
jest.mock('../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));
jest.mock('../src/design/components', () => {
  const ReactActual = require('react');
  return {
    LoadingState: (props: { label: string }) =>
      ReactActual.createElement('LoadingState', props),
  };
});
jest.mock('../src/state/accessStore', () => {
  const { create } = require('zustand');
  return {
    useAccessStore: create(() => ({
      status: 'ready',
      canonicalAccess: { canStartRating: true },
      initialize: jest.fn(async () => {}),
    })),
  };
});
jest.mock('../src/auth/authStore', () => {
  const { create } = require('zustand');
  return {
    useAuthStore: create(() => ({
      session: { provider: 'apple', localOnly: false },
    })),
  };
});
jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    legalTermsUrl: null,
    legalPrivacyUrl: null,
  }),
}));
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

const mockRefNavigate = jest.fn();
const mockRefReady = jest.fn(() => false);
const mockContainerProps: { current: { onReady?: () => void } | null } = {
  current: null,
};

jest.mock('@react-navigation/native', () => {
  const ReactActual = require('react');
  return {
    NavigationContainer: (props: {
      children?: React.ReactNode;
      onReady?: () => void;
    }) => {
      mockContainerProps.current = props;
      return ReactActual.createElement(
        'NavigationContainer',
        null,
        props.children,
      );
    },
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
    createNavigationContainerRef: () => ({
      isReady: () => mockRefReady(),
      navigate: (...args: unknown[]) => mockRefNavigate(...args),
    }),
  };
});
jest.mock('@react-navigation/native-stack', () => {
  const ReactActual = require('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: (props: { children?: React.ReactNode }) =>
        ReactActual.createElement('StackNavigator', null, props.children),
      Screen: (props: Record<string, unknown>) =>
        ReactActual.createElement('StackScreen', props),
    }),
  };
});
jest.mock('@react-navigation/bottom-tabs', () => {
  const ReactActual = require('react');
  return {
    createBottomTabNavigator: () => ({
      Navigator: (props: { children?: React.ReactNode }) =>
        ReactActual.createElement('TabNavigator', null, props.children),
      Screen: (props: Record<string, unknown>) =>
        ReactActual.createElement('TabScreen', props),
    }),
  };
});

import notifee, { EventType } from 'react-native-notify-kit';
import { RootNavigator } from '../src/navigation/RootNavigator';
import * as notificationService from '../src/notifications/service';

type PressEvent = {
  type: number;
  detail: { notification?: { id?: string; data?: unknown } };
};

const mocked = notifee as unknown as {
  getInitialNotification: jest.Mock;
  onForegroundEvent: jest.Mock;
  onBackgroundEvent: jest.Mock;
};

const live: ReactTestRenderer[] = [];

function renderRoot(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<RootNavigator />);
  });
  live.push(renderer);
  return renderer;
}

/** Simulates NavigationContainer finishing its mount. */
function containerBecomesReady(): void {
  mockRefReady.mockReturnValue(true);
  const onReady = mockContainerProps.current?.onReady;
  if (onReady) act(() => onReady());
}

function foregroundHandler(): (event: PressEvent) => void {
  const call = mocked.onForegroundEvent.mock.calls.at(-1);
  if (!call) throw new Error('RootNavigator did not subscribe to presses');
  return call[0];
}

function backgroundHandler(): (event: PressEvent) => Promise<void> {
  notificationService.registerBackgroundNotificationHandler();
  const call = mocked.onBackgroundEvent.mock.calls.at(-1);
  if (!call) throw new Error('No background handler was registered');
  return call[0];
}

function press(id: string, screen: string): PressEvent {
  return {
    type: EventType.PRESS,
    detail: { notification: { id, data: { screen } } },
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockRefNavigate.mockClear();
  mockRefReady.mockReturnValue(false);
  mockContainerProps.current = null;
  mocked.getInitialNotification.mockClear();
  mocked.getInitialNotification.mockResolvedValue(null);
  mocked.onForegroundEvent.mockClear();
  mocked.onBackgroundEvent.mockClear();
});

afterEach(() => {
  act(() => {
    for (const renderer of live.splice(0)) renderer.unmount();
  });
});

describe('W09-03: cold start', () => {
  it('holds the initial-notification press until the container is ready, then dispatches it exactly once', async () => {
    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: { id: 'ps.cold.initial', data: { screen: 'Performance' } },
    });
    renderRoot();
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });

    await flushMicrotasks();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
  });

  it('a tap that arrives on the background channel before RootNavigator mounts is dispatched once — the initial-notification read of the same tap is not replayed', async () => {
    const onBackground = backgroundHandler();
    await onBackground(press('ps.cold.background', 'Performance'));
    expect(mockRefNavigate).not.toHaveBeenCalled();

    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: {
        id: 'ps.cold.background',
        data: { screen: 'Performance' },
      },
    });
    renderRoot();
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });

    // The next day's repeat of the same reminder is a fresh tap.
    await onBackground(press('ps.cold.background', 'Performance'));
    expect(mockRefNavigate).toHaveBeenCalledTimes(2);
  });
});

describe('W09-03: warm start', () => {
  it('foreground presses before the container is ready are queued, deduplicated and replayed in order exactly once', () => {
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => {
      onForeground(press('ps.warm.a', 'Performance'));
      onForeground(press('ps.warm.b', 'Home'));
      onForeground(press('ps.warm.c', 'Performance'));
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Home' }],
      ['Tabs', { screen: 'Performance' }],
    ]);

    // Once ready, presses route immediately and the queue does not replay.
    act(() => onForeground(press('ps.warm.d', 'Home')));
    expect(mockRefNavigate).toHaveBeenCalledTimes(3);
    expect(mockRefNavigate).toHaveBeenLastCalledWith('Tabs', {
      screen: 'Home',
    });
  });

  it('a tap delivered on the background channel (app inactive at the moment of the tap) routes to its tab', async () => {
    renderRoot();
    containerBecomesReady();
    const onBackground = backgroundHandler();

    await onBackground({
      type: EventType.DISMISSED,
      detail: { notification: { id: 'ps.warm.bg', data: { screen: 'Home' } } },
    });
    await onBackground({
      type: EventType.PRESS,
      detail: { notification: { id: 'ps.warm.bg', data: { screen: 'Nope' } } },
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();

    await onBackground(press('ps.warm.bg', 'Home'));
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
  });

  it('after the navigator unmounts, a press waits for the next mount and is dispatched once when that container is ready', async () => {
    const first = renderRoot();
    containerBecomesReady();
    const onBackground = backgroundHandler();
    act(() => {
      live.splice(live.indexOf(first), 1)[0]!.unmount();
    });
    mockRefReady.mockReturnValue(false);

    await onBackground(press('ps.remount', 'Performance'));
    expect(mockRefNavigate).not.toHaveBeenCalled();

    renderRoot();
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();
    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
    expect(mockRefNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Performance',
    });
  });
});

describe('W09-03: pending press queue', () => {
  it('is bounded (oldest dropped) and deduplicated (a repeat moves to the newest slot)', () => {
    const { enqueueBounded, MAX_QUEUED_NOTIFICATION_PRESSES } =
      notificationService;
    expect(MAX_QUEUED_NOTIFICATION_PRESSES).toBeGreaterThanOrEqual(2);

    let queue: string[] = [];
    for (let i = 0; i < MAX_QUEUED_NOTIFICATION_PRESSES + 2; i += 1) {
      queue = enqueueBounded(queue, `press-${i}`);
    }
    expect(queue).toHaveLength(MAX_QUEUED_NOTIFICATION_PRESSES);
    expect(queue[0]).toBe('press-2');
    expect(queue.at(-1)).toBe(`press-${MAX_QUEUED_NOTIFICATION_PRESSES + 1}`);

    expect(enqueueBounded(['Performance', 'Home'], 'Performance')).toEqual([
      'Home',
      'Performance',
    ]);
    expect(enqueueBounded(['Home'], 'Home')).toEqual(['Home']);
  });
});
