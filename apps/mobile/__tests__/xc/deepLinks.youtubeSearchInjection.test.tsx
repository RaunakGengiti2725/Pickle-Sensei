/**
 * xc/journey-deep-links-urls — the ONE `Linking.openURL` whose argument is
 * built from text the app does not fully control: DrillLibraryScreen's
 * "Browse YouTube" row (drill title from the server) and "Search YouTube"
 * row (free text the user typed). Both go through `youtubeSearchUrl`, which
 * percent-encodes the topic into a fixed https://www.youtube.com/results?
 * prefix.
 *
 * This suite renders the real screen with hostile titles / queries, presses
 * the real rows, captures what reached `Linking.openURL`, and asserts under
 * the WHATWG parser that the opened URL is ALWAYS
 * `https://www.youtube.com/results` with the payload confined to the
 * `search_query` parameter — never a scheme change, never a foreign host,
 * never an extra query key, never a fragment.
 */
import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import { TrainingError, type DrillDetail } from '../../src/training/types';

// Node built-ins, typed the way __tests__/wf/be-mobile-security-secrets.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };
const os = require('os') as { tmpdir: () => string };

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
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
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

const mockListCatalogDrills = jest.fn<
  Promise<CatalogDrill[]>,
  [{ q?: string; family?: string }]
>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: jest.fn(async () => undefined),
    unsaveDrill: jest.fn(async () => undefined),
    getDrill: mockGetDrill,
  }),
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

const ARTIFACT_DIR =
  process.env.XC_DEEP_LINKS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'xc-deep-links');

const HOSTILE_TOPICS: { label: string; text: string }[] = [
  { label: 'ampersand-new-param', text: 'dink&redirect=https://evil.example' },
  { label: 'hash-fragment', text: 'dink#@evil.example' },
  { label: 'question-mark', text: 'dink?next=javascript:alert(1)' },
  { label: 'slashes-host', text: '//evil.example/' },
  { label: 'at-host', text: '@evil.example' },
  { label: 'backslash-at', text: '\\@evil.example' },
  { label: 'javascript-scheme', text: 'javascript:alert(1)' },
  { label: 'percent-already', text: '%2F%2Fevil.example' },
  { label: 'crlf', text: 'dink\r\nLocation: https://evil.example' },
  { label: 'nul', text: 'dink\u0000evil' },
  { label: 'unicode-dots', text: 'dink。evil.example' },
  { label: 'html', text: '<script>alert(1)</script>' },
  { label: 'quotes', text: '" onmouseover="alert(1)' },
  { label: 'spaces-plus', text: 'a+b c%20d' },
  { label: 'long', text: 'x'.repeat(2_000) },
  { label: 'emoji', text: '🏓 dink 🥒' },
];

interface Row {
  surface: 'browse-title' | 'search-query';
  label: string;
  input: string;
  opened: string | null;
  protocol: string | null;
  host: string | null;
  pathname: string | null;
  queryKeys: string[];
  hash: string | null;
  decodedSearchQuery: string | null;
}

function analyse(
  surface: Row['surface'],
  label: string,
  input: string,
  opened: string | null,
): Row {
  if (opened === null) {
    return {
      surface,
      label,
      input,
      opened,
      protocol: null,
      host: null,
      pathname: null,
      queryKeys: [],
      hash: null,
      decodedSearchQuery: null,
    };
  }
  const parsed = new URL(opened);
  return {
    surface,
    label,
    input,
    opened,
    protocol: parsed.protocol,
    host: parsed.host,
    pathname: parsed.pathname,
    queryKeys: [...parsed.searchParams.keys()],
    hash: parsed.hash,
    decodedSearchQuery: parsed.searchParams.get('search_query'),
  };
}

function drillWithTitle(title: string): CatalogDrill {
  return {
    id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
    slug: 'dink-target-ladder',
    title,
    description: 'Land four consecutive cross-court dinks per kitchen zone.',
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    families: ['dink'],
    validationState: 'PUBLISHED',
    saved: false,
  };
}

function detailFor(drill: CatalogDrill): DrillDetail {
  return {
    id: drill.id,
    slug: drill.slug,
    title: drill.title,
    description: drill.description,
    coachName: drill.coachName,
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    saved: false,
    mappings: [],
    instructionalMedia: [],
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

async function pressByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  await act(async () => {
    node.props.onPress();
  });
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

function spyOnOpenUrl() {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockClear();
  spy.mockResolvedValue(undefined);
  return spy;
}

function assertConfined(row: Row): void {
  expect({ label: row.label, opened: row.opened }).toEqual({
    label: row.label,
    opened: expect.any(String),
  });
  expect({
    label: row.label,
    protocol: row.protocol,
    host: row.host,
    pathname: row.pathname,
    queryKeys: row.queryKeys,
    hash: row.hash,
  }).toEqual({
    label: row.label,
    protocol: 'https:',
    host: 'www.youtube.com',
    pathname: '/results',
    queryKeys: ['search_query'],
    hash: '',
  });
  expect(row.decodedSearchQuery).toBe(`${row.input} pickleball drill`);
  // Raw (unencoded) delimiter characters never appear after the prefix.
  const afterPrefix = (row.opened ?? '').slice(
    'https://www.youtube.com/results?search_query='.length,
  );
  expect({
    label: row.label,
    raw:
      /[#&?@\\\s<>"']/.test(afterPrefix) ||
      [...afterPrefix].some(ch => ch.charCodeAt(0) < 0x20),
  }).toEqual({
    label: row.label,
    raw: false,
  });
}

describe('xc deep links — YouTube search URL built from server title / user text', () => {
  const rows: Row[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockGetDrill
      .mockReset()
      .mockRejectedValue(
        new TrainingError('training.unavailable', 'offline', true),
      );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'youtube-search-injection.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          rows: rows.length,
          matrix: rows.map(row => ({
            ...row,
            input:
              row.input.length > 120
                ? `${row.input.slice(0, 120)}…`
                : row.input,
            opened:
              row.opened && row.opened.length > 300
                ? `${row.opened.slice(0, 300)}…`
                : row.opened,
            decodedSearchQuery:
              row.decodedSearchQuery && row.decodedSearchQuery.length > 120
                ? `${row.decodedSearchQuery.slice(0, 120)}…`
                : row.decodedSearchQuery,
          })),
        },
        null,
        2,
      ),
    );
  });

  it('server-supplied drill titles cannot escape the search_query parameter (Browse YouTube row)', async () => {
    for (const topic of HOSTILE_TOPICS.filter(t => t.label !== 'long')) {
      const drill = drillWithTitle(topic.text);
      mockListCatalogDrills
        .mockReset()
        .mockImplementation(async () => [{ ...drill }]);
      mockGetDrill.mockResolvedValue(detailFor(drill));
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, `Show detail for ${topic.text}`);
      await settle();
      await pressByLabel(renderer, `Browse YouTube videos for ${topic.text}`);
      expect(openUrl).toHaveBeenCalledTimes(1);
      const opened = openUrl.mock.calls[0]?.[0] ?? null;
      const row = analyse('browse-title', topic.label, topic.text, opened);
      rows.push(row);
      assertConfined(row);
      act(() => renderer.unmount());
    }
  });

  it('user-typed search text cannot escape the search_query parameter (Search YouTube row)', async () => {
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [drillWithTitle('Dink Target Ladder')]);
    for (const topic of HOSTILE_TOPICS) {
      const openUrl = spyOnOpenUrl();
      const renderer = renderScreen();
      await settle();
      typeSearch(renderer, topic.text);
      await advanceDebounce();
      await settle();
      await pressByTestId(renderer, 'search-youtube');
      expect(openUrl).toHaveBeenCalledTimes(1);
      const opened = openUrl.mock.calls[0]?.[0] ?? null;
      const row = analyse('search-query', topic.label, topic.text, opened);
      rows.push(row);
      assertConfined(row);
      act(() => renderer.unmount());
    }
  });
});
