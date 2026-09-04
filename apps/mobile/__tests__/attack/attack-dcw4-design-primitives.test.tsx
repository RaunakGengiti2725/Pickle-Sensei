/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenarios 2–4.
 *
 * S2  ScoreRing with out-of-range scores (-3, 17): a11y label text and the
 *     sweep fraction fed to the arc must stay inside [0, 1].
 * S3  TrendChart with non-finite points: no `NaN` / `Infinity` may reach the
 *     SVG `points` attribute and render must not throw.
 * S4  Two PressableScale + the module-level reduceMotion listener Set: unmount
 *     one, flip the OS listener again, survivor updates, no
 *     setState-after-unmount warning (Set cleanup).
 *
 * Reanimated is replaced by a minimal manual mock (the official mock pulls in
 * react-native-worklets' native initializers, which cannot load under jest —
 * same approach as premiumTabBar.test.tsx). The mock spreads `animatedProps`
 * onto the host so the ring's `strokeDashoffset` is inspectable, and records
 * every `withTiming` target so the animated sweep fraction is observable too.
 */
const withTimingCalls: number[] = [];

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
        (props: Record<string, unknown>) => {
          const { animatedProps, ...rest } = props as {
            animatedProps?: Record<string, unknown>;
          } & Record<string, unknown>;
          return React.createElement(Component, { ...rest, ...animatedProps });
        },
    },
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => React.useRef({ value: init }).current,
    withTiming: (toValue: number) => {
      withTimingCalls.push(toValue);
      return toValue;
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import React from 'react';
import { AccessibilityInfo, Animated, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Circle, Polyline } from 'react-native-svg';
import {
  PressableScale,
  ScoreRing,
  TrendChart,
} from '../../src/design/components';

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter(
      (child): child is string | number =>
        typeof child === 'string' || typeof child === 'number',
    )
    .map(String);
}

type Listener = (value: boolean) => void;

/** The `reduceMotionChanged` subscriber the design module registered. */
function capturedReduceMotionListener(): Listener {
  const mocked = AccessibilityInfo.addEventListener as unknown as jest.Mock;
  const call = mocked.mock.calls.find(
    ([event]) => event === 'reduceMotionChanged',
  );
  if (!call) throw new Error('reduceMotionChanged listener never registered');
  return call[1] as Listener;
}

const consoleError = jest.spyOn(console, 'error');

beforeEach(() => {
  consoleError.mockClear();
  withTimingCalls.length = 0;
});

afterAll(() => {
  consoleError.mockRestore();
});

describe('ATTACK S4 — PressableScale reduceMotion listener Set cleanup', () => {
  it('two mounted → flip true → unmount one → flip false: survivor updates, no orphan setState', () => {
    const a = render(
      <PressableScale accessibilityLabel="A" onPress={() => undefined}>
        <Text>A</Text>
      </PressableScale>,
    );
    const b = render(
      <PressableScale accessibilityLabel="B" onPress={() => undefined}>
        <Text>B</Text>
      </PressableScale>,
    );
    const listener = capturedReduceMotionListener();

    const timing = jest.spyOn(Animated, 'timing');
    // The composite Pressable's onPressIn is PressableScale's own
    // `() => animate(0.975, 110)`, which short-circuits when `reduced` is true.
    const pressIn = (r: TestRenderer.ReactTestRenderer) =>
      act(() => {
        const composite = r.root.findAll(
          n =>
            typeof n.type !== 'string' &&
            typeof n.props.onPressIn === 'function' &&
            n.props.accessibilityRole === 'button',
        )[0];
        if (!composite) throw new Error('Pressable composite not found');
        composite.props.onPressIn();
      });

    // Precondition: motion allowed → press-in animates.
    pressIn(a);
    expect(timing).toHaveBeenCalledTimes(1);

    act(() => listener(true));
    expect(consoleError).not.toHaveBeenCalled();

    // Unmount A while the OS setting is true.
    act(() => a.unmount());

    // Flip twice more — a leaked setter for A would warn here.
    act(() => listener(false));
    act(() => listener(true));
    const unmountWarnings = consoleError.mock.calls.filter(args =>
      String(args[0]).includes('unmounted'),
    );
    expect(unmountWarnings).toEqual([]);

    // Survivor B honours the CURRENT value (true → press-in must not animate).
    timing.mockClear();
    pressIn(b);
    expect(timing).not.toHaveBeenCalled();

    // …and flips back with the setting (false → animates again).
    act(() => listener(false));
    pressIn(b);
    expect(timing).toHaveBeenCalledTimes(1);

    act(() => b.unmount());
    // Flipping with nothing mounted must be a no-op (Set empty).
    expect(() => act(() => listener(true))).not.toThrow();
    expect(() => act(() => listener(false))).not.toThrow();
    expect(consoleError).not.toHaveBeenCalled();
    timing.mockRestore();
  });

  it('extra: 200 mount/unmount cycles under a flapping listener leak nothing (seed 4242)', () => {
    let seed = 4242;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const listener = capturedReduceMotionListener();
    const live: TestRenderer.ReactTestRenderer[] = [];
    for (let i = 0; i < 200; i++) {
      const roll = rand();
      if (roll < 0.45 || live.length === 0) {
        live.push(
          render(
            <PressableScale accessibilityLabel={`P${i}`}>
              <Text>{`P${i}`}</Text>
            </PressableScale>,
          ),
        );
      } else if (roll < 0.8) {
        const idx = Math.floor(rand() * live.length);
        const [gone] = live.splice(idx, 1);
        act(() => gone!.unmount());
      } else {
        act(() => listener(rand() < 0.5));
      }
    }
    for (const r of live) act(() => r.unmount());
    act(() => listener(true));
    act(() => listener(false));
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('ATTACK S2 — ScoreRing out-of-range scores', () => {
  function ringOf(renderer: TestRenderer.ReactTestRenderer) {
    const circles = renderer.root.findAllByType(Circle);
    // The sweep arc is the circle that carries strokeDasharray.
    const arc = circles.find(c => c.props.strokeDasharray !== undefined);
    if (!arc) throw new Error('sweep arc not rendered');
    return arc;
  }

  function circumferenceFor(size: number) {
    const stroke = Math.max(8, size * 0.065);
    const r = (size - stroke) / 2;
    return 2 * Math.PI * r;
  }

  function labelOf(renderer: TestRenderer.ReactTestRenderer): string {
    const host = renderer.root.find(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Technique score'),
    );
    return host.props.accessibilityLabel;
  }

  beforeEach(() => {
    // Reduced motion ON so the ring renders its resting state synchronously
    // (sweep initialised to `fraction`, no rAF count-up).
    act(() => capturedReduceMotionListener()(true));
  });

  afterEach(() => {
    act(() => capturedReduceMotionListener()(false));
  });

  it('score=17: label reads the raw value, sweep fraction clamps to 1', () => {
    const renderer = render(<ScoreRing score={17} size={154} />);
    expect(labelOf(renderer)).toBe('Technique score 17.0 out of 10');
    const c = circumferenceFor(154);
    const offset = ringOf(renderer).props.strokeDashoffset as number;
    const fraction = 1 - offset / c;
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1 + 1e-9);
    expect(fraction).toBeCloseTo(1, 9);
    expect(texts(renderer)).toContain('17.0');
    act(() => renderer.unmount());
  });

  it('score=-3: label reads the raw value; sweep fraction must clamp to 0 (resting state)', () => {
    const renderer = render(<ScoreRing score={-3} size={154} />);
    expect(labelOf(renderer)).toBe('Technique score -3.0 out of 10');
    const c = circumferenceFor(154);
    const offset = ringOf(renderer).props.strokeDashoffset as number;
    const fraction = 1 - offset / c;
    act(() => renderer.unmount());
    // BREAK PROBE: components.tsx computes Math.min(score / 10, 1) with no
    // lower bound, so -3 yields fraction -0.3 (dashoffset = 1.3 × circumference).
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  it('score=-3 with motion allowed: the withTiming sweep target must be within [0,1]', () => {
    act(() => capturedReduceMotionListener()(false));
    withTimingCalls.length = 0;
    const renderer = render(<ScoreRing score={-3} size={154} />);
    act(() => renderer.unmount());
    expect(withTimingCalls.length).toBeGreaterThanOrEqual(1);
    for (const target of withTimingCalls) {
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThanOrEqual(1);
    }
  });

  it('extra: NaN / Infinity / -Infinity scores do not throw; label + sweep are finite', () => {
    for (const score of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      expect(() => {
        renderer = render(<ScoreRing score={score} size={120} />);
      }).not.toThrow();
      const offset = ringOf(renderer).props.strokeDashoffset as number;
      const label = labelOf(renderer);
      act(() => renderer.unmount());
      expect(Number.isFinite(offset)).toBe(true);
      expect(label).not.toMatch(/NaN|Infinity/);
    }
  });

  it('extra: null score renders the em dash and the "No technique score yet" label', () => {
    const renderer = render(<ScoreRing score={null} />);
    const host = renderer.root.find(
      n =>
        typeof n.type === 'string' &&
        n.props.accessibilityLabel === 'No technique score yet',
    );
    expect(host).toBeTruthy();
    expect(texts(renderer)).toContain('—');
    const c = circumferenceFor(154);
    expect(ringOf(renderer).props.strokeDashoffset).toBeCloseTo(c, 6);
    act(() => renderer.unmount());
  });
});

describe('ATTACK S3 — TrendChart non-finite points', () => {
  function polylinePoints(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType(Polyline)
      .map(node => String(node.props.points));
  }

  it('points=[NaN, 5, Infinity, -2] renders without throwing', () => {
    expect(() => {
      const r = render(
        <TrendChart points={[Number.NaN, 5, Number.POSITIVE_INFINITY, -2]} />,
      );
      act(() => r.unmount());
    }).not.toThrow();
  });

  it('points=[NaN, 5, Infinity, -2]: no NaN/Infinity substrings in any SVG points attribute', () => {
    const renderer = render(
      <TrendChart
        points={[Number.NaN, 5, Number.POSITIVE_INFINITY, -2]}
        width={300}
        height={90}
      />,
    );
    const attrs = polylinePoints(renderer);
    act(() => renderer.unmount());
    expect(attrs.length).toBe(2);
    for (const attr of attrs) {
      expect(attr).not.toMatch(/NaN/);
      expect(attr).not.toMatch(/Infinity/);
    }
  });

  it('extra: every emitted coordinate stays inside the viewBox (negative scores are clamped)', () => {
    const width = 300;
    const height = 90;
    const renderer = render(
      <TrendChart points={[0, 5, -2, 10, 12]} width={width} height={height} />,
    );
    const attrs = polylinePoints(renderer);
    act(() => renderer.unmount());
    const coords = attrs
      .flatMap(a => a.split(' '))
      .map(pair => pair.split(',').map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(width + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(height + 1e-9);
    }
  });

  it('extra: max=0 / NaN max does not divide into NaN', () => {
    for (const max of [0, Number.NaN]) {
      const renderer = render(<TrendChart points={[1, 2, 3]} max={max} />);
      const attrs = polylinePoints(renderer);
      act(() => renderer.unmount());
      for (const attr of attrs) expect(attr).not.toMatch(/NaN|Infinity/);
    }
  });

  it('extra: huge series (10k points) renders finite geometry without throwing', () => {
    const pts = Array.from({ length: 10_000 }, (_, i) => (i * 7919) % 11);
    let renderer!: TestRenderer.ReactTestRenderer;
    expect(() => {
      renderer = render(<TrendChart points={pts} />);
    }).not.toThrow();
    const attrs = polylinePoints(renderer);
    act(() => renderer.unmount());
    expect(attrs.length).toBe(2);
    for (const attr of attrs) expect(attr).not.toMatch(/NaN|Infinity/);
  });

  it('extra: fewer than two points renders the copy fallback, never an empty SVG', () => {
    for (const pts of [[], [7], [Number.NaN]]) {
      const renderer = render(<TrendChart points={pts} />);
      expect(polylinePoints(renderer)).toEqual([]);
      expect(texts(renderer)).toContain(
        'Your trend appears after two scored reps.',
      );
      act(() => renderer.unmount());
    }
  });
});
