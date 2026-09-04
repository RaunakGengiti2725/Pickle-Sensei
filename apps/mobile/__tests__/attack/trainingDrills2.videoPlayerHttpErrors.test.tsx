import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { InstructionalMedia } from '../../src/training/types';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { DrillVideoPlayer } from '../../src/components/DrillVideoPlayer';

/**
 * ADVERSARIAL PASS 3 — mobile-training-drills, scenario S1.
 *
 * Attack: in the watch stage, deliver `onHttpError` for the main document
 * with statusCode 429, then a subresource 404 (and several other orderings
 * and rapid repeats). Only the first main-document error may advance the
 * fallback ladder to `failed`; every later event must be inert.
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

const hostedMedia: InstructionalMedia = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4?sig=abc',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei Coaching',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const FAILED_COPY = 'This video could not load in the app.';

const onClose = jest.fn();

function renderPlayer(media: InstructionalMedia) {
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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** Coarse ladder position derived purely from what is rendered. */
function ladderStage(
  renderer: TestRenderer.ReactTestRenderer,
): 'embed' | 'watch' | 'failed' | 'unknown' {
  const webView = findWebView(renderer);
  if (!webView) {
    return allText(renderer).includes(FAILED_COPY) ? 'failed' : 'unknown';
  }
  const source = webView.props.source as { html?: string; uri?: string };
  if (typeof source.html === 'string') return 'embed';
  if (source.uri === youtubeMedia.sourceUrl) return 'watch';
  return 'unknown';
}

async function sendMessage(
  renderer: TestRenderer.ReactTestRenderer,
  data: string,
) {
  const webView = findWebView(renderer);
  await act(async () => {
    webView?.props.onMessage({ nativeEvent: { data } });
  });
}

type HttpErrorHandler = (event: {
  nativeEvent: { url?: string; statusCode?: number; description?: string };
}) => void;

async function enterWatchStage(renderer: TestRenderer.ReactTestRenderer) {
  await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 150 }));
  const watchView = findWebView(renderer);
  expect(watchView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
  return watchView!.props.onHttpError as HttpErrorHandler;
}

async function deliverHttpError(
  handler: HttpErrorHandler,
  url: string,
  statusCode: number,
) {
  await act(async () => {
    handler({
      nativeEvent: { url, statusCode, description: `HTTP ${statusCode}` },
    });
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

describe('S1 — watch-stage HTTP error ladder (DrillVideoPlayer)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onClose.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('main-document 429 advances to failed exactly once; a later subresource 404 is inert', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const onHttpError = await enterWatchStage(renderer);
    const transitions: string[] = [ladderStage(renderer)];

    // 1) The watch document itself is rate limited.
    await deliverHttpError(onHttpError, youtubeMedia.sourceUrl, 429);
    transitions.push(ladderStage(renderer));
    expect(ladderStage(renderer)).toBe('failed');
    expect(findWebView(renderer)).toBeNull();
    const failedTextAfter429 = allText(renderer);
    expect(failedTextAfter429).toContain(FAILED_COPY);

    // 2) A subresource on the (now torn down) watch page 404s. Delivered
    //    through the same handler reference the watch WebView held.
    await deliverHttpError(
      onHttpError,
      'https://www.youtube.com/api/stats/qoe?docid=dnk101xyz',
      404,
    );
    transitions.push(ladderStage(renderer));
    expect(ladderStage(renderer)).toBe('failed');
    expect(findWebView(renderer)).toBeNull();
    expect(allText(renderer)).toBe(failedTextAfter429);

    // Exactly one transition happened: watch → failed.
    expect(transitions).toEqual(['watch', 'failed', 'failed']);
    expect(onClose).not.toHaveBeenCalled();

    // The escape hatch and retry are intact after the noise.
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await pressByLabel(renderer, 'Open on YouTube');
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    await pressByLabel(renderer, 'Try loading the video again');
    expect(ladderStage(renderer)).toBe('embed');
    act(() => renderer.unmount());
  });

  it('subresource 404 BEFORE the main-document 429 is ignored; the 429 still fails the ladder', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const onHttpError = await enterWatchStage(renderer);
    await deliverHttpError(
      onHttpError,
      'https://i.ytimg.com/vi/dnk101xyz/hqdefault.jpg',
      404,
    );
    expect(ladderStage(renderer)).toBe('watch');
    // The live handler after the (no-op) event still fails on the document.
    const liveHandler = findWebView(renderer)!.props
      .onHttpError as HttpErrorHandler;
    await deliverHttpError(liveHandler, youtubeMedia.sourceUrl, 429);
    expect(ladderStage(renderer)).toBe('failed');
    act(() => renderer.unmount());
  });

  it('rapid repeats: five main-document errors with mixed status codes fail the ladder once and never past failed', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const onHttpError = await enterWatchStage(renderer);
    const observed: string[] = [];
    for (const status of [429, 500, 403, 404, 429]) {
      await deliverHttpError(onHttpError, youtubeMedia.sourceUrl, status);
      observed.push(ladderStage(renderer));
    }
    expect(observed).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
    // Still exactly one error card / one retry affordance.
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.accessibilityLabel === 'Try loading the video again',
      ).length,
    ).toBe(1);
    act(() => renderer.unmount());
  });

  it('same-tick burst (429 main + 404 subresource + 429 main) collapses to a single failed state', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const onHttpError = await enterWatchStage(renderer);
    await act(async () => {
      onHttpError({
        nativeEvent: { url: youtubeMedia.sourceUrl, statusCode: 429 },
      });
      onHttpError({
        nativeEvent: {
          url: 'https://www.youtube.com/youtubei/v1/player',
          statusCode: 404,
        },
      });
      onHttpError({
        nativeEvent: { url: youtubeMedia.sourceUrl, statusCode: 429 },
      });
    });
    expect(ladderStage(renderer)).toBe('failed');
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.accessibilityLabel === 'Try loading the video again',
      ).length,
    ).toBe(1);
    act(() => renderer.unmount());
  });

  it('events with no url, an empty url, or a non-http url never move the ladder', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const onHttpError = await enterWatchStage(renderer);
    await act(async () => {
      onHttpError({ nativeEvent: { statusCode: 429 } });
      onHttpError({ nativeEvent: { url: '', statusCode: 429 } });
      onHttpError({ nativeEvent: { url: 'about:blank', statusCode: 429 } });
      onHttpError({
        nativeEvent: {
          url: 'https://www.youtube.com/WATCH?v=dnk101xyz',
          statusCode: 429,
        },
      });
    });
    expect(ladderStage(renderer)).toBe('watch');
    act(() => renderer.unmount());
  });

  it('a stale watch-stage handler firing after Retry cannot double-advance the fresh embed', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const staleHandler = await enterWatchStage(renderer);
    await deliverHttpError(staleHandler, youtubeMedia.sourceUrl, 429);
    expect(ladderStage(renderer)).toBe('failed');
    await pressByLabel(renderer, 'Try loading the video again');
    expect(ladderStage(renderer)).toBe('embed');
    // Late 404 for a watch-page subresource from the torn-down WebView.
    await deliverHttpError(
      staleHandler,
      'https://www.youtube.com/api/stats/atr?docid=dnk101xyz',
      404,
    );
    expect(ladderStage(renderer)).toBe('embed');
    act(() => renderer.unmount());
  });

  it('hosted media: main-document 429 fails once, later subresource 404 inert', async () => {
    const renderer = renderPlayer(hostedMedia);
    const webView = findWebView(renderer);
    expect(webView?.props.source).toEqual({ uri: hostedMedia.playbackUrl });
    const onHttpError = webView!.props.onHttpError as HttpErrorHandler;
    await deliverHttpError(onHttpError, hostedMedia.playbackUrl, 429);
    expect(allText(renderer)).toContain(FAILED_COPY);
    expect(findWebView(renderer)).toBeNull();
    const snapshot = allText(renderer);
    await deliverHttpError(
      onHttpError,
      'https://cdn.example.com/drills/poster.jpg',
      404,
    );
    expect(allText(renderer)).toBe(snapshot);
    expect(findWebView(renderer)).toBeNull();
    act(() => renderer.unmount());
  });
});
