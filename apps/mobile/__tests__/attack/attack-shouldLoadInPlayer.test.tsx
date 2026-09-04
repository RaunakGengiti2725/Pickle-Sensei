/**
 * ADVERSARIAL PASS 3 — scenario 3 (mobile-design-components-walkthrough).
 *
 * Attack: the DrillVideoPlayer navigation gate (`shouldLoadInPlayer`) with
 * host-spoofing URLs — trailing-dot FQDN, punycode look-alike, userinfo
 * smuggling, parent-domain suffix spoofing, upper-case scheme/host, Cyrillic
 * homoglyphs, backslash authority tricks, non-https schemes and a 1 MB URL.
 *
 * Oracle: only URLs whose WHATWG-parsed hostname is a legitimate provider
 * host (or the app shell) may load in the top frame. Node's `URL` is used as
 * the reference parser so the hand-rolled regex can be compared against the
 * spec the WebView itself follows.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { shouldLoadInPlayer } from '../../src/components/DrillVideoPlayer';
import type { InstructionalMedia } from '../../src/training/types';

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

const LEGIT_SUFFIXES = [
  'youtube.com',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
  'com.picklesensei',
];

/** WHATWG reference: is the parsed https hostname a legitimate provider host? */
function whatwgLegit(url: string): boolean | 'unparseable' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unparseable';
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return LEGIT_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`));
}

const top = (url: string) => shouldLoadInPlayer(youtubeMedia, { url });

describe('shouldLoadInPlayer adversarial host spoofing', () => {
  it.each([
    [
      'https://YOUTUBE.COM./watch',
      false,
      'trailing-dot FQDN (conservatively refused)',
    ],
    ['https://xn--yutube-abc.com', false, 'punycode look-alike'],
    ['https://youtube.com:8443@evil.com/', false, 'userinfo smuggling'],
    ['https://youtube.com.evil.com', false, 'parent-domain suffix spoof'],
    ['HTTPS://youtube.com', true, 'upper-case scheme, legit host'],
  ])('assigned: %s → %s (%s)', (url, expected) => {
    expect(top(url)).toBe(expected);
    // Anything the gate lets through must ALSO be legit per the WHATWG parser.
    if (top(url)) expect(whatwgLegit(url)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=dnk101xyz',
    'https://WWW.YOUTUBE-NOCOOKIE.COM:443/embed/x',
    'https://youtube.com:',
    'https://user:pass@www.youtube.com/watch',
    'https://rr1---sn-abc.googlevideo.com/videoplayback',
    'https://i.ytimg.com/vi/x/hqdefault.jpg',
    'https://com.picklesensei/',
    'about:blank',
  ])('legitimate provider URL loads: %s', url => {
    expect(top(url)).toBe(true);
  });

  it.each([
    'https://evil.com/@youtube.com',
    'https://evil.com?@youtube.com',
    'https://evil.com#@youtube.com',
    'https://youtube.com@evil.com',
    'https://www.youtube.com@evil.com:443/',
    'https://youtube.com%2F@evil.com',
    'https://youtube.com%00.evil.com',
    'https://youtube.com:evil.com',
    'https://youtubecom',
    'https://notyoutube.com',
    'https://youtube.com.',
    'https://youtubе.com', // Cyrillic е (U+0435)
    'https://xn--youtub-3ve.com', // punycode of the homoglyph above
    'https://youtube.co',
    'https://youtube.com.evil.com:8443',
    'http://youtube.com',
    'https:/youtube.com',
    'https:\\\\youtube.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'intent://youtube.com#Intent;scheme=https;end',
    'file:///etc/passwd',
    'About:blank',
    'about:srcdoc'.toUpperCase(),
    'ftp://youtube.com',
    '',
    'https://',
    'https://@',
    'https://:443',
  ])('spoof / foreign scheme is refused: %s', url => {
    expect(top(url)).toBe(false);
  });

  // WHATWG treats "\" as "/" for special schemes, so the hostname of each of
  // these is evil.com. The gate must agree with the parser the WebView uses.
  it.each([
    'https://evil.com\\@youtube.com',
    'https://evil.com\\.youtube.com',
    'https://evil.com\\@www.youtube-nocookie.com/embed/x',
    'https://evil.com\\:443@youtube.com',
  ])(
    'never lets through a URL whose WHATWG hostname is not a provider host: %s',
    url => {
      expect(new URL(url).hostname).toBe('evil.com');
      expect(whatwgLegit(url)).toBe(false);
      expect(top(url)).toBe(false);
    },
  );

  it('tab / newline injected into the authority never widens the gate beyond WHATWG', () => {
    for (const ws of ['\t', '\n', '\r']) {
      const url = `https://youtube.com${ws}.evil.com/`;
      // WHATWG strips tab/newline → "youtube.com.evil.com" → not legit.
      expect(whatwgLegit(url)).toBe(false);
      expect(top(url)).toBe(false);
    }
  });

  it('sub-frame requests from the provider player pass only over https', () => {
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://accounts.google.com/x',
        isTopFrame: false,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'http://evil.com/',
        isTopFrame: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'javascript:void 0',
        isTopFrame: false,
      }),
    ).toBe(false);
  });

  it('vimeo media never lets youtube hosts through and vice versa', () => {
    const vimeo: InstructionalMedia = {
      ...youtubeMedia,
      kind: 'embed',
      provider: 'vimeo',
      videoId: '76543210',
      embedUrl: 'https://player.vimeo.com/video/76543210',
      sourceUrl: 'https://vimeo.com/76543210',
    };
    expect(shouldLoadInPlayer(vimeo, { url: 'https://www.youtube.com/' })).toBe(
      false,
    );
    expect(
      shouldLoadInPlayer(vimeo, { url: 'https://player.vimeo.com/' }),
    ).toBe(true);
    expect(top('https://player.vimeo.com/video/1')).toBe(false);
  });

  it('hosted media only allows its own cdn + source hosts, never provider hosts', () => {
    const hosted: InstructionalMedia = {
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      kind: 'hosted',
      playbackUrl: 'https://cdn.example.com/drills/dink.mp4?sig=abc',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sourceUrl: 'https://example.com/drills/dink',
      creatorName: 'Pickle Sensei Coaching',
      licenseName: 'Licensed to Pickle Sensei',
      licenseUrl: null,
      attribution: 'Video licensed for Pickle Sensei',
    };
    expect(
      shouldLoadInPlayer(hosted, { url: 'https://cdn.example.com/x' }),
    ).toBe(true);
    expect(shouldLoadInPlayer(hosted, { url: 'https://example.com/y' })).toBe(
      true,
    );
    expect(
      shouldLoadInPlayer(hosted, { url: 'https://www.youtube.com/' }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(hosted, { url: 'https://cdn.example.com.evil.com/' }),
    ).toBe(false);
  });

  it('a 1 MB URL is decided quickly and refused', () => {
    const huge = `https://${'a'.repeat(1_000_000)}.evil.com/`;
    const started = Date.now();
    expect(top(huge)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    const hugeLegit = `https://www.youtube.com/${'a'.repeat(1_000_000)}`;
    expect(top(hugeLegit)).toBe(true);
  });
});
