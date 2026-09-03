import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/design/components', () => ({
  ...jest.requireActual('../../src/design/components'),
  useReducedMotion: () => false,
}));

import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';

/**
 * App.tsx paints the first screen UNDER the splash as soon as hydration is
 * ready, so the opaque overlay must own every touch for as long as it is
 * genuinely on screen — otherwise an impatient tap on the intro lands on an
 * invisible Welcome / Home control and the user is routed somewhere they
 * never chose.
 *
 * With the MP4 intro the contract is expressed through the root's
 * `pointerEvents`: 'auto' (topmost in hit-testing, nothing beneath is
 * reachable) while mounted and not exiting — including while the Skip
 * control is showing — and 'none' the moment the exit cross-fade starts, so
 * the live screen beneath takes over instead of a fading ghost eating taps.
 * (The old 'box-only' root would have swallowed the overlay's own Skip too.)
 */

function splashRoot(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' && node.props.testID === 'splash-screen',
  );
}

function video(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' && node.props.testID === 'splash-video',
  );
}

function expectSwallowsTouches(renderer: TestRenderer.ReactTestRenderer) {
  expect(splashRoot(renderer).props.pointerEvents).toBe('auto');
}

function expectPassesTouchesThrough(renderer: TestRenderer.ReactTestRenderer) {
  expect(splashRoot(renderer).props.pointerEvents).toBe('none');
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SplashScreen touch interception (fix-30)', () => {
  test('blocks touches while hydration is still pending', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });

    expectSwallowsTouches(renderer);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expectSwallowsTouches(renderer);
    // Even once the intro itself is over (and the watchdog has long fired),
    // an unready gate keeps the overlay — and its touch ownership — in place.
    act(() => {
      video(renderer).props.onEnd();
    });
    act(() => {
      jest.advanceTimersByTime(WATCHDOG_MS + EXIT_MS);
    });
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();
  });

  test('keeps blocking touches through the intro after ready flips — including while Skip is showing', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={true} onFinished={onFinished} />,
      );
    });

    expectSwallowsTouches(renderer);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expectSwallowsTouches(renderer);
    // The Skip control appearing does not open the screen beneath: the
    // overlay stays the hit-test target, Skip is simply a child of it.
    act(() => {
      video(renderer).props.onProgress({
        currentTime: SKIP_AFTER_S,
        playableDuration: 5,
        seekableDuration: 5,
      });
    });
    expect(
      renderer.root.findAll(node => node.props.testID === 'splash-skip').length,
    ).toBeGreaterThan(0);
    expectSwallowsTouches(renderer);
    act(() => {
      jest.advanceTimersByTime(WATCHDOG_MS - 1001);
    });
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();
  });

  test('hands touches to the live screen beneath the moment the exit starts, and never takes them back', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });
    act(() => {
      video(renderer).props.onEnd();
    });
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    // Intro over, gate not ready: still holding, still owning touches.
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();

    act(() => {
      renderer.update(<SplashScreen ready={true} onFinished={onFinished} />);
    });
    // Exiting: the first screen is painted and must be tappable at once —
    // a fading overlay may not intercept a single touch.
    expectPassesTouchesThrough(renderer);
    expect(onFinished).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(EXIT_MS + 50);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    // Until App.tsx unmounts it on onFinished, the finished overlay stays
    // transparent to touches.
    expectPassesTouchesThrough(renderer);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expectPassesTouchesThrough(renderer);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  test('a skip mid-intro follows the same rule: touches pass through only once the exit has begun', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={true} onFinished={onFinished} />,
      );
    });
    act(() => {
      video(renderer).props.onProgress({
        currentTime: SKIP_AFTER_S + 0.4,
        playableDuration: 5,
        seekableDuration: 5,
      });
    });
    expectSwallowsTouches(renderer);
    const skip = renderer.root.findAll(
      node => node.props.testID === 'splash-skip' && node.props.onPress,
    )[0]!;
    act(() => {
      skip.props.onPress();
    });
    expectPassesTouchesThrough(renderer);
    act(() => {
      jest.advanceTimersByTime(EXIT_MS + 50);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectPassesTouchesThrough(renderer);
  });
});
