/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * ProgressScreen's focus load awaits `Promise.all([facts, captures,
 * fetchCanonicalProgress(...).catch(() => null)])` before `setLoaded(true)`,
 * so "Loading measured progress…" stays on screen while the network request
 * is pending (bounded only by PROGRESS_REQUEST_TIMEOUT_MS = 15s) even though
 * both local reads have resolved. Also pins that a rejected fetch never
 * fails the load, and that the stale-focus guard (`active`) drops late
 * results after blur.
 */
import React from 'react';
import { Text } from 'react-native';
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
const mockFocus: { cleanup: (() => void) | void } = { cleanup: undefined };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => {
      mockFocus.cleanup = callback();
      return mockFocus.cleanup;
    }, [callback]);
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

jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: { profile: null }) => unknown) =>
    selector({ profile: null }),
}));

const mockRefreshConsistency = jest.fn(async () => {});
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: {
      snapshot: null;
      refresh: typeof mockRefreshConsistency;
    }) => unknown,
  ) => selector({ snapshot: null, refresh: mockRefreshConsistency }),
}));

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../../src/screens/ProgressScreen';

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const emptyProgress = {
  series: [],
  improving: [],
  needsAttention: [],
  streak: {
    currentDays: 0,
    longestDays: 0,
    practicedToday: false,
    lastPracticeDate: null,
  },
};

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

async function flush(rounds = 5) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('audit: Progress first paint vs canonical progress fetch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListRealAnalysisFacts.mockReset();
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockFetchCanonicalProgress.mockReset();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('keeps "Loading measured progress…" while /v1/progress is pending after both local reads resolved', async () => {
    mockGetApiSession.mockReturnValue(session);
    let resolveProgress!: (value: unknown) => void;
    mockFetchCanonicalProgress.mockReturnValue(
      new Promise(resolve => {
        resolveProgress = resolve;
      }),
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();

    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockListCaptureHistory).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Loading measured progress…');

    await act(async () => {
      resolveProgress(emptyProgress);
    });
    await flush();
    expect(allText(renderer)).not.toContain('Loading measured progress…');
    act(() => renderer.unmount());
  });

  it('a rejected canonical fetch is not a load failure', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    const text = allText(renderer);
    expect(text).not.toContain('Loading measured progress…');
    expect(text).not.toContain('could not be opened');
    act(() => renderer.unmount());
  });

  it('a failed local history read shows the honest error, never empty substitutes', async () => {
    mockListCaptureHistory.mockRejectedValue(new Error('sqlite locked'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    expect(allText(renderer)).toContain(
      'Your saved camera history could not be opened.',
    );
    act(() => renderer.unmount());
  });

  it('a load that settles after blur is dropped (no state written for a stale focus)', async () => {
    mockGetApiSession.mockReturnValue(session);
    let resolveProgress!: (value: unknown) => void;
    mockFetchCanonicalProgress.mockReturnValue(
      new Promise(resolve => {
        resolveProgress = resolve;
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    expect(allText(renderer)).toContain('Loading measured progress…');

    // Blur (focus cleanup) before the network settles.
    act(() => {
      if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup();
    });
    await act(async () => {
      resolveProgress(emptyProgress);
    });
    await flush();
    // The stale result must not flip `loaded` for a screen no longer focused.
    expect(allText(renderer)).toContain('Loading measured progress…');
    act(() => renderer.unmount());
  });
});
