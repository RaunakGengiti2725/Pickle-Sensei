/**
 * Progress dashboard render tests: the WHOOP-style surface must show honest
 * key-statistic deltas, celebrate a real personal best, survive hostile
 * local data, honor the account-synced series, and route into the streak
 * calendar and gameplay progression — all verifiable from mocked stores.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/data/db', () => ({
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
jest.mock('../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
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

const mockAppState = { profile: null as { skillLevel?: string } | null };
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
import type { CaptureEvidenceV1 } from '../src/camera/capture';

const DAY_MS = 86_400_000;

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
    ...overrides,
  };
}

/** Repository-shaped automatic capture with valid evidence (mirrors the
 * practiceHistory test fixture — metadata must match the clip exactly). */
function capture(
  id: string,
  capturedAtIso: string,
  status: 'analyzed' | 'awaiting_model' = 'analyzed',
) {
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount: 4,
    poseMissingFrameCount: 1,
    analysisInputFrameCount: 5,
    trackedDurationMs: 300,
    meanCanonicalJointVisibility: 0.8,
    meanJointCoverage: 0.75,
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
  const uri = `file:///captures/${id}.mov`;
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    evidenceStatus: 'valid',
    status,
    clip: {
      uri,
      capturedAtIso,
      durationMs: 3_000,
      fps: 60,
      width: 1_080,
      height: 1_920,
      captureMode: 'automatic_pose_trigger',
      recognition: {
        status: 'unknown',
        reason: 'validated_classifier_unavailable',
      },
      trigger: {
        startMs: 1_000,
        endMs: 1_800,
        peakMotionMs: 1_500,
        confidence: 0.82,
        source: 'temporal_pose_motion',
        modelVersion: 'temporal-stroke-heuristic-2',
      },
      captureEvidence: evidence,
      ballSpeed: {
        status: 'unavailable',
        reason: 'calibrated_ball_tracker_unavailable',
      },
      preRollMs: 1_000,
      postRollMs: 1_200,
    },
  };
}

/** A minimal-but-complete consistency snapshot for the technique tab. */
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

describe('ProgressScreen dashboard', () => {
  beforeEach(() => {
    // Fake timers keep the chart reveal animations from outliving the test.
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockListRealAnalysisFacts.mockReset();
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

  it('shows practice key statistics without inventing a first-period comparison', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'practice progress');
    const text = renderedText(renderer);

    expect(text).toContain('KEY STATISTICS');
    expect(text).toContain('VS. PRIOR 4 WEEKS');
    expect(findByTestId(renderer, 'practice-stat-captures')).not.toBeNull();
    // Zero prior captures: the rows show current values only — no fake "0
    // last period" comparison for a first measured window.
    const captures = findByTestId(renderer, 'practice-stat-captures')!;
    expect(captures.props.accessibilityLabel).toBe('CAPTURES: 0');
    act(() => renderer.unmount());
  });

  it('compares practice against a real prior window from stored captures', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockListCaptureHistory.mockResolvedValue([
      capture('a', daysAgoIso(1), 'analyzed'),
      capture('b', daysAgoIso(2), 'awaiting_model'),
      capture('c', daysAgoIso(2), 'analyzed'),
      // Prior 4-week window (28–56 days back).
      capture('d', daysAgoIso(40), 'analyzed'),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'practice progress');
    const text = renderedText(renderer);

    expect(
      findByTestId(renderer, 'practice-stat-captures')!.props
        .accessibilityLabel,
    ).toBe('CAPTURES: 3. Prior period 1, trending up');
    expect(
      findByTestId(renderer, 'practice-stat-active-days')!.props
        .accessibilityLabel,
    ).toBe('ACTIVE DAYS: 2. Prior period 1, trending up');
    expect(
      findByTestId(renderer, 'practice-stat-pose-tracked')!.props
        .accessibilityLabel,
    ).toBe('POSE TRACKED: 0.9s. Prior period 0.3s, trending up');

    // Hero: count, honest comparison sentence, and the capture streak.
    expect(text).toContain('+2 captures versus the prior 4 weeks.');
    expect(text).toContain('DAY STREAK');
    // Recent evidence list shows the latest four with their true states.
    expect(text).toContain('LATEST 4');
    expect(text).toContain('ANALYZED');
    expect(text).toContain('SAVED');
    act(() => renderer.unmount());
  });

  it('renders technique deltas, a real personal best, and the score trend', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      // Current window (4W default): two reads, best 8.2.
      fact({ capturedAt: daysAgoIso(2), overallScore: 8.2 }),
      fact({ capturedAt: daysAgoIso(5), overallScore: 7.2 }),
      // Prior window: one read — the previous best this window beats.
      fact({ capturedAt: daysAgoIso(40), overallScore: 8.1 }),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    expect(text).toContain('KEY STATISTICS');
    expect(text).toContain('VS. PRIOR 4 WEEKS');
    expect(text).toContain('SCORE TREND');
    expect(text).toContain('DAILY AVG · ALL TECHNIQUES');

    // Key statistic rows carry the honest prior-window comparison.
    const reps = findByTestId(renderer, 'technique-stat-reps')!;
    expect(reps.props.accessibilityLabel).toBe(
      'SCORED REPS: 2. Prior period 1, trending up',
    );
    const best = findByTestId(renderer, 'technique-stat-best')!;
    expect(best.props.accessibilityLabel).toBe(
      'BEST SCORE: 8.2. Prior period 8.1, trending up',
    );

    // The 8.2 read strictly beats the pre-window best of 8.1.
    expect(findByTestId(renderer, 'personal-best-card')).not.toBeNull();
    expect(text).toContain('NEW PERSONAL BEST');
    expect(text).toMatch(/Beats your previous best\s+8\.1/);

    // Insight states the window arithmetic, nothing more.
    expect(text).toContain('Average score -0.4 vs the prior 4 weeks.');
    act(() => renderer.unmount());
  });

  it('keeps the technique tab honest with zero scored history', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    expect(text).toContain('No score is being estimated.');
    expect(text).toContain(
      'No comparable scored reads in this window yet. Your next validated analysis starts this chart.',
    );
    expect(
      findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
    ).toBe('SCORED REPS: 0');
    expect(findByTestId(renderer, 'personal-best-card')).toBeNull();
    expect(text).toContain('Comparable trends start after scoring');
    act(() => renderer.unmount());
  });

  it('survives a corrupt local timestamp without dropping the page', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.5 }),
      fact({ capturedAt: 'not a real timestamp', overallScore: 9.9 }),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');

    // The corrupt read is excluded — never guessed, never a crash.
    expect(
      findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
    ).toBe('SCORED REPS: 1');
    expect(renderedText(renderer)).not.toContain('9.9');
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
    expect(renderedText(renderer)).toContain('KEY STATISTICS');
    act(() => renderer.unmount());
  });

  it('re-anchors every comparison when the range switches', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('VS. PRIOR 4 WEEKS');

    await pressByLabel(renderer, '7 days range');
    const text = renderedText(renderer);
    expect(text).toContain('VS. PRIOR 7 DAYS');
    expect(text).not.toContain('VS. PRIOR 4 WEEKS');

    await pressByLabel(renderer, '90 days range');
    expect(renderedText(renderer)).toContain('VS. PRIOR 90 DAYS');
    act(() => renderer.unmount());
  });

  it('marks the active section tab for assistive tech', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    // Technique is the default (left) tab.
    expect(
      hostByLabel(renderer, 'technique progress')!.props.accessibilityState
        .selected,
    ).toBe(true);

    await pressByLabel(renderer, 'practice progress');
    expect(
      hostByLabel(renderer, 'practice progress')!.props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      hostByLabel(renderer, 'technique progress')!.props.accessibilityState
        .selected,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('renders the account-synced series and server signals when signed in', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
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
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    // The hero falls back to the newest synced daily average.
    expect(text).toContain('dink daily average');
    expect(text).toContain('6.8');
    // By-stroke compares the account's daily averages, labeled as such.
    expect(text).toContain('daily averages');
    // Server signals render with their honest disclosure.
    expect(text).toContain('OBSERVED SCORE SIGNALS');
    expect(text).toContain('RECENT READS HIGHER');
    expect(text).toContain('+0.6');
    expect(text).toContain('LOWER RECENT AVG');
    expect(text).toContain('4.9');
    expect(text).toContain('They are not a player rating.');
    act(() => renderer.unmount());
  });

  it('shows consistency, achievements, and the streak calendar route', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7 }),
    ]);
    mockConsistencyState.snapshot = consistencySnapshot();
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    expect(text).toContain('ACHIEVEMENTS');
    expect(text).toContain('Day 5 secured');

    await pressByLabel(
      renderer,
      'Consistency. 5 days training streak, momentum level 2. Opens the streak calendar.',
    );
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
    await pressByLabel(renderer, 'technique progress');
    expect(
      findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
    ).toBe('SCORED REPS: 2. Prior period 1, trending up');
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
    await pressByLabel(renderer, 'technique progress');
    expect(
      findByTestId(renderer, 'technique-stat-reps')!.props.accessibilityLabel,
    ).toBe('SCORED REPS: 2. Prior period 1, trending up');
    expect(renderedText(renderer)).toContain(
      'Average score +1.5 vs the prior 4 weeks.',
    );
    act(() => renderer.unmount());
  });

  it('offers no Live Court surfaces (cut from the v1 launch)', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);
    expect(text).not.toContain('LIVE SESSIONS');
    expect(text).not.toContain('Gameplay progression');
    act(() => renderer.unmount());
  });
});
