import React from 'react';
import { StatusBar, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../src/screens/SplashScreen';

/**
 * Launch intro contract: the brand video plays whole (9:16, `contain`) with
 * its sound; a Skip control appears only after the first second of playback;
 * the overlay leaves only once BOTH the intro is over (ended, skipped,
 * errored or timed out) AND hydration is ready, via a cross-fade whose end
 * reports `onFinished`. Animated frames run on fake timers here.
 */

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

function hostNodes(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

function video(renderer: TestRenderer.ReactTestRenderer) {
  return hostNodes(renderer, 'splash-video')[0]!;
}

function skipButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => node.props.testID === 'splash-skip' && node.props.onPress,
  )[0];
}

async function render(ready: boolean) {
  const onFinished = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SplashScreen ready={ready} onFinished={onFinished} />,
    );
  });
  return { renderer, onFinished };
}

async function play(renderer: TestRenderer.ReactTestRenderer, seconds: number) {
  await act(async () => {
    video(renderer).props.onProgress({
      currentTime: seconds,
      playableDuration: 5,
      seekableDuration: 5,
    });
  });
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('SplashScreen', () => {
  it('plays the whole intro at its own aspect, with sound, autoplaying once', async () => {
    const { renderer, onFinished } = await render(true);
    const player = video(renderer).props;
    expect(player.resizeMode).toBe('contain');
    expect(player.paused).toBe(false);
    expect(player.repeat).toBe(false);
    expect(player.controls).toBe(false);
    expect(player.muted).toBeUndefined();
    expect(player.volume).toBe(1);
    expect(player.ignoreSilentSwitch).toBe('obey');
    expect(player.source).toBeDefined();
    // Nothing leaves before the intro is over.
    expect(skipButton(renderer)).toBeUndefined();
    await elapse(EXIT_MS * 2);
    expect(onFinished).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('shows the skip control only after the first second of playback', async () => {
    const { renderer } = await render(true);
    await play(renderer, SKIP_AFTER_S / 2);
    expect(skipButton(renderer)).toBeUndefined();
    await play(renderer, SKIP_AFTER_S);
    const skip = skipButton(renderer)!;
    expect(skip).toBeDefined();
    expect(skip.props.accessibilityLabel).toBe('Skip intro');
    expect(JSON.stringify(renderer.toJSON())).toContain('"Skip"');
    act(() => renderer.unmount());
  });

  it('skip cross-fades the overlay out and reports finished', async () => {
    const { renderer, onFinished } = await render(true);
    await play(renderer, 1.4);
    await act(async () => {
      skipButton(renderer)!.props.onPress();
    });
    // The fading overlay must not eat taps meant for the first screen.
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'none',
    );
    expect(onFinished).not.toHaveBeenCalled();
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    // Sound tailed off with the picture instead of cutting.
    expect(video(renderer).props.volume).toBe(0);
    act(() => renderer.unmount());
  });

  it('finishes after the intro ends on its own', async () => {
    const { renderer, onFinished } = await render(true);
    await act(async () => {
      video(renderer).props.onEnd();
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('holds the last frame until hydration is ready, then hands off', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });
    await act(async () => {
      video(renderer).props.onEnd();
    });
    await elapse(EXIT_MS * 3);
    expect(onFinished).not.toHaveBeenCalled();
    expect(hostNodes(renderer, 'splash-screen')[0]!.props.pointerEvents).toBe(
      'auto',
    );
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never strands the user: a player error finishes the intro', async () => {
    const { renderer, onFinished } = await render(true);
    await act(async () => {
      video(renderer).props.onError({ error: { code: 1 } });
    });
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never strands the user: a silent player is cut by the watchdog', async () => {
    const { renderer, onFinished } = await render(true);
    await elapse(WATCHDOG_MS - 1);
    await elapse(EXIT_MS + 50);
    expect(onFinished).not.toHaveBeenCalled();
    await elapse(1);
    await elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('keeps dark status-bar icons on top of a dark first screen that mounts under it', async () => {
    // Mirrors App.tsx: the first screen (a dark one pushing light-content)
    // mounts under the overlay only once hydration is ready. RN's StatusBar
    // honors the entry pushed LAST, so without the re-push the bar would go
    // white-on-white over the video.
    const Gate = (props: { ready: boolean }) => (
      <View>
        {props.ready ? <StatusBar barStyle="light-content" /> : null}
        <SplashScreen ready={props.ready} onFinished={() => {}} />
      </View>
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Gate ready={false} />);
    });
    await act(async () => {
      renderer.update(<Gate ready />);
    });
    await elapse(1);
    const stack = (
      StatusBar as unknown as {
        _propsStack: { barStyle?: { value: string } }[];
      }
    )._propsStack;
    expect(stack.length).toBeGreaterThanOrEqual(2);
    expect(stack[stack.length - 1]!.barStyle?.value).toBe('dark-content');
    act(() => renderer.unmount());
    await elapse(1);
    // The overlay's entry leaves with it.
    expect(stack.some(entry => entry.barStyle?.value === 'dark-content')).toBe(
      false,
    );
  });

  it('reports finished exactly once even if skip and end both fire', async () => {
    const { renderer, onFinished } = await render(true);
    await play(renderer, 2);
    await act(async () => {
      skipButton(renderer)!.props.onPress();
      video(renderer).props.onEnd();
    });
    await elapse(EXIT_MS * 3);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
