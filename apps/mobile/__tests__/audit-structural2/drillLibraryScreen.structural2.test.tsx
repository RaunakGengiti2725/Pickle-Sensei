// Structural audit #2 (pass 1) — DrillLibraryScreen coupling to the API
// session and timing of optimistic state. `REPRO:` cases assert the behaviour
// the screen SHOULD have and fail on 4d812e1a; `VERIFY:` cases hold.
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import {
  TrainingError,
  type DrillDetail,
  type InstructionalMedia,
} from '../../src/training/types';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';

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
/** Every createTrainingApi call, with the token it captured. */
const mockCreatedClients: Array<{ baseUrl?: string; token?: string }> = [];
jest.mock('../../src/training/api', () => ({
  createTrainingApi: (config: { baseUrl?: string; token?: string }) => {
    mockCreatedClients.push({ baseUrl: config.baseUrl, token: config.token });
    if (!config.baseUrl || !config.token) {
      // Mirrors the real client: no session → fail closed, unconfigured.
      const { TrainingError: Err } =
        require('../../src/training/types') as typeof import('../../src/training/types');
      const unconfigured = async () => {
        throw new Err(
          'training.unconfigured',
          'Sign in to a synced account before loading training plans.',
          false,
        );
      };
      return {
        listCatalogDrills: unconfigured,
        saveDrill: unconfigured,
        unsaveDrill: unconfigured,
        getDrill: unconfigured,
      };
    }
    return {
      listCatalogDrills: mockListCatalogDrills,
      saveDrill: mockSaveDrill,
      unsaveDrill: mockUnsaveDrill,
      getDrill: mockGetDrill,
    };
  },
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

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

const session: ApiSession = {
  apiBaseUrl: 'https://api.pickle.test',
  bearerToken: 'access-token-1',
  canonicalAppUserId: '2f6c1d8e-1b7a-4c3d-9e5f-0a1b2c3d4e5f',
  provider: 'apple',
  refreshToken: 'refresh-1',
  bearerExpiresAtMs: Date.now() + 3_600_000,
};

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

function hostedMedia(expiresAt: string): InstructionalMedia {
  return {
    id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
    kind: 'hosted',
    playbackUrl: 'https://media.pickle.test/signed/dink.mp4?sig=abc',
    sourceUrl: 'https://media.pickle.test/dink',
    expiresAt,
    creatorName: 'Coach Rivera',
    licenseName: 'Published with permission',
    licenseUrl: null,
    attribution: 'Coach Rivera instructional video',
  } as InstructionalMedia;
}

function detailWith(media: InstructionalMedia[]): DrillDetail {
  return {
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
    instructionalMedia: media,
  };
}

/** Every renderer is unmounted in afterEach so a failing REPRO cannot leak a
 * mounted screen (and its store subscriptions) into the next case. */
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
    act(() => {
      renderer.unmount();
    });
  }
}

async function settle() {
  await act(async () => {});
}

function textWithin(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
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

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(n => n.props.testID === testID);
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

async function advanceTimers(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('DrillLibraryScreen — structural audit #2', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    establishApiSession(session);
    mockCreatedClients.length = 0;
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dinkDrill }, { ...volleyDrill }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockResolvedValue(detailWith([]));
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockNavigate.mockClear();
  });

  afterEach(() => {
    unmountAll();
    clearApiSession();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('REPRO: a catalog refetch that lands during an in-flight save must not leave the bookmark contradicting the "Saved" toast (DrillLibraryScreen.tsx:604-640)', async () => {
    const save = deferred<void>();
    mockSaveDrill.mockReset().mockImplementation(() => save.promise);
    const renderer = renderScreen();
    await settle();

    await pressByLabel(renderer, 'Save Dink Target Ladder');
    // Optimistic: shows as saved while PUT is in flight.
    expect(
      findPressableByLabel(
        renderer,
        'Remove Dink Target Ladder from saved drills',
      ),
    ).not.toBeNull();

    // The user narrows the search while the save is still in flight; the
    // refetch answers with the server's PRE-save truth (saved: false).
    typeSearch(renderer, 'dink');
    await advanceTimers(300);
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);

    await act(async () => {
      save.resolve();
    });
    // The server accepted the save and the toast says so, so the bookmark
    // must agree: "Remove … from saved drills" must be the live control.
    expect({
      toast: allText(renderer).includes('Saved to your library'),
      showsAsSaved:
        findPressableByLabel(
          renderer,
          'Remove Dink Target Ladder from saved drills',
        ) !== null,
      showsAsUnsaved:
        findPressableByLabel(renderer, 'Save Dink Target Ladder') !== null,
    }).toEqual({ toast: true, showsAsSaved: true, showsAsUnsaved: false });
  });

  it('REPRO: an access-token rotation does not rebuild the client or refetch the catalog (DrillLibraryScreen.tsx:471-476, 597-602)', async () => {
    renderScreen();
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(mockCreatedClients).toHaveLength(1);

    // sessionKeeper rotates the bearer 60s before expiry (AGENTS.md: long-
    // lived clients resolve the bearer per request; never capture it).
    act(() => {
      establishApiSession({
        ...session,
        bearerToken: 'access-token-2',
        bearerExpiresAtMs: Date.now() + 3_600_000,
      });
    });
    await settle();
    expect({
      clientsBuilt: mockCreatedClients.map(c => c.token),
      catalogFetches: mockListCatalogDrills.mock.calls.length,
    }).toEqual({ clientsBuilt: ['access-token-1'], catalogFetches: 1 });
  });

  it('REPRO: a rotation while offline must not surface an unprompted error banner over a loaded catalog', async () => {
    const renderer = renderScreen();
    await settle();
    expect(findByTestId(renderer, 'drill-library-inline-error')).toBeNull();

    mockListCatalogDrills
      .mockReset()
      .mockRejectedValue(
        new TrainingError(
          'training.unavailable',
          'The training service could not be reached.',
          true,
        ),
      );
    act(() => {
      establishApiSession({ ...session, bearerToken: 'access-token-2' });
    });
    await settle();
    // The user did nothing; the catalog is still on screen…
    expect(allText(renderer)).toContain('Dink Target Ladder');
    // …so no error may appear unprompted.
    const banner = findByTestId(renderer, 'drill-library-inline-error');
    expect({
      bannerShown: banner !== null,
      bannerCopy: banner ? textWithin(banner) : '',
    }).toEqual({ bannerShown: false, bannerCopy: '' });
  });

  it('REPRO: losing the API session while mounted shows the Connect-account state, not an inline banner over a stale catalog with live save buttons', async () => {
    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');

    // authStore.clearSyncedRuntime() (implicit sign-out without a refresh
    // token, or a provider re-sign-in from ConnectAccount) clears the API
    // session while the auth session — and this screen — stay mounted.
    act(() => {
      clearApiSession();
    });
    await settle();

    const inline = findByTestId(renderer, 'drill-library-inline-error');
    const connect = findByTestId(renderer, 'drill-library-unconfigured');
    const saveStillPressable =
      findPressableByLabel(renderer, 'Save Dink Target Ladder') !== null;
    expect({
      inlineBanner: inline
        ? allText(renderer).includes('Sign in to a synced account')
        : false,
      connectState: connect !== null,
      saveStillPressable,
    }).toEqual({
      inlineBanner: false,
      connectState: true,
      saveStillPressable: false,
    });
  });

  it('REPRO: hosted media that expires while the card is open is no longer offered (DrillLibraryScreen.tsx:166-174 evaluates expiry at render only)', async () => {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    mockGetDrill
      .mockReset()
      .mockResolvedValue(detailWith([hostedMedia(expiresAt)]));
    const renderer = renderScreen();
    await settle();

    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(
      findByTestId(renderer, 'watch-media-dink-target-ladder-0'),
    ).not.toBeNull();

    // Ten seconds later (modern fake timers advance Date.now too).
    await advanceTimers(10_000);
    expect(new Date(expiresAt).getTime()).toBeLessThan(Date.now());
    // The signed URL is dead; the row must not still offer it.
    expect(
      findByTestId(renderer, 'watch-media-dink-target-ladder-0'),
    ).toBeNull();
  });

  it('VERIFY: saving two different drills back-to-back shows one toast at a time, and the superseded toast never resurfaces', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    expect(allText(renderer)).toContain('Saved to your library');
    await pressByLabel(
      renderer,
      'Remove Volley Wall Intervals from saved drills',
    );
    const copy = allText(renderer);
    expect(copy).toContain('Removed from saved drills');
    expect(copy).not.toContain('Saved to your library');
    expect(mockSaveDrill).toHaveBeenCalledTimes(1);
    expect(mockUnsaveDrill).toHaveBeenCalledTimes(1);
    // The second toast's timer is the only one live: it is still visible
    // just before its own deadline and gone after it.
    await advanceTimers(2_400);
    expect(allText(renderer)).toContain('Removed from saved drills');
    await advanceTimers(400);
    expect(allText(renderer)).not.toContain('Removed from saved drills');
    // Nothing else fires later: the superseded toast never resurfaces.
    await advanceTimers(5_000);
    expect(allText(renderer)).not.toContain('Saved to your library');
    expect(allText(renderer)).not.toContain('Removed from saved drills');
  });

  it('VERIFY: a save that settles after unmount neither throws nor logs an act/state warning', async () => {
    const save = deferred<void>();
    mockSaveDrill.mockReset().mockImplementation(() => save.promise);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    unmountAll();
    await act(async () => {
      save.resolve();
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('VERIFY: no API session at mount → Connect-account state (never demo drills)', async () => {
    clearApiSession();
    const renderer = renderScreen();
    await settle();
    expect(findByTestId(renderer, 'drill-library-unconfigured')).not.toBeNull();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    await pressByLabel(renderer, 'Connect account');
    expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
  });
});
