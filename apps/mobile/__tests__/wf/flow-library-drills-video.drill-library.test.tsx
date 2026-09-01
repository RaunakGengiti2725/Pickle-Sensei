import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import {
  EMBED_READY_TIMEOUT_MS,
  VIDEO_EMBED_REFERER,
} from '../../src/components/DrillVideoPlayer';
import {
  TrainingError,
  type DrillDetail,
  type InstructionalMedia,
} from '../../src/training/types';

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

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
const mockListScoredCheckpointFacts = jest.fn<
  Promise<ScoredCheckpointFact[]>,
  [unknown]
>();
jest.mock('../../src/data/repository', () => ({
  listScoredCheckpointFacts: (...args: [unknown]) =>
    mockListScoredCheckpointFacts(...args),
}));

const mockListCatalogDrills = jest.fn<
  Promise<CatalogDrill[]>,
  [{ q?: string; family?: string }]
>();
const mockSaveDrill = jest.fn<Promise<void>, [string]>();
const mockUnsaveDrill = jest.fn<Promise<void>, [string]>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

/**
 * Drives the Drill Library as a user would, end to end through the in-app
 * video player: back, catalog load failure → retry, detail open/close with
 * loading → error → retry → ready, the bookmark toggle (optimistic, single
 * flight under a double tap, reverted with a dismissible inline error on
 * failure), the unconfigured-session copy, external YouTube discovery and
 * its failure branch, and the full DrillVideoPlayer ladder mounted from the
 * screen: embed shell → player error / watchdog → canonical watch page →
 * load failure → error card → retry / open at source / close / dismiss.
 *
 * AGENTS.md invariants pinned: no bare /embed/ URL is ever loaded or opened,
 * the shell is identified by the VIDEO_EMBED_REFERER baseUrl, and every
 * outbound link is the canonical sourceUrl.
 */

const dinkDrill: CatalogDrill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: '2.0',
  difficultyMax: '3.5',
  families: ['dink'],
  validationState: 'PUBLISHED',
  saved: false,
};

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

const detailFixture: DrillDetail = {
  id: dinkDrill.id,
  slug: dinkDrill.slug,
  title: dinkDrill.title,
  description: dinkDrill.description,
  coachName: dinkDrill.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: false,
  mappings: [],
  instructionalMedia: [youtubeMedia],
};

const OFFLINE_COPY =
  'Training is temporarily offline. Your existing reads are still safe.';

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole !== undefined,
  );
}

function oneByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const [node] = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function firstNode(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
): TestRenderer.ReactTestInstance {
  const [node] = renderer.root.findAll(predicate);
  if (!node) throw new Error('No node matched');
  return node;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = oneByLabel(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
  return node;
}

function findByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(n => n.props.testID === id);
}

function webView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = findByTestId(renderer, 'drill-video-webview');
  if (!node) throw new Error('No video WebView mounted');
  return node;
}

async function settle() {
  await act(async () => {});
}

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<DrillLibraryScreen />);
  });
  return renderer;
}

async function openDetail(renderer: TestRenderer.ReactTestRenderer) {
  await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
  await settle();
}

async function openPlayer(renderer: TestRenderer.ReactTestRenderer) {
  await openDetail(renderer);
  await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
  expect(findByTestId(renderer, 'drill-video-player').length).toBeGreaterThan(
    0,
  );
}

function spyOnOpenUrl() {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockClear();
  spy.mockResolvedValue(undefined);
  return spy;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListScoredCheckpointFacts.mockResolvedValue([]);
  mockListCatalogDrills.mockResolvedValue([dinkDrill]);
  mockGetDrill.mockResolvedValue(detailFixture);
  mockSaveDrill.mockResolvedValue(undefined);
  mockUnsaveDrill.mockResolvedValue(undefined);
});

describe('Drill Library flow · catalog', () => {
  it('loading → catalog; Back pops the stack', async () => {
    let resolveCatalog!: (rows: CatalogDrill[]) => void;
    mockListCatalogDrills.mockReturnValue(
      new Promise<CatalogDrill[]>(resolve => {
        resolveCatalog = resolve;
      }),
    );
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Loading the drill catalog…');
    await act(async () => resolveCatalog([dinkDrill]));
    expect(allText(renderer)).not.toContain('Loading the drill catalog…');
    expect(allText(renderer)).toContain('Dink Target Ladder');
    await pressByLabel(renderer, 'Back');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('initial load failure is an alert with the failure copy and a working retry', async () => {
    mockListCatalogDrills.mockRejectedValueOnce(
      new TrainingError('training.unavailable', OFFLINE_COPY, true),
    );
    const renderer = await renderScreen();
    const text = allText(renderer);
    expect(text).toContain('The drill catalog could not load.');
    expect(text).toContain(OFFLINE_COPY);
    expect(text).not.toContain('Loading the drill catalog…');
    const alert = firstNode(
      renderer,
      n => n.props.accessibilityRole === 'alert' && String(n.type) === 'View',
    );
    expect(alert.props.accessibilityLiveRegion).toBe('assertive');

    await pressByLabel(renderer, 'Try again');
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('Dink Target Ladder');
    expect(allText(renderer)).not.toContain(
      'The drill catalog could not load.',
    );
    act(() => renderer.unmount());
  });

  it('an unconfigured session surfaces the account copy instead of spinning', async () => {
    mockListCatalogDrills.mockRejectedValueOnce(
      new TrainingError(
        'training.unconfigured',
        'Connect a synced account to load saved drills and personalized plans.',
        false,
      ),
    );
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain(
      'Connect a synced account to load saved drills and personalized plans.',
    );
    expect(findByLabel(renderer, 'Try again')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('a non-Error rejection still yields honest copy, never [object Object]', async () => {
    mockListCatalogDrills.mockRejectedValueOnce({ weird: true });
    const renderer = await renderScreen();
    const text = allText(renderer);
    expect(text).toContain('The drill catalog could not load.');
    expect(text).not.toContain('[object Object]');
    act(() => renderer.unmount());
  });
});

describe('Drill Library flow · detail + bookmark', () => {
  it('expand → loading → ready → collapse, without refetching on reopen', async () => {
    let resolveDetail!: (detail: DrillDetail) => void;
    mockGetDrill.mockReturnValue(
      new Promise<DrillDetail>(resolve => {
        resolveDetail = resolve;
      }),
    );
    const renderer = await renderScreen();
    const toggle = oneByLabel(renderer, 'Show detail for Dink Target Ladder');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });

    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    expect(allText(renderer)).toContain('Loading drill detail…');
    expect(
      oneByLabel(renderer, 'Hide detail for Dink Target Ladder').props
        .accessibilityState,
    ).toEqual({ expanded: true });

    await act(async () => resolveDetail(detailFixture));
    let text = allText(renderer);
    expect(text).not.toContain('Loading drill detail…');
    expect(text).toContain('Third Shot Sports');
    expect(text).toContain(youtubeMedia.attribution);

    await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
    text = allText(renderer);
    expect(text).not.toContain('Third Shot Sports');
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    expect(allText(renderer)).toContain('Third Shot Sports');
    expect(mockGetDrill).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('detail failure → inline copy + Retry → detail renders', async () => {
    mockGetDrill.mockRejectedValueOnce(
      new TrainingError('training.unavailable', OFFLINE_COPY, true),
    );
    const renderer = await renderScreen();
    await openDetail(renderer);
    const text = allText(renderer);
    expect(text).toContain(
      'Drill detail could not be loaded from this deployment.',
    );
    expect(text).toContain(OFFLINE_COPY);
    expect(text).not.toContain('Loading drill detail…');

    await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
    expect(mockGetDrill).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('Third Shot Sports');
    expect(allText(renderer)).not.toContain(
      'Drill detail could not be loaded from this deployment.',
    );
    act(() => renderer.unmount());
  });

  it('a detail without media renders no fake video row and still offers YouTube discovery', async () => {
    mockGetDrill.mockResolvedValueOnce({
      ...detailFixture,
      instructionalMedia: [],
    });
    const renderer = await renderScreen();
    await openDetail(renderer);
    expect(allText(renderer)).not.toContain('WATCH IT DONE');
    expect(allText(renderer)).toContain('More drills on YouTube');
    expect(
      findByLabel(renderer, 'Watch demonstration for Dink Target Ladder'),
    ).toHaveLength(0);
    expect(
      findByLabel(renderer, 'Browse YouTube videos for Dink Target Ladder'),
    ).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('bookmark: optimistic, single-flight under a double tap, toast, then un-save', async () => {
    let resolveSave!: () => void;
    mockSaveDrill.mockReturnValue(
      new Promise<void>(resolve => {
        resolveSave = resolve;
      }),
    );
    const renderer = await renderScreen();
    const save = oneByLabel(renderer, 'Save Dink Target Ladder');
    expect(save.props.accessibilityState).toEqual({
      selected: false,
      disabled: false,
    });

    // Double tap in the same tick: one network call, control disabled.
    await act(async () => {
      save.props.onPress();
      save.props.onPress();
    });
    expect(mockSaveDrill).toHaveBeenCalledTimes(1);
    const pending = oneByLabel(
      renderer,
      'Remove Dink Target Ladder from saved drills',
    );
    expect(pending.props.accessibilityState).toEqual({
      selected: true,
      disabled: true,
    });

    await act(async () => resolveSave());
    expect(allText(renderer)).toContain(
      'Saved to your library · Library → Saved drills',
    );
    const saved = oneByLabel(
      renderer,
      'Remove Dink Target Ladder from saved drills',
    );
    expect(saved.props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });

    await pressByLabel(renderer, 'Remove Dink Target Ladder from saved drills');
    expect(mockUnsaveDrill).toHaveBeenCalledWith('dink-target-ladder');
    expect(allText(renderer)).toContain('Removed from saved drills');
    expect(findByLabel(renderer, 'Save Dink Target Ladder')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('bookmark failure reverts and shows a dismissible inline error', async () => {
    mockSaveDrill.mockRejectedValueOnce(
      new TrainingError('training.unavailable', OFFLINE_COPY, true),
    );
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    expect(allText(renderer)).toContain(OFFLINE_COPY);
    expect(findByLabel(renderer, 'Save Dink Target Ladder')).toHaveLength(1);
    expect(allText(renderer)).not.toContain('Saved to your library');

    await pressByLabel(renderer, 'Dismiss error');
    expect(allText(renderer)).not.toContain(OFFLINE_COPY);

    // The control is live again after the failure.
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    expect(mockSaveDrill).toHaveBeenCalledTimes(2);
    expect(
      findByLabel(renderer, 'Remove Dink Target Ladder from saved drills'),
    ).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('YouTube discovery opens the results page externally and reports failure inline', async () => {
    const openUrl = spyOnOpenUrl();
    const renderer = await renderScreen();
    await openDetail(renderer);
    const label = 'Browse YouTube videos for Dink Target Ladder';
    await pressByLabel(renderer, label);
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/results?search_query=Dink%20Target%20Ladder%20pickleball%20drill',
    );
    expect(findByTestId(renderer, 'drill-video-player')).toHaveLength(0);

    openUrl.mockRejectedValueOnce(new Error('no handler'));
    await pressByLabel(renderer, label);
    expect(allText(renderer)).toContain(
      'YouTube could not be opened on this device.',
    );
    await pressByLabel(renderer, 'Dismiss error');
    expect(allText(renderer)).not.toContain(
      'YouTube could not be opened on this device.',
    );
    act(() => renderer.unmount());
  });
});

describe('Drill Library flow · in-app video ladder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('embed stage: referer-identified IFrame shell, loading overlay, ready message clears it', async () => {
    const openUrl = spyOnOpenUrl();
    const renderer = await renderScreen();
    await openPlayer(renderer);

    const source = webView(renderer).props.source;
    expect(source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    expect(source.html).toContain('youtube-nocookie.com');
    expect(source.html).toContain(youtubeMedia.videoId);
    expect(source.uri).toBeUndefined();
    expect(
      findByTestId(renderer, 'drill-video-embed-loading').length,
    ).toBeGreaterThan(0);
    expect(allText(renderer)).toContain(youtubeMedia.attribution);

    act(() => {
      webView(renderer).props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
      });
    });
    expect(findByTestId(renderer, 'drill-video-embed-loading')).toHaveLength(0);

    // A ready embed never times out into the watch page.
    act(() => {
      jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS + 1);
    });
    expect(webView(renderer).props.source.baseUrl).toBe(VIDEO_EMBED_REFERER);

    // Malformed messages are ignored.
    act(() => {
      webView(renderer).props.onMessage({ nativeEvent: { data: '{nope' } });
    });
    expect(webView(renderer).props.source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    expect(openUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('player error → canonical watch page (never /embed/) → load failure → error card → Open on YouTube', async () => {
    const openUrl = spyOnOpenUrl();
    const renderer = await renderScreen();
    await openPlayer(renderer);

    act(() => {
      webView(renderer).props.onMessage({
        nativeEvent: { data: JSON.stringify({ kind: 'error' }) },
      });
    });
    const watch = webView(renderer).props.source;
    expect(watch.uri).toBe(youtubeMedia.sourceUrl);
    expect(watch.uri).not.toContain('/embed/');
    expect(watch.headers).toEqual({ Referer: VIDEO_EMBED_REFERER });
    expect(findByTestId(renderer, 'drill-video-embed-loading')).toHaveLength(0);

    // A blocked subresource on the watch page must NOT kill playback.
    act(() => {
      webView(renderer).props.onHttpError({
        nativeEvent: { url: 'https://googleads.g.doubleclick.net/pagead' },
      });
    });
    expect(webView(renderer).props.source.uri).toBe(youtubeMedia.sourceUrl);

    act(() => {
      webView(renderer).props.onError();
    });
    expect(findByTestId(renderer, 'drill-video-webview')).toHaveLength(0);
    expect(findByTestId(renderer, 'drill-video-error').length).toBeGreaterThan(
      0,
    );
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );

    await pressByLabel(renderer, 'Open on YouTube');
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    for (const call of openUrl.mock.calls) {
      expect(String(call[0])).not.toContain('/embed/');
    }
    act(() => renderer.unmount());
  });

  it('watchdog: a silent embed falls to the watch page; Try again restarts the ladder', async () => {
    const renderer = await renderScreen();
    await openPlayer(renderer);
    act(() => {
      jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS - 1);
    });
    expect(webView(renderer).props.source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(webView(renderer).props.source.uri).toBe(youtubeMedia.sourceUrl);

    // Main-document HTTP error on the watch page → error card.
    act(() => {
      webView(renderer).props.onHttpError({
        nativeEvent: { url: `${youtubeMedia.sourceUrl}&feature=x` },
      });
    });
    expect(findByTestId(renderer, 'drill-video-error').length).toBeGreaterThan(
      0,
    );

    await pressByLabel(renderer, 'Try loading the video again');
    expect(findByTestId(renderer, 'drill-video-error')).toHaveLength(0);
    const source = webView(renderer).props.source;
    expect(source.baseUrl).toBe(VIDEO_EMBED_REFERER);
    expect(
      findByTestId(renderer, 'drill-video-embed-loading').length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('Close, backdrop Dismiss, and the hardware back request all unmount the player', async () => {
    const renderer = await renderScreen();
    await openPlayer(renderer);
    const close = oneByLabel(renderer, 'Close video player');
    expect(close.props.accessibilityRole).toBe('button');
    await pressByLabel(renderer, 'Close video player');
    expect(findByTestId(renderer, 'drill-video-player')).toHaveLength(0);
    // The screen underneath is untouched.
    expect(allText(renderer)).toContain('Third Shot Sports');

    await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
    await pressByLabel(renderer, 'Dismiss video');
    expect(findByTestId(renderer, 'drill-video-player')).toHaveLength(0);

    await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
    const modal = firstNode(
      renderer,
      n => typeof n.props.onRequestClose === 'function',
    );
    await act(async () => modal.props.onRequestClose());
    expect(findByTestId(renderer, 'drill-video-player')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('the "Watch on YouTube" footer link opens the canonical sourceUrl', async () => {
    const openUrl = spyOnOpenUrl();
    const renderer = await renderScreen();
    await openPlayer(renderer);
    const link = oneByLabel(renderer, 'Watch on YouTube');
    expect(link.props.accessibilityRole).toBe('button');
    await pressByLabel(renderer, 'Watch on YouTube');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    act(() => renderer.unmount());
  });
});
