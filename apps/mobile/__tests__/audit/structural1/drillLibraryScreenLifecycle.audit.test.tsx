/**
 * STRUCTURAL AUDIT #1 — DrillLibraryScreen lifecycle
 * (apps/mobile/src/screens/DrillLibraryScreen.tsx).
 *
 * Covers the two mapper hotspots that no existing suite pins:
 *   - optimistic save vs. a catalog refetch landing mid-flight,
 *   - the api memo keyed on session?.bearerToken (rotation / sign-out).
 *
 * Each test states the behaviour the screen SHOULD have. A failing test is a
 * reproduced defect on the audited commit, not a broken test.
 */
import React from 'react';
import { RefreshControl, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScoredCheckpointFact } from '../../../src/library/libraryFocus';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../../src/account/apiSession';

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

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
}));

jest.mock('../../../src/data/db', () => ({ getDb: jest.fn() }));
const mockListScoredCheckpointFacts = jest.fn<
  Promise<ScoredCheckpointFact[]>,
  [unknown]
>();
jest.mock('../../../src/data/repository', () => ({
  listScoredCheckpointFacts: (...args: [unknown]) =>
    mockListScoredCheckpointFacts(...args),
}));

// The REAL client: the screen builds it from the api-session store, so the
// fetch double below sees exactly the bearer the screen captured.
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
jest.mock('../../../src/training/api', () => {
  const actual = jest.requireActual<typeof import('../../../src/training/api')>(
    '../../../src/training/api',
  );
  return {
    ...actual,
    createTrainingApi: (
      config: Parameters<typeof actual.createTrainingApi>[0],
    ) => actual.createTrainingApi({ ...config, fetchFn: mockFetch }),
  };
});

import { DrillLibraryScreen } from '../../../src/screens/DrillLibraryScreen';

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
  bearerToken: 'bearer-1',
  canonicalAppUserId: '2c8f0e0a-5f7d-4a1e-9b3c-0d1e2f3a4b5c',
  provider: 'apple',
  refreshToken: 'refresh-1',
};

const dinkWire = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'PUBLISHED',
  saved: false,
};

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => payload,
  } as Response;
}

interface Call {
  url: string;
  method: string;
  bearer: string | null;
  response: Deferred<Response>;
}

/** Every request is held until the test releases it. */
function holdRequests(): Call[] {
  const calls: Call[] = [];
  mockFetch.mockReset().mockImplementation((url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      bearer: headers['Authorization']?.replace(/^Bearer /, '') ?? null,
      response: deferred<Response>(),
    };
    calls.push(call);
    return call.response.promise;
  });
  return calls;
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<DrillLibraryScreen />);
  });
  mounted = renderer;
  return renderer;
}

/** Unmounts even when an assertion failed mid-test, so a leaked screen can
 * never react to the next test's session changes. */
function unmountScreen() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
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

function saveToggle(renderer: TestRenderer.ReactTestRenderer, slug: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.testID === `save-toggle-${slug}` &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`no save toggle for ${slug}`);
  return node;
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
}

function catalogCalls(calls: Call[]) {
  return calls.filter(
    c => c.method === 'GET' && /\/v1\/catalog\/drills(\?|$)/.test(c.url),
  );
}

describe('DrillLibraryScreen — optimistic save vs. concurrent catalog refetch', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockNavigate.mockClear();
    await act(async () => {
      establishApiSession(session);
    });
  });

  afterEach(async () => {
    unmountScreen();
    await act(async () => {
      clearApiSession();
    });
    jest.useRealTimers();
  });

  it('a catalog refresh that lands while a save is in flight does not un-save the drill the server just accepted', async () => {
    const calls = holdRequests();
    const renderer = renderScreen();
    await settle();
    expect(catalogCalls(calls)).toHaveLength(1);
    await act(async () => {
      catalogCalls(calls)[0]!.response.resolve(
        jsonResponse(200, { items: [dinkWire] }),
      );
    });
    expect(
      saveToggle(renderer, dinkWire.slug).props.accessibilityState,
    ).toEqual({ selected: false });

    // Tap save → optimistic saved=true, PUT in flight.
    await act(async () => {
      saveToggle(renderer, dinkWire.slug).props.onPress();
    });
    const put = calls.find(c => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(
      saveToggle(renderer, dinkWire.slug).props.accessibilityState,
    ).toEqual({ selected: true });

    // Pull-to-refresh while the PUT is still open. The GET is answered from
    // pre-save server truth (saved:false) before the PUT commits.
    await act(async () => {
      renderer.root.findByType(RefreshControl).props.onRefresh();
    });
    expect(catalogCalls(calls)).toHaveLength(2);
    await act(async () => {
      catalogCalls(calls)[1]!.response.resolve(
        jsonResponse(200, { items: [dinkWire] }),
      );
    });

    // The PUT succeeds: the server now has the drill saved.
    await act(async () => {
      put!.response.resolve(
        jsonResponse(200, { slug: dinkWire.slug, saved: true }),
      );
    });

    const copy = allText(renderer);
    expect(copy).toContain('Saved to your library');
    // Contract: the bookmark reflects the confirmed server state.
    expect(
      saveToggle(renderer, dinkWire.slug).props.accessibilityState,
    ).toEqual({ selected: true });
    unmountScreen();
  });
});

describe('DrillLibraryScreen — api identity follows session?.bearerToken', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockNavigate.mockClear();
    await act(async () => {
      establishApiSession(session);
    });
  });

  afterEach(async () => {
    unmountScreen();
    await act(async () => {
      clearApiSession();
    });
    jest.useRealTimers();
  });

  it('a routine bearer rotation does not refetch the catalog', async () => {
    const calls = holdRequests();
    renderScreen();
    await settle();
    await act(async () => {
      catalogCalls(calls)[0]!.response.resolve(
        jsonResponse(200, { items: [dinkWire] }),
      );
    });
    expect(catalogCalls(calls)).toHaveLength(1);

    // sessionKeeper rotates the access token (same account, same base URL).
    await act(async () => {
      establishApiSession({ ...session, bearerToken: 'bearer-2' });
    });
    await settle();

    expect(catalogCalls(calls).map(c => c.bearer)).toEqual(['bearer-1']);
    unmountScreen();
  });

  it('a request issued after rotation carries the CURRENT bearer, not the one captured at construction', async () => {
    const calls = holdRequests();
    const renderer = renderScreen();
    await settle();
    await act(async () => {
      catalogCalls(calls)[0]!.response.resolve(
        jsonResponse(200, { items: [dinkWire] }),
      );
    });

    // Rotate, then let the screen settle whatever it decides to do.
    await act(async () => {
      establishApiSession({ ...session, bearerToken: 'bearer-2' });
    });
    await settle();
    for (const c of catalogCalls(calls).slice(1)) {
      c.response.resolve(jsonResponse(200, { items: [dinkWire] }));
    }
    await settle();

    // A user action now → must go out under bearer-2.
    await act(async () => {
      saveToggle(renderer, dinkWire.slug).props.onPress();
    });
    const put = calls.find(c => c.method === 'PUT');
    expect(put?.bearer).toBe('bearer-2');
    unmountScreen();
  });

  it('losing the api session while mounted shows the Connect-account state, not an inline error over a stale catalog', async () => {
    const calls = holdRequests();
    const renderer = renderScreen();
    await settle();
    await act(async () => {
      catalogCalls(calls)[0]!.response.resolve(
        jsonResponse(200, { items: [dinkWire] }),
      );
    });
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');

    // authStore.handleApiUnauthorized (legacy provider-token path) clears
    // the api session first and only later sets the auth session to null —
    // the screen stays mounted with no bearer in between.
    await act(async () => {
      clearApiSession();
    });
    await settle();
    await settle();

    const copy = allText(renderer);
    expect({
      connectState: hasTestId(renderer, 'drill-library-unconfigured'),
      inlineError: hasTestId(renderer, 'drill-library-inline-error'),
      staleCatalogStillShown: copy.includes('Dink Target Ladder'),
    }).toEqual({
      connectState: true,
      inlineError: false,
      staleCatalogStillShown: false,
    });
    unmountScreen();
  });
});
