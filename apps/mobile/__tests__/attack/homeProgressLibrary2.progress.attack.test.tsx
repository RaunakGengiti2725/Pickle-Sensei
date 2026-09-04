/**
 * ADVERSARIAL PASS 3 · mobile-home-progress-library · tester #2
 * Baseline: 4d812e1aa699014cc0521fd92fde66908043aaa8
 *
 * Assigned scenario S7 (Progress): canonical series dink avgScore 7.2 → 7.15
 * under the SAME scoring model — the BY STROKE movement label must never
 * read "-0.0". Extra attacks: the device-local series takes the same
 * formatter, mixed-model series stay honest (no movement), arrival order
 * never changes the movement sign, and the project's own signed-delta
 * formatter (progress/techniqueDashboard) already handles the case that
 * ProgressScreen's private `signed()` does not.
 *
 * Tests whose name starts with [BROKEN@4d812e1a] encode the EXPECTED
 * behaviour and FAIL on the baseline on purpose — each failure is a finding.
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

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { formatSignedDelta } from '../../src/progress/techniqueDashboard';
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

interface SeriesPoint {
  day: string;
  shotType: string;
  scoringModelVersion: string;
  shotCount: number;
  avgScore: number;
  bestScore: number;
}

function point(
  daysAgo: number,
  avgScore: number,
  overrides: Partial<SeriesPoint> = {},
): SeriesPoint {
  return {
    day: daysAgoDay(daysAgo),
    shotType: 'dink',
    scoringModelVersion: 'model-2',
    shotCount: 3,
    avgScore,
    bestScore: Math.max(avgScore, 7.5),
    ...overrides,
  };
}

function canonical(series: SeriesPoint[]) {
  return {
    series,
    improving: [],
    needsAttention: [],
    streak: {
      currentDays: 1,
      longestDays: 1,
      practicedToday: true,
      lastPracticeDate: daysAgoDay(0),
    },
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
  return out.join(' ').replace(/\s+/g, ' ');
}

/** The rendered "<signed> SERIES" movement labels, in order. */
function seriesLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  const text = renderedText(renderer);
  return [...text.matchAll(/([+-]\d+\.\d) SERIES/g)].map(m => m[1]!);
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderTechnique(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ProgressScreen />);
  });
  mounted.push(renderer);
  await pressByLabel(renderer, 'technique progress');
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

beforeEach(() => {
  jest.useFakeTimers();
  mockNavigate.mockClear();
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
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

// ------------------------------------------------ S7 · canonical -0.0 SERIES

describe('S7 · canonical dink series 7.2 → 7.15 under one scoring model', () => {
  it('renders the synced by-stroke row (daily averages basis) without throwing', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([point(3, 7.2), point(2, 7.15)]),
    );
    const renderer = await renderTechnique();
    const text = renderedText(renderer);
    expect(text).toContain('daily averages');
    expect(text).toContain('dink daily average');
    // The visible current value rounds 7.15 → "7.2" (toFixed), i.e. the
    // card shows the SAME number the series opened with…
    expect(text).toContain('7.2');
    expect(seriesLabels(renderer)).toHaveLength(1);
  });

  it('[BROKEN@4d812e1a] the movement label is never "-0.0 SERIES"', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([point(3, 7.2), point(2, 7.15)]),
    );
    const renderer = await renderTechnique();
    const labels = seriesLabels(renderer);
    // Observed on 4d812e1a: ["-0.0"] (movement = 7.15 - 7.2 = -0.05 →
    // toFixed(1) → "-0.0", painted in the "declining" flame colour).
    expect(labels).not.toContain('-0.0');
    expect(labels).toEqual(['+0.0']);
  });

  it('[BROKEN@4d812e1a] a sub-tenth decline is not coloured as a decline while reading as zero', async () => {
    const { Text } =
      jest.requireActual<typeof import('react-native')>('react-native');
    const { color } = jest.requireActual<
      typeof import('../../src/design/tokens')
    >('../../src/design/tokens');
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([point(3, 7.2), point(2, 7.15)]),
    );
    const renderer = await renderTechnique();
    const movementNodes = renderer.root
      .findAllByType(Text)
      .filter(
        n =>
          Array.isArray(n.props.children) &&
          n.props.children.includes(' SERIES'),
      );
    expect(movementNodes).toHaveLength(1);
    const style = movementNodes[0]!.props.style as unknown[];
    const colour = style
      .flat()
      .find(
        (s): s is { color: string } =>
          typeof s === 'object' && s !== null && 'color' in s,
      )?.color;
    const label = movementNodes[0]!.props.children[0] as string;
    // A label that READS as zero must not be painted flame (decline).
    if (/^[+-]0\.0$/.test(label)) {
      expect(colour).not.toBe(color.flame);
    }
  });

  it('the shared formatter formatSignedDelta already yields "+0.0" for the same delta (inconsistency evidence)', () => {
    expect(formatSignedDelta(7.15 - 7.2)).toBe('+0.0');
    expect(formatSignedDelta(-0.04)).toBe('+0.0');
    expect(formatSignedDelta(-0.05)).toBe('-0.1');
    expect(formatSignedDelta(0.6)).toBe('+0.6');
    expect(formatSignedDelta(-0.6)).toBe('-0.6');
  });
});

// ------------------------------------------------------------------ extras

describe('extras · movement label edge cases', () => {
  it('[BROKEN@4d812e1a] device-local scored reads 7.2 → 7.15 (same model + config) never render "-0.0 SERIES"', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 7.15 }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 7.2 }),
    ]);
    const renderer = await renderTechnique();
    expect(renderedText(renderer)).toContain('scored reads');
    expect(seriesLabels(renderer)).not.toContain('-0.0');
  });

  it('two identical canonical averages render "+0.0 SERIES" (never "-0.0")', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([point(3, 7.2), point(2, 7.2)]),
    );
    const renderer = await renderTechnique();
    expect(seriesLabels(renderer)).toEqual(['+0.0']);
  });

  it('a series that arrives newest-first still measures oldest → newest (sorted by day, not arrival)', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([point(2, 6.0), point(5, 8.0), point(3, 7.0)]),
    );
    const renderer = await renderTechnique();
    expect(seriesLabels(renderer)).toEqual(['-2.0']);
  });

  it('a scoring-model change mid-series shows no movement label at all (only same-model points compare)', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([
        point(4, 5.0, { scoringModelVersion: 'model-1' }),
        point(3, 5.5, { scoringModelVersion: 'model-1' }),
        point(2, 8.0, { scoringModelVersion: 'model-2' }),
      ]),
    );
    const renderer = await renderTechnique();
    expect(seriesLabels(renderer)).toEqual([]);
    expect(renderedText(renderer)).toContain('8.0');
  });

  it('hostile canonical values (NaN / ±Infinity / unparseable day) never throw', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockResolvedValue(
      canonical([
        point(3, Number.NaN),
        point(2, Number.POSITIVE_INFINITY, { day: 'garbage-day' }),
        point(2, Number.NEGATIVE_INFINITY, { day: '' }),
      ]),
    );
    const renderer = await renderTechnique();
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('a rejected canonical fetch falls back to the device series without throwing', async () => {
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('503'));
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ capturedAt: daysAgoIso(2), overallScore: 8 }),
      fact({ capturedAt: daysAgoIso(3), overallScore: 6 }),
    ]);
    const renderer = await renderTechnique();
    expect(seriesLabels(renderer)).toEqual(['+2.0']);
  });
});
