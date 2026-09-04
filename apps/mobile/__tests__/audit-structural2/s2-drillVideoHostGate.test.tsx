/**
 * Structural audit #2: `shouldLoadInPlayer` is the navigation gate for the
 * drill WebView and derives the host with a hand-rolled regex. This probe
 * compares its top-frame decisions against the WHATWG URL parser (Node's
 * `URL`) for authority edge cases. Any URL the gate ALLOWS whose WHATWG host
 * is off-provider is a fail-open divergence; fail-closed divergences are
 * listed separately as verified-safe.
 */
import type { InstructionalMedia } from '../../src/training/types';

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
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
  creatorName: 'Creator',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Creator on YouTube',
};

const PROVIDER_SUFFIXES = [
  'youtube.com',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
  'com.picklesensei',
];

function whatwgHostAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return PROVIDER_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`));
}

const FAIL_OPEN_CANDIDATES = [
  // Backslash is a path separator for special schemes in WHATWG; the regex
  // treats everything before "@" as userinfo.
  'https://evil.example\\@www.youtube.com/watch?v=x',
  'https://evil.example\\foo@www.youtube.com/',
];

const FAIL_CLOSED_OR_SAME = [
  'https://www.youtube.com@evil.example/',
  'https://evil.example#@www.youtube.com/',
  'https://evil.example?@www.youtube.com/',
  'https://evil.example/@www.youtube.com/',
  'https://www.youtube.com:evil.example/',
  'https://www.youtube.com%00.evil.example/',
  'https://www.youtube.com./',
  'https://WWW.YOUTUBE.COM/',
  'https://www.youtubе.com/', // Cyrillic е
  'https://www.youtube.com\\evil.example/',
  ' https://www.youtube.com/',
  'https://user:pw@www.youtube.com:443/watch',
  'http://www.youtube.com/',
  'javascript:alert(1)',
  'https://evil.example.youtube.com.evil.example/',
];

describe('shouldLoadInPlayer host derivation vs WHATWG URL', () => {
  it.each(FAIL_OPEN_CANDIDATES)(
    'never allows a top-frame URL whose real host is off-provider: %s',
    url => {
      const gate = shouldLoadInPlayer(youtube, { url, isTopFrame: true });
      const oracle = whatwgHostAllowed(url);
      expect(oracle).toBe(false);
      expect(gate).toBe(false);
    },
  );

  it.each(FAIL_CLOSED_OR_SAME)(
    'agrees with WHATWG or fails closed: %s',
    url => {
      const gate = shouldLoadInPlayer(youtube, { url, isTopFrame: true });
      const oracle = whatwgHostAllowed(url);
      if (oracle === false) expect(gate).toBe(false);
      // gate may be stricter than the oracle, never looser
      if (gate === true) expect(oracle).toBe(true);
    },
  );

  it('sub-frame requests still require https (verified invariant)', () => {
    expect(
      shouldLoadInPlayer(youtube, {
        url: 'http://tracker.example/pixel',
        isTopFrame: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadInPlayer(youtube, {
        url: 'https://ads.example/frame',
        isTopFrame: false,
      }),
    ).toBe(true);
  });
});
