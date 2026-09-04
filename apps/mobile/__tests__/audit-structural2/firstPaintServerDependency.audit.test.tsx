/**
 * Structural audit #2 (pass 1) — does the OPTIONAL canonical progress request
 * gate the first paint of Home and Progress?
 *
 * Both screens describe `/v1/progress` as best-effort ("any fetch failure →
 * null, local data still renders"), yet both `await` it inside the same
 * load before `setLoaded(true)`. `fetchCanonicalProgress` has a 15 s
 * deadline (PROGRESS_REQUEST_TIMEOUT_MS), so a signed-in user on a slow or
 * black-holed network looks at the loading placeholder for up to 15 s even
 * though every local read already resolved. This suite resolves the local
 * SQLite reads immediately and leaves the server request pending, then asks
 * whether the local data is on screen.
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
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
const mockGetKv = jest.fn<Promise<string | null>, unknown[]>();
const mockSetKv = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
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

const mockAppState = {
  profile: null as {
    firstName?: string;
    skillLevel?: string;
    focusCheckpoint?: string;
  } | null,
};
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

const mockNotificationState = {
  hydrated: true,
  prefs: { enabled: false, promptDismissed: true },
  permission: 'unknown' as const,
  requestPermissionAndEnable: jest.fn(async () => true),
  dismissPrompt: jest.fn(async () => {}),
};
jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (
    selector: (s: typeof mockNotificationState) => unknown,
  ) => selector(mockNotificationState),
}));

import { HomeScreen } from '../../src/screens/HomeScreen';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import type { LocalShotRow, RealAnalysisFact } from '../../src/data/repository';

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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const shot: LocalShotRow = {
  id: 'shot-1',
  sessionId: null,
  shotType: 'third_shot_drop',
  capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
  overallScore: 6.4,
  confidence: 0.9,
  resultKind: 'scored',
  source: 'real',
  favorite: false,
};

const fact: RealAnalysisFact = {
  id: 'fact-1',
  shotType: 'third_shot_drop',
  capturedAt: shot.capturedAt,
  overallScore: 6.4,
  confidence: 0.9,
  resultKind: 'scored',
  scoringModelVersion: 'model-1',
  shotConfigVersion: 'config-1',
  sessionId: null,
  priorityCheckpoint: null,
  checkpointScores: {},
};

describe('audit: optional server progress must not gate the first paint', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListShots.mockReset();
    mockListRealAnalysisFacts.mockReset();
    mockListCaptureHistory.mockReset();
    mockGetKv.mockReset();
    mockSetKv.mockReset();
    mockFetchCanonicalProgress.mockReset();
    mockGetApiSession.mockReset();
    // Signed in: the canonical request is issued and never settles
    // (network black hole; the 15 s deadline has not elapsed yet).
    mockGetApiSession.mockReturnValue({ token: 'fake' });
    mockFetchCanonicalProgress.mockImplementation(
      () => new Promise<unknown>(() => {}),
    );
    mockListShots.mockResolvedValue([shot]);
    mockListRealAnalysisFacts.mockResolvedValue([fact]);
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetKv.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('Home shows the locally stored reads while /v1/progress is still pending', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    await flush();
    expect(mockListShots).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);

    const text = allText(renderer);
    // Local reads resolved: the home surface should be painted from them.
    expect(text).not.toContain('Loading your court…');
    expect(text).toContain('third shot drop');
    act(() => renderer.unmount());
  });

  it('Progress shows the locally stored reads while /v1/progress is still pending', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    await flush();
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);

    const text = allText(renderer);
    expect(text).not.toContain('Loading measured progress…');
    expect(text).toContain('KEY STATISTICS');
    act(() => renderer.unmount());
  });
});
