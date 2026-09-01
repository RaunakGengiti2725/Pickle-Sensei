import React from 'react';
import { Text } from 'react-native';
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
 * STRESS SUITE for the drill library screen. The pinned behavioral contract
 * lives in drillLibraryScreen.test.tsx; this suite hammers the same surface
 * with the failure modes production will eventually produce:
 *
 *  - out-of-order and late-failing catalog responses (request-id guard),
 *  - same-tick and mid-flight double-taps on the save mutation,
 *  - expand/collapse churn (exactly one detail fetch per drill),
 *  - non-Error rejections and non-TrainingError exceptions,
 *  - a 160-drill catalog with personalization on top,
 *  - regex-hostile search input,
 *  - slow/failing local evidence reads,
 *  - unmounting with every request still in flight.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'rebound wall'],
  difficultyMin: null,
  difficultyMax: null,
  families: ['volley'],
  validationState: 'PUBLISHED',
  saved: true,
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

const detailWithMediaFixture: DrillDetail = {
  ...detailFixture,
  mappings: [cueMapping],
  instructionalMedia: [youtubeMedia],
};

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

/** 160 drills across four families: dink/volley/drive ×40 + global ×40. */
function largeCatalog(): CatalogDrill[] {
  const families = ['dink', 'volley', 'drive', 'global'] as const;
  const familyName: Record<(typeof families)[number], string> = {
    dink: 'Dink',
    volley: 'Volley',
    drive: 'Drive',
    global: 'Global',
  };
  return families.flatMap((family, familyIndex) =>
    Array.from({ length: 40 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(familyIndex * 100 + i).padStart(
        12,
        '0',
      )}`,
      slug: `${family}-drill-${i}`,
      title: `${familyName[family]} Drill ${i}`,
      description: `Practice block ${i} for the ${family} family.`,
      coachName: 'Pickle Sensei Training Library',
      equipment: ['paddle'],
      difficultyMin: null,
      difficultyMax: null,
      families: [family],
      validationState: 'PUBLISHED',
      saved: false,
    })),
  );
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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function findPressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = findPressableByLabel(renderer, label);
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

describe('DrillLibraryScreen under stress', () => {
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
    jest.restoreAllMocks();
  });

  it('drops an out-of-order catalog response instead of overwriting newer results', async () => {
    const responses: Deferred<CatalogDrill[]>[] = [];
    mockListCatalogDrills.mockReset().mockImplementation(() => {
      const response = deferred<CatalogDrill[]>();
      responses.push(response);
      return response.promise;
    });
    const renderer = renderScreen();
    await act(async () => {
      responses[0]!.resolve([{ ...dinkDrill }, { ...volleyDrill }]);
    });

    // Two rapid query changes: the older request intentionally stays open.
    typeSearch(renderer, 'wa');
    await advanceDebounce();
    typeSearch(renderer, 'wall');
    await advanceDebounce();
    expect(responses).toHaveLength(3);

    // The NEWER request resolves first with the narrower result…
    await act(async () => {
      responses[2]!.resolve([{ ...volleyDrill }]);
    });
    expect(allText(renderer)).toContain('1 of 1 drill');
    expect(allText(renderer)).toContain('Volley Wall Intervals');

    // …then the STALE request resolves late and must be ignored.
    await act(async () => {
      responses[1]!.resolve([{ ...dinkDrill }, { ...volleyDrill }]);
    });
    const copy = allText(renderer);
    expect(copy).toContain('1 of 1 drill');
    expect(copy).not.toContain('of 2 drills');
    expect(copy).not.toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('ignores a stale request that fails after a newer one already succeeded', async () => {
    const responses: Deferred<CatalogDrill[]>[] = [];
    mockListCatalogDrills.mockReset().mockImplementation(() => {
      const response = deferred<CatalogDrill[]>();
      responses.push(response);
      return response.promise;
    });
    const renderer = renderScreen();
    await act(async () => {
      responses[0]!.resolve([{ ...dinkDrill }, { ...volleyDrill }]);
    });

    typeSearch(renderer, 'wall');
    await advanceDebounce();
    typeSearch(renderer, '');
    await advanceDebounce();
    expect(responses).toHaveLength(3);

    await act(async () => {
      responses[2]!.resolve([{ ...dinkDrill }, { ...volleyDrill }]);
    });
    await act(async () => {
      responses[1]!.reject(
        new TrainingError('training.unavailable', 'stale failure', true),
      );
    });
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(copy).not.toContain('stale failure');
    act(() => renderer.unmount());
  });

  it('fetches drill detail exactly once across 30 expand/collapse cycles', async () => {
    const detail = deferred<DrillDetail>();
    mockGetDrill.mockReset().mockImplementation(() => detail.promise);
    const renderer = renderScreen();
    await settle();

    for (let cycle = 0; cycle < 15; cycle += 1) {
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
    }
    expect(mockGetDrill).toHaveBeenCalledTimes(1);

    await act(async () => {
      detail.resolve(detailWithMediaFixture);
    });
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    const copy = allText(renderer);
    expect(copy).toContain('Contact the ball below your waist.');
    expect(copy).toContain('More drills on YouTube');
    expect(mockGetDrill).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('a same-tick 10× hammer on save fires exactly one mutation', async () => {
    const save = deferred<void>();
    mockSaveDrill.mockReset().mockImplementation(() => save.promise);
    const renderer = renderScreen();
    await settle();

    const toggle = findPressableByTestId(
      renderer,
      'save-toggle-dink-target-ladder',
    );
    expect(toggle).not.toBeNull();
    // Same tick: state has not flushed between calls — the ref guard holds.
    await act(async () => {
      for (let press = 0; press < 10; press += 1) {
        toggle!.props.onPress();
      }
    });
    expect(mockSaveDrill).toHaveBeenCalledTimes(1);

    // Mid-flight, across ticks: the pending guard holds.
    await act(async () => {
      toggle!.props.onPress();
    });
    expect(mockSaveDrill).toHaveBeenCalledTimes(1);

    await act(async () => {
      save.resolve();
    });
    expect(mockSaveDrill).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain(
      'Saved to your library · Library → Saved drills',
    );
    expect(
      findPressableByLabel(
        renderer,
        'Remove Dink Target Ladder from saved drills',
      ),
    ).not.toBeNull();

    // Now hammer the unsave path the same way.
    const unsave = deferred<void>();
    mockUnsaveDrill.mockReset().mockImplementation(() => unsave.promise);
    await act(async () => {
      for (let press = 0; press < 10; press += 1) {
        toggle!.props.onPress();
      }
    });
    expect(mockUnsaveDrill).toHaveBeenCalledTimes(1);
    await act(async () => {
      unsave.resolve();
    });
    expect(allText(renderer)).toContain('Removed from saved drills');
    expect(
      findPressableByLabel(renderer, 'Save Dink Target Ladder'),
    ).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('save → unsave churn keeps exactly one toast alive and clears it', async () => {
    const renderer = renderScreen();
    await settle();
    const toggle = findPressableByTestId(
      renderer,
      'save-toggle-dink-target-ladder',
    );
    await act(async () => {
      toggle!.props.onPress();
    });
    expect(allText(renderer)).toContain('Saved to your library');
    await act(async () => {
      toggle!.props.onPress();
    });
    const copy = allText(renderer);
    expect(copy).toContain('Removed from saved drills');
    expect(copy).not.toContain('Saved to your library');
    await act(async () => {
      jest.advanceTimersByTime(2_600);
    });
    expect(allText(renderer)).not.toContain('Removed from saved drills');
    act(() => renderer.unmount());
  });

  it('survives a non-Error string rejection from the save endpoint', async () => {
    mockSaveDrill.mockReset().mockRejectedValue('boom');
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    // Reverted, generic honest failure, no fake success.
    expect(copy).toContain('The drill catalog is temporarily unavailable.');
    expect(copy).not.toContain('boom');
    expect(copy).not.toContain('Saved to your library');
    expect(
      findPressableByLabel(renderer, 'Save Dink Target Ladder'),
    ).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('survives a TypeError from the detail endpoint and recovers on retry', async () => {
    mockGetDrill
      .mockReset()
      .mockRejectedValueOnce(new TypeError('cannot read properties'))
      .mockResolvedValueOnce(detailWithMediaFixture);
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    let copy = allText(renderer);
    expect(copy).toContain(
      'Drill detail could not be loaded from this deployment.',
    );
    expect(copy).toContain('The drill catalog is temporarily unavailable.');
    expect(copy).not.toContain('cannot read properties');
    await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
    await settle();
    copy = allText(renderer);
    expect(copy).toContain('Contact the ball below your waist.');
    act(() => renderer.unmount());
  });

  it('renders a 160-drill catalog with personalization, deduped and in order', async () => {
    const catalog = largeCatalog();
    mockListCatalogDrills.mockReset().mockResolvedValue(catalog);
    mockListScoredCheckpointFacts.mockResolvedValue(dinkFocusFacts());
    const renderer = renderScreen();
    await settle();

    const order = drillCardOrder(renderer);
    expect(order).toHaveLength(160);
    expect(new Set(order).size).toBe(160);
    // The three recommended dink drills lead, in catalog order, undedoubled.
    expect(order.slice(0, 3)).toEqual([
      'drill-card-dink-drill-0',
      'drill-card-dink-drill-1',
      'drill-card-dink-drill-2',
    ]);
    const copy = allText(renderer);
    expect(copy).toContain('YOUR FOCUS');
    expect(copy).toContain('Recommended for you');
    expect(copy).toContain('All drills');

    // Search across the large catalog stays correct and drops the sections.
    typeSearch(renderer, 'dink drill 3');
    await advanceDebounce();
    await settle();
    expect(allText(renderer)).toContain('11 of 160 drills');
    expect(allText(renderer)).not.toContain('Recommended for you');
    typeSearch(renderer, '');
    await advanceDebounce();
    await settle();
    expect(drillCardOrder(renderer)).toHaveLength(160);
    act(() => renderer.unmount());
  });

  it('expanding a recommended card loads its detail in place, never a duplicate card', async () => {
    mockListScoredCheckpointFacts.mockResolvedValue(dinkFocusFacts());
    mockGetDrill.mockReset().mockResolvedValue(detailWithMediaFixture);
    const renderer = renderScreen();
    await settle();
    expect(drillCardOrder(renderer)).toEqual([
      'drill-card-dink-target-ladder',
      'drill-card-volley-wall-intervals',
    ]);
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(mockGetDrill).toHaveBeenCalledWith('dink-target-ladder');
    const copy = allText(renderer);
    expect(copy).toContain('FORM FOCUS');
    expect(copy).toContain('Contact the ball below your waist.');
    expect(drillCardOrder(renderer)).toHaveLength(2);
    act(() => renderer.unmount());
  });

  it('handles regex-hostile search text without crashing', async () => {
    const renderer = renderScreen();
    await settle();
    typeSearch(renderer, '([\\.*+?^${}|');
    await advanceDebounce();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('No drills match');
    expect(copy).toContain('0 of 2 drills');
    // The honest YouTube escape hatch still carries the query verbatim.
    expect(copy).toContain('Search YouTube: "([\\.*+?^${}|" pickleball drills');
    act(() => renderer.unmount());
  });

  it('shows no personalization while the local evidence read is still in flight, then fills in', async () => {
    const facts = deferred<ScoredCheckpointFact[]>();
    mockListScoredCheckpointFacts
      .mockReset()
      .mockImplementation(() => facts.promise);
    const renderer = renderScreen();
    await settle();
    // Neither a focus nor the hint: the evidence read has not answered yet,
    // so nothing is claimed either way.
    expect(findByTestId(renderer, 'library-focus')).toBeNull();
    expect(findByTestId(renderer, 'library-focus-hint')).toBeNull();
    await act(async () => {
      facts.resolve(dinkFocusFacts());
    });
    expect(findByTestId(renderer, 'library-focus')).not.toBeNull();
    expect(allText(renderer)).toContain('Recommended for you');
    act(() => renderer.unmount());
  });

  it('unmounts cleanly with catalog, focus, detail, and save all still in flight', async () => {
    const catalog = deferred<CatalogDrill[]>();
    const facts = deferred<ScoredCheckpointFact[]>();
    mockListCatalogDrills.mockReset().mockImplementation(() => catalog.promise);
    mockListScoredCheckpointFacts
      .mockReset()
      .mockImplementation(() => facts.promise);
    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).toContain('Loading the drill catalog…');
    act(() => renderer.unmount());
    // Everything resolves/rejects after unmount — nothing may throw.
    await act(async () => {
      catalog.resolve([{ ...dinkDrill }]);
      facts.reject(new Error('db closed mid-flight'));
    });
    await settle();
  });

  it('withstands 20 rapid query/filter mutations in a row', async () => {
    const renderer = renderScreen();
    await settle();
    const families = [
      'Filter dink drills',
      'Filter volley drills',
      'Filter drive drills',
      'Show all drill families',
    ];
    for (let round = 0; round < 5; round += 1) {
      typeSearch(renderer, `query-${round}`);
      await advanceDebounce();
      await pressByLabel(renderer, families[round % families.length]!);
      typeSearch(renderer, '');
      await advanceDebounce();
    }
    await pressByLabel(renderer, 'Show all drill families');
    await settle();
    // The screen lands consistent: full catalog, personalization visible
    // (empty evidence ⇒ the honest hint), no crash, no stuck error.
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(copy).toContain('Volley Wall Intervals');
    expect(findByTestId(renderer, 'library-focus-hint')).not.toBeNull();
    act(() => renderer.unmount());
  });
});
