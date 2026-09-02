import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, NativeModules } from 'react-native';

import { SplashScreen } from '../../src/screens/SplashScreen';

/**
 * Button ledger for `SplashScreen`.
 *
 * The splash is a pointer-transparent launch overlay: it declares NO
 * pressable, switch, input, link, or gesture handler of its own. This suite
 * pins that fact (so a control can never be added here without a ledger
 * entry) and covers the only user-observable handoff the component owns —
 * `onFinished` firing exactly once after BOTH hydration (`ready`) and the
 * minimum-visible hold have elapsed — including the reduced-motion path.
 */

const MIN_VISIBLE_MS = 1150;
const EXIT_MS = 380;
/**
 * The RN jest preset's NativeAnimatedModule ends EVERY native-driver
 * animation 16ms after it starts regardless of duration, so wall-clock length
 * is not observable here; the requested duration is, via the frame table the
 * timing config hands to `startAnimatingNode`.
 */
const NATIVE_ANIMATION_END_MS = 16;

const startAnimatingNode = NativeModules.NativeAnimatedModule
  .startAnimatingNode as jest.Mock;

function lastStartedAnimationFrames(): number[] {
  const call = startAnimatingNode.mock.calls.at(-1);
  if (!call) throw new Error('no native animation was started');
  const config = call[2] as { type: string; frames?: number[] };
  expect(config.type).toBe('frames');
  return config.frames ?? [];
}

type Renderer = TestRenderer.ReactTestRenderer;

function hostNodes(renderer: Renderer) {
  return renderer.root.findAll(node => typeof node.type === 'string');
}

function hostRoot(renderer: Renderer) {
  const root = hostNodes(renderer)[0];
  if (!root) throw new Error('SplashScreen rendered no host view');
  return root;
}

function hostImages(renderer: Renderer) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && String(node.type) === 'Image',
  );
}

function interactiveNodes(renderer: Renderer) {
  return hostNodes(renderer).filter(node => {
    const props = node.props as Record<string, unknown>;
    return (
      typeof props.onPress === 'function' ||
      typeof props.onLongPress === 'function' ||
      typeof props.onValueChange === 'function' ||
      typeof props.onSubmitEditing === 'function' ||
      typeof props.onStartShouldSetResponder === 'function' ||
      typeof props.onResponderRelease === 'function' ||
      typeof props.onClick === 'function'
    );
  });
}

async function render(ready: boolean, onFinished: () => void) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SplashScreen ready={ready} onFinished={onFinished} />,
    );
  });
  return renderer;
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * `useReducedMotion` keeps ONE module-level observer that subscribes to
 * `AccessibilityInfo` on first use; the jest preset mocks `addEventListener`
 * as a jest.fn, so the registered `reduceMotionChanged` handler is the way
 * to flip the setting mid-suite (the initial `isReduceMotionEnabled` read is
 * consulted only once per module).
 */
function reduceMotionHandler(): (value: boolean) => void {
  const call = (
    AccessibilityInfo.addEventListener as jest.Mock
  ).mock.calls.find(([eventName]) => eventName === 'reduceMotionChanged');
  if (!call) throw new Error('reduceMotionChanged listener not registered');
  return call[1] as (value: boolean) => void;
}

async function setReducedMotion(value: boolean) {
  await act(async () => {
    reduceMotionHandler()(value);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  startAnimatingNode.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SplashScreen button ledger', () => {
  it('declares zero interactive elements and intercepts touches while mounted', async () => {
    const renderer = await render(false, jest.fn());

    expect(interactiveNodes(renderer)).toHaveLength(0);

    // The opaque overlay swallows touches so taps during the minimum hold and
    // exit fade never activate invisible controls on the first screen beneath.
    const root = hostRoot(renderer);
    expect(root.props.pointerEvents).toBe('box-only');
    expect(root.props.accessible).toBe(true);
    expect(root.props.accessibilityLabel).toBe('Pickle Sensei is starting');

    // No control, so no role is owed — but nothing may CLAIM one either.
    for (const node of hostNodes(renderer)) {
      expect(node.props.accessibilityRole).toBeUndefined();
    }

    await act(async () => {
      renderer.unmount();
    });
  });

  it('renders the storyboard-identical glow + lockup layers', async () => {
    const renderer = await render(false, jest.fn());
    const images = hostImages(renderer);
    expect(images).toHaveLength(2);
    // Every layer is decorative — none can be reached or acted on.
    for (const image of images) {
      expect(image.props.onPress).toBeUndefined();
    }
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('SplashScreen handoff (onFinished)', () => {
  it('does not finish while hydration is still pending, however long', async () => {
    const onFinished = jest.fn();
    const renderer = await render(false, onFinished);

    await advance(MIN_VISIBLE_MS + EXIT_MS + 10_000);
    expect(onFinished).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('holds the mark for the minimum time even when hydration is instant', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);

    await advance(MIN_VISIBLE_MS - 1);
    expect(onFinished).not.toHaveBeenCalled();

    // Min hold elapses → exit fade starts; onFinished only after the fade.
    await advance(1);
    expect(onFinished).not.toHaveBeenCalled();
    // A real fade: a multi-frame table spanning EXIT_MS at 60Hz.
    const frames = lastStartedAnimationFrames();
    expect(frames.length).toBe(Math.round(EXIT_MS / (1000 / 60)) + 1);
    expect(frames.at(-1)).toBe(1);

    await advance(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('finishes once when ready flips after the minimum hold', async () => {
    const onFinished = jest.fn();
    const renderer = await render(false, onFinished);

    await advance(MIN_VISIBLE_MS + 2_000);
    expect(onFinished).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    expect(onFinished).not.toHaveBeenCalled();

    await advance(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Re-renders with a new callback identity must not re-run the exit.
    const replacement = jest.fn();
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={replacement} />);
    });
    await advance(MIN_VISIBLE_MS + EXIT_MS + 1_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('with reduced motion, skips the fade and finishes right after the hold', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);
    await setReducedMotion(true);

    try {
      await advance(MIN_VISIBLE_MS - 1);
      expect(onFinished).not.toHaveBeenCalled();

      // Zero-duration exit: a single-frame jump to the end value, no fade.
      await advance(1);
      expect(lastStartedAnimationFrames()).toEqual([1]);
      await advance(NATIVE_ANIMATION_END_MS);
      expect(onFinished).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    } finally {
      await setReducedMotion(false);
    }
  });

  it('unmounting before the hold elapses never calls onFinished', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);

    await act(async () => {
      renderer.unmount();
    });
    await advance(MIN_VISIBLE_MS + EXIT_MS + 1_000);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
