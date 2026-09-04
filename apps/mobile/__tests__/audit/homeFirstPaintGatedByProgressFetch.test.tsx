/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * Home's first paint must never wait on the network: `load()` marks the
 * screen loaded as soon as the local reads (shots, facts, chart preference)
 * resolve, while the optional `/v1/progress` fetch hydrates the synced numbers
 * whenever it arrives (bounded only by PROGRESS_REQUEST_TIMEOUT_MS = 15s).
 *
 * Also pins the honest parts of the same path: a rejected canonical fetch
 * never fails the Home load, a signed-out session never touches the network,
 * and a canonical result that settles after a newer load (or after unmount)
 * never writes stale account data over the newest one.
 */
import React from 'react';
import { RefreshControl, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

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

jest.mock('../../src/data/db', () => ({
  getDb: () => ({ execute: jest.fn() }),
}));

const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockGetKv = jest.fn<Promise<string | null>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: jest.fn(async () => {}),
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

jest.mock('../../src/notifications/notificationStore', () => {
  const state = {
    hydrated: true,
    prefs: { enabled: false, promptDismissed: true },
    permission: 'unknown',
    requestPermissionAndEnable: jest.fn(async () => true),
    dismissPrompt: jest.fn(async () => {}),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { HomeScreen } from '../../src/screens/HomeScreen';

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const emptyStreak = {
  currentDays: 0,
  longestDays: 0,
  practicedToday: false,
  lastPracticeDate: null,
};

/** A canonical response whose only series row is one daily average. */
function progressWith(shotType: string, avgScore: number) {
  return {
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
    improving: [],
    needsAttention: [],
    streak: emptyStreak,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

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

describe('audit: Home first paint vs canonical progress fetch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListShots.mockReset();
    mockListShots.mockResolvedValue([]);
    mockListRealAnalysisFacts.mockReset();
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockGetKv.mockReset();
    mockGetKv.mockResolvedValue(null);
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

  it('paints the local court while /v1/progress is still pending, then hydrates the synced series when it lands', async () => {
    mockGetApiSession.mockReturnValue(session);
    const progress = deferred<unknown>();
    mockFetchCanonicalProgress.mockReturnValue(progress.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();

    // Local reads are done and the network request is in flight…
    expect(mockListShots).toHaveBeenCalledTimes(1);
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockGetKv).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    // …and the court is already painted from the local reads.
    const painted = allText(renderer);
    expect(painted).not.toContain('Loading your court…');
    expect(painted).toContain('No scored technique yet');
    expect(painted).not.toContain('daily average');

    await act(async () => {
      progress.resolve(progressWith('dink', 6.8));
    });
    await flush();
    const hydrated = allText(renderer);
    expect(hydrated).toContain('dink daily average');
    expect(hydrated).toContain('6.8');
    act(() => renderer.unmount());
  });

  it('a canonical fetch that settles after a newer load never overwrites the newer result', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockFetchCanonicalProgress
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();
    expect(allText(renderer)).not.toContain('Loading your court…');

    // Pull-to-refresh starts a newer load while the first fetch is in flight.
    const [refreshControl] = renderer.root.findAllByType(RefreshControl);
    await act(async () => {
      refreshControl!.props.onRefresh();
    });
    await flush();
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(progressWith('dink', 6.8));
    });
    await flush();
    expect(allText(renderer)).toContain('dink daily average');
    expect(allText(renderer)).toContain('6.8');

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

  it('a canonical fetch that settles after unmount is dropped without an error', async () => {
    mockGetApiSession.mockReturnValue(session);
    const progress = deferred<unknown>();
    mockFetchCanonicalProgress.mockReturnValue(progress.promise);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();
    act(() => renderer.unmount());

    await act(async () => {
      progress.resolve(progressWith('dink', 6.8));
    });
    await flush();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a rejected canonical fetch does not fail the Home load (local data still shows)', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();

    const text = allText(renderer);
    expect(text).not.toContain('Loading your court…');
    expect(text).not.toContain('Your court couldn’t load');
    act(() => renderer.unmount());
  });

  it('never calls the progress API without an API session', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();
    expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
    expect(allText(renderer)).not.toContain('Loading your court…');
    act(() => renderer.unmount());
  });

  it('a rejected chart-preference read is not a load failure (defaults to scores)', async () => {
    mockGetKv.mockRejectedValue(new Error('kv unreadable'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();
    const text = allText(renderer);
    expect(text).not.toContain('Your court couldn’t load');
    expect(text).not.toContain('Loading your court…');
    act(() => renderer.unmount());
  });
});
