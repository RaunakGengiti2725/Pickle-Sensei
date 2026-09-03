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

import {
  DrillVideoPlayer,
  shouldLoadInPlayer,
  VIDEO_EMBED_REFERER,
} from '../../src/components/DrillVideoPlayer';

/**
 * Pins the two escape-hatch guarantees of the in-app player:
 *
 *  1. "Watch on …" / "Open on …" never fail silently — a refused
 *     Linking.openURL surfaces copy on the card, and the player stays usable.
 *  2. The WebView's top frame is confined to the app's shell and the video's
 *     provider; third-party links, store nudges and non-https deep links are
 *     dropped instead of navigating the player or being handed to the OS.
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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function sourceErrorNode(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-source-error',
  );
  return node ?? null;
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

async function failToErrorCard(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    findWebView(renderer)?.props.onMessage({
      nativeEvent: { data: JSON.stringify({ kind: 'error', code: 150 }) },
    });
  });
  await act(async () => {
    findWebView(renderer)?.props.onError();
  });
  expect(allText(renderer)).toContain('This video could not load in the app.');
}

describe('DrillVideoPlayer external hand-off', () => {
  beforeEach(() => {
    onClose.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('"Watch on YouTube" surfaces copy when the OS refuses the URL and keeps the player usable', async () => {
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('no handler'));
    const renderer = renderPlayer(youtubeMedia);
    expect(sourceErrorNode(renderer)).toBeNull();

    await pressByLabel(renderer, 'Watch on YouTube');
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    const error = sourceErrorNode(renderer);
    expect(error?.props.accessibilityRole).toBe('alert');
    expect(allText(renderer)).toContain(
      'YouTube could not be opened on this device.',
    );
    // The in-app player is untouched by the failed hand-off.
    expect(findWebView(renderer)?.props.source.html).toContain('"dnk101xyz"');
    // The link stays live: a later successful open clears the copy.
    openUrl.mockResolvedValue(undefined);
    await pressByLabel(renderer, 'Watch on YouTube');
    expect(sourceErrorNode(renderer)).toBeNull();
    act(() => renderer.unmount());
  });

  it('the error card\'s "Open on …" reports a refused hand-off instead of doing nothing', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('refused'));
    const renderer = renderPlayer(youtubeMedia);
    await failToErrorCard(renderer);

    await pressByLabel(renderer, 'Open on YouTube');
    expect(allText(renderer)).toContain(
      'YouTube could not be opened on this device.',
    );
    // Retry remains available after the failed hand-off.
    await pressByLabel(renderer, 'Try loading the video again');
    expect(findWebView(renderer)?.props.source.html).toContain('"dnk101xyz"');
    act(() => renderer.unmount());
  });

  it('names the actual provider in the failure copy', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('refused'));
    const renderer = renderPlayer(vimeoMedia);
    await pressByLabel(renderer, 'Watch on Vimeo');
    expect(allText(renderer)).toContain(
      'Vimeo could not be opened on this device.',
    );
    act(() => renderer.unmount());
  });

  it('a successful open renders no failure copy', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const renderer = renderPlayer(youtubeMedia);
    await pressByLabel(renderer, 'Watch on YouTube');
    expect(sourceErrorNode(renderer)).toBeNull();
    act(() => renderer.unmount());
  });

  it('a newly opened video does not inherit the previous failure copy', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('refused'));
    const renderer = renderPlayer(youtubeMedia);
    await pressByLabel(renderer, 'Watch on YouTube');
    expect(sourceErrorNode(renderer)).not.toBeNull();
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });
    expect(sourceErrorNode(renderer)).toBeNull();
    act(() => renderer.unmount());
  });
});

describe('DrillVideoPlayer WebView navigation gate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('wires the gate on the WebView and takes over the whitelist so nothing is handed to the OS implicitly', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const embedView = findWebView(renderer);
    expect(embedView?.props.originWhitelist).toEqual(['*']);
    expect(embedView?.props.setSupportMultipleWindows).toBe(false);
    expect(typeof embedView?.props.onShouldStartLoadWithRequest).toBe(
      'function',
    );
    await act(async () => {
      embedView?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 153 }) },
      });
    });
    const watchView = findWebView(renderer);
    expect(watchView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
    const gate = watchView?.props.onShouldStartLoadWithRequest as (request: {
      url: string;
      isTopFrame?: boolean;
    }) => boolean;
    expect(gate({ url: youtubeMedia.sourceUrl, isTopFrame: true })).toBe(true);
    expect(gate({ url: 'https://evil.example/phish', isTopFrame: true })).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('allows the shell, the provider and its mobile/consent hosts in the top frame', () => {
    const allowed = [
      VIDEO_EMBED_REFERER,
      youtubeMedia.sourceUrl,
      youtubeMedia.embedUrl,
      'https://m.youtube.com/watch?v=dnk101xyz',
      'https://consent.youtube.com/m?continue=x',
      'https://www.youtube-nocookie.com/embed/dnk101xyz',
      'https://rr1---sn-abc.googlevideo.com/videoplayback?x=1',
      'https://WWW.YOUTUBE.COM:443/watch?v=dnk101xyz',
      'about:blank',
    ];
    for (const url of allowed) {
      expect(shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: true })).toBe(
        true,
      );
    }
  });

  it('drops third-party top-frame navigations, store nudges and non-https deep links', () => {
    const blocked = [
      'https://example.com/anything',
      'https://accounts.google.com/ServiceLogin',
      'https://notyoutube.com/watch?v=dnk101xyz',
      'https://youtube.com.evil.example/watch',
      'https://www.youtube.com@evil.example/watch',
      'https://evil.example/?next=https://www.youtube.com/',
      'http://www.youtube.com/watch?v=dnk101xyz',
      'vnd.youtube://dnk101xyz',
      'itms-apps://apps.apple.com/app/id544007664',
      'intent://watch?v=dnk101xyz#Intent;package=com.google.android.youtube;end',
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
    ];
    for (const url of blocked) {
      expect(shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: true })).toBe(
        false,
      );
    }
  });

  it('never hands non-https schemes to the OS, even from a sub-frame', () => {
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'vnd.youtube://dnk101xyz',
        isTopFrame: false,
      }),
    ).toBe(false);
    // Player sub-frames themselves belong to the provider and load.
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://www.google.com/recaptcha/api2/anchor',
        isTopFrame: false,
      }),
    ).toBe(true);
  });

  it('applies the host rule when the platform reports no frame info (Android)', () => {
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://www.youtube.com/watch?v=other',
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtubeMedia, { url: 'https://example.com/' }),
    ).toBe(false);
  });

  it('scopes the allowed hosts to the video at hand', () => {
    expect(
      shouldLoadInPlayer(vimeoMedia, {
        url: 'https://player.vimeo.com/video/76543210',
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(vimeoMedia, {
        url: 'https://www.youtube.com/watch?v=dnk101xyz',
        isTopFrame: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(hostedMedia, {
        url: hostedMedia.playbackUrl,
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(hostedMedia, {
        url: 'https://example.com/drills/dink',
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(hostedMedia, {
        url: 'https://vimeo.com/76543210',
        isTopFrame: true,
      }),
    ).toBe(false);
  });
});
