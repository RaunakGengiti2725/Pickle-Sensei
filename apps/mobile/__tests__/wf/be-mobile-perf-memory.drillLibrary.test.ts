import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import { TrainingError, type DrillDetail } from '../../src/training/types';

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
const mockSaveDrill = jest.fn<Promise<void>, [string]>();
const mockUnsaveDrill = jest.fn<Promise<void>, [string]>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

// Every DrillCard render commits exactly one Card element carrying its
// `drill-card-<slug>` testID, so counting those Card renders counts card
// renders without touching the screen's internals.
const mockCardRenders: string[] = [];
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const CountingCard = (props: React.ComponentProps<typeof actual.Card>) => {
    if (
      typeof props.testID === 'string' &&
      props.testID.startsWith('drill-card-')
    ) {
      mockCardRenders.push(props.testID);
    }
    return ReactModule.createElement(actual.Card, props);
  };
  return { ...actual, Card: CountingCard };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

/**
 * Render-scaling pins for the drill library with a populated catalog: a
 * search keystroke, an expand, and a save toggle must each re-render a small
 * constant number of DrillCards (the ones whose props changed), not the whole
 * catalog. The list is not virtualized — every card stays mounted, which the
 * stress suite pins as 160 host nodes — so memoized cards with stable
 * callbacks are what keep per-interaction cost O(1) instead of O(catalog).
 */

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

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(DrillLibraryScreen));
  });
  return renderer;
}

async function settle() {
  await act(async () => {});
}

function mountedCards(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('drill-card-'),
  ).length;
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

function typeSearch(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const [input] = renderer.root.findAll(
    n => n.props.testID === 'drill-search-input',
  );
  if (!input) throw new Error('Search input not found');
  act(() => {
    input.props.onChangeText(text);
  });
}

function distinctRenders(): Set<string> {
  return new Set(mockCardRenders);
}

describe('DrillLibraryScreen render scaling (160-drill catalog)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCardRenders.length = 0;
    mockListCatalogDrills.mockReset().mockResolvedValue(largeCatalog());
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill
      .mockReset()
      .mockRejectedValue(
        new TrainingError(
          'training.request_failed',
          'Detail endpoint unavailable in this deployment.',
          true,
        ),
      );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mounts the full catalog once, then a search keystroke re-renders no cards', async () => {
    const renderer = renderScreen();
    await settle();
    expect(mountedCards(renderer)).toBe(CATALOG_SIZE);
    expect(distinctRenders().size).toBe(CATALOG_SIZE);

    mockCardRenders.length = 0;
    typeSearch(renderer, 'd');
    typeSearch(renderer, 'dr');
    typeSearch(renderer, 'dri');
    expect(mockCardRenders).toHaveLength(0);
    expect(mountedCards(renderer)).toBe(CATALOG_SIZE);
    act(() => renderer.unmount());
  });

  it('expanding one card re-renders only that card, not the catalog', async () => {
    const renderer = renderScreen();
    await settle();
    mockCardRenders.length = 0;

    await pressByLabel(renderer, 'Show detail for dink drill 7');
    await settle();
    expect(distinctRenders()).toEqual(new Set(['drill-card-dink-drill-7']));
    expect(mockCardRenders.length).toBeLessThanOrEqual(4);

    mockCardRenders.length = 0;
    await pressByLabel(renderer, 'Show detail for volley drill 3');
    await settle();
    expect(distinctRenders()).toEqual(
      new Set(['drill-card-dink-drill-7', 'drill-card-volley-drill-3']),
    );
    act(() => renderer.unmount());
  });

  it('toggling save on one card re-renders only that card', async () => {
    const renderer = renderScreen();
    await settle();
    mockCardRenders.length = 0;

    await pressByTestId(renderer, 'save-toggle-drive-drill-12');
    await settle();
    expect(distinctRenders()).toEqual(new Set(['drill-card-drive-drill-12']));
    expect(mockCardRenders.length).toBeLessThanOrEqual(4);
    expect(mockSaveDrill).toHaveBeenCalledWith('drive-drill-12');
    act(() => renderer.unmount());
  });
});
