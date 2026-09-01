import React from 'react';
import { Linking, Text } from 'react-native';
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

// Passthrough View keeps every WebView prop (source, onMessage, onError,
// onHttpError) inspectable and callable from the tree.
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  DrillVideoPlayer,
  EMBED_READY_TIMEOUT_MS,
  VIDEO_EMBED_REFERER,
} from '../src/components/DrillVideoPlayer';

/**
 * Pins the playback guarantee: YouTube embeds are NEVER loaded as bare
 * /embed/ URLs (YouTube refuses those without an embedding referer — error
 * 153, "Video player configuration error"). Playback runs through a local
 * IFrame API shell identified by the app's https referer, and every failure
 * falls forward automatically — player error or silent wedge → the video's
 * canonical watch page in-app → explicit error card with retry and an
 * external escape hatch. A video row can therefore never dead-end.
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

const vimeoMedia: InstructionalMedia = {
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  kind: 'embed',
  provider: 'vimeo',
  videoId: '76543210',
  embedUrl: 'https://player.vimeo.com/video/76543210',
  sourceUrl: 'https://vimeo.com/76543210',
  creatorName: 'Kitchen Lab Pickleball',
  licenseName: 'Vimeo Terms of Service',
  licenseUrl: null,
  attribution: 'Video by Kitchen Lab Pickleball on Vimeo',
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

function hasEmbedLoadingOverlay(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(n => n.props.testID === 'drill-video-embed-loading')
      .length > 0
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
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

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('DrillVideoPlayer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onClose.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('plays YouTube through the referer-identified IFrame shell, never a bare /embed/ URL', () => {
    const renderer = renderPlayer(youtubeMedia);
    const source = findWebView(renderer)?.props.source;
    expect(source.uri).toBeUndefined();
    expect(source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    expect(source.html).toContain('"dnk101xyz"');
    expect(source.html).toContain('https://www.youtube-nocookie.com');
    expect(source.html).toContain('https://www.youtube.com/iframe_api');
    // A spinner covers the shell until the player reports ready.
    expect(hasEmbedLoadingOverlay(renderer)).toBe(true);
    act(() => renderer.unmount());
  });

  it('a ready signal clears the loading overlay and defuses the watchdog', async () => {
    const renderer = renderPlayer(youtubeMedia);
    // Malformed messages are ignored rather than crashing playback.
    await sendMessage(renderer, 'not json');
    await sendMessage(renderer, JSON.stringify({ kind: 'ready' }));
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);
    await elapse(EMBED_READY_TIMEOUT_MS + 1000);
    // Still on the embed shell: no watch-page takeover after ready.
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    act(() => renderer.unmount());
  });

  it('falls forward to the canonical watch page on any player error', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 153 }));
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: 'https://www.youtube.com/watch?v=dnk101xyz',
      headers: { Referer: VIDEO_EMBED_REFERER },
    });
    act(() => renderer.unmount());
  });

  it('falls forward to the watch page when the player stays silent too long', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      'https://www.youtube.com/watch?v=dnk101xyz',
    );
    act(() => renderer.unmount());
  });

  it('only a watch-page load failure reaches the error card, and retry restarts the ladder', async () => {
    const openUrl = jest.spyOn(Linking, 'openURL');
    openUrl.mockClear();
    openUrl.mockResolvedValue(undefined);
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 150 }));
    const watchView = findWebView(renderer);
    expect(watchView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
    await act(async () => {
      watchView?.props.onError();
    });
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
    // The external escape hatch always remains.
    await pressByLabel(renderer, 'Open on YouTube');
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    // Retry starts over at the embed shell.
    await pressByLabel(renderer, 'Try loading the video again');
    expect(findWebView(renderer)?.props.source.html).toContain('"dnk101xyz"');
    act(() => renderer.unmount());
  });

  it('escalates main-document HTTP failures but ignores subresource noise', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 101 }));
    const watchView = findWebView(renderer);
    expect(watchView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
    // A failing ad/analytics call on the watch page must not kill playback.
    await act(async () => {
      watchView?.props.onHttpError({
        nativeEvent: { url: 'https://ads.example.com/blocked' },
      });
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    // The watch document itself failing does.
    await act(async () => {
      findWebView(renderer)?.props.onHttpError({
        nativeEvent: { url: youtubeMedia.sourceUrl },
      });
    });
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
    act(() => renderer.unmount());
  });

  it('identifies the app on Vimeo embeds and falls forward on failure', async () => {
    const renderer = renderPlayer(vimeoMedia);
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: 'https://player.vimeo.com/video/76543210?playsinline=1',
      headers: { Referer: VIDEO_EMBED_REFERER },
    });
    await act(async () => {
      findWebView(renderer)?.props.onError();
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(vimeoMedia.sourceUrl);
    act(() => renderer.unmount());
  });

  it('plays hosted media from its signed URL and fails straight to the error card', async () => {
    const renderer = renderPlayer(hostedMedia);
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: hostedMedia.playbackUrl,
    });
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);
    await act(async () => {
      findWebView(renderer)?.props.onError();
    });
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
    expect(allText(renderer)).toContain('Open on the original source');
    act(() => renderer.unmount());
  });

  it('a newly opened video never inherits the previous ladder position', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 153 }));
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => {
      renderer.update(
        <DrillVideoPlayer
          media={{ ...youtubeMedia, id: 'other', videoId: 'dnk202abc' }}
          onClose={onClose}
        />,
      );
    });
    expect(findWebView(renderer)?.props.source.html).toContain('"dnk202abc"');
    act(() => renderer.unmount());
  });
});
