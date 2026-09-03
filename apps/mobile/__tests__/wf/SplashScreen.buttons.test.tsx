import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, NativeModules } from 'react-native';

import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';

/**
 * Button ledger for `SplashScreen`.
 *
 * The splash is a full-screen MP4 intro overlay with exactly ONE control of
 * its own: a "Skip" (`PressableScale`, testID `splash-skip`, label "Skip
 * intro") that fades in only after SKIP_AFTER_S seconds of playback. Before
 * that it declares NO pressable, switch, input, link, or gesture handler.
 * This suite pins both facts (so a control can never be added here without a
 * ledger entry), the touch-ownership contract (root pointerEvents 'auto'
 * while mounted and not exiting, 'none' while exiting), and the only
 * user-observable handoff the component owns — `onFinished` firing exactly
 * once after BOTH hydration (`ready`) and the intro being over (ended,
 * skipped, errored or cut by WATCHDOG_MS) — including the reduced-motion
 * path. react-native-video is auto-mocked from `__mocks__/` (canonical
 * harness: `__tests__/splashScreen.test.tsx`).
 */

/**
 * The RN jest preset's NativeAnimatedModule ends EVERY native-driver
 * animation 16ms after it starts regardless of duration, so wall-clock length
 * is not observable here; the requested duration is, via the frame table the
 * timing config hands to `startAnimatingNode`. (The exit is a parallel of a
 * native-driver opacity fade and a JS-driven twin that steps the volume; the
 * JS twin is what makes the handoff take EXIT_MS on fake timers.)
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
  expect(root.props.testID).toBe('splash-screen');
  return root;
}

function video(renderer: Renderer) {
  const nodes = hostNodes(renderer).filter(
    node => node.props.testID === 'splash-video',
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
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

/**
 * The RN Pressable rendered by PressableScale (after it resolved its a11y
 * defaults): the innermost node carrying the label and an onPress.
 */
function labelledPressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node =>
      node.findAll(
        child =>
          child !== node &&
          child.props?.accessibilityLabel === label &&
          typeof child.props?.onPress === 'function',
      ).length === 0,
  );
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

async function play(renderer: Renderer, seconds: number) {
  await act(async () => {
    video(renderer).props.onProgress({
      currentTime: seconds,
      playableDuration: 5,
      seekableDuration: 5,
    });
  });
}

async function endIntro(renderer: Renderer) {
  await act(async () => {
    video(renderer).props.onEnd();
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
  it('declares zero interactive elements before the first second of playback and owns every touch while mounted', async () => {
    const renderer = await render(false, jest.fn());

    expect(interactiveNodes(renderer)).toHaveLength(0);

    // The full-screen overlay is topmost in hit-testing ('auto') so taps
    // during the intro never activate invisible controls on the first screen
    // beneath — NOT 'box-only', which would also swallow its own Skip.
    const root = hostRoot(renderer);
    expect(root.props.pointerEvents).toBe('auto');
    // The root is deliberately not an accessible/labelled node: that would
    // hide the Skip control from VoiceOver once it appears. The intro itself
    // is what screen readers meet, as an image.
    expect(root.props.accessible).toBeUndefined();
    expect(root.props.accessibilityLabel).toBeUndefined();
    expect(
      renderer.root.findAll(
        node => node.props?.accessibilityLabel === 'Pickle Sensei is starting',
      ),
    ).toHaveLength(0);

    // No control yet, so no control role may be claimed; the single role in
    // the tree is the decorative-but-labelled intro image.
    const roles = hostNodes(renderer)
      .filter(node => node.props.accessibilityRole !== undefined)
      .map(node => [
        node.props.accessibilityRole,
        node.props.accessibilityLabel,
      ]);
    expect(roles).toEqual([['image', 'Pickle Sensei intro animation']]);

    // Half a second in: still nothing to press.
    await play(renderer, SKIP_AFTER_S / 2);
    expect(interactiveNodes(renderer)).toHaveLength(0);
    expect(labelledPressables(renderer, 'Skip intro')).toHaveLength(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('renders the intro video whole, with sound, autoplaying once — and not pressable', async () => {
    const renderer = await render(false, jest.fn());
    const player = video(renderer).props;
    expect(player.source).toBeDefined();
    expect(player.resizeMode).toBe('contain');
    expect(player.paused).toBe(false);
    expect(player.repeat).toBe(false);
    expect(player.controls).toBe(false);
    expect(player.muted).toBeUndefined();
    expect(player.volume).toBe(1);
    expect(player.ignoreSilentSwitch).toBe('obey');
    // The media layer is not a tap target.
    expect(player.onPress).toBeUndefined();
    expect(player.accessibilityRole).toBeUndefined();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('"Skip" is the ONE control: a labelled button that appears after SKIP_AFTER_S seconds and ends the intro', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);

    await play(renderer, SKIP_AFTER_S);
    const skips = labelledPressables(renderer, 'Skip intro');
    expect(skips).toHaveLength(1);
    const skip = skips[0]!;
    expect(skip.props.testID).toBe('splash-skip');
    expect(skip.props.accessibilityRole).toBe('button');
    expect(skip.props.hitSlop).toBe(12);
    expect(skip.props.disabled).toBeFalsy();
    expect(skip.props.accessibilityState?.disabled).toBeFalsy();
    // Exactly one interactive host element exists now, and it is the Skip.
    const interactive = interactiveNodes(renderer);
    expect(interactive).toHaveLength(1);
    expect(interactive[0]!.props.accessibilityLabel).toBe('Skip intro');
    expect(interactive[0]!.props.testID).toBe('splash-skip');
    // Skip is reachable, but the screen beneath still is not.
    expect(hostRoot(renderer).props.pointerEvents).toBe('auto');

    await act(async () => {
      skip.props.onPress();
    });
    // The exit started: the fading overlay must not eat taps meant for the
    // first screen, and nothing is reported until the cross-fade ends.
    expect(hostRoot(renderer).props.pointerEvents).toBe('none');
    expect(onFinished).not.toHaveBeenCalled();
    await advance(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    // Sound tailed off with the picture instead of cutting.
    expect(video(renderer).props.volume).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('SplashScreen handoff (onFinished)', () => {
  it('does not finish while hydration is still pending, however long — even after the intro ended and the watchdog fired', async () => {
    const onFinished = jest.fn();
    const renderer = await render(false, onFinished);

    await endIntro(renderer);
    await advance(WATCHDOG_MS + EXIT_MS + 10_000);
    expect(onFinished).not.toHaveBeenCalled();
    // Holding the last frame over an unpainted gate: still owns every touch.
    expect(hostRoot(renderer).props.pointerEvents).toBe('auto');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('holds until the intro is over even when hydration is instant, then cross-fades out', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);

    await advance(WATCHDOG_MS - 1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(hostRoot(renderer).props.pointerEvents).toBe('auto');

    // The intro ends → exit fade starts; onFinished only after the fade.
    await endIntro(renderer);
    expect(onFinished).not.toHaveBeenCalled();
    expect(hostRoot(renderer).props.pointerEvents).toBe('none');
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

  it('finishes once when ready flips after the intro ended', async () => {
    const onFinished = jest.fn();
    const renderer = await render(false, onFinished);

    await endIntro(renderer);
    await advance(WATCHDOG_MS + 2_000);
    expect(onFinished).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    expect(onFinished).not.toHaveBeenCalled();

    await advance(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Re-renders with a new callback identity, a second end event and a late
    // watchdog must not re-run the exit.
    const replacement = jest.fn();
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={replacement} />);
    });
    await endIntro(renderer);
    await advance(WATCHDOG_MS + EXIT_MS + 1_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('never strands the user: a player error and a stalled player (watchdog) both end the intro', async () => {
    const errored = jest.fn();
    const erroredRenderer = await render(true, errored);
    await act(async () => {
      video(erroredRenderer).props.onError({ error: { code: 1 } });
    });
    await advance(EXIT_MS + 50);
    expect(errored).toHaveBeenCalledTimes(1);
    await act(async () => {
      erroredRenderer.unmount();
    });

    const stalled = jest.fn();
    const stalledRenderer = await render(true, stalled);
    await advance(WATCHDOG_MS - 1);
    await advance(EXIT_MS + 50);
    expect(stalled).not.toHaveBeenCalled();
    await advance(1);
    await advance(EXIT_MS + 50);
    expect(stalled).toHaveBeenCalledTimes(1);
    await act(async () => {
      stalledRenderer.unmount();
    });
  });

  it('with reduced motion, skips the cross-fade and finishes right after the intro ends', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);
    await setReducedMotion(true);

    try {
      await advance(WATCHDOG_MS - 1);
      expect(onFinished).not.toHaveBeenCalled();

      // Zero-duration exit: a single-frame jump to the end value, no fade.
      await endIntro(renderer);
      expect(lastStartedAnimationFrames()).toEqual([1]);
      await advance(NATIVE_ANIMATION_END_MS);
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(video(renderer).props.volume).toBe(0);

      await act(async () => {
        renderer.unmount();
      });
    } finally {
      await setReducedMotion(false);
    }
  });

  it('unmounting before the intro is over never calls onFinished', async () => {
    const onFinished = jest.fn();
    const renderer = await render(true, onFinished);

    await act(async () => {
      renderer.unmount();
    });
    await advance(WATCHDOG_MS + EXIT_MS + 1_000);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
