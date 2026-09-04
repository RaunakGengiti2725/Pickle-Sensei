/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenario 7.
 *
 * DrillVideoPlayer fallback ladder under media swaps: the `media` prop is
 * replaced while the player sits in the `failed` stage and Retry is pressed
 * immediately (same tick / same act as the swap, and one tick later). The
 * retried WebView must load the NEW media — never the previous one's embed
 * shell, watch page or playback URL — and stale watchdogs from the previous
 * media must never advance the new media's ladder.
 */
import React from 'react';
import { Text } from 'react-native';
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
  EMBED_READY_TIMEOUT_MS,
} from '../../src/components/DrillVideoPlayer';

const youtubeA: InstructionalMedia = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'firstVID01',
  embedUrl: 'https://www.youtube-nocookie.com/embed/firstVID01',
  sourceUrl: 'https://www.youtube.com/watch?v=firstVID01',
  creatorName: 'Creator One',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Creator One on YouTube',
};

const youtubeB: InstructionalMedia = {
  ...youtubeA,
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  videoId: 'secondVID2',
  embedUrl: 'https://www.youtube-nocookie.com/embed/secondVID2',
  sourceUrl: 'https://www.youtube.com/watch?v=secondVID2',
  creatorName: 'Creator Two',
  attribution: 'Video by Creator Two on YouTube',
};

const vimeoC: InstructionalMedia = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  kind: 'embed',
  provider: 'vimeo',
  videoId: '31337',
  embedUrl: 'https://player.vimeo.com/video/31337',
  sourceUrl: 'https://vimeo.com/31337',
  creatorName: 'Creator Three',
  licenseName: 'Vimeo Terms of Service',
  licenseUrl: null,
  attribution: 'Video by Creator Three on Vimeo',
};

const hostedD: InstructionalMedia = {
  id: 'dddddddd-0000-4000-8000-000000000004',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/d.mp4?sig=first',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sourceUrl: 'https://example.com/drills/d',
  creatorName: 'Creator Four',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const onClose = jest.fn();

function element(media: InstructionalMedia | null) {
  return <DrillVideoPlayer media={media} onClose={onClose} />;
}

function renderPlayer(media: InstructionalMedia | null) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element(media));
  });
  return renderer;
}

function findWebView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-webview' && n.props.source,
  );
  return node ?? null;
}

/** Host-level WebView nodes only (the mock renders one host View each). */
function webViews(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.testID === 'drill-video-webview' &&
      n.props.source,
  );
}

/** Raw (unescaped) text of the current WebView source: html + uri + headers. */
function sourceString(renderer: TestRenderer.ReactTestRenderer): string {
  const source = findWebView(renderer)?.props.source as
    { html?: string; uri?: string; baseUrl?: string } | undefined;
  if (!source) return '';
  return [source.html ?? '', source.uri ?? '', source.baseUrl ?? ''].join('\n');
}

function inFailedStage(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(n => n.props.testID === 'drill-video-error').length >
    0
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function retryNode(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === 'Try loading the video again' &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

async function driveToFailed(
  renderer: TestRenderer.ReactTestRenderer,
  media: InstructionalMedia,
) {
  if (media.kind === 'embed') {
    // embed → watch (player error) → failed (watch page main-doc error)
    await act(async () => {
      findWebView(renderer)?.props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error', code: 150 }) },
      });
    });
    expect(findWebView(renderer)?.props.source.uri).toBe(media.sourceUrl);
  }
  await act(async () => {
    findWebView(renderer)?.props.onError();
  });
  expect(inFailedStage(renderer)).toBe(true);
}

/** Every string that identifies the PREVIOUS media, none of which may leak. */
function identifiers(media: InstructionalMedia): string[] {
  return media.kind === 'embed'
    ? [media.videoId, media.embedUrl, media.sourceUrl]
    : [media.playbackUrl, media.sourceUrl];
}

beforeEach(() => {
  jest.useFakeTimers();
  onClose.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('ATTACK S7 — media swap while in failed stage + immediate Retry', () => {
  it('swap A→B in failed stage, then Retry one tick later: WebView loads B, never A', async () => {
    const renderer = renderPlayer(youtubeA);
    await driveToFailed(renderer, youtubeA);

    await act(async () => {
      renderer.update(element(youtubeB));
    });
    // Swapping media resets the ladder: the new video starts at its embed.
    expect(inFailedStage(renderer)).toBe(false);
    const afterSwap = sourceString(renderer);
    expect(afterSwap).toContain('"secondVID2"');
    for (const id of identifiers(youtubeA)) expect(afterSwap).not.toContain(id);

    // If the error card is (still) up, press Retry; either way the WebView
    // must be B's.
    const retry = retryNode(renderer);
    if (retry) await act(async () => retry.props.onPress());
    const src = sourceString(renderer);
    expect(src).toContain('"secondVID2"');
    for (const id of identifiers(youtubeA)) expect(src).not.toContain(id);
    expect(allText(renderer)).toContain('Creator Two');
    expect(allText(renderer)).not.toContain('Creator One');
    act(() => renderer.unmount());
  });

  it('swap A→B and press the captured Retry in the SAME act (before the reset effect commits): loads B, never A, exactly one WebView', async () => {
    const renderer = renderPlayer(youtubeA);
    await driveToFailed(renderer, youtubeA);
    const retry = retryNode(renderer);
    expect(retry).not.toBeNull();
    const onPress = retry!.props.onPress as () => void;

    await act(async () => {
      renderer.update(element(youtubeB));
      onPress();
    });
    expect(inFailedStage(renderer)).toBe(false);
    expect(webViews(renderer)).toHaveLength(1);
    const src = sourceString(renderer);
    expect(src).toContain('"secondVID2"');
    for (const id of identifiers(youtubeA)) expect(src).not.toContain(id);
    act(() => renderer.unmount());
  });

  it('Retry pressed FIRST, then swap A→B in the same act: still ends on B embed', async () => {
    const renderer = renderPlayer(youtubeA);
    await driveToFailed(renderer, youtubeA);
    const onPress = retryNode(renderer)!.props.onPress as () => void;
    await act(async () => {
      onPress();
      renderer.update(element(youtubeB));
    });
    const src = sourceString(renderer);
    expect(src).toContain('"secondVID2"');
    for (const id of identifiers(youtubeA)) expect(src).not.toContain(id);
    act(() => renderer.unmount());
  });

  it('swap failed YouTube → Vimeo → hosted: each swap loads the new provider surface, never a previous URL', async () => {
    const renderer = renderPlayer(youtubeA);
    await driveToFailed(renderer, youtubeA);
    await act(async () => {
      renderer.update(element(vimeoC));
    });
    let src = sourceString(renderer);
    expect(src).toContain('https://player.vimeo.com/video/31337?playsinline=1');
    for (const id of identifiers(youtubeA)) expect(src).not.toContain(id);

    await driveToFailed(renderer, vimeoC);
    await act(async () => {
      renderer.update(element(hostedD));
    });
    src = sourceString(renderer);
    expect(src).toContain('https://cdn.example.com/d.mp4?sig=first');
    for (const id of [...identifiers(youtubeA), ...identifiers(vimeoC)]) {
      expect(src).not.toContain(id);
    }
    act(() => renderer.unmount());
  });

  it('extra: swap to the SAME id with a refreshed signed playbackUrl while failed — Retry must load the fresh URL', async () => {
    const renderer = renderPlayer(hostedD);
    await driveToFailed(renderer, hostedD);
    const refreshed: InstructionalMedia = {
      ...hostedD,
      playbackUrl: 'https://cdn.example.com/d.mp4?sig=second',
    };
    await act(async () => {
      renderer.update(element(refreshed));
    });
    // Same id: the ladder is intentionally NOT reset, so the error card stays.
    expect(inFailedStage(renderer)).toBe(true);
    const retry = retryNode(renderer);
    await act(async () => retry!.props.onPress());
    const src = sourceString(renderer);
    expect(src).toContain('sig=second');
    expect(src).not.toContain('sig=first');
    act(() => renderer.unmount());
  });

  it('extra: swap to null while failed and back to a different media — renders B embed, old failed stage does not survive', async () => {
    const renderer = renderPlayer(youtubeA);
    await driveToFailed(renderer, youtubeA);
    await act(async () => {
      renderer.update(element(null));
    });
    expect(renderer.toJSON()).toBeNull();
    await act(async () => {
      renderer.update(element(youtubeB));
    });
    expect(inFailedStage(renderer)).toBe(false);
    expect(sourceString(renderer)).toContain('"secondVID2"');
    act(() => renderer.unmount());
  });

  it("extra: A's embed watchdog must not advance B's ladder after a swap (timer keyed on media)", async () => {
    const renderer = renderPlayer(youtubeA);
    act(() => {
      jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS - 1);
    });
    await act(async () => {
      renderer.update(element(youtubeB));
    });
    act(() => {
      jest.advanceTimersByTime(2);
    });
    // B is still on its embed shell — A's nearly-expired watchdog was cleared.
    expect(sourceString(renderer)).toContain('"secondVID2"');
    expect(findWebView(renderer)?.props.source.uri).toBeUndefined();
    act(() => {
      jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS);
    });
    // B's own watchdog fires at its own 12s.
    expect(findWebView(renderer)?.props.source.uri).toBe(youtubeB.sourceUrl);
    act(() => renderer.unmount());
  });

  it('extra: rapid seeded swap/retry/fail interleaving (seed 9001) never shows a stale media URL and never renders two WebViews', async () => {
    let seed = 9001;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pool = [youtubeA, youtubeB, vimeoC, hostedD];
    let current: InstructionalMedia = youtubeA;
    const renderer = renderPlayer(current);
    for (let i = 0; i < 80; i += 1) {
      const roll = rand();
      if (roll < 0.3) {
        current = pool[Math.floor(rand() * pool.length)]!;
        await act(async () => {
          renderer.update(element(current));
        });
      } else if (roll < 0.55) {
        const wv = findWebView(renderer);
        if (wv) await act(async () => wv.props.onError());
      } else if (roll < 0.75) {
        const wv = findWebView(renderer);
        if (wv) {
          await act(async () => {
            wv.props.onMessage({
              nativeEvent: {
                data: JSON.stringify({ kind: 'error', code: 101 }),
              },
            });
          });
        }
      } else if (roll < 0.9) {
        const retry = retryNode(renderer);
        if (retry) await act(async () => retry.props.onPress());
      } else {
        act(() => {
          jest.advanceTimersByTime(Math.floor(rand() * 15_000));
        });
      }
      const views = webViews(renderer);
      expect(views.length).toBeLessThanOrEqual(1);
      const src = sourceString(renderer);
      for (const other of pool) {
        if (other.id === current.id) continue;
        for (const id of identifiers(other)) {
          expect(src).not.toContain(id);
        }
      }
      expect(allText(renderer)).toContain(current.creatorName);
    }
    act(() => renderer.unmount());
  });
});
