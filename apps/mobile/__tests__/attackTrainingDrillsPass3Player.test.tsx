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

/**
 * Every COMMITTED WebView mount is recorded with the source it was created
 * with. A stage change re-keys the WebView, so this log is exactly the list
 * of native web views the device would have created, in order.
 */
const mockMountedSources: unknown[] = [];
jest.mock('react-native-webview', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  class MockWebView extends ReactModule.Component<Record<string, unknown>> {
    componentDidMount() {
      mockMountedSources.push(this.props.source);
    }
    render() {
      return ReactModule.createElement(View, this.props);
    }
  }
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  DrillVideoPlayer,
  VIDEO_EMBED_REFERER,
  shouldLoadInPlayer,
} from '../src/components/DrillVideoPlayer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — `DrillVideoPlayer` (drill media
 * consumption). Scenario #6 (navigation gate for a hostile hosted payload)
 * and #8 (switching `media` straight from a failed YouTube video to a Vimeo
 * video without closing the player). `RECORD:` tests pin observed behaviour
 * at 4d812e1a without endorsing it.
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

const hostileHosted: InstructionalMedia = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  kind: 'hosted',
  playbackUrl: 'https://',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sourceUrl: 'https://evil.example/x',
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

function has(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
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

async function failWebView(renderer: TestRenderer.ReactTestRenderer) {
  const webView = findWebView(renderer);
  await act(async () => {
    webView?.props.onError({ nativeEvent: {} });
  });
}

describe('scenario 6 — navigation gate with a hostile hosted payload', () => {
  const gate = (url: string, isTopFrame = true) =>
    shouldLoadInPlayer(hostileHosted, { url, isTopFrame });

  it("RECORD: sourceUrl 'https://evil.example/x' makes evil.example an allowed TOP-FRAME host", () => {
    expect(gate('https://evil.example/x')).toBe(true);
    expect(gate('https://evil.example/anything/else')).toBe(true);
    expect(gate('https://login.evil.example/phish')).toBe(true);
  });

  it("the scheme-only playbackUrl 'https://' contributes no host and the top frame cannot load it", () => {
    expect(gate('https://')).toBe(false);
    expect(gate('https:///path')).toBe(false);
  });

  it('unrelated https hosts, http:// and javascript: are still refused for the top frame', () => {
    expect(gate('https://attacker.example/')).toBe(false);
    expect(gate('https://evil.example.attacker.example/')).toBe(false);
    expect(gate('https://notevil.example/')).toBe(false);
    expect(gate('http://evil.example/x')).toBe(false);
    expect(gate('javascript:alert(1)')).toBe(false);
    expect(gate('data:text/html,hi')).toBe(false);
  });

  it('RECORD: the player renders this payload and dead-ends on its own error card (no crash)', async () => {
    const renderer = renderPlayer(hostileHosted);
    expect(findWebView(renderer)?.props.source).toEqual({ uri: 'https://' });
    await failWebView(renderer);
    expect(has(renderer, 'drill-video-error')).toBe(true);
    expect(allText(renderer)).toContain('Open on the original source');
    act(() => renderer.unmount());
  });

  it('RECORD: gate host parsing differs from WHATWG for a backslash before "@" (Linux-only observation)', () => {
    // A WHATWG parser reads the host of `https://evil.example\@www.youtube.com/`
    // as evil.example (the backslash ends the authority); the gate reads
    // www.youtube.com. Whether WKWebView ever hands such a raw string to the
    // gate is UNKNOWN from Linux — recorded, not claimed.
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example\\@www.youtube.com/',
        isTopFrame: true,
      }),
    ).toBe(true);
    // The normalised form is refused as expected.
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example/@www.youtube.com/',
        isTopFrame: true,
      }),
    ).toBe(false);
  });
});

describe('scenario 8 — failed YouTube → Vimeo without closing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onClose.mockClear();
    mockMountedSources.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function driveYoutubeToFailed(
    renderer: TestRenderer.ReactTestRenderer,
  ) {
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 153 }));
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    await failWebView(renderer);
    expect(has(renderer, 'drill-video-error')).toBe(true);
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
  }

  it('resets to the Vimeo embed with the app referer and no stale failure copy', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await driveYoutubeToFailed(renderer);

    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });

    const source = findWebView(renderer)?.props.source;
    expect(source).toEqual({
      uri: `${vimeoMedia.embedUrl}?playsinline=1`,
      headers: { Referer: VIDEO_EMBED_REFERER },
    });
    expect(has(renderer, 'drill-video-error')).toBe(false);
    const copy = allText(renderer);
    expect(copy).not.toContain('This video could not load in the app.');
    expect(copy).not.toContain('Open on YouTube');
    expect(copy).toContain(vimeoMedia.attribution);
    // Vimeo has no ready handshake, so no YouTube-only loading overlay.
    expect(has(renderer, 'drill-video-embed-loading')).toBe(false);
    act(() => renderer.unmount());
  });

  it('the new Vimeo video still walks its own ladder (embed → watch → failed) from the top', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await driveYoutubeToFailed(renderer);
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });
    await failWebView(renderer);
    expect(findWebView(renderer)?.props.source).toEqual({
      uri: vimeoMedia.sourceUrl,
      headers: { Referer: VIDEO_EMBED_REFERER },
    });
    await failWebView(renderer);
    expect(has(renderer, 'drill-video-error')).toBe(true);
    expect(allText(renderer)).toContain('Open on Vimeo');
    act(() => renderer.unmount());
  });

  it('RECORD: which WebViews were COMMITTED across the switch (transient stale-stage mount check)', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await driveYoutubeToFailed(renderer);
    const before = mockMountedSources.length;
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });
    const afterSwitch = mockMountedSources.slice(before);
    // Documented outcome: exactly one Vimeo WebView is committed, and it is
    // the embed. If a `${vimeo.id}:failed` frame or a Vimeo watch-page
    // WebView had been committed first, it would appear here.
    expect(afterSwitch).toEqual([
      {
        uri: `${vimeoMedia.embedUrl}?playsinline=1`,
        headers: { Referer: VIDEO_EMBED_REFERER },
      },
    ]);
    act(() => renderer.unmount());
  });

  it('switching from YouTube in the WATCH stage ends on the Vimeo embed', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 101 }));
    expect(findWebView(renderer)?.props.source.uri).toBe(
      youtubeMedia.sourceUrl,
    );
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(
      `${vimeoMedia.embedUrl}?playsinline=1`,
    );
    act(() => renderer.unmount());
  });

  // BROKEN at 4d812e1a: the stage reset runs in a passive effect AFTER the
  // first commit of the new media, so a WebView keyed `${vimeo.id}:watch`
  // pointing at vimeo.com/<id> (the new video's WATCH PAGE, with the app
  // referer) is committed and then torn down one commit later. `.failing`
  // pins the expectation; when the reset moves ahead of the commit this
  // test starts passing and the marker must be removed.
  it.failing(
    'BROKEN: no Vimeo watch-page WebView is committed while switching away from a WATCH-stage YouTube video',
    async () => {
      const renderer = renderPlayer(youtubeMedia);
      await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 101 }));
      const before = mockMountedSources.length;
      act(() => {
        renderer.update(
          <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
        );
      });
      expect(mockMountedSources.slice(before)).toEqual([
        {
          uri: `${vimeoMedia.embedUrl}?playsinline=1`,
          headers: { Referer: VIDEO_EMBED_REFERER },
        },
      ]);
      act(() => renderer.unmount());
    },
  );

  it('RECORD: the transient WATCH-stage mount targets the NEW video’s watch page with the app referer', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 101 }));
    const before = mockMountedSources.length;
    act(() => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={onClose} />,
      );
    });
    expect(mockMountedSources.slice(before)).toEqual([
      { uri: vimeoMedia.sourceUrl, headers: { Referer: VIDEO_EMBED_REFERER } },
      {
        uri: `${vimeoMedia.embedUrl}?playsinline=1`,
        headers: { Referer: VIDEO_EMBED_REFERER },
      },
    ]);
    act(() => renderer.unmount());
  });

  it('rapid A→B→A→B switching (seeded order) never leaves a stale stage or copy', async () => {
    // Deterministic pseudo-random interleaving; seed recorded for replay.
    const seed = 0x5eed_0004;
    let state = seed;
    const rnd = () => {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      return state / 0x1_0000_0000;
    };
    const renderer = renderPlayer(youtubeMedia);
    let current: InstructionalMedia = youtubeMedia;
    for (let i = 0; i < 24; i += 1) {
      const roll = rnd();
      if (roll < 0.34) {
        await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 2 }));
      } else if (roll < 0.67) {
        await failWebView(renderer);
      }
      current = current === youtubeMedia ? vimeoMedia : youtubeMedia;
      act(() => {
        renderer.update(<DrillVideoPlayer media={current} onClose={onClose} />);
      });
      const source = findWebView(renderer)?.props.source;
      expect(has(renderer, 'drill-video-error')).toBe(false);
      if (current === youtubeMedia) {
        expect(source.baseUrl).toBe(VIDEO_EMBED_REFERER);
        expect(source.html).toContain(`"${youtubeMedia.videoId}"`);
      } else {
        expect(source).toEqual({
          uri: `${vimeoMedia.embedUrl}?playsinline=1`,
          headers: { Referer: VIDEO_EMBED_REFERER },
        });
      }
    }
    act(() => renderer.unmount());
  });

  it('the same media object with a NEW id resets; the same id with a new videoId does not', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await driveYoutubeToFailed(renderer);
    // Same id, different video: the ladder position is (by design) keyed on
    // media.id, so the failure card persists. Recorded as observed.
    act(() => {
      renderer.update(
        <DrillVideoPlayer
          media={{ ...youtubeMedia, videoId: 'other000' }}
          onClose={onClose}
        />,
      );
    });
    expect(has(renderer, 'drill-video-error')).toBe(true);
    act(() => renderer.unmount());
  });
});
