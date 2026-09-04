/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * Reproduces the Home first-paint dependency on the network: `load()` awaits
 * `fetchCanonicalProgress` BEFORE `setLoaded(true)` runs in `finally`, so the
 * "Loading your court…" state stays on screen for as long as the request is
 * pending (up to PROGRESS_REQUEST_TIMEOUT_MS = 15s) even though every local
 * read (shots, facts, chart preference) has already resolved.
 *
 * Also pins the honest parts of the same path: a rejected canonical fetch
 * never fails the Home load, and a signed-out session never touches the
 * network.
 */
import React from 'react';
import { Text } from 'react-native';
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

  it('keeps "Loading your court…" up while /v1/progress is pending even though every local read resolved', async () => {
    mockGetApiSession.mockReturnValue(session);
    let resolveProgress!: (value: unknown) => void;
    mockFetchCanonicalProgress.mockReturnValue(
      new Promise(resolve => {
        resolveProgress = resolve;
      }),
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();

    // Local reads are done…
    expect(mockListShots).toHaveBeenCalledTimes(1);
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockGetKv).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    // …yet the screen is still the loading placeholder: first paint is gated
    // on the network round trip (bounded only by the 15s API deadline).
    expect(allText(renderer)).toContain('Loading your court…');

    await act(async () => {
      resolveProgress({
        series: [],
        improving: [],
        needsAttention: [],
        streak: {
          currentDays: 0,
          longestDays: 0,
          practicedToday: false,
          lastPracticeDate: null,
        },
      });
    });
    await flush();
    expect(allText(renderer)).not.toContain('Loading your court…');
    act(() => renderer.unmount());
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
