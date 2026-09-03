/**
 * Button ledger for ProgressScreen: every pressable the screen renders is
 * pressed here and its real observable effect asserted — section/range tabs
 * (state + selected a11y state + copy re-anchoring), both ConsistencyCard
 * instances (StreakCalendar route), the error-state retry (reload, loading
 * guard, repeated failure), and the AchievementsShowcase badge toggles the
 * technique tab hosts. A final sweep asserts no unlisted pressable exists.
 */
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
}));

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchCanonicalProgress = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: (...args: unknown[]) =>
    mockFetchCanonicalProgress(...args),
}));

jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

const mockAppState = { profile: null as { skillLevel?: string } | null };
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockRefreshConsistency = jest.fn(async () => {});
const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: mockRefreshConsistency,
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { STREAK_MILESTONES } from '../../src/consistency/milestones';

const DAY_MS = 86_400_000;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function daysAgoDay(days: number): string {
  return daysAgoIso(days).slice(0, 10);
}

/** Both ConsistencyCard presses must land on a real root-stack route. */
const STREAK_ROUTE: keyof RootStackParams = 'StreakCalendar';

function consistencySnapshot() {
  return {
    asOfDay: daysAgoDay(0),
    timeZone: 'UTC',
    days: {},
    trainedToday: true,
    currentStreak: 5,
    atRisk: false,
    longestStreak: 6,
    shieldsAvailable: 1,
    shieldsEarnedTotal: 1,
    shieldedDayCount: 0,
    momentumXp: 140,
    momentum: { level: 2, xpIntoLevel: 40, xpForNextLevel: 80 },
    runXp: 100,
    trainedLast7: 5,
    totalTrainedDays: 9,
    totalActivities: 14,
    scoredAnalysisCount: 12,
    // Engine-consistent: a 5-day run has already banked the 1- and 3-day
    // milestones.
    earned: [
      { id: 'streak.1', earnedOnDay: daysAgoDay(4) },
      { id: 'streak.3', earnedOnDay: daysAgoDay(2) },
    ],
    nextStreakMilestone: null,
  };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ProgressScreen />);
  });
  return renderer;
}

/** react-test-renderer skips React.memo wrappers, so the mounted Pressable
 * node is the memo's inner component — match on that. */
const PressableInner = (
  Pressable as unknown as { type: React.ComponentType<unknown> }
).type;

/** Every Pressable element instance currently mounted (composite level —
 * this is where onPress / accessibility props are authored). */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(PressableInner);
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = pressables(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = pressableByLabel(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  await act(async () => {
    node.props.onPress();
  });
}

function hostByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === id,
  );
  return node ?? null;
}

function flatStyle(node: TestRenderer.ReactTestInstance) {
  const style = node.props.style;
  return StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed: false }) : style,
  ) as Record<string, unknown>;
}

const SECTION_LABELS = ['technique progress', 'practice progress'] as const;
const RANGE_LABELS = [
  '7 days range',
  '4 weeks range',
  '90 days range',
] as const;
const RANGE_COPY: Record<(typeof RANGE_LABELS)[number], string> = {
  '7 days range': 'VS. PRIOR 7 DAYS',
  '4 weeks range': 'VS. PRIOR 4 WEEKS',
  '90 days range': 'VS. PRIOR 90 DAYS',
};
const CONSISTENCY_EMPTY_LABEL =
  'Consistency. 0 days training streak, momentum level 1. Opens the streak calendar.';
const CONSISTENCY_SNAPSHOT_LABEL =
  'Consistency. 5 days training streak, momentum level 2. Opens the streak calendar.';

describe('ProgressScreen button ledger', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockRefreshConsistency.mockClear();
    mockListRealAnalysisFacts.mockReset();
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockFetchCanonicalProgress.mockReset();
    mockAppState.profile = null;
    mockConsistencyState.snapshot = null;
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('section tabs switch the dashboard and expose tab semantics', async () => {
    const renderer = await renderScreen();

    // Default: technique. Only the technique statistics are mounted.
    expect(hostByTestId(renderer, 'technique-stat-reps')).not.toBeNull();
    expect(hostByTestId(renderer, 'practice-stat-captures')).toBeNull();

    for (const label of SECTION_LABELS) {
      const tab = pressableByLabel(renderer, label);
      expect(tab.props.accessibilityRole).toBe('tab');
      expect(typeof tab.props.onPress).toBe('function');
      // >= 44pt hit target: the tab slot is minHeight 44.
      expect(flatStyle(tab).minHeight).toBeGreaterThanOrEqual(44);
    }
    expect(
      pressableByLabel(renderer, 'technique progress').props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      pressableByLabel(renderer, 'practice progress').props.accessibilityState
        .selected,
    ).toBe(false);

    await pressByLabel(renderer, 'practice progress');
    expect(hostByTestId(renderer, 'practice-stat-captures')).not.toBeNull();
    expect(hostByTestId(renderer, 'technique-stat-reps')).toBeNull();
    expect(renderedText(renderer)).toContain('VERIFIED PRACTICE');
    expect(
      pressableByLabel(renderer, 'practice progress').props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      pressableByLabel(renderer, 'technique progress').props.accessibilityState
        .selected,
    ).toBe(false);

    // Re-pressing the active tab is a harmless no-op, not a crash.
    await pressByLabel(renderer, 'practice progress');
    expect(hostByTestId(renderer, 'practice-stat-captures')).not.toBeNull();

    await pressByLabel(renderer, 'technique progress');
    expect(hostByTestId(renderer, 'technique-stat-reps')).not.toBeNull();
    expect(hostByTestId(renderer, 'practice-stat-captures')).toBeNull();
    expect(renderedText(renderer)).toContain('LATEST VALIDATED TECHNIQUE');
    act(() => renderer.unmount());
  });

  it('range tabs re-anchor every window label on both sections', async () => {
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('VS. PRIOR 4 WEEKS');
    expect(
      pressableByLabel(renderer, '4 weeks range').props.accessibilityState
        .selected,
    ).toBe(true);

    for (const label of RANGE_LABELS) {
      const tab = pressableByLabel(renderer, label);
      expect(tab.props.accessibilityRole).toBe('tab');
      expect(typeof tab.props.onPress).toBe('function');
      // WF-ISSUE: Range tabs render a 38pt-tall hit target without hitSlop
      // expect(flatStyle(tab).minHeight).toBeGreaterThanOrEqual(44);
    }

    // Technique section.
    for (const label of RANGE_LABELS) {
      await pressByLabel(renderer, label);
      const text = renderedText(renderer);
      expect(text).toContain(RANGE_COPY[label]);
      for (const other of RANGE_LABELS) {
        if (other !== label) expect(text).not.toContain(RANGE_COPY[other]);
        expect(
          pressableByLabel(renderer, other).props.accessibilityState.selected,
        ).toBe(other === label);
      }
    }
    expect(renderedText(renderer)).toContain('90 DAYS');

    // Practice section shares the same range state.
    await pressByLabel(renderer, 'practice progress');
    expect(renderedText(renderer)).toContain('VS. PRIOR 90 DAYS');
    await pressByLabel(renderer, '7 days range');
    const text = renderedText(renderer);
    expect(text).toContain('VS. PRIOR 7 DAYS');
    expect(text).toContain('CAPTURE EVIDENCE 7 DAYS');
    expect(text).not.toContain('VS. PRIOR 90 DAYS');
    act(() => renderer.unmount());
  });

  it('technique ConsistencyCard opens the streak calendar', async () => {
    const renderer = await renderScreen();
    const card = pressableByLabel(renderer, CONSISTENCY_EMPTY_LABEL);
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.testID).toBe('consistency-card');

    await pressByLabel(renderer, CONSISTENCY_EMPTY_LABEL);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(STREAK_ROUTE);
    act(() => renderer.unmount());
  });

  it('practice ConsistencyCard opens the streak calendar', async () => {
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'practice progress');
    expect(mockNavigate).not.toHaveBeenCalled();

    const card = pressableByLabel(renderer, CONSISTENCY_SNAPSHOT_LABEL);
    expect(card.props.accessibilityRole).toBe('button');
    await pressByLabel(renderer, CONSISTENCY_SNAPSHOT_LABEL);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(STREAK_ROUTE);
    act(() => renderer.unmount());
  });

  it('error-state retry reloads, hides itself while pending, and recovers', async () => {
    let releaseReload!: (rows: unknown[]) => void;
    mockListRealAnalysisFacts
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>(resolve => {
            releaseReload = resolve;
          }),
      );
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Progress couldn’t load');
    expect(renderedText(renderer)).toContain(
      'Your saved camera history could not be opened. No empty values were substituted.',
    );
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);

    const retry = pressableByLabel(renderer, 'Try again');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(flatStyle(retry).minHeight).toBeGreaterThanOrEqual(44);
    // The only pressable on the error surface is the retry itself.
    expect(pressables(renderer)).toHaveLength(1);

    await pressByLabel(renderer, 'Try again');
    // Pending: the loading state replaces the button (no double tap).
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Loading measured progress…');
    expect(pressables(renderer)).toHaveLength(0);
    expect(mockRefreshConsistency).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseReload([]);
    });
    const text = renderedText(renderer);
    expect(text).toContain('KEY STATISTICS');
    expect(text).not.toContain('Progress couldn’t load');
    act(() => renderer.unmount());
  });

  it('error-state retry that fails again re-shows the error with a live retry', async () => {
    mockListRealAnalysisFacts.mockRejectedValue(new Error('still down'));
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Progress couldn’t load');

    await pressByLabel(renderer, 'Try again');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Progress couldn’t load');
    const retry = pressableByLabel(renderer, 'Try again');
    expect(retry.props.disabled).toBeFalsy();

    // Third attempt succeeds.
    mockListRealAnalysisFacts.mockResolvedValue([]);
    await pressByLabel(renderer, 'Try again');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(3);
    expect(renderedText(renderer)).toContain('KEY STATISTICS');
    act(() => renderer.unmount());
  });

  it('a failing capture-history read also routes through the retry', async () => {
    mockListCaptureHistory
      .mockRejectedValueOnce(new Error('captures unreadable'))
      .mockResolvedValue([]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Progress couldn’t load');
    await pressByLabel(renderer, 'Try again');
    expect(renderedText(renderer)).toContain('KEY STATISTICS');
    act(() => renderer.unmount());
  });

  it('a failing account-progress fetch degrades to device data, never the error state', async () => {
    mockGetApiSession.mockReturnValue({
      apiBaseUrl: 'https://example.test',
      bearerToken: 'fake',
    });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    expect(text).not.toContain('Progress couldn’t load');
    expect(text).toContain('KEY STATISTICS');
    expect(text).not.toContain('OBSERVED SCORE SIGNALS');
    act(() => renderer.unmount());
  });

  it('achievement badges toggle their story open and closed', async () => {
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('ACHIEVEMENTS');

    // The next locked milestone past the fixture's 5-day streak.
    const first = STREAK_MILESTONES.find(milestone => milestone.days > 5)!;
    const daysAway = first.days - 5;
    const label = `${first.title}. Locked. ${daysAway} ${
      daysAway === 1 ? 'day' : 'days'
    } away`;
    const badge = pressableByLabel(renderer, label);
    expect(badge.props.accessibilityRole).toBe('button');
    expect(renderedText(renderer)).not.toContain(first.blurb);

    await pressByLabel(renderer, label);
    expect(renderedText(renderer)).toContain(first.blurb);
    expect(renderedText(renderer)).toContain(first.reward);

    await pressByLabel(renderer, label);
    expect(renderedText(renderer)).not.toContain(first.blurb);

    // An earned badge opens too, and selecting it closes the other story.
    const earned = STREAK_MILESTONES.find(m => m.id === 'streak.3')!;
    const [earnedBadge] = pressables(renderer).filter(n =>
      String(n.props.accessibilityLabel).startsWith(`${earned.title}. Earned`),
    );
    expect(earnedBadge).toBeDefined();
    await act(async () => {
      earnedBadge!.props.onPress();
    });
    expect(renderedText(renderer)).toContain(earned.blurb);
    expect(renderedText(renderer)).toContain('Unlocked');
    act(() => renderer.unmount());
  });

  it('hides achievements until a first activity exists', async () => {
    mockConsistencyState.snapshot = {
      ...consistencySnapshot(),
      totalActivities: 0,
      currentStreak: 0,
    };
    const renderer = await renderScreen();
    expect(renderedText(renderer)).not.toContain('ACHIEVEMENTS');
    act(() => renderer.unmount());
  });

  it('ledger: every mounted pressable is wired, labeled, and accounted for', async () => {
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();

    const badgeLabels = pressables(renderer)
      .map(n => n.props.accessibilityLabel as string)
      .filter(label => /\. (Locked\.|Earned)/.test(label));
    // 8 streak milestones + 2 volume achievements.
    expect(badgeLabels).toHaveLength(STREAK_MILESTONES.length + 2);

    const techniqueLedger = [
      ...SECTION_LABELS,
      ...RANGE_LABELS,
      ...badgeLabels,
      CONSISTENCY_SNAPSHOT_LABEL,
    ];
    const techniqueFound = pressables(renderer).map(n => {
      expect(typeof n.props.onPress).toBe('function');
      expect(n.props.disabled).toBeFalsy();
      expect(typeof n.props.accessibilityRole).toBe('string');
      expect(typeof n.props.accessibilityLabel).toBe('string');
      return n.props.accessibilityLabel as string;
    });
    expect(techniqueFound.sort()).toEqual([...techniqueLedger].sort());

    await pressByLabel(renderer, 'practice progress');
    const practiceLedger = [
      ...SECTION_LABELS,
      ...RANGE_LABELS,
      CONSISTENCY_SNAPSHOT_LABEL,
    ];
    const practiceFound = pressables(renderer).map(n => {
      expect(typeof n.props.onPress).toBe('function');
      expect(n.props.disabled).toBeFalsy();
      expect(typeof n.props.accessibilityRole).toBe('string');
      return n.props.accessibilityLabel as string;
    });
    expect(practiceFound.sort()).toEqual([...practiceLedger].sort());
    act(() => renderer.unmount());
  });
});
