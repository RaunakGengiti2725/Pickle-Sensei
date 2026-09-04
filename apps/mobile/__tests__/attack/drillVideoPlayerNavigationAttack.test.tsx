// Adversarial pass 3 — subsystem `mobile-training-drills`, media surface.
//
// Scenario S6: top-frame navigations to `intent://…`, `youtube://watch?v=x`
// and `https://accounts.google.com/…` are fed to the player's
// onShouldStartLoadWithRequest gate — directly, through the rendered WebView
// props, and through react-native-webview's REAL `createOnShouldStartLoadWithRequest`
// with the player's actual `originWhitelist` — asserting every one is blocked
// and `Linking.openURL` / `Linking.canOpenURL` are never invoked.

import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/lib/WebViewShared';
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
} from '../../src/components/DrillVideoPlayer';

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

/** The three assigned URLs plus close variants an embed could emit. */
const ASSIGNED_TOP_FRAME_URLS = [
  'intent://watch?v=dnk101xyz#Intent;package=com.google.android.youtube;scheme=https;end',
  'intent://www.youtube.com/watch?v=dnk101xyz#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=https%3A%2F%2Fevil.example;end',
  'INTENT://watch?v=dnk101xyz#Intent;end',
  'youtube://watch?v=x',
  'youtube://www.youtube.com/watch?v=x',
  'vnd.youtube://x',
  'vnd.youtube:x',
  'YOUTUBE://watch?v=x',
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin',
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https://www.youtube.com/',
  'https://accounts.google.com/',
  'HTTPS://ACCOUNTS.GOOGLE.COM/ServiceLogin',
  'https://accounts.google.com:443/ServiceLogin',
  'https://user:pass@accounts.google.com/ServiceLogin',
  'https://accounts.google.com.youtube.com.evil.example/',
  'https://www.youtube.com.accounts.google.com/',
  'https://accounts.youtube.com.evil.example/',
  'https://www.google.com/recaptcha/api2/anchor',
  'https://myaccount.google.com/',
  'https://apis.google.com/js/platform.js',
  'https://play.google.com/store/apps/details?id=com.google.android.youtube',
  'https://apps.apple.com/app/youtube/id544007664',
  'itms-apps://apps.apple.com/app/id544007664',
  'market://details?id=com.google.android.youtube',
  'googlechrome://www.youtube.com/watch?v=x',
  'x-safari-https://www.youtube.com/watch?v=x',
  'javascript:window.location="https://evil.example"',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'blob:https://www.youtube.com/2f1c5f7e',
  'file:///etc/passwd',
  'ftp://www.youtube.com/watch?v=x',
  'http://www.youtube.com/watch?v=x',
  'ws://www.youtube.com/',
  'wss://www.youtube.com/',
  'sms:+15555550100?body=https://evil.example',
  'tel:+15555550100',
  'mailto:support@example.com',
  '//www.youtube.com/watch?v=x',
  ' https://www.youtube.com/watch?v=x',
  'https:/www.youtube.com/watch?v=x',
  'https//www.youtube.com/watch?v=x',
  'https://',
  '',
];

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

type Gate = (request: { url: string; isTopFrame?: boolean }) => boolean;

let openUrl: jest.SpyInstance;
let canOpenUrl: jest.SpyInstance;

beforeEach(() => {
  openUrl = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(async () => undefined);
  canOpenUrl = jest
    .spyOn(Linking, 'canOpenURL')
    .mockImplementation(async () => true);
  // The RN jest preset already ships Linking as jest.fn()s; spyOn returns
  // those same mocks, so their call history must be cleared explicitly.
  openUrl.mockClear();
  canOpenUrl.mockClear();
  onClose.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('S6 — hostile top-frame navigations at the player gate', () => {
  it.each(ASSIGNED_TOP_FRAME_URLS.map(url => [url]))(
    'HELD: shouldLoadInPlayer blocks %j for every media kind and never touches Linking',
    url => {
      for (const media of [youtubeMedia, vimeoMedia, hostedMedia]) {
        expect(shouldLoadInPlayer(media, { url, isTopFrame: true })).toBe(
          false,
        );
        expect(shouldLoadInPlayer(media, { url })).toBe(false);
      }
      expect(openUrl).not.toHaveBeenCalled();
      expect(canOpenUrl).not.toHaveBeenCalled();
    },
  );

  it('HELD: the rendered WebView gate (embed stage) blocks all assigned urls; Linking is never called', () => {
    const renderer = renderPlayer(youtubeMedia);
    const view = findWebView(renderer);
    expect(view).not.toBeNull();
    expect(view!.props.originWhitelist).toEqual(['*']);
    expect(view!.props.setSupportMultipleWindows).toBe(false);
    const gate = view!.props.onShouldStartLoadWithRequest as Gate;
    for (const url of ASSIGNED_TOP_FRAME_URLS) {
      expect(gate({ url, isTopFrame: true })).toBe(false);
    }
    // The legitimate frames still load, so the block is not a blanket deny.
    expect(gate({ url: 'about:blank', isTopFrame: true })).toBe(true);
    expect(gate({ url: youtubeMedia.embedUrl, isTopFrame: true })).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(canOpenUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('HELD: after the embed falls forward to the watch page, the new WebView gate blocks the same urls', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await act(async () => {
      findWebView(renderer)!.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 150 }) },
      });
    });
    const view = findWebView(renderer);
    expect(view!.props.source.uri).toBe(youtubeMedia.sourceUrl);
    const gate = view!.props.onShouldStartLoadWithRequest as Gate;
    for (const url of ASSIGNED_TOP_FRAME_URLS) {
      expect(gate({ url, isTopFrame: true })).toBe(false);
    }
    expect(openUrl).not.toHaveBeenCalled();
    expect(canOpenUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("HELD: react-native-webview's real request handler, with the player's originWhitelist, refuses every url via the gate (not via Linking)", () => {
    const renderer = renderPlayer(youtubeMedia);
    const view = findWebView(renderer)!;
    const loadRequest = jest.fn();
    const handler = createOnShouldStartLoadWithRequest(
      loadRequest,
      view.props.originWhitelist as string[],
      view.props.onShouldStartLoadWithRequest as Gate,
    );
    let lock = 0;
    for (const url of ASSIGNED_TOP_FRAME_URLS) {
      lock += 1;
      handler({
        nativeEvent: {
          url,
          lockIdentifier: lock,
          isTopFrame: true,
          navigationType: 'click',
          title: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          mainDocumentURL: url,
        },
      } as never);
      expect(loadRequest).toHaveBeenLastCalledWith(false, url, lock);
    }
    expect(loadRequest).toHaveBeenCalledTimes(ASSIGNED_TOP_FRAME_URLS.length);
    // Crucial: with `['*']` nothing falls into the library's "outside the
    // whitelist → Linking.openURL" branch.
    expect(openUrl).not.toHaveBeenCalled();
    expect(canOpenUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('HELD (contrast): with the library DEFAULT whitelist the same urls WOULD reach Linking — pinning why ["*"] matters', async () => {
    const loadRequest = jest.fn();
    const handler = createOnShouldStartLoadWithRequest(
      loadRequest,
      ['https://*'],
      () => false,
    );
    // The library's fallback is `canOpenURL(url).then(openURL)`; wait for the
    // whole chain so nothing leaks into the next test.
    const opened = new Promise<string>(resolve => {
      openUrl.mockImplementation(async (url: string) => {
        resolve(url);
      });
    });
    handler({
      nativeEvent: { url: 'youtube://watch?v=x', lockIdentifier: 1 },
    } as never);
    expect(loadRequest).toHaveBeenCalledWith(false, 'youtube://watch?v=x', 1);
    await expect(opened).resolves.toBe('youtube://watch?v=x');
    expect(canOpenUrl).toHaveBeenCalledWith('youtube://watch?v=x');
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it('HELD: a same-tick hammer of 2,000 mixed requests keeps the gate pure (no Linking, deterministic answers)', () => {
    const renderer = renderPlayer(youtubeMedia);
    const gate = findWebView(renderer)!.props
      .onShouldStartLoadWithRequest as Gate;
    const allowed = [
      'about:blank',
      youtubeMedia.embedUrl,
      youtubeMedia.sourceUrl,
      'https://www.youtube.com/watch?v=other',
    ];
    let seed = 0x5eed2026;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const pickAllowed = next() % 3 === 0;
      const url = pickAllowed
        ? allowed[next() % allowed.length]!
        : ASSIGNED_TOP_FRAME_URLS[next() % ASSIGNED_TOP_FRAME_URLS.length]!;
      expect(gate({ url, isTopFrame: true })).toBe(pickAllowed);
    }
    expect(openUrl).not.toHaveBeenCalled();
    expect(canOpenUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('HELD: the only Linking.openURL the player performs is the explicit "Watch on YouTube" affordance, with the sourceUrl', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const [button] = renderer.root.findAll(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        /YouTube/.test(n.props.accessibilityLabel) &&
        typeof n.props.onPress === 'function',
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    act(() => renderer.unmount());
  });
});

describe('extra — authority parser differentials in httpsHost', () => {
  // WHATWG/WebKit treat `\` in a special-scheme authority as a path
  // separator; the gate's regex does not. These urls would be reported by a
  // spec-normalising WebView as `https://evil.example/...` (blocked) — the
  // rows below document the gate's raw answer at 4d812e1a.
  it.each([
    ['https://evil.example\\@www.youtube.com/watch', true],
    ['https://evil.example\\.youtube.com/watch', true],
    ['https://www.youtube.com\\@evil.example/watch', false],
    ['https://www.youtube.com%2F@evil.example/', false],
    ['https://www.youtube.com#@evil.example/', true],
    ['https://www.youtube.com?@evil.example/', true],
    ['https://evil.example#@www.youtube.com/', false],
    ['https://evil.example?@www.youtube.com/', false],
    ['https://www.youtube.com.evil.example/', false],
    ['https://evil.example/https://www.youtube.com/', false],
    ['https://www.youtube.com@evil.example/', false],
    ['https://xn--youtube-com.evil.example/', false],
    ['https://www.youtube.com\t/watch', false],
    ['https://www\t.youtube.com/watch', true],
    ['https://www.youtube.com./watch', false],
    ['https://WWW.YOUTUBE.COM./watch', false],
  ])(
    'gate answer for %j is %s (raw string, pre-normalisation)',
    (url, expected) => {
      expect(shouldLoadInPlayer(youtubeMedia, { url, isTopFrame: true })).toBe(
        expected,
      );
      expect(openUrl).not.toHaveBeenCalled();
    },
  );

  it('P3 candidate: a backslash inside the authority lets a raw non-provider host through the gate', () => {
    // Raw-string evaluation only. Exploitability depends on the WebView
    // delivering a non-normalised url, which cannot be established on Linux.
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example\\@www.youtube.com/watch',
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldLoadInPlayer(youtubeMedia, {
        url: 'https://evil.example\\.youtube.com/watch',
        isTopFrame: true,
      }),
    ).toBe(true);
  });
});
