/**
 * mobile-perf-memory reproduction: the Drill Library renders the whole
 * catalog eagerly (ScrollView + `.map`) and re-renders EVERY card on every
 * keystroke.
 *
 * DrillLibraryScreen.tsx: `renderDrill` builds a fresh set of inline
 * closures per card per render, `DrillCard` is a plain function component
 * (no React.memo), and the search `TextInput` writes `query` state on each
 * character (the 250 ms debounce only gates the network call, not the
 * render). The backend catalog route returns every matching drill with
 * `cursor: null`, so nothing bounds the number of cards mounted.
 *
 * Measured here by wrapping the design-system `Card` (the root of every
 * DrillCard) with a render counter.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';

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
jest.mock('../../src/data/repository', () => ({
  listScoredCheckpointFacts: jest.fn(async () => []),
}));

const mockListCatalogDrills = jest.fn<Promise<CatalogDrill[]>, [unknown]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: jest.fn(async () => {}),
    unsaveDrill: jest.fn(async () => {}),
    getDrill: jest.fn(),
  }),
}));

// Render counter on the design-system Card: DrillCard's root element is
// `<Card testID="drill-card-<slug>">`, so every DrillCard render is one
// Card render with that testID.
const mockDrillCardRenders = new Map<string, number>();
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const CountingCard = (props: Parameters<typeof actual.Card>[0]) => {
    if (
      typeof props.testID === 'string' &&
      props.testID.startsWith('drill-card-')
    ) {
      mockDrillCardRenders.set(
        props.testID,
        (mockDrillCardRenders.get(props.testID) ?? 0) + 1,
      );
    }
    return ReactModule.createElement(actual.Card, props);
  };
  return { ...actual, Card: CountingCard };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

const CATALOG_SIZE = 160;

function largeCatalog(): CatalogDrill[] {
  const families = ['dink', 'volley', 'drive', 'global'] as const;
  return families.flatMap((family, familyIndex) =>
    Array.from({ length: CATALOG_SIZE / families.length }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(familyIndex * 100 + i).padStart(
        12,
        '0',
      )}`,
      slug: `${family}-drill-${i}`,
      title: `${family} drill ${i}`,
      description: `Practice block ${i} for the ${family} family.`,
      coachName: 'Pickle Sensei Training Library',
      equipment: ['paddle'],
      difficultyMin: null,
      difficultyMax: null,
      families: [family],
      validationState: 'PUBLISHED',
      saved: false,
    })),
  );
}

function totalRenders(): number {
  let total = 0;
  for (const count of mockDrillCardRenders.values()) total += count;
  return total;
}

describe('DrillLibraryScreen catalog rendering (mobile-perf-memory)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDrillCardRenders.clear();
    mockListCatalogDrills.mockReset();
    mockListCatalogDrills.mockResolvedValue(largeCatalog());
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('mounts every catalog card at once and re-renders all of them per search keystroke', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DrillLibraryScreen));
    });
    await act(async () => {});

    // Evidence 1: no virtualization — all 160 cards are host-mounted.
    const mountedCards = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('drill-card-'),
    );
    expect(mountedCards).toHaveLength(CATALOG_SIZE);
    expect(mockDrillCardRenders.size).toBe(CATALOG_SIZE);

    // Evidence 2: one keystroke (before the debounce fires, so no catalog
    // reload and no filtered-list change) re-renders every card.
    const [input] = renderer.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.testID === 'drill-search-input',
    );
    if (!input) throw new Error('search input not rendered');
    const before = totalRenders();
    await act(async () => {
      input.props.onChangeText('d');
    });
    const perKeystroke = totalRenders() - before;
    expect(perKeystroke).toBeGreaterThanOrEqual(CATALOG_SIZE);

    // Evidence 3: expanding one card re-renders every other card too.
    const [toggle] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Show detail for dink drill 0' &&
        typeof n.props.onPress === 'function',
    );
    if (!toggle) throw new Error('expand toggle not rendered');
    const beforeExpand = totalRenders();
    await act(async () => {
      toggle.props.onPress();
    });
    expect(totalRenders() - beforeExpand).toBeGreaterThanOrEqual(CATALOG_SIZE);

    act(() => renderer.unmount());
  });
});
