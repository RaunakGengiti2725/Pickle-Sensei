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
import {
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useSharedValue } from 'react-native-reanimated';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../src/navigation/PremiumTabBar';
import {
  TAB_BAR_HEIGHT,
  TAB_BAR_SIDE_INSET,
  tabBarBottomOffset,
  tabBarFootprint,
} from '../src/navigation/tabBarLayout';
import { useTabBarDockStore } from '../src/navigation/tabBarDock';
import { Icon } from '../src/design/icons';
import { color, radius, shadow, space } from '../src/design/tokens';

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
      // The menu rises from the floating bar's top edge, wherever it rests.
      expect(bounds.bottom).toBe(tabBarFootprint(dimensions.bottom) + space.xl);
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
    // 12 (bar lift, no home indicator) + 70 (bar) + 32 (arrow lane).
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({
      bottom: 114,
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
      expect(tab.props.accessibilityRole).toBe('button');
      expect(typeof tab.props.accessibilityState.selected).toBe('boolean');
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
    // The overlay copy sits exactly over the in-bar button: the bar rests 12
    // above the screen edge here and the button's bottom is 26 up the bar.
    const overlay = renderer.root.findAll(node => {
      if (node.props.accessibilityLabel !== 'Close coach actions') return false;
      if (typeof node.props.onPress !== 'function') return false;
      const style = controlStyle(node);
      return style?.width === 68 && style.bottom === 38;
    })[0]!;
    expect(controlStyle(overlay)).toMatchObject({
      width: 68,
      height: 68,
      bottom: 38,
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

/**
 * The bar floats: a rounded card positioned over the screens, a little above
 * the home indicator, with the surface showing around it. It takes no layout
 * room (screens reserve `useTabBarContentInset()` instead). Once the focused
 * page is scrolled to its end it latches onto the bottom of the screen — the
 * docked bar as it always sat — and lets go again as the page scrolls up.
 */
describe('PremiumTabBar floating geometry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion = true;
    mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    act(() => useTabBarDockStore.setState({ docked: {} }));
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
    jest.mocked(useSharedValue).mockClear();
    mockWithTiming.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function barNode(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.find(
      node => node.type === View && node.props.testID === 'premium-tab-bar',
    );
  }

  function barStyle(renderer: TestRenderer.ReactTestRenderer) {
    return StyleSheet.flatten(barNode(renderer).props.style);
  }

  it.each([
    { label: 'iOS home button', os: 'ios', bottom: 0, expectedLift: 12 },
    { label: 'iOS home indicator', os: 'ios', bottom: 34, expectedLift: 20 },
    {
      label: 'Android gesture nav',
      os: 'android',
      bottom: 24,
      expectedLift: 32,
    },
    {
      label: 'Android 3-button nav',
      os: 'android',
      bottom: 48,
      expectedLift: 56,
    },
  ])(
    'rests $expectedLift above the screen edge with a $label ($bottom inset)',
    ({ os, bottom, expectedLift }) => {
      jest.replaceProperty(Platform, 'OS', os as 'ios');
      mockInsets = { top: 59, bottom, left: 0, right: 0 };
      const renderer = renderBar();
      expect(tabBarBottomOffset(bottom)).toBe(expectedLift);
      expect(barStyle(renderer)).toMatchObject({
        position: 'absolute',
        bottom: expectedLift,
        left: TAB_BAR_SIDE_INSET,
        right: TAB_BAR_SIDE_INSET,
        height: TAB_BAR_HEIGHT,
        borderRadius: radius.lg,
        // Floating, the bar itself never stretches to the screen edge.
        paddingBottom: 0,
      });
      act(() => renderer.unmount());
    },
  );

  it('sits just above the home indicator: the card dips into the 34pt inset rather than riding on top of it', () => {
    mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
    const renderer = renderBar();
    const style = barStyle(renderer);
    expect(style.bottom).toBeLessThan(34);
    expect(style.bottom).toBe(20);
    act(() => renderer.unmount());
  });

  it('keeps the existing colors; floating, the top rule becomes a card edge with a downward shadow', () => {
    const renderer = renderBar();
    const style = barStyle(renderer);
    expect(style.backgroundColor).toBe(color.tabBar);
    expect(style.borderColor).toBe(color.line);
    expect(style.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(style.borderLeftWidth).toBe(StyleSheet.hairlineWidth);
    expect(style.borderRightWidth).toBe(StyleSheet.hairlineWidth);
    expect(style.borderBottomWidth).toBe(StyleSheet.hairlineWidth);
    expect(style.shadowColor).toBe(shadow.floating.shadowColor);
    expect(style.shadowOpacity).toBe(shadow.floating.shadowOpacity);
    expect(style.shadowOffset.height).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it.each([0, 34])(
    'latches onto the bottom of the screen — full width, square, flush — once the focused page reaches its end (%s inset)',
    async bottom => {
      mockInsets = { top: 59, bottom, left: 0, right: 0 };
      act(() => useTabBarDockStore.getState().setDocked('Home', true));
      const renderer = renderBar();
      const style = barStyle(renderer);
      // The docked frame is the bar as it sat before it floated.
      expect(style).toMatchObject({
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: TAB_BAR_HEIGHT + bottom,
        paddingBottom: bottom,
        borderRadius: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: 0,
        borderRightWidth: 0,
        borderBottomWidth: 0,
        backgroundColor: color.tabBar,
        borderColor: color.line,
        shadowOpacity: 0.055,
        shadowRadius: 20,
      });
      expect(style.shadowOffset.height).toBeLessThan(0);
      // The Coach menu and overlay button follow the docked row.
      await pressByLabel(renderer, 'Open coach actions');
      const overlay = renderer.root
        .findAll(
          node =>
            node.props.accessibilityLabel === 'Close coach actions' &&
            node.props.accessibilityState?.expanded === true &&
            typeof node.props.onPress === 'function',
        )
        .map(controlStyle)
        .find(style_ => style_.left === '50%');
      expect(overlay).toMatchObject({ bottom: bottom + 26 });
      expect(StyleSheet.flatten(coachPanel(renderer).props.style).bottom).toBe(
        bottom + TAB_BAR_HEIGHT + space.xl,
      );
      act(() => renderer.unmount());
    },
  );

  it('reads the latch of the FOCUSED tab only', () => {
    act(() => useTabBarDockStore.getState().setDocked('Library', true));
    // Home is focused (index 0): Library's latch does not dock the bar.
    const renderer = renderBar();
    expect(barStyle(renderer)).toMatchObject({
      bottom: 12,
      left: TAB_BAR_SIDE_INSET,
      borderRadius: radius.lg,
    });
    // Focus Library. The reanimated mock evaluates the animated style during
    // render, while the latch effect writes the shared value afterwards, so a
    // second render is what reads it back (on device the UI thread does).
    const focusLibrary = () =>
      renderer.update(
        <PremiumTabBar
          {...makeProps()}
          state={{ ...makeProps().state, index: 1 }}
        />,
      );
    act(focusLibrary);
    act(focusLibrary);
    expect(barStyle(renderer)).toMatchObject({
      bottom: 0,
      left: 0,
      right: 0,
      borderRadius: 0,
    });
    act(() => renderer.unmount());
  });

  it('animates the latch with a 240ms ease-out, and snaps under reduced motion', () => {
    mockReducedMotion = false;
    const renderer = renderBar();
    // results[0] is the menu progress; the dock value follows it.
    const dock = jest.mocked(useSharedValue).mock.results[1]!.value;
    expect(dock.value).toBe(0);
    mockWithTiming.mockClear();
    act(() => useTabBarDockStore.getState().setDocked('Home', true));
    expect(mockWithTiming).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 240 }),
    );
    // The floating→docked animation never restarts the menu's own timing.
    expect(mockWithTiming).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 210 }),
    );
    mockReducedMotion = true;
    mockWithTiming.mockClear();
    act(() => renderer.update(<PremiumTabBar {...makeProps()} />));
    act(() => useTabBarDockStore.getState().setDocked('Home', false));
    expect(dock.value).toBe(0);
    expect(mockWithTiming).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('adds the horizontal safe-area insets to the side gaps', () => {
    // Landscape on a Face ID phone: 21 under, 44 either side.
    mockInsets = { top: 0, bottom: 21, left: 44, right: 44 };
    const renderer = renderBar();
    expect(StyleSheet.flatten(barNode(renderer).props.style)).toMatchObject({
      left: TAB_BAR_SIDE_INSET + 44,
      right: TAB_BAR_SIDE_INSET + 44,
      bottom: 12,
    });
    act(() => renderer.unmount());
  });

  it.each([0, 34])(
    'anchors the overlay Coach button and the menu to the resting bar (%s inset)',
    async bottom => {
      mockInsets = { top: 59, bottom, left: 0, right: 0 };
      const renderer = renderBar();
      await pressByLabel(renderer, 'Open coach actions');
      const lift = tabBarBottomOffset(bottom);
      // In-bar button: rises 24 above a 70 bar, so its bottom edge is 26 up.
      const overlay = renderer.root
        .findAll(
          node =>
            node.props.accessibilityLabel === 'Close coach actions' &&
            node.props.accessibilityState?.expanded === true &&
            typeof node.props.onPress === 'function',
        )
        .map(controlStyle)
        .find(style => style.left === '50%');
      expect(overlay).toMatchObject({ bottom: lift + 26 });
      expect(StyleSheet.flatten(coachPanel(renderer).props.style).bottom).toBe(
        lift + TAB_BAR_HEIGHT + space.xl,
      );
      act(() => renderer.unmount());
    },
  );

  it('dims the whole screen behind the menu, the floating bar included', async () => {
    mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const scrim = renderer.root
      .findAllByType(View)
      .map(node => StyleSheet.flatten(node.props.style))
      .find(style => style?.backgroundColor === color.overlayStrong);
    expect(scrim).toMatchObject({
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: color.overlayStrong,
    });
    act(() => renderer.unmount());
  });
});
