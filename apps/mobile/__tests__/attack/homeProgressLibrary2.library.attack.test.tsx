/**
 * ADVERSARIAL PASS 3 · tester #2 · subsystem mobile-home-progress-library.
 *
 * Attack tests against LibraryScreen at 4d812e1a. Every test asserts the
 * behaviour the product SHOULD have; a test that is red on the baseline is a
 * reproduced finding (its title is prefixed `[BROKEN@4d812e1a]`), a green
 * test is a HELD scenario. No production code is touched by this file.
 *
 * Scenarios (assigned):
 *  S1 reads row: resultKind 'scored', overallScore null, capturedAt 'garbage'
 *  S2 3 saved drills, catalog detail for only 1 → one card, held copy for 2,
 *     retry reaches the training-store detail refresh
 *  S3 Linking.canOpenURL → false: branded notice, openURL never called
 *  S4 listShots resolves, listPendingCaptures rejects
 *  S5 pending capture evidenceStatus 'corrupt' with clip null
 *  S6 rapid double-press on "Remove from saved" for the same slug
 * Extras: unsave-then-reload failure, pending list truncation disclosure,
 *  unicode / huge inputs, dismiss-hint double tap.
 */
import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalShotRow, PendingCapture } from '../../src/data/repository';
import {
  configureTrainingStore,
  clearTrainingStoreConfiguration,
  useTrainingStore,
} from '../../src/training/store';
import type { TrainingStoreState } from '../../src/training/store';
import type {
  DrillDetail,
  InstructionalMedia,
  SavedDrill,
  TrainingApi,
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

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({})),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

const mockListShots = jest.fn<Promise<LocalShotRow[]>, [unknown, number]>();
const mockListPendingCaptures = jest.fn<
  Promise<PendingCapture[]>,
  [unknown, number]
>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: [unknown, number]) => mockListShots(...args),
  listPendingCaptures: (...args: [unknown, number]) =>
    mockListPendingCaptures(...args),
}));

jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import {
  LibraryScreen,
  MUTATION_ERROR_DISMISS_HINT,
  PENDING_SECTION_PILL,
} from '../../src/screens/LibraryScreen';

// ---------------------------------------------------------------- fixtures

const shotScored: LocalShotRow = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: null,
  shotType: 'forehand_drive',
  capturedAt: '2026-08-30T15:04:00.000Z',
  overallScore: 7.25,
  confidence: 0.91,
  resultKind: 'scored',
  source: 'real',
  favorite: false,
};

const shotDink: LocalShotRow = {
  ...shotScored,
  id: '22222222-2222-4222-8222-222222222222',
  shotType: 'dink',
  capturedAt: '2026-08-29T09:30:00.000Z',
  overallScore: 6.4,
};

/** S1 payload: a scored kind, no number, unparseable timestamp. */
const shotGarbage: LocalShotRow = {
  ...shotScored,
  id: '33333333-3333-4333-8333-333333333333',
  shotType: 'third_shot_drop',
  capturedAt: 'garbage',
  overallScore: null,
  resultKind: 'scored',
};

function pendingCapture(overrides: Partial<PendingCapture>): PendingCapture {
  return {
    id: 'cap-1',
    shotType: 'unrecognized',
    declaredStroke: 'forehand_drive',
    uri: 'file:///captures/cap-1.mov',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    clip: null,
    evidenceStatus: 'valid',
    ...overrides,
  };
}

function savedDrill(slug: string, title = slug): SavedDrill {
  return {
    id: `id-${slug}`,
    slug,
    title,
    description: `Description for ${title}.`,
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    savedAt: '2026-08-30T10:00:00.000Z',
  };
}

const embedMedia: InstructionalMedia = {
  id: '3f6f5a1e-9c1a-4d2b-8f3e-2b1c4d5e6f70',
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

const hostedMedia: InstructionalMedia = {
  id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/dink.mp4?sig=abc',
  expiresAt: '2999-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/dink',
  creatorName: 'Kitchen Lab Pickleball',
  licenseName: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Video by Kitchen Lab Pickleball',
};

function detailFor(
  drill: SavedDrill,
  media: InstructionalMedia[] = [embedMedia],
): DrillDetail {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coachName: drill.coachName,
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    saved: true,
    mappings: [],
    instructionalMedia: media,
  };
}

const drillA = savedDrill('dink-target-ladder', 'Dink Target Ladder');
const drillB = savedDrill('third-shot-drop-lane', 'Third Shot Drop Lane');
const drillC = savedDrill('reset-block-wall', 'Reset Block Wall');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [drillA]),
    getDrill: jest.fn(async () => detailFor(drillA)),
    saveDrill: jest.fn(async () => undefined),
    unsaveDrill: jest.fn(async () => undefined),
    getCurrentPlan: jest.fn(async () => null),
    createPlan: jest.fn(async () => {
      throw new Error('not used');
    }),
    completeDrill: jest.fn(async () => {
      throw new Error('not used');
    }),
    reassessPlan: jest.fn(async () => {
      throw new Error('not used');
    }),
    ...overrides,
  };
}

// ----------------------------------------------------------------- helpers

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** First composite node with a real onPress for `label` (the tap target). */
function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

/** HOST nodes whose label starts with `prefix` — one per rendered control
 * (composite wrappers repeat the same props and would double count). */
function hostLabelsWithPrefix(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith(prefix),
    )
    .map(n => n.props.accessibilityLabel as string);
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

function findTab(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const tabs = renderer.root.findAll(
    n =>
      n.props.accessibilityRole === 'tab' &&
      typeof n.props.onPress === 'function',
  );
  const tab = tabs.find(
    n => n.findAll(child => child.props.children === label).length > 0,
  );
  if (!tab) throw new Error(`No tab labeled ${label}`);
  return tab;
}

async function pressTab(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const tab = findTab(renderer, label);
  await act(async () => {
    tab.props.onPress();
  });
}

/** Composite Pressable nodes carrying the inline-error dismiss hint. */
function dismissRegions(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityHint === MUTATION_ERROR_DISMISS_HINT &&
      typeof n.props.onPress === 'function',
  );
}

/** A value SQLite can hand back that the TypeScript contract says is
 * impossible — the point of the attack is that the row still renders. */
function offContract(value: string): PendingCapture['declaredStroke'] {
  return value as unknown as PendingCapture['declaredStroke'];
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

function setStore(partial: Partial<TrainingStoreState>) {
  act(() => {
    useTrainingStore.setState(partial);
  });
}

const realActions = {
  loadSavedDrills: useTrainingStore.getState().loadSavedDrills,
  loadCurrentPlan: useTrainingStore.getState().loadCurrentPlan,
  setDrillSaved: useTrainingStore.getState().setDrillSaved,
  clearMutationError: useTrainingStore.getState().clearMutationError,
};

function configureApi(api: TrainingApi) {
  act(() => {
    configureTrainingStore(api);
    useTrainingStore.setState(realActions);
  });
}

/** Every mount is torn down in afterEach even when an assertion fails —
 * a leaked screen would re-run its focus effect on the next test's store
 * writes and pollute call counts. */
const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  mounted.push(renderer);
  await settle();
  return renderer;
}

function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
}

function readyStoreState(
  drills: SavedDrill[] = [drillA],
  details: Record<string, DrillDetail> = { [drillA.slug]: detailFor(drillA) },
) {
  setStore({
    savedStatus: 'ready',
    planStatus: 'ready',
    mutation: 'idle',
    savedDrills: drills,
    drillDetails: details,
    currentPlan: null,
    savedError: null,
    planError: null,
    mutationError: null,
    loadSavedDrills: async () => true,
    loadCurrentPlan: async () => true,
  });
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockListShots.mockReset();
  mockListPendingCaptures.mockReset();
  mockListShots.mockResolvedValue([shotScored, shotDink]);
  mockListPendingCaptures.mockResolvedValue([]);
  mockShowBrandNotice.mockClear();
  jest.spyOn(Linking, 'canOpenURL').mockClear();
  jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  jest.spyOn(Linking, 'openURL').mockClear();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  act(() => clearTrainingStoreConfiguration());
  readyStoreState();
});

afterEach(() => {
  unmountAll();
  act(() => clearTrainingStoreConfiguration());
});

// ------------------------------------------------------------ S1 · garbage

describe('S1 · reads row with resultKind scored / overallScore null / capturedAt garbage', () => {
  it('renders without throwing, is pressable, and opens its Result', async () => {
    mockListShots.mockResolvedValue([shotGarbage, shotScored]);
    const renderer = await renderLibrary();

    expect(allText(renderer)).toContain('2 analyzed reads');
    const row = findByLabel(renderer, 'Open third shot drop result');
    expect(row).not.toBeNull();
    await pressByLabel(renderer, 'Open third shot drop result');
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: shotGarbage.id,
    });
    // The healthy sibling row is unaffected by the hostile neighbour.
    expect(allText(renderer)).toContain('7.3');
  });

  it('[BROKEN@4d812e1a] never paints "NaN" / "INVALID DATE" placeholders into the row', async () => {
    mockListShots.mockResolvedValue([shotGarbage]);
    const renderer = await renderLibrary();
    const text = allText(renderer);

    // Expected: an unparseable timestamp degrades to a neutral placeholder
    // (e.g. "—"), never JavaScript's Invalid-Date artefacts.
    expect(text).not.toMatch(/\bNaN\b/);
    expect(text).not.toMatch(/INVALID DATE/i);
  });
});

// ------------------------------------------------ S2 · partial detail load

describe('S2 · three saved drills, catalog detail loads for exactly one', () => {
  function partialApi() {
    return fakeApi({
      listSavedDrills: jest.fn(async () => [drillA, drillB, drillC]),
      getDrill: jest.fn(async (slug: string) => {
        if (slug === drillA.slug) return detailFor(drillA);
        throw new Error(`catalog 503 for ${slug}`);
      }),
    });
  }

  it('renders exactly one card and the held-count copy for the two unverifiable entries', async () => {
    const api = partialApi();
    configureApi(api);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await settle();

    expect(hostLabelsWithPrefix(renderer, 'Remove ')).toEqual([
      `Remove ${drillA.title} from saved drills`,
    ]);
    expect(allText(renderer)).toContain('1 saved');
    const text = allText(renderer);
    expect(text).toContain(
      '2 additional saved entries are hidden because their server catalog entries could not be loaded.',
    );
    expect(text).not.toContain(drillB.title);
    expect(text).not.toContain(drillC.title);
    // Every slug was attempted exactly once by the store's detail loader.
    expect(api.getDrill).toHaveBeenCalledTimes(3);
  });

  it('[BROKEN@4d812e1a] exposes a retry control in the partially-held state that re-runs the detail refresh', async () => {
    const api = partialApi();
    configureApi(api);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await settle();
    expect(allText(renderer)).toContain('2 additional saved entries');

    // Expected: the held notice offers the same "Try again" the all-held
    // state offers, and it calls loadSavedDrills → getDrill for each slug.
    const retry = findByLabel(renderer, 'Try again');
    expect(retry).not.toBeNull();
    (api.getDrill as jest.Mock).mockClear();
    await pressByLabel(renderer, 'Try again');
    await settle();
    expect(api.getDrill).toHaveBeenCalledWith(drillB.slug);
    expect(api.getDrill).toHaveBeenCalledWith(drillC.slug);
  });

  it('a screen refocus re-runs loadSavedDrills and recovers the held entries once the catalog answers', async () => {
    const api = partialApi();
    configureApi(api);
    const first = await renderLibrary();
    await pressTab(first, 'Saved drills');
    await settle();
    expect(hostLabelsWithPrefix(first, 'Remove ')).toHaveLength(1);
    unmountAll();

    // Catalog heals; the next focus must re-attempt every slug.
    (api.getDrill as jest.Mock).mockImplementation(async (slug: string) => {
      const drill = [drillA, drillB, drillC].find(d => d.slug === slug)!;
      return detailFor(drill);
    });
    (api.getDrill as jest.Mock).mockClear();
    const second = await renderLibrary();
    await pressTab(second, 'Saved drills');
    await settle();
    expect(api.getDrill).toHaveBeenCalledTimes(3);
    expect(hostLabelsWithPrefix(second, 'Remove ')).toHaveLength(3);
    expect(allText(second)).not.toContain('additional saved');
  });
});

// ------------------------------------------------------- S3 · canOpenURL

describe('S3 · Linking.canOpenURL resolves false', () => {
  it('shows the branded media notice and never calls openURL (embed media)', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await pressByLabel(
      renderer,
      `Watch reviewed instruction for ${drillA.title}`,
    );

    expect(Linking.canOpenURL).toHaveBeenCalledWith(embedMedia.sourceUrl);
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Video unavailable',
        tone: 'danger',
        eyebrow: 'COACHING VIDEO',
      }),
    );
  });

  it('hosted media: canOpenURL false → notice, openURL never called', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    readyStoreState([drillA], {
      [drillA.slug]: detailFor(drillA, [hostedMedia]),
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await pressByLabel(
      renderer,
      `Watch reviewed instruction for ${drillA.title}`,
    );

    expect(Linking.canOpenURL).toHaveBeenCalledWith(hostedMedia.playbackUrl);
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
  });

  it('canOpenURL REJECTS → same notice path, openURL never called', async () => {
    jest
      .spyOn(Linking, 'canOpenURL')
      .mockRejectedValue(new Error('LSApplicationQueriesSchemes'));
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await pressByLabel(
      renderer,
      `Watch reviewed instruction for ${drillA.title}`,
    );
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
  });

  it('rapid double tap on Watch with canOpenURL false never reaches openURL', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    const watch = findByLabel(
      renderer,
      `Watch reviewed instruction for ${drillA.title}`,
    )!;
    await act(async () => {
      watch.props.onPress();
      watch.props.onPress();
    });
    await settle();
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(mockShowBrandNotice.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------- S4 · listShots ok, pending rejects

describe('S4 · listShots resolves while listPendingCaptures rejects', () => {
  it('current behaviour: both lists are discarded and the empty state renders (no throw)', async () => {
    mockListShots.mockResolvedValue([shotScored, shotDink]);
    mockListPendingCaptures.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    const renderer = await renderLibrary();

    const text = allText(renderer);
    expect(mockListShots).toHaveBeenCalledTimes(1);
    expect(mockListPendingCaptures).toHaveBeenCalledTimes(1);
    expect(text).toContain('Your measured reads, in one place.');
    expect(findByLabel(renderer, 'Analyze your first stroke')).not.toBeNull();
    expect(findByLabel(renderer, 'Open forehand drive result')).toBeNull();
    expect(text).not.toContain('analyzed read');
  });

  it('[BROKEN@4d812e1a] the two reads that DID load are not hidden behind a first-run empty state', async () => {
    mockListShots.mockResolvedValue([shotScored, shotDink]);
    mockListPendingCaptures.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    const renderer = await renderLibrary();
    const text = allText(renderer);

    // Expected: either the loaded reads render (pending section simply
    // absent) or an explicit "couldn't load" notice replaces the first-run
    // "Analyze your first stroke" copy. Neither happens.
    const readsVisible =
      findByLabel(renderer, 'Open forehand drive result') !== null;
    const errorCopyVisible =
      /couldn.t|could not|unavailable|try again/i.test(text) &&
      !text.includes('Your measured reads, in one place.');
    expect(readsVisible || errorCopyVisible).toBe(true);
  });

  it('inverse interleaving: listShots rejects while pending resolves → same silent empty state', async () => {
    mockListShots.mockRejectedValue(new Error('SQLITE_BUSY'));
    mockListPendingCaptures.mockResolvedValue([pendingCapture({})]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('Your measured reads, in one place.');
    expect(text).not.toContain('pending clip');
  });
});

// ------------------------------------------- S5 · corrupt evidence, no clip

describe('S5 · pending capture with evidenceStatus corrupt and clip null', () => {
  function tracked(capture: PendingCapture) {
    const touched = new Set<string>();
    const proxy = new Proxy(capture, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') touched.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    return { proxy, touched };
  }

  it('renders NOT SCORED + the unscorable disclosure without reading clip.*', async () => {
    const { proxy, touched } = tracked(
      pendingCapture({ evidenceStatus: 'corrupt', clip: null }),
    );
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([proxy]);
    const renderer = await renderLibrary();

    const text = allText(renderer);
    expect(text).toContain('1 pending clip');
    expect(text).toContain(PENDING_SECTION_PILL);
    expect(text).toContain(
      'Saved evidence could not be verified — can’t be scored',
    );
    expect(text).toContain('Forehand Drive · auto capture');
    expect(touched.has('clip')).toBe(false);
  });

  it.each([
    ['legacy', 'Recorded by an older app version — can’t be scored'],
    [
      'metadata_mismatch',
      'Evidence doesn’t match this video — can’t be scored',
    ],
  ] as const)(
    'evidenceStatus %s with clip null → NOT SCORED and honest copy, clip untouched',
    async (status, copy) => {
      const { proxy, touched } = tracked(
        pendingCapture({ evidenceStatus: status, clip: null }),
      );
      mockListShots.mockResolvedValue([]);
      mockListPendingCaptures.mockResolvedValue([proxy]);
      const renderer = await renderLibrary();
      const text = allText(renderer);
      expect(text).toContain(PENDING_SECTION_PILL);
      expect(text).toContain(copy);
      expect(touched.has('clip')).toBe(false);
    },
  );

  it('evidenceStatus valid with clip null degrades to "analysis has not run yet" (no throw)', async () => {
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([
      pendingCapture({ evidenceStatus: 'valid', clip: null }),
    ]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('Clip saved — analysis has not run yet');
    expect(text).not.toContain('pose frames');
  });
});

// ----------------------------------------------- S6 · rapid double unsave

describe('S6 · rapid double-press on "Remove from saved" for the same slug', () => {
  it('issues exactly one unsave mutation and one reload when the API is slow', async () => {
    const gate = deferred<void>();
    const api = fakeApi({
      listSavedDrills: jest.fn(async () => [drillA]),
      unsaveDrill: jest.fn(() => gate.promise),
    });
    configureApi(api);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await settle();
    expect(api.listSavedDrills).toHaveBeenCalledTimes(1);

    const remove = findByLabel(
      renderer,
      `Remove ${drillA.title} from saved drills`,
    )!;
    await act(async () => {
      remove.props.onPress();
      remove.props.onPress();
    });
    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    expect(useTrainingStore.getState().mutation).toBe(`saving:${drillA.slug}`);
    // A third tap while the first is in flight is refused by the store guard.
    let thirdResult!: Promise<boolean>;
    await act(async () => {
      thirdResult = useTrainingStore
        .getState()
        .setDrillSaved(drillA.slug, false);
    });
    expect(await thirdResult).toBe(false);
    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    expect(
      findByLabel(renderer, `Remove ${drillA.title} from saved drills`)!.props
        .disabled,
    ).toBe(true);

    await act(async () => {
      gate.resolve();
    });
    await settle();
    expect(useTrainingStore.getState().mutation).toBe('idle');
    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    expect(api.listSavedDrills).toHaveBeenCalledTimes(2);
    expect(dismissRegions(renderer)).toHaveLength(0);
  });

  it('failing unsave under a double-tap yields ONE error region; one dismiss clears it; a second dismiss is a no-op', async () => {
    const api = fakeApi({
      listSavedDrills: jest.fn(async () => [drillA]),
      unsaveDrill: jest.fn(async () => {
        throw new Error('503');
      }),
    });
    configureApi(api);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await settle();

    const remove = findByLabel(
      renderer,
      `Remove ${drillA.title} from saved drills`,
    )!;
    await act(async () => {
      remove.props.onPress();
      remove.props.onPress();
    });
    await settle();

    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    const regions = dismissRegions(renderer);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.props.accessibilityLabel).toBe(
      'Training is temporarily unavailable.',
    );
    // The card survives the failed mutation and is tappable again.
    expect(
      findByLabel(renderer, `Remove ${drillA.title} from saved drills`)!.props
        .disabled,
    ).toBe(false);

    const dismiss = regions[0]!;
    await act(async () => {
      dismiss.props.onPress();
      dismiss.props.onPress();
    });
    expect(dismissRegions(renderer)).toHaveLength(0);
    expect(useTrainingStore.getState().mutationError).toBeNull();
  });
});

// ------------------------------------------------------------------ extras

describe('extras · saved-drill list durability', () => {
  it('[BROKEN@4d812e1a] a successful unsave whose follow-up reload fails keeps the remaining saved drills on screen', async () => {
    let listCalls = 0;
    const api = fakeApi({
      listSavedDrills: jest.fn(async () => {
        listCalls += 1;
        if (listCalls === 1) return [drillA, drillB];
        throw new Error('502 on reload');
      }),
      getDrill: jest.fn(async (slug: string) =>
        detailFor([drillA, drillB].find(d => d.slug === slug)!),
      ),
    });
    configureApi(api);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await settle();
    expect(hostLabelsWithPrefix(renderer, 'Remove ')).toHaveLength(2);

    await pressByLabel(renderer, `Remove ${drillA.title} from saved drills`);
    await settle();

    expect(api.unsaveDrill).toHaveBeenCalledWith(drillA.slug);
    // Expected: drill B — known-good, still saved server-side — stays
    // visible. Observed: the whole list is wiped to "Training is offline."
    expect(
      findByLabel(renderer, `Remove ${drillB.title} from saved drills`),
    ).not.toBeNull();
  });

  it('huge unicode titles / descriptions render and stay pressable', async () => {
    const huge = '🥒'.repeat(2_000) + 'Ünïcødé ' + 'x'.repeat(10_000);
    const drill = savedDrill('huge', huge);
    readyStoreState([drill], { huge: detailFor(drill) });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    const remove = findByLabel(renderer, `Remove ${huge} from saved drills`);
    expect(remove).not.toBeNull();
    expect(
      findByLabel(renderer, `Watch reviewed instruction for ${huge}`),
    ).not.toBeNull();
  });
});

describe('extras · pending list', () => {
  it('[BROKEN@4d812e1a] with 100 pending clips the header count and the 3 visible rows disclose the truncation', async () => {
    const captures = Array.from({ length: 100 }, (_, i) =>
      pendingCapture({
        id: `cap-${i}`,
        evidenceStatus: i % 2 ? 'corrupt' : 'valid',
        declaredStroke: i % 3 ? 'dink' : null,
      }),
    );
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue(captures);
    const renderer = await renderLibrary();
    const text = allText(renderer);

    expect(text).toContain('100 pending clips');
    const rows = renderer.root
      .findAllByType(Text)
      .filter(
        n =>
          Array.isArray(n.props.children) &&
          n.props.children.includes('s clip ·'),
      );
    expect(rows).toHaveLength(3);
    // Expected: some "showing 3 of 100" / "97 more" disclosure.
    expect(text).toMatch(/97 more|3 of 100|showing 3/i);
  });

  it('declaredStroke "" / "__" / unicode / MAX_SAFE_INTEGER duration / garbage date never throws', async () => {
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([
      pendingCapture({
        id: 'a',
        declaredStroke: offContract(''),
        evidenceStatus: 'legacy',
      }),
      pendingCapture({
        id: 'b',
        declaredStroke: offContract('__'),
        evidenceStatus: 'legacy',
      }),
      pendingCapture({
        id: 'c',
        declaredStroke: offContract('ünder_score_ストローク'),
        evidenceStatus: 'legacy',
        durationMs: Number.MAX_SAFE_INTEGER,
        capturedAtIso: 'garbage',
      }),
    ]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('Auto capture');
    expect(text).toContain('Ünder Score ストローク · auto capture');
  });
});
