/**
 * PremiumTabBar coach-action portal: the center + button opens an action
 * menu; these tests pin that the menu keeps its existing capture actions and
 * that the Drill Library entry navigates to the 'DrillLibrary' stack route on
 * the parent (root stack) navigator once the close animation settles.
 */
// The official react-native-reanimated/mock pulls in react-native-worklets'
// native initializers, which cannot load under jest; this minimal manual
// mock covers exactly the APIs the tab bar uses.
const mockWithTiming = jest.fn<unknown, [unknown, unknown]>(value => value);
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
    useSharedValue: jest.fn(
      (init: unknown) => React.useRef({ value: init }).current,
    ),
    withTiming: (toValue: unknown, config: unknown) =>
      mockWithTiming(toValue, config),
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
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

let mockReducedMotion = false;
jest.mock('../src/design/components', () => {
  const actual = jest.requireActual<typeof import('../src/design/components')>(
    '../src/design/components',
  );
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useSharedValue } from 'react-native-reanimated';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../src/navigation/PremiumTabBar';
import { Icon } from '../src/design/icons';
import { color, space } from '../src/design/tokens';

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

function controlByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function controlStyle(node: TestRenderer.ReactTestInstance) {
  return StyleSheet.flatten(
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style,
  );
}

function coachPanel(renderer: TestRenderer.ReactTestRenderer) {
  let panel = controlByLabel(renderer, 'Auto Analyze').parent;
  while (panel && panel.props.pointerEvents !== 'box-none')
    panel = panel.parent;
  if (!panel) throw new Error('No Coach action panel');
  return panel;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  await act(async () => {
    controlByLabel(renderer, label).props.onPress();
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
    mockReducedMotion = false;
    mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
    jest.mocked(useSharedValue).mockClear();
    mockWithTiming.mockClear();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    { width: 375, height: 667, top: 20, bottom: 0 },
    { width: 393, height: 852, top: 59, bottom: 34 },
    { width: 320, height: 568, top: 20, bottom: 0 },
  ])(
    'bounds every Coach action in a scrollable viewport at $width × $height / 3.571x',
    async dimensions => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width: dimensions.width,
        height: dimensions.height,
        scale: 3,
        fontScale: 3.571,
      });
      mockInsets = {
        top: dimensions.top,
        bottom: dimensions.bottom,
        left: 0,
        right: 0,
      };
      mockReducedMotion = true;
      const renderer = renderBar();
      await pressByLabel(renderer, 'Open coach actions');
      const panel = coachPanel(renderer);
      const bounds = StyleSheet.flatten(panel.props.style);
      expect(panel.props.pointerEvents).toBe('box-none');
      expect(bounds.bottom).toBe(dimensions.bottom + 70 + space.xl);
      expect(bounds.maxHeight).toBe(
        dimensions.height - dimensions.top - space.md - bounds.bottom,
      );
      expect(dimensions.height - bounds.bottom - bounds.maxHeight).toBe(
        dimensions.top + space.md,
      );
      expect(bounds.maxHeight).toBeLessThan(3 * 244 + 20);
      const scroll = panel.findByType(ScrollView);
      expect(scroll.props.scrollEnabled).not.toBe(false);
      expect(scroll.props.bounces).toBe(false);
      expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never');
      expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
      expect(scroll.props.removeClippedSubviews).toBe(false);
      expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: 380,
      });
      for (const label of ['Auto Analyze', 'Import Video', 'Drill Library']) {
        const action = controlByLabel(renderer, label);
        expect(scroll.findAll(node => node === action)).toHaveLength(1);
        expect(controlStyle(action).minHeight).toBeGreaterThanOrEqual(44);
        expect(controlStyle(action).height).toBeUndefined();
        for (const text of action.findAllByType(Text)) {
          expect(text.props.numberOfLines).toBeUndefined();
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          expect(text.props.adjustsFontSizeToFit).not.toBe(true);
          expect(text.props.allowFontScaling).not.toBe(false);
        }
      }
      await pressByLabel(renderer, 'Import Video');
      await pressByLabel(renderer, 'Close coach actions');
      await flushCloseAnimation();
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'library',
      });
      act(() => renderer.unmount());
    },
  );

  it('keeps default Coach row geometry and bottom anchoring instead of expanding a fitting menu', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const panel = coachPanel(renderer);
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({
      bottom: 102,
    });
    const scroll = panel.findByType(ScrollView);
    expect(StyleSheet.flatten(scroll.props.style).flexGrow).toBe(0);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).gap).toBe(10);
    for (const label of ['Auto Analyze', 'Import Video', 'Drill Library']) {
      expect(controlStyle(controlByLabel(renderer, label))).toMatchObject({
        minHeight: 68,
        paddingHorizontal: 12,
        paddingVertical: 10,
      });
    }
    expect(mockWithTiming).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ duration: 210 }),
    );
    await pressByLabel(renderer, 'Close coach actions');
    await flushCloseAnimation();
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('uses a flat volt FAB with the same 68pt target and neutral tab descriptors', () => {
    const renderer = renderBar();
    const fab = controlByLabel(renderer, 'Open coach actions');
    expect(controlStyle(fab)).toMatchObject({
      width: 68,
      height: 68,
      top: -24,
    });
    expect(
      fab
        .findAllByType(View)
        .some(
          view =>
            StyleSheet.flatten(view.props.style)?.backgroundColor ===
            color.volt,
        ),
    ).toBe(true);
    expect(
      fab
        .findAllByType(View)
        .every(
          view =>
            (StyleSheet.flatten(view.props.style)?.shadowOpacity ?? 0) === 0,
        ),
    ).toBe(true);
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    const tabs = ['Home', 'Library', 'Progress', 'Settings'].map(label =>
      controlByLabel(renderer, label),
    );
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) {
      expect(tab.props.accessibilityRole).toBe('tab');
      const style = controlStyle(tab);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(tab.findByType(Icon).props.color).toBe(
        tab.props.accessibilityState.selected ? color.ink : color.inkSoft,
      );
    }
    act(() => renderer.unmount());
  });

  it('keeps secondary coach actions neutral with upload and library glyphs and unchanged targets', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    for (const [label, iconName] of [
      ['Import Video', 'upload'],
      ['Drill Library', 'library'],
    ]) {
      const action = controlByLabel(renderer, label!);
      expect(controlStyle(action).minHeight).toBeGreaterThanOrEqual(44);
      const icon = action
        .findAllByType(Icon)
        .find(node => node.props.name === iconName)!;
      expect(icon).toBeDefined();
      expect(StyleSheet.flatten(icon.parent!.props.style).backgroundColor).toBe(
        color.surfaceAlt,
      );
      let ancestor = action.parent;
      while (ancestor && ancestor.props.pointerEvents !== 'box-none')
        ancestor = ancestor.parent;
      expect(ancestor).not.toBeNull();
    }
    expect(
      renderer.root
        .findAllByType(Icon)
        .some(icon => icon.props.name === 'flame'),
    ).toBe(false);
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    const overlay = renderer.root.findAll(node => {
      if (node.props.accessibilityLabel !== 'Close coach actions') return false;
      if (typeof node.props.onPress !== 'function') return false;
      const style = controlStyle(node);
      return style?.width === 68 && style.bottom === 26;
    })[0]!;
    expect(controlStyle(overlay)).toMatchObject({
      width: 68,
      height: 68,
      bottom: 26,
      left: '50%',
      marginLeft: -34,
    });
    act(() => renderer.unmount());
  });

  it('preserves the reduced-motion close delay and runs a selected action only once', async () => {
    mockReducedMotion = true;
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const progress = jest.mocked(useSharedValue).mock.results[0]!.value;
    expect(progress.value).toBe(1);
    const row = controlByLabel(renderer, 'Drill Library');
    expect(
      StyleSheet.flatten(row.props.style({ pressed: true })).transform,
    ).toBeUndefined();
    await pressByLabel(renderer, 'Drill Library');
    expect(mockRootNavigate).not.toHaveBeenCalled();
    expect(progress.value).toBe(0);
    expect(mockWithTiming).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1));
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('settles directly when reduced motion changes and keeps the pending close action', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const progress = jest.mocked(useSharedValue).mock.results[0]!.value;
    expect(mockWithTiming).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ duration: 210 }),
    );
    mockReducedMotion = true;
    mockWithTiming.mockClear();
    await act(async () => renderer.update(<PremiumTabBar {...makeProps()} />));
    expect(progress.value).toBe(1);
    expect(mockWithTiming).not.toHaveBeenCalled();
    await pressByLabel(renderer, 'Drill Library');
    await pressByLabel(renderer, 'Close coach actions');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    expect(mockWithTiming).not.toHaveBeenCalled();
    act(() => renderer.unmount());
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
