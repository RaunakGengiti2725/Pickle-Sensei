import React from 'react';
import { Animated } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { EXIT_MS, SplashScreen } from '../../../src/screens/SplashScreen';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S9 against 4d812e1a.
 *
 * Unmount the REAL SplashScreen after its exit effect has run (finished.current
 * = true, fade listener attached, Animated.parallel started) but BEFORE the
 * parallel's completion callback fires. The scenario's contract: onFinished is
 * NOT invoked after unmount and `fade.removeListener` has run by then.
 * Animated frames run on fake timers (same as __tests__/splashScreen.test.tsx).
 */

type Renderer = TestRenderer.ReactTestRenderer;

const addListenerSpy = jest.spyOn(Animated.Value.prototype, 'addListener');
const removeListenerSpy = jest.spyOn(
  Animated.Value.prototype,
  'removeListener',
);

function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

async function mountReady(onFinished: jest.Mock) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SplashScreen ready onFinished={onFinished} />,
    );
  });
  return renderer;
}

async function endVideo(renderer: Renderer) {
  await act(async () => {
    hostNodes(renderer, 'splash-video')[0]!.props.onEnd();
  });
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  addListenerSpy.mockClear();
  removeListenerSpy.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('S9 — SplashScreen unmounted after the exit started but before it completed', () => {
  it('precondition: the exit effect ran (listener attached, overlay is pass-through) and nothing finished yet', async () => {
    const onFinished = jest.fn();
    const renderer = await mountReady(onFinished);
    await endVideo(renderer);
    // The fade listener is the ONLY Animated.Value listener SplashScreen adds.
    expect(addListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).not.toHaveBeenCalled();
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'none',
    );
    expect(onFinished).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('CONTRACT (fails on 4d812e1a): unmount mid-exit — onFinished must NOT fire after unmount, and the fade listener must be removed by then', async () => {
    const onFinished = jest.fn();
    const renderer = await mountReady(onFinished);
    await endVideo(renderer);
    await elapse(EXIT_MS / 4); // a few frames into the cross-fade
    expect(onFinished).not.toHaveBeenCalled();

    act(() => renderer.unmount());
    const removedAtUnmount = removeListenerSpy.mock.calls.length;

    // Let the (orphaned) animation run to completion and past it.
    await elapse(EXIT_MS * 3);

    console.log(
      JSON.stringify({
        probe: 'S9/unmount-mid-exit',
        onFinishedCallsAfterUnmount: onFinished.mock.calls.length,
        listenerRemovedAtUnmount: removedAtUnmount,
        listenerRemovedEventually: removeListenerSpy.mock.calls.length,
      }),
    );
    expect(removedAtUnmount).toBe(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('CONTRACT (fails on 4d812e1a): unmount on the very tick the exit started (before any frame) — same contract', async () => {
    const onFinished = jest.fn();
    const renderer = await mountReady(onFinished);
    await endVideo(renderer);
    act(() => renderer.unmount());
    const removedAtUnmount = removeListenerSpy.mock.calls.length;
    await elapse(EXIT_MS * 3);
    expect(removedAtUnmount).toBe(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('control: left mounted, the same exit completes once, removes the listener once, and reports finished once', async () => {
    const onFinished = jest.fn();
    const renderer = await mountReady(onFinished);
    await endVideo(renderer);
    await elapse(EXIT_MS + 50);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(hostNodes(renderer, 'splash-video')[0]!.props.volume).toBe(0);
    act(() => renderer.unmount());
  });

  it('PROBE: a parent that swaps onFinished mid-exit — which callback fires?', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const renderer = await mountReady(first);
    await endVideo(renderer);
    await elapse(EXIT_MS / 4);
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={second} />);
    });
    await elapse(EXIT_MS * 2);

    console.log(
      JSON.stringify({
        probe: 'S9/onFinished-swap',
        firstCalls: first.mock.calls.length,
        secondCalls: second.mock.calls.length,
      }),
    );
    // Exactly one handoff regardless of which identity is used; App.tsx
    // passes a stable useCallback so both are equivalent there.
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    act(() => renderer.unmount());
  });

  it('rapid repeats: 10 mount → end → unmount-mid-exit cycles never leak an onFinished call', async () => {
    const calls: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const onFinished = jest.fn();
      const renderer = await mountReady(onFinished);
      await endVideo(renderer);
      await elapse((EXIT_MS * i) / 12);
      act(() => renderer.unmount());
      await elapse(EXIT_MS * 2);
      calls.push(onFinished.mock.calls.length);
    }

    console.log(
      JSON.stringify({ probe: 'S9/rapid', onFinishedCallsPerCycle: calls }),
    );
    expect(calls.every(count => count === 0)).toBe(true);
  });
});
