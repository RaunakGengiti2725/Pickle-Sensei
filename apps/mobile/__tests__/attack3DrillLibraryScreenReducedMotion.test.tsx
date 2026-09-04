import React from 'react';
import { AccessibilityInfo, Animated, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { CatalogDrill } from '../src/training/api';
import type { ScoredCheckpointFact } from '../src/library/libraryFocus';
import type { DrillDetail, InstructionalMedia } from '../src/training/types';

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

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
const mockListScoredCheckpointFacts = jest.fn<
  Promise<ScoredCheckpointFact[]>,
  [unknown]
>();
jest.mock('../src/data/repository', () => ({
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
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

// The design system probes AccessibilityInfo.isReduceMotionEnabled() ONCE
// per process, so the answer must be in place before the first render in
// this file — hence a dedicated suite.
const isReduceMotionEnabled =
  AccessibilityInfo.isReduceMotionEnabled as jest.Mock;
isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));

import { DrillLibraryScreen } from '../src/screens/DrillLibraryScreen';

/**
 * ADVERSARIAL PASS 3 — DrillLibraryScreen with Reduce Motion ON.
 *
 * Reduced motion must not strand any state: the save toast still appears and
 * still dismisses itself, the detail reveal still renders its children
 * (without the 200 ms Animated.timing), and unmounting mid-toast leaves no
 * timer behind. Adds nothing to production.
 */

const dinkDrill: CatalogDrill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coachName: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficultyMin: '2.0',
  difficultyMax: '3.5',
  families: ['dink'],
  validationState: 'UNVALIDATED',
  saved: false,
};

const youtubeMedia: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
};

const detailFixture: DrillDetail = {
  id: dinkDrill.id,
  slug: dinkDrill.slug,
  title: dinkDrill.title,
  description: dinkDrill.description,
  coachName: dinkDrill.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: false,
  mappings: [
    {
      checkpoint: 'contact_height',
      shotType: 'dink',
      planRole: 'targeted',
      faultDirections: ['high'],
      cueText: 'Contact the ball below your waist.',
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
    },
  ],
  instructionalMedia: [youtubeMedia],
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

async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('attack 3 — DrillLibraryScreen with Reduce Motion enabled', () => {
  let consoleError: jest.SpyInstance;
  let timingSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    timingSpy = jest.spyOn(Animated, 'timing');
    mockListCatalogDrills.mockReset().mockResolvedValue([{ ...dinkDrill }]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockResolvedValue(detailFixture);
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('the probe answered true before the first render', async () => {
    const renderer = renderScreen();
    await settle();
    expect(isReduceMotionEnabled).toHaveBeenCalled();
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('the save toast still appears and still dismisses itself after 2.5 s', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    await settle();
    expect(allText(renderer)).toContain(
      'Saved to your library · Library → Saved drills',
    );
    await elapse(2_499);
    expect(allText(renderer)).toContain('Saved to your library');
    await elapse(1);
    expect(allText(renderer)).not.toContain('Saved to your library');
    expect(jest.getTimerCount()).toBe(0);
    act(() => renderer.unmount());
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('the detail reveal renders its content without arming the 200 ms reveal animation', async () => {
    const renderer = renderScreen();
    await settle();
    timingSpy.mockClear();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('FORM FOCUS');
    expect(copy).toContain('Contact the ball below your waist.');
    expect(copy).toContain('WATCH IT DONE');
    expect(copy).toContain('Video by Third Shot Sports on YouTube');
    const revealTimings = timingSpy.mock.calls.filter(
      call => (call[1] as { duration?: number } | undefined)?.duration === 200,
    );
    expect(revealTimings).toHaveLength(0);
    // Reduced motion leaves the reveal at full progress from the start: the
    // Animated.View wrapping the detail exposes opacity as an Animated.Value
    // already at 1 (no interpolation from 0).
    const [reveal] = renderer.root.findAll(
      n =>
        n.type === Animated.View ||
        (typeof n.type !== 'string' &&
          (n.type as { displayName?: string }).displayName ===
            'AnimatedComponent(View)'),
    );
    expect(reveal).toBeDefined();
    act(() => renderer.unmount());
  });

  it('rapid save/unsave keeps exactly one toast timer alive and unmounting mid-toast clears it', async () => {
    const renderer = renderScreen();
    await settle();
    for (let i = 0; i < 6; i += 1) {
      const label =
        i % 2 === 0
          ? 'Save Dink Target Ladder'
          : 'Remove Dink Target Ladder from saved drills';
      await pressByLabel(renderer, label);
      await settle();
      // The 160 ms toast fade (a plain opacity fade, still run under reduced
      // motion) and the bookmark's disabled-state transition drive their own
      // short timers; once they finish only the dismissal timer may remain.
      await elapse(500);
      expect(jest.getTimerCount()).toBe(1);
    }
    expect(allText(renderer)).toContain('Removed from saved drills');
    expect(jest.getTimerCount()).toBe(1);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
    await elapse(5_000);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('expanding, opening the player and unmounting mid-toast leaves no timers behind', async () => {
    const renderer = renderScreen();
    await settle();
    await pressByLabel(renderer, 'Show detail for Dink Target Ladder');
    await settle();
    await pressByLabel(renderer, 'Save Dink Target Ladder');
    await settle();
    await elapse(500);
    await pressByLabel(renderer, 'Watch demonstration for Dink Target Ladder');
    // Toast dismissal timer + YouTube watchdog are both pending now.
    expect(jest.getTimerCount()).toBe(2);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
    await elapse(15_000);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
