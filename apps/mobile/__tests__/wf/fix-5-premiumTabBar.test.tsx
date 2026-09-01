/**
 * PremiumTabBar capture actions: routing is decided synchronously from the
 * access store snapshot. A known verdict routes straight to Analyze or
 * Paywall; an unresolved (idle/loading) check hands off to the Analyze route,
 * whose gate shows "Checking access…" and waits — never to the Paywall. A
 * dismiss tap during the close animation must keep the chosen action, and
 * the backdrop is an announced button.
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

const mockAccessState: {
  status: string;
  canonicalAccess: { canStartRating: boolean } | null;
  initialize: jest.Mock;
} = {
  status: 'idle',
  canonicalAccess: null,
  initialize: jest.fn(async () => {}),
};
jest.mock('../../src/state/accessStore', () => ({
  useAccessStore: { getState: () => mockAccessState },
}));

const mockAuthState: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: { getState: () => mockAuthState },
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));

function makeProps(): BottomTabBarProps {
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
      emit: mockEmit,
      navigate: mockTabNavigate,
      getParent: () => ({ navigate: mockRootNavigate }),
    },
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
}

function renderBar() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PremiumTabBar {...makeProps()} />);
  });
  return renderer;
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = findByLabel(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
}

async function flushCloseAnimation() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

async function chooseCaptureAction(
  label: 'Auto Analyze' | 'Import Video',
): Promise<TestRenderer.ReactTestRenderer> {
  const renderer = renderBar();
  await pressByLabel(renderer, 'Open coach actions');
  await pressByLabel(renderer, label);
  await flushCloseAnimation();
  return renderer;
}

describe('PremiumTabBar capture routing (wf fix-5)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAccessState.status = 'idle';
    mockAccessState.canonicalAccess = null;
    mockAccessState.initialize = jest.fn(async () => {});
    mockAuthState.session = { localOnly: false };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hands an in-flight access check to the Analyze gate instead of the Paywall', async () => {
    mockAccessState.status = 'loading';
    const renderer = await chooseCaptureAction('Auto Analyze');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(mockAccessState.initialize).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('routes an idle (never checked) account to the Analyze gate without awaiting', async () => {
    const renderer = await chooseCaptureAction('Import Video');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'library',
    });
    act(() => renderer.unmount());
  });

  it('repeat taps while loading never reach the Paywall', async () => {
    mockAccessState.status = 'loading';
    const renderer = renderBar();
    for (let i = 0; i < 2; i += 1) {
      await pressByLabel(renderer, 'Open coach actions');
      await pressByLabel(renderer, 'Auto Analyze');
      await flushCloseAnimation();
    }
    expect(mockRootNavigate).toHaveBeenCalledTimes(2);
    expect(
      mockRootNavigate.mock.calls.every(([route]) => route === 'Analyze'),
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('sends a resolved free-eligible user straight to Analyze', async () => {
    mockAccessState.status = 'ready';
    mockAccessState.canonicalAccess = { canStartRating: true };
    const renderer = await chooseCaptureAction('Auto Analyze');
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    act(() => renderer.unmount());
  });

  it('sends a resolved exhausted allowance to the rating Paywall', async () => {
    mockAccessState.status = 'ready';
    mockAccessState.canonicalAccess = { canStartRating: false };
    const renderer = await chooseCaptureAction('Import Video');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it.each(['error', 'unconfigured'] as const)(
    'sends a failed access check (%s) to the rating Paywall',
    async status => {
      mockAccessState.status = status;
      const renderer = await chooseCaptureAction('Auto Analyze');
      expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
        source: 'rating',
      });
      act(() => renderer.unmount());
    },
  );

  it('sends a local-only session to ConnectAccount', async () => {
    mockAuthState.session = { localOnly: true };
    const renderer = await chooseCaptureAction('Auto Analyze');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');
    act(() => renderer.unmount());
  });
});

describe('PremiumTabBar coach menu dismissal (wf fix-5)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockAccessState.status = 'ready';
    mockAccessState.canonicalAccess = { canStartRating: true };
    mockAuthState.session = { localOnly: false };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a backdrop tap during the exit animation keeps the chosen action', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Drill Library');
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await pressByLabel(renderer, 'Close coach actions');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('an overlay + tap during the exit animation keeps the chosen action', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    const overlayFabs = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Close coach actions' &&
        n.props.accessibilityRole === 'button' &&
        n.props.accessibilityState?.expanded === true &&
        typeof n.props.onPress === 'function',
    );
    const overlayFab = overlayFabs[overlayFabs.length - 1];
    if (!overlayFab) throw new Error('No overlay coach button');
    await act(async () => {
      overlayFab.props.onPress();
    });
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    act(() => renderer.unmount());
  });

  it('a plain dismiss followed by a row tap still runs the row action once', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Close coach actions');
    await pressByLabel(renderer, 'Drill Library');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('a plain dismiss runs nothing', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Close coach actions');
    await flushCloseAnimation();
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('every dismiss pressable, including the backdrop, declares the button role', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const dismissers = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Close coach actions' &&
        typeof n.props.onPress === 'function',
    );
    expect(dismissers.length).toBeGreaterThanOrEqual(2);
    for (const node of dismissers) {
      expect(node.props.accessibilityRole).toBe('button');
    }
    act(() => renderer.unmount());
  });
});
