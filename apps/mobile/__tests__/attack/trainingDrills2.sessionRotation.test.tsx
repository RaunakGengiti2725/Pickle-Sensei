import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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
jest.mock('../../src/data/repository', () => ({
  listScoredCheckpointFacts: async () => [],
}));

import {
  establishApiSession,
  setApiUnauthorizedListener,
  useApiSessionStore,
  type ApiSession,
} from '../../src/account/apiSession';
import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

/**
 * ADVERSARIAL PASS 3 — mobile-training-drills, scenarios S2 and S7.
 *
 * Unlike the pinned suites, this one runs the REAL `createTrainingApi` and
 * the REAL `useApiSessionStore`, with only `globalThis.fetch` faked, so the
 * session → api memo → request-id chain is exercised end to end.
 *
 *  S2: catalog loaded, then the api session is cleared while mounted.
 *  S7: bearer rotated while the first catalog request is still in flight.
 */

const API_BASE = 'https://api.pickle.test';
const CATALOG_PATH = '/v1/catalog/drills';

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

function sessionWith(token: string, userId = 'user-1'): ApiSession {
  return {
    apiBaseUrl: API_BASE,
    bearerToken: token,
    canonicalAppUserId: userId,
    provider: 'apple',
    refreshToken: `refresh-${token}`,
    bearerExpiresAtMs: Date.now() + 60 * 60 * 1000,
  };
}

const dinkItem = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'UNVALIDATED',
  saved: false,
};

const volleyItem = {
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

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

function catalogResponse(items: unknown[]): Response {
  return jsonResponse(200, { items, cursor: null });
}

interface RecordedCall {
  url: string;
  bearer: string | undefined;
  response: Deferred<Response>;
}

const calls: RecordedCall[] = [];
const fetchMock = jest.fn(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const response = deferred<Response>();
    calls.push({
      url,
      bearer: headers['Authorization']?.replace(/^Bearer /, ''),
      response,
    });
    return response.promise;
  },
);

function catalogCalls(): RecordedCall[] {
  return calls.filter(call =>
    call.url.startsWith(`${API_BASE}${CATALOG_PATH}`),
  );
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

/** A test that fails mid-way must not leave a screen subscribed to the
 * session store, or its reloads would pollute every later test. */
function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted by the test itself
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

const originalFetch = globalThis.fetch;

describe('DrillLibraryScreen × live api session', () => {
  const unauthorizedListener = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    calls.length = 0;
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    unauthorizedListener.mockClear();
    setApiUnauthorizedListener(unauthorizedListener);
    useApiSessionStore.setState({ session: null });
    mockGoBack.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    unmountAll();
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    setApiUnauthorizedListener(null);
    useApiSessionStore.setState({ session: null });
  });

  describe('S2 — api session cleared while the catalog is on screen', () => {
    it('keeps the stale catalog with an inline unconfigured banner, never the Connect-account state', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      expect(catalogCalls()).toHaveLength(1);
      expect(catalogCalls()[0]!.bearer).toBe('tok-1');
      await act(async () => {
        catalogCalls()[0]!.response.resolve(
          catalogResponse([dinkItem, volleyItem]),
        );
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);

      // Attack: the session disappears underneath the mounted screen.
      act(() => {
        useApiSessionStore.setState({ session: null });
      });
      await settle();

      // No network request can be attempted without a bearer.
      expect(catalogCalls()).toHaveLength(1);
      // Stale catalog stays; the failure is inline, not the initial state.
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(findByTestId(renderer, 'drill-library-unconfigured')).toBeNull();
      expect(allText(renderer)).not.toContain('Connect account');
      expect(inlineErrorText(renderer)).toBe(
        'Sign in to a synced account before loading training plans.',
      );

      // Dismiss clears the banner; a pull-to-refresh brings it straight back
      // (still no request), and nothing ever escalates to Connect account.
      await pressByLabel(renderer, 'Dismiss error');
      expect(inlineErrorText(renderer)).toBeNull();
      const [scroll] = renderer.root.findAll(
        n => n.props.refreshControl !== undefined,
      );
      await act(async () => {
        scroll!.props.refreshControl.props.onRefresh();
      });
      expect(catalogCalls()).toHaveLength(1);
      expect(inlineErrorText(renderer)).toBe(
        'Sign in to a synced account before loading training plans.',
      );
      expect(findByTestId(renderer, 'drill-library-unconfigured')).toBeNull();
      expect(drillCardOrder(renderer)).toHaveLength(2);
      act(() => renderer.unmount());
    });

    it('a save attempt with no session fails inline and leaves the stale saved state untouched', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([dinkItem]));
      });
      act(() => {
        useApiSessionStore.setState({ session: null });
      });
      await settle();
      await pressByLabel(renderer, 'Dismiss error');
      await pressByLabel(renderer, 'Save Dink Target Ladder');
      // Only the catalog call ever hit the network.
      expect(calls).toHaveLength(1);
      expect(inlineErrorText(renderer)).toBe(
        'Sign in to a synced account before loading training plans.',
      );
      // The optimistic toggle rolled back: the drill still reads unsaved.
      expect(
        renderer.root.findAll(
          n => n.props.accessibilityLabel === 'Save Dink Target Ladder',
        ).length,
      ).toBeGreaterThan(0);
      act(() => renderer.unmount());
    });

    it('re-establishing a session reloads the catalog once — and does the stale unconfigured banner go away?', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([dinkItem]));
      });
      act(() => {
        useApiSessionStore.setState({ session: null });
      });
      await settle();
      expect(inlineErrorText(renderer)).toBe(
        'Sign in to a synced account before loading training plans.',
      );

      act(() => {
        establishApiSession(sessionWith('tok-2'));
      });
      await settle();
      expect(catalogCalls()).toHaveLength(2);
      expect(catalogCalls()[1]!.bearer).toBe('tok-2');
      await act(async () => {
        catalogCalls()[1]!.response.resolve(
          catalogResponse([dinkItem, volleyItem]),
        );
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      // The account is connected again and the catalog just reloaded from
      // it; a banner still telling the user to sign in is stale.
      expect(inlineErrorText(renderer)).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('S7 — bearer rotation while the first catalog request is in flight', () => {
    it('issues exactly one extra request with the new bearer, drops the stale response, renders no duplicates', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      expect(catalogCalls()).toHaveLength(1);
      expect(allText(renderer)).toContain('Loading the drill catalog…');

      act(() => {
        establishApiSession(sessionWith('tok-2'));
      });
      await settle();
      expect(catalogCalls().map(call => call.bearer)).toEqual([
        'tok-1',
        'tok-2',
      ]);
      // Nothing has loaded yet, so the screen is still in its initial
      // loading state (no stale catalog exists to keep).
      expect(allText(renderer)).toContain('Loading the drill catalog…');

      // The stale (tok-1) response lands first and must be dropped.
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([dinkItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([]);
      expect(allText(renderer)).toContain('Loading the drill catalog…');

      await act(async () => {
        catalogCalls()[1]!.response.resolve(
          catalogResponse([dinkItem, volleyItem]),
        );
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(catalogCalls()).toHaveLength(2);
      expect(inlineErrorText(renderer)).toBeNull();
      act(() => renderer.unmount());
    });

    it('rotation after the catalog loaded is an "update": stale cards stay visible, one extra call, old late response dropped', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([dinkItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
      ]);

      // Pull-to-refresh with tok-1 is in flight when the bearer rotates.
      const [scroll] = renderer.root.findAll(
        n => n.props.refreshControl !== undefined,
      );
      await act(async () => {
        scroll!.props.refreshControl.props.onRefresh();
      });
      expect(catalogCalls()).toHaveLength(2);
      act(() => {
        establishApiSession(sessionWith('tok-2'));
      });
      await settle();
      expect(catalogCalls().map(call => call.bearer)).toEqual([
        'tok-1',
        'tok-1',
        'tok-2',
      ]);
      // Update mode: the stale catalog never blinks to a loading state.
      expect(allText(renderer)).not.toContain('Loading the drill catalog…');
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
      ]);

      // The stale refresh response (tok-1) arrives late with different
      // content and must be ignored.
      await act(async () => {
        catalogCalls()[1]!.response.resolve(catalogResponse([volleyItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
      ]);

      await act(async () => {
        catalogCalls()[2]!.response.resolve(
          catalogResponse([dinkItem, volleyItem]),
        );
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(inlineErrorText(renderer)).toBeNull();
      act(() => renderer.unmount());
    });

    it('a stale 401 for the OLD bearer neither surfaces an error nor reports the new session as unauthorized', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      act(() => {
        establishApiSession(sessionWith('tok-2'));
      });
      await settle();
      expect(catalogCalls()).toHaveLength(2);
      await act(async () => {
        catalogCalls()[0]!.response.resolve(
          jsonResponse(401, {
            error: { code: 'unauthorized', message: 'expired' },
          }),
        );
      });
      expect(unauthorizedListener).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain('Loading the drill catalog…');
      expect(allText(renderer)).not.toContain('could not load');
      await act(async () => {
        catalogCalls()[1]!.response.resolve(catalogResponse([dinkItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
      ]);
      act(() => renderer.unmount());
    });

    it('five rapid rotations in flight → six requests, only the newest response is applied', async () => {
      establishApiSession(sessionWith('tok-0'));
      const renderer = renderScreen();
      for (let i = 1; i <= 5; i += 1) {
        act(() => {
          establishApiSession(sessionWith(`tok-${i}`));
        });
      }
      await settle();
      expect(catalogCalls().map(call => call.bearer)).toEqual([
        'tok-0',
        'tok-1',
        'tok-2',
        'tok-3',
        'tok-4',
        'tok-5',
      ]);
      // Resolve newest first, then every stale one out of order.
      await act(async () => {
        catalogCalls()[5]!.response.resolve(
          catalogResponse([dinkItem, volleyItem]),
        );
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      await act(async () => {
        for (const index of [2, 0, 4, 1, 3]) {
          catalogCalls()[index]!.response.resolve(
            catalogResponse([volleyItem]),
          );
        }
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
        'drill-card-volley-wall-intervals',
      ]);
      expect(catalogCalls()).toHaveLength(6);
      act(() => renderer.unmount());
    });

    it('re-establishing the SAME bearer (new object, same token) triggers no extra request', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      act(() => {
        establishApiSession({
          ...sessionWith('tok-1'),
          bearerExpiresAtMs: Date.now() + 2 * 60 * 60 * 1000,
        });
      });
      await settle();
      expect(catalogCalls()).toHaveLength(1);
      act(() => renderer.unmount());
    });

    it("rotating to a DIFFERENT account mid-flight drops the previous account's catalog", async () => {
      establishApiSession(sessionWith('tok-1', 'user-1'));
      const renderer = renderScreen();
      act(() => {
        establishApiSession(sessionWith('tok-9', 'user-2'));
      });
      await settle();
      expect(catalogCalls().map(call => call.bearer)).toEqual([
        'tok-1',
        'tok-9',
      ]);
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([volleyItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([]);
      await act(async () => {
        catalogCalls()[1]!.response.resolve(catalogResponse([dinkItem]));
      });
      expect(drillCardOrder(renderer)).toEqual([
        'drill-card-dink-target-ladder',
      ]);
      act(() => renderer.unmount());
    });

    it('unmounting with a rotated request still in flight settles quietly', async () => {
      establishApiSession(sessionWith('tok-1'));
      const renderer = renderScreen();
      act(() => {
        establishApiSession(sessionWith('tok-2'));
      });
      await settle();
      act(() => renderer.unmount());
      await act(async () => {
        catalogCalls()[0]!.response.resolve(catalogResponse([dinkItem]));
        catalogCalls()[1]!.response.reject(new TypeError('network down'));
      });
      expect(unauthorizedListener).not.toHaveBeenCalled();
    });
  });
});
