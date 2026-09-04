/**
 * AUDIT — shouldLoadInPlayer / httpsHost (DrillVideoPlayer.tsx:181-226), the
 * WebView navigation gate. The authority parser is a hand-rolled regex, so
 * the odd-shaped inputs a URL library would normalise are pinned here:
 * uppercase, trailing dot, punycode, userinfo, ports, non-numeric ports,
 * empty authority, IPv6 literal, look-alike suffixes and non-https schemes.
 *
 * The one PROBE encodes a raw-string ambiguity: a backslash in the authority
 * (`https://evil.com\@www.youtube.com/`). WHATWG URL parsing (WebKit, Node's
 * URL) treats `\` as a path separator for special schemes, so the *browser*
 * would navigate to evil.com while this gate — which splits on the LAST `@`
 * — sees www.youtube.com and allows it. Whether WKWebView ever hands the
 * gate an un-normalised string is an Apple-runtime fact this Linux suite
 * cannot establish; the probe pins that the gate is not self-defending.
 */
import type { InstructionalMedia } from '../../src/training/types';

jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: () => null,
  WebView: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: null,
}));

import { shouldLoadInPlayer } from '../../src/components/DrillVideoPlayer';

const youtube: InstructionalMedia = {
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

const top = (url: string) => ({ url, isTopFrame: true });

describe('shouldLoadInPlayer — top frame, YouTube embed', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dnk101xyz', true],
    ['HTTPS://WWW.YOUTUBE.COM/watch', true],
    ['https://m.youtube.com/watch', true],
    ['https://youtube.com/', true],
    ['https://www.youtube-nocookie.com/embed/x', true],
    ['https://r1---sn.googlevideo.com/videoplayback', true],
    ['https://i.ytimg.com/vi/x/hq.jpg', true],
    ['https://com.picklesensei/shell.html', true],
    ['https://user:pw@www.youtube.com:443/watch', true],
    ['https://www.youtube.com:8443/watch', true],
    // look-alike and malformed hosts are dropped
    ['https://www.youtube.com.evil.com/', false],
    ['https://evilyoutube.com/', false],
    ['https://youtube.com.', false],
    ['https://xn--youtube-xyz.com/', false],
    ['https://www.youtube.com:abc/', false],
    ['https:///www.youtube.com/', false],
    ['https://[2001:db8::1]/', false],
    ['https://accounts.google.com/', false],
    ['https://apps.apple.com/app/x', false],
    ['https://player.vimeo.com/video/1', false],
    // non-https schemes never load
    ['http://www.youtube.com/watch', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<b>x</b>', false],
    ['intent://scan/#Intent;scheme=zxing;end', false],
    ['file:///etc/passwd', false],
    ['about:blank', true],
    ['about:srcdoc', true],
  ])('VERIFIED: %s → %s', (url, expected) => {
    expect(shouldLoadInPlayer(youtube, top(url))).toBe(expected);
  });
});

describe('shouldLoadInPlayer — sub-frames and frame-less requests', () => {
  it('VERIFIED: sub-frames pass any https host but never a non-https scheme', () => {
    expect(
      shouldLoadInPlayer(youtube, {
        url: 'https://tracker.example.net/pixel',
        isTopFrame: false,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtube, {
        url: 'http://tracker.example.net/pixel',
        isTopFrame: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(youtube, {
        url: 'javascript:void 0',
        isTopFrame: false,
      }),
    ).toBe(false);
  });

  it('VERIFIED: without frame info the host rule applies', () => {
    expect(
      shouldLoadInPlayer(youtube, { url: 'https://www.youtube.com/watch' }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtube, { url: 'https://tracker.example.net/' }),
    ).toBe(false);
  });

  it('VERIFIED: hosted media scopes hosts to its own playback + source origins (no provider hosts)', () => {
    expect(
      shouldLoadInPlayer(hosted, top('https://cdn.example.com/drills/x.mp4')),
    ).toBe(true);
    expect(shouldLoadInPlayer(hosted, top('https://example.com/drills'))).toBe(
      true,
    );
    expect(
      shouldLoadInPlayer(hosted, top('https://www.youtube.com/watch')),
    ).toBe(false);
    expect(shouldLoadInPlayer(hosted, top('https://vimeo.com/1'))).toBe(false);
  });
});

describe('shouldLoadInPlayer — authority parsing ambiguity', () => {
  it('PROBE: a backslash-before-@ authority that WHATWG parsing resolves to evil.com must be dropped', () => {
    const raw = 'https://evil.com\\@www.youtube.com/watch';
    // Reference: what a WHATWG parser (and therefore WebKit) makes of it.
    expect(new URL(raw).host).toBe('evil.com');
    expect(shouldLoadInPlayer(youtube, top(raw))).toBe(false);
  });

  it('VERIFIED: an authority whose last "@" hides a look-alike is not allowed on the userinfo host', () => {
    const raw = 'https://www.youtube.com@evil.com/';
    // Here userinfo = www.youtube.com, real host = evil.com — the gate agrees.
    expect(shouldLoadInPlayer(youtube, top(raw))).toBe(false);
    // …but the reverse (real host youtube.com, attacker text in userinfo)
    // is correctly allowed; pinned so the two cases stay distinguishable.
    expect(
      shouldLoadInPlayer(youtube, top('https://evil.com@www.youtube.com/')),
    ).toBe(true);
  });
});
