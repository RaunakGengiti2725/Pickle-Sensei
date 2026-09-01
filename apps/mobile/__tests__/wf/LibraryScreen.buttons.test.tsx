import React from 'react';
import { Alert, Linking, StyleSheet, Text } from 'react-native';
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
  TrainingPlan,
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

let mockLocalOnly = false;
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: mockLocalOnly } }),
}));

import { LibraryScreen } from '../../src/screens/LibraryScreen';

/**
 * Button ledger for LibraryScreen: every pressable the screen renders (in
 * every state) is pressed here and its real observable effect asserted —
 * navigation target + params, training-store mutation, Linking call, or
 * copy change. Failure paths of the async handlers are covered too.
 */

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

const shotNotRead: LocalShotRow = {
  ...shotScored,
  id: '22222222-2222-4222-8222-222222222222',
  shotType: 'dink',
  capturedAt: '2026-08-29T09:30:00.000Z',
  overallScore: null,
  confidence: 0.2,
  resultKind: 'low_confidence',
};

/** Server rows can arrive with a scored kind but no number; must not throw. */
const shotScoredWithoutNumber: LocalShotRow = {
  ...shotScored,
  id: '33333333-3333-4333-8333-333333333333',
  shotType: 'third_shot_drop',
  capturedAt: 'not-a-date',
  overallScore: null,
};

const pendingCapture: PendingCapture = {
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
};

const savedDrill: SavedDrill = {
  id: 'a2e6f9d0-1111-4222-8333-444455556666',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: null,
  difficultyMax: null,
  savedAt: '2026-08-30T10:00:00.000Z',
};

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

const savedDetail: DrillDetail = {
  id: savedDrill.id,
  slug: savedDrill.slug,
  title: savedDrill.title,
  description: savedDrill.description,
  coachName: savedDrill.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: true,
  mappings: [],
  instructionalMedia: [embedMedia],
};

const currentPlan: TrainingPlan = {
  id: 'plan-1',
  status: 'active',
  algorithmVersion: 'v1',
  sourceShotId: '55555555-5555-4555-8555-555555555555',
  shotType: 'forehand_drive',
  priorityCheckpoint: 'contact_position',
  priorityDirection: 'too_late',
  baselineScore: 6.1,
  baselineCheckpointScore: 52,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-30T10:00:00.000Z',
  completedAt: null,
  items: [
    {
      id: 'item-1',
      position: 1,
      kind: 'targeted',
      drill: {
        slug: savedDrill.slug,
        title: savedDrill.title,
        description: savedDrill.description,
        coachName: savedDrill.coachName,
        equipment: [],
        saved: true,
      },
      cueText: null,
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: null,
      completion: null,
    },
  ],
};

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [savedDrill]),
    getDrill: jest.fn(async () => savedDetail),
    saveDrill: jest.fn(async () => undefined),
    unsaveDrill: jest.fn(async () => undefined),
    getCurrentPlan: jest.fn(async () => null),
    createPlan: jest.fn(async () => currentPlan),
    completeDrill: jest.fn(async () => {
      throw new Error('not used');
    }),
    reassessPlan: jest.fn(async () => currentPlan),
    ...overrides,
  };
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** Composite nodes carrying a real onPress (PressableScale / Pressable). */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => typeof n.type !== 'string' && typeof n.props.onPress === 'function',
  );
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
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

function pressedStyle(node: TestRenderer.ReactTestInstance) {
  const style = node.props.style;
  return StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed: false }) : style,
  ) as { minHeight?: number; height?: number; width?: number };
}

/** Drain every chained microtask (store loads await several promises). */
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

/** The store's real loaders; `reset()` keeps whatever actions are installed. */
const realLoaders = {
  loadSavedDrills: useTrainingStore.getState().loadSavedDrills,
  loadCurrentPlan: useTrainingStore.getState().loadCurrentPlan,
};

function configureApi(api: TrainingApi) {
  act(() => {
    configureTrainingStore(api);
    useTrainingStore.setState(realLoaders);
  });
}

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  await settle();
  return renderer;
}

function readyStoreState() {
  setStore({
    savedStatus: 'ready',
    planStatus: 'ready',
    mutation: 'idle',
    savedDrills: [savedDrill],
    drillDetails: { [savedDrill.slug]: savedDetail },
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
  mockLocalOnly = false;
  mockListShots.mockReset();
  mockListPendingCaptures.mockReset();
  mockListShots.mockResolvedValue([shotScored, shotNotRead]);
  mockListPendingCaptures.mockResolvedValue([]);
  jest.spyOn(Alert, 'alert').mockClear();
  jest.spyOn(Linking, 'canOpenURL').mockClear();
  jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  jest.spyOn(Linking, 'openURL').mockClear();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  act(() => clearTrainingStoreConfiguration());
  readyStoreState();
});

afterEach(() => {
  act(() => clearTrainingStoreConfiguration());
});

describe('LibraryScreen · segmented tabs', () => {
  it('Reads / Saved drills tabs switch the page and expose tab semantics', async () => {
    const renderer = await renderLibrary();

    const reads = findTab(renderer, 'Reads');
    const saved = findTab(renderer, 'Saved drills');
    expect(reads.props.accessibilityRole).toBe('tab');
    expect(saved.props.accessibilityRole).toBe('tab');
    expect(reads.props.accessibilityState).toEqual({ selected: true });
    expect(saved.props.accessibilityState).toEqual({ selected: false });
    expect(pressedStyle(reads).minHeight).toBeGreaterThanOrEqual(44);
    expect(pressedStyle(saved).minHeight).toBeGreaterThanOrEqual(44);

    // Reads page is up: rows render, saved-tab content does not.
    expect(allText(renderer)).toContain('2 analyzed reads');
    expect(findByLabel(renderer, 'Explore the Drill Library')).toBeNull();

    await pressTab(renderer, 'Saved drills');
    expect(findTab(renderer, 'Saved drills').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(findByLabel(renderer, 'Explore the Drill Library')).not.toBeNull();
    expect(allText(renderer)).not.toContain('analyzed reads');

    await pressTab(renderer, 'Reads');
    expect(findTab(renderer, 'Reads').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(allText(renderer)).toContain('2 analyzed reads');
    expect(findByLabel(renderer, 'Explore the Drill Library')).toBeNull();

    act(() => renderer.unmount());
  });
});

describe('LibraryScreen · reads tab', () => {
  it('shows a loading state until the local repository answers', async () => {
    const pending = deferred<LocalShotRow[]>();
    mockListShots.mockReturnValue(pending.promise);
    const renderer = await renderLibrary();

    expect(allText(renderer)).toContain('Opening your library…');
    // Only the header tabs are pressable while loading — never a dead tap.
    expect(
      pressables(renderer).filter(n => n.props.accessibilityRole !== 'tab'),
    ).toHaveLength(0);

    await act(async () => {
      pending.resolve([shotScored]);
    });
    await settle();
    expect(allText(renderer)).not.toContain('Opening your library…');
    expect(allText(renderer)).toContain('1 analyzed read');

    act(() => renderer.unmount());
  });

  it('a read row opens its Result with the row id as analysisId', async () => {
    const renderer = await renderLibrary();

    const row = findByLabel(renderer, 'Open forehand drive result');
    expect(row).not.toBeNull();
    expect(pressedStyle(row!).minHeight).toBeGreaterThanOrEqual(44);
    expect(allText(renderer)).toContain('7.3');

    await pressByLabel(renderer, 'Open forehand drive result');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: shotScored.id,
    });

    act(() => renderer.unmount());
  });

  it('a low-confidence read is labeled NOT READ and still opens its Result', async () => {
    const renderer = await renderLibrary();

    expect(allText(renderer)).toContain('NOT READ');
    await pressByLabel(renderer, 'Open dink result');
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: shotNotRead.id,
    });

    act(() => renderer.unmount());
  });

  it('renders rows with a missing score / unparseable timestamp without throwing', async () => {
    mockListShots.mockResolvedValue([shotScoredWithoutNumber]);
    const renderer = await renderLibrary();

    expect(findByLabel(renderer, 'Open third shot drop result')).not.toBeNull();
    await pressByLabel(renderer, 'Open third shot drop result');
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: shotScoredWithoutNumber.id,
    });

    act(() => renderer.unmount());
  });

  it('empty library: "Analyze your first stroke" opens the Analyze route', async () => {
    mockListShots.mockResolvedValue([]);
    const renderer = await renderLibrary();

    expect(allText(renderer)).toContain('Your measured reads, in one place.');
    const button = findByLabel(renderer, 'Analyze your first stroke');
    expect(button).not.toBeNull();
    expect(button!.props.disabled).toBeFalsy();

    await pressByLabel(renderer, 'Analyze your first stroke');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Analyze');

    act(() => renderer.unmount());
  });

  it('pending clips render their honest copy; the rows themselves are not buttons', async () => {
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([pendingCapture]);
    const renderer = await renderLibrary();

    const text = allText(renderer);
    expect(text).toContain('0 analyzed reads · 1 pending clip');
    expect(text).toContain('SAVED CLIPS · READY TO ANALYZE');
    expect(text).toContain('Forehand Drive · auto capture');
    expect(text).toContain('Clip saved — analysis has not run yet');
    // With pending clips present the empty-state CTA is withheld, so the
    // only pressables on the page are the two header tabs.
    expect(
      pressables(renderer).filter(n => n.props.accessibilityRole !== 'tab'),
    ).toHaveLength(0);
    // WF-ISSUE: Pending clips are labelled "READY TO ANALYZE" but neither the
    // rows nor any other control on this page can analyze them (no
    // Analyze-with-captureId route exists) — the section is a dead end.

    act(() => renderer.unmount());
  });
});

describe('LibraryScreen · saved tab navigation', () => {
  it('"Explore the Drill Library" opens the DrillLibrary route', async () => {
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    const explore = findByLabel(renderer, 'Explore the Drill Library');
    expect(pressedStyle(explore!).minHeight).toBeGreaterThanOrEqual(44);
    await pressByLabel(renderer, 'Explore the Drill Library');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('DrillLibrary');

    act(() => renderer.unmount());
  });

  it('the current-plan card opens the Result of the plan source shot', async () => {
    setStore({ currentPlan });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    const text = allText(renderer);
    expect(text).toContain('CURRENT PLAN');
    expect(text).toContain('0/1 DONE');
    expect(text).toContain('Continue plan');
    const card = findByLabel(renderer, 'Open your current personalized plan');
    expect(pressedStyle(card!).minHeight).toBeGreaterThanOrEqual(44);

    await pressByLabel(renderer, 'Open your current personalized plan');
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: currentPlan.sourceShotId,
    });

    act(() => renderer.unmount());
  });

  it('the plan card is absent while the plan is not ready', async () => {
    setStore({ currentPlan, planStatus: 'loading' });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    expect(
      findByLabel(renderer, 'Open your current personalized plan'),
    ).toBeNull();
    act(() => renderer.unmount());
  });

  it('guest session + unconfigured training: "Connect account" opens ConnectAccount', async () => {
    mockLocalOnly = true;
    setStore({
      savedStatus: 'unconfigured',
      savedDrills: [],
      savedError: {
        code: 'training.unconfigured',
        message:
          'Connect a synced account to load saved drills and personalized plans.',
        retryable: false,
        status: null,
      },
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    expect(allText(renderer)).toContain(
      'Saved training needs a synced account.',
    );
    expect(allText(renderer)).toContain('Connect a synced account');
    await pressByLabel(renderer, 'Connect account');
    expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');

    act(() => renderer.unmount());
  });

  it('synced session + unconfigured training shows the explanation without a guest CTA', async () => {
    mockLocalOnly = false;
    setStore({
      savedStatus: 'unconfigured',
      savedDrills: [],
      savedError: null,
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    expect(allText(renderer)).toContain(
      'no authenticated training API connection',
    );
    expect(findByLabel(renderer, 'Connect account')).toBeNull();

    act(() => renderer.unmount());
  });
});

describe('LibraryScreen · saved tab retries (real training store)', () => {
  it('"Try again" after a load failure re-runs loadSavedDrills and recovers', async () => {
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue([savedDrill]);
    configureApi(fakeApi({ listSavedDrills }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    expect(useTrainingStore.getState().savedStatus).toBe('error');
    expect(allText(renderer)).toContain('Training is offline.');
    expect(allText(renderer)).toContain('Training is temporarily unavailable.');
    expect(listSavedDrills).toHaveBeenCalledTimes(1);

    await pressByLabel(renderer, 'Try again');
    await settle();
    expect(listSavedDrills).toHaveBeenCalledTimes(2);
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
    expect(allText(renderer)).toContain('Dink Target Ladder');
    expect(allText(renderer)).not.toContain('Training is offline.');

    act(() => renderer.unmount());
  });

  it('"Try again" while a retry is in flight is replaced by the loading state (no double fire)', async () => {
    const gate = deferred<SavedDrill[]>();
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockReturnValue(gate.promise);
    configureApi(fakeApi({ listSavedDrills }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    await pressByLabel(renderer, 'Try again');

    expect(findByLabel(renderer, 'Try again')).toBeNull();
    expect(allText(renderer)).toContain('Loading saved drills…');

    await act(async () => {
      gate.resolve([savedDrill]);
    });
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');

    act(() => renderer.unmount());
  });

  it('"Try again" for held (unverified) entries reloads their catalog detail', async () => {
    const getDrill = jest
      .fn<Promise<DrillDetail>, [string]>()
      .mockRejectedValueOnce(new Error('catalog 503'))
      .mockResolvedValue(savedDetail);
    configureApi(fakeApi({ getDrill }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    expect(allText(renderer)).toContain(
      'Saved entries couldn’t be verified right now.',
    );
    expect(allText(renderer)).not.toContain('Dink Target Ladder');

    await pressByLabel(renderer, 'Try again');
    await settle();
    expect(getDrill).toHaveBeenCalledTimes(2);
    expect(getDrill).toHaveBeenLastCalledWith(savedDrill.slug);
    expect(allText(renderer)).toContain('Dink Target Ladder');
    expect(allText(renderer)).not.toContain('couldn’t be verified right now');

    act(() => renderer.unmount());
  });
});

describe('LibraryScreen · saved drill card actions (real training store)', () => {
  const removeLabel = `Remove ${savedDrill.title} from saved drills`;
  const watchLabel = `Watch reviewed instruction for ${savedDrill.title}`;

  it('the bookmark button unsaves through the API and the entry leaves the list', async () => {
    const unsaveDrill = jest.fn<Promise<void>, [string]>(async () => undefined);
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([savedDrill])
      .mockResolvedValue([]);
    configureApi(fakeApi({ unsaveDrill, listSavedDrills }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');
    expect(allText(renderer)).toContain('1 saved');

    const bookmark = findByLabel(renderer, removeLabel);
    expect(bookmark).not.toBeNull();
    expect(bookmark!.props.disabled).toBe(false);
    const size = pressedStyle(bookmark!);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);

    await pressByLabel(renderer, removeLabel);
    await settle();
    expect(unsaveDrill).toHaveBeenCalledWith(savedDrill.slug);
    expect(useTrainingStore.getState().savedDrills).toEqual([]);
    expect(allText(renderer)).toContain('No saved drills yet.');
    expect(findByLabel(renderer, removeLabel)).toBeNull();

    act(() => renderer.unmount());
  });

  it('the bookmark button is disabled while the unsave is in flight', async () => {
    const gate = deferred<void>();
    const unsaveDrill = jest.fn<Promise<void>, [string]>(() => gate.promise);
    configureApi(fakeApi({ unsaveDrill }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    await pressByLabel(renderer, removeLabel);
    expect(useTrainingStore.getState().mutation).toBe(
      `saving:${savedDrill.slug}`,
    );
    expect(findByLabel(renderer, removeLabel)!.props.disabled).toBe(true);

    await act(async () => {
      gate.resolve();
    });
    await settle();
    expect(useTrainingStore.getState().mutation).toBe('idle');

    act(() => renderer.unmount());
  });

  it('a failed unsave surfaces the inline error, keeps the entry, and re-enables the button', async () => {
    const unsaveDrill = jest.fn<Promise<void>, [string]>(async () => {
      throw new Error('server 503');
    });
    configureApi(fakeApi({ unsaveDrill }));

    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    await pressByLabel(renderer, removeLabel);
    await settle();

    expect(unsaveDrill).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Dink Target Ladder');
    expect(allText(renderer)).toContain('Training is temporarily unavailable.');
    const bookmark = findByLabel(renderer, removeLabel);
    expect(bookmark!.props.disabled).toBe(false);

    // The inline error is itself a pressable that dismisses it.
    const [inlineError] = renderer.root.findAll(
      n =>
        n.props.accessibilityRole === 'alert' &&
        typeof n.props.onPress === 'function',
    );
    expect(inlineError).toBeDefined();
    await act(async () => {
      inlineError!.props.onPress();
    });
    expect(useTrainingStore.getState().mutationError).toBeNull();
    expect(allText(renderer)).not.toContain(
      'Training is temporarily unavailable.',
    );
    expect(
      renderer.root.findAll(n => n.props.accessibilityRole === 'alert'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('"Watch form" opens the embed’s canonical watch page (never the /embed/ URL)', async () => {
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    const watch = findByLabel(renderer, watchLabel);
    expect(watch).not.toBeNull();
    expect(watch!.props.accessibilityHint).toBe(embedMedia.attribution);
    expect(pressedStyle(watch!).minHeight).toBeGreaterThanOrEqual(44);

    await pressByLabel(renderer, watchLabel);
    await settle();
    expect(Linking.canOpenURL).toHaveBeenCalledWith(embedMedia.sourceUrl);
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledWith(embedMedia.sourceUrl);
    expect(Linking.openURL).not.toHaveBeenCalledWith(embedMedia.embedUrl);
    expect(Alert.alert).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('"Watch form" opens hosted media at its playback URL', async () => {
    setStore({
      drillDetails: {
        [savedDrill.slug]: {
          ...savedDetail,
          instructionalMedia: [hostedMedia],
        },
      },
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    await pressByLabel(renderer, watchLabel);
    await settle();
    expect(Linking.openURL).toHaveBeenCalledWith(hostedMedia.playbackUrl);
    expect(Alert.alert).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('"Watch form" explains when the URL cannot be opened', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    await pressByLabel(renderer, watchLabel);
    await settle();
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Video unavailable',
      expect.stringContaining('could not be opened'),
    );
    // The control stays usable for another attempt.
    expect(findByLabel(renderer, watchLabel)!.props.disabled).toBeFalsy();

    act(() => renderer.unmount());
  });

  it('"Watch form" explains when Linking.openURL rejects', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    await pressByLabel(renderer, watchLabel);
    await settle();
    expect(Linking.openURL).toHaveBeenCalledWith(embedMedia.sourceUrl);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Video unavailable',
      expect.stringContaining('Refresh the library and try again'),
    );

    act(() => renderer.unmount());
  });

  it('a saved card without playable media offers no Watch control and says so', async () => {
    setStore({
      drillDetails: {
        [savedDrill.slug]: { ...savedDetail, instructionalMedia: [] },
      },
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    expect(findByLabel(renderer, watchLabel)).toBeNull();
    expect(allText(renderer)).toContain(
      'No rights-cleared coaching video is published for this drill yet.',
    );

    act(() => renderer.unmount());
  });
});

describe('LibraryScreen · pressable ledger', () => {
  it('every pressable on the saved tab has a role and a descriptive label', async () => {
    setStore({
      currentPlan,
      mutationError: {
        code: 'training.request_failed',
        message: 'Could not update saved drills.',
        retryable: true,
        status: 503,
      },
    });
    const renderer = await renderLibrary();
    await pressTab(renderer, 'Saved drills');

    const labels = pressables(renderer)
      .filter(n => n.props.accessibilityRole !== 'tab')
      .map(
        n =>
          n.props.accessibilityLabel ?? `<role:${n.props.accessibilityRole}>`,
      );
    // Each PressableScale appears twice (wrapper + inner Pressable); dedupe.
    expect(new Set(labels)).toEqual(
      new Set([
        'Open your current personalized plan',
        'Explore the Drill Library',
        `Remove ${savedDrill.title} from saved drills`,
        `Watch reviewed instruction for ${savedDrill.title}`,
        '<role:alert>',
      ]),
    );
    for (const node of renderer.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityRole !== undefined,
    )) {
      expect(['button', 'tab', 'alert']).toContain(
        node.props.accessibilityRole,
      );
    }

    act(() => renderer.unmount());
  });

  it('every pressable on the reads tab has a role and a descriptive label', async () => {
    const renderer = await renderLibrary();
    const labels = pressables(renderer)
      .filter(n => n.props.accessibilityRole !== 'tab')
      .map(n => n.props.accessibilityLabel);
    expect(new Set(labels)).toEqual(
      new Set(['Open forehand drive result', 'Open dink result']),
    );
    act(() => renderer.unmount());
  });
});
