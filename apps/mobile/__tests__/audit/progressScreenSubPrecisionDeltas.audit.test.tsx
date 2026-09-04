/**
 * AUDIT (structural pass 1, mobile-home-progress-library): sub-display-
 * precision deltas on the Progress technique dashboard.
 *
 * Contract under test (techniqueDashboard.ts `formatSignedDelta` + the
 * integer-tenths comment in `comparableReads`): a delta whose one-decimal
 * rendering is 0.0 must never be presented as a decline. Two surfaces on
 * ProgressScreen bypass that contract:
 *
 *  1. BY STROKE `signed(item.movement)` (ProgressScreen.tsx:95, :354, :378,
 *     :998, :1002) — raw float subtraction of series points, rendered with
 *     `toFixed(1)` and colored by the UNROUNDED sign.
 *  2. KEY STATISTICS `StatDeltaRow delta={avgDelta}` (ProgressScreen.tsx:428,
 *     :866; StatDeltaRow.tsx:23) — the mean-of-tenths subtraction is not
 *     rounded, so a sub-0.05 difference drives the triangle / "trending
 *     down" while both rendered values and the insight sentence agree the
 *     change is +0.0.
 *
 * Mock topology mirrors __tests__/progressScreenDashboard.test.tsx.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

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

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  return node ?? null;
}

/** The Text node whose flattened children contain `needle`. */
function textNodeContaining(
  renderer: TestRenderer.ReactTestRenderer,
  needle: string,
) {
  const nodes = renderer.root.findAllByType(Text).filter(node => {
    const children = ([] as unknown[]).concat(node.props.children);
    return children.some(
      child => typeof child === 'string' && child.includes(needle),
    );
  });
  return nodes[0] ?? null;
}

describe('AUDIT ProgressScreen sub-display-precision deltas', () => {
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
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('BY STROKE never renders a synced-series movement of -0.0 in the decline color', async () => {
    // Canonical /v1/progress averages are hundredths (server maps
    // round(avg*100)/10, api.ts divides by 10). 6.83 → 6.80 both render as
    // 6.8; the movement is -0.03 → toFixed(1) === "-0.0".
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockFetchCanonicalProgress.mockResolvedValue({
      series: [
        {
          day: daysAgoDay(4),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 3,
          avgScore: 6.83,
          bestScore: 7.2,
        },
        {
          day: daysAgoDay(2),
          shotType: 'dink',
          scoringModelVersion: 'model-2',
          shotCount: 3,
          avgScore: 6.8,
          bestScore: 7.1,
        },
      ],
      improving: [],
      needsAttention: [],
      streak: null,
    });
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    // Sanity: the BY STROKE card is on screen with the synced basis.
    expect(text).toContain('daily averages');
    expect(text).toContain('SERIES');

    const movementNode = textNodeContaining(renderer, 'SERIES');
    expect(movementNode).not.toBeNull();
    const rendered = ([] as unknown[])
      .concat(movementNode!.props.children)
      .filter((child): child is string => typeof child === 'string')
      .join('');
    const flattened = StyleSheet.flatten(movementNode!.props.style) as {
      color?: string;
    };

    // Contract: a delta that rounds to 0.0 is "+0.0" (formatSignedDelta
    // convention in techniqueDashboard.ts) and is never colored as a decline.
    expect(rendered).not.toContain('-0.0');
    expect(flattened.color).not.toBe(color.flame);
    act(() => renderer.unmount());
  });

  it('AVG SCORE row direction agrees with its own rendered values and the insight sentence', async () => {
    // 28-day default window. Current reads 7.1, 7.2 → mean 7.15 (renders
    // "7.2"). Prior window reads 7.1, 7.2, 7.2 → mean 7.1667 (renders
    // "7.2"). Delta −0.0167: insightLine says "+0.0", the row says "trending
    // down" with a flame triangle.
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.1 }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 7.2 }),
      fact({ capturedAt: daysAgoIso(30), overallScore: 7.1 }),
      fact({ capturedAt: daysAgoIso(31), overallScore: 7.2 }),
      fact({ capturedAt: daysAgoIso(32), overallScore: 7.2 }),
    ]);
    const renderer = await renderScreen();
    await pressByLabel(renderer, 'technique progress');
    const text = renderedText(renderer);

    const avgRow = findByTestId(renderer, 'technique-stat-avg');
    expect(avgRow).not.toBeNull();
    const label = String(avgRow!.props.accessibilityLabel);

    // Precondition: both rendered values are identical at display precision
    // and the screen's own insight sentence calls the change +0.0.
    expect(label).toMatch(/^AVG SCORE: 7\.2\. Prior period 7\.2/);
    expect(text).toContain('Average score +0.0 vs the prior 4 weeks.');

    // Contract: identical rendered values must not be announced as a trend.
    expect(label).toBe('AVG SCORE: 7.2. Prior period 7.2');
    act(() => renderer.unmount());
  });
});
