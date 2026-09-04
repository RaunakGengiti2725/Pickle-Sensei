/**
 * ADVERSARIAL PASS 3 — scenario 4 (mobile-launch-onboarding).
 *
 * Attack: render SplashScreen with ready=true and fire the player's onError
 * BEFORE onLoad or any onProgress (a decoder that refuses the asset at
 * once). Variants: onError fired repeatedly, onError + onEnd + watchdog all
 * landing, onError delivered in the same commit as mount, and — the
 * unusual one — progress events that keep arriving AFTER the error.
 *
 * Expected: onFinished fires exactly once; the Skip control never appears
 * (it is gated on ≥1s of real playback, which never happened); the exiting
 * overlay stops eating taps.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../../src/screens/SplashScreen';

type Renderer = TestRenderer.ReactTestRenderer;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

function video(renderer: Renderer) {
  return hostNodes(renderer, 'splash-video')[0]!;
}

function skipButtons(renderer: Renderer) {
  return renderer.root.findAll(
    node => node.props.testID === 'splash-skip' && node.props.onPress,
  );
}

function rendersSkipCopy(renderer: Renderer) {
  return JSON.stringify(renderer.toJSON()).includes('"Skip"');
}

async function mount(ready = true) {
  const onFinished = jest.fn();
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SplashScreen ready={ready} onFinished={onFinished} />,
    );
  });
  return { renderer, onFinished };
}

async function fail(renderer: Renderer) {
  await act(async () => {
    video(renderer).props.onError({
      error: { code: -11828, domain: 'AVFoundationErrorDomain' },
    });
  });
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function expectNoSkip(renderer: Renderer) {
  expect(skipButtons(renderer)).toHaveLength(0);
  expect(rendersSkipCopy(renderer)).toBe(false);
}

describe('S4 — ready=true, onError before onLoad/onProgress', () => {
  it('error first: finishes exactly once, Skip never rendered, overlay releases taps', async () => {
    const { renderer, onFinished } = await mount(true);
    expectNoSkip(renderer);
    expect(video(renderer).props.onLoad).toBeUndefined();
    await fail(renderer);
    expectNoSkip(renderer);
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'none',
    );
    expect(onFinished).not.toHaveBeenCalled();
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectNoSkip(renderer);
    // Long after: watchdog + anything else must not re-fire.
    await elapse(WATCHDOG_MS * 2);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectNoSkip(renderer);
    act(() => renderer.unmount());
  });

  it('error fired 5× in one tick, then onEnd, then the watchdog: still exactly one onFinished, no Skip', async () => {
    const { renderer, onFinished } = await mount(true);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        video(renderer).props.onError({ error: { code: i } });
      }
      video(renderer).props.onEnd();
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    await elapse(WATCHDOG_MS + EXIT_MS);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectNoSkip(renderer);
    act(() => renderer.unmount());
  });

  it('error delivered synchronously right after the first commit (no microtask in between): one onFinished, no Skip', async () => {
    const onFinished = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    act(() => {
      video(renderer).props.onError({ error: { code: 1 } });
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectNoSkip(renderer);
    act(() => renderer.unmount());
  });

  it('error while NOT ready, then ready: one onFinished, no Skip, and the overlay held taps until the exit began', async () => {
    const { renderer, onFinished } = await mount(false);
    await fail(renderer);
    await elapse(EXIT_MS * 2);
    expect(onFinished).not.toHaveBeenCalled();
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'auto',
    );
    expectNoSkip(renderer);
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectNoSkip(renderer);
    act(() => renderer.unmount());
  });

  it('progress events with currentTime ≥ SKIP_AFTER_S arriving AFTER the error cannot surface a TAPPABLE Skip or a second finish', async () => {
    const { renderer, onFinished } = await mount(true);
    await fail(renderer);
    // A misbehaving player keeps emitting progress after reporting an error.
    await act(async () => {
      video(renderer).props.onProgress({
        currentTime: SKIP_AFTER_S + 0.5,
        playableDuration: 5,
        seekableDuration: 5,
      });
    });
    // The overlay is already exiting and inert (pointerEvents none), exactly
    // as after a normal end where Skip is visible during the fade too. The
    // control therefore renders here as well; the contract is that it is not
    // reachable and that pressing it anyway cannot re-arm the exit.
    const overlay = hostNodes(renderer, 'splash-screen')[0]!;
    expect(overlay.props.pointerEvents).toBe('none');
    const skip = skipButtons(renderer);
    expect(skip.length).toBeGreaterThan(0);
    await act(async () => {
      skip[0]!.props.onPress();
      skip[0]!.props.onPress();
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    await elapse(WATCHDOG_MS * 2);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
