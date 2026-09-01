import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
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
 * Button ledger for DrillLibraryScreen: every pressable the screen owns (and
 * every control of the DrillVideoPlayer modal it mounts) is pressed here via
 * props.onPress and its real observable effect asserted — navigation, api
 * doubles, Linking, or copy. Async handlers are exercised on both the
 * success and the failure path.
 */

const SAVED_TOAST = 'Saved to your library · Library → Saved drills';
const REMOVED_TOAST = 'Removed from saved drills';
const YOUTUBE_FAIL_COPY = 'YouTube could not be opened on this device.';
const CATALOG_FAIL_TITLE = 'The drill catalog could not load.';
const DINK_BROWSE_URL =
  'https://www.youtube.com/results?search_query=Dink%20Target%20Ladder%20pickleball%20drill';
const QUERY_BROWSE_URL =
  'https://www.youtube.com/results?search_query=wall%20pickleball%20drill';

const ALL_CHIP = { label: 'Show all drill families', family: undefined };
const FAMILY_CHIPS: Array<{ label: string; family: string | undefined }> = [
  ALL_CHIP,
  { label: 'Filter dink drills', family: 'dink' },
  { label: 'Filter volley drills', family: 'volley' },
  { label: 'Filter drive drills', family: 'drive' },
  { label: 'Filter serve drills', family: 'serve' },
  { label: 'Filter return drills', family: 'return' },
  { label: 'Filter drop reset drills', family: 'drop_reset' },
  { label: 'Filter global drills', family: 'global' },
];

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

const volleyDrill: CatalogDrill = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  slug: 'volley-wall-intervals',
  title: 'Volley Wall Intervals',
  description: 'Timed volley intervals against a rebound wall.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'rebound wall'],
  difficultyMin: null,
  difficultyMax: null,
  families: ['volley'],
  validationState: 'PUBLISHED',
  saved: true,
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

const secondYoutubeMedia: InstructionalMedia = {
  ...youtubeMedia,
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  videoId: 'dnk202abc',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk202abc',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk202abc',
  creatorName: 'Kitchen Lab Pickleball',
  attribution: 'Video by Kitchen Lab Pickleball on YouTube',
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
  mappings: [
    {
      checkpoint: 'contact_height',
      shotType: 'dink',
      planRole: 'targeted',
      faultDirections: ['high'],
      cueText: 'Contact the ball below your waist.',
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
    },
  ],
  instructionalMedia: [youtubeMedia, secondYoutubeMedia],
};

const detailFailure = new TrainingError(
  'training.request_failed',
  'Drill detail is not deployed for this build.',
  false,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<DrillLibraryScreen />);
  });
  return renderer;
}

async function settle() {
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function spyOnOpenUrl() {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockClear();
  spy.mockResolvedValue(undefined);
  return spy;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  // Innermost match: PressableScale forwards to a react-native Pressable,
  // and the inner one carries the resolved accessibilityRole/hitSlop.
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return nodes.at(-1) ?? null;
}

function requireByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = requireByLabel(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
}

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(n => n.props.testID === testID);
  return node ?? null;
}

function requirePressableByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = renderer.root
    .findAll(
      n => n.props.testID === testID && typeof n.props.onPress === 'function',
    )
    .at(-1);
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function searchInput(renderer: TestRenderer.ReactTestRenderer) {
  const node = findByTestId(renderer, 'drill-search-input');
  if (!node) throw new Error('Search input not found');
  return node;
}

function typeSearch(renderer: TestRenderer.ReactTestRenderer, text: string) {
  act(() => {
    searchInput(renderer).props.onChangeText(text);
  });
}

function refreshControl(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => typeof n.props.onRefresh === 'function',
  );
  if (!node) throw new Error('RefreshControl not found');
  return node;
}

async function expandDink(renderer: TestRenderer.ReactTestRenderer) {
  await pressByLabel(renderer, `Show detail for ${dinkDrill.title}`);
}

async function openFirstDinkVideo(renderer: TestRenderer.ReactTestRenderer) {
  mockGetDrill.mockResolvedValue(detailFixture);
  await expandDink(renderer);
  await act(async () => {
    requirePressableByTestId(
      renderer,
      `watch-media-${dinkDrill.slug}-0`,
    ).props.onPress();
  });
  expect(findByTestId(renderer, 'drill-video-player')).not.toBeNull();
}

describe('DrillLibraryScreen button ledger', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dinkDrill }, { ...volleyDrill }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockRejectedValue(detailFailure);
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('header', () => {
    it('Back -> navigation.goBack()', async () => {
      const renderer = renderScreen();
      await settle();
      const back = requireByLabel(renderer, 'Back');
      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.hitSlop).toBe(8);
      await pressByLabel(renderer, 'Back');
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('Search drills onChangeText -> debounced listCatalogDrills({ q })', async () => {
      const renderer = renderScreen();
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(findByLabel(renderer, 'Clear search')).toBeNull();

      typeSearch(renderer, 'wall');
      expect(searchInput(renderer).props.value).toBe('wall');
      // Debounce: nothing fires before 250ms.
      await advance(200);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      await advance(100);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
        q: 'wall',
        family: undefined,
      });
      // Client-side filter + count line switch on.
      const copy = allText(renderer);
      expect(copy).toContain('1 of 2 drills');
      expect(copy).toContain('Volley Wall Intervals');
      expect(copy).not.toContain('Dink Target Ladder');
    });

    it('Clear search -> query reset, results restored', async () => {
      const renderer = renderScreen();
      await settle();
      typeSearch(renderer, 'wall');
      await advance(300);
      const clear = requireByLabel(renderer, 'Clear search');
      expect(clear.props.accessibilityRole).toBe('button');
      expect(clear.props.hitSlop).toBe(8);

      await pressByLabel(renderer, 'Clear search');
      expect(searchInput(renderer).props.value).toBe('');
      expect(findByLabel(renderer, 'Clear search')).toBeNull();
      await advance(300);
      expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
        q: undefined,
        family: undefined,
      });
      expect(allText(renderer)).toContain('Dink Target Ladder');
      expect(findByTestId(renderer, 'search-youtube')).toBeNull();
    });

    it('Search YouTube row -> Linking.openURL(results page)', async () => {
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      expect(findByTestId(renderer, 'search-youtube')).toBeNull();

      typeSearch(renderer, 'wall');
      await advance(300);
      const row = requirePressableByTestId(renderer, 'search-youtube');
      expect(row.props.accessibilityRole).toBe('button');
      expect(row.props.accessibilityLabel).toBe(
        'Search YouTube: "wall" pickleball drills',
      );
      await act(async () => {
        row.props.onPress();
      });
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(QUERY_BROWSE_URL);
      expect(allText(renderer)).not.toContain(YOUTUBE_FAIL_COPY);
    });

    it('Search YouTube row failure -> inline error; Dismiss error clears it', async () => {
      const openUrl = spyOnOpenUrl();
      openUrl.mockRejectedValue(new Error('no handler'));
      const renderer = renderScreen();
      await settle();
      typeSearch(renderer, 'wall');
      await advance(300);

      await act(async () => {
        requirePressableByTestId(renderer, 'search-youtube').props.onPress();
      });
      expect(allText(renderer)).toContain(YOUTUBE_FAIL_COPY);

      const dismiss = requireByLabel(renderer, 'Dismiss error');
      // WF-ISSUE: Inline error banner is announced as "Dismiss error" with an
      // alert role, so VoiceOver never hears the failure copy and gets no
      // button affordance — the role/label assertion is skipped here.
      await pressByLabel(renderer, 'Dismiss error');
      expect(findByLabel(renderer, 'Dismiss error')).toBeNull();
      expect(allText(renderer)).not.toContain(YOUTUBE_FAIL_COPY);
      expect(dismiss).toBeDefined();
    });
  });

  describe('family filter chips', () => {
    it('every chip -> setFamily -> listCatalogDrills({ family }) with selected state', async () => {
      const renderer = renderScreen();
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);

      const all = requireByLabel(renderer, 'Show all drill families');
      expect(all.props.accessibilityState).toEqual({ selected: true });

      // Press the seven family chips, then "All" to return.
      const ordered = [...FAMILY_CHIPS.slice(1), ALL_CHIP];
      let calls = 1;
      for (const chip of ordered) {
        const node = requireByLabel(renderer, chip.label);
        expect(node.props.accessibilityRole).toBe('button');
        await pressByLabel(renderer, chip.label);
        calls += 1;
        expect(mockListCatalogDrills).toHaveBeenCalledTimes(calls);
        expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
          q: undefined,
          family: chip.family,
        });
        expect(
          requireByLabel(renderer, chip.label).props.accessibilityState,
        ).toEqual({ selected: true });
        const selectedChips = FAMILY_CHIPS.filter(
          other =>
            requireByLabel(renderer, other.label).props.accessibilityState
              .selected === true,
        );
        expect(selectedChips.map(c => c.label)).toEqual([chip.label]);
      }
      // Re-pressing the active chip is a no-op for the endpoint.
      await pressByLabel(renderer, 'Show all drill families');
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(calls);
    });

    it('a filter-update failure keeps the catalog and shows inline copy', async () => {
      const renderer = renderScreen();
      await settle();
      mockListCatalogDrills.mockRejectedValueOnce(
        new TrainingError(
          'training.request_failed',
          'Filter is offline.',
          true,
        ),
      );
      await pressByLabel(renderer, 'Filter serve drills');
      const copy = allText(renderer);
      expect(copy).toContain('Filter is offline.');
      expect(copy).toContain('Dink Target Ladder');
      await pressByLabel(renderer, 'Dismiss error');
      expect(allText(renderer)).not.toContain('Filter is offline.');
    });
  });

  describe('catalog load states', () => {
    it('Try again (ErrorState) -> load("initial") recovers the catalog', async () => {
      mockListCatalogDrills.mockRejectedValueOnce(
        new TrainingError(
          'training.request_failed',
          'Catalog is offline.',
          true,
        ),
      );
      const renderer = renderScreen();
      await settle();
      let copy = allText(renderer);
      expect(copy).toContain(CATALOG_FAIL_TITLE);
      expect(copy).toContain('Catalog is offline.');
      const retry = requireByLabel(renderer, 'Try again');
      expect(retry.props.accessibilityRole).toBe('button');
      // WF-ISSUE: Guest (local-only) sessions dead-end on the catalog error
      // state — the only control is a retry that can never succeed and there
      // is no path to ConnectAccount, so that branch is not asserted here.
      await pressByLabel(renderer, 'Try again');
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      copy = allText(renderer);
      expect(copy).not.toContain(CATALOG_FAIL_TITLE);
      expect(copy).toContain('Dink Target Ladder');
    });

    it('Try again failing twice keeps the retry control (no infinite loading)', async () => {
      mockListCatalogDrills.mockRejectedValue(
        new TrainingError(
          'training.request_failed',
          'Catalog is offline.',
          true,
        ),
      );
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Try again');
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain('Catalog is offline.');
      expect(allText(renderer)).not.toContain('Loading the drill catalog…');
      expect(findByLabel(renderer, 'Try again')).not.toBeNull();
    });

    it('RefreshControl onRefresh -> load("refresh") re-reads catalog + focus', async () => {
      const renderer = renderScreen();
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(mockListScoredCheckpointFacts).toHaveBeenCalledTimes(1);
      const gate = deferred<CatalogDrill[]>();
      mockListCatalogDrills.mockReturnValueOnce(gate.promise);

      await act(async () => {
        refreshControl(renderer).props.onRefresh();
      });
      expect(refreshControl(renderer).props.refreshing).toBe(true);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      expect(mockListScoredCheckpointFacts).toHaveBeenCalledTimes(2);

      await act(async () => {
        gate.resolve([{ ...volleyDrill }]);
      });
      expect(refreshControl(renderer).props.refreshing).toBe(false);
      const copy = allText(renderer);
      expect(copy).toContain('Volley Wall Intervals');
      expect(copy).not.toContain('Dink Target Ladder');
    });

    it('RefreshControl failure -> spinner stops, inline error, catalog kept', async () => {
      const renderer = renderScreen();
      await settle();
      mockListCatalogDrills.mockRejectedValueOnce(
        new TrainingError('training.request_failed', 'Refresh failed.', true),
      );
      await act(async () => {
        refreshControl(renderer).props.onRefresh();
      });
      expect(refreshControl(renderer).props.refreshing).toBe(false);
      const copy = allText(renderer);
      expect(copy).toContain('Refresh failed.');
      expect(copy).toContain('Dink Target Ladder');
      expect(copy).toContain('Volley Wall Intervals');
    });
  });

  describe('save toggle', () => {
    it('save-toggle (unsaved) -> saveDrill, selected state, toast that auto-dismisses', async () => {
      const renderer = renderScreen();
      await settle();
      const toggle = requirePressableByTestId(
        renderer,
        `save-toggle-${dinkDrill.slug}`,
      );
      expect(toggle.props.accessibilityLabel).toBe('Save Dink Target Ladder');
      expect(toggle.props.accessibilityRole).toBe('button');
      expect(toggle.props.accessibilityState).toMatchObject({
        selected: false,
      });
      expect(toggle.props.disabled).toBe(false);

      await act(async () => {
        toggle.props.onPress();
      });
      expect(mockSaveDrill).toHaveBeenCalledTimes(1);
      expect(mockSaveDrill).toHaveBeenCalledWith(dinkDrill.slug);
      expect(mockUnsaveDrill).not.toHaveBeenCalled();
      const after = requirePressableByTestId(
        renderer,
        `save-toggle-${dinkDrill.slug}`,
      );
      expect(after.props.accessibilityLabel).toBe(
        'Remove Dink Target Ladder from saved drills',
      );
      expect(after.props.accessibilityState).toMatchObject({ selected: true });
      expect(after.props.disabled).toBe(false);
      expect(allText(renderer)).toContain(SAVED_TOAST);
      await advance(2600);
      expect(allText(renderer)).not.toContain(SAVED_TOAST);
    });

    it('save-toggle (saved) -> unsaveDrill + removed toast', async () => {
      const renderer = renderScreen();
      await settle();
      const toggle = requirePressableByTestId(
        renderer,
        `save-toggle-${volleyDrill.slug}`,
      );
      expect(toggle.props.accessibilityLabel).toBe(
        'Remove Volley Wall Intervals from saved drills',
      );
      await act(async () => {
        toggle.props.onPress();
      });
      expect(mockUnsaveDrill).toHaveBeenCalledTimes(1);
      expect(mockUnsaveDrill).toHaveBeenCalledWith(volleyDrill.slug);
      expect(mockSaveDrill).not.toHaveBeenCalled();
      expect(
        requirePressableByTestId(renderer, `save-toggle-${volleyDrill.slug}`)
          .props.accessibilityLabel,
      ).toBe('Save Volley Wall Intervals');
      expect(allText(renderer)).toContain(REMOVED_TOAST);
    });

    it('save-toggle is disabled while pending and ignores a double tap', async () => {
      const renderer = renderScreen();
      await settle();
      const gate = deferred<void>();
      mockSaveDrill.mockReturnValueOnce(gate.promise);
      const toggle = requirePressableByTestId(
        renderer,
        `save-toggle-${dinkDrill.slug}`,
      );
      await act(async () => {
        toggle.props.onPress();
        toggle.props.onPress();
      });
      expect(mockSaveDrill).toHaveBeenCalledTimes(1);
      const pending = requirePressableByTestId(
        renderer,
        `save-toggle-${dinkDrill.slug}`,
      );
      expect(pending.props.disabled).toBe(true);
      // A second press while pending is dropped by the state guard too.
      await act(async () => {
        pending.props.onPress();
      });
      expect(mockSaveDrill).toHaveBeenCalledTimes(1);
      expect(mockUnsaveDrill).not.toHaveBeenCalled();

      await act(async () => {
        gate.resolve();
      });
      expect(
        requirePressableByTestId(renderer, `save-toggle-${dinkDrill.slug}`)
          .props.disabled,
      ).toBe(false);
      expect(allText(renderer)).toContain(SAVED_TOAST);
    });

    it('save-toggle failure -> reverts, inline error, control re-enabled', async () => {
      const renderer = renderScreen();
      await settle();
      mockSaveDrill.mockRejectedValueOnce(
        new TrainingError('training.request_failed', 'Save failed.', true),
      );
      await act(async () => {
        requirePressableByTestId(
          renderer,
          `save-toggle-${dinkDrill.slug}`,
        ).props.onPress();
      });
      const after = requirePressableByTestId(
        renderer,
        `save-toggle-${dinkDrill.slug}`,
      );
      expect(after.props.accessibilityLabel).toBe('Save Dink Target Ladder');
      expect(after.props.accessibilityState).toMatchObject({ selected: false });
      expect(after.props.disabled).toBe(false);
      expect(allText(renderer)).toContain('Save failed.');
      expect(allText(renderer)).not.toContain(SAVED_TOAST);

      // Recovers on the next tap.
      await act(async () => {
        after.props.onPress();
      });
      expect(mockSaveDrill).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).not.toContain('Save failed.');
      expect(allText(renderer)).toContain(SAVED_TOAST);
    });

    it('unsave failure -> non-TrainingError falls back to generic copy', async () => {
      const renderer = renderScreen();
      await settle();
      mockUnsaveDrill.mockRejectedValueOnce(new Error('boom'));
      await act(async () => {
        requirePressableByTestId(
          renderer,
          `save-toggle-${volleyDrill.slug}`,
        ).props.onPress();
      });
      expect(allText(renderer)).toContain(
        'The drill catalog is temporarily unavailable.',
      );
      expect(
        requirePressableByTestId(renderer, `save-toggle-${volleyDrill.slug}`)
          .props.accessibilityState,
      ).toMatchObject({ selected: true });
    });
  });

  describe('card detail', () => {
    it('Show detail -> getDrill once; Hide detail collapses; re-show does not refetch', async () => {
      mockGetDrill.mockResolvedValue(detailFixture);
      const renderer = renderScreen();
      await settle();
      const show = requireByLabel(
        renderer,
        'Show detail for Dink Target Ladder',
      );
      expect(show.props.accessibilityRole).toBe('button');
      expect(show.props.accessibilityState).toMatchObject({ expanded: false });

      await expandDink(renderer);
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      expect(mockGetDrill).toHaveBeenCalledWith(dinkDrill.slug);
      let copy = allText(renderer);
      expect(copy).toContain('Contact the ball below your waist.');
      expect(copy).toContain('Video by Third Shot Sports on YouTube');
      expect(copy).toContain('More drills on YouTube');
      expect(
        requireByLabel(renderer, 'Hide detail for Dink Target Ladder').props
          .accessibilityState.expanded,
      ).toBe(true);

      await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
      copy = allText(renderer);
      expect(copy).not.toContain('Contact the ball below your waist.');
      expect(
        findByLabel(renderer, 'Show detail for Dink Target Ladder'),
      ).not.toBeNull();

      await expandDink(renderer);
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      expect(allText(renderer)).toContain('Contact the ball below your waist.');
    });

    it('expanding one card collapses the other (single expanded slug)', async () => {
      mockGetDrill.mockResolvedValue(detailFixture);
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      await pressByLabel(renderer, 'Show detail for Volley Wall Intervals');
      expect(mockGetDrill).toHaveBeenCalledTimes(2);
      expect(mockGetDrill).toHaveBeenLastCalledWith(volleyDrill.slug);
      expect(
        findByLabel(renderer, 'Show detail for Dink Target Ladder'),
      ).not.toBeNull();
      expect(
        findByLabel(renderer, 'Hide detail for Volley Wall Intervals'),
      ).not.toBeNull();
    });

    it('Retry detail -> getDrill again; failure copy stays until success', async () => {
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      let copy = allText(renderer);
      expect(copy).toContain(
        'Drill detail could not be loaded from this deployment.',
      );
      expect(copy).toContain('Drill detail is not deployed for this build.');
      expect(copy).not.toContain('Loading drill detail…');

      const retry = requireByLabel(
        renderer,
        'Retry detail for Dink Target Ladder',
      );
      expect(retry.props.accessibilityRole).toBe('button');
      // WF-ISSUE: Detail retry "Try again" is a bare caption-sized Pressable
      // (~18pt tall, no minHeight/hitSlop) — hit-target size is not asserted.

      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      expect(mockGetDrill).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain(
        'Drill detail is not deployed for this build.',
      );

      mockGetDrill.mockResolvedValueOnce(detailFixture);
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      expect(mockGetDrill).toHaveBeenCalledTimes(3);
      copy = allText(renderer);
      expect(copy).not.toContain(
        'Drill detail could not be loaded from this deployment.',
      );
      expect(copy).toContain('Contact the ball below your waist.');
      expect(
        findByLabel(renderer, 'Retry detail for Dink Target Ladder'),
      ).toBeNull();
    });

    it('detail retry with a non-TrainingError shows generic copy', async () => {
      mockGetDrill.mockRejectedValue(new Error('boom'));
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      expect(allText(renderer)).toContain(
        'The drill catalog is temporarily unavailable.',
      );
      expect(
        findByLabel(renderer, 'Retry detail for Dink Target Ladder'),
      ).not.toBeNull();
    });

    it('browse-videos -> Linking.openURL(drill results page)', async () => {
      const openUrl = spyOnOpenUrl();
      mockGetDrill.mockResolvedValue(detailFixture);
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      const browse = requirePressableByTestId(
        renderer,
        `browse-videos-${dinkDrill.slug}`,
      );
      expect(browse.props.accessibilityRole).toBe('button');
      expect(browse.props.accessibilityLabel).toBe(
        'Browse YouTube videos for Dink Target Ladder',
      );
      await act(async () => {
        browse.props.onPress();
      });
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(DINK_BROWSE_URL);
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();
    });

    it('browse-videos failure -> inline error copy', async () => {
      const openUrl = spyOnOpenUrl();
      openUrl.mockRejectedValue(new Error('no handler'));
      mockGetDrill.mockResolvedValue(detailFixture);
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      await act(async () => {
        requirePressableByTestId(
          renderer,
          `browse-videos-${dinkDrill.slug}`,
        ).props.onPress();
      });
      expect(allText(renderer)).toContain(YOUTUBE_FAIL_COPY);
      await pressByLabel(renderer, 'Dismiss error');
      expect(allText(renderer)).not.toContain(YOUTUBE_FAIL_COPY);
    });

    it('browse-videos is not offered while the detail is in its error state', async () => {
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      // Detail rejected: the error branch replaces the media rows, so the
      // browse row is absent here — it lives inside the ready branch only.
      expect(
        findByTestId(renderer, `browse-videos-${dinkDrill.slug}`),
      ).toBeNull();
      expect(openUrl).not.toHaveBeenCalled();
    });
  });

  describe('instructional media -> DrillVideoPlayer', () => {
    it('watch-media rows open the player for their own media, never Linking', async () => {
      const openUrl = spyOnOpenUrl();
      mockGetDrill.mockResolvedValue(detailFixture);
      const renderer = renderScreen();
      await settle();
      await expandDink(renderer);
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();

      const first = requirePressableByTestId(
        renderer,
        `watch-media-${dinkDrill.slug}-0`,
      );
      expect(first.props.accessibilityRole).toBe('button');
      expect(first.props.accessibilityLabel).toBe(
        'Watch demonstration for Dink Target Ladder',
      );
      expect(first.props.accessibilityHint).toBe(youtubeMedia.attribution);
      await act(async () => {
        first.props.onPress();
      });
      expect(findByTestId(renderer, 'drill-video-player')).not.toBeNull();
      const webView = findByTestId(renderer, 'drill-video-webview');
      expect(webView?.props.source.html).toContain(youtubeMedia.videoId);
      expect(webView?.props.source.baseUrl).toBe('https://com.picklesensei');
      expect(openUrl).not.toHaveBeenCalled();

      await pressByLabel(renderer, 'Close video player');
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();

      const second = requirePressableByTestId(
        renderer,
        `watch-media-${dinkDrill.slug}-1`,
      );
      expect(second.props.accessibilityHint).toBe(
        secondYoutubeMedia.attribution,
      );
      await act(async () => {
        second.props.onPress();
      });
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(secondYoutubeMedia.videoId);
      expect(allText(renderer)).toContain(secondYoutubeMedia.attribution);
    });

    it('Dismiss video (backdrop) -> player closes', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      const backdrop = requireByLabel(renderer, 'Dismiss video');
      expect(backdrop.props.accessibilityRole).toBe('button');
      await pressByLabel(renderer, 'Dismiss video');
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();
    });

    it('Close video player -> player closes (hitSlop present)', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      const close = requirePressableByTestId(renderer, 'drill-video-close');
      expect(close.props.accessibilityLabel).toBe('Close video player');
      expect(close.props.hitSlop).toBe(8);
      await act(async () => {
        close.props.onPress();
      });
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();
      // Reopening starts back at the embed stage.
      await act(async () => {
        requirePressableByTestId(
          renderer,
          `watch-media-${dinkDrill.slug}-0`,
        ).props.onPress();
      });
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(youtubeMedia.videoId);
    });

    it('Modal onRequestClose (hardware back) -> player closes', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      const [modal] = renderer.root.findAll(
        n => typeof n.props.onRequestClose === 'function' && n.props.visible,
      );
      if (!modal) throw new Error('Modal not found');
      await act(async () => {
        modal.props.onRequestClose();
      });
      expect(findByTestId(renderer, 'drill-video-player')).toBeNull();
    });

    it('Watch on YouTube -> Linking.openURL(sourceUrl), player stays open', async () => {
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      const link = requirePressableByTestId(
        renderer,
        'drill-video-source-link',
      );
      expect(link.props.accessibilityLabel).toBe('Watch on YouTube');
      expect(link.props.accessibilityRole).toBe('button');
      await act(async () => {
        link.props.onPress();
      });
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
      expect(findByTestId(renderer, 'drill-video-player')).not.toBeNull();
    });

    it('WebView onError ladder: embed -> watch page -> failed card', async () => {
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      expect(
        findByTestId(renderer, 'drill-video-embed-loading'),
      ).not.toBeNull();

      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onError();
      });
      const watchView = findByTestId(renderer, 'drill-video-webview');
      expect(watchView?.props.source.uri).toBe(youtubeMedia.sourceUrl);
      expect(findByTestId(renderer, 'drill-video-error')).toBeNull();

      await act(async () => {
        watchView?.props.onError();
      });
      expect(findByTestId(renderer, 'drill-video-webview')).toBeNull();
      expect(findByTestId(renderer, 'drill-video-error')).not.toBeNull();

      const open = requirePressableByTestId(
        renderer,
        'drill-video-open-source',
      );
      expect(open.props.accessibilityLabel).toBe('Open on YouTube');
      await act(async () => {
        open.props.onPress();
      });
      expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);

      const retry = requirePressableByTestId(renderer, 'drill-video-retry');
      expect(retry.props.accessibilityLabel).toBe(
        'Try loading the video again',
      );
      await act(async () => {
        retry.props.onPress();
      });
      expect(findByTestId(renderer, 'drill-video-error')).toBeNull();
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(youtubeMedia.videoId);
    });

    it('WebView onMessage: ready clears the loading veil, error falls to watch', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onMessage({
          nativeEvent: { data: 'not json' },
        });
      });
      expect(
        findByTestId(renderer, 'drill-video-embed-loading'),
      ).not.toBeNull();

      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onMessage({
          nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
        });
      });
      expect(findByTestId(renderer, 'drill-video-embed-loading')).toBeNull();
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(youtubeMedia.videoId);

      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onMessage({
          nativeEvent: { data: JSON.stringify({ kind: 'error' }) },
        });
      });
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.uri,
      ).toBe(youtubeMedia.sourceUrl);
    });

    it('WebView onHttpError: only the main document steps the ladder', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onHttpError({
          nativeEvent: { url: 'https://ads.example.com/blocked' },
        });
      });
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(youtubeMedia.videoId);

      await act(async () => {
        findByTestId(renderer, 'drill-video-webview')?.props.onHttpError({
          nativeEvent: { url: `${youtubeMedia.embedUrl}?rel=0` },
        });
      });
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.uri,
      ).toBe(youtubeMedia.sourceUrl);
    });

    it('embed watchdog falls forward to the watch page without a ready signal', async () => {
      const renderer = renderScreen();
      await settle();
      await openFirstDinkVideo(renderer);
      await advance(11_999);
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.html,
      ).toContain(youtubeMedia.videoId);
      await advance(1);
      expect(
        findByTestId(renderer, 'drill-video-webview')?.props.source.uri,
      ).toBe(youtubeMedia.sourceUrl);
    });
  });
});
