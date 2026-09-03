/**
 * ProgressScreen derives its per-window fact slices from memoized arrays: a
 * section-tab toggle (unrelated state) must not re-run Intl day formatting
 * across the whole local history, and the range tabs must expose a ≥44pt
 * hit target.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
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

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: jest.fn(async () => null),
}));

jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
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

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import type { RealAnalysisFact } from '../../src/data/repository';

const DAY_MS = 86_400_000;
const FACT_COUNT = 3_000;

function fact(index: number): RealAnalysisFact {
  return {
    id: `fact-${index}`,
    shotType: index % 2 === 0 ? 'dink' : 'drive',
    capturedAt: new Date(Date.now() - (index % 400) * DAY_MS).toISOString(),
    overallScore: 5 + (index % 5),
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ProgressScreen />);
  });
  return renderer;
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No host node labeled ${label}`);
  return node;
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
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

describe('fix-12: ProgressScreen render-time scans', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListRealAnalysisFacts.mockReset();
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not re-format every fact when an unrelated section tab toggles', async () => {
    mockListRealAnalysisFacts.mockResolvedValue(
      Array.from({ length: FACT_COUNT }, (_, index) => fact(index)),
    );
    const renderer = await renderScreen();
    const formatToParts = jest.spyOn(
      Intl.DateTimeFormat.prototype,
      'formatToParts',
    );

    await press(renderer, 'practice progress');
    await press(renderer, 'technique progress');

    expect(formatToParts.mock.calls.length).toBeLessThan(FACT_COUNT / 10);
    act(() => renderer.unmount());
  });

  it('range tabs expose at least a 44pt tall hit target', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([]);
    const renderer = await renderScreen();

    for (const label of ['7 days range', '4 weeks range', '90 days range']) {
      const tab = hostByLabel(renderer, label);
      const style = StyleSheet.flatten(
        typeof tab.props.style === 'function'
          ? tab.props.style({ pressed: false })
          : tab.props.style,
      ) as { minHeight?: number; height?: number };
      const height = Math.max(style.minHeight ?? 0, style.height ?? 0);
      const slop = tab.props.hitSlop;
      const vertical =
        typeof slop === 'number'
          ? slop * 2
          : slop
            ? (slop.top ?? 0) + (slop.bottom ?? 0)
            : 0;
      expect(height + vertical).toBeGreaterThanOrEqual(44);
    }
    act(() => renderer.unmount());
  });
});
