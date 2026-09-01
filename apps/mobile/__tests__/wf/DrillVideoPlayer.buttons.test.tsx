import React from 'react';
import { Linking, Modal, StyleSheet, Text } from 'react-native';
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
} from '../../src/components/DrillVideoPlayer';

/**
 * Button ledger for DrillVideoPlayer: every interactive element in the
 * component is pressed here and its real observable effect asserted.
 *
 *   Dismiss video (backdrop)        -> onClose
 *   drill-video-close               -> onClose
 *   Modal onRequestClose (back)     -> onClose
 *   drill-video-source-link         -> Linking.openURL(media.sourceUrl)
 *   drill-video-open-source (error) -> Linking.openURL(media.sourceUrl)
 *   drill-video-retry (error)       -> restart the ladder at the embed shell
 *   WebView onMessage/onError/onHttpError -> fallback ladder
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
  expiresAt: '2030-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei Coaching',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const onClose = jest.fn();
let openUrl: jest.SpyInstance;

function renderPlayer(media: InstructionalMedia | null) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DrillVideoPlayer media={media} onClose={onClose} />,
    );
  });
  return renderer;
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      typeof n.props.accessibilityRole === 'string',
  );
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  match: { testID?: string; label?: string },
) {
  const [node] = pressables(renderer).filter(n =>
    match.testID
      ? n.props.testID === match.testID
      : n.props.accessibilityLabel === match.label,
  );
  if (!node) throw new Error(`No pressable ${JSON.stringify(match)}`);
  return node;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

function findWebView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-webview' && n.props.source,
  );
  return node ?? null;
}

function hasErrorCard(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(n => n.props.testID === 'drill-video-error').length >
    0
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

/** Resolved style of a pressable node (PressableScale passes a function). */
function pressableStyle(node: TestRenderer.ReactTestInstance) {
  const raw = node.props.style;
  return StyleSheet.flatten(
    typeof raw === 'function' ? raw({ pressed: false }) : raw,
  ) as Record<string, unknown>;
}

async function reachErrorCard(renderer: TestRenderer.ReactTestRenderer) {
  // hosted media: a main-document failure goes straight to the error card.
  await act(async () => {
    findWebView(renderer)?.props.onError();
  });
  expect(hasErrorCard(renderer)).toBe(true);
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('DrillVideoPlayer buttons', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onClose.mockClear();
    // The RN jest preset already stubs Linking.openURL with a shared jest.fn,
    // so restoreAllMocks does not clear its call history between tests.
    openUrl = jest.spyOn(Linking, 'openURL');
    openUrl.mockReset();
    openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing (and no pressables) without media', () => {
    const renderer = renderPlayer(null);
    expect(renderer.toJSON()).toBeNull();
    expect(pressables(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('exposes exactly the playing-stage controls, each with a role and label', () => {
    const renderer = renderPlayer(youtubeMedia);
    const nodes = pressables(renderer);
    expect(
      nodes.map(n => n.props.testID ?? n.props.accessibilityLabel).sort(),
    ).toEqual(
      ['Dismiss video', 'drill-video-close', 'drill-video-source-link'].sort(),
    );
    for (const node of nodes) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(typeof node.props.accessibilityLabel).toBe('string');
      expect(node.props.accessibilityLabel.length).toBeGreaterThan(0);
    }
    act(() => renderer.unmount());
  });

  it('backdrop "Dismiss video" -> onClose', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const backdrop = findPressable(renderer, { label: 'Dismiss video' });
    expect(backdrop.props.style).toEqual(StyleSheet.absoluteFill);
    await press(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('drill-video-close -> onClose, 44pt target plus hitSlop', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const close = findPressable(renderer, { testID: 'drill-video-close' });
    expect(close.props.accessibilityLabel).toBe('Close video player');
    expect(close.props.hitSlop).toBe(8);
    expect(close.props.disabled).toBeFalsy();
    const style = pressableStyle(close);
    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
    await press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A second tap is harmless: the parent owns the visibility state.
    await press(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('hardware back (Modal onRequestClose) -> onClose', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const modal = renderer.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('drill-video-source-link -> Linking.openURL(sourceUrl) for every media kind', async () => {
    for (const media of [youtubeMedia, vimeoMedia, hostedMedia]) {
      openUrl.mockClear();
      const renderer = renderPlayer(media);
      const link = findPressable(renderer, {
        testID: 'drill-video-source-link',
      });
      const host =
        media.kind === 'hosted'
          ? 'the original source'
          : media.provider === 'youtube'
            ? 'YouTube'
            : 'Vimeo';
      expect(link.props.accessibilityLabel).toBe(`Watch on ${host}`);
      expect(allText(renderer)).toContain(`Watch on ${host}`);
      expect(pressableStyle(link).minHeight).toBeGreaterThanOrEqual(44);
      await press(link);
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(media.sourceUrl);
      // The link never opens the bare embed URL (YouTube error 153).
      expect(openUrl).not.toHaveBeenCalledWith(
        expect.stringContaining('/embed/'),
      );
      act(() => renderer.unmount());
    }
  });

  it('source link failure: the player stays usable', async () => {
    const rejected = Promise.reject(new Error('No handler for URL'));
    rejected.catch(() => undefined);
    openUrl.mockReturnValue(rejected);
    const renderer = renderPlayer(youtubeMedia);
    const link = findPressable(renderer, { testID: 'drill-video-source-link' });
    await press(link);
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    // WF-ISSUE: openSource swallows the Linking.openURL rejection — no user-visible error copy
    // Still rendered and still closable after the failure.
    expect(findWebView(renderer)).not.toBeNull();
    await press(findPressable(renderer, { testID: 'drill-video-close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('error card: drill-video-open-source -> Linking.openURL(sourceUrl)', async () => {
    const renderer = renderPlayer(hostedMedia);
    expect(() =>
      findPressable(renderer, { testID: 'drill-video-open-source' }),
    ).toThrow();
    await reachErrorCard(renderer);
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
    const open = findPressable(renderer, {
      testID: 'drill-video-open-source',
    });
    expect(open.props.accessibilityRole).toBe('button');
    expect(open.props.accessibilityLabel).toBe('Open on the original source');
    expect(pressableStyle(open).minHeight).toBeGreaterThanOrEqual(44);
    await press(open);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(hostedMedia.sourceUrl);
    act(() => renderer.unmount());
  });

  it('error card: open-source failure leaves the card and its controls in place', async () => {
    const rejected = Promise.reject(new Error('No handler for URL'));
    rejected.catch(() => undefined);
    openUrl.mockReturnValue(rejected);
    const renderer = renderPlayer(hostedMedia);
    await reachErrorCard(renderer);
    await press(findPressable(renderer, { testID: 'drill-video-open-source' }));
    expect(openUrl).toHaveBeenCalledWith(hostedMedia.sourceUrl);
    // WF-ISSUE: openSource swallows the Linking.openURL rejection — no user-visible error copy
    expect(hasErrorCard(renderer)).toBe(true);
    expect(
      findPressable(renderer, { testID: 'drill-video-retry' }).props.disabled,
    ).toBeFalsy();
    act(() => renderer.unmount());
  });

  it('error card: drill-video-retry -> restarts the ladder at the embed shell', async () => {
    const renderer = renderPlayer(youtubeMedia);
    // embed -> watch (player error) -> failed (watch document failure)
    await act(async () => {
      findWebView(renderer)?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 150 }) },
      });
    });
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: youtubeMedia.sourceUrl,
      headers: { Referer: VIDEO_EMBED_REFERER },
    });
    await act(async () => {
      findWebView(renderer)?.props.onError();
    });
    expect(hasErrorCard(renderer)).toBe(true);
    expect(findWebView(renderer)).toBeNull();
    const retry = findPressable(renderer, { testID: 'drill-video-retry' });
    expect(retry.props.accessibilityLabel).toBe('Try loading the video again');
    expect(allText(renderer)).toContain('Try again');
    expect(pressableStyle(retry).minHeight).toBeGreaterThanOrEqual(44);
    await press(retry);
    expect(hasErrorCard(renderer)).toBe(false);
    const source = findWebView(renderer)?.props.source;
    expect(source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    expect(source.html).toContain('"dnk101xyz"');
    // The spinner and watchdog are re-armed after retry.
    expect(
      renderer.root.findAll(n => n.props.testID === 'drill-video-embed-loading')
        .length,
    ).toBeGreaterThan(0);
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => renderer.unmount());
  });

  it('error card: retry on hosted media reloads the signed URL and can fail again honestly', async () => {
    const renderer = renderPlayer(hostedMedia);
    await reachErrorCard(renderer);
    await press(findPressable(renderer, { testID: 'drill-video-retry' }));
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: hostedMedia.playbackUrl,
    });
    await reachErrorCard(renderer);
    // Every error-card control is present again after the second failure.
    expect(
      pressables(renderer)
        .map(n => n.props.testID ?? n.props.accessibilityLabel)
        .sort(),
    ).toEqual(
      [
        'Dismiss video',
        'drill-video-close',
        'drill-video-open-source',
        'drill-video-retry',
        'drill-video-source-link',
      ].sort(),
    );
    act(() => renderer.unmount());
  });

  it('WebView handlers: ready clears the spinner, malformed messages are ignored, http errors only count for the main document', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const webView = findWebView(renderer);
    expect(typeof webView?.props.onMessage).toBe('function');
    expect(typeof webView?.props.onError).toBe('function');
    expect(typeof webView?.props.onHttpError).toBe('function');
    await act(async () => {
      webView?.props.onMessage({ nativeEvent: { data: '{not json' } });
    });
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    await act(async () => {
      webView?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
      });
    });
    expect(
      renderer.root.findAll(n => n.props.testID === 'drill-video-embed-loading')
        .length,
    ).toBe(0);
    // Subresource failures never move the ladder.
    await act(async () => {
      findWebView(renderer)?.props.onHttpError({
        nativeEvent: { url: 'https://ads.example.com/blocked' },
      });
    });
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    // The embed document itself failing falls forward to the watch page.
    await act(async () => {
      findWebView(renderer)?.props.onHttpError({
        nativeEvent: { url: `${youtubeMedia.embedUrl}?foo=1` },
      });
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => renderer.unmount());
  });
});
