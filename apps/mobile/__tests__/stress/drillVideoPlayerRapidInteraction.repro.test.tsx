import React, { useState } from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { InstructionalMedia } from '../../src/training/types';

/**
 * Minimised, deterministic reproductions of every failure class the seeded
 * campaign in drillVideoPlayerRapidInteraction.stress.test.tsx surfaced on
 * 1fb0efd7 (STRESS_ITER=400, base seed 20260904). Each `it` is one class,
 * named for the minimal seed that first hit it; they are RED on that commit
 * by design and document the intent-level contract the component should
 * meet. Replay any seed with:
 *
 *   STRESS_ONLY=<seed> npx jest --ci __tests__/stress/drillVideoPlayerRapidInteraction.stress
 */

interface WebViewSource {
  uri?: string;
  html?: string;
}

interface WebViewMount {
  source: WebViewSource;
  alive: boolean;
}

const mockMounts: WebViewMount[] = [];

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
  const MockWebView = (props: { source: WebViewSource }) => {
    ReactModule.useEffect(() => {
      const entry: WebViewMount = { source: props.source, alive: true };
      mockMounts.push(entry);
      return () => {
        entry.alive = false;
      };
    }, []);
    return ReactModule.createElement(View, props);
  };
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { DrillVideoPlayer } from '../../src/components/DrillVideoPlayer';

const youtubeB: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'ytB_000002',
  embedUrl: 'https://www.youtube-nocookie.com/embed/ytB_000002',
  sourceUrl: 'https://www.youtube.com/watch?v=ytB_000002',
  creatorName: 'Creator B',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Creator B on YouTube',
};

const vimeoC: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000003',
  kind: 'embed',
  provider: 'vimeo',
  videoId: '33000003',
  embedUrl: 'https://player.vimeo.com/video/33000003',
  sourceUrl: 'https://vimeo.com/33000003',
  creatorName: 'Creator C',
  licenseName: 'Vimeo Terms of Service',
  licenseUrl: null,
  attribution: 'Video by Creator C on Vimeo',
};

const hostedD: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000004',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/d.mp4?sig=abc',
  expiresAt: '2030-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/d',
  creatorName: 'Creator D',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

interface HostApi {
  setMedia: (media: InstructionalMedia | null) => void;
}

function Host(props: {
  initial: InstructionalMedia | null;
  api: { current: HostApi | null };
}) {
  const [media, setMedia] = useState<InstructionalMedia | null>(props.initial);
  props.api.current = { setMedia };
  return <DrillVideoPlayer media={media} onClose={() => setMedia(null)} />;
}

let mounted: Renderer | null = null;

function render(initial: InstructionalMedia) {
  const api: { current: HostApi | null } = { current: null };
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<Host initial={initial} api={api} />);
  });
  mounted = renderer;
  return { renderer, api };
}

function webView(renderer: Renderer): Instance {
  const views = renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.testID === 'drill-video-webview' &&
      n.props.source !== undefined,
  );
  expect(views).toHaveLength(1);
  return views[0] as Instance;
}

function webViewUri(renderer: Renderer): string | undefined {
  return (webView(renderer).props.source as WebViewSource).uri;
}

function pressable(renderer: Renderer, label: string): Instance {
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0] as Instance;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function hasErrorCard(renderer: Renderer): boolean {
  return (
    renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'drill-video-error',
    ).length > 0
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockMounts.length = 0;
  // The RN preset ships Linking.openURL as a jest.fn(); spyOn reuses that
  // mock, so calls would otherwise accumulate across tests.
  jest.spyOn(Linking, 'openURL').mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  // Unmount even after a failed expectation so no post-teardown re-render
  // leaks out of a red test.
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => renderer.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('DrillVideoPlayer — rapid-interaction failure classes (1fb0efd7)', () => {
  it('[A] seed 20260969: replacing the media while on the watch rung must not mount a WebView at the NEW media\u2019s watch page first', () => {
    const { renderer, api } = render(youtubeB);
    act(() => {
      webView(renderer).props.onError();
    });
    expect(webViewUri(renderer)).toBe(youtubeB.sourceUrl);

    act(() => {
      api.current?.setMedia(hostedD);
    });

    // The new media starts on its own embed rung...
    expect(webViewUri(renderer)).toBe(hostedD.playbackUrl);
    // ...and no player was ever created for its watch page on the way.
    const throwaway = mockMounts.filter(
      m => m.source.uri === hostedD.sourceUrl,
    );
    expect(throwaway).toEqual([]);
  });

  it('[B] seed 20260953: a {kind:"error"} message from a non-YouTube document must not move the ladder', () => {
    const { renderer } = render(vimeoC);
    const embedUri = webViewUri(renderer);
    expect(embedUri).toContain(vimeoC.embedUrl);

    act(() => {
      webView(renderer).props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ kind: 'error', code: 'api-load-failed' }),
        },
      });
    });

    // Only the local YouTube shell speaks the ready/error protocol.
    expect(webViewUri(renderer)).toBe(embedUri);
  });

  it('[B\u2032] seed 20261031: a {kind:"error"} message on the watch rung must not regress a failed ladder back to watch', () => {
    const { renderer } = render(youtubeB);
    act(() => {
      webView(renderer).props.onError();
    });
    expect(webViewUri(renderer)).toBe(youtubeB.sourceUrl);

    act(() => {
      const view = webView(renderer);
      view.props.onHttpError({
        nativeEvent: { url: youtubeB.sourceUrl, statusCode: 404 },
      });
      view.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 153 }) },
      });
    });

    // The watch page failed: the ladder is at `failed`, error card shown.
    expect(hasErrorCard(renderer)).toBe(true);
  });

  it('[D] seed 20261153: a late openURL rejection for the PREVIOUS media must not surface under the current media', async () => {
    let reject!: (error: Error) => void;
    const openUrl = jest.spyOn(Linking, 'openURL').mockImplementation(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    const { renderer, api } = render(hostedD);

    // Hosted media fails straight to the error card (no watch rung).
    act(() => {
      webView(renderer).props.onError();
    });
    expect(hasErrorCard(renderer)).toBe(true);
    act(() => {
      pressable(renderer, 'Open on the original source').props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);

    // The user moves on to a different video while the open is in flight...
    act(() => {
      api.current?.setMedia(vimeoC);
    });
    expect(allText(renderer)).not.toContain('could not be opened');

    // ...then the OLD request rejects.
    await act(async () => {
      reject(new Error('no handler'));
      await Promise.resolve();
    });

    const text = allText(renderer);
    expect(text).not.toContain('the original source could not be opened');
  });

  it('[D\u2032] seed 280 (base 1): a double tap on the source button whose FIRST request rejects and SECOND succeeds must not end on an error', async () => {
    const settlers: Array<{ resolve: () => void; reject: (e: Error) => void }> =
      [];
    const openUrl = jest.spyOn(Linking, 'openURL').mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          settlers.push({ resolve, reject });
        }),
    );
    const { renderer } = render(hostedD);
    act(() => {
      webView(renderer).props.onError();
    });
    expect(hasErrorCard(renderer)).toBe(true);

    // Two taps in one bridge flush → two requests in flight.
    act(() => {
      const button = pressable(renderer, 'Open on the original source');
      button.props.onPress();
      button.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(2);

    // The superseded first request fails, the latest one succeeds.
    await act(async () => {
      settlers[0]?.reject(new Error('no handler'));
      await Promise.resolve();
      settlers[1]?.resolve();
      await Promise.resolve();
    });

    // The user's latest intent succeeded; a stale rejection must not win.
    expect(allText(renderer)).not.toContain('could not be opened');
  });
});
