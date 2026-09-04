/**
 * ADVERSARIAL S2 — SplashScreen: fire onEnd, onError AND the 8 s watchdog
 * together while `ready=false`, then flip `ready`. The overlay must start
 * its exit cross-fade exactly once and report `onFinished` exactly once.
 *
 * Extra interleavings: onFinished identity churn after the exit began,
 * ready flapping true→false→true during the exit, repeated onEnd/onError
 * bursts after the exit, and an unmount mid-exit (no onFinished after
 * unmount).
 */
import React from 'react';
import { Animated } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';

const ATTACK_SEED = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.['ATTACK_SEED'] ?? '20260904',
);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

let parallelSpy: jest.SpyInstance;
let exitStarts = 0;

beforeEach(() => {
  jest.useFakeTimers();
  exitStarts = 0;
  const realParallel = Animated.parallel;
  parallelSpy = jest
    .spyOn(Animated, 'parallel')
    .mockImplementation((animations, config) => {
      const composite = realParallel(animations, config);
      const realStart = composite.start.bind(composite);
      composite.start = (cb?: Parameters<typeof realStart>[0]) => {
        exitStarts += 1;
        realStart(cb);
      };
      return composite;
    });
});

afterEach(() => {
  parallelSpy.mockRestore();
  jest.useRealTimers();
});

function video(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.testID === 'splash-video' && typeof node.type === 'string',
  )[0]!;
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe(`S2 splash: onEnd + onError + watchdog while ready=false (seed ${ATTACK_SEED})`, () => {
  it('a burst of every playback-over signal followed by ready=true yields one exit start and one onFinished', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });

    // All three "playback over" sources land in the same tick, in a seeded
    // order, while hydration is still pending.
    const rnd = lcg(ATTACK_SEED);
    const signals: Array<() => void> = [
      () => video(renderer).props.onEnd(),
      () => video(renderer).props.onError({ error: { code: -1 } }),
      () => jest.advanceTimersByTime(WATCHDOG_MS),
    ].sort(() => rnd() - 0.5);
    await act(async () => {
      for (const fire of signals) fire();
    });
    // Repeat the burst a few more times (a player that keeps erroring).
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        video(renderer).props.onError({ error: { code: i } });
        video(renderer).props.onEnd();
      });
    }
    await elapse(EXIT_MS * 3);
    expect(exitStarts).toBe(0);
    expect(onFinished).not.toHaveBeenCalled();

    // Hydration lands.
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    expect(exitStarts).toBe(1);
    expect(onFinished).not.toHaveBeenCalled();
    // Overlay is already letting taps through to the first screen.
    expect(
      renderer.root.findAll(
        node =>
          node.props.testID === 'splash-screen' &&
          typeof node.type === 'string',
      )[0]!.props.pointerEvents,
    ).toBe('none');

    // Attack during the exit: late onEnd/onError, onFinished identity churn
    // and a ready flap must not restart the exit or double-report.
    const onFinished2 = jest.fn();
    await act(async () => {
      video(renderer).props.onEnd();
      video(renderer).props.onError({ error: { code: 99 } });
      renderer.update(<SplashScreen ready={false} onFinished={onFinished2} />);
    });
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished2} />);
    });
    await elapse(EXIT_MS + 50);

    const total = onFinished.mock.calls.length + onFinished2.mock.calls.length;
    console.log(
      JSON.stringify({
        scenario: 'S2',
        seed: ATTACK_SEED,
        exitStarts,
        onFinishedCalls: total,
        onFinished1: onFinished.mock.calls.length,
        onFinished2: onFinished2.mock.calls.length,
      }),
    );
    expect(exitStarts).toBe(1);
    expect(total).toBe(1);

    await elapse(WATCHDOG_MS * 2);
    expect(exitStarts).toBe(1);
    expect(onFinished.mock.calls.length + onFinished2.mock.calls.length).toBe(
      1,
    );
    act(() => renderer.unmount());
  });

  it('mounting with ready=true and firing every signal at once still exits exactly once', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    await act(async () => {
      video(renderer).props.onEnd();
      video(renderer).props.onError({ error: {} });
      jest.advanceTimersByTime(WATCHDOG_MS);
      video(renderer).props.onEnd();
    });
    await elapse(EXIT_MS + 50);
    expect(exitStarts).toBe(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('unmounting mid-exit reports nothing after unmount', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    await act(async () => {
      video(renderer).props.onEnd();
    });
    expect(exitStarts).toBe(1);
    await elapse(EXIT_MS / 2);
    act(() => renderer.unmount());
    await elapse(EXIT_MS * 2);
    console.log(
      JSON.stringify({
        scenario: 'S2-unmount-mid-exit',
        onFinishedAfterUnmount: onFinished.mock.calls.length,
      }),
    );
    expect(onFinished).not.toHaveBeenCalled();
  });
});
