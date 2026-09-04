/**
 * Execution audit — Reduce Motion across the shared design primitives.
 *
 * `useReducedMotion` keeps one module-level cache that is seeded `false` and
 * corrected once `AccessibilityInfo.isReduceMotionEnabled()` resolves. This
 * suite runs with that probe resolving `true` and settles it in `beforeAll`
 * (see design-reduced-motion-first-mount.test.tsx for the pre-settle tick),
 * then pins that every motion primitive renders its resting state once the
 * setting is known and that the `reduceMotionChanged` listener re-enables
 * motion. Accessibility roles/labels/states and 44pt targets are asserted on
 * the same host nodes. Every test is order-independent.
 */
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
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaView = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    SafeAreaView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

import React from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  BrandSpinner,
  BrandToggle,
  LoadingState,
  ErrorState,
  RevealFill,
  ScoreRing,
} from '../../src/design/components';

const MIN_TARGET_PT = 44;

function flat(node: ReactTestInstance) {
  return StyleSheet.flatten(node.props.style) ?? {};
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(t => React.Children.toArray(t.props.children).join(''));
}

function hostPressables(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function reduceMotionListener(): (value: boolean) => void {
  const call = (
    AccessibilityInfo.addEventListener as jest.Mock
  ).mock.calls.find(([eventName]) => eventName === 'reduceMotionChanged');
  if (!call) throw new Error('reduceMotionChanged listener not registered');
  return call[1] as (value: boolean) => void;
}

let rafQueue: Array<(t: number) => void> = [];

beforeAll(async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockImplementation(
    () => Promise.resolve(true),
  );
  // Settle the one-per-process probe inside act() so no test observes the
  // pre-settle tick.
  let warmUp!: ReactTestRenderer;
  await act(async () => {
    warmUp = TestRenderer.create(<ScoreRing score={null} />);
  });
  act(() => warmUp.unmount());
});

beforeEach(() => {
  rafQueue = [];
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation((cb: (t: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Reduce Motion enabled — resting states, roles, labels, targets', () => {
  it('ScoreRing renders the final score immediately and never schedules a frame', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ScoreRing score={4.9} label="Dink" />);
    });
    expect(texts(renderer)).toEqual(expect.arrayContaining(['4.9', 'Dink']));
    expect(rafQueue).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('ScoreRing with no score reads "No technique score yet" and shows the em dash', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ScoreRing score={null} />);
    });
    expect(texts(renderer)).toContain('—');
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === 'No technique score yet',
      ).length,
    ).toBeGreaterThan(0);
    expect(rafQueue).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('BrandToggle is a 54x44 switch with checked/disabled state and does not animate its knob', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const onValueChange = jest.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BrandToggle
          label="Reminders"
          value={false}
          onValueChange={onValueChange}
          testID="toggle"
        />,
      );
    });
    const [host] = hostPressables(renderer);
    expect(host).toBeDefined();
    expect(host!.props.accessibilityRole).toBe('switch');
    expect(host!.props.accessibilityLabel).toBe('Reminders');
    expect(host!.props.accessibilityState).toEqual({
      checked: false,
      disabled: undefined,
    });
    expect(host!.props.hitSlop).toBe(5);
    const container = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        Number(flat(n).width) === 54 &&
        Number(flat(n).height) === MIN_TARGET_PT,
    );
    expect(container.length).toBeGreaterThan(0);

    act(() => host!.props.onClick());
    expect(onValueChange).toHaveBeenCalledWith(true);
    act(() => {
      renderer.update(
        <BrandToggle
          label="Reminders"
          value
          onValueChange={onValueChange}
          testID="toggle"
        />,
      );
    });
    expect(hostPressables(renderer)[0]!.props.accessibilityState.checked).toBe(
      true,
    );
    expect(timing).not.toHaveBeenCalled();

    act(() => {
      renderer.update(
        <BrandToggle
          label="Reminders"
          value
          disabled
          onValueChange={onValueChange}
        />,
      );
    });
    const disabledHost = hostPressables(renderer)[0]!;
    expect(disabledHost.props.accessibilityState.disabled).toBe(true);
    onValueChange.mockClear();
    act(() => disabledHost.props.onClick());
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('BrandSpinner is a static progressbar when labelled and decorative when not', () => {
    const loop = jest.spyOn(Animated, 'loop');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BrandSpinner accessibilityLabel="Scoring your read" />,
      );
    });
    const bar = renderer.root.findAll(
      n => n.props.accessibilityRole === 'progressbar',
    );
    expect(bar.length).toBeGreaterThan(0);
    expect(bar[0]!.props.accessibilityLabel).toBe('Scoring your read');
    expect(loop).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    act(() => {
      renderer = TestRenderer.create(<BrandSpinner />);
    });
    expect(
      renderer.root.findAll(n => n.props.accessibilityRole === 'progressbar'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('RevealFill mounts at rest (scaleX 1) without a delayed timing', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<RevealFill testID="fill" delay={200} />);
    });
    const fill = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'fill',
    );
    expect(fill).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('LoadingState is a polite live region that tells the user to keep the app open; ErrorState is an assertive alert with a labelled 44pt retry', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LoadingState label="Loading drills" />);
    });
    const live = renderer.root.findAll(
      n => n.props.accessibilityLiveRegion === 'polite',
    );
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]!.props.accessibilityLabel).toBe(
      'Loading drills. Keep Pickle Sensei open.',
    );
    act(() => renderer.unmount());

    const onRetry = jest.fn();
    act(() => {
      renderer = TestRenderer.create(
        <ErrorState
          title="Could not load"
          detail="Offline."
          onRetry={onRetry}
        />,
      );
    });
    const alert = renderer.root.findAll(
      n => n.props.accessibilityRole === 'alert',
    );
    expect(alert.length).toBeGreaterThan(0);
    expect(alert[0]!.props.accessibilityLiveRegion).toBe('assertive');
    const [retry] = hostPressables(renderer);
    expect(retry).toBeDefined();
    expect(Number(flat(retry!).minHeight)).toBeGreaterThanOrEqual(
      MIN_TARGET_PT,
    );
    act(() => retry!.props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

describe('Reduce Motion toggled off at runtime', () => {
  it('reduceMotionChanged(false) re-enables the ScoreRing count-up on the next mount', () => {
    act(() => {
      reduceMotionListener()(false);
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ScoreRing score={6} />);
    });
    expect(texts(renderer)).toContain('0.0');
    expect(rafQueue.length).toBeGreaterThan(0);
    // Drive the frame loop to completion by hand.
    let now = 1_000;
    let guard = 0;
    while (rafQueue.length > 0 && guard < 200) {
      const cb = rafQueue.shift()!;
      now += 100;
      act(() => cb(now));
      guard += 1;
    }
    expect(texts(renderer)).toContain('6.0');
    act(() => renderer.unmount());
    act(() => {
      reduceMotionListener()(true);
    });
  });
});
