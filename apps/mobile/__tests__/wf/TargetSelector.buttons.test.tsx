/**
 * Button ledger for `src/camera/TargetSelector.tsx` ("Tap yourself").
 *
 * Every interactive element in the component is pressed here and its real
 * observable effect asserted:
 *   1. frame `TouchableWithoutFeedback` ("Tap yourself in the frame") → seeds
 *      the tap, draws the ring, flips the status copy, enables Analyze;
 *   2. `Button` "Analyze this player" → `onConfirm({ point, selectedAtIso })`
 *      with SOURCE-normalized coordinates; disabled + no-op until a tap;
 *   3. `Button` "Skip — pick automatically" → `onSkip()`;
 *   4. `Image.onError` → honest "Preview unavailable" fallback that still
 *      accepts taps (not a pressable, but the only other conditional branch).
 *
 * The component owns no async work: both callbacks are synchronous props the
 * parent (AnalyzeScreen) turns into `scoreCapture`, which carries its own
 * in-flight guard and error phase. The failure-path assertions therefore
 * live at the contract boundary: the selector must never call back with a
 * NaN / out-of-range point, must not throw on absent or degenerate source
 * dimensions, and must ignore taps before it has a measured layout.
 */
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  // One component per primitive so `findAllByType(Circle)` matches ONLY
  // circles (the design icons render paths/lines/rects through the same
  // module).
  const make = (name: string) => {
    const Mock = (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children);
    Mock.displayName = name;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Line: make('Line'),
    Path: make('Path'),
    Polyline: make('Polyline'),
    Rect: make('Rect'),
  };
});

import React from 'react';
import {
  Image,
  Text,
  TouchableWithoutFeedback,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Circle } from 'react-native-svg';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Button } from '../../src/design/components';
import {
  TargetSelector,
  viewPointToSourcePoint,
  type TargetSelection,
} from '../../src/camera/TargetSelector';

const FRAME_URI = 'file:///private/var/mobile/import.mov';
const POSTER_URI = 'file:///private/var/mobile/import.poster.jpg';
const NOW_ISO = '2026-09-01T12:00:00.000Z';
const VIEW = { width: 270, height: 480 };
const SOURCE = { width: 1920, height: 1080 };

type Props = React.ComponentProps<typeof TargetSelector>;

function render(overrides: Partial<Props> = {}) {
  const onConfirm = jest.fn<void, [TargetSelection]>();
  const onSkip = jest.fn<void, []>();
  const props: Props = {
    frameUri: FRAME_URI,
    posterUri: POSTER_URI,
    sourceWidth: SOURCE.width,
    sourceHeight: SOURCE.height,
    onConfirm,
    onSkip,
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<TargetSelector {...props} />);
  });
  return { renderer, onConfirm, onSkip };
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function frameTouchable(renderer: ReactTestRenderer) {
  return renderer.root.findByType(TouchableWithoutFeedback);
}

function frameView(renderer: ReactTestRenderer) {
  const matches = renderer.root.findAll(
    node => node.type === View && typeof node.props.onLayout === 'function',
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function layoutFrame(
  renderer: ReactTestRenderer,
  size: { width: number; height: number } = VIEW,
) {
  act(() => {
    frameView(renderer).props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, ...size } },
    } as LayoutChangeEvent);
  });
}

function tapFrame(renderer: ReactTestRenderer, x: number, y: number) {
  act(() => {
    frameTouchable(renderer).props.onPress({
      nativeEvent: { locationX: x, locationY: y },
    });
  });
}

function designButton(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/**
 * The underlying RN `Pressable` a design `Button` renders (what the finger
 * hits). `PressableScale` is the only element in the chain that forwards an
 * explicit `accessibilityState`, so that prop singles out the Pressable.
 */
function pressableFor(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityState !== undefined,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function allPressables(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityState !== undefined,
  );
}

function pressButton(renderer: ReactTestRenderer, label: string) {
  act(() => {
    pressableFor(renderer, label).props.onPress();
  });
}

/** The 26pt selection ring (the `person` fallback icon also draws a circle). */
function ringCircles(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType(Circle)
    .filter(node => node.props.r === 26);
}

function expectNormalized(point: { x: number; y: number }) {
  expect(Number.isFinite(point.x)).toBe(true);
  expect(Number.isFinite(point.y)).toBe(true);
  expect(point.x).toBeGreaterThanOrEqual(0);
  expect(point.x).toBeLessThanOrEqual(1);
  expect(point.y).toBeGreaterThanOrEqual(0);
  expect(point.y).toBeLessThanOrEqual(1);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TargetSelector button ledger', () => {
  it('renders exactly the three pressables, each with a button role and label', () => {
    const { renderer } = render();

    const frame = frameTouchable(renderer);
    expect(frame.props.accessibilityRole).toBe('button');
    expect(frame.props.accessibilityLabel).toBe('Tap yourself in the frame');
    expect(typeof frame.props.onPress).toBe('function');

    const pressables = allPressables(renderer);
    expect(pressables.map(node => node.props.accessibilityLabel)).toEqual([
      'Analyze this player',
      'Skip — pick automatically',
    ]);
    for (const node of pressables) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(typeof node.props.onPress).toBe('function');
    }

    // Only a tapped frame can be analyzed; the copy says so instead of
    // leaving a silently dead primary button.
    expect(pressableFor(renderer, 'Analyze this player').props.disabled).toBe(
      true,
    );
    expect(
      pressableFor(renderer, 'Analyze this player').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(
      pressableFor(renderer, 'Skip — pick automatically').props.disabled,
    ).toBeFalsy();
    expect(allText(renderer)).toContain('Tap the player to analyze');
    expect(ringCircles(renderer)).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('prefers the poster over the clip URI for the still frame', () => {
    const { renderer } = render();
    const image = renderer.root.findByType(Image);
    expect(image.props.source).toEqual({ uri: POSTER_URI });
    expect(image.props.resizeMode).toBe('cover');
    act(() => renderer.unmount());

    const { renderer: noPoster } = render({ posterUri: undefined });
    expect(noPoster.root.findByType(Image).props.source).toEqual({
      uri: FRAME_URI,
    });
    act(() => noPoster.unmount());
  });

  describe('frame tap → "Tap yourself in the frame"', () => {
    it('ignores taps before the frame has a measured layout (no NaN seed)', () => {
      const { renderer, onConfirm } = render();
      tapFrame(renderer, 100, 200);
      expect(ringCircles(renderer)).toHaveLength(0);
      expect(allText(renderer)).toContain('Tap the player to analyze');
      expect(pressableFor(renderer, 'Analyze this player').props.disabled).toBe(
        true,
      );
      pressButton(renderer, 'Skip — pick automatically');
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('seeds the tap: ring at the touch point, status flips, Analyze enables', () => {
      const { renderer } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 135, 240);

      const circles = ringCircles(renderer);
      expect(circles).toHaveLength(1);
      expect(circles[0]!.props.cx).toBe(135);
      expect(circles[0]!.props.cy).toBe(240);
      expect(allText(renderer)).toContain('Player selected');
      expect(allText(renderer)).not.toContain('Tap the player to analyze');
      expect(pressableFor(renderer, 'Analyze this player').props.disabled).toBe(
        false,
      );
      expect(
        pressableFor(renderer, 'Analyze this player').props.accessibilityState,
      ).toEqual({ disabled: false });
      act(() => renderer.unmount());
    });

    it('a second tap replaces the first (initialization seed, not a boundary)', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 20, 30);
      tapFrame(renderer, 200, 400);
      const circles = ringCircles(renderer);
      expect(circles).toHaveLength(1);
      expect(circles[0]!.props.cx).toBe(200);
      expect(circles[0]!.props.cy).toBe(400);

      pressButton(renderer, 'Analyze this player');
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm.mock.calls[0]![0].point).toEqual(
        viewPointToSourcePoint({ x: 200, y: 400 }, VIEW, SOURCE),
      );
      act(() => renderer.unmount());
    });

    it('clamps out-of-frame touches to the frame edge', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      tapFrame(renderer, -40, 9999);
      const circles = ringCircles(renderer);
      expect(circles[0]!.props.cx).toBe(0);
      expect(circles[0]!.props.cy).toBe(VIEW.height);

      pressButton(renderer, 'Analyze this player');
      const { point } = onConfirm.mock.calls[0]![0];
      expectNormalized(point);
      expect(point).toEqual(
        viewPointToSourcePoint({ x: 0, y: VIEW.height }, VIEW, SOURCE),
      );
      act(() => renderer.unmount());
    });
  });

  describe('"Analyze this player" → onConfirm', () => {
    it('is a guarded no-op while disabled (no tap yet)', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      // Drive the design Button's own handler directly, bypassing the
      // Pressable `disabled` gate, to prove the inner guard also holds.
      act(() => {
        designButton(renderer, 'Analyze this player').props.onPress();
      });
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('confirms the SOURCE-normalized point (cover-crop inverted) with a timestamp', () => {
      const { renderer, onConfirm, onSkip } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 135, 240);
      pressButton(renderer, 'Analyze this player');

      expect(onConfirm).toHaveBeenCalledTimes(1);
      const selection = onConfirm.mock.calls[0]![0];
      // 1920x1080 in a 270x480 view: scale = 480/1080, ~292px cropped each side.
      const expected = viewPointToSourcePoint({ x: 135, y: 240 }, VIEW, SOURCE);
      expect(selection.point).toEqual(expected);
      expect(selection.point.x).toBeCloseTo(0.5, 9);
      expect(selection.point.y).toBeCloseTo(0.5, 9);
      expectNormalized(selection.point);
      expect(selection.selectedAtIso).toBe(NOW_ISO);
      expect(onSkip).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('an off-center tap lands off-center in source space (not view-normalized)', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 0, 0);
      pressButton(renderer, 'Analyze this player');
      const { point } = onConfirm.mock.calls[0]![0];
      // Left edge of the view is ~292 scaled px into the 853px-wide scaled
      // source, i.e. x ≈ 0.342 — NOT 0 as a naive view-normalization gives.
      expect(point.x).toBeCloseTo((1920 * (480 / 1080) - 270) / 2 / 853.333, 2);
      expect(point.y).toBe(0);
      act(() => renderer.unmount());
    });

    it('falls back to view-normalization when source dimensions are absent', () => {
      const { renderer, onConfirm } = render({
        sourceWidth: undefined,
        sourceHeight: undefined,
      });
      layoutFrame(renderer);
      tapFrame(renderer, 67.5, 120);
      pressButton(renderer, 'Analyze this player');
      expect(onConfirm.mock.calls[0]![0].point).toEqual({ x: 0.25, y: 0.25 });
      act(() => renderer.unmount());
    });

    it.each([
      ['zero', 0, 0],
      ['negative', -1920, 1080],
      ['NaN', Number.NaN, 1080],
      ['Infinity', 1920, Number.POSITIVE_INFINITY],
    ])(
      'does not throw and never emits NaN when source dimensions are %s',
      (_label, width, height) => {
        const { renderer, onConfirm } = render({
          sourceWidth: width,
          sourceHeight: height,
        });
        layoutFrame(renderer);
        expect(() => tapFrame(renderer, 135, 240)).not.toThrow();
        pressButton(renderer, 'Analyze this player');
        expect(onConfirm).toHaveBeenCalledTimes(1);
        const { point } = onConfirm.mock.calls[0]![0];
        expectNormalized(point);
        expect(point).toEqual({ x: 0.5, y: 0.5 });
        act(() => renderer.unmount());
      },
    );

    it('only one source dimension present → treated as absent (view-normalized)', () => {
      const { renderer, onConfirm } = render({ sourceHeight: undefined });
      layoutFrame(renderer);
      tapFrame(renderer, 270, 480);
      pressButton(renderer, 'Analyze this player');
      expect(onConfirm.mock.calls[0]![0].point).toEqual({ x: 1, y: 1 });
      act(() => renderer.unmount());
    });

    it('each press confirms exactly once with the current seed (parent unmounts on confirm)', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 135, 240);
      pressButton(renderer, 'Analyze this player');
      pressButton(renderer, 'Analyze this player');
      // The component has no in-flight state of its own: AnalyzeScreen sets
      // the seed on the first call (which unmounts this selector) and
      // `scoreCapture` ignores re-entry, so a second call here is inert
      // upstream. Pin that the second call carries the identical seed.
      expect(onConfirm).toHaveBeenCalledTimes(2);
      expect(onConfirm.mock.calls[1]![0].point).toEqual(
        onConfirm.mock.calls[0]![0].point,
      );
      act(() => renderer.unmount());
    });
  });

  describe('"Skip — pick automatically" → onSkip', () => {
    it('calls onSkip with no arguments and never confirms', () => {
      const { renderer, onConfirm, onSkip } = render();
      pressButton(renderer, 'Skip — pick automatically');
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledWith();
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('stays available after a tap (the user may still defer to auto-pick)', () => {
      const { renderer, onConfirm, onSkip } = render();
      layoutFrame(renderer);
      tapFrame(renderer, 135, 240);
      expect(
        pressableFor(renderer, 'Skip — pick automatically').props.disabled,
      ).toBeFalsy();
      pressButton(renderer, 'Skip — pick automatically');
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('is a ghost variant (secondary to Analyze) and passes the parent handler through', () => {
      const { renderer, onSkip } = render();
      const button = designButton(renderer, 'Skip — pick automatically');
      expect(button.props.variant).toBe('ghost');
      expect(button.props.onPress).toBe(onSkip);
      act(() => renderer.unmount());
    });
  });

  describe('Image.onError → honest preview fallback', () => {
    it('swaps the frame for actionable copy and keeps the tap target live', () => {
      const { renderer, onConfirm } = render();
      layoutFrame(renderer);
      act(() => {
        renderer.root.findByType(Image).props.onError({
          nativeEvent: { error: 'decode failed' },
        });
      });
      expect(renderer.root.findAllByType(Image)).toHaveLength(0);
      expect(allText(renderer)).toContain(
        'Preview unavailable — tap where you are in the video',
      );
      // The tap surface and both buttons survive the fallback.
      expect(frameTouchable(renderer).props.accessibilityLabel).toBe(
        'Tap yourself in the frame',
      );
      tapFrame(renderer, 135, 240);
      expect(ringCircles(renderer)).toHaveLength(1);
      expect(allText(renderer)).toContain('Player selected');
      pressButton(renderer, 'Analyze this player');
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expectNormalized(onConfirm.mock.calls[0]![0].point);
      act(() => renderer.unmount());
    });
  });

  it('relayout after a tap keeps the existing seed and ring', () => {
    const { renderer } = render();
    layoutFrame(renderer);
    tapFrame(renderer, 135, 240);
    layoutFrame(renderer, { width: 360, height: 380 });
    const circles = ringCircles(renderer);
    expect(circles).toHaveLength(1);
    expect(circles[0]!.props.cx).toBe(135);
    expect(allText(renderer)).toContain('Player selected');
    act(() => renderer.unmount());
  });
});
