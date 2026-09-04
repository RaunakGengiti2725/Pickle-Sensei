/**
 * Execution audit (mobile-training-drills): drives DrillLibraryScreen through
 * the concurrency / stale-data paths the existing suites do not reach —
 * bearer rotation while mounted, a catalog reload racing an optimistic save,
 * a pull-to-refresh racing a save, session loss while mounted, and unmount
 * with requests in flight. Tests titled "DOCUMENTS:" pin the behaviour that
 * was OBSERVED on 4d812e1a so a change is visible; they are not statements
 * that the behaviour is desired (see the audit findings).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { TrainingApiConfig } from '../../src/training/api';
import type { DrillDetail } from '../../src/training/types';
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  listScoredCheckpointFacts: async () => [],
}));

const mockListCatalogDrills = jest.fn<
  Promise<CatalogDrill[]>,
  [{ q?: string; family?: string }]
>();
const mockSaveDrill = jest.fn<Promise<void>, [string]>();
const mockUnsaveDrill = jest.fn<Promise<void>, [string]>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
const createdConfigs: TrainingApiConfig[] = [];

jest.mock('../../src/training/api', () => {
  const { TrainingError: RealTrainingError } = jest.requireActual<
    typeof import('../../src/training/types')
  >('../../src/training/types');
  return {
    createTrainingApi: (config: TrainingApiConfig) => {
      createdConfigs.push(config);
      const configured = Boolean(config.baseUrl && config.token);
      const unconfigured = () =>
        Promise.reject(
          new RealTrainingError(
            'training.unconfigured',
            'Sign in to a synced account before loading training plans.',
            false,
          ),
        );
      return {
        listCatalogDrills: (params: { q?: string; family?: string }) =>
          configured ? mockListCatalogDrills(params) : unconfigured(),
        saveDrill: (slug: string) =>
          configured ? mockSaveDrill(slug) : unconfigured(),
        unsaveDrill: (slug: string) =>
          configured ? mockUnsaveDrill(slug) : unconfigured(),
        getDrill: (slug: string) =>
          configured ? mockGetDrill(slug) : unconfigured(),
      };
    },
  };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

const SAVED_TOAST = 'Saved to your library · Library → Saved drills';

const dink: CatalogDrill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: null,
  difficultyMax: null,
  families: ['dink'],
  validationState: 'PUBLISHED',
  saved: false,
};

const volley: CatalogDrill = {
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

const session: ApiSession = {
  apiBaseUrl: 'https://edge.test/functions/v1/api',
  bearerToken: 'bearer-v1',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
  refreshToken: 'refresh-1',
  bearerExpiresAtMs: Date.now() + 3_600_000,
};

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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressableByLabel(
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
  const node = pressableByLabel(renderer, label);
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

function isShownSaved(
  renderer: TestRenderer.ReactTestRenderer,
  slug: string,
): boolean {
  const node = saveToggle(renderer, slug);
  return node.props.accessibilityState?.selected === true;
}

describe('DrillLibraryScreen — concurrency, rotation and stale-data paths', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    createdConfigs.length = 0;
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dink }, { ...volley }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockRejectedValue(new Error('no detail'));
    establishApiSession({ ...session });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    clearApiSession();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('loads once per mount and binds the client to the current bearer', async () => {
    const renderer = renderScreen();
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(createdConfigs.at(-1)).toMatchObject({
      baseUrl: session.apiBaseUrl,
      token: 'bearer-v1',
    });
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('DOCUMENTS: a bearer rotation (sessionKeeper refresh) while mounted rebuilds the client and silently refetches the whole catalog', async () => {
    const renderer = renderScreen();
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);

    // sessionKeeper.ts rotates the access token 60s before expiry; the
    // session object is replaced, canonical id unchanged.
    act(() => {
      establishApiSession({ ...session, bearerToken: 'bearer-v2' });
    });
    await settle();

    // Observed: the screen memoises the client on session.bearerToken, so a
    // rotation re-creates it, `load` changes identity and the effect issues a
    // second catalog request (mode 'update') that the user did not ask for.
    expect(createdConfigs.map(config => config.token)).toEqual([
      'bearer-v1',
      'bearer-v2',
    ]);
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    // Still shows the catalog (no spinner) — the refetch is invisible.
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('DOCUMENTS: a catalog reload that was already in flight overwrites an optimistic save that completed after it started', async () => {
    const renderer = renderScreen();
    await settle();
    expect(isShownSaved(renderer, dink.slug)).toBe(false);

    // A family filter tap starts an 'update' reload; the server processes
    // this list request BEFORE the save below lands, so it echoes saved:false.
    const slowList = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockImplementationOnce(() => slowList.promise);
    await pressByLabel(renderer, 'Filter dink drills');
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);

    // User taps the bookmark on the still-visible card; PUT succeeds.
    await act(async () => {
      saveToggle(renderer, dink.slug).props.onPress();
    });
    await settle();
    expect(mockSaveDrill).toHaveBeenCalledWith(dink.slug);
    expect(isShownSaved(renderer, dink.slug)).toBe(true);
    expect(allText(renderer)).toContain(SAVED_TOAST);

    // The stale list response arrives last.
    await act(async () => {
      slowList.resolve([{ ...dink, saved: false }]);
    });
    await settle();

    // Observed: the screen replaces `drills` wholesale with the stale server
    // list, so the bookmark flips back to unsaved while the "Saved to your
    // library" toast is still on screen — the server state IS saved.
    expect(isShownSaved(renderer, dink.slug)).toBe(false);
    expect(allText(renderer)).toContain(SAVED_TOAST);
    act(() => renderer.unmount());
  });

  it('DOCUMENTS: pull-to-refresh started before a save completes shows the same stale flag', async () => {
    const renderer = renderScreen();
    await settle();

    const slowList = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockImplementationOnce(() => slowList.promise);
    const [refreshControl] = renderer.root.findAll(
      n => typeof n.props.onRefresh === 'function' && 'refreshing' in n.props,
    );
    expect(refreshControl).toBeDefined();
    await act(async () => {
      refreshControl?.props.onRefresh();
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);

    await act(async () => {
      saveToggle(renderer, dink.slug).props.onPress();
    });
    await settle();
    expect(isShownSaved(renderer, dink.slug)).toBe(true);

    await act(async () => {
      slowList.resolve([{ ...dink, saved: false }, { ...volley }]);
    });
    await settle();
    expect(isShownSaved(renderer, dink.slug)).toBe(false);
    act(() => renderer.unmount());
  });

  it('a save that fails reverts only its own card and keeps the catalog', async () => {
    const renderer = renderScreen();
    await settle();
    mockSaveDrill.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      saveToggle(renderer, dink.slug).props.onPress();
    });
    await settle();
    expect(isShownSaved(renderer, dink.slug)).toBe(false);
    expect(isShownSaved(renderer, volley.slug)).toBe(false);
    expect(allText(renderer)).toContain('Volley Wall Intervals');
    act(() => renderer.unmount());
  });

  it("DOCUMENTS: losing the session while mounted keeps the previous account's catalog and saved flags on screen behind an inline error", async () => {
    mockListCatalogDrills.mockResolvedValue([{ ...dink, saved: true }]);
    const renderer = renderScreen();
    await settle();
    expect(isShownSaved(renderer, dink.slug)).toBe(true);

    act(() => {
      clearApiSession();
    });
    await settle();

    // Observed: `load('update')` fails with training.unconfigured and only
    // sets inlineError; the drill list (including saved=true from the signed
    // out account) stays rendered and its bookmark remains pressable.
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(isShownSaved(renderer, dink.slug)).toBe(true);
    expect(copy).toContain('Sign in to a synced account');
    expect(saveToggle(renderer, dink.slug).props.disabled).toBeFalsy();
    act(() => renderer.unmount());
  });

  it('connecting an account while on the unconfigured state performs the initial load', async () => {
    clearApiSession();
    const renderer = renderScreen();
    await settle();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    expect(allText(renderer)).toMatch(/Connect/i);

    act(() => {
      establishApiSession({ ...session });
    });
    await settle();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('unmounting with the catalog request, a save and a detail load in flight resolves without errors', async () => {
    const slowList = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockImplementationOnce(() => slowList.promise);
    const renderer = renderScreen();
    await settle();
    // Resolve the initial load so cards exist, then start slow follow-ups.
    await act(async () => {
      slowList.resolve([{ ...dink }]);
    });
    await settle();

    const slowSave = deferred<void>();
    const slowDetail = deferred<DrillDetail>();
    mockSaveDrill.mockImplementationOnce(() => slowSave.promise);
    mockGetDrill.mockImplementationOnce(() => slowDetail.promise);
    await act(async () => {
      saveToggle(renderer, dink.slug).props.onPress();
    });
    await pressByLabel(renderer, `Show detail for ${dink.title}`);
    expect(mockGetDrill).toHaveBeenCalledWith(dink.slug);

    act(() => renderer.unmount());
    await act(async () => {
      slowSave.resolve();
      slowDetail.reject(new Error('late failure'));
    });
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
