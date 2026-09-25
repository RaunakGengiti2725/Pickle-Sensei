/**
 * Progress page render tests: the one-page surface (level, streak, one
 * estimated-DUPR trend, each stroke's latest read) must stay honest —
 * comparisons only against a real prior window, hostile local data never
 * crashing the page, account-synced series honored, owner switches never
 * leaking another sign-in's history — all verifiable from mocked stores.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { type as typography } from '../src/design/tokens';

jest.mock('../src/data/db', () => ({
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
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      if (mockFocused) return callback();
    }, [callback, mockFocused]);
  },
}));

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

// Session is swappable per test: null (device-only) or a fake account
// session that activates the canonical-progress and server-rank paths.
const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchCanonicalProgress = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/progress/api', () => ({
  fetchCanonicalProgress: (...args: unknown[]) =>
    mockFetchCanonicalProgress(...args),
}));

// The rank card fetches its account rank itself; the fetch is stubbed so a
// fake session never reaches the network, while the local math stays real.
jest.mock('../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../src/progress/playerRank')
  >('../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

const mockAppState = {
  ownerKey: null as string | null,
  profile: null as { skillLevel?: string } | null,
};
jest.mock('../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../src/screens/ProgressScreen';
import type { RealAnalysisFact } from '../src/data/repository';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 86_400_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function syncedProgress(score: number) {
  return {
    series: [
      {
        day: daysAgoDay(2),
        shotType: 'serve',
        scoringModelVersion: 'model-2',
        shotCount: 1,
        avgScore: score,
        bestScore: score,
      },
    ],
    improving: [],
    needsAttention: [],
    streak: {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDate: null,
    },
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Calendar day (UTC slice) for canonical series rows; kept ≥2 days back so
 * device-zone drift can never push it outside the selected window. */
function daysAgoDay(days: number): string {
  return daysAgoIso(days).slice(0, 10);
}

let sequence = 0;

function fact(overrides: Partial<RealAnalysisFact>): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: daysAgoIso(2),
    overallScore: 7,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

function consistencyDay(day: string, shielded: boolean) {
  return {
    day,
    shielded,
    strokeCount: shielded ? 0 : 1,
    sessionStrokeCount: 0,
    drillCount: 0,
    scoredCount: shielded ? 0 : 1,
    scoreAvg: shielded ? null : 7,
    activities: [],
    xp: shielded ? 0 : 20,
  };
}

/** A minimal-but-complete consistency snapshot: trained today, shielded
 * yesterday, nothing else inside the last seven days. */
function consistencySnapshot() {
  return {
    asOfDay: daysAgoDay(0),
    timeZone: 'UTC',
    days: {
      [daysAgoDay(0)]: consistencyDay(daysAgoDay(0), false),
      [daysAgoDay(1)]: consistencyDay(daysAgoDay(1), true),
    },
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

/** Host node only: composite wrappers repeat the same testID prop, and the
 * accessibility props live on the rendered host view. */
function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  return node ?? null;
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  return node ?? null;
}

describe('ProgressScreen page', () => {
  beforeEach(() => {
    // Fake timers keep the chart reveal animations from outliving the test.
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockFocused = true;
    mockListRealAnalysisFacts.mockReset();
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockFetchCanonicalProgress.mockReset();
    mockAppState.profile = null;
    mockAppState.ownerKey = OWNER;
    setActiveDataOwner(OWNER);
    mockConsistencyState.snapshot = null;
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('never requests canonical history with a different owner’s API session', async () => {
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OTHER_OWNER });
    mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(8.3));
    mockListRealAnalysisFacts.mockResolvedValue([fact({ overallScore: 6.4 })]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('6.4');
    expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('rejects local history from a previous sign-in even when the same owner returns before render', async () => {
    const local = deferred<unknown[]>();
    mockListRealAnalysisFacts.mockReturnValueOnce(local.promise);
    const renderer = await renderScreen();
    setActiveDataOwner(OTHER_OWNER);
    setActiveDataOwner(OWNER);
    await act(async () => local.resolve([fact({ overallScore: 4.2 })]));
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    mockListRealAnalysisFacts.mockResolvedValue([fact({ overallScore: 8.3 })]);
    await act(async () => renderer.update(<ProgressScreen />));
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('8.3');
    act(() => renderer.unmount());
  });

  it('hides loaded history and rejects canonical work from an earlier sign-in generation', async () => {
    const canonical = deferred<ReturnType<typeof syncedProgress>>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockReturnValueOnce(canonical.promise);
    mockListRealAnalysisFacts.mockResolvedValue([fact({ overallScore: 4.2 })]);
    const renderer = await renderScreen();
    setActiveDataOwner(OTHER_OWNER);
    setActiveDataOwner(OWNER);
    const local = deferred<unknown[]>();
    mockListRealAnalysisFacts.mockReturnValueOnce(local.promise);
    mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(8.3));
    await act(async () => renderer.update(<ProgressScreen />));
    expect(renderedText(renderer)).toContain('Loading measured progress');
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    await act(async () => canonical.resolve(syncedProgress(4.2)));
    expect(renderedText(renderer)).toContain('Loading measured progress');
    await act(async () => local.resolve([]));
    expect(renderedText(renderer)).toContain('8.3');
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    act(() => renderer.unmount());
  });

  it('ignores canonical work after blur and starts a fresh request on refocus', async () => {
    const first = deferred<ReturnType<typeof syncedProgress>>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockReturnValueOnce(first.promise);
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    mockFocused = false;
    await act(async () => renderer.update(<ProgressScreen />));
    await act(async () => first.resolve(syncedProgress(4.2)));
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(8.3));
    mockFocused = true;
    await act(async () => renderer.update(<ProgressScreen />));
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('8.3');
    act(() => renderer.unmount());
  });

  it('paints local technique data before a deferred canonical request', async () => {
    const canonical = deferred<ReturnType<typeof syncedProgress>>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockReturnValue(canonical.promise);
    mockListRealAnalysisFacts.mockResolvedValue([fact({ overallScore: 6.4 })]);
    const renderer = await renderScreen();

    expect(findByTestId(renderer, 'stroke-row-dink')).not.toBeNull();
    expect(renderedText(renderer)).toContain('6.4 /10');
    expect(findByTestId(renderer, 'stroke-row-serve')).toBeNull();
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    // The account series joins the local reads; it never replaces them.
    await act(async () => canonical.resolve(syncedProgress(8.3)));
    expect(renderedText(renderer)).toContain('6.4 /10');
    expect(findByTestId(renderer, 'stroke-row-serve')).not.toBeNull();
    expect(renderedText(renderer)).toContain('8.3 /10');
    act(() => renderer.unmount());
  });

  it('merges canonical data later without holding the empty local page behind it', async () => {
    const canonical = deferred<ReturnType<typeof syncedProgress>>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockReturnValue(canonical.promise);
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Get your first score');
    expect(findByTestId(renderer, 'stroke-row-serve')).toBeNull();
    await act(async () => canonical.resolve(syncedProgress(8.3)));
    const text = renderedText(renderer);
    expect(text).not.toContain('Get your first score');
    expect(findByTestId(renderer, 'stroke-row-serve')).not.toBeNull();
    expect(text).toContain('8.3 /10');
    expect(text).toContain('1 daily average in 4 weeks');
    act(() => renderer.unmount());
  });

  it('discards the previous owner’s deferred local history on an owner switch', async () => {
    const local = deferred<unknown[]>();
    mockListRealAnalysisFacts.mockReturnValueOnce(local.promise);
    const renderer = await renderScreen();
    setActiveDataOwner(OTHER_OWNER);
    mockAppState.ownerKey = OTHER_OWNER;
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ shotType: 'serve', overallScore: 8.3 }),
    ]);
    await act(async () => renderer.update(<ProgressScreen />));
    expect(renderedText(renderer)).toContain('8.3');
    await act(async () => local.resolve([fact({ overallScore: 4.2 })]));
    expect(renderedText(renderer)).toContain('8.3');
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    act(() => renderer.unmount());
  });

  it('ignores the previous owner’s canonical result after the new owner has loaded', async () => {
    const first = deferred<ReturnType<typeof syncedProgress>>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockReturnValueOnce(first.promise);
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    setActiveDataOwner(OTHER_OWNER);
    mockAppState.ownerKey = OTHER_OWNER;
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OTHER_OWNER });
    mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(8.3));
    await act(async () => renderer.update(<ProgressScreen />));
    await act(async () => first.resolve(syncedProgress(4.2)));
    expect(renderedText(renderer)).toContain('8.3');
    expect(renderedText(renderer)).not.toContain('4.2 /10');
    act(() => renderer.unmount());
  });

  it('keeps unmount cancellation when local history finishes late', async () => {
    const local = deferred<unknown[]>();
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(8.3));
    mockListRealAnalysisFacts.mockReturnValue(local.promise);
    const renderer = await renderScreen();
    act(() => renderer.unmount());
    await act(async () => local.resolve([fact({})]));
    expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
    expect(renderer.toJSON()).toBeNull();
  });

  it('is one light page: the hero title, the level, the streak, one trend and the strokes', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.4 }),
    ]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);

    expect(text).toContain('Progress');
    expect(text).toContain('Your level, streak and stroke trends.');
    expect(findByTestId(renderer, 'player-rank-card')).not.toBeNull();
    expect(findByTestId(renderer, 'consistency-card')).not.toBeNull();
    expect(findByTestId(renderer, 'progress-trend')).not.toBeNull();
    expect(findByTestId(renderer, 'stroke-row-dink')).not.toBeNull();
    expect(text).toContain('Strokes');
    expect(findByTestId(renderer, 'progress-dupr-note')).not.toBeNull();
    // Everything that made the old dashboard loud is gone.
    for (const removed of [
      'TECHNIQUE',
      'PRACTICE',
      'KEY STATISTICS',
      'LATEST VALIDATED TECHNIQUE',
      'BY STROKE',
      'standard deviation',
      'MOMENTUM',
      'ACHIEVEMENTS',
      'SELF-REPORTED PLAYING LEVEL',
      'CAPTURE EVIDENCE',
      'OBSERVED SCORE SIGNALS',
      'THIS SET',
    ]) {
      expect(text).not.toContain(removed);
    }
    act(() => renderer.unmount());
  });

  it('renders the trend with its honest insight and each stroke’s movement', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      // Current window (4 weeks by default): two reads, newest 8.2.
      fact({ capturedAt: daysAgoIso(2), overallScore: 8.2 }),
      fact({ capturedAt: daysAgoIso(5), overallScore: 7.2 }),
      // Prior window: one read.
      fact({ capturedAt: daysAgoIso(40), overallScore: 8.1 }),
    ]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);

    expect(text).toContain('EST. DUPR · 4 WEEKS');
    // Insight states the window arithmetic, nothing more — as the change in
    // estimated DUPR (7.7 → 4.70 vs 8.1 → 5.10).
    expect(text).toContain('Average DUPR \u22120.40 vs the prior 4 weeks.');
    // The stroke's latest read prints as its estimated DUPR (5.20) in the
    // card-score numeral role with "8.2 /10" as the smaller line (D-046).
    const dupr = renderer.root
      .findAllByType(Text)
      .find(
        node =>
          Array.isArray(node.props.children) &&
          node.props.children[0] === '5.20',
      );
    expect(StyleSheet.flatten(dupr!.props.style)).toMatchObject(
      typography.score,
    );
    expect(text).toContain('8.2 /10');
    // Movement is the DUPR difference of the window's first and latest
    // comparable reads (7.2 → 4.20, 8.2 → 5.20), in plain words.
    expect(text).toContain('Up 1.00 in 4 weeks');
    expect(
      findByTestId(renderer, 'stroke-row-dink')!.props.accessibilityLabel,
    ).toBe(
      'dink. Estimated DUPR 5.20, technique score 8.2 out of 10. Up 1.00 in 4 weeks.',
    );
    act(() => renderer.unmount());
  });

  it('says when a stroke moved down, and when a single read has nothing to compare', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 6.5 }),
      fact({ capturedAt: daysAgoIso(4), overallScore: 8 }),
      fact({ shotType: 'serve', capturedAt: daysAgoIso(3), overallScore: 7 }),
    ]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    expect(text).toContain('Down 1.50 in 4 weeks');
    expect(text).toContain('1 scored read in 4 weeks');
    act(() => renderer.unmount());
  });

  it('shows one clear next step with zero scored history', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);

    expect(text).toContain('Unranked');
    expect(text).toContain('No streak yet');
    expect(text).toContain('Get your first score');
    expect(findByTestId(renderer, 'progress-trend')).toBeNull();
    expect(findByTestId(renderer, 'progress-dupr-note')).toBeNull();
    expect(
      renderer.root.findAll(n => n.props.accessibilityRole === 'tab'),
    ).toHaveLength(0);

    await pressByLabel(renderer, 'Analyze your first stroke');
    expect(mockNavigate).toHaveBeenCalledWith('Analyze');
    act(() => renderer.unmount());
  });

  it('keeps the trend honest when the window holds no reads', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(40), overallScore: 7 }),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, '7 days range');
    const text = renderedText(renderer);
    expect(text).toContain('No scored swings in the last 7 days.');
    expect(findByTestId(renderer, 'stroke-row-dink')).toBeNull();
    act(() => renderer.unmount());
  });

  it('survives a corrupt local timestamp without dropping the page', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.5 }),
      fact({ capturedAt: 'not a real timestamp', overallScore: 9.9 }),
    ]);
    const renderer = await renderScreen();

    // The corrupt read is excluded — never guessed, never a crash.
    expect(renderedText(renderer)).toContain('1 scored read in 4 weeks');
    expect(renderedText(renderer)).not.toContain('9.9 /10');
    act(() => renderer.unmount());
  });

  it('keeps the estimate disclaimer beside an account-only rank when this phone has no scores', async () => {
    const { fetchPlayerRank } = jest.requireMock(
      '../src/progress/playerRank',
    ) as { fetchPlayerRank: jest.Mock };
    fetchPlayerRank.mockResolvedValueOnce({
      rating: 5.5,
      tier: 'gold',
      techniqueCount: 0,
      scoredShotCount: null,
      updatedAt: null,
      techniques: [],
    });
    mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    await act(async () => {
      await Promise.resolve();
    });
    const text = renderedText(renderer);
    expect(text).toContain('Get your first score');
    expect(text).toContain('Gold');
    expect(findByTestId(renderer, 'progress-dupr-note')).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('keeps the first-score step when the only scored read cannot be placed in time', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: 'not a real timestamp', overallScore: 9.9 }),
    ]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Get your first score');
    expect(findByTestId(renderer, 'progress-trend')).toBeNull();
    act(() => renderer.unmount());
  });

  it('never lets an unscored newer capture hide a stroke’s score', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({
        capturedAt: daysAgoIso(1),
        resultKind: 'low_confidence',
        overallScore: null,
        scoringModelVersion: 'model-3',
      }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 7 }),
    ]);
    const renderer = await renderScreen();
    expect(findByTestId(renderer, 'stroke-row-dink')).not.toBeNull();
    expect(renderedText(renderer)).toContain('1 scored read in 4 weeks');
    act(() => renderer.unmount());
  });

  it('lists exactly the reads the trend counts: newest model only, nothing stamped in the future', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      // Saved out of time order: the older model's read comes first.
      fact({
        capturedAt: daysAgoIso(3),
        overallScore: 7,
        scoringModelVersion: 'model-1',
      }),
      fact({ capturedAt: daysAgoIso(1), overallScore: 8 }),
      // A clock-skewed read stamped two hours from now.
      fact({
        capturedAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        overallScore: 9.9,
      }),
    ]);
    const renderer = await renderScreen();
    const label = String(
      findByTestId(renderer, 'stroke-row-dink')!.props.accessibilityLabel,
    );
    expect(label).toContain('technique score 8.0 out of 10');
    expect(label).toContain('1 scored read in 4 weeks');
    expect(renderedText(renderer)).not.toContain('9.9 /10');
    expect(renderedText(renderer)).not.toContain('7.0 /10');
    act(() => renderer.unmount());
  });

  it('recovers through the error state retry', async () => {
    mockListRealAnalysisFacts
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockResolvedValue([]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Progress couldn’t load');

    await pressByLabel(renderer, 'Try again');
    await act(async () => {});
    expect(renderedText(renderer)).toContain('Get your first score');
    act(() => renderer.unmount());
  });

  it('re-anchors the trend and the stroke lines when the range switches', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7 }),
      fact({ capturedAt: daysAgoIso(40), overallScore: 6 }),
    ]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('EST. DUPR · 4 WEEKS');
    expect(renderedText(renderer)).toContain('1 scored read in 4 weeks');

    await pressByLabel(renderer, '7 days range');
    let text = renderedText(renderer);
    expect(text).toContain('EST. DUPR · 7 DAYS');
    expect(text).toContain('1 scored read in 7 days');
    expect(text).not.toContain('4 WEEKS');

    await pressByLabel(renderer, '90 days range');
    text = renderedText(renderer);
    expect(text).toContain('EST. DUPR · 90 DAYS');
    // Both reads are inside 90 days: the stroke now has a real movement
    // (6.0 → 3.38, 7.0 → 4.00).
    expect(text).toContain('Up 0.62 in 90 days');
    act(() => renderer.unmount());
  });

  it('marks the selected range tab for assistive tech', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([fact({})]);
    const renderer = await renderScreen();
    // 4 weeks is the default window.
    expect(
      hostByLabel(renderer, '4 weeks range')!.props.accessibilityState.selected,
    ).toBe(true);

    await pressByLabel(renderer, '7 days range');
    expect(
      hostByLabel(renderer, '7 days range')!.props.accessibilityState.selected,
    ).toBe(true);
    expect(
      hostByLabel(renderer, '4 weeks range')!.props.accessibilityState.selected,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('renders the account-synced series as daily averages and leaves server signals off the page', async () => {
    mockGetApiSession.mockReturnValue({
      canonicalAppUserId: OWNER,
      token: 'fake',
    });
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockFetchCanonicalProgress.mockResolvedValue({
      series: [
        {
          day: daysAgoDay(3),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 4,
          avgScore: 6.2,
          bestScore: 7,
        },
        {
          day: daysAgoDay(2),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 5,
          avgScore: 6.8,
          bestScore: 7.5,
        },
      ],
      improving: [{ checkpoint: 'contact_position', delta: 0.6 }],
      needsAttention: [{ checkpoint: 'athletic_base', avg: 4.9 }],
      streak: {
        currentDays: 2,
        longestDays: 3,
        practicedToday: true,
        lastPracticeDate: daysAgoDay(0),
      },
    });
    const renderer = await renderScreen();
    const text = renderedText(renderer);

    // The dink row reads the newest synced daily average.
    expect(findByTestId(renderer, 'stroke-row-dink')).not.toBeNull();
    expect(text).toContain('6.8 /10');
    expect(text).toContain('Up 0.37 in 4 weeks');
    expect(text).not.toContain('contact position');
    expect(text).not.toContain('RECENT READS HIGHER');
    act(() => renderer.unmount());
  });

  it('shows the streak with this week’s days and routes to the streak calendar', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7 }),
    ]);
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();
    const text = renderedText(renderer);

    expect(text).toContain('5-day streak');
    expect(text).toContain('Day 5 secured · 5 of the last 7 days');
    const dots = (state: string) =>
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.testID === `consistency-day-${state}`,
      ).length;
    expect(dots('trained')).toBe(1);
    expect(dots('shielded')).toBe(1);
    expect(dots('rest')).toBe(5);

    await pressByLabel(renderer, 'Streak: 5 days. Opens the streak calendar.');
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('keeps window math stable minutes after local midnight', async () => {
    // 00:10 local on the suite's zone — the hardest instant for day math.
    const localMidnightIsh = new Date();
    localMidnightIsh.setHours(0, 10, 0, 0);
    jest.setSystemTime(localMidnightIsh);
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(0.005), overallScore: 8 }), // ~7 min ago
      fact({ capturedAt: daysAgoIso(1), overallScore: 6 }),
      fact({ capturedAt: daysAgoIso(40), overallScore: 5 }),
    ]);
    const renderer = await renderScreen();
    // Both recent reads land in the current window (7.0 → 4.00) against the
    // prior window's 5.0 → 3.15.
    expect(renderedText(renderer)).toContain(
      'Average DUPR +0.85 vs the prior 4 weeks.',
    );
    act(() => renderer.unmount());
  });

  it('keeps window math stable across a DST fall-back day', async () => {
    // 2026-11-01T05:30:00Z is 01:30 EDT on the US fall-back morning; in any
    // other suite zone it is simply a fixed instant — the relative fixtures
    // must land in the same windows regardless.
    jest.setSystemTime(new Date('2026-11-01T05:30:00.000Z'));
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(1), overallScore: 7 }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 6 }),
      fact({ capturedAt: daysAgoIso(40), overallScore: 5 }),
    ]);
    const renderer = await renderScreen();
    // 5.0 → 3.15 in the prior window, 6.5 → 3.50 now.
    expect(renderedText(renderer)).toContain(
      'Average DUPR +0.35 vs the prior 4 weeks.',
    );
    act(() => renderer.unmount());
  });

  it('offers no Live Court surfaces (cut from the v1 launch)', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    const text = renderedText(renderer);
    expect(text).not.toContain('LIVE SESSIONS');
    expect(text).not.toContain('Gameplay progression');
    act(() => renderer.unmount());
  });
});
