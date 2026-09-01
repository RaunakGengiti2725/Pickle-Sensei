/**
 * mobile-perf-memory reproduction: ProgressScreen re-derives the range
 * filter over EVERY loaded fact on every render.
 *
 * `selectedFacts` (ProgressScreen.tsx) is a plain `facts.filter(...)` in the
 * component body that calls `dayKey()` → `Intl.DateTimeFormat#formatToParts`
 * once per fact. It is not memoized, and because `byShot`'s useMemo depends
 * on that fresh array, `byShot` recomputes every render as well. Since the
 * screen loads facts with `listRealAnalysisFacts(db, null)` (unbounded), the
 * cost of ANY unrelated state change (tab toggle, range chip, refresh) grows
 * linearly with lifetime history.
 *
 * This test renders the screen with 3 000 facts and asserts that a single
 * section toggle re-runs formatToParts at least 3 000 more times.
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
    const ReactActual = jest.requireActual<typeof import('react')>('react');
    ReactActual.useEffect(() => callback(), [callback]);
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
import type { RealAnalysisFact } from '../../src/data/repository';

const DAY_MS = 86_400_000;
const FACT_COUNT = 3_000;

function facts(count: number): RealAnalysisFact[] {
  const shotTypes = ['dink', 'volley', 'drive', 'serve'] as const;
  return Array.from({ length: count }, (_, i) => ({
    id: `fact-${i}`,
    shotType: shotTypes[i % shotTypes.length]!,
    // Spread across ~2 years so most facts fall OUTSIDE the selected window.
    capturedAt: new Date(
      Date.now() - (i % 730) * DAY_MS - 3_600_000,
    ).toISOString(),
    overallScore: 5 + (i % 40) / 10,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
  }));
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

describe('ProgressScreen per-render fact scan (mobile-perf-memory)', () => {
  let formatToParts: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockListRealAnalysisFacts.mockReset();
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    formatToParts = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
  });

  afterEach(() => {
    formatToParts.mockRestore();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('loads the full local history unbounded and re-keys every fact on an unrelated state change', async () => {
    mockListRealAnalysisFacts.mockResolvedValue(facts(FACT_COUNT));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ProgressScreen));
    });

    // Evidence 1: the screen asks the repository for EVERY fact (limit null).
    expect(mockListRealAnalysisFacts).toHaveBeenCalledWith(
      expect.anything(),
      null,
    );

    // Baseline after the data-loading renders settle.
    formatToParts.mockClear();

    // A section toggle changes no fact, no range, no timezone — yet every
    // fact is run through Intl again because `selectedFacts` is unmemoized.
    await pressByLabel(renderer, 'practice progress');
    const afterSectionToggle = formatToParts.mock.calls.length;
    expect(afterSectionToggle).toBeGreaterThanOrEqual(FACT_COUNT);

    formatToParts.mockClear();
    await pressByLabel(renderer, 'technique progress');
    expect(formatToParts.mock.calls.length).toBeGreaterThanOrEqual(FACT_COUNT);

    act(() => renderer.unmount());
  });
});
