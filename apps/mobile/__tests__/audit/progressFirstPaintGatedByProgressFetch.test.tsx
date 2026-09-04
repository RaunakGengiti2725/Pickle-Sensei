/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * ProgressScreen's focus load marks the screen loaded as soon as both local
 * reads (facts, captures) resolve; the optional `/v1/progress` fetch hydrates
 * the account series whenever it lands (bounded only by
 * PROGRESS_REQUEST_TIMEOUT_MS = 15s) and never holds "Loading measured
 * progress…" on screen. Also pins that a rejected fetch never fails the load,
 * and that the stale-focus guard (`active`) drops late results after blur.
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
const mockFocus: {
  cleanup: (() => void) | void;
  /** The latest focus callback, so a test can replay a refocus. */
  refocus: (() => void | (() => void)) | undefined;
} = { cleanup: undefined, refocus: undefined };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    mockFocus.refocus = callback;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

/** A canonical response whose only series row is one daily average. */
function progressWith(shotType: string, avgScore: number) {
  return {
    ...emptyProgress,
    series: [
      {
        day: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
        shotType,
        scoringModelVersion: 'model-2',
        shotCount: 3,
        avgScore,
        bestScore: avgScore,
      },
    ],
  };
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

  it('paints the local dashboard while /v1/progress is still pending, then hydrates the account series when it lands', async () => {
    mockGetApiSession.mockReturnValue(session);
    const progress = deferred<unknown>();
    mockFetchCanonicalProgress.mockReturnValue(progress.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();

    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockListCaptureHistory).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    const painted = allText(renderer);
    expect(painted).not.toContain('Loading measured progress…');
    expect(painted).toContain('KEY STATISTICS');
    expect(painted).not.toContain('daily average');

    await act(async () => {
      progress.resolve(progressWith('dink', 6.8));
    });
    await flush();
    const hydrated = allText(renderer);
    expect(hydrated).not.toContain('Loading measured progress…');
    expect(hydrated).toContain('dink daily average');
    expect(hydrated).toContain('6.8');
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
    const facts = deferred<unknown[]>();
    mockListRealAnalysisFacts.mockReturnValue(facts.promise);
    const progress = deferred<unknown>();
    mockFetchCanonicalProgress.mockReturnValue(progress.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    expect(allText(renderer)).toContain('Loading measured progress…');

    // Blur (focus cleanup) before either the local read or the network
    // settles.
    act(() => {
      if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup();
    });
    await act(async () => {
      facts.resolve([]);
      progress.resolve(progressWith('dink', 6.8));
    });
    await flush();
    // The stale results must not flip `loaded` nor hydrate the account
    // series for a screen no longer focused.
    const text = allText(renderer);
    expect(text).toContain('Loading measured progress…');
    expect(text).not.toContain('dink daily average');
    act(() => renderer.unmount());
  });

  it('a canonical fetch that settles after blur, once a newer focus load painted, never overwrites the newer series', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockFetchCanonicalProgress
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    expect(allText(renderer)).not.toContain('Loading measured progress…');

    // Blur, then refocus: the focus effect runs a newer load.
    act(() => {
      if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup();
    });
    await act(async () => {
      mockFocus.cleanup = mockFocus.refocus?.();
    });
    await flush();
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(progressWith('dink', 6.8));
    });
    await flush();
    expect(allText(renderer)).toContain('dink daily average');

    // The OLDER fetch settles last with different numbers: dropped.
    await act(async () => {
      first.resolve(progressWith('serve', 5.5));
    });
    await flush();
    const text = allText(renderer);
    expect(text).toContain('dink daily average');
    expect(text).toContain('6.8');
    expect(text).not.toContain('serve daily average');
    expect(text).not.toContain('5.5');
    act(() => renderer.unmount());
  });
});
