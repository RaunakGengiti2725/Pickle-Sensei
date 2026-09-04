import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { InstructionalMedia } from '../src/training/types';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

/** Every WebView source the tree ever committed, in order (see the media-swap probe). */
const renderedSources: string[] = [];
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) => {
    const source = props.source as { uri?: string; html?: string } | undefined;
    ReactModule.useEffect(() => {
      renderedSources.push(
        source?.uri ?? (source?.html ? 'html-shell' : 'none'),
      );
    }, [source?.uri, source?.html]);
    return ReactModule.createElement(View, props);
  };
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  DrillVideoPlayer,
  EMBED_READY_TIMEOUT_MS,
} from '../src/components/DrillVideoPlayer';

/**
 * ADVERSARIAL PASS 3 — DrillVideoPlayer watchdog boundaries.
 *
 * Attacks the 12 s "silent YouTube shell → watch page" watchdog at its exact
 * edges: unmount 1 ms before it fires (the timer must be cleared, nothing may
 * touch React state afterwards), let it fire 1 ms late (the fallback must
 * happen), swap media at the edge (the new video must get a fresh 12 s), and
 * hammer open/close churn (no timer may leak). Adds nothing to production.
 */

const youtubeMedia: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
};

const secondYoutubeMedia: InstructionalMedia = {
  ...youtubeMedia,
  id: '0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  videoId: 'vly202abc',
  embedUrl: 'https://www.youtube-nocookie.com/embed/vly202abc',
  sourceUrl: 'https://www.youtube.com/watch?v=vly202abc',
};

const hostedMedia: InstructionalMedia = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4?sig=abc',
  expiresAt: '2030-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei Coaching',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const onClose = jest.fn();

function renderPlayer(media: InstructionalMedia | null) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DrillVideoPlayer media={media} onClose={onClose} />,
    );
  });
  return renderer;
}

function findWebView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-webview' && n.props.source,
  );
  return node ?? null;
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(n => n.props.testID === id).length > 0;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

/** Handles of every setTimeout armed with the watchdog delay. */
function watchdogHandles(spy: jest.SpyInstance): unknown[] {
  return spy.mock.results
    .filter((_, i) => spy.mock.calls[i]?.[1] === EMBED_READY_TIMEOUT_MS)
    .map(result => result.value);
}

describe('attack 3 — YouTube embed watchdog boundaries', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    // React 19 schedules its own work through queueMicrotask; keeping that
    // real makes jest.getTimerCount() count only genuine timers.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    onClose.mockClear();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('unmounting at 11,999 ms clears the watchdog: no timer left, no state update, no warning', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const renderer = renderPlayer(youtubeMedia);

    // Silent shell: never deliver onMessage.
    expect(findWebView(renderer)?.props.source.html).toContain('dnk101xyz');
    expect(hasTestId(renderer, 'drill-video-embed-loading')).toBe(true);

    const armed = watchdogHandles(setTimeoutSpy);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    const lastArmed = armed[armed.length - 1];

    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    // Still on the embed shell 1 ms before the deadline.
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    expect(findWebView(renderer)?.props.source.uri).toBeUndefined();

    act(() => renderer.unmount());

    // The live handle was cleared by the effect cleanup…
    expect(
      clearTimeoutSpy.mock.calls.map((call: unknown[]) => call[0]),
    ).toContain(lastArmed);
    // …and nothing is left pending in the fake clock.
    expect(jest.getTimerCount()).toBe(0);

    // Crossing the deadline after unmount must be a no-op.
    await elapse(10);
    await elapse(EMBED_READY_TIMEOUT_MS);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a silent shell falls forward to the watch page at 12,001 ms, not at 11,999 ms', async () => {
    const renderer = renderPlayer(youtubeMedia);

    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    expect(hasTestId(renderer, 'drill-video-embed-loading')).toBe(true);

    await elapse(2); // 12,001 ms total
    const webView = findWebView(renderer);
    expect(webView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
    expect(webView?.props.source.headers.Referer).toBe(
      'https://com.picklesensei',
    );
    expect(hasTestId(renderer, 'drill-video-embed-loading')).toBe(false);
    // The watchdog disarms itself once the stage changed.
    expect(jest.getTimerCount()).toBe(0);
    act(() => renderer.unmount());
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('fires exactly at the 12,000 ms boundary (not before)', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    expect(findWebView(renderer)?.props.source.uri).toBeUndefined();
    await elapse(1);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => renderer.unmount());
  });

  it('a "ready" message at 11,999 ms disarms the watchdog and keeps the shell', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    await act(async () => {
      findWebView(renderer)?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
      });
    });
    expect(jest.getTimerCount()).toBe(0);
    await elapse(EMBED_READY_TIMEOUT_MS * 2);
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    expect(hasTestId(renderer, 'drill-video-embed-loading')).toBe(false);
    act(() => renderer.unmount());
  });

  it('swapping media at 11,999 ms restarts the 12 s budget for the new video', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS - 1);

    act(() => {
      renderer.update(
        <DrillVideoPlayer media={secondYoutubeMedia} onClose={onClose} />,
      );
    });
    expect(findWebView(renderer)?.props.source.html).toContain('vly202abc');

    // 2 ms later the OLD deadline would have passed: nothing may happen.
    await elapse(2);
    expect(findWebView(renderer)?.props.source.uri).toBeUndefined();

    // The new video gets its own full budget.
    await elapse(EMBED_READY_TIMEOUT_MS - 3);
    expect(findWebView(renderer)?.props.source.uri).toBeUndefined();
    await elapse(2);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      secondYoutubeMedia.sourceUrl,
    );
    expect(jest.getTimerCount()).toBe(0);
    act(() => renderer.unmount());
  });

  it('closing the player (media → null) at 11,999 ms clears the watchdog', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    act(() => {
      renderer.update(<DrillVideoPlayer media={null} onClose={onClose} />);
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(renderer.toJSON()).toBeNull();
    await elapse(EMBED_READY_TIMEOUT_MS);
    expect(renderer.toJSON()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('hosted media never arms a watchdog', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const renderer = renderPlayer(hostedMedia);
    expect(watchdogHandles(setTimeoutSpy)).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      hostedMedia.playbackUrl,
    );
    act(() => renderer.unmount());
  });

  it('after the watch fallback, retry re-arms exactly one fresh watchdog', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    // Watch page dies → error card → retry.
    await act(async () => {
      findWebView(renderer)?.props.onError({ nativeEvent: {} });
    });
    expect(hasTestId(renderer, 'drill-video-error')).toBe(true);
    const armedBefore = watchdogHandles(setTimeoutSpy).length;
    await pressByLabel(renderer, 'Try loading the video again');
    expect(watchdogHandles(setTimeoutSpy)).toHaveLength(armedBefore + 1);
    expect(jest.getTimerCount()).toBe(1);
    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    await elapse(1);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('200 open/close cycles at random offsets leak no timers (seed 0x5eed03)', async () => {
    // Deterministic LCG so the run is reproducible.
    let seed = 0x5eed03;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const renderer = renderPlayer(null);
    for (let i = 0; i < 200; i += 1) {
      act(() => {
        renderer.update(
          <DrillVideoPlayer
            media={i % 3 === 0 ? secondYoutubeMedia : youtubeMedia}
            onClose={onClose}
          />,
        );
      });
      const offset = Math.floor(next() * (EMBED_READY_TIMEOUT_MS + 50));
      await elapse(offset);
      if (next() < 0.3) {
        await act(async () => {
          findWebView(renderer)?.props.onMessage({
            nativeEvent: { data: JSON.stringify({ kind: 'error' }) },
          });
        });
      }
      act(() => {
        renderer.update(<DrillVideoPlayer media={null} onClose={onClose} />);
      });
      expect(jest.getTimerCount()).toBe(0);
    }
    act(() => renderer.unmount());
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a late "error" message after the watch fallback does not regress the stage', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    await act(async () => {
      findWebView(renderer)?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error' }) },
      });
    });
    await act(async () => {
      findWebView(renderer)?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
      });
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    expect(hasTestId(renderer, 'drill-video-error')).toBe(false);
    expect(allText(renderer)).toContain(
      'Video by Third Shot Sports on YouTube',
    );
    act(() => renderer.unmount());
  });

  it('swapping media while on the watch page: observe which stage the new video renders first', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    renderedSources.length = 0;
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={secondYoutubeMedia} onClose={onClose} />,
      );
    });
    // The settled state is the new video's shell…
    expect(findWebView(renderer)?.props.source.html).toContain('vly202abc');
    // …but the stage reset is an effect, so the FIRST commit for the new
    // media mounts a WebView on its watch page (a real WebView would start
    // loading youtube.com/watch?v=vly202abc before being torn down).
    expect(renderedSources).toEqual([
      secondYoutubeMedia.sourceUrl,
      'html-shell',
    ]);
    act(() => renderer.unmount());
  });
});
