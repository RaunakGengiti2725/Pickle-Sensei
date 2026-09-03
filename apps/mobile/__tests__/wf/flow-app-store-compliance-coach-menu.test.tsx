/**
 * App Store compliance sweep — the Coach tab (App Review 2.1 / 4.2).
 *
 * The bottom tab navigator registers an "Add" tab backed by an empty
 * `CoachActionPortal` component. Users must never reach that blank screen:
 * the custom tab bar intercepts the slot and renders the Coach FAB + action
 * menu instead. These tests drive the FAB, every action row (including the
 * gated Paywall and local-only ConnectAccount branches), both dismissals,
 * a double tap, and the four real tabs, asserting nothing ever navigates to
 * 'Add' and every control has a wired handler and accessibility props.
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
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockAccess: {
  canonicalAccess: { canStartRating: boolean } | null;
  status: 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
  initialize: jest.Mock<Promise<void>, []>;
} = {
  canonicalAccess: { canStartRating: true },
  status: 'ready',
  initialize: jest.fn(async () => undefined),
};
const mockAuth: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/state/accessStore', () => ({
  useAccessStore: {
    getState: () => ({
      canonicalAccess: mockAccess.canonicalAccess,
      status: mockAccess.status,
      initialize: mockAccess.initialize,
    }),
  },
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: {
    getState: () => ({ session: mockAuth.session }),
  },
}));

import React from 'react';
import { Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));

const ROUTES = [
  { key: 'Home-1', name: 'Home' },
  { key: 'Library-1', name: 'Library' },
  { key: 'Add-1', name: 'Add' },
  { key: 'Performance-1', name: 'Performance' },
  { key: 'Settings-1', name: 'Settings' },
];

function makeProps(index = 0): BottomTabBarProps {
  return {
    state: { index, routes: ROUTES },
    navigation: {
      emit: mockEmit,
      navigate: mockTabNavigate,
      getParent: () => ({ navigate: mockRootNavigate }),
    },
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
}

function renderBar(index = 0) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PremiumTabBar {...makeProps(index)} />);
  });
  return renderer;
}

function pressablesByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = pressablesByLabel(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

async function flushCloseAnimation() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

function menuVisible(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Modal).props.visible === true;
}

describe('Coach tab — FAB and action menu replace the empty Add portal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAccess.canonicalAccess = { canStartRating: true };
    mockAccess.status = 'ready';
    mockAccess.initialize = jest.fn(async () => undefined);
    mockAuth.session = { localOnly: false };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('the Add slot renders the Coach FAB (button role, expanded state) instead of a tab', () => {
    const renderer = renderBar();
    const [fab] = pressablesByLabel(renderer, 'Open coach actions');
    expect(fab).toBeDefined();
    expect(fab!.props.accessibilityRole).toBe('button');
    expect(fab!.props.accessibilityState).toEqual({ expanded: false });
    // No tab-role control exists for the Add route.
    const tabs = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'tab',
    );
    expect(tabs.map(t => t.props.accessibilityLabel)).toEqual([
      'Home',
      'Library',
      'Progress',
      'Settings',
    ]);
    expect(menuVisible(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('real tabs navigate to their own routes and never to Add', async () => {
    const renderer = renderBar(0);
    for (const label of ['Library', 'Progress', 'Settings']) {
      await pressByLabel(renderer, label);
    }
    expect(mockTabNavigate.mock.calls.map(call => call[0])).toEqual([
      'Library',
      'Performance',
      'Settings',
    ]);
    // Pressing the focused tab re-emits tabPress but does not navigate.
    await pressByLabel(renderer, 'Home');
    expect(mockTabNavigate).toHaveBeenCalledTimes(3);
    expect(mockEmit).toHaveBeenCalledTimes(4);
    expect(mockTabNavigate).not.toHaveBeenCalledWith('Add', undefined);
    act(() => renderer.unmount());
  });

  it('FAB opens the menu with three labeled, hinted action rows and flips to expanded', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    expect(menuVisible(renderer)).toBe(true);
    for (const [title, hint] of [
      ['Auto Analyze', 'Auto capture · validated scores only'],
      ['Import Video', 'Choose a real clip from this phone'],
      ['Drill Library', 'Guided drills you can search'],
    ]) {
      const [row] = pressablesByLabel(renderer, title!);
      expect(row).toBeDefined();
      expect(row!.props.accessibilityRole).toBe('button');
      expect(row!.props.accessibilityHint).toBe(hint);
    }
    // In-bar FAB now reads as the close control with expanded=true.
    const closers = pressablesByLabel(renderer, 'Close coach actions');
    expect(closers.length).toBeGreaterThanOrEqual(2);
    expect(
      closers.some(n => n.props.accessibilityState?.expanded === true),
    ).toBe(true);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('backdrop, FAB, and hardware back all dismiss the menu without navigating', async () => {
    const renderer = renderBar();

    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Close coach actions');
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(false);

    await pressByLabel(renderer, 'Open coach actions');
    const modal = renderer.root.findByType(Modal);
    await act(async () => {
      modal.props.onRequestClose();
    });
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(false);

    expect(mockRootNavigate).not.toHaveBeenCalled();
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('Auto Analyze → Analyze {source: camera} once the close animation settles', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    expect(mockRootNavigate).not.toHaveBeenCalled();
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(menuVisible(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('gated: no free ratings left → Paywall {source: rating} instead of the camera', async () => {
    mockAccess.canonicalAccess = { canStartRating: false };
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Import Video');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it('gated: local-only session → ConnectAccount, no access lookup', async () => {
    mockAuth.session = { localOnly: true };
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('unknown access → Analyze gate (which resolves it) without awaiting; a failed check still resolves to the Paywall', async () => {
    // The bar never awaits initialize(): an unchecked ('idle') account is
    // handed to the Analyze route whose gate shows "Checking access…".
    mockAccess.canonicalAccess = null;
    mockAccess.status = 'idle';
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    await act(async () => {});
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    act(() => renderer.unmount());

    // Backend unreachable: access stays null with status 'error' → honest
    // Paywall route, never a hang and never the blank Add screen.
    mockRootNavigate.mockClear();
    mockAccess.canonicalAccess = null;
    mockAccess.status = 'error';
    const second = renderBar();
    await pressByLabel(second, 'Open coach actions');
    await pressByLabel(second, 'Import Video');
    await flushCloseAnimation();
    await act(async () => {});
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => second.unmount());
  });

  it('double tap on an action row navigates exactly once', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const [row] = pressablesByLabel(renderer, 'Drill Library');
    await act(async () => {
      row!.props.onPress();
      row!.props.onPress();
    });
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('unmounting mid-close never fires a navigation after teardown', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Drill Library');
    act(() => renderer.unmount());
    await flushCloseAnimation();
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });
});
