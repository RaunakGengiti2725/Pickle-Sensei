// Adversarial pass 3 — subsystem `mobile-training-drills`, search surface.
//
// Scenario S5: hostile search text ('(', '\\', '[a-z', a 5,000-character
// string, plus unicode/whitespace extras) typed into DrillLibraryScreen. The
// real `createTrainingApi` is left in place and `globalThis.fetch` is the
// only double, so the assertion covers the full path
// TextInput → debounce → listCatalogDrills → URL as it leaves the app.

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import {
  clearApiSession,
  establishApiSession,
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

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

const BASE_URL = 'https://api.pickle.test';

const catalogItem = {
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

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  } as Response;
}

const fetchSpy = jest.fn<Promise<Response>, [string, RequestInit?]>();
const originalFetch = globalThis.fetch;

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

function typeSearch(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const [input] = renderer.root.findAll(
    n => n.props.testID === 'drill-search-input',
  );
  if (!input) throw new Error('Search input not found');
  act(() => {
    input.props.onChangeText(text);
  });
}

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

function catalogUrls(): string[] {
  return fetchSpy.mock.calls
    .map(call => call[0])
    .filter(url => url.startsWith(`${BASE_URL}/v1/catalog/drills`));
}

function qParam(url: string): string | null {
  const index = url.indexOf('?');
  if (index === -1) return null;
  const pairs = url.slice(index + 1).split('&');
  const q = pairs.find(pair => pair.startsWith('q='));
  return q === undefined ? null : q.slice(2);
}

/** Count of `%XX` escapes that decode to another `%` — i.e. double encoding. */
function doubleEncodedEscapes(encoded: string): number {
  return (encoded.match(/%25/g) ?? []).length;
}

// 4,000 + 250 + 750 = 5,000 code points (5,250 UTF-16 units).
const HUGE = 'a'.repeat(4_000) + '🥒'.repeat(250) + '(['.repeat(375);

const hostileQueries: { label: string; text: string }[] = [
  { label: 'lone open paren', text: '(' },
  { label: 'lone backslash', text: '\\' },
  { label: 'unterminated class', text: '[a-z' },
  { label: 'regex soup', text: '([\\.*+?^${}|)' },
  { label: 'query-breaking chars', text: 'a&b=c?d#e/f%g+h' },
  { label: 'percent-looking', text: '%20%2F%25' },
  { label: 'unicode + zero-width + RTL', text: 'dink\u200b\u202eкухня🥒' },
  { label: 'surrounding whitespace + tabs', text: '\t  kitchen line \n ' },
  { label: 'five thousand code points', text: HUGE },
];

describe('S5 — hostile search text through the real API client', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy
      .mockReset()
      .mockImplementation(async () =>
        jsonResponse({ items: [catalogItem], cursor: null }),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    act(() => {
      establishApiSession({
        apiBaseUrl: BASE_URL,
        bearerToken: 'signed-token',
        canonicalAppUserId: '9b2f7f0e-3c4d-4a5b-8c6d-7e8f9a0b1c2d',
        provider: 'apple',
      });
    });
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      clearApiSession();
    });
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('HELD: the initial load goes out with no q parameter at all', async () => {
    const renderer = renderScreen();
    await settle();
    expect(catalogUrls()).toEqual([`${BASE_URL}/v1/catalog/drills`]);
    act(() => renderer.unmount());
  });

  it.each(hostileQueries)(
    'HELD: "$label" never throws in matchesQuery and reaches the wire percent-encoded exactly once',
    async ({ text }) => {
      const renderer = renderScreen();
      await settle();
      const before = catalogUrls().length;

      expect(() => typeSearch(renderer, text)).not.toThrow();
      await advanceDebounce();
      await settle();

      const urls = catalogUrls().slice(before);
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        expect(urls).toEqual([`${BASE_URL}/v1/catalog/drills`]);
      } else {
        expect(urls).toHaveLength(1);
        const url = urls[0]!;
        const encodedQ = qParam(url);
        expect(encodedQ).not.toBeNull();
        // Exactly once: decoding once yields the trimmed input verbatim…
        expect(decodeURIComponent(encodedQ!)).toBe(trimmed);
        // …and the escape set is exactly what encodeURIComponent produces
        // (no second pass, no raw reserved characters leaking through).
        expect(encodedQ).toBe(encodeURIComponent(trimmed));
        expect(doubleEncodedEscapes(encodedQ!)).toBe(
          (trimmed.match(/%/g) ?? []).length,
        );
        // The query part never splits into extra parameters or a fragment.
        expect(url.split('?')).toHaveLength(2);
        expect(url).not.toContain('#');
        expect(url.slice(url.indexOf('?') + 1).split('&')).toEqual([
          `q=${encodedQ}`,
        ]);
        // Bearer + client version headers still ride along.
        const init = fetchSpy.mock.calls.find(call => call[0] === url)![1]!;
        expect((init.headers as Record<string, string>)['Authorization']).toBe(
          'Bearer signed-token',
        );
        expect(init.method).toBe('GET');
      }

      // The screen filtered client-side with literal matching and rendered.
      const copy = allText(renderer);
      expect(copy).toContain('drills');
      act(() => renderer.unmount());
    },
  );

  it('HELD: the 5,000-code-point query is sent whole (no truncation) and the YouTube escape hatch encodes it once too', async () => {
    const renderer = renderScreen();
    await settle();
    typeSearch(renderer, HUGE);
    await advanceDebounce();
    await settle();
    const url = catalogUrls().at(-1)!;
    const encodedQ = qParam(url)!;
    expect([...HUGE]).toHaveLength(5_000);
    expect([...decodeURIComponent(encodedQ)]).toHaveLength(5_000);
    expect(encodedQ.length).toBeGreaterThan(5_000);
    const [button] = renderer.root.findAll(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Search YouTube:') &&
        typeof n.props.onPress === 'function',
    );
    expect(button).toBeDefined();
    const { Linking } =
      jest.requireActual<typeof import('react-native')>('react-native');
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(async () => undefined);
    await act(async () => {
      button!.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    const youtubeUrl = openUrl.mock.calls[0]![0];
    expect(
      youtubeUrl.startsWith('https://www.youtube.com/results?search_query='),
    ).toBe(true);
    const search = youtubeUrl.slice(
      'https://www.youtube.com/results?search_query='.length,
    );
    expect(decodeURIComponent(search)).toBe(`${HUGE} pickleball drill`);
    expect(search).toBe(encodeURIComponent(`${HUGE} pickleball drill`));
    openUrl.mockRestore();
    act(() => renderer.unmount());
  });

  it('HELD: rapid keystrokes collapse into one request carrying only the final text', async () => {
    const renderer = renderScreen();
    await settle();
    const before = catalogUrls().length;
    for (const partial of ['(', '([', '([a', '([a-', '([a-z', '([a-z\\']) {
      typeSearch(renderer, partial);
      act(() => {
        jest.advanceTimersByTime(100);
      });
    }
    await advanceDebounce();
    await settle();
    const urls = catalogUrls().slice(before);
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(qParam(urls[0]!)!)).toBe('([a-z\\');
    act(() => renderer.unmount());
  });

  it('HELD: a 400 for an over-long query surfaces inline and keeps the previous catalog on screen', async () => {
    const renderer = renderScreen();
    await settle();
    fetchSpy.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({
            error: {
              code: 'catalog.query_too_long',
              message: 'Query too long',
            },
          }),
        }) as Response,
    );
    typeSearch(renderer, HUGE);
    await advanceDebounce();
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Query too long');
    expect(
      renderer.root.findAll(
        n => n.props.testID === 'drill-library-inline-error',
      ).length,
    ).toBeGreaterThan(0);
    // The previously loaded catalog is retained (filtered to zero by the
    // literal matcher, not wiped by the failure).
    expect(copy).toContain('0 of 1 drill');
    act(() => renderer.unmount());
  });
});
