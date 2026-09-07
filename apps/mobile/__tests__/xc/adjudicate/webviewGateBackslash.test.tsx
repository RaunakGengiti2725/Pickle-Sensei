/**
 * xc-journeys / XC-P2-WEBVIEW-GATE-BACKSLASH-AUTHORITY
 *
 * The DrillVideoPlayer top-frame gate must read the host of a request the
 * way the browser does. WHATWG URL parsing (the grammar WebKit follows for
 * special schemes) terminates the authority at `/`, `?`, `#` AND `\`, so
 * `https://evil.example\@www.youtube.com/` is host `evil.example` to the
 * browser. A gate that reads the authority up to the first `/` only sees
 * `www.youtube.com` and admits a top-frame navigation the allowlist was
 * supposed to refuse.
 *
 * Oracle: Node's `URL` (WHATWG). Every backslash-authority payload must be
 * refused when the oracle host is foreign and admitted when it is the
 * provider's, and every authority the oracle cannot parse must fail closed.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  shouldLoadInPlayer,
  VIDEO_EMBED_REFERER,
} from '../../../src/components/DrillVideoPlayer';
import type { InstructionalMedia } from '../../../src/training/types';

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
  ...youtubeMedia,
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  provider: 'vimeo',
  videoId: '76543210',
  embedUrl: 'https://player.vimeo.com/video/76543210',
  sourceUrl: 'https://vimeo.com/76543210',
};

const hostedMedia: InstructionalMedia = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4',
  expiresAt: '2999-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Pickle Sensei',
  licenseName: 'Licensed',
  licenseUrl: null,
  attribution: 'Pickle Sensei',
};

const topFrame = (media: InstructionalMedia, url: string) =>
  shouldLoadInPlayer(media, { url, isTopFrame: true });

describe('xc-journeys: WebView gate reads the host like the browser (backslash authority)', () => {
  it('refuses the canonical repro: https://evil.example\\@www.youtube.com/', () => {
    const url = 'https://evil.example\\@www.youtube.com/';
    expect(new URL(url).hostname).toBe('evil.example');
    expect(topFrame(youtubeMedia, url)).toBe(false);
  });

  it('refuses every backslash-authority payload whose browser host is foreign', () => {
    const payloads = [
      'https://evil.example\\@www.youtube.com/',
      'https://evil.example\\www.youtube.com/',
      'https://evil.example\\\\@www.youtube.com/',
      'https://evil.example\\.youtube.com/',
      'https://evil.example:443\\@www.youtube.com/',
      'https://user:pass@evil.example\\@www.youtube.com/watch?v=dnk101xyz',
      'https://evil.example\\?@www.youtube.com/',
      'https://evil.example\\#@www.youtube.com/',
    ];
    for (const url of payloads) {
      const browserHost = new URL(url).hostname;
      expect({ url, browserHost }).toEqual({
        url,
        browserHost: expect.not.stringMatching(/(^|\.)youtube\.com$/),
      });
      for (const media of [youtubeMedia, vimeoMedia, hostedMedia]) {
        expect({
          url,
          media: media.id,
          admitted: topFrame(media, url),
        }).toEqual({ url, media: media.id, admitted: false });
      }
    }
  });

  it('agrees with the browser when a backslash merely starts the path of a provider host', () => {
    const payloads = [
      'https://www.youtube.com\\@evil.example/',
      'https://www.youtube.com\\.evil.example/',
      'https://www.youtube.com:443\\@evil.example/',
      'https://www.youtube.com\\evil.example/',
    ];
    for (const url of payloads) {
      expect(new URL(url).hostname).toBe('www.youtube.com');
      expect({ url, admitted: topFrame(youtubeMedia, url) }).toEqual({
        url,
        admitted: true,
      });
      expect(topFrame(vimeoMedia, url)).toBe(false);
    }
  });

  it('fails closed on authorities the browser cannot parse', () => {
    const unparseable = [
      'https://evil.example%2F%2Fwww.youtube.com/',
      'https://www.youtube.com:65536/',
      'https://www.youtube.com:99999999999/',
      'https://evil.example:443:www.youtube.com/',
      'https://www.youtube.com:abc/',
      'https://www.youtube.com:443:80/',
      'https://',
      'https://www.you tube.com/',
      'https://www.youtube.com%00.evil.example/',
    ];
    for (const url of unparseable) {
      let parses = true;
      try {
        new URL(url);
      } catch {
        parses = false;
      }
      // Each row is either unparseable or parses to a non-provider host; the
      // gate must refuse it either way.
      if (parses) {
        expect(new URL(url).hostname).not.toMatch(/(^|\.)youtube\.com$/);
      }
      for (const media of [youtubeMedia, vimeoMedia, hostedMedia]) {
        expect({
          url,
          media: media.id,
          admitted: topFrame(media, url),
        }).toEqual({ url, media: media.id, admitted: false });
      }
    }
  });

  it('refuses a sub-frame whose authority the browser cannot parse, and still loads provider sub-frames', () => {
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://www.youtube.com:65536/',
        isTopFrame: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://www.google.com/recaptcha/api2/anchor',
        isTopFrame: false,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example\\@www.youtube.com/',
        isTopFrame: false,
      }),
    ).toBe(true);
  });

  it('keeps admitting the legitimate provider top-frame shapes', () => {
    const allowed = [
      VIDEO_EMBED_REFERER,
      youtubeMedia.sourceUrl,
      youtubeMedia.embedUrl,
      'https://m.youtube.com/watch?v=dnk101xyz',
      'https://consent.youtube.com/m?continue=x',
      'https://rr1---sn-abc.googlevideo.com/videoplayback?x=1',
      'https://WWW.YOUTUBE.COM:443/watch?v=dnk101xyz',
      'https://user:pass@www.youtube.com/watch?v=dnk101xyz',
      'https://www.youtube.com:/watch',
      'https://www.youtube.com?v=dnk101xyz',
      'https://www.youtube.com#frag',
      'https://www.youtube.com',
      'about:blank',
    ];
    for (const url of allowed) {
      expect({ url, admitted: topFrame(youtubeMedia, url) }).toEqual({
        url,
        admitted: true,
      });
    }
  });
});
