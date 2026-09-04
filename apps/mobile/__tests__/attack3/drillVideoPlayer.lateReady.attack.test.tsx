import React from 'react';
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
  VIDEO_EMBED_REFERER,
} from '../../src/components/DrillVideoPlayer';

/**
 * Adversarial pass 3 — DrillVideoPlayer stage ladder under out-of-order
 * shell messages. Attack: the YouTube shell reports `ready` only AFTER the
 * 12s watchdog already moved the player to the watch page (a slow network
 * where the IFrame API finally wakes up). The late `ready` must not roll the
 * stage back to the embed, must not resurrect the loading overlay, and
 * garbage messages (invalid JSON, JSON primitives, arrays, null, huge
 * strings, prototype-polluting keys) must be ignored without throwing.
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

const WATCH_SOURCE = {
  uri: 'https://www.youtube.com/watch?v=dnk101xyz',
  headers: { Referer: VIDEO_EMBED_REFERER },
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

function hasEmbedLoadingOverlay(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(n => n.props.testID === 'drill-video-embed-loading')
      .length > 0
  );
}

function hasErrorCard(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(n => n.props.testID === 'drill-video-error').length >
    0
  );
}

async function sendMessage(
  renderer: TestRenderer.ReactTestRenderer,
  data: unknown,
) {
  const webView = findWebView(renderer);
  await act(async () => {
    webView?.props.onMessage({ nativeEvent: { data } });
  });
}

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('DrillVideoPlayer — late ready after the watchdog (attack 3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    onClose.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a `ready` posted after the watchdog moved to watch keeps the watch page and never re-shows the loading overlay', async () => {
    const renderer = renderPlayer(youtubeMedia);
    expect(hasEmbedLoadingOverlay(renderer)).toBe(true);

    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);

    // The stale shell finally wakes up.
    await sendMessage(renderer, JSON.stringify({ kind: 'ready' }));
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);
    expect(hasErrorCard(renderer)).toBe(false);

    // Repeated late readies and a late error are equally inert: the ladder
    // is strictly forward, so watch stays watch.
    for (let i = 0; i < 25; i += 1) {
      await sendMessage(renderer, JSON.stringify({ kind: 'ready' }));
    }
    await sendMessage(renderer, JSON.stringify({ kind: 'error', code: 153 }));
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);

    // No second watchdog is armed on the watch stage: another 12s changes nothing.
    await elapse(EMBED_READY_TIMEOUT_MS * 2);
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);
    expect(hasErrorCard(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('malformed JSON, JSON primitives, arrays, null and prototype keys are ignored without throwing or moving the stage', async () => {
    const renderer = renderPlayer(youtubeMedia);
    const embedSource = findWebView(renderer)?.props.source;
    expect(embedSource.html).toBeDefined();

    const garbage: unknown[] = [
      'not json',
      '{"kind": ',
      '',
      '42',
      '"ready"',
      'true',
      'null',
      '[]',
      '["ready"]',
      '[{"kind":"ready"}]',
      JSON.stringify({ kind: ['ready'] }),
      JSON.stringify({ kind: { kind: 'ready' } }),
      JSON.stringify({ kind: 'READY' }),
      JSON.stringify({ kind: 'ready\u0000' }),
      JSON.stringify({ __proto__: { kind: 'ready' } }),
      JSON.stringify({ constructor: { prototype: { kind: 'error' } } }),
      '{"kind":"ready"}'.repeat(2),
      `{"pad":"${'x'.repeat(200_000)}"}`,
      '\uFEFF{"kind":"ready"}',
      '{"kind":"錯誤"}',
    ];
    for (const data of garbage) {
      await sendMessage(renderer, data);
      expect(findWebView(renderer)?.props.source.html).toBe(embedSource.html);
      expect(hasEmbedLoadingOverlay(renderer)).toBe(true);
    }
    // Non-string payloads (the bridge always delivers strings, but a mocked
    // or future bridge may not): `JSON.parse` coerces or throws, and the
    // handler must swallow both without moving the stage.
    for (const data of [undefined, null, 42, true, {}, [], { kind: 'ready' }]) {
      await expect(sendMessage(renderer, data)).resolves.toBeUndefined();
      expect(findWebView(renderer)?.props.source.html).toBe(embedSource.html);
      expect(hasEmbedLoadingOverlay(renderer)).toBe(true);
    }
    expect(hasErrorCard(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('a genuine ready after garbage still defuses the watchdog exactly once', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await sendMessage(renderer, 'null');
    await sendMessage(renderer, '[]');
    await elapse(EMBED_READY_TIMEOUT_MS - 1);
    await sendMessage(renderer, JSON.stringify({ kind: 'ready' }));
    expect(hasEmbedLoadingOverlay(renderer)).toBe(false);
    await elapse(EMBED_READY_TIMEOUT_MS * 3);
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    act(() => renderer.unmount());
  });

  it('retry from the failed card re-arms the watchdog and a stale ready from the dead shell cannot cancel it', async () => {
    const renderer = renderPlayer(youtubeMedia);
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    // Watch page itself dies → error card.
    await act(async () => {
      findWebView(renderer)?.props.onError();
    });
    expect(hasErrorCard(renderer)).toBe(true);
    const [retry] = renderer.root.findAll(
      n => n.props.testID === 'drill-video-retry' && n.props.onPress,
    );
    await act(async () => retry!.props.onPress());
    expect(findWebView(renderer)?.props.source.html).toBeDefined();
    expect(hasEmbedLoadingOverlay(renderer)).toBe(true);
    // New shell never reports → watchdog must fire again.
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);
    act(() => renderer.unmount());
  });

  it('switching media after a late ready resets the ladder for the new video', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <DrillVideoPlayer media={youtubeMedia} onClose={onClose} />,
      );
    });
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    await sendMessage(renderer, JSON.stringify({ kind: 'ready' }));
    expect(findWebView(renderer)?.props.source).toEqual(WATCH_SOURCE);

    const other: InstructionalMedia = {
      ...youtubeMedia,
      id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
      videoId: 'second0001',
      embedUrl: 'https://www.youtube-nocookie.com/embed/second0001',
      sourceUrl: 'https://www.youtube.com/watch?v=second0001',
    };
    await act(async () => {
      renderer.update(<DrillVideoPlayer media={other} onClose={onClose} />);
    });
    const source = findWebView(renderer)?.props.source;
    expect(source.html).toContain('"second0001"');
    // The stale embedReady=true from the previous video must not leave the
    // new embed without its watchdog + overlay.
    expect(hasEmbedLoadingOverlay(renderer)).toBe(true);
    await elapse(EMBED_READY_TIMEOUT_MS + 1);
    expect(findWebView(renderer)?.props.source.uri).toBe(other.sourceUrl);
    act(() => renderer.unmount());
  });
});
