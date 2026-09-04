/**
 * Structural audit #2 (pass 1) — Progress BY STROKE cards.
 *
 * Two suspected defects are demonstrated against ProgressScreen's local
 * `byShot` memo, each as its own `it` so the run log states exactly which
 * one fails on the audited commit:
 *
 *  R3 — `signed(points.at(-1) - points[0])` is raw float subtraction and the
 *       triangle colour is `movement >= 0`; a sub-0.05 decline renders
 *       "-0.0 SERIES" in flame. AGENTS.md ("Progress dashboard") says
 *       averages aggregate in integer TENTHS precisely because "float
 *       summation once flipped a ±0.0 delta's triangle"; techniqueDashboard's
 *       `formatSignedDelta` is negative-zero safe, the by-stroke card is not.
 *
 *  R2 — the local by-stroke path anchors comparability on `allForShot[0]`
 *       (the newest fact of ANY resultKind), whereas techniqueDashboard's
 *       `comparableReads` anchors on the newest SCORED read and documents
 *       itself as "the same comparability rule the By-stroke cards use". A
 *       single low-confidence abstention on a newer model therefore hides
 *       every scored read of that stroke behind "Need 2" while KEY
 *       STATISTICS on the same screen still counts them.
 */
import React from 'react';
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
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
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

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
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

import { Text } from 'react-native';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { color } from '../../src/design/tokens';
import type { RealAnalysisFact } from '../../src/data/repository';

const DAY_MS = 86_400_000;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

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

/** The `<Text>` node whose flattened children end in " SERIES". */
function seriesMovementNode(renderer: TestRenderer.ReactTestRenderer) {
  const nodes = renderer.root.findAllByType(Text).filter(node => {
    const children = ([] as unknown[]).concat(node.props.children);
    return children.some(
      child => typeof child === 'string' && child.trim() === 'SERIES',
    );
  });
  return nodes;
}

describe('audit: Progress BY STROKE cards', () => {
  beforeEach(() => {
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
    jest.useRealTimers();
  });

  it('R3: a sub-0.05 decline between account daily averages never renders "-0.0 SERIES" in flame', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockListRealAnalysisFacts.mockResolvedValue([]);
    // Server daily averages carry two decimals (avg_score/10 in api.ts), so
    // 6.83 → 6.81 is a realistic -0.02 movement.
    mockFetchCanonicalProgress.mockResolvedValue({
      series: [
        {
          day: daysAgoDay(3),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 4,
          avgScore: 6.83,
          bestScore: 7,
        },
        {
          day: daysAgoDay(2),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 5,
          avgScore: 6.81,
          bestScore: 7.5,
        },
      ],
      improving: [],
      needsAttention: [],
      streak: {
        currentDays: 2,
        longestDays: 3,
        practicedToday: true,
        lastPracticeDate: daysAgoDay(0),
      },
    });
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');

    const [movement] = seriesMovementNode(renderer);
    expect(movement).toBeDefined();
    const label = ([] as unknown[])
      .concat(movement!.props.children)
      .filter((c): c is string => typeof c === 'string')
      .join('');
    const flattened = Object.assign(
      {},
      ...([] as unknown[]).concat(movement!.props.style).filter(Boolean),
    ) as { color?: string };

    // A movement that rounds to zero must not be typeset as a negative
    // zero, and must not be painted as a decline.
    expect(label).not.toMatch(/-0\.0/);
    expect(flattened.color).not.toBe(color.flame);
    act(() => renderer.unmount());
  });

  it('R2: one newer low-confidence abstention on a new model must not hide the stroke’s scored history that KEY STATISTICS still counts', async () => {
    // Repository order: newest first. The newest dink fact is an abstention
    // produced by model-3; the three scored dinks below it are all model-2.
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({
        capturedAt: daysAgoIso(1),
        resultKind: 'low_confidence',
        overallScore: null,
        confidence: 0.2,
        scoringModelVersion: 'model-3',
      }),
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.1 }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 6.9 }),
      fact({ capturedAt: daysAgoIso(4), overallScore: 6.4 }),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    // KEY STATISTICS (techniqueDashboard, newest SCORED read anchors) counts
    // the three scored dinks as comparable reads in the 28-day window.
    expect(text).toContain('KEY STATISTICS');
    // The by-stroke card for the same stroke must agree: 3 scored reads,
    // not "0 accepted reps · 0 scored reads" + "Need 2".
    expect(text).toContain('3 accepted reps');
    expect(text).not.toContain('0 accepted reps');
    act(() => renderer.unmount());
  });
});
