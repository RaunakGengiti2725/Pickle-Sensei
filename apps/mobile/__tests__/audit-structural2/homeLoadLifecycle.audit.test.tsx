/**
 * Structural audit #2 (pass 1) — HomeScreen load() lifecycle.
 *
 * `load()` has no active/unmount guard and no sequencing between the focus
 * load and pull-to-refresh. Two questions: (1) does a load that settles
 * after unmount throw or log? (2) when a focus load and a pull-to-refresh
 * overlap and the OLDER read settles LAST, does the screen keep the newest
 * data or does last-writer-wins roll it back?
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
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
  listCaptureHistory: async () => [],
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: async () => undefined,
}));

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: async () => null,
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

jest.mock('../../src/consistency/store', () => {
  const state = { snapshot: null, refresh: jest.fn(async () => {}) };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function shotRow(
  id: string,
  shotType: string,
  minutesAgo: number,
): LocalShotRow {
  return {
    id,
    sessionId: null,
    shotType,
    capturedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    overallScore: 6.4,
    confidence: 0.9,
    resultKind: 'scored',
    source: 'real',
    favorite: false,
  };
}

function factFor(row: LocalShotRow): RealAnalysisFact {
  return {
    id: `fact-${row.id}`,
    shotType: row.shotType,
    capturedAt: row.capturedAt,
    overallScore: row.overallScore,
    confidence: row.confidence,
    resultKind: 'scored',
    scoringModelVersion: 'model-1',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

describe('audit: HomeScreen load lifecycle', () => {
  beforeEach(() => {
    mockListShots.mockReset();
    mockListRealAnalysisFacts.mockReset();
    mockGetKv.mockReset();
    mockGetKv.mockResolvedValue(null);
    mockListRealAnalysisFacts.mockResolvedValue([]);
  });

  it('a load that settles after unmount neither throws nor logs a React error', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pending = deferred<unknown[]>();
    mockListShots.mockReturnValue(pending.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    expect(allText(renderer)).toContain('Loading your court…');
    act(() => renderer.unmount());
    await act(async () => {
      pending.resolve([shotRow('late', 'dink', 5)]);
    });
    await flush();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('when a focus load and a pull-to-refresh overlap, the newest read wins even if the older one settles last', async () => {
    const older = shotRow('older', 'dink', 60);
    const newer = shotRow('newer', 'third_shot_drop', 1);
    const firstRead = deferred<unknown[]>();
    // Focus load: slow read that will return only the older row.
    mockListShots.mockReturnValueOnce(firstRead.promise);
    mockListRealAnalysisFacts.mockResolvedValueOnce([factFor(older)]);
    // Pull-to-refresh: fast read, sees the newer row too.
    mockListShots.mockResolvedValueOnce([newer, older]);
    mockListRealAnalysisFacts.mockResolvedValueOnce([
      factFor(newer),
      factFor(older),
    ]);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    // The first paint needs SOME loaded state to expose the RefreshControl;
    // let the focus load's read settle later, but first get the screen out
    // of the loading placeholder via a third resolved read? No — the screen
    // only paints once load() completes, so drive the refresh from the
    // second read by resolving the focus read now and re-triggering.
    firstRead.resolve([older]);
    await flush();
    expect(allText(renderer)).toContain('dink');

    // Second overlap: a fresh focus load (slow, older data) races a
    // pull-to-refresh (fast, newer data).
    const slowRead = deferred<unknown[]>();
    mockListShots.mockReturnValueOnce(slowRead.promise);
    mockListRealAnalysisFacts.mockResolvedValueOnce([factFor(older)]);
    mockListShots.mockResolvedValueOnce([newer, older]);
    mockListRealAnalysisFacts.mockResolvedValueOnce([
      factFor(newer),
      factFor(older),
    ]);
    const refreshControl = renderer.root.findByType(RefreshControl);
    // Kick a focus-style load by re-invoking through the refresh control
    // twice: the first call takes the slow read, the second the fast one.
    await act(async () => {
      refreshControl.props.onRefresh();
    });
    await act(async () => {
      refreshControl.props.onRefresh();
    });
    await flush();
    expect(allText(renderer)).toContain('third shot drop');

    await act(async () => {
      slowRead.resolve([older]);
    });
    await flush();
    // The stale (older) read settled last; the newest data must still win.
    expect(allText(renderer)).toContain('third shot drop');
    act(() => renderer.unmount());
  });
});
