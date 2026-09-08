/**
 * INT-ui-flows-a11y adversary — ScreenHeader at the largest accessibility
 * Dynamic Type size (AX5, fontScale 3.571).
 *
 * The header's centre column is what is left of the 393pt (iPhone 16 / 15 /
 * 14) width after two 44pt side slots + 8pt hit slop + 20pt horizontal
 * padding on each side: ~245pt. type.h3 is 17pt; at 3.571x it renders at
 * ~60.7pt. Using SF Pro Semibold's conservative ~0.5em average advance, any
 * title longer than ~8 characters is wider than the column, so a single-line
 * title (`numberOfLines={1}`) without wrapping, `adjustsFontSizeToFit` or a
 * font-scale cap is clipped to an ellipsis — the screen loses its name for
 * exactly the users who rely on AX sizes.
 *
 * Shipping headers without `wrapTitle` (grep on HEAD): "Stroke analysis",
 * "Saved capture", "Full breakdown", "Form review", "Consistency",
 * "Notifications", "Manage account", "Drill Library", "Data & consent",
 * "Confirm technique", "Capture complete", "Auto Analyze".
 *
 * Passing counter-check: a `wrapTitle` header (StreakCalendarScreen) expands
 * at fontScale >= 2 and lets its title wrap.
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
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
    withSpring: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ScreenHeader } from '../../src/design/components';
import { type } from '../../src/design/tokens';

const AX5_FONT_SCALE = 3.571;
const IPHONE_WIDTH = 393;
const SIDE_SLOT = 44 + 8;
const SCREEN_PADDING = 20;
const CENTER_WIDTH = IPHONE_WIDTH - 2 * (SIDE_SLOT + SCREEN_PADDING);
const AVERAGE_ADVANCE_EM = 0.5;

const SHIPPING_TITLES = [
  'Stroke analysis',
  'Saved capture',
  'Full breakdown',
  'Form review',
  'Consistency',
  'Notifications',
  'Manage account',
  'Drill Library',
  'Data & consent',
  'Confirm technique',
  'Capture complete',
  'Auto Analyze',
];

function estimatedTitleWidthPt(title: string, fontScale: number): number {
  return title.length * AVERAGE_ADVANCE_EM * type.h3.fontSize * fontScale;
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function titleNode(renderer: TestRenderer.ReactTestRenderer, title: string) {
  const [node] = renderer.root.findAll(
    n => n.type === Text && n.props.children === title,
  );
  if (!node) throw new Error(`title ${title} not rendered`);
  return node;
}

function fitsOnOneLine(node: TestRenderer.ReactTestInstance) {
  const style = StyleSheet.flatten(node.props.style) as {
    fontSize?: number;
  };
  return (
    node.props.adjustsFontSizeToFit === true ||
    node.props.allowFontScaling === false ||
    typeof node.props.maxFontSizeMultiplier === 'number' ||
    (typeof style.fontSize === 'number' && style.fontSize < type.h3.fontSize)
  );
}

describe('adv: ScreenHeader at AX5 Dynamic Type', () => {
  beforeEach(() => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: IPHONE_WIDTH,
      height: 852,
      scale: 3,
      fontScale: AX5_FONT_SCALE,
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('every shipping single-line title is wider than the centre column at 3.571x', () => {
    for (const title of SHIPPING_TITLES) {
      expect(estimatedTitleWidthPt(title, AX5_FONT_SCALE)).toBeGreaterThan(
        CENTER_WIDTH,
      );
    }
  });

  it.each(SHIPPING_TITLES)(
    '"%s" is not clipped to one line at 3.571x (wraps, shrinks to fit, or caps scaling)',
    title => {
      const renderer = render(<ScreenHeader title={title} onBack={() => {}} />);
      const node = titleNode(renderer, title);
      const clippedToOneLine =
        node.props.numberOfLines === 1 && !fitsOnOneLine(node);
      expect(clippedToOneLine).toBe(false);
      act(() => renderer.unmount());
    },
  );

  it('a wrapTitle header expands at >= 2x and lets the title wrap (control)', () => {
    const renderer = render(
      <ScreenHeader title="Consistency calendar" wrapTitle onBack={() => {}} />,
    );
    const node = titleNode(renderer, 'Consistency calendar');
    expect(node.props.numberOfLines).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('at the default size the single-line header is the intended layout (control)', () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: IPHONE_WIDTH,
      height: 852,
      scale: 3,
      fontScale: 1,
    });
    const renderer = render(
      <ScreenHeader title="Stroke analysis" onBack={() => {}} />,
    );
    expect(estimatedTitleWidthPt('Stroke analysis', 1)).toBeLessThan(
      CENTER_WIDTH,
    );
    expect(titleNode(renderer, 'Stroke analysis').props.numberOfLines).toBe(1);
    act(() => renderer.unmount());
  });
});
