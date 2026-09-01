import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../src/training/api';
import type { ScoredCheckpointFact } from '../src/library/libraryFocus';
import {
  TrainingError,
  type DrillDetail,
  type DrillMapping,
  type InstructionalMedia,
} from '../src/training/types';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

// In-app playback runs through react-native-webview; a passthrough View
// keeps every prop (source, onError, testID) inspectable in the tree.
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

// The screen reads local checkpoint evidence for its focus; the SQLite
// binding does not exist under jest, so both layers are doubled.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
const mockListScoredCheckpointFacts = jest.fn<
  Promise<ScoredCheckpointFact[]>,
  [unknown]
>();
jest.mock('../src/data/repository', () => ({
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
 * Pins the production drill-library surface: the default view is a learning
 * surface — a focus card computed from local scored evidence, family-matched
 * recommendations under it, then the rest of the catalog — while search and
 * family filters switch to plain results. Cards lead with one quiet metadata
 * line (no internal validation-state or draft messaging, whatever the
 * payload says), clean coach bylines render while internal draft bylines are
 * hidden, search is debounced and filters both client-side and via the
 * endpoint, and the save bookmark is optimistic with a transient toast on
 * success and a loud revert on failure.
 *
 * Video honesty is pinned too: the expanded form guide lists the server's
 * coaching cues before any video, every served instructional video renders
 * with creator + attribution verbatim, playback happens in-app through the
 * DrillVideoPlayer WebView modal (never Linking), and only the YouTube
 * search-results rows (per drill, and per typed query) open externally.
 */

const DISCLOSURE = 'Community videos · credited to their creators';
const SAVED_TOAST = 'Saved to your library · Library → Saved drills';
const REMOVED_TOAST = 'Removed from saved drills';
const DINK_BROWSE_URL =
  'https://www.youtube.com/results?search_query=Dink%20Target%20Ladder%20pickleball%20drill';
const FOCUS_HINT =
  'After two scored analyses of the same technique, this library sorts ' +
  'itself around your weakest checkpoint.';

// Legacy engineering payload: the client must still look production-clean.
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

// Production payload: a clean byline renders as a subtle caption.
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

const cueMapping: DrillMapping = {
  checkpoint: 'contact_height',
  shotType: 'dink',
  planRole: 'targeted',
  faultDirections: ['high'],
  cueText: 'Contact the ball below your waist.',
  targetSets: 3,
  targetRepetitionsPerSet: 10,
  targetDurationSeconds: null,
  restSeconds: 30,
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
  mappings: [cueMapping],
  instructionalMedia: [youtubeMedia],
};

const detailWithTwoMediaFixture: DrillDetail = {
  ...detailFixture,
  instructionalMedia: [youtubeMedia, secondYoutubeMedia],
};

/** Two scored dink reads whose weakest checkpoint is contact_position —
 * recency-weighted (2·50 + 1·60) / 3 ≈ 53. */
function dinkFocusFacts(): ScoredCheckpointFact[] {
  return [
    {
      id: '00000000-0000-4000-8000-000000000002',
      shotType: 'dink',
      capturedAt: '2026-08-02T10:00:00.000Z',
      checkpoints: [
        { key: 'contact_position', score: 50, applicable: true },
        { key: 'athletic_base', score: 80, applicable: true },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000001',
      shotType: 'dink',
      capturedAt: '2026-08-01T10:00:00.000Z',
      checkpoints: [
        { key: 'contact_position', score: 60, applicable: true },
        { key: 'athletic_base', score: 82, applicable: true },
      ],
    },
  ];
}

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

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(n => n.props.testID === testID);
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

/** Rendered drill-card testIDs in tree (top-to-bottom) order. Host nodes
 * only: composite wrappers repeat the same testID prop. */
function drillCardOrder(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('drill-card-'),
    )
    .map(n => n.props.testID as string);
}

/** The in-app player's WebView node, or null while the modal is closed. */
function findPlayerWebView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-webview' && n.props.source,
  );
  return node ?? null;
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
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    // Restores any Linking spies without touching the module-level jest.fn
    // doubles reset in beforeEach.
    jest.restoreAllMocks();
  });

  it('renders a production-clean catalog with one quiet metadata line per card', async () => {
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(copy).toContain('Volley Wall Intervals');
    // Family, skill band, and equipment collapse into a single sentence-case
    // line — no shouting pill rows.
    expect(textCount(renderer, 'Dinks · Skill 2.0–3.5 · Paddle, balls')).toBe(
      1,
    );
    expect(textCount(renderer, 'Volleys · Paddle, rebound wall')).toBe(1);
    // The default view is a learning surface, not a result set: the count
    // line only appears once the user searches or filters.
    expect(copy).not.toContain('of 2 drills');
    // No internal validation-state or draft messaging, whatever the payload.
    expect(copy).not.toMatch(/UNVALIDATED/i);
    expect(copy).not.toMatch(/engineering draft/i);
    expect(copy).not.toMatch(/coach-validated/i);
    expect(copy).not.toContain('PUBLISHED');
    expect(mockListCatalogDrills).toHaveBeenCalledWith({
      q: undefined,
      family: undefined,
    });
    act(() => renderer.unmount());
  });

  it('advertises the form-guide affordance on every card', async () => {
    const renderer = renderScreen();
    await settle();
    // Every collapsed card carries an explicit call to action, so the form
    // cues and videos are never hidden behind an unlabeled tap target.
    expect(textCount(renderer, 'Form guide & videos')).toBe(2);
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(textCount(renderer, 'Hide form guide')).toBe(1);
    expect(textCount(renderer, 'Form guide & videos')).toBe(1);
    // Collapsing restores the invitation.
    await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
    expect(textCount(renderer, 'Form guide & videos')).toBe(2);
    act(() => renderer.unmount());
  });

  it('shows a clean server byline but hides the internal draft byline', async () => {
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    // volleyDrill's production byline renders as a caption…
    expect(copy).toContain('Pickle Sensei Training Library');
    // …while dinkDrill's internal seeding byline never reaches users.
    expect(copy).not.toContain('Engineering draft — not coach-validated');
    act(() => renderer.unmount());
  });

  it('sorts the default view around the weakest evidenced checkpoint', async () => {
    mockListScoredCheckpointFacts.mockResolvedValue(dinkFocusFacts());
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    // The focus card names the checkpoint, its recency-weighted average,
    // and exactly the evidence behind it — computed locally.
    expect(findByTestId(renderer, 'library-focus')).not.toBeNull();
    expect(copy).toContain('YOUR FOCUS');
    expect(copy).toContain('Contact position');
    expect(textCount(renderer, '53')).toBe(1);
    expect(copy).toContain('Dink · from 2 recent scored reads');
    // Family-matched drills lead, with the matching rule stated verbatim —
    // no claim that a specific drill was validated for the checkpoint.
    expect(copy).toContain('Recommended for you');
    expect(copy).toContain('Matched to your focus by technique family.');
    expect(copy).toContain('All drills');
    expect(drillCardOrder(renderer)).toEqual([
      'drill-card-dink-target-ladder',
      'drill-card-volley-wall-intervals',
    ]);
    // The empty-evidence hint never renders alongside a real focus.
    expect(findByTestId(renderer, 'library-focus-hint')).toBeNull();
    expect(copy).not.toContain(FOCUS_HINT);
    act(() => renderer.unmount());
  });

  it('shows the honest hint instead of a focus when evidence is thin', async () => {
    const renderer = renderScreen();
    await settle();
    expect(findByTestId(renderer, 'library-focus')).toBeNull();
    expect(findByTestId(renderer, 'library-focus-hint')).not.toBeNull();
    const copy = allText(renderer);
    expect(copy).toContain(FOCUS_HINT);
    expect(copy).not.toContain('Recommended for you');
    expect(copy).not.toContain('YOUR FOCUS');
    act(() => renderer.unmount());
  });

  it('never lets a failing local evidence read block the catalog', async () => {
    mockListScoredCheckpointFacts.mockRejectedValue(
      new Error('local db unavailable'),
    );
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(findByTestId(renderer, 'library-focus')).toBeNull();
    expect(copy).not.toContain('Recommended for you');
    act(() => renderer.unmount());
  });

  it('drops the personalized sections while searching or filtering', async () => {
    mockListScoredCheckpointFacts.mockResolvedValue(dinkFocusFacts());
    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).toContain('YOUR FOCUS');
    typeSearch(renderer, 'wall');
    await advanceDebounce();
    await settle();
    let copy = allText(renderer);
    expect(copy).not.toContain('YOUR FOCUS');
    expect(copy).not.toContain('Recommended for you');
    expect(copy).toContain('1 of 2 drills');
    typeSearch(renderer, '');
    await advanceDebounce();
    await settle();
    copy = allText(renderer);
    expect(copy).toContain('YOUR FOCUS');
    expect(copy).toContain('Recommended for you');
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
    expect(copy).toContain('1 of 2 drills');
    act(() => renderer.unmount());
  });

  it('single-select family chips pass the family param through', async () => {
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

  it('saves optimistically, flips the bookmark, and confirms with a toast', async () => {
    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).not.toContain(SAVED_TOAST);
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
    // Non-blocking confirmation, gone again after the auto-dismiss window.
    expect(allText(renderer)).toContain(SAVED_TOAST);
    await act(async () => {
      jest.advanceTimersByTime(2600);
    });
    expect(allText(renderer)).not.toContain(SAVED_TOAST);
    act(() => renderer.unmount());
  });

  it('unsaves an already-saved drill and confirms the removal', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(
      renderer,
      'Remove Volley Wall Intervals from saved drills',
    );
    expect(mockUnsaveDrill).toHaveBeenCalledWith('volley-wall-intervals');
    expect(allText(renderer)).toContain(REMOVED_TOAST);
    act(() => renderer.unmount());
  });

  it('reverts the optimistic save, surfaces the error, and shows no toast', async () => {
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
    const copy = allText(renderer);
    expect(copy).toContain('Saving is offline right now.');
    expect(copy).not.toContain(SAVED_TOAST);
    act(() => renderer.unmount());
  });

  it('shows the clean empty state when no drill matches the search', async () => {
    const renderer = renderScreen();
    await settle();
    typeSearch(renderer, 'zzzz-no-such-drill');
    await advanceDebounce();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('No drills match');
    expect(copy).toContain('Try a different search or family filter.');
    expect(copy).not.toMatch(/engineering draft/i);
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
    const copy = allText(renderer);
    expect(copy).toContain('More drills on YouTube');
    // An empty detail fabricates nothing: no form-focus header without
    // mappings, no video header without media, no draft caveats.
    expect(copy).not.toContain('FORM FOCUS');
    expect(copy).not.toContain('WATCH IT DONE');
    expect(copy).not.toMatch(/reviewed prescription/i);
    expect(copy).not.toContain('no rights-cleared video yet');
    act(() => renderer.unmount());
  });

  it('leads the expanded detail with the form guide, before any video', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    // The cue is real learning content: instruction, checkpoint, targets.
    expect(copy).toContain('FORM FOCUS');
    expect(copy).toContain('Contact the ball below your waist.');
    expect(copy).toContain('Contact height · 3 × 10 · rest 30s');
    // Form content precedes the video section in the rendered order.
    expect(copy.indexOf('FORM FOCUS')).toBeLessThan(
      copy.indexOf('WATCH IT DONE'),
    );
    act(() => renderer.unmount());
  });

  it('opens the in-app player modal for a media row instead of leaving the app', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Watch demonstration');
    // Creator + attribution are mandatory display, rendered verbatim.
    expect(copy).toContain('Third Shot Sports');
    expect(copy).toContain('Video by Third Shot Sports on YouTube');
    expect(copy).toContain(DISCLOSURE);
    expect(findPlayerWebView(renderer)).toBeNull();
    await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
    // Playback stays inside the app: modal + WebView, no Linking.
    expect(openUrl).not.toHaveBeenCalled();
    const webView = findPlayerWebView(renderer);
    expect(webView).not.toBeNull();
    // YouTube runs through the referer-correct IFrame API shell — never a
    // bare /embed/ URL, which YouTube refuses with error 153.
    expect(webView?.props.source.uri).toBeUndefined();
    expect(webView?.props.source.baseUrl).toBe('https://com.picklesensei');
    expect(webView?.props.source.html).toContain('"dnk101xyz"');
    expect(webView?.props.source.html).toContain(
      'https://www.youtube-nocookie.com',
    );
    // The modal carries the license attribution and a source link.
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Watch on YouTube' &&
          typeof n.props.onPress === 'function',
      ).length,
    ).toBeGreaterThan(0);
    await pressByLabel(renderer, 'Close video player');
    expect(findPlayerWebView(renderer)).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('links to the source from the player and falls back when the WebView errors', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
    // "Watch on YouTube" opens the original page for users who want it.
    await pressByLabel(renderer, 'Watch on YouTube');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=dnk101xyz',
    );
    // An embed failure falls forward to the canonical watch page in-app —
    // the surface YouTube serves without embed restrictions.
    const webView = findPlayerWebView(renderer);
    expect(webView).not.toBeNull();
    await act(async () => {
      webView?.props.onError();
    });
    const watchView = findPlayerWebView(renderer);
    expect(watchView?.props.source).toEqual({
      uri: 'https://www.youtube.com/watch?v=dnk101xyz',
      headers: { Referer: 'https://com.picklesensei' },
    });
    // Only when the watch page itself cannot load does the explicit
    // error card appear, with an external escape hatch.
    await act(async () => {
      watchView?.props.onError();
    });
    expect(allText(renderer)).toContain(
      'This video could not load in the app.',
    );
    await pressByLabel(renderer, 'Open on YouTube');
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenLastCalledWith(
      'https://www.youtube.com/watch?v=dnk101xyz',
    );
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
    // Both curated videos render as full watch rows with mandatory credits.
    expect(textCount(renderer, 'Watch demonstration')).toBe(2);
    expect(copy).toContain('Third Shot Sports');
    expect(copy).toContain('Video by Third Shot Sports on YouTube');
    expect(copy).toContain('Kitchen Lab Pickleball');
    expect(copy).toContain('Video by Kitchen Lab Pickleball on YouTube');
    // One shared disclosure for the whole list, not one per row.
    expect(textCount(renderer, DISCLOSURE)).toBe(1);
    expect(
      findPressableByTestId(renderer, 'watch-media-dink-target-ladder-0'),
    ).not.toBeNull();
    // Each row opens its own video in the in-app player.
    await pressByTestId(renderer, 'watch-media-dink-target-ladder-1');
    expect(openUrl).not.toHaveBeenCalled();
    expect(findPlayerWebView(renderer)?.props.source.html).toContain(
      '"dnk202abc"',
    );
    act(() => renderer.unmount());
  });

  it('offers the external YouTube browse row under curated media', async () => {
    mockGetDrill.mockResolvedValue(detailWithMediaFixture);
    const openUrl = spyOnOpenUrl();
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('More drills on YouTube');
    expect(copy).toContain('Opens the YouTube app');
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
    expect(copy).toContain('More drills on YouTube');
    expect(copy).not.toContain(DISCLOSURE);
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
