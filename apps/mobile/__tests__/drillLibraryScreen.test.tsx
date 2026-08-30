import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../src/training/api';
import {
  TrainingError,
  type DrillDetail,
  type InstructionalMedia,
} from '../src/training/types';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

const mockListCatalogDrills = jest.fn<
  Promise<CatalogDrill[]>,
  [{ q?: string; family?: string }]
>();
const mockSaveDrill = jest.fn<Promise<void>, [string]>();
const mockUnsaveDrill = jest.fn<Promise<void>, [string]>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

import { DrillLibraryScreen } from '../src/screens/DrillLibraryScreen';

/**
 * Pins the honest drill-library surface: every card carries the UNVALIDATED
 * engineering-draft label and the server's coach line verbatim, search is
 * debounced and filters both client-side and via the endpoint, and the save
 * bookmark is optimistic but reverts loudly when the server refuses.
 *
 * Video honesty is pinned too: every served instructional video is listed
 * with creator + attribution verbatim under a single community-video
 * disclosure, and the only "more videos" affordances are real YouTube
 * search deep links (per drill, and per typed query) — no fabricated video
 * IDs or counts.
 */

const DRAFT_PILL = 'UNVALIDATED · ENGINEERING DRAFT';
const DISCLOSURE = 'Community video · not Pickle Sensei coach-validated';
const DINK_BROWSE_URL =
  'https://www.youtube.com/results?search_query=Dink%20Target%20Ladder%20pickleball%20drill';

const dinkDrill: CatalogDrill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coachName: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficultyMin: '2.0',
  difficultyMax: '3.5',
  families: ['dink'],
  validationState: 'UNVALIDATED',
  saved: false,
};

const volleyDrill: CatalogDrill = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  slug: 'volley-wall-intervals',
  title: 'Volley Wall Intervals',
  description: 'Timed volley intervals against a rebound wall.',
  coachName: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'rebound wall'],
  difficultyMin: null,
  difficultyMax: null,
  families: ['volley'],
  validationState: 'UNVALIDATED',
  saved: true,
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
  instructionalMedia: [],
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
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk202abc',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk202abc',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk202abc',
  creatorName: 'Kitchen Lab Pickleball',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Kitchen Lab Pickleball on YouTube',
};

const detailWithMediaFixture: DrillDetail = {
  ...detailFixture,
  instructionalMedia: [youtubeMedia],
};

const detailWithTwoMediaFixture: DrillDetail = {
  ...detailFixture,
  instructionalMedia: [youtubeMedia, secondYoutubeMedia],
};

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<DrillLibraryScreen />);
  });
  return renderer;
}

/**
 * The RN jest preset already installs Linking.openURL as a shared jest.fn,
 * so spyOn returns that same instance; clear it to isolate per-test calls.
 */
function spyOnOpenUrl() {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockClear();
  spy.mockResolvedValue(undefined);
  return spy;
}

async function settle() {
  await act(async () => {});
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function draftPillCount(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root
    .findAllByType(Text)
    .filter(node => node.props.children === DRAFT_PILL).length;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

function findPressableByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

async function pressByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = findPressableByTestId(renderer, testID);
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  await act(async () => {
    node.props.onPress();
  });
}

function textCount(
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
): number {
  return renderer.root
    .findAllByType(Text)
    .filter(node => node.props.children === text).length;
}

function typeSearch(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const [input] = renderer.root.findAll(
    n => n.props.testID === 'drill-search-input',
  );
  if (!input) throw new Error('Search input not found');
  act(() => {
    input.props.onChangeText(text);
  });
}

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

describe('DrillLibraryScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dinkDrill }, { ...volleyDrill }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill
      .mockReset()
      .mockRejectedValue(
        new TrainingError(
          'training.request_failed',
          'Drill detail is not deployed for this build.',
          false,
        ),
      );
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    // Restores any Linking spies without touching the module-level jest.fn
    // doubles reset in beforeEach.
    jest.restoreAllMocks();
  });

  it('renders every catalog drill with the honest engineering-draft label', async () => {
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(copy).toContain('Volley Wall Intervals');
    expect(copy).toContain('Engineering draft — not coach-validated');
    expect(copy).toContain('PADDLE · BALLS');
    expect(copy).toContain('SKILL 2.0–3.5');
    expect(copy).toContain('none coach-validated yet');
    expect(draftPillCount(renderer)).toBe(2);
    expect(mockListCatalogDrills).toHaveBeenCalledWith({
      q: undefined,
      family: undefined,
    });
    act(() => renderer.unmount());
  });

  it('debounces search, filters client-side, and forwards q to the endpoint', async () => {
    const renderer = renderScreen();
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    typeSearch(renderer, 'wall');
    // Nothing is refetched until the debounce window elapses.
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    await advanceDebounce();
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
      q: 'wall',
      family: undefined,
    });
    // The server double still returns both drills; the client-side filter
    // over title+description+equipment hides the non-matching one.
    const copy = allText(renderer);
    expect(copy).toContain('Volley Wall Intervals');
    expect(copy).not.toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('single-select family pills pass the family param through', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Filter volley drills');
    expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
      q: undefined,
      family: 'volley',
    });
    await pressByLabel(renderer, 'Filter drop reset drills');
    expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
      q: undefined,
      family: 'drop_reset',
    });
    await pressByLabel(renderer, 'Show all drill families');
    expect(mockListCatalogDrills).toHaveBeenLastCalledWith({
      q: undefined,
      family: undefined,
    });
    act(() => renderer.unmount());
  });

  it('saves optimistically through the api and flips the bookmark', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    expect(mockSaveDrill).toHaveBeenCalledWith('dink-target-ladder');
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel ===
            'Remove Dink Target Ladder from saved drills' &&
          typeof n.props.onPress === 'function',
      ).length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('unsaves an already-saved drill through the api', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(
      renderer,
      'Remove Volley Wall Intervals from saved drills',
    );
    expect(mockUnsaveDrill).toHaveBeenCalledWith('volley-wall-intervals');
    act(() => renderer.unmount());
  });

  it('reverts the optimistic save and surfaces the error when saving fails', async () => {
    mockSaveDrill.mockRejectedValue(
      new TrainingError(
        'training.unavailable',
        'Saving is offline right now.',
        true,
      ),
    );
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    await settle();
    // Reverted: the card offers "Save" again, and the failure is visible.
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Save Dink Target Ladder' &&
          typeof n.props.onPress === 'function',
      ).length,
    ).toBeGreaterThan(0);
    expect(allText(renderer)).toContain('Saving is offline right now.');
    act(() => renderer.unmount());
  });

  it('shows the empty state when no drill matches the search', async () => {
    const renderer = renderScreen();
    await settle();
    typeSearch(renderer, 'zzzz-no-such-drill');
    await advanceDebounce();
    await settle();
    expect(allText(renderer)).toContain('No drills match');
    act(() => renderer.unmount());
  });

  it('shows an error state with retry when the catalog fails to load', async () => {
    mockListCatalogDrills.mockRejectedValueOnce(
      new TrainingError(
        'training.unavailable',
        'Training is temporarily offline.',
        true,
      ),
    );
    const renderer = renderScreen();
    await settle();
    const failedCopy = allText(renderer);
    expect(failedCopy).toContain('The drill catalog could not load.');
    expect(failedCopy).toContain('Training is temporarily offline.');
    await pressByLabel(renderer, 'Try again');
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('handles a failing drill-detail endpoint with an inline error, not a crash', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(allText(renderer)).toContain(
      'Drill detail could not be loaded from this deployment.',
    );
    expect(allText(renderer)).toContain(
      'Drill detail is not deployed for this build.',
    );
    // A later retry can still succeed without reloading the screen.
    mockGetDrill.mockResolvedValueOnce(detailFixture);
    await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
    await settle();
    expect(allText(renderer)).toContain(
      'No reviewed prescription is published for this drill yet.',
    );
    act(() => renderer.unmount());
  });

  it('renders the WATCH row with verbatim attribution for embed media and opens the source URL', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('WATCH: real coach demonstration');
    // Creator + attribution are mandatory display, rendered verbatim.
    expect(copy).toContain('Third Shot Sports');
    expect(copy).toContain('Video by Third Shot Sports on YouTube');
    // The row never implies Pickle Sensei's own coaches made the video.
    expect(copy).toContain(
      'Community video · not Pickle Sensei coach-validated',
    );
    expect(copy).toContain('1 instructional video');
    expect(openUrl).not.toHaveBeenCalled();
    await pressByLabel(
      renderer,
      'Watch real coach demonstration for Dink Target Ladder',
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=dnk101xyz',
    );
    act(() => renderer.unmount());
  });

  it('keeps the honest no-video line and offers no WATCH row when media is empty', async () => {
    mockGetDrill.mockResolvedValue(detailFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('no rights-cleared video yet');
    expect(copy).not.toContain('WATCH: real coach demonstration');
    expect(copy).not.toContain(
      'Community video · not Pickle Sensei coach-validated',
    );
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel ===
            'Watch real coach demonstration for Dink Target Ladder' &&
          typeof n.props.onPress === 'function',
      ),
    ).toHaveLength(0);
    expect(openUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('lists every served video with verbatim attribution under one disclosure', async () => {
    mockGetDrill.mockResolvedValue(detailWithTwoMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    // Both curated videos render as full WATCH rows with mandatory credits.
    expect(textCount(renderer, 'WATCH: real coach demonstration')).toBe(2);
    expect(copy).toContain('Third Shot Sports');
    expect(copy).toContain('Video by Third Shot Sports on YouTube');
    expect(copy).toContain('Kitchen Lab Pickleball');
    expect(copy).toContain('Video by Kitchen Lab Pickleball on YouTube');
    expect(copy).toContain('2 instructional videos');
    // One shared disclosure for the whole list, not one per row.
    expect(textCount(renderer, DISCLOSURE)).toBe(1);
    expect(
      findPressableByTestId(renderer, 'watch-media-dink-target-ladder-0'),
    ).not.toBeNull();
    await pressByTestId(renderer, 'watch-media-dink-target-ladder-1');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=dnk202abc',
    );
    act(() => renderer.unmount());
  });

  it('offers the YouTube browse row under curated media and opens the encoded search', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Browse hundreds more on YouTube');
    expect(copy).toContain('Search results on YouTube · community videos');
    await pressByTestId(renderer, 'browse-videos-dink-target-ladder');
    expect(openUrl).toHaveBeenCalledTimes(1);
    // A real YouTube results deep link for "<title> pickleball drill".
    expect(openUrl).toHaveBeenCalledWith(DINK_BROWSE_URL);
    act(() => renderer.unmount());
  });

  it('keeps the YouTube browse row when the drill has zero curated videos', async () => {
    mockGetDrill.mockResolvedValue(detailFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('no rights-cleared video yet');
    expect(copy).toContain('Browse hundreds more on YouTube');
    await pressByLabel(
      renderer,
      'Browse YouTube videos for Dink Target Ladder',
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(DINK_BROWSE_URL);
    act(() => renderer.unmount());
  });

  it('surfaces the YouTube search row for a debounced query and removes it when cleared', async () => {
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    expect(findPressableByTestId(renderer, 'search-youtube')).toBeNull();
    typeSearch(renderer, 'kitchen dinks');
    // The row keys off the debounced query, so nothing appears mid-typing.
    expect(findPressableByTestId(renderer, 'search-youtube')).toBeNull();
    await advanceDebounce();
    await settle();
    expect(allText(renderer)).toContain(
      'Search YouTube: "kitchen dinks" pickleball drills',
    );
    await pressByTestId(renderer, 'search-youtube');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/results?search_query=kitchen%20dinks%20pickleball%20drill',
    );
    typeSearch(renderer, '');
    await advanceDebounce();
    await settle();
    expect(findPressableByTestId(renderer, 'search-youtube')).toBeNull();
    act(() => renderer.unmount());
  });
});
