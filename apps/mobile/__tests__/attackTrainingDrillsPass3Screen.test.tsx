import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../src/training/api';
import type { ScoredCheckpointFact } from '../src/library/libraryFocus';
import { TrainingError, type DrillDetail } from '../src/training/types';

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
 * ADVERSARIAL PASS 3 / tester #4 — `DrillLibraryScreen`. Scenario #1 (two
 * saves within 100 ms, resolved out of order), #7 (a malformed detail payload
 * through the REAL parser), #9 (40 keystrokes at 10 ms then clear inside the
 * debounce), plus a retry hammer on the detail endpoint. `.failing` tests
 * state the EXPECTED behaviour for a reproduced break at 4d812e1a.
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
  saved: false,
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
  instructionalMedia: [],
};

const SAVED_TOAST = 'Saved to your library · Library → Saved drills';
const DETAIL_ERROR = 'Drill detail could not be loaded from this deployment.';

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

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function toastNodes(renderer: TestRenderer.ReactTestRenderer) {
  // Host nodes only: the Animated wrapper and its View render the same props.
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.accessibilityLiveRegion === 'polite' &&
      n.props.pointerEvents === 'none',
  );
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

function saveToggle(renderer: TestRenderer.ReactTestRenderer, slug: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.testID === `save-toggle-${slug}` &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No save toggle for ${slug}`);
  return node;
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
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

describe('DrillLibraryScreen — adversarial pass 3', () => {
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

  describe('scenario 1 — save A then B within 100 ms, B resolves first', () => {
    it('keeps one toast, re-arms its timer on the later resolution, and clears both pending flags', async () => {
      const saves = new Map<string, Deferred<void>>();
      mockSaveDrill.mockReset().mockImplementation(slug => {
        const d = deferred<void>();
        saves.set(slug, d);
        return d.promise;
      });
      const renderer = renderScreen();
      await settle();

      await act(async () => {
        saveToggle(renderer, dinkDrill.slug).props.onPress();
      });
      await elapse(80);
      await act(async () => {
        saveToggle(renderer, volleyDrill.slug).props.onPress();
      });
      expect(saveToggle(renderer, dinkDrill.slug).props.disabled).toBe(true);
      expect(saveToggle(renderer, volleyDrill.slug).props.disabled).toBe(true);
      expect(toastNodes(renderer)).toHaveLength(0);

      // B (volley) resolves first.
      await act(async () => {
        saves.get(volleyDrill.slug)!.resolve();
      });
      expect(toastNodes(renderer)).toHaveLength(1);
      expect(saveToggle(renderer, volleyDrill.slug).props.disabled).toBe(false);
      expect(saveToggle(renderer, dinkDrill.slug).props.disabled).toBe(true);

      // A (dink) resolves 50 ms later: still exactly one toast.
      await elapse(50);
      await act(async () => {
        saves.get(dinkDrill.slug)!.resolve();
      });
      expect(toastNodes(renderer)).toHaveLength(1);
      expect(allText(renderer)).toContain(SAVED_TOAST);
      expect(saveToggle(renderer, dinkDrill.slug).props.disabled).toBe(false);
      expect(saveToggle(renderer, volleyDrill.slug).props.disabled).toBe(false);

      // B's original 2500 ms timer must have been cleared: at 2500 ms after
      // B's toast (2450 after A's) the toast is still alive …
      await elapse(2_450);
      expect(toastNodes(renderer)).toHaveLength(1);
      // … and it dismisses on A's schedule.
      await elapse(60);
      expect(toastNodes(renderer)).toHaveLength(0);
      expect(allText(renderer)).not.toContain(SAVED_TOAST);

      expect(mockSaveDrill).toHaveBeenCalledTimes(2);
      expect(mockSaveDrill.mock.calls.map(([slug]) => slug)).toEqual([
        dinkDrill.slug,
        volleyDrill.slug,
      ]);
      act(() => renderer.unmount());
    });

    it('B succeeds, A fails: the toast survives, the inline error shows, A reverts, both flags clear', async () => {
      const saves = new Map<string, Deferred<void>>();
      mockSaveDrill.mockReset().mockImplementation(slug => {
        const d = deferred<void>();
        saves.set(slug, d);
        return d.promise;
      });
      const renderer = renderScreen();
      await settle();
      await act(async () => {
        saveToggle(renderer, dinkDrill.slug).props.onPress();
      });
      await elapse(30);
      await act(async () => {
        saveToggle(renderer, volleyDrill.slug).props.onPress();
      });
      await act(async () => {
        saves.get(volleyDrill.slug)!.resolve();
      });
      await act(async () => {
        saves
          .get(dinkDrill.slug)!
          .reject(
            new TrainingError(
              'training.request_failed',
              'Save refused.',
              false,
            ),
          );
      });
      const copy = allText(renderer);
      expect(toastNodes(renderer)).toHaveLength(1);
      expect(copy).toContain('Save refused.');
      expect(
        saveToggle(renderer, dinkDrill.slug).props.accessibilityState,
      ).toEqual({ selected: false });
      expect(
        saveToggle(renderer, volleyDrill.slug).props.accessibilityState,
      ).toEqual({ selected: true });
      expect(saveToggle(renderer, dinkDrill.slug).props.disabled).toBe(false);
      expect(saveToggle(renderer, volleyDrill.slug).props.disabled).toBe(false);
      act(() => renderer.unmount());
    });

    it('seeded 12-slug interleaving: never more than one toast, every pending flag clears', async () => {
      const seed = 0x5eed_0001;
      let state = seed;
      const rnd = () => {
        state = (state * 1_103_515_245 + 12_345) >>> 0;
        return state / 0x1_0000_0000;
      };
      const catalog: CatalogDrill[] = Array.from({ length: 12 }, (_, i) => ({
        ...dinkDrill,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        slug: `drill-${i}`,
        title: `Drill ${i}`,
      }));
      mockListCatalogDrills.mockReset().mockResolvedValue(catalog);
      const saves: { slug: string; d: Deferred<void> }[] = [];
      mockSaveDrill.mockReset().mockImplementation(slug => {
        const d = deferred<void>();
        saves.push({ slug, d });
        return d.promise;
      });
      const renderer = renderScreen();
      await settle();

      for (const drill of catalog) {
        await act(async () => {
          saveToggle(renderer, drill.slug).props.onPress();
        });
        await elapse(Math.floor(rnd() * 8));
      }
      expect(saves).toHaveLength(12);
      // Settle in a seeded random order, some failing.
      const order = [...saves].sort(() => rnd() - 0.5);
      for (const { d } of order) {
        await act(async () => {
          if (rnd() < 0.3) {
            d.reject(new TrainingError('training.request_failed', 'x', false));
          } else {
            d.resolve();
          }
        });
        expect(toastNodes(renderer).length).toBeLessThanOrEqual(1);
        await elapse(Math.floor(rnd() * 40));
      }
      for (const drill of catalog) {
        expect(saveToggle(renderer, drill.slug).props.disabled).toBe(false);
      }
      await elapse(3_000);
      expect(toastNodes(renderer)).toHaveLength(0);
      act(() => renderer.unmount());
    });
  });

  describe('scenario 7 — malformed detail through the real parser', () => {
    function realGetDrill(payload: unknown) {
      const { createTrainingApi } = jest.requireActual<
        typeof import('../src/training/api')
      >('../src/training/api');
      return createTrainingApi({
        baseUrl: 'https://api.pickle.test',
        token: 'signed-token',
        fetchFn: jest.fn(async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => payload,
        })) as unknown as typeof fetch,
      }).getDrill;
    }

    const brokenPayload = {
      drill: {
        id: dinkDrill.id,
        slug: dinkDrill.slug,
        title: dinkDrill.title,
        description: dinkDrill.description,
        coach_name: dinkDrill.coachName,
        equipment: ['paddle'],
        difficulty_min: null,
        difficulty_max: null,
        saved: false,
      },
      mappings: { 0: { plan_role: 'targeted' } },
      instructionalMedia: null,
    };

    it('shows the inline detail error with Retry, no crash, and recovers when the server is fixed', async () => {
      mockGetDrill.mockReset().mockImplementation(realGetDrill(brokenPayload));
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      let copy = allText(renderer);
      expect(copy).toContain(DETAIL_ERROR);
      expect(copy).toContain(
        'The training server returned an invalid response.',
      );
      expect(
        findPressableByLabel(renderer, 'Retry detail for Dink Target Ladder'),
      ).not.toBeNull();
      expect(mockGetDrill).toHaveBeenCalledTimes(1);

      // Retry against the same broken payload: still the honest error.
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain(DETAIL_ERROR);
      expect(mockGetDrill).toHaveBeenCalledTimes(2);

      // Server fixed: retry renders the coach cue.
      mockGetDrill.mockImplementation(
        realGetDrill({
          ...brokenPayload,
          mappings: [
            {
              checkpoint: 'contact_height',
              shot_type: 'dink',
              plan_role: 'targeted',
              fault_directions: ['high'],
              cue_text: 'Contact the ball below your waist.',
              target_sets: 3,
              target_repetitions_per_set: 10,
              target_duration_seconds: null,
              rest_seconds: 30,
            },
          ],
          instructionalMedia: [],
        }),
      );
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      await settle();
      copy = allText(renderer);
      expect(copy).toContain('Contact the ball below your waist.');
      expect(copy).not.toContain(DETAIL_ERROR);
      act(() => renderer.unmount());
    });

    it('collapse/expand while the malformed detail is in flight does not refetch or crash', async () => {
      const gate = deferred<DrillDetail>();
      mockGetDrill.mockReset().mockImplementation(() => gate.promise);
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      await act(async () => {
        gate.reject(
          new TrainingError(
            'training.invalid_response',
            'The training server returned an invalid response.',
            true,
          ),
        );
      });
      expect(allText(renderer)).toContain(DETAIL_ERROR);
      act(() => renderer.unmount());
    });
  });

  describe('extra — detail retry hammer', () => {
    async function openAndFail(renderer: TestRenderer.ReactTestRenderer) {
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain(DETAIL_ERROR);
    }

    it('Retry disappears while its request is in flight, so a hammer yields exactly one getDrill call', async () => {
      const renderer = renderScreen();
      await settle();
      await openAndFail(renderer);
      const pending: Deferred<DrillDetail>[] = [];
      mockGetDrill.mockReset().mockImplementation(() => {
        const d = deferred<DrillDetail>();
        pending.push(d);
        return d.promise;
      });
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      expect(allText(renderer)).toContain('Loading drill detail…');
      for (let i = 0; i < 5; i += 1) {
        expect(
          findPressableByLabel(renderer, 'Retry detail for Dink Target Ladder'),
        ).toBeNull();
        await elapse(5);
      }
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      // Collapse/expand during the retry does not refetch either.
      await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      await act(async () => {
        pending[0]!.resolve(detailFixture);
      });
      expect(allText(renderer)).toContain('Contact the ball below your waist.');
      act(() => renderer.unmount());
    });

    it('a retry whose request rejects with a non-Error value shows the generic copy and stays retryable', async () => {
      const renderer = renderScreen();
      await settle();
      await openAndFail(renderer);
      mockGetDrill.mockReset().mockRejectedValue('plain string rejection');
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      await settle();
      const copy = allText(renderer);
      expect(copy).toContain(DETAIL_ERROR);
      expect(copy).toContain('The drill catalog is temporarily unavailable.');
      expect(copy).not.toContain('plain string rejection');
      expect(
        findPressableByLabel(renderer, 'Retry detail for Dink Target Ladder'),
      ).not.toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('scenario 9 — 40 keystrokes at 10 ms, cleared inside the debounce', () => {
    const phrase = 'dink target ladder kitchen zone drill!!!'; // 40 chars
    const youtubeRow = (renderer: TestRenderer.ReactTestRenderer) =>
      hasTestId(renderer, 'search-youtube');

    it('exactly one listCatalogDrills call (the initial one) and no YouTube row ever renders', async () => {
      expect(phrase).toHaveLength(40);
      const renderer = renderScreen();
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(mockListCatalogDrills.mock.calls[0]?.[0]).toEqual({
        q: undefined,
        family: undefined,
      });

      for (let i = 1; i <= phrase.length; i += 1) {
        typeSearch(renderer, phrase.slice(0, i));
        await elapse(10);
        expect(youtubeRow(renderer)).toBe(false);
        expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      }
      // 100 ms into the 250 ms debounce: clear via the Clear button.
      await elapse(100);
      expect(youtubeRow(renderer)).toBe(false);
      await pressByLabel(renderer, 'Clear search');
      await elapse(600);
      await settle();

      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(youtubeRow(renderer)).toBe(false);
      expect(allText(renderer)).not.toContain('Search YouTube:');
      // Both catalog cards are still there (no filtering leaked through).
      expect(hasTestId(renderer, 'drill-card-dink-target-ladder')).toBe(true);
      expect(hasTestId(renderer, 'drill-card-volley-wall-intervals')).toBe(
        true,
      );
      act(() => renderer.unmount());
    });

    it('control: letting the debounce fire yields exactly one extra call carrying the final q', async () => {
      const renderer = renderScreen();
      await settle();
      for (let i = 1; i <= phrase.length; i += 1) {
        typeSearch(renderer, phrase.slice(0, i));
        await elapse(10);
      }
      // 10 ms already elapsed after the last keystroke: 239 more = 249 total.
      await elapse(239);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(youtubeRow(renderer)).toBe(false);
      await elapse(1);
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      expect(mockListCatalogDrills.mock.calls[1]?.[0]).toEqual({
        q: phrase,
        family: undefined,
      });
      expect(youtubeRow(renderer)).toBe(true);
      expect(allText(renderer)).toContain(`Search YouTube: "${phrase}"`);
      act(() => renderer.unmount());
    });

    it('clear → retype the same text inside the window: still one extra call, no intermediate row', async () => {
      const renderer = renderScreen();
      await settle();
      typeSearch(renderer, 'dink');
      await elapse(200);
      await pressByLabel(renderer, 'Clear search');
      await elapse(200);
      typeSearch(renderer, 'dink');
      await elapse(200);
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
      expect(youtubeRow(renderer)).toBe(false);
      await elapse(60);
      await settle();
      expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
      expect(mockListCatalogDrills.mock.calls[1]?.[0]?.q).toBe('dink');
      act(() => renderer.unmount());
    });

    it('whitespace-only and 10k-char Unicode queries never crash and send a trimmed q', async () => {
      const renderer = renderScreen();
      await settle();
      typeSearch(renderer, '   \u3000  ');
      await elapse(300);
      await settle();
      // Trimmed to empty → q undefined and the same catalog. React only
      // re-runs the load effect when debouncedQuery changes, so this is a
      // new call with q undefined.
      const calls = mockListCatalogDrills.mock.calls.length;
      expect(youtubeRow(renderer)).toBe(false);
      const huge =
        '🥒'.repeat(2_500) + 'ダンク'.repeat(1_000) + '(((['.repeat(500);
      typeSearch(renderer, huge);
      await elapse(300);
      await settle();
      expect(mockListCatalogDrills.mock.calls.length).toBe(calls + 1);
      expect(mockListCatalogDrills.mock.calls.at(-1)?.[0]?.q).toBe(huge.trim());
      expect(youtubeRow(renderer)).toBe(true);
      act(() => renderer.unmount());
    });
  });
});
