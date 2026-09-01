/**
 * PremiumTabBar coach-action portal: the center + button opens an action
 * menu; these tests pin that the menu keeps its existing capture actions and
 * that the Drill Library entry navigates to the 'DrillLibrary' stack route on
 * the parent (root stack) navigator once the close animation settles.
 */
// The official react-native-reanimated/mock pulls in react-native-worklets'
// native initializers, which cannot load under jest; this minimal manual
// mock covers exactly the APIs the tab bar uses.
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      // design/components.tsx wraps an SVG circle at module scope.
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
// The tab bar only reads these stores lazily inside the capture actions;
// minimal getState doubles keep the render free of billing/native imports.
jest.mock('../src/state/accessStore', () => ({
  useAccessStore: {
    getState: () => ({
      canonicalAccess: { canStartRating: true },
      initialize: async () => {},
    }),
  },
}));
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: {
    getState: () => ({ session: { localOnly: false } }),
  },
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../src/navigation/PremiumTabBar';

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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
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

describe('PremiumTabBar coach menu', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists Drill Library alongside the existing coach actions', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const copy = allText(renderer);
    // Existing entries stay untouched (Live Court is cut from the v1 menu).
    expect(copy).toContain('Auto Analyze');
    expect(copy).not.toContain('Live Court');
    expect(copy).toContain('Import Video');
    // New entry with its subtitle.
    expect(copy).toContain('Drill Library');
    expect(copy).toContain('Guided drills you can search');
    act(() => renderer.unmount());
  });

  it('navigates to the DrillLibrary stack route when Drill Library is pressed', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Drill Library');
    // Navigation is deferred until the menu close animation settles.
    expect(mockRootNavigate).not.toHaveBeenCalled();
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('routes Import Video through the rating flow, not the drill library', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Import Video');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'library',
    });
    act(() => renderer.unmount());
  });
});
