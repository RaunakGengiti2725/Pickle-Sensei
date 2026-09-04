import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import {
  TrainingError,
  type DrillDetail,
  type DrillMapping,
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

const mockGetDb = jest.fn<unknown, []>();
jest.mock('../../src/data/db', () => ({ getDb: () => mockGetDb() }));
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
 * ADVERSARIAL PASS 3 — mobile-training-drills, scenarios S3, S5, S6.
 *
 *  S3: Linking.openURL rejects for "More drills on YouTube" while another
 *      drill's detail Retry is still pending.
 *  S5: getDb() throws SYNCHRONOUSLY (not a rejected promise).
 *  S6: listScoredCheckpointFacts returns 10,000 corrupt facts (NaN scores,
 *      'not-a-date' timestamps, duplicate ids) — seeded, see SEED.
 *
 * Plus the unusual: corrupt fact SHAPES (missing shotType / checkpoints),
 * prototype-key shot types, an inline load error surviving a later
 * successful refresh, and openURL rejecting with a non-Error value.
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

function detailFor(drill: CatalogDrill): DrillDetail {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coachName: drill.coachName,
    equipment: drill.equipment,
    difficultyMin: drill.difficultyMin,
    difficultyMax: drill.difficultyMax,
    saved: drill.saved,
    mappings: [cueMapping],
    instructionalMedia: [youtubeMedia],
  };
}

const DETAIL_FAILURE = new TrainingError(
  'training.request_failed',
  'Drill detail is not deployed for this build.',
  false,
);

const YOUTUBE_FAILURE = 'YouTube could not be opened on this device.';
const FOCUS_HINT =
  'After two scored analyses of the same technique, this library sorts itself around your weakest checkpoint.';

/** mulberry32 — deterministic; every corrupt dataset below is reproducible. */
const SEED = 0x5eed2;
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

/** 10,000 facts: NaN/±Infinity/out-of-range scores, 'not-a-date' capture
 * times, only 97 distinct ids, hostile shot types. */
function corruptFacts(count = 10_000): ScoredCheckpointFact[] {
  const random = seededRandom(SEED);
  const shotTypes = [
    'dink',
    'volley',
    'forehand_drive',
    'third_shot_drop',
    '__proto__',
    'constructor',
    '',
    '🥒'.repeat(50),
    'x'.repeat(4096),
  ];
  const keys = [
    'contact_position',
    'athletic_base',
    'contact_height',
    '__proto__',
    'toString',
    '',
  ];
  const scores: (number | null)[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    -5,
    150,
    1e308,
    Number.MIN_VALUE,
    0,
    100,
    42,
    58,
    73,
  ];
  const facts: ScoredCheckpointFact[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = 1 + Math.floor(random() * 28);
    const capturedAt = pick(random, [
      'not-a-date',
      'not-a-date',
      `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      '',
      '9999-12-31T23:59:59.999Z',
      '0000-01-01T00:00:00.000Z',
    ]);
    facts.push({
      id: `00000000-0000-4000-8000-${String(i % 97).padStart(12, '0')}`,
      shotType: pick(random, shotTypes),
      capturedAt,
      checkpoints: Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
        key: pick(random, keys),
        score: pick(random, scores),
        applicable: random() < 0.7,
      })),
    });
  }
  return facts;
}

/** Exactly the assigned combination, with just enough valid rows to be able
 * to produce a finite focus. */
function assignedCorruptFacts(): ScoredCheckpointFact[] {
  const facts = corruptFacts(10_000);
  for (let i = 0; i < 4; i += 1) {
    facts[i] = {
      id: '00000000-0000-4000-8000-000000000001',
      shotType: 'dink',
      capturedAt: i % 2 === 0 ? 'not-a-date' : '2026-08-02T10:00:00.000Z',
      checkpoints: [
        { key: 'contact_position', score: Number.NaN, applicable: true },
        { key: 'athletic_base', score: 40 + i, applicable: true },
      ],
    };
  }
  return facts;
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<DrillLibraryScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted by the test
    }
  }
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

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
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

function inlineErrorText(
  renderer: TestRenderer.ReactTestRenderer,
): string | null {
  const banner = findByTestId(renderer, 'drill-library-inline-error');
  if (!banner) return null;
  return banner
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

/** The focus card's rendered average, or null when no card is shown. */
function renderedFocusScore(
  renderer: TestRenderer.ReactTestRenderer,
): number | null {
  const card = findByTestId(renderer, 'library-focus');
  if (!card) return null;
  const [track] = card.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Recent average '),
  );
  if (!track) throw new Error('focus card without an average');
  const match = /Recent average (.+) out of 100/.exec(
    track.props.accessibilityLabel as string,
  );
  return Number(match?.[1]);
}

async function refresh(renderer: TestRenderer.ReactTestRenderer) {
  const [scroll] = renderer.root.findAll(
    n => n.props.refreshControl !== undefined,
  );
  if (!scroll) throw new Error('No refreshable list rendered');
  await act(async () => {
    scroll.props.refreshControl.props.onRefresh();
  });
}

describe('DrillLibraryScreen under hostile dependencies', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetDb.mockReset().mockReturnValue({});
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dinkDrill }, { ...volleyDrill }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockRejectedValue(DETAIL_FAILURE);
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockGoBack.mockClear();
    mockNavigate.mockClear();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    // The RN preset ships Linking.openURL as a shared jest.fn; spyOn returns
    // that same mock, so its call history must be cleared per test.
    jest.spyOn(Linking, 'openURL').mockClear();
  });

  afterEach(() => {
    unmountAll();
    consoleError.mockRestore();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('S3 — openURL rejects while a detail Retry is pending', () => {
    it('shows the YouTube failure inline, leaves the pending detail alone, and Dismiss clears only the banner', async () => {
      // Drill A (dink): detail fails, Retry left pending. Drill B (volley):
      // detail ready so its "More drills on YouTube" row is visible.
      const retryOfA = deferred<DrillDetail>();
      mockGetDrill.mockImplementation(async slug => {
        if (slug === volleyDrill.slug) return detailFor(volleyDrill);
        if (mockGetDrill.mock.calls.length === 1) throw DETAIL_FAILURE;
        return retryOfA.promise;
      });
      const openUrl = jest
        .spyOn(Linking, 'openURL')
        .mockRejectedValue(new Error('No app can open youtube://'));

      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain(DETAIL_FAILURE.message);
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      expect(allText(renderer)).toContain('Loading drill detail…');

      // Open B, tap its YouTube browse row while A's retry is in flight.
      await pressByLabel(renderer, 'Show detail for Volley Wall Intervals');
      await settle();
      await pressByLabel(
        renderer,
        'Browse YouTube videos for Volley Wall Intervals',
      );
      expect(openUrl).toHaveBeenCalledWith(
        'https://www.youtube.com/results?search_query=' +
          encodeURIComponent('Volley Wall Intervals pickleball drill'),
      );
      expect(inlineErrorText(renderer)).toBe(YOUTUBE_FAILURE);
      // B's own detail is untouched by the browse failure.
      expect(allText(renderer)).toContain('More drills on YouTube');
      expect(allText(renderer)).toContain(cueMapping.cueText);

      // A's retry now fails: its detail error is rendered next to (not
      // instead of, not replaced by) the YouTube banner.
      await act(async () => {
        retryOfA.reject(
          new TrainingError(
            'training.request_failed',
            'Detail retry failed too.',
            false,
          ),
        );
      });
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain('Detail retry failed too.');
      expect(inlineErrorText(renderer)).toBe(YOUTUBE_FAILURE);

      // Dismiss clears the banner and nothing else.
      await pressByLabel(renderer, 'Dismiss error');
      expect(inlineErrorText(renderer)).toBeNull();
      expect(allText(renderer)).toContain('Detail retry failed too.');
      expect(
        findPressableByLabel(renderer, 'Retry detail for Dink Target Ladder'),
      ).not.toBeNull();
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(openUrl).toHaveBeenCalledTimes(1);
    });

    it('a pending retry that SUCCEEDS after the YouTube failure renders its detail while the banner stays until dismissed', async () => {
      const retryOfA = deferred<DrillDetail>();
      mockGetDrill.mockImplementation(async slug => {
        if (slug === volleyDrill.slug) return detailFor(volleyDrill);
        if (mockGetDrill.mock.calls.length === 1) throw DETAIL_FAILURE;
        return retryOfA.promise;
      });
      jest.spyOn(Linking, 'openURL').mockRejectedValue('not-an-error');
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      await pressByLabel(renderer, 'Show detail for Volley Wall Intervals');
      await settle();
      await pressByLabel(
        renderer,
        'Browse YouTube videos for Volley Wall Intervals',
      );
      expect(inlineErrorText(renderer)).toBe(YOUTUBE_FAILURE);
      await act(async () => {
        retryOfA.resolve(detailFor(dinkDrill));
      });
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain('Watch demonstration');
      expect(inlineErrorText(renderer)).toBe(YOUTUBE_FAILURE);
      await pressByLabel(renderer, 'Dismiss error');
      expect(inlineErrorText(renderer)).toBeNull();
    });

    it('rapid double-tap on the browse row while openURL rejects yields one banner and two attempts', async () => {
      mockGetDrill.mockResolvedValue(detailFor(volleyDrill));
      const openUrl = jest
        .spyOn(Linking, 'openURL')
        .mockRejectedValue(new Error('nope'));
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Volley Wall Intervals');
      await settle();
      const row = findPressableByLabel(
        renderer,
        'Browse YouTube videos for Volley Wall Intervals',
      )!;
      await act(async () => {
        row.props.onPress();
        row.props.onPress();
      });
      expect(openUrl).toHaveBeenCalledTimes(2);
      expect(
        renderer.root.findAll(
          n =>
            typeof n.type === 'string' &&
            n.props.testID === 'drill-library-inline-error',
        ),
      ).toHaveLength(1);
      expect(inlineErrorText(renderer)).toBe(YOUTUBE_FAILURE);
    });
  });

  describe('S5 — getDb() throws synchronously', () => {
    it('focus resolves to null (hint shown) and the catalog still loads', async () => {
      mockGetDb.mockImplementation(() => {
        throw new Error('SQLite is not available on this host');
      });
      mockListScoredCheckpointFacts.mockImplementation(async () => {
        throw new Error('listScoredCheckpointFacts must not be reached');
      });
      const renderer = renderScreen();
      await settle();
      expect(mockGetDb).toHaveBeenCalled();
      expect(mockListScoredCheckpointFacts).not.toHaveBeenCalled();
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(findByTestId(renderer, 'library-focus')).toBeNull();
      expect(findByTestId(renderer, 'library-focus-hint')).not.toBeNull();
      expect(allText(renderer)).toContain(FOCUS_HINT);
      expect(allText(renderer)).not.toContain('Recommended for you');
      expect(inlineErrorText(renderer)).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('getDb throwing a non-Error value (string) is swallowed the same way', async () => {
      mockGetDb.mockImplementation(() => {
        throw 'db string failure';
      });
      const renderer = renderScreen();
      await settle();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      expect(findByTestId(renderer, 'library-focus')).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('a DB that recovers by the next pull-to-refresh produces a focus without remounting', async () => {
      let healthy = false;
      mockGetDb.mockImplementation(() => {
        if (!healthy) throw new Error('db booting');
        return {};
      });
      mockListScoredCheckpointFacts.mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000002',
          shotType: 'dink',
          capturedAt: '2026-08-02T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 50, applicable: true },
          ],
        },
        {
          id: '00000000-0000-4000-8000-000000000001',
          shotType: 'dink',
          capturedAt: '2026-08-01T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 60, applicable: true },
          ],
        },
      ]);
      const renderer = renderScreen();
      await settle();
      expect(findByTestId(renderer, 'library-focus')).toBeNull();
      healthy = true;
      await refresh(renderer);
      expect(findByTestId(renderer, 'library-focus')).not.toBeNull();
      expect(renderedFocusScore(renderer)).toBe(53);
    });
  });

  describe('S6 — corrupt and huge local evidence', () => {
    it(`assigned mix (seed ${SEED}): NaN, 'not-a-date', duplicate ids, 10,000 rows → catalog renders, focus null or finite, nothing throws`, async () => {
      const facts = assignedCorruptFacts();
      expect(facts).toHaveLength(10_000);
      expect(new Set(facts.map(f => f.id)).size).toBeLessThan(100);
      mockListScoredCheckpointFacts.mockResolvedValue(facts);
      const started = Date.now();
      const renderer = renderScreen();
      await settle();
      const elapsedMs = Date.now() - started;
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      const score = renderedFocusScore(renderer);
      if (score === null) {
        expect(findByTestId(renderer, 'library-focus-hint')).not.toBeNull();
      } else {
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
        expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
      }
      expect(inlineErrorText(renderer)).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
      // Render + focus computation over 10k rows in well under a second.
      expect(elapsedMs).toBeLessThan(5_000);
    });

    it('fully hostile dataset (prototype keys, 4 KB / emoji shot types, ±Infinity) never throws', async () => {
      mockListScoredCheckpointFacts.mockResolvedValue(corruptFacts());
      const renderer = renderScreen();
      await settle();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      const score = renderedFocusScore(renderer);
      if (score !== null) {
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('a fact whose checkpoints are missing altogether falls back to "no focus" (caught by loadFocus)', async () => {
      mockListScoredCheckpointFacts.mockResolvedValue([
        {
          id: 'a',
          shotType: 'dink',
          capturedAt: '2026-08-02T10:00:00.000Z',
          checkpoints:
            undefined as unknown as ScoredCheckpointFact['checkpoints'],
        },
      ]);
      const renderer = renderScreen();
      await settle();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      expect(findByTestId(renderer, 'library-focus')).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('a persisted fact with a NON-STRING shotType must not crash the screen', async () => {
      // repository.listScoredCheckpointFacts copies `analysis.shotType`
      // verbatim from the persisted payload; a corrupt row can therefore
      // reach computeLibraryFocus with shotType undefined / number.
      mockListScoredCheckpointFacts.mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000002',
          shotType: undefined as unknown as string,
          capturedAt: '2026-08-02T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 50, applicable: true },
          ],
        },
        {
          id: '00000000-0000-4000-8000-000000000001',
          shotType: undefined as unknown as string,
          capturedAt: '2026-08-01T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 60, applicable: true },
          ],
        },
      ]);
      let renderError: unknown = null;
      let renderer: TestRenderer.ReactTestRenderer | null = null;
      try {
        renderer = renderScreen();
        await settle();
      } catch (error) {
        renderError = error;
      }
      expect(renderError).toBeNull();
      expect(renderer && drillCardOrder(renderer)).toHaveLength(2);
    });

    it('a `__proto__` shot type with enough samples does not leak Object.prototype into the UI', async () => {
      mockListScoredCheckpointFacts.mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000002',
          shotType: '__proto__',
          capturedAt: '2026-08-02T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 50, applicable: true },
          ],
        },
        {
          id: '00000000-0000-4000-8000-000000000001',
          shotType: '__proto__',
          capturedAt: '2026-08-01T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: 60, applicable: true },
          ],
        },
      ]);
      const renderer = renderScreen();
      await settle();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      expect(allText(renderer)).not.toContain('[object Object]');
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe('inline load errors across refreshes', () => {
    it('a failed pull-to-refresh banner is cleared once a later refresh succeeds', async () => {
      const renderer = renderScreen();
      await settle();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      mockListCatalogDrills.mockRejectedValueOnce(
        new TrainingError(
          'training.unavailable',
          'Training is temporarily offline. Your existing reads are still safe.',
          true,
        ),
      );
      await refresh(renderer);
      expect(inlineErrorText(renderer)).toBe(
        'Training is temporarily offline. Your existing reads are still safe.',
      );
      // The next refresh succeeds and replaces the catalog…
      await refresh(renderer);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(3);
      expect(drillCardOrder(renderer)).toHaveLength(2);
      // …so an "offline" banner is no longer true.
      expect(inlineErrorText(renderer)).toBeNull();
    });
  });
});
