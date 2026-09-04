/**
 * Adjudication reproduction (xc-journeys / journey-deep-links-urls): the
 * DrillVideoPlayer top-frame gate parses the authority with a hand-rolled
 * regex that takes the host after the LAST '@'. WHATWG URL parsing (which
 * browsers use) treats '\' in a special-scheme authority as a path separator,
 * so `https://evil.example\@www.youtube.com/` is host `evil.example` to the
 * browser but `www.youtube.com` to the gate — the gate admits a top-frame
 * navigation the allowlist was supposed to refuse.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { shouldLoadInPlayer } from '../../../src/components/DrillVideoPlayer';
import type { InstructionalMedia } from '../../../src/training/types';

const youtube = {
  id: 'drill-1',
  kind: 'embed',
  provider: 'youtube',
  embedUrl: 'https://www.youtube-nocookie.com/embed/abc123',
  sourceUrl: 'https://www.youtube.com/watch?v=abc123',
  title: 'Dink drill',
} as unknown as InstructionalMedia;

describe('adjudication: WebView gate vs WHATWG host on backslash authority', () => {
  it('refuses a top-frame URL whose browser host is not allowlisted', () => {
    const url = 'https://evil.example\\@www.youtube.com/';
    const browserHost = new URL(url).hostname;
    const admitted = shouldLoadInPlayer(youtube, { url, isTopFrame: true });

    console.log(
      `[adjudicate] url=${JSON.stringify(url)} browserHost=${browserHost} gateAdmitted=${admitted}`,
    );
    expect(browserHost).toBe('evil.example');
    expect(admitted).toBe(false);
  });
});
