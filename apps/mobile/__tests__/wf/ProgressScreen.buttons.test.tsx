/**
 * Button ledger for ProgressScreen at default text size: every pressable
 * is pressed here and its real observable effect asserted — the range tabs
 * (state + selected a11y state + copy re-anchoring), the streak card
 * (StreakCalendar route), the empty page's one next step (Analyze) and the
 * error-state retry (reload, loading guard, repeated failure). A final sweep
 * asserts no unlisted pressable exists.
 */
import React from 'react';
import { Dimensions, Pressable, StyleSheet } from 'react-native';
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
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
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
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
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
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 86_400_000;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function daysAgoDay(days: number): string {
  return daysAgoIso(days).slice(0, 10);
}

/** The streak card press must land on a real root-stack route. */
const STREAK_ROUTE: keyof RootStackParams = 'StreakCalendar';
/** The empty page's one next step, typed against the stack as well. */
const ANALYZE_ROUTE: keyof RootStackParams = 'Analyze';

function scoredFact() {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    shotType: 'dink',
    capturedAt: daysAgoIso(2),
    overallScore: 7.1,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

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

const RANGE_LABELS = [
  '7 days range',
  '4 weeks range',
  '90 days range',
] as const;
const RANGE_COPY: Record<(typeof RANGE_LABELS)[number], string> = {
  '7 days range': 'EST. DUPR · 7 DAYS',
  '4 weeks range': 'EST. DUPR · 4 WEEKS',
  '90 days range': 'EST. DUPR · 90 DAYS',
};
const STREAK_EMPTY_LABEL = 'Streak: 0 days. Opens the streak calendar.';
const STREAK_SNAPSHOT_LABEL = 'Streak: 5 days. Opens the streak calendar.';
const EMPTY_ACTION_LABEL = 'Analyze your first stroke';

describe('ProgressScreen button ledger', () => {
  beforeEach(() => {
    setActiveDataOwner(OWNER);
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 375,
      height: 667,
      scale: 2,
      fontScale: 1,
    });
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockRefreshConsistency.mockClear();
    mockListRealAnalysisFacts.mockReset();
    mockListRealAnalysisFacts.mockResolvedValue([]);
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
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.restoreAllMocks();
  });

  it('range tabs re-anchor the trend and expose tab semantics', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain(RANGE_COPY['4 weeks range']);
    expect(
      pressableByLabel(renderer, '4 weeks range').props.accessibilityState
        .selected,
    ).toBe(true);

    for (const label of RANGE_LABELS) {
      const tab = pressableByLabel(renderer, label);
      expect(tab.props.accessibilityRole).toBe('tab');
      expect(typeof tab.props.onPress).toBe('function');
      // >= 44pt hit target.
      expect(flatStyle(tab).minHeight).toBeGreaterThanOrEqual(44);
    }

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
    // Re-pressing the active tab is a harmless no-op, not a crash.
    await pressByLabel(renderer, '90 days range');
    expect(renderedText(renderer)).toContain(RANGE_COPY['90 days range']);
    act(() => renderer.unmount());
  });

  it('the streak card opens the streak calendar (fresh account)', async () => {
    const renderer = await renderScreen();
    const card = pressableByLabel(renderer, STREAK_EMPTY_LABEL);
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.testID).toBe('consistency-card');

    await pressByLabel(renderer, STREAK_EMPTY_LABEL);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(STREAK_ROUTE);
    act(() => renderer.unmount());
  });

  it('the streak card opens the streak calendar (running streak)', async () => {
    mockConsistencyState.snapshot = consistencySnapshot();
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    const renderer = await renderScreen();
    const card = pressableByLabel(renderer, STREAK_SNAPSHOT_LABEL);
    expect(card.props.accessibilityRole).toBe('button');
    await pressByLabel(renderer, STREAK_SNAPSHOT_LABEL);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(STREAK_ROUTE);
    act(() => renderer.unmount());
  });

  it('the empty page offers one next step that opens Analyze', async () => {
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Get your first score');
    const action = pressableByLabel(renderer, EMPTY_ACTION_LABEL);
    expect(action.props.accessibilityRole).toBe('button');
    expect(flatStyle(action).minHeight).toBeGreaterThanOrEqual(44);

    await pressByLabel(renderer, EMPTY_ACTION_LABEL);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(ANALYZE_ROUTE);
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
    expect(text).toContain('Get your first score');
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
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    await pressByLabel(renderer, 'Try again');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(3);
    expect(renderedText(renderer)).toContain(RANGE_COPY['4 weeks range']);
    act(() => renderer.unmount());
  });

  it('a failing account-progress fetch degrades to device data, never the error state', async () => {
    mockGetApiSession.mockReturnValue({
      apiBaseUrl: 'https://example.test',
      bearerToken: 'fake',
      canonicalAppUserId: OWNER,
    });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    expect(text).not.toContain('Progress couldn’t load');
    expect(text).toContain(RANGE_COPY['4 weeks range']);
    expect(text).toContain('7.1 /10');
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('keeps rating and stroke rows side by side, stacking them at large text sizes', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    const regular = await renderScreen();
    expect(flatStyle(hostByTestId(regular, 'stroke-row-dink')!)).toMatchObject({
      flexDirection: 'row',
    });
    expect(
      flatStyle(hostByTestId(regular, 'player-rank-card-rating')!),
    ).toMatchObject({ alignItems: 'flex-end' });
    act(() => regular.unmount());

    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 375,
      height: 667,
      scale: 2,
      fontScale: 2,
    });
    const large = await renderScreen();
    // The name keeps the full width; the DUPR sits under it, left-aligned.
    expect(flatStyle(hostByTestId(large, 'stroke-row-dink')!)).toMatchObject({
      flexDirection: 'column',
      alignItems: 'flex-start',
    });
    expect(flatStyle(hostByTestId(large, 'stroke-rating-dink')!)).toMatchObject(
      { alignItems: 'flex-start' },
    );
    expect(
      flatStyle(hostByTestId(large, 'player-rank-card-rating')!),
    ).toMatchObject({ alignItems: 'flex-start' });
    act(() => large.unmount());
  });

  it('ledger: every mounted pressable is wired, labeled, and accounted for', async () => {
    const collect = (renderer: TestRenderer.ReactTestRenderer) =>
      pressables(renderer).map(n => {
        expect(typeof n.props.onPress).toBe('function');
        expect(n.props.disabled).toBeFalsy();
        expect(typeof n.props.accessibilityRole).toBe('string');
        expect(typeof n.props.accessibilityLabel).toBe('string');
        return n.props.accessibilityLabel as string;
      });

    // Scored history: the three range tabs and the streak card — no section
    // tabs, no achievement badges.
    mockConsistencyState.snapshot = consistencySnapshot();
    mockListRealAnalysisFacts.mockResolvedValue([scoredFact()]);
    const scored = await renderScreen();
    expect(collect(scored).sort()).toEqual(
      [...RANGE_LABELS, STREAK_SNAPSHOT_LABEL].sort(),
    );
    act(() => scored.unmount());

    // No scored history: the streak card and the one next step.
    mockConsistencyState.snapshot = null;
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const empty = await renderScreen();
    expect(collect(empty).sort()).toEqual(
      [STREAK_EMPTY_LABEL, EMPTY_ACTION_LABEL].sort(),
    );
    act(() => empty.unmount());
  });
});
