/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S7.
 *
 * `useReducedMotion` (src/design/components.tsx:41-68) seeds every consumer
 * with a module-level `reducedMotionValue` that starts FALSE and is only
 * corrected when `AccessibilityInfo.isReduceMotionEnabled()` resolves. The
 * ScoreRing (:590-712) decides `animate = !reduced && score !== null` from
 * that initial value, so a ring mounted BEFORE the promise resolves may start
 * its 900 ms arc sweep and rAF count-up for a reduce-motion user.
 *
 * The reanimated mock below is inline (it wins over __mocks__): `withTiming`
 * returns a tagged sentinel instead of the target value so "sweep started
 * animating" is observable as `sweep.value` holding the sentinel, while a
 * snap writes a plain number. `useSharedValue` records every shared value so
 * the ring's `sweep` can be inspected without touching production code.
 *
 * The observer is module-level state, so every case reloads the module
 * registry (`jest.resetModules` + fresh React / renderer / RN / components —
 * all four from the SAME registry, or hooks see two React copies).
 *
 * Cases: mount-before-resolve (the assigned attack), mount-after-resolve,
 * control (resolves false), live `reduceMotionChanged` mid-sweep, 40 rings
 * mounted in the window, and a null-score ring. The promise-REJECTION probe
 * lives in apps/mobile/attack-harness/dcw2-reducedMotion-rejection.probe.tsx
 * because it takes the jest worker down (see that file).
 */

const mockLedger: {
  withTiming: Array<{ toValue: unknown; duration: unknown }>;
  shared: Array<{ value: unknown }>;
} = { withTiming: [], shared: [] };

jest.mock('react-native-reanimated', () => {
  const ReactModule = require('react');
  const RN = require('react-native');
  const passthrough = (value: unknown) => value;
  const Easing = {
    linear: passthrough,
    ease: passthrough,
    cubic: passthrough,
    quad: passthrough,
    exp: passthrough,
    bezier: () => passthrough,
    in: (fn: unknown) => fn,
    out: (fn: unknown) => fn,
    inOut: (fn: unknown) => fn,
  };
  const createAnimatedComponent =
    (Component: React.ComponentType<Record<string, unknown>>) =>
    (props: Record<string, unknown> & { animatedProps?: object }) => {
      const { animatedProps, ...rest } = props;
      return ReactModule.createElement(Component, {
        ...rest,
        ...(animatedProps ?? {}),
      });
    };
  return {
    __esModule: true,
    default: {
      View: createAnimatedComponent(RN.View),
      Text: createAnimatedComponent(RN.Text),
      ScrollView: createAnimatedComponent(RN.ScrollView),
      Image: createAnimatedComponent(RN.Image),
      createAnimatedComponent,
    },
    Easing,
    interpolate: () => 0,
    cancelAnimation: () => {},
    // Stable across re-renders (like the real hook) — the repo's __mocks__
    // version allocates per render, which would hide a snap written on a
    // later render behind a stale first-render holder.
    useSharedValue: (initial: unknown) => {
      const ref = ReactModule.useRef(null) as {
        current: { value: unknown } | null;
      };
      if (ref.current === null) {
        ref.current = { value: initial };
        mockLedger.shared.push(ref.current);
      }
      return ref.current;
    },
    useDerivedValue: (updater: () => unknown) => ({ value: updater() }),
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    withTiming: (toValue: unknown, config?: { duration?: unknown }) => {
      const sentinel = { __timing: toValue, duration: config?.duration };
      mockLedger.withTiming.push({ toValue, duration: config?.duration });
      return sentinel;
    },
    withSpring: passthrough,
    withDelay: (_delay: number, animation: unknown) => animation,
    withRepeat: passthrough,
    withSequence: (...animations: unknown[]) => animations.at(-1),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

type ReactModule = typeof import('react');
type RNModule = typeof import('react-native');
type RendererModule = typeof import('react-test-renderer');
type ComponentsModule = typeof import('../../src/design/components');
type Renderer = import('react-test-renderer').ReactTestRenderer;

interface Deferred {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
}

function deferred(): Deferred {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

interface World {
  React: ReactModule;
  RN: RNModule;
  TR: RendererModule;
  act: RendererModule['act'];
  components: ComponentsModule;
  isReduceMotionEnabled: jest.Mock;
  addEventListener: jest.Mock;
  ring: (score: number | null) => Renderer;
  scoreText: (renderer: Renderer) => string;
}

/** Fresh module registry → fresh module-level reduced-motion observer. */
function load(reduceMotion: Promise<boolean>): World {
  jest.resetModules();
  mockLedger.withTiming.length = 0;
  mockLedger.shared.length = 0;
  const React = require('react') as ReactModule;
  const RN = require('react-native') as RNModule;
  const TR = require('react-test-renderer') as RendererModule;
  const isReduceMotionEnabled = RN.AccessibilityInfo
    .isReduceMotionEnabled as unknown as jest.Mock;
  isReduceMotionEnabled.mockReset();
  isReduceMotionEnabled.mockReturnValue(reduceMotion);
  const addEventListener = RN.AccessibilityInfo
    .addEventListener as unknown as jest.Mock;
  addEventListener.mockClear();
  const components = require('../../src/design/components') as ComponentsModule;
  const ring = (score: number | null): Renderer => {
    let renderer!: Renderer;
    TR.act(() => {
      renderer = TR.create(
        React.createElement(components.ScoreRing, { score }),
      );
    });
    return renderer;
  };
  const scoreText = (renderer: Renderer) =>
    renderer.root
      .findAllByType(RN.Text)
      .map(n => String(n.props.children))
      .join('|');
  return {
    React,
    RN,
    TR,
    act: TR.act,
    components,
    isReduceMotionEnabled,
    addEventListener,
    ring,
    scoreText,
  };
}

function isTimingSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '__timing' in value;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ATTACK S7 — ScoreRing mounted before isReduceMotionEnabled resolves true', () => {
  it('the ring must not start the sweep in the initial-false window, then snaps when the promise lands', async () => {
    const gate = deferred();
    const w = load(gate.promise);
    const renderer = w.ring(7.2);
    expect(w.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
    const sweep = mockLedger.shared[0]!;

    const startedBeforeResolve = mockLedger.withTiming.length;
    const sweepStateBeforeResolve = isTimingSentinel(sweep.value)
      ? 'animating(withTiming sentinel)'
      : `snapped(${String(sweep.value)})`;
    const textBeforeResolve = w.scoreText(renderer);
    console.log(
      `[ATTACK S7] before resolve: withTiming calls=${startedBeforeResolve} sweep=${sweepStateBeforeResolve} text=${textBeforeResolve}`,
    );

    await w.act(async () => {
      gate.resolve(true);
      await gate.promise;
    });

    // After the flag lands the ring must be at rest: numeric sweep at the
    // final fraction, no further withTiming, number shows the final score.
    expect(isTimingSentinel(sweep.value)).toBe(false);
    expect(sweep.value).toBeCloseTo(0.72, 10);
    expect(mockLedger.withTiming.length).toBe(startedBeforeResolve);
    expect(w.scoreText(renderer)).toContain('7.2');

    // Count-up rAF must have been cancelled: advancing time changes nothing.
    w.act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(w.scoreText(renderer)).toContain('7.2');
    expect(sweep.value).toBeCloseTo(0.72, 10);

    // The assigned assertion: the sweep never started animating.
    expect(startedBeforeResolve).toBe(0);
    expect(sweepStateBeforeResolve).toBe('snapped(0.72)');
    w.act(() => renderer.unmount());
  });

  it('a ring mounted AFTER the promise resolved true never calls withTiming and renders the final state at once', async () => {
    const w = load(Promise.resolve(true));
    // Prime the observer through another consumer, exactly like Home does.
    function Primer() {
      w.components.useReducedMotion();
      return null;
    }
    let primer!: Renderer;
    await w.act(async () => {
      primer = w.TR.create(w.React.createElement(Primer));
    });
    mockLedger.withTiming.length = 0;
    mockLedger.shared.length = 0;

    const renderer = w.ring(4.4);
    expect(mockLedger.withTiming).toHaveLength(0);
    expect(mockLedger.shared[0]!.value).toBeCloseTo(0.44, 10);
    expect(w.scoreText(renderer)).toContain('4.4');
    w.act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(w.scoreText(renderer)).toContain('4.4');
    w.act(() => {
      renderer.unmount();
      primer.unmount();
    });
  });

  it('control: promise resolves false → sweep animates once (withTiming 900 ms) and the number counts up', async () => {
    const gate = deferred();
    const w = load(gate.promise);
    const renderer = w.ring(9.1);
    expect(mockLedger.withTiming).toHaveLength(1);
    expect(mockLedger.withTiming[0]!.duration).toBe(900);
    expect(mockLedger.withTiming[0]!.toValue as number).toBeCloseTo(0.91, 10);
    expect(isTimingSentinel(mockLedger.shared[0]!.value)).toBe(true);
    expect(w.scoreText(renderer)).toContain('0.0');
    await w.act(async () => {
      gate.resolve(false);
      await gate.promise;
    });
    expect(mockLedger.withTiming).toHaveLength(1);
    w.act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(w.scoreText(renderer)).toContain('9.1');
    w.act(() => renderer.unmount());
  });

  it('live reduceMotionChanged(true) mid-sweep snaps the ring; (false) afterwards does not replay', async () => {
    const w = load(Promise.resolve(false));
    let renderer!: Renderer;
    await w.act(async () => {
      renderer = w.TR.create(
        w.React.createElement(w.components.ScoreRing, { score: 6.0 }),
      );
    });
    const handler = w.addEventListener.mock.calls.find(
      ([name]) => name === 'reduceMotionChanged',
    )?.[1] as ((value: boolean) => void) | undefined;
    expect(handler).toBeDefined();
    expect(isTimingSentinel(mockLedger.shared[0]!.value)).toBe(true);

    await w.act(async () => {
      handler!(true);
    });
    expect(mockLedger.shared[0]!.value).toBeCloseTo(0.6, 10);
    expect(w.scoreText(renderer)).toContain('6.0');

    const callsBefore = mockLedger.withTiming.length;
    await w.act(async () => {
      handler!(false);
    });
    const extra = mockLedger.withTiming.length - callsBefore;
    console.log(
      `[ATTACK S7] reduceMotionChanged(false) after snap: extra withTiming=${extra} text=${w.scoreText(renderer)}`,
    );
    w.act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(w.scoreText(renderer)).toContain('6.0');
    w.act(() => renderer.unmount());
  });

  it('40 rings mounted inside the window all snap together and none keeps a sentinel', async () => {
    const gate = deferred();
    const w = load(gate.promise);
    const renderers: Renderer[] = [];
    w.act(() => {
      for (let i = 0; i < 40; i++) {
        renderers.push(
          w.TR.create(
            w.React.createElement(w.components.ScoreRing, {
              score: (i % 10) + 0.5,
            }),
          ),
        );
      }
    });
    expect(w.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
    const sentinelsBefore = mockLedger.shared.filter(s =>
      isTimingSentinel(s.value),
    ).length;
    console.log(
      `[ATTACK S7] 40 rings before resolve: ${sentinelsBefore} animating`,
    );
    await w.act(async () => {
      gate.resolve(true);
      await gate.promise;
    });
    expect(
      mockLedger.shared.filter(s => isTimingSentinel(s.value)),
    ).toHaveLength(0);
    mockLedger.shared.forEach((s, i) => {
      expect(s.value).toBeCloseTo(((i % 10) + 0.5) / 10, 10);
    });
    w.act(() => {
      for (const r of renderers) r.unmount();
    });
    expect(sentinelsBefore).toBe(0);
  });

  it('null score never animates regardless of the flag, and the label stays honest', async () => {
    const gate = deferred();
    const w = load(gate.promise);
    const renderer = w.ring(null);
    expect(mockLedger.withTiming).toHaveLength(0);
    expect(mockLedger.shared[0]!.value).toBe(0);
    expect(w.scoreText(renderer)).toContain('—');
    const labelled = renderer.root.findAll(
      n => n.props.accessibilityLabel === 'No technique score yet',
    );
    expect(labelled.length).toBeGreaterThan(0);
    await w.act(async () => {
      gate.resolve(true);
      await gate.promise;
    });
    expect(mockLedger.withTiming).toHaveLength(0);
    w.act(() => renderer.unmount());
  });
});
