/**
 * Progress dashboard flow, driven the way a player would: land on the
 * technique tab, switch sections and windows, hit a failing load and recover
 * through retry, and step into the streak calendar from either section.
 * Every control is exercised through its rendered handler and its
 * accessibility contract is asserted on the host node.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { type } from '../../src/design/tokens';

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

const mockFetchPlayerRank = jest.fn<Promise<unknown>, unknown[]>(
  async () => null,
);
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (...args: unknown[]) => mockFetchPlayerRank(...args),
  };
});

jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: { profile: null }) => unknown) =>
    selector({ profile: null }),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

const mockMaybeCelebrate = jest.fn<Promise<void>, [unknown]>(async () => {});
jest.mock('../../src/progress/rankCelebration', () => ({
  useRankCelebrationStore: (
    selector: (s: { maybeCelebrate: typeof mockMaybeCelebrate }) => unknown,
  ) => selector({ maybeCelebrate: mockMaybeCelebrate }),
}));

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { PRACTICE_HISTORY_RANGES } from '../../src/progress/practiceHistory';

const DAY_MS = 86_400_000;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function daysAgoDay(days: number): string {
  return daysAgoIso(days).slice(0, 10);
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
    earned: [],
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

/** Host node carrying the label — the one assistive tech actually sees. */
function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  return node ?? null;
}

function hostsByRole(renderer: TestRenderer.ReactTestRenderer, role: string) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityRole === role,
  );
}

/** The element owning the press handler for a label (Pressable composite;
 * the host view receives responder props, not onPress). */
function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  await press(pressableByLabel(renderer, label));
}

describe('flow: progress dashboard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockMaybeCelebrate.mockClear();
    mockListRealAnalysisFacts.mockReset();
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockFetchCanonicalProgress.mockReset();
    mockFetchPlayerRank.mockReset();
    mockFetchPlayerRank.mockResolvedValue(null);
    mockConsistencyState.snapshot = null;
    mockConsistencyState.refresh.mockClear();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('opens on Technique with a real tablist and refreshes the streak on focus', async () => {
    const renderer = await renderScreen();

    const tabs = hostsByRole(renderer, 'tab');
    const sectionTabs = tabs.filter(tab =>
      String(tab.props.accessibilityLabel).endsWith(' progress'),
    );
    expect(sectionTabs.map(tab => tab.props.accessibilityLabel)).toEqual([
      'technique progress',
      'practice progress',
    ]);
    expect(sectionTabs[0]!.props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(sectionTabs[0]!.props.accessibilityState.disabled).toBeFalsy();
    expect(sectionTabs[1]!.props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(hostsByRole(renderer, 'tablist').length).toBeGreaterThanOrEqual(2);
    expect(mockConsistencyState.refresh).toHaveBeenCalledTimes(1);

    // Title role is the canonical top-level page hero (AGENTS.md typography).
    const title = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === 'Progress');
    expect(title).toBeDefined();
    expect(
      Array.isArray(title!.props.style) &&
        title!.props.style.includes(type.hero),
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('switches sections both ways and keeps the selected tab honest', async () => {
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('SCORE TREND');

    await pressByLabel(renderer, 'practice progress');
    let text = renderedText(renderer);
    expect(text).toContain('VERIFIED CAMERA PRACTICE');
    expect(text).not.toContain('SCORE TREND');
    expect(
      hostByLabel(renderer, 'practice progress')!.props.accessibilityState
        .selected,
    ).toBe(true);

    // Re-pressing the active tab is a no-op, never a crash or a reload.
    await pressByLabel(renderer, 'practice progress');
    expect(renderedText(renderer)).toContain('VERIFIED CAMERA PRACTICE');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);

    await pressByLabel(renderer, 'technique progress');
    text = renderedText(renderer);
    expect(text).toContain('SCORE TREND');
    expect(
      hostByLabel(renderer, 'technique progress')!.props.accessibilityState
        .selected,
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('exposes every window option as a tab and re-anchors on each pick', async () => {
    const renderer = await renderScreen();
    for (const option of PRACTICE_HISTORY_RANGES) {
      const tab = hostByLabel(renderer, `${option.label} range`);
      expect(tab).not.toBeNull();
      expect(tab!.props.accessibilityRole).toBe('tab');
      expect(tab!.props.accessibilityState).toMatchObject({
        selected: option.key === '28d',
      });
    }

    await pressByLabel(renderer, '7 days range');
    expect(renderedText(renderer)).toContain('VS. PRIOR 7 DAYS');
    expect(
      hostByLabel(renderer, '7 days range')!.props.accessibilityState.selected,
    ).toBe(true);
    expect(
      hostByLabel(renderer, '4 weeks range')!.props.accessibilityState.selected,
    ).toBe(false);

    // The window applies to the practice section too.
    await pressByLabel(renderer, 'practice progress');
    expect(renderedText(renderer)).toContain('VS. PRIOR 7 DAYS');
    await pressByLabel(renderer, '90 days range');
    expect(renderedText(renderer)).toContain('VS. PRIOR 90 DAYS');
    // Selecting a window never re-queries storage.
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('surfaces a failed local load as an alert with honest copy and a working retry', async () => {
    mockListRealAnalysisFacts
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValue([]);
    const renderer = await renderScreen();

    const alert = hostsByRole(renderer, 'alert')[0];
    expect(alert).toBeDefined();
    expect(alert!.props.accessibilityLiveRegion).toBe('assertive');
    const text = renderedText(renderer);
    expect(text).toContain('Progress couldn’t load');
    expect(text).toContain(
      'Your saved camera history could not be opened. No empty values were substituted.',
    );
    expect(text).not.toContain('KEY STATISTICS');

    // First retry fails again: the error state returns, never a hang.
    await pressByLabel(renderer, 'Try again');
    await act(async () => {});
    expect(renderedText(renderer)).toContain('Progress couldn’t load');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);

    // Second retry succeeds and the dashboard renders.
    await pressByLabel(renderer, 'Try again');
    await act(async () => {});
    expect(renderedText(renderer)).toContain('KEY STATISTICS');
    expect(renderedText(renderer)).not.toContain('Progress couldn’t load');
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(3);
    act(() => renderer.unmount());
  });

  it('collapses a double-tapped retry into a single reload', async () => {
    mockListRealAnalysisFacts
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockResolvedValue([]);
    const renderer = await renderScreen();
    expect(hostByLabel(renderer, 'Try again')!.props.accessibilityRole).toBe(
      'button',
    );
    const retry = pressableByLabel(renderer, 'Try again');

    // Both taps land inside one commit; the loading state replaces the
    // button and only one additional load is issued.
    await act(async () => {
      retry.props.onPress();
      retry.props.onPress();
    });
    await act(async () => {});
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('KEY STATISTICS');
    act(() => renderer.unmount());
  });

  it('keeps loading finite when the account endpoints fail behind a session', async () => {
    mockGetApiSession.mockReturnValue({
      apiBaseUrl: 'https://example.test',
      bearerToken: 'fake',
    });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
    mockFetchPlayerRank.mockRejectedValue(new Error('offline'));
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    expect(text).not.toContain('Loading measured progress');
    expect(text).not.toContain('Progress couldn’t load');
    expect(text).toContain('KEY STATISTICS');
    // Device-only evidence stands in: nothing is invented for the rank.
    expect(text).toContain('Unranked');
    act(() => renderer.unmount());
  });

  it('routes the consistency card to StreakCalendar from both sections', async () => {
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();
    const label =
      'Consistency. 5 days training streak, momentum level 2. Opens the streak calendar.';

    const techniqueCard = hostByLabel(renderer, label)!;
    expect(techniqueCard.props.accessibilityRole).toBe('button');
    expect(techniqueCard.props.accessibilityState?.disabled).toBeFalsy();
    await pressByLabel(renderer, label);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');

    await pressByLabel(renderer, 'practice progress');
    await pressByLabel(renderer, label);
    expect(mockNavigate).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenLastCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('shows the fresh-account consistency card without inventing a streak', async () => {
    const renderer = await renderScreen();
    const label =
      'Consistency. 0 days training streak, momentum level 1. Opens the streak calendar.';
    expect(hostByLabel(renderer, label)).not.toBeNull();
    expect(renderedText(renderer)).toContain(
      'Your first analysis lights the flame.',
    );
    await pressByLabel(renderer, label);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('reports the resolved rank to the ceremony store once per resolve', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        shotType: 'dink',
        capturedAt: daysAgoIso(2),
        overallScore: 7.1,
        confidence: 0.9,
        resultKind: 'scored',
        scoringModelVersion: 'model-2',
        shotConfigVersion: 'config-1',
      },
    ]);
    const renderer = await renderScreen();
    expect(mockMaybeCelebrate).toHaveBeenCalledTimes(1);
    expect(mockMaybeCelebrate.mock.calls[0]![0]).toMatchObject({
      tier: 'platinum',
    });
    // Switching windows/sections re-renders but never re-reports.
    await pressByLabel(renderer, '7 days range');
    await pressByLabel(renderer, 'practice progress');
    expect(mockMaybeCelebrate).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
