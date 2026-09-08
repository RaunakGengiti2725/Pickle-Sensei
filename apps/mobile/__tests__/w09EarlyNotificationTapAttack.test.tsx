/**
 * W09-03 adversarial suite (attack branch). Drives the candidate's press
 * intake (src/notifications/service.ts) and RootNavigator's hold/replay at
 * their failure boundaries: duplicate identities across both channels, a
 * re-targeted repeat of one notification id, queue bounds while nothing is
 * subscribed, a stale tap crossing a sign-out/sign-in (account switch), the
 * cold-start read resolving after the navigator is gone, overlapping
 * subscribers, and malformed payloads. Same mock harness as the candidate's
 * own suite so the two can be compared line by line.
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
const mockReadyListeners: Array<() => void> = [];

jest.mock('@react-navigation/native', () => {
  const ReactActual = require('react');
  return {
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement('NavigationContainer', null, props.children),
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
    createNavigationContainerRef: () => ({
      isReady: () => mockRefReady(),
      navigate: (...args: unknown[]) => mockRefNavigate(...args),
      current: {
        addListener: (event: string, listener: () => void) => {
          if (event !== 'ready') throw new Error(`unexpected event ${event}`);
          mockReadyListeners.push(listener);
          return () => {
            const index = mockReadyListeners.indexOf(listener);
            if (index >= 0) mockReadyListeners.splice(index, 1);
          };
        },
      },
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

function renderRoot(strict = false): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      strict ? (
        <React.StrictMode>
          <RootNavigator />
        </React.StrictMode>
      ) : (
        <RootNavigator />
      ),
    );
  });
  live.push(renderer);
  return renderer;
}

function unmount(renderer: ReactTestRenderer): void {
  const index = live.indexOf(renderer);
  if (index >= 0) live.splice(index, 1);
  act(() => renderer.unmount());
  mockRefReady.mockReturnValue(false);
}

function containerBecomesReady(): void {
  mockRefReady.mockReturnValue(true);
  act(() => {
    for (const listener of [...mockReadyListeners]) listener();
  });
}

function foregroundHandlerAt(callIndex: number): (event: PressEvent) => void {
  const call = mocked.onForegroundEvent.mock.calls[callIndex];
  if (!call) throw new Error(`no foreground subscription #${callIndex}`);
  return call[0];
}

function foregroundHandler(): (event: PressEvent) => void {
  return foregroundHandlerAt(mocked.onForegroundEvent.mock.calls.length - 1);
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

/** Drains anything a failed attack left in the process-wide intake. */
async function drainIntake(): Promise<void> {
  const renderer = renderRoot();
  containerBecomesReady();
  await flushMicrotasks();
  unmount(renderer);
}

beforeEach(() => {
  mockRefNavigate.mockClear();
  mockRefReady.mockReturnValue(false);
  mockReadyListeners.length = 0;
  mocked.getInitialNotification.mockClear();
  mocked.getInitialNotification.mockResolvedValue(null);
  mocked.onForegroundEvent.mockClear();
  mocked.onBackgroundEvent.mockClear();
});

afterEach(async () => {
  act(() => {
    for (const renderer of live.splice(0)) renderer.unmount();
  });
  mockRefReady.mockReturnValue(false);
  await drainIntake();
});

describe('W09-03 attack: duplicate identities', () => {
  it('A1 one tap seen on the foreground channel, the background channel and the cold-start read dispatches exactly once', async () => {
    const onBackground = backgroundHandler();
    await onBackground(press('ps.attack.a1', 'Performance'));

    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: { id: 'ps.attack.a1', data: { screen: 'Performance' } },
    });
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => onForeground(press('ps.attack.a1', 'Performance')));
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);
  });

  it('A2 the same notification id re-targeted before ready lands on the LAST target and never navigates more than once per distinct target', () => {
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => {
      onForeground(press('ps.attack.a2', 'Performance'));
      onForeground(press('ps.attack.a2', 'Home'));
      onForeground(press('ps.attack.a2', 'Performance'));
      onForeground(press('ps.attack.a2', 'Home'));
    });
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    expect(mockRefNavigate.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mockRefNavigate).toHaveBeenLastCalledWith('Tabs', {
      screen: 'Home',
    });
  });

  it('A3 a double tap on one reminder after ready navigates idempotently (same tab, no extra route pushes)', async () => {
    renderRoot();
    containerBecomesReady();
    const onBackground = backgroundHandler();
    const onForeground = foregroundHandler();
    await onBackground(press('ps.attack.a3', 'Home'));
    act(() => onForeground(press('ps.attack.a3', 'Home')));
    for (const call of mockRefNavigate.mock.calls) {
      expect(call).toEqual(['Tabs', { screen: 'Home' }]);
    }
  });
});

describe('W09-03 attack: bounds and ordering while nothing is subscribed', () => {
  it('A4 a burst of alternating taps before any navigator exists drains bounded, deduplicated, in press order, ending on the last tap', async () => {
    const onBackground = backgroundHandler();
    const targets = ['Home', 'Performance'] as const;
    for (let i = 0; i < 12; i += 1) {
      await onBackground(press(`ps.attack.a4.${i}`, targets[i % 2]!));
    }
    expect(mockRefNavigate).not.toHaveBeenCalled();

    renderRoot();
    containerBecomesReady();
    await flushMicrotasks();
    const screens = mockRefNavigate.mock.calls.map(
      call => (call[1] as { screen: string }).screen,
    );
    expect(screens.length).toBeLessThanOrEqual(
      notificationService.MAX_QUEUED_NOTIFICATION_PRESSES,
    );
    expect(new Set(screens).size).toBe(screens.length);
    expect(screens.at(-1)).toBe('Performance');
    expect(screens).toEqual(['Home', 'Performance']);
  });

  it('A5 enqueueBounded boundary values: limit 0 / 1 / negative never grow past the limit and never return the original array', () => {
    const { enqueueBounded } = notificationService;
    expect(enqueueBounded([], 'Home', 1)).toEqual(['Home']);
    expect(enqueueBounded(['Home'], 'Performance', 1)).toEqual(['Performance']);
    expect(enqueueBounded(['Home'], 'Home', 0)).toEqual([]);
    expect(enqueueBounded([], 'Home', 0)).toEqual([]);
    expect(enqueueBounded(['Home'], 'Performance', -1)).toEqual([]);
    const original = ['Home'];
    const next = enqueueBounded(original, 'Home');
    expect(next).not.toBe(original);
    expect(original).toEqual(['Home']);
  });
});

describe('W09-03 attack: lifecycle races', () => {
  it('A6 a tap that arrives while signed out (navigator unmounted) is replayed exactly once into the next sign-in, never twice', async () => {
    const first = renderRoot();
    containerBecomesReady();
    const onBackground = backgroundHandler();
    unmount(first);

    await onBackground(press('ps.attack.a6', 'Performance'));
    await onBackground(press('ps.attack.a6', 'Performance'));
    expect(mockRefNavigate).not.toHaveBeenCalled();

    const second = renderRoot();
    await flushMicrotasks();
    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);

    unmount(second);
    renderRoot();
    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate).toHaveBeenCalledTimes(1);
  });

  it('A7 the cold-start read resolving after the navigator unmounted is held for the next mount and dispatched exactly once (iOS hands the initial notification out once)', async () => {
    let resolveInitial!: (value: unknown) => void;
    mocked.getInitialNotification.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveInitial = resolve;
        }),
    );
    const first = renderRoot();
    containerBecomesReady();
    unmount(first);

    resolveInitial({
      notification: { id: 'ps.attack.a7', data: { screen: 'Home' } },
    });
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    renderRoot();
    await flushMicrotasks();
    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate.mock.calls).toEqual([['Tabs', { screen: 'Home' }]]);
  });

  it('A8 a foreground tap during the ready-event replay itself is not lost and not duplicated', () => {
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => onForeground(press('ps.attack.a8.early', 'Performance')));

    mockRefNavigate.mockImplementationOnce(() => {
      onForeground(press('ps.attack.a8.reentrant', 'Home'));
    });
    containerBecomesReady();
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
      ['Tabs', { screen: 'Home' }],
    ]);
  });

  it('A12 StrictMode double-invoked effects (subscribe → unsubscribe → subscribe) still dispatch a held tap and a later tap exactly once', async () => {
    const onBackground = backgroundHandler();
    await onBackground(press('ps.attack.a12.early', 'Performance'));

    renderRoot(true);
    expect(mocked.onForegroundEvent.mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();

    containerBecomesReady();
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);

    act(() => foregroundHandler()(press('ps.attack.a12.late', 'Home')));
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
      ['Tabs', { screen: 'Home' }],
    ]);
  });

  it('A9 two overlapping subscribers: when the newer one unsubscribes, the surviving mounted navigator still receives presses', async () => {
    const first = renderRoot();
    containerBecomesReady();
    const firstForeground = foregroundHandlerAt(0);

    const second = renderRoot();
    unmount(second);
    mockRefReady.mockReturnValue(true);

    act(() => firstForeground(press('ps.attack.a9', 'Performance')));
    expect(mockRefNavigate.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);
    unmount(first);
  });
});

describe('W09-03 attack: malformed payloads', () => {
  it('A10 garbage on either channel and on the cold-start read never navigates and never throws', async () => {
    const onBackground = backgroundHandler();
    const bad: PressEvent[] = [
      { type: EventType.PRESS, detail: {} },
      { type: EventType.PRESS, detail: { notification: {} } },
      { type: EventType.PRESS, detail: { notification: { id: 'x' } } },
      {
        type: EventType.PRESS,
        detail: { notification: { id: 'x', data: null } },
      },
      {
        type: EventType.PRESS,
        detail: { notification: { id: 'x', data: 'Home' } },
      },
      {
        type: EventType.PRESS,
        detail: { notification: { id: 'x', data: { screen: ['Home'] } } },
      },
      {
        type: EventType.PRESS,
        detail: { notification: { id: 'x', data: { screen: 'home' } } },
      },
      {
        type: EventType.PRESS,
        detail: { notification: { id: 'x', data: { screen: 'Paywall' } } },
      },
      {
        type: EventType.PRESS,
        detail: {
          notification: {
            id: 'x',
            data: { screen: { valueOf: () => 'Home' } },
          },
        },
      },
      {
        type: EventType.DELIVERED,
        detail: { notification: { id: 'x', data: { screen: 'Home' } } },
      },
    ];
    for (const event of bad) await onBackground(event);

    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: { id: 'x', data: { screen: 'Settings' } },
    });
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => {
      for (const event of bad) onForeground(event);
    });
    containerBecomesReady();
    await flushMicrotasks();
    expect(mockRefNavigate).not.toHaveBeenCalled();
  });

  it('A11 a rejected cold-start read does not poison later presses', async () => {
    mocked.getInitialNotification.mockRejectedValueOnce(new Error('native'));
    renderRoot();
    await flushMicrotasks();
    containerBecomesReady();
    const onForeground = foregroundHandler();
    act(() => onForeground(press('ps.attack.a11', 'Home')));
    expect(mockRefNavigate.mock.calls).toEqual([['Tabs', { screen: 'Home' }]]);
  });
});
