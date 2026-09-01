import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../../src/training/api';
import type { ScoredCheckpointFact } from '../../src/library/libraryFocus';
import { TrainingError, type DrillDetail } from '../../src/training/types';

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RNView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View: RNView } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(RNView, props);
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
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

/**
 * App Review honesty pins for the drill library's edge states: a local-only
 * (guest) session gets a "Connect account" exit instead of a retry that can
 * never succeed; an empty catalog says so instead of blaming a search that
 * was never typed; the inline error is announced to assistive tech with its
 * copy and dismissed by a real button; and the detail retry plus family chips
 * meet the 44pt touch target.
 */

const FOCUS_HINT =
  'After two scored analyses of the same technique, this library sorts ' +
  'itself around your weakest checkpoint.';

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

/** The Pressable element (role button, style + hitSlop resolved) behind a
 * labeled control, below any design-system wrapper. */
function buttonByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      n.props.accessibilityRole === 'button' &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No button labeled ${label}`);
  return node;
}

function resolvedStyle(node: TestRenderer.ReactTestInstance) {
  const style = node.props.style;
  const flat = StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed: false }) : style,
  );
  return flat ?? {};
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

describe('DrillLibraryScreen edge states (fix-1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGoBack.mockReset();
    mockNavigate.mockReset();
    mockListCatalogDrills
      .mockReset()
      .mockImplementation(async () => [{ ...dinkDrill }]);
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

  describe('local-only session', () => {
    beforeEach(() => {
      mockListCatalogDrills
        .mockReset()
        .mockRejectedValue(
          new TrainingError(
            'training.unconfigured',
            'Sign in to a synced account before loading training plans.',
            false,
          ),
        );
    });

    it('offers Connect account instead of a retry that can never succeed', async () => {
      const renderer = renderScreen();
      await settle();
      expect(
        findByTestId(renderer, 'drill-library-unconfigured'),
      ).not.toBeNull();
      const copy = allText(renderer);
      expect(copy).toContain('The drill catalog needs a synced account.');
      expect(copy).not.toContain('The drill catalog could not load.');
      expect(copy).not.toContain('training plans');
      expect(findPressableByLabel(renderer, 'Try again')).toBeNull();

      await pressByLabel(renderer, 'Connect account');
      expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
      act(() => renderer.unmount());
    });

    it('keeps the generic retry state for non-account failures', async () => {
      mockListCatalogDrills
        .mockReset()
        .mockRejectedValueOnce(
          new TrainingError(
            'training.unavailable',
            'Training is temporarily offline.',
            true,
          ),
        );
      const renderer = renderScreen();
      await settle();
      expect(allText(renderer)).toContain('The drill catalog could not load.');
      expect(findByTestId(renderer, 'drill-library-unconfigured')).toBeNull();
      expect(findPressableByLabel(renderer, 'Connect account')).toBeNull();
      expect(findPressableByLabel(renderer, 'Try again')).not.toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('empty catalog', () => {
    it('says the catalog is empty rather than blaming a search or filter', async () => {
      mockListCatalogDrills.mockReset().mockResolvedValue([]);
      const renderer = renderScreen();
      await settle();
      const copy = allText(renderer);
      expect(copy).toContain('No drills published yet');
      expect(copy).toContain('Pull down to refresh');
      expect(copy).not.toContain('No drills match');
      expect(copy).not.toContain('Try a different search or family filter.');
      expect(copy).not.toContain(FOCUS_HINT);
      expect(findByTestId(renderer, 'library-focus-hint')).toBeNull();
      act(() => renderer.unmount());
    });

    it('keeps the search-empty copy when a query produces zero hits', async () => {
      const renderer = renderScreen();
      await settle();
      mockListCatalogDrills.mockResolvedValue([]);
      typeSearch(renderer, 'zzzz-no-such-drill');
      await advanceDebounce();
      await settle();
      const copy = allText(renderer);
      expect(copy).toContain('No drills match');
      expect(copy).toContain('Try a different search or family filter.');
      expect(copy).not.toContain('No drills published yet');
      act(() => renderer.unmount());
    });
  });

  describe('inline error banner', () => {
    it('announces the failure copy as an alert and dismisses via a button', async () => {
      mockSaveDrill.mockRejectedValueOnce(
        new TrainingError(
          'training.request_failed',
          'Saving is unavailable right now.',
          true,
        ),
      );
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Save Dink Target Ladder');
      await settle();

      const banner = findByTestId(renderer, 'drill-library-inline-error');
      expect(banner).not.toBeNull();
      expect(banner!.props.accessibilityRole).toBe('alert');
      expect(banner!.props.accessibilityLiveRegion).toBe('assertive');
      expect(banner!.props.accessibilityLabel).toBeUndefined();
      expect(banner!.props.onPress).toBeUndefined();
      const bannerText = banner!
        .findAllByType(Text)
        .map(node => node.props.children)
        .join(' ');
      expect(bannerText).toContain('Saving is unavailable right now.');

      const dismiss = buttonByLabel(renderer, 'Dismiss error');
      expect(dismiss.props.accessibilityRole).toBe('button');
      expect(dismiss.props.hitSlop).toBe(8);
      expect(banner!.findAll(n => n === dismiss)).toHaveLength(1);

      await pressByLabel(renderer, 'Dismiss error');
      expect(findByTestId(renderer, 'drill-library-inline-error')).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('touch targets', () => {
    it('gives the detail retry a 44pt target that still recovers the detail', async () => {
      const renderer = renderScreen();
      await settle();
      await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
      await settle();
      expect(allText(renderer)).toContain(
        'Detail endpoint unavailable in this deployment.',
      );

      const retry = buttonByLabel(
        renderer,
        'Retry detail for Dink Target Ladder',
      );
      const style = resolvedStyle(retry);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(retry.props.hitSlop).toBe(8);

      mockGetDrill.mockResolvedValueOnce({
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
        instructionalMedia: [],
      });
      await pressByLabel(renderer, 'Retry detail for Dink Target Ladder');
      await settle();
      expect(mockGetDrill).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).not.toContain(
        'Detail endpoint unavailable in this deployment.',
      );
      act(() => renderer.unmount());
    });

    it('extends every family chip to at least a 44pt vertical target', async () => {
      const renderer = renderScreen();
      await settle();
      const chips = renderer.root.findAll(
        n =>
          typeof n.props.accessibilityLabel === 'string' &&
          (n.props.accessibilityLabel === 'Show all drill families' ||
            n.props.accessibilityLabel.startsWith('Filter ')) &&
          n.props.accessibilityRole === 'button' &&
          typeof n.props.onPress === 'function',
      );
      expect(
        new Set(chips.map(chip => chip.props.accessibilityLabel as string)),
      ).toEqual(
        new Set([
          'Show all drill families',
          'Filter dink drills',
          'Filter volley drills',
          'Filter drive drills',
          'Filter serve drills',
          'Filter return drills',
          'Filter drop reset drills',
          'Filter global drills',
        ]),
      );
      for (const chip of chips) {
        const style = resolvedStyle(chip);
        const minHeight =
          typeof style.minHeight === 'number' ? style.minHeight : 0;
        const slop = chip.props.hitSlop;
        const vertical =
          typeof slop === 'number'
            ? slop * 2
            : (slop?.top ?? 0) + (slop?.bottom ?? 0);
        expect(minHeight + vertical).toBeGreaterThanOrEqual(44);
      }
      act(() => renderer.unmount());
    });
  });
});
