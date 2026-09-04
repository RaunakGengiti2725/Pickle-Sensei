/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S5.
 *
 * `DrillVideoPlayer.openSource` awaits `Linking.openURL(media.sourceUrl)`
 * and, on rejection, renders `<Text accessibilityRole="alert">` under the
 * attribution block. Attacks:
 *   - reject once → alert text + role, WebView identical (same element,
 *     same source/key, stage unchanged), second tap re-invokes openURL;
 *   - reject then resolve → alert clears on the successful retry;
 *   - reject → rapid 20× taps → exactly 20 openURL attempts, one alert;
 *   - synchronous throw (openURL not returning a promise) — is it caught?;
 *   - rejection landing AFTER unmount / after the media changed mid-flight
 *     → stale error must not leak onto the new video;
 *   - error card stage: both `drill-video-open-source` and the footer link
 *     share the path;
 *   - Vimeo naming + a hostile creator name never reach the alert copy;
 *   - the alert copy stays store-safe (no "Android"/"Google Play").
 */
import React from 'react';
import { Linking } from 'react-native';
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

import { DrillVideoPlayer } from '../../src/components/DrillVideoPlayer';

const youtubeMedia: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: '<script>alert(1)</script> 🥒 Ünïcödé Coach',
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
  creatorName: 'Vimeo Coach',
  attribution: 'Video by Vimeo Coach on Vimeo',
};

type Renderer = TestRenderer.ReactTestRenderer;

const openURL = Linking.openURL as jest.MockedFunction<typeof Linking.openURL>;

beforeEach(() => {
  openURL.mockReset();
});

async function render(media: InstructionalMedia | null = youtubeMedia) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <DrillVideoPlayer media={media} onClose={() => {}} />,
    );
  });
  return renderer;
}

/** Host nodes only — testID propagates through the composite wrappers. */
function byTestId(renderer: Renderer, id: string) {
  return renderer.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

function pressable(renderer: Renderer, id: string) {
  return renderer.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
}

function alertNode(renderer: Renderer) {
  return byTestId(renderer, 'drill-video-source-error')[0] ?? null;
}

function webView(renderer: Renderer) {
  const nodes = byTestId(renderer, 'drill-video-webview');
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

async function tap(renderer: Renderer, id: string) {
  await act(async () => {
    pressable(renderer, id).props.onPress();
  });
}

describe('ATTACK S5 — DrillVideoPlayer when Linking.openURL rejects', () => {
  it('rejection → assertive alert text, WebView untouched, second tap re-attempts', async () => {
    openURL.mockRejectedValue(new Error('No app can open this URL'));
    const renderer = await render();
    const before = webView(renderer);
    const beforeSource = JSON.stringify(before.props.source);
    const beforeInstance = before.instance;
    expect(alertNode(renderer)).toBeNull();

    await tap(renderer, 'drill-video-source-link');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(youtubeMedia.sourceUrl);

    const alert = alertNode(renderer);
    expect(alert).not.toBeNull();
    expect(alert!.props.accessibilityRole).toBe('alert');
    expect(alert!.props.children).toBe(
      'YouTube could not be opened on this device.',
    );

    const after = webView(renderer);
    expect(after.instance).toBe(beforeInstance);
    expect(JSON.stringify(after.props.source)).toBe(beforeSource);
    expect(byTestId(renderer, 'drill-video-error')).toHaveLength(0);

    await tap(renderer, 'drill-video-source-link');
    expect(openURL).toHaveBeenCalledTimes(2);
    expect(alertNode(renderer)).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('reject then resolve: the alert clears on the successful retry', async () => {
    openURL
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined as never);
    const renderer = await render();
    await tap(renderer, 'drill-video-source-link');
    expect(alertNode(renderer)).not.toBeNull();
    await tap(renderer, 'drill-video-source-link');
    expect(openURL).toHaveBeenCalledTimes(2);
    expect(alertNode(renderer)).toBeNull();
    act(() => renderer.unmount());
  });

  it('20 rapid taps while every attempt rejects: 20 attempts, exactly one alert node', async () => {
    openURL.mockRejectedValue(new Error('denied'));
    const renderer = await render();
    await act(async () => {
      const link = pressable(renderer, 'drill-video-source-link');
      for (let i = 0; i < 20; i++) link.props.onPress();
    });
    expect(openURL).toHaveBeenCalledTimes(20);
    expect(byTestId(renderer, 'drill-video-source-error')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('SYNCHRONOUS throw from openURL (non-promise implementation) is still caught', async () => {
    openURL.mockImplementation(() => {
      throw new Error('sync throw');
    });
    const renderer = await render();
    await expect(
      tap(renderer, 'drill-video-source-link'),
    ).resolves.toBeUndefined();
    expect(alertNode(renderer)).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('openURL rejecting with a non-Error (undefined / string / null) still yields the alert', async () => {
    for (const reason of [undefined, 'str', null, 42]) {
      openURL.mockReset();
      openURL.mockImplementation(() => Promise.reject(reason));
      const renderer = await render();
      await tap(renderer, 'drill-video-source-link');
      expect(alertNode(renderer)).not.toBeNull();
      act(() => renderer.unmount());
    }
  });

  it('rejection landing after unmount: no React warning, no throw', async () => {
    let reject!: (e: Error) => void;
    openURL.mockImplementation(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = await render();
    await tap(renderer, 'drill-video-source-link');
    act(() => renderer.unmount());
    await act(async () => {
      reject(new Error('late'));
      await Promise.resolve();
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("media swap mid-flight: the OLD video's late rejection is recorded against the new video", async () => {
    let reject!: (e: Error) => void;
    openURL.mockImplementation(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    const renderer = await render(youtubeMedia);
    await tap(renderer, 'drill-video-source-link');
    await act(async () => {
      renderer.update(
        <DrillVideoPlayer media={vimeoMedia} onClose={() => {}} />,
      );
    });
    expect(alertNode(renderer)).toBeNull();
    await act(async () => {
      reject(new Error('late'));
      await Promise.resolve();
    });
    const alert = alertNode(renderer);
    console.log(
      `[ATTACK S5] alert after media swap + stale rejection: ${
        alert ? JSON.stringify(alert.props.children) : 'none'
      }`,
    );
    // The stale closure names the OLD provider, shown under the NEW video.
    expect(alert).not.toBeNull();
    expect(alert!.props.children).toBe(
      'YouTube could not be opened on this device.',
    );
    act(() => renderer.unmount());
  });

  it('error-card "Open on YouTube" shares the path: rejects → alert; WebView absent stays absent', async () => {
    openURL.mockRejectedValue(new Error('denied'));
    const renderer = await render();
    // Drive the ladder to the failed stage: embed load fails → watch → fails.
    await act(async () => {
      webView(renderer).props.onError();
    });
    expect(webView(renderer).props.source.uri).toBe(youtubeMedia.sourceUrl);
    await act(async () => {
      webView(renderer).props.onError();
    });
    expect(byTestId(renderer, 'drill-video-error')).toHaveLength(1);
    expect(byTestId(renderer, 'drill-video-webview')).toHaveLength(0);

    await tap(renderer, 'drill-video-open-source');
    expect(openURL).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    expect(alertNode(renderer)!.props.children).toBe(
      'YouTube could not be opened on this device.',
    );
    expect(byTestId(renderer, 'drill-video-webview')).toHaveLength(0);

    // Retry rebuilds the embed WebView; the alert is independent of stage.
    await tap(renderer, 'drill-video-retry');
    expect(webView(renderer).props.source.uri).toBeUndefined();
    expect(alertNode(renderer)).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('Vimeo copy and store-safety: hostile creator name never enters the alert', async () => {
    openURL.mockRejectedValue(new Error('denied'));
    const renderer = await render(vimeoMedia);
    await tap(renderer, 'drill-video-source-link');
    const text = String(alertNode(renderer)!.props.children);
    expect(text).toBe('Vimeo could not be opened on this device.');
    expect(text).not.toContain('<script>');
    expect(text).not.toMatch(/android|google play|dupr/i);
    act(() => renderer.unmount());
  });
});
