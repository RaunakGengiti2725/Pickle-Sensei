/**
 * ADVERSARIAL PASS 3 — scenario 3 (mobile-launch-onboarding).
 *
 * Attack: render SplashScreen and toggle `ready` false→true→false→true around
 * the intro's end — before the end, straddling it, and mid-exit-fade — plus a
 * seeded burst of toggles in one tick and an unmount mid-fade.
 *
 * Expected: `onFinished` fires exactly once; every Animated listener the
 * exit ramp registered is removed by the time the fade completes (or the
 * component unmounts); no timers (watchdog, animation frames) survive the
 * unmount.
 *
 * Listener accounting is done by spying on Animated.Value's own
 * addListener/removeListener, so it covers the `fade` value the component
 * keeps private.
 */
import React from 'react';
import { Animated, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SplashScreen,
  WATCHDOG_MS,
} from '../../../src/screens/SplashScreen';

type Renderer = TestRenderer.ReactTestRenderer;

const addedListenerIds: string[] = [];
const removedListenerIds: string[] = [];
let addSpy: jest.SpyInstance;
let removeSpy: jest.SpyInstance;
/** Timers the renderer/scheduler keep alive regardless of the component
 * under test (measured per test with a bare <View/>); the splash must not
 * add to them once unmounted and flushed. */
let baselineTimers = 0;
/** Every setTimeout armed with the watchdog's delay, and which were cleared. */
const watchdogIds = new Set<unknown>();
const clearedIds = new Set<unknown>();
const firedIds = new Set<unknown>();
let timeoutSpy: jest.SpyInstance;
let clearTimeoutSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.useFakeTimers();
  let probe!: Renderer;
  await act(async () => {
    probe = TestRenderer.create(<View />);
  });
  act(() => probe.unmount());
  await act(async () => {
    jest.advanceTimersByTime(WATCHDOG_MS * 4);
  });
  baselineTimers = jest.getTimerCount();
  addedListenerIds.length = 0;
  removedListenerIds.length = 0;
  watchdogIds.clear();
  clearedIds.clear();
  firedIds.clear();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms !== WATCHDOG_MS) return realSetTimeout(fn, ms);
    const id: ReturnType<typeof setTimeout> = realSetTimeout(() => {
      firedIds.add(id);
      fn();
    }, ms);
    watchdogIds.add(id);
    return id;
  }) as typeof setTimeout);
  clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((
    id: unknown,
  ) => {
    clearedIds.add(id);
    return realClearTimeout(id as never);
  }) as typeof clearTimeout);
  const proto = Animated.Value.prototype;
  const realAdd = proto.addListener;
  const realRemove = proto.removeListener;
  addSpy = jest.spyOn(proto, 'addListener').mockImplementation(function (
    this: Animated.Value,
    cb,
  ) {
    const id = realAdd.call(this, cb);
    addedListenerIds.push(id);
    return id;
  });
  removeSpy = jest.spyOn(proto, 'removeListener').mockImplementation(function (
    this: Animated.Value,
    id: string,
  ) {
    removedListenerIds.push(id);
    return realRemove.call(this, id);
  });
});

afterEach(() => {
  addSpy.mockRestore();
  removeSpy.mockRestore();
  timeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
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

async function mount(ready: boolean) {
  const onFinished = jest.fn();
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SplashScreen ready={ready} onFinished={onFinished} />,
    );
  });
  return { renderer, onFinished };
}

async function setReady(
  renderer: Renderer,
  onFinished: jest.Mock,
  ready: boolean,
) {
  await act(async () => {
    renderer.update(<SplashScreen ready={ready} onFinished={onFinished} />);
  });
}

async function end(renderer: Renderer) {
  await act(async () => {
    video(renderer).props.onEnd();
  });
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function expectListenersBalanced() {
  expect(addedListenerIds.length).toBeGreaterThan(0);
  expect([...removedListenerIds].sort()).toEqual([...addedListenerIds].sort());
}

/** Call after unmount: every watchdog either fired while mounted or was
 * cleared on unmount (never left to fire into an unmounted component), and
 * no timer beyond the renderer's own baseline is still pending after a long
 * flush. */
async function expectNoLeakedTimers() {
  expect(watchdogIds.size).toBeGreaterThan(0);
  for (const id of watchdogIds) {
    expect(clearedIds.has(id) || firedIds.has(id)).toBe(true);
  }
  await act(async () => {
    jest.advanceTimersByTime(WATCHDOG_MS * 4);
  });
  expect(jest.getTimerCount()).toBe(baselineTimers);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const SEED = 0x5eed33;

describe('S3 — ready toggling false→true→false→true around intro end', () => {
  it('toggle BEFORE the intro ends: exit runs once after the final true', async () => {
    const { renderer, onFinished } = await mount(false);
    await setReady(renderer, onFinished, true);
    await setReady(renderer, onFinished, false);
    await end(renderer); // intro over while NOT ready — must hold
    await elapse(EXIT_MS * 2);
    expect(onFinished).not.toHaveBeenCalled();
    expect(addedListenerIds).toHaveLength(0);
    await setReady(renderer, onFinished, true);
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(addedListenerIds).toHaveLength(1);
    expectListenersBalanced();
    await elapse(WATCHDOG_MS * 2);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await expectNoLeakedTimers();
  });

  it('toggle STRADDLING the end (false→true, end, false→true mid-fade): one exit, one onFinished', async () => {
    const { renderer, onFinished } = await mount(false);
    await setReady(renderer, onFinished, true);
    await end(renderer); // exit starts here (ready && playbackOver)
    await elapse(EXIT_MS / 3);
    await setReady(renderer, onFinished, false); // mid-fade
    await elapse(EXIT_MS / 3);
    await setReady(renderer, onFinished, true); // mid-fade again
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    // Exactly one exit ramp was armed and its listener was released.
    expect(addedListenerIds).toHaveLength(1);
    expectListenersBalanced();
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'none',
    );
    expect(video(renderer).props.volume).toBe(0);
    await elapse(WATCHDOG_MS * 2);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await expectNoLeakedTimers();
  });

  it('ready flips false→true→false→true all in ONE commit after the end: one exit, one onFinished', async () => {
    const { renderer, onFinished } = await mount(false);
    await end(renderer);
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
      renderer.update(<SplashScreen ready={false} onFinished={onFinished} />);
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(addedListenerIds).toHaveLength(1);
    expectListenersBalanced();
    act(() => renderer.unmount());
    await expectNoLeakedTimers();
  });

  it('ready ends FALSE after the burst: nothing exits, no listener armed, and a late true still finishes once', async () => {
    const { renderer, onFinished } = await mount(false);
    await end(renderer);
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
      renderer.update(<SplashScreen ready={false} onFinished={onFinished} />);
    });
    await elapse(EXIT_MS * 3);
    // Whether the true→false in one commit collapses to "never true" or
    // "true then false", the contract is the same: at most one exit, and it
    // must complete (never a half-faded overlay left over the first screen).
    const exitedEarly = onFinished.mock.calls.length;
    expect(exitedEarly).toBeLessThanOrEqual(1);
    await setReady(renderer, onFinished, true);
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(addedListenerIds).toHaveLength(1);
    expectListenersBalanced();
    act(() => renderer.unmount());
    await expectNoLeakedTimers();
  });

  it(`seeded toggle storm (seed ${SEED}) across 30 runs: onFinished once per run, listeners balanced, no leaked timers`, async () => {
    const rand = lcg(SEED);
    for (let run = 0; run < 30; run += 1) {
      addedListenerIds.length = 0;
      removedListenerIds.length = 0;
      const { renderer, onFinished } = await mount(false);
      const endAt = Math.floor(rand() * 6);
      let ready = false;
      const steps = 6 + Math.floor(rand() * 6);
      for (let i = 0; i < steps; i += 1) {
        if (i === endAt) await end(renderer);
        ready = rand() < 0.5;
        await setReady(renderer, onFinished, ready);
        await elapse(Math.floor(rand() * (EXIT_MS / 2)));
      }
      if (!ready) await setReady(renderer, onFinished, true);
      if (endAt >= steps) await end(renderer);
      await elapse(EXIT_MS + 50);
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(addedListenerIds).toHaveLength(1);
      expectListenersBalanced();
      act(() => renderer.unmount());
      await expectNoLeakedTimers();
    }
  });

  it('unmount MID-FADE: the fade listener is released and no timer survives', async () => {
    const { renderer, onFinished } = await mount(true);
    await end(renderer);
    await elapse(EXIT_MS / 2);
    expect(onFinished).not.toHaveBeenCalled();
    expect(addedListenerIds).toHaveLength(1);
    act(() => renderer.unmount());
    await elapse(EXIT_MS * 2 + WATCHDOG_MS);
    // Detaching the Animated.View stops the exit; whatever the completion
    // callback does, the listener must be gone and nothing may fire twice.
    expectListenersBalanced();
    expect(onFinished.mock.calls.length).toBeLessThanOrEqual(1);
    await expectNoLeakedTimers();
  });

  it('a NEW onFinished identity mid-fade neither re-arms the exit nor double-fires', async () => {
    const first = jest.fn();
    const second = jest.fn();
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SplashScreen ready onFinished={first} />);
    });
    await end(renderer);
    await elapse(EXIT_MS / 2);
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={second} />);
    });
    await elapse(EXIT_MS + 50);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    expect(addedListenerIds).toHaveLength(1);
    expectListenersBalanced();
    act(() => renderer.unmount());
    await expectNoLeakedTimers();
  });
});
