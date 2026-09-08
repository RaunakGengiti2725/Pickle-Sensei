/**
 * W09-03 adversarial suite, real navigation edition (attack branch). The
 * candidate's own suite fakes `isReady()` and the container's `ready` event;
 * this file mounts RootNavigator on the REAL @react-navigation container,
 * native-stack and bottom-tabs so the readiness hand-off the implementer
 * labelled UNKNOWN/INFERRED is exercised by the library itself. Only the
 * screens, stores and the notification native module are doubles. The
 * container ref's `navigate` is wrapped (not replaced) so dispatch counts are
 * observable while the real router still moves.
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

type ContainerRef =
  import('@react-navigation/native').NavigationContainerRefWithCurrent<
    Record<string, object | undefined>
  >;

const mockNavigateSpy = jest.fn();

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  const created: ContainerRef[] = [];
  return {
    ...actual,
    __createdContainerRefs: created,
    createNavigationContainerRef: () => {
      const ref =
        actual.createNavigationContainerRef<
          Record<string, object | undefined>
        >();
      const realNavigate = ref.navigate;
      ref.navigate = ((...args: Parameters<typeof realNavigate>) => {
        mockNavigateSpy(...args);
        return realNavigate(...args);
      }) as typeof realNavigate;
      created.push(ref);
      return ref;
    },
  };
});

import notifee, { EventType } from 'react-native-notify-kit';
import * as navigationModule from '@react-navigation/native';
import { RootNavigator } from '../src/navigation/RootNavigator';
import * as notificationService from '../src/notifications/service';

const mockRefs = (
  navigationModule as unknown as { __createdContainerRefs: ContainerRef[] }
).__createdContainerRefs;

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

function navigationRef() {
  const ref = mockRefs[0];
  if (!ref) throw new Error('RootNavigator did not create its container ref');
  return ref;
}

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

/** The focused tab of the mounted root, read from the real router state. */
function focusedTab(): string | undefined {
  const root = navigationRef().getRootState();
  if (!root) return undefined;
  const tabs = root.routes[root.index];
  if (!tabs || tabs.name !== 'Tabs' || !tabs.state) return undefined;
  const state = tabs.state;
  return state.index === undefined
    ? undefined
    : state.routes[state.index]?.name;
}

beforeEach(() => {
  mockNavigateSpy.mockClear();
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

describe('W09-03 attack on the real container', () => {
  it('R1 the navigator subscribes only once the real container is ready, so a mount never leaks a console.error from navigate()', async () => {
    const errors = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const onBackground = backgroundHandler();
    await onBackground(press('ps.real.r1', 'Performance'));
    expect(mockNavigateSpy).not.toHaveBeenCalled();

    renderRoot();
    await flushMicrotasks();
    expect(navigationRef().isReady()).toBe(true);
    expect(mockNavigateSpy.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);
    expect(focusedTab()).toBe('Performance');
    expect(
      errors.mock.calls.filter(call =>
        String(call[0]).includes("hasn't been initialized"),
      ),
    ).toEqual([]);
    errors.mockRestore();
  });

  it('R2 cold start: the initial-notification read of a tap already routed on the background channel is not dispatched again', async () => {
    const onBackground = backgroundHandler();
    await onBackground(press('ps.real.r2', 'Performance'));
    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: { id: 'ps.real.r2', data: { screen: 'Performance' } },
    });
    renderRoot();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(mockNavigateSpy).toHaveBeenCalledTimes(1);
    expect(focusedTab()).toBe('Performance');
  });

  it('R3 warm start: a foreground press after mount routes immediately and a Home press afterwards wins the tab', () => {
    renderRoot();
    const onForeground = foregroundHandler();
    act(() => onForeground(press('ps.real.r3.a', 'Performance')));
    expect(focusedTab()).toBe('Performance');
    act(() => onForeground(press('ps.real.r3.b', 'Home')));
    expect(focusedTab()).toBe('Home');
    expect(mockNavigateSpy).toHaveBeenCalledTimes(2);
  });

  it('R4 sign-out then sign-in (unmount + remount) with a tap in between dispatches once on the new container and does not touch the dead one', async () => {
    const first = renderRoot();
    await flushMicrotasks();
    const onBackground = backgroundHandler();
    unmount(first);
    expect(navigationRef().isReady()).toBe(false);

    await onBackground(press('ps.real.r4', 'Performance'));
    expect(mockNavigateSpy).not.toHaveBeenCalled();

    renderRoot();
    await flushMicrotasks();
    expect(mockNavigateSpy.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);
    expect(focusedTab()).toBe('Performance');
  });

  it('R6 StrictMode double-invoked effects on the real container: a held tap dispatches once and later taps route once each', async () => {
    const onBackground = backgroundHandler();
    await onBackground(press('ps.real.r6.early', 'Performance'));

    renderRoot(true);
    await flushMicrotasks();
    expect(mockNavigateSpy.mock.calls).toEqual([
      ['Tabs', { screen: 'Performance' }],
    ]);
    expect(focusedTab()).toBe('Performance');

    act(() => foregroundHandler()(press('ps.real.r6.late', 'Home')));
    expect(mockNavigateSpy).toHaveBeenCalledTimes(2);
    expect(focusedTab()).toBe('Home');
  });

  it('R5 the foreground listener is released on unmount so a press after sign-out is held, not delivered into a dead ref', async () => {
    const first = renderRoot();
    await flushMicrotasks();
    const onForeground = foregroundHandler();
    unmount(first);

    act(() => onForeground(press('ps.real.r5', 'Home')));
    expect(mockNavigateSpy).not.toHaveBeenCalled();

    renderRoot();
    await flushMicrotasks();
    expect(mockNavigateSpy.mock.calls).toEqual([['Tabs', { screen: 'Home' }]]);
    expect(focusedTab()).toBe('Home');
  });
});
