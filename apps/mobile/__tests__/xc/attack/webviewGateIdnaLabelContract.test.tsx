/**
 * xc-journeys / XC-P2-WEBVIEW-GATE-BACKSLASH-AUTHORITY — adversarial follow-up
 * against fb56927c (attack branch, P3).
 *
 * `httpsHost` documents itself as returning null whenever "the browser would
 * refuse" the URL and says "anything the browser would … IDNA-map or reject
 * fails closed"; the adversarial corpus suite asserts "the gate admits
 * nothing the browser cannot parse". Both are broken by a host whose label
 * starts with `xn--` but is not valid Punycode: the host regex accepts it
 * (ASCII letters, digits, `-`) and the gate ADMITS the top-frame navigation,
 * while the WHATWG oracle (`new URL(...)`) throws.
 *
 * Severity P3, NOT a security break: every admitted host still ends in an
 * allow-listed suffix (`.youtube.com`), and a WHATWG browser refuses the
 * navigation altogether, so nothing foreign is reached. It is a gap between
 * the documented fail-closed contract and the implementation. It is not a
 * regression either — the 4d812e1a parser admitted the same strings.
 *
 * Oracle: Node's `URL` (WHATWG). Whether WKWebView rejects invalid `xn--`
 * labels the same way is UNKNOWN from Linux.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { shouldLoadInPlayer } from '../../../src/components/DrillVideoPlayer';
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

function oracleParses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

const INVALID_PUNYCODE_LABEL_URLS = [
  'https://xn--.youtube.com/',
  'https://xn--a.youtube.com/',
  'https://xn--0.youtube.com/',
  'https://xn---.youtube.com/',
  'https://www.xn--.youtube.com/',
  'https://xn--ab-9999999999.youtube.com/',
];

describe('DrillVideoPlayer gate — documented fail-closed contract vs invalid xn-- labels', () => {
  it.each(INVALID_PUNYCODE_LABEL_URLS)(
    'refuses %s for the top frame because the WHATWG oracle cannot parse it',
    url => {
      // Precondition: the browser-side oracle rejects the URL outright.
      expect(oracleParses(url)).toBe(false);
      // Contract under test: "null when … the browser would refuse it" →
      // the gate must fail closed rather than admit the navigation.
      expect(shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: true })).toBe(
        false,
      );
    },
  );

  it('still admits a VALID punycode subdomain of the provider (control)', () => {
    const url = 'https://xn--80ak6aa92e.youtube.com/';
    expect(new URL(url).hostname).toBe('xn--80ak6aa92e.youtube.com');
    expect(shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: true })).toBe(
      true,
    );
  });
});
