import React from 'react';
import { RefreshControl, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScoredCheckpointFact } from '../src/library/libraryFocus';
import {
  establishApiSession,
  setApiUnauthorizedListener,
  useApiSessionStore,
  type ApiSession,
} from '../src/account/apiSession';

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

import { DrillLibraryScreen } from '../src/screens/DrillLibraryScreen';

/**
 * ADVERSARIAL PASS 3 — DrillLibraryScreen driven through the REAL training
 * API client (src/training/api.ts) with only `globalThis.fetch` faked, so
 * every status/body/header edge reaches the screen exactly as production
 * would deliver it. Scenarios:
 *
 *  - hosted media whose signed URL expires after it was rendered,
 *  - optimistic save racing a debounced search response,
 *  - 401 on save after the bearer already rotated,
 *  - 429 + Retry-After during pull-to-refresh,
 *  - 503 with an HTML (non-JSON) body on the catalog list.
 *
 * Adds nothing to production.
 */

const BASE_URL = 'https://api.pickle.test';

const sessionA: ApiSession = {
  apiBaseUrl: BASE_URL,
  bearerToken: 'access-token-A',
  canonicalAppUserId: 'user-1',
  provider: 'apple',
  refreshToken: 'refresh-1',
  bearerExpiresAtMs: Date.now() + 3_600_000,
};

const rawDink = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coach_name: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'UNVALIDATED',
  saved: false,
};

const rawVolley = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  slug: 'volley-wall-intervals',
  title: 'Volley Wall Intervals',
  description: 'Timed volley intervals against a rebound wall.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'rebound wall'],
  difficulty_min: null,
  difficulty_max: null,
  families: ['volley'],
  validation_state: 'PUBLISHED',
  saved: true,
};

const HOSTED_PLAYBACK_URL = 'https://cdn.example.com/drills/dink.mp4?sig=abc';

function rawDetailWithHosted(expiresAt: string) {
  return {
    drill: { ...rawDink },
    mappings: [],
    instructionalMedia: [
      {
        id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        kind: 'hosted',
        playbackUrl: HOSTED_PLAYBACK_URL,
        expiresAt,
        sourceUrl: 'https://example.com/drills/dink',
        creatorName: 'Pickle Sensei Coaching',
        licenseName: 'Licensed to Pickle Sensei',
        licenseUrl: null,
        attribution: 'Video licensed for Pickle Sensei',
      },
    ],
  };
}

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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A gateway-style HTML error page: `.json()` rejects like the real fetch. */
function htmlResponse(status: number, html: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Service Unavailable',
    headers: {
      get: (name: string) => (name === 'content-type' ? 'text/html' : null),
    },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    text: async () => html,
  } as unknown as Response;
}

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
}

const calls: Call[] = [];
type Router = (call: Call) => Promise<Response> | Response;
let router: Router = () => jsonResponse(200, { items: [], cursor: null });

const fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = {
    method: init?.method ?? 'GET',
    path: input.replace(BASE_URL, ''),
    authorization: headers.Authorization,
  };
  calls.push(call);
  return router(call);
});

function catalogRouter(items: unknown[] = [rawDink, rawVolley]): Router {
  return call => {
    if (call.method === 'GET' && call.path.startsWith('/v1/catalog/drills?'))
      return jsonResponse(200, { items, cursor: null });
    if (call.method === 'GET' && call.path === '/v1/catalog/drills')
      return jsonResponse(200, { items, cursor: null });
    throw new Error(`Unrouted ${call.method} ${call.path}`);
  };
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

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const [node] = renderer.root.findAll(
    n => predicate(n.props) && typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = findPressable(renderer, p => p.accessibilityLabel === label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

async function pressByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = findPressable(renderer, p => p.testID === testID);
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  await act(async () => {
    node.props.onPress();
  });
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(n => n.props.testID === id).length > 0;
}

function saveToggle(renderer: TestRenderer.ReactTestRenderer, slug: string) {
  return findPressable(renderer, p => p.testID === `save-toggle-${slug}`);
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

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function refreshControl(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAllByType(RefreshControl);
  return node ?? null;
}

function inlineErrorText(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-library-inline-error',
  );
  if (!node) return null;
  return node
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

describe('attack 3 — DrillLibraryScreen through the real training API', () => {
  const unauthorized = jest.fn();
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    calls.length = 0;
    fetchMock.mockClear();
    router = catalogRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockGoBack.mockClear();
    mockNavigate.mockClear();
    unauthorized.mockClear();
    setApiUnauthorizedListener(unauthorized);
    establishApiSession({ ...sessionA });
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
    useApiSessionStore.setState({ session: null });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // S2 — hosted media whose signed URL expires 1 s after it was rendered.
  // ────────────────────────────────────────────────────────────────────────
  it('hosted media expiring 1 s after render: Watch still opens it, the player fails, and the row only disappears once the card re-renders', async () => {
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const base = catalogRouter();
    router = call =>
      call.method === 'GET' &&
      call.path === '/v1/catalog/drills/dink-target-ladder'
        ? jsonResponse(200, rawDetailWithHosted(expiresAt))
        : base(call);

    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');

    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(hasTestId(renderer, 'watch-media-dink-target-ladder-0')).toBe(true);
    expect(allText(renderer)).toContain('WATCH IT DONE');

    // Signed URL is now 1 s past its expiry. Nothing re-rendered the card.
    await elapse(2_000);
    expect(hasTestId(renderer, 'watch-media-dink-target-ladder-0')).toBe(true);

    // Press Watch: the screen hands the EXPIRED media to the player.
    await pressByTestId(renderer, 'watch-media-dink-target-ladder-0');
    expect(hasTestId(renderer, 'drill-video-player')).toBe(true);
    const [webView] = renderer.root.findAll(
      n => n.props.testID === 'drill-video-webview' && n.props.source,
    );
    expect(webView?.props.source.uri).toBe(HOSTED_PLAYBACK_URL);

    // The CDN refuses the stale signature on the main document.
    await act(async () => {
      webView?.props.onHttpError({
        nativeEvent: { url: HOSTED_PLAYBACK_URL, statusCode: 403 },
      });
    });
    expect(hasTestId(renderer, 'drill-video-error')).toBe(true);
    expect(allText(renderer)).toContain('This video could not load in the app');

    // Retry re-requests the very same expired URL.
    await pressByLabel(renderer, 'Try loading the video again');
    const [retried] = renderer.root.findAll(
      n => n.props.testID === 'drill-video-webview' && n.props.source,
    );
    expect(retried?.props.source.uri).toBe(HOSTED_PLAYBACK_URL);

    // Close the player: the screen re-renders, but DrillCard is memoized on
    // unchanged props, so the expired row is STILL offered.
    await pressByLabel(renderer, 'Close video player');
    expect(hasTestId(renderer, 'drill-video-player')).toBe(false);
    const rowStillOffered = hasTestId(
      renderer,
      'watch-media-dink-target-ladder-0',
    );

    // Force the card to re-render (collapse + expand): the row is filtered
    // out and NO fresh detail (fresh signed URL) is requested — the detail
    // cache is keyed for the screen's lifetime.
    await pressByLabel(renderer, 'Hide detail for Dink Target Ladder');
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    expect(hasTestId(renderer, 'watch-media-dink-target-ladder-0')).toBe(false);
    expect(allText(renderer)).not.toContain('WATCH IT DONE');
    const detailFetches = calls.filter(
      c => c.path === '/v1/catalog/drills/dink-target-ladder',
    );
    expect(detailFetches).toHaveLength(1);

    // Pull-to-refresh reloads the catalog but never the detail either.
    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    await settle();
    expect(
      calls.filter(c => c.path === '/v1/catalog/drills/dink-target-ladder'),
    ).toHaveLength(1);
    expect(hasTestId(renderer, 'watch-media-dink-target-ladder-0')).toBe(false);

    act(() => renderer.unmount());
    // Documented observation for the report: the expired row survives the
    // player round-trip because nothing changed the card's props.
    expect(rowStillOffered).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // S3 — save racing a debounced search response.
  // ────────────────────────────────────────────────────────────────────────
  it('a debounced search response with saved:false landing mid-save overwrites the optimistic bookmark and the save success never restores it', async () => {
    const save = deferred<Response>();
    const search = deferred<Response>();
    const base = catalogRouter();
    router = call => {
      if (
        call.method === 'PUT' &&
        call.path === '/v1/me/saved-drills/dink-target-ladder'
      )
        return save.promise;
      if (call.method === 'GET' && call.path === '/v1/catalog/drills?q=dink')
        return search.promise;
      return base(call);
    };

    const renderer = renderScreen();
    await settle();
    expect(
      saveToggle(renderer, 'dink-target-ladder')?.props.accessibilityState,
    ).toEqual({
      selected: false,
    });

    // Type a query; the debounce fires and the search request goes out
    // (server state at that moment: saved=false).
    typeSearch(renderer, 'dink');
    await elapse(300);
    expect(calls.some(c => c.path === '/v1/catalog/drills?q=dink')).toBe(true);

    // Now press save while the search is still in flight. Optimistic UI.
    await pressByTestId(renderer, 'save-toggle-dink-target-ladder');
    expect(
      saveToggle(renderer, 'dink-target-ladder')?.props.accessibilityState,
    ).toEqual({
      selected: true,
    });
    expect(saveToggle(renderer, 'dink-target-ladder')?.props.disabled).toBe(
      true,
    );

    // The stale search response lands first: saved:false for the slug.
    await act(async () => {
      search.resolve(jsonResponse(200, { items: [rawDink], cursor: null }));
    });
    await settle();
    const afterSearch = saveToggle(renderer, 'dink-target-ladder')?.props
      .accessibilityState;

    // Then the server confirms the save.
    await act(async () => {
      save.resolve(
        jsonResponse(200, { slug: 'dink-target-ladder', saved: true }),
      );
    });
    await settle();
    expect(allText(renderer)).toContain('Saved to your library');
    const finalState = saveToggle(renderer, 'dink-target-ladder')?.props
      .accessibilityState;
    const finalLabel = saveToggle(renderer, 'dink-target-ladder')?.props
      .accessibilityLabel;
    expect(saveToggle(renderer, 'dink-target-ladder')?.props.disabled).toBe(
      false,
    );
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    // Pin the observed drift so the report can cite it: the server has the
    // drill saved, the toast says so, yet the bookmark renders unsaved.
    expect(afterSearch).toEqual({ selected: false });
    expect(finalState).toEqual({ selected: false });
    expect(finalLabel).toBe('Save Dink Target Ladder');
  });

  it('the mirror case: unsave in flight, stale list says saved:true → renders saved although the server removed it', async () => {
    const unsave = deferred<Response>();
    const search = deferred<Response>();
    const base = catalogRouter();
    router = call => {
      if (
        call.method === 'DELETE' &&
        call.path === '/v1/me/saved-drills/volley-wall-intervals'
      )
        return unsave.promise;
      if (call.method === 'GET' && call.path === '/v1/catalog/drills?q=volley')
        return search.promise;
      return base(call);
    };

    const renderer = renderScreen();
    await settle();
    typeSearch(renderer, 'volley');
    await elapse(300);
    await pressByTestId(renderer, 'save-toggle-volley-wall-intervals');
    expect(
      saveToggle(renderer, 'volley-wall-intervals')?.props.accessibilityState,
    ).toEqual({
      selected: false,
    });
    await act(async () => {
      search.resolve(jsonResponse(200, { items: [rawVolley], cursor: null }));
    });
    await act(async () => {
      unsave.resolve(jsonResponse(204, null));
    });
    await settle();
    expect(allText(renderer)).toContain('Removed from saved drills');
    const finalState = saveToggle(renderer, 'volley-wall-intervals')?.props
      .accessibilityState;
    act(() => renderer.unmount());
    expect(finalState).toEqual({ selected: true });
  });

  // ────────────────────────────────────────────────────────────────────────
  // S5 — 401 on save after the bearer rotated.
  // ────────────────────────────────────────────────────────────────────────
  it('401 on save after the bearer rotated: reportApiUnauthorized is a no-op, the card reverts, session_expired copy shows', async () => {
    const save = deferred<Response>();
    const base = catalogRouter();
    router = call =>
      call.method === 'PUT' &&
      call.path === '/v1/me/saved-drills/dink-target-ladder'
        ? save.promise
        : base(call);

    const renderer = renderScreen();
    await settle();
    const catalogCallsBefore = calls.filter(c => c.method === 'GET').length;

    await pressByTestId(renderer, 'save-toggle-dink-target-ladder');
    const saveCall = calls.find(c => c.method === 'PUT');
    expect(saveCall?.authorization).toBe('Bearer access-token-A');

    // sessionKeeper rotates the bearer while the PUT is in flight.
    act(() => {
      establishApiSession({ ...sessionA, bearerToken: 'access-token-B' });
    });
    await settle();

    // The stale token is rejected.
    await act(async () => {
      save.resolve(
        jsonResponse(401, {
          error: { code: 'unauthorized', message: 'Invalid or expired token.' },
        }),
      );
    });
    await settle();

    expect(unauthorized).not.toHaveBeenCalled();
    expect(useApiSessionStore.getState().session?.bearerToken).toBe(
      'access-token-B',
    );
    expect(
      saveToggle(renderer, 'dink-target-ladder')?.props.accessibilityState,
    ).toEqual({
      selected: false,
    });
    expect(saveToggle(renderer, 'dink-target-ladder')?.props.disabled).toBe(
      false,
    );
    expect(inlineErrorText(renderer)).toBe(
      'Your sign-in expired. Sign in again to continue.',
    );

    // Side effect of the rotation itself: the screen re-created its API
    // client and re-fetched the catalog with the new bearer.
    const catalogCallsAfter = calls.filter(c => c.method === 'GET');
    expect(catalogCallsAfter.length).toBe(catalogCallsBefore + 1);
    expect(catalogCallsAfter[catalogCallsAfter.length - 1]?.authorization).toBe(
      'Bearer access-token-B',
    );

    // A second tap now succeeds with the rotated bearer.
    router = call =>
      call.method === 'PUT' &&
      call.path === '/v1/me/saved-drills/dink-target-ladder'
        ? jsonResponse(200, { slug: 'dink-target-ladder', saved: true })
        : base(call);
    await pressByTestId(renderer, 'save-toggle-dink-target-ladder');
    await settle();
    const secondSave = calls.filter(c => c.method === 'PUT');
    expect(secondSave[secondSave.length - 1]?.authorization).toBe(
      'Bearer access-token-B',
    );
    expect(
      saveToggle(renderer, 'dink-target-ladder')?.props.accessibilityState,
    ).toEqual({
      selected: true,
    });
    act(() => renderer.unmount());
  });

  it('401 on save with the bearer still current DOES notify the unauthorized listener', async () => {
    const base = catalogRouter();
    router = call =>
      call.method === 'PUT'
        ? jsonResponse(401, { error: { code: 'unauthorized', message: 'x' } })
        : base(call);
    const renderer = renderScreen();
    await settle();
    await pressByTestId(renderer, 'save-toggle-dink-target-ladder');
    await settle();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(unauthorized.mock.calls[0]?.[0]).toMatchObject({
      bearerToken: 'access-token-A',
    });
    expect(inlineErrorText(renderer)).toBe(
      'Your sign-in expired. Sign in again to continue.',
    );
    act(() => renderer.unmount());
  });

  it('bearer rotation with the catalog offline surfaces an unprompted inline error', async () => {
    const renderer = renderScreen();
    await settle();
    expect(inlineErrorText(renderer)).toBeNull();
    router = () => {
      throw new TypeError('Network request failed');
    };
    act(() => {
      establishApiSession({ ...sessionA, bearerToken: 'access-token-C' });
    });
    await settle();
    // The user did nothing; the rotation alone triggered a catalog refetch
    // that failed and now shows an error banner.
    expect(inlineErrorText(renderer)).toBe(
      'Training is temporarily offline. Your existing reads are still safe.',
    );
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  // ────────────────────────────────────────────────────────────────────────
  // S6 — 429 + Retry-After during pull-to-refresh.
  // ────────────────────────────────────────────────────────────────────────
  it('429 with Retry-After during pull-to-refresh: inline banner with server copy, catalog kept, spinner stops', async () => {
    const renderer = renderScreen();
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');
    expect(refreshControl(renderer)?.props.refreshing).toBe(false);

    const refresh = deferred<Response>();
    router = call =>
      call.method === 'GET' && call.path === '/v1/catalog/drills'
        ? refresh.promise
        : (() => {
            throw new Error(`Unrouted ${call.method} ${call.path}`);
          })();

    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    expect(refreshControl(renderer)?.props.refreshing).toBe(true);

    await act(async () => {
      refresh.resolve(
        jsonResponse(
          429,
          {
            error: {
              code: 'rate_limited',
              message:
                'Too many requests. Please slow down and try again shortly.',
            },
          },
          {
            'Retry-After': '17',
            'RateLimit-Limit': '60',
            'RateLimit-Remaining': '0',
          },
        ),
      );
    });
    await settle();

    expect(refreshControl(renderer)?.props.refreshing).toBe(false);
    expect(inlineErrorText(renderer)).toBe(
      'Too many requests. Please slow down and try again shortly.',
    );
    const copy = allText(renderer);
    expect(copy).toContain('Dink Target Ladder');
    expect(copy).toContain('Volley Wall Intervals');
    expect(hasTestId(renderer, 'drill-library-inline-error')).toBe(true);
    // Nothing in the banner reflects the 17 s Retry-After the server sent.
    expect(copy).not.toMatch(/17/);

    // Pulling again immediately is not throttled client-side: the request
    // goes straight back out inside the Retry-After window.
    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    expect(calls.filter(c => c.path === '/v1/catalog/drills')).toHaveLength(3);
    act(() => renderer.unmount());
  });

  it('429 whose body is NOT JSON during refresh is surfaced as an invalid response', async () => {
    const renderer = renderScreen();
    await settle();
    router = () =>
      htmlResponse(429, '<html><body>Too Many Requests</body></html>');
    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    await settle();
    expect(refreshControl(renderer)?.props.refreshing).toBe(false);
    expect(inlineErrorText(renderer)).toBe(
      'The training server returned an invalid response.',
    );
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  // ────────────────────────────────────────────────────────────────────────
  // S7 — 503 with an HTML body on the catalog list.
  // ────────────────────────────────────────────────────────────────────────
  it('initial load hitting a 503 HTML page renders the error state with the invalid-response copy and a retry that works', async () => {
    router = () =>
      htmlResponse(
        503,
        '<html><head><title>503 Service Unavailable</title></head><body>upstream connect error</body></html>',
      );
    const renderer = renderScreen();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('The drill catalog could not load.');
    expect(copy).toContain('The training server returned an invalid response.');
    // No hint that the service is down / temporarily unavailable.
    expect(copy).not.toMatch(/temporarily|offline|unavailable/i);

    router = catalogRouter();
    await pressByLabel(renderer, 'Try again');
    await settle();
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('a 503 HTML page during pull-to-refresh keeps the catalog and shows the same invalid-response banner', async () => {
    const renderer = renderScreen();
    await settle();
    router = () => htmlResponse(503, '<html>Service Unavailable</html>');
    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    await settle();
    expect(refreshControl(renderer)?.props.refreshing).toBe(false);
    expect(inlineErrorText(renderer)).toBe(
      'The training server returned an invalid response.',
    );
    expect(allText(renderer)).toContain('Volley Wall Intervals');
    act(() => renderer.unmount());
  });

  // ────────────────────────────────────────────────────────────────────────
  // Extras — interleavings the scenarios imply.
  // ────────────────────────────────────────────────────────────────────────
  it('a search typed while a refresh is in flight still ends with the spinner stopped', async () => {
    const renderer = renderScreen();
    await settle();
    const refresh = deferred<Response>();
    const search = deferred<Response>();
    router = call => {
      if (call.path === '/v1/catalog/drills') return refresh.promise;
      if (call.path === '/v1/catalog/drills?q=wall') return search.promise;
      throw new Error(`Unrouted ${call.method} ${call.path}`);
    };
    await act(async () => {
      refreshControl(renderer)?.props.onRefresh();
    });
    expect(refreshControl(renderer)?.props.refreshing).toBe(true);
    typeSearch(renderer, 'wall');
    await elapse(300);
    // Stale refresh resolves first (ignored), then the search.
    await act(async () => {
      refresh.resolve(
        jsonResponse(200, { items: [rawDink, rawVolley], cursor: null }),
      );
    });
    expect(refreshControl(renderer)?.props.refreshing).toBe(true);
    await act(async () => {
      search.resolve(jsonResponse(200, { items: [rawVolley], cursor: null }));
    });
    await settle();
    expect(refreshControl(renderer)?.props.refreshing).toBe(false);
    expect(allText(renderer)).toContain('1 of 1 drill');
    act(() => renderer.unmount());
  });

  it('unicode + huge search input is URL-encoded once and never crashes the screen', async () => {
    const renderer = renderScreen();
    await settle();
    const nasty = '🥒 ダブル dink & volley?/#%'.repeat(40);
    router = catalogRouter([]);
    typeSearch(renderer, nasty);
    await elapse(300);
    await settle();
    const searchCall = calls[calls.length - 1];
    expect(searchCall?.path).toBe(
      `/v1/catalog/drills?q=${encodeURIComponent(nasty.trim())}`,
    );
    expect(
      decodeURIComponent(
        searchCall!.path.slice('/v1/catalog/drills?q='.length),
      ),
    ).toBe(nasty.trim());
    expect(allText(renderer)).toContain('0 of 0 drills');
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('save 200 whose body is HTML is treated as a failure and the bookmark reverts', async () => {
    const base = catalogRouter();
    router = call =>
      call.method === 'PUT' ? htmlResponse(200, '<html>ok</html>') : base(call);
    const renderer = renderScreen();
    await settle();
    await pressByTestId(renderer, 'save-toggle-dink-target-ladder');
    await settle();
    expect(
      saveToggle(renderer, 'dink-target-ladder')?.props.accessibilityState,
    ).toEqual({
      selected: false,
    });
    expect(inlineErrorText(renderer)).toBe(
      'The training server returned an invalid response.',
    );
    act(() => renderer.unmount());
  });

  it('unmounting with a save, a search and a detail all in flight resolves without warnings', async () => {
    const pending: Deferred<Response>[] = [];
    const base = catalogRouter();
    let first = true;
    router = call => {
      if (first) {
        first = false;
        return base(call);
      }
      const d = deferred<Response>();
      pending.push(d);
      return d.promise;
    };
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await pressByTestId(renderer, 'save-toggle-volley-wall-intervals');
    typeSearch(renderer, 'x');
    await elapse(300);
    expect(pending).toHaveLength(3);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
    await act(async () => {
      pending[0]!.resolve(
        jsonResponse(200, rawDetailWithHosted('2030-01-01T00:00:00.000Z')),
      );
      pending[1]!.resolve(jsonResponse(204, null));
      pending[2]!.resolve(jsonResponse(200, { items: [], cursor: null }));
    });
    await settle();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
