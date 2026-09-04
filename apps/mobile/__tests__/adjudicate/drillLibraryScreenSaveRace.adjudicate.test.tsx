/**
 * ADJUDICATION — DrillLibraryScreen optimistic save vs. concurrent catalog
 * refetch (apps/mobile/src/screens/DrillLibraryScreen.tsx, baseline 4d812e1a).
 *
 * Uses the REAL training client with a held fetch double so the screen's own
 * request/response ordering is exercised. On the baseline this test FAILS:
 * the refetched catalog (pre-save server truth) overwrites the optimistic
 * `saved: true`, and the PUT that then succeeds never re-applies it, leaving
 * an unsaved bookmark under a "Saved to your library" toast.
 */
import React from 'react';
import { RefreshControl, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
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
const mockListScoredCheckpointFacts = jest.fn<
  Promise<ScoredCheckpointFact[]>,
  [unknown]
>();
jest.mock('../../src/data/repository', () => ({
  listScoredCheckpointFacts: (...args: [unknown]) =>
    mockListScoredCheckpointFacts(...args),
}));

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
jest.mock('../../src/training/api', () => {
  const actual = jest.requireActual<typeof import('../../src/training/api')>(
    '../../src/training/api',
  );
  return {
    ...actual,
    createTrainingApi: (
      config: Parameters<typeof actual.createTrainingApi>[0],
    ) => actual.createTrainingApi({ ...config, fetchFn: mockFetch }),
  };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
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
  response: Deferred<Response>;
}

function holdRequests(): Call[] {
  const calls: Call[] = [];
  mockFetch.mockReset().mockImplementation((url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
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

function catalogCalls(calls: Call[]) {
  return calls.filter(
    c => c.method === 'GET' && /\/v1\/catalog\/drills(\?|$)/.test(c.url),
  );
}

describe('ADJ-SCREEN-1: optimistic save vs. concurrent catalog refetch', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
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

  it('a pull-to-refresh that lands while a save PUT is in flight must not leave the bookmark contradicting the "Saved" toast', async () => {
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

    await act(async () => {
      saveToggle(renderer, dinkWire.slug).props.onPress();
    });
    const put = calls.find(c => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(
      saveToggle(renderer, dinkWire.slug).props.accessibilityState,
    ).toEqual({ selected: true });

    // Refresh while the PUT is still open; the GET is answered from
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

    await act(async () => {
      put!.response.resolve(
        jsonResponse(200, { slug: dinkWire.slug, saved: true }),
      );
    });

    expect(allText(renderer)).toContain('Saved to your library');
    expect(
      saveToggle(renderer, dinkWire.slug).props.accessibilityState,
    ).toEqual({ selected: true });
  });
});
