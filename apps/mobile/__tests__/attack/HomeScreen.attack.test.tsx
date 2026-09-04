/**
 * Adversarial pass (mobile-home-progress-library #1, pass 3) against
 * HomeScreen's load pipeline: a canonical payload missing `streak`, a kv
 * that rejects, pull-to-refresh racing the focus load, unmount mid-flight,
 * rapid repeats and late rejections. The real `progress/api` module runs
 * against a mocked `fetch` so the parse path is exercised end to end.
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

const mockGetDb = jest.fn<unknown, []>(() => ({ execute: jest.fn() }));
jest.mock('../../src/data/db', () => ({
  getDb: () => mockGetDb(),
}));

const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockGetKv = jest.fn<Promise<string | null>, unknown[]>();
const mockSetKv = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
}));

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

// `progress/api` is REAL here (fetch is mocked) unless a test overrides
// `mockCanonicalOverride` to bypass parsing and hand Home a raw object.
const mockCanonicalOverride: { impl: null | (() => Promise<unknown>) } = {
  impl: null,
};
jest.mock('../../src/progress/api', () => {
  const actual = jest.requireActual<typeof import('../../src/progress/api')>(
    '../../src/progress/api',
  );
  return {
    ...actual,
    fetchCanonicalProgress: (
      ...args: Parameters<typeof actual.fetchCanonicalProgress>
    ) =>
      mockCanonicalOverride.impl
        ? mockCanonicalOverride.impl()
        : actual.fetchCanonicalProgress(...args),
  };
});

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

const mockRefreshConsistency = jest.fn(async () => {});
const mockConsistencyState = {
  snapshot: null as { currentStreak: number; atRisk: boolean } | null,
  refresh: mockRefreshConsistency,
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
  prefs: { enabled: false, promptDismissed: false },
  permission: 'unknown' as 'unknown' | 'denied' | 'granted',
  requestPermissionAndEnable: jest.fn(async () => true),
  dismissPrompt: jest.fn(async () => {}),
};
jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (
    selector: (s: typeof mockNotificationState) => unknown,
  ) => selector(mockNotificationState),
}));

import { HomeScreen } from '../../src/screens/HomeScreen';
import type { LocalShotRow, RealAnalysisFact } from '../../src/data/repository';

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

const session = {
  apiBaseUrl: 'https://example.invalid',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'user-1',
};

function shot(overrides: Partial<LocalShotRow>): LocalShotRow {
  return {
    id: 'shot-1',
    sessionId: null,
    shotType: 'third_shot_drop',
    capturedAt: '2026-08-30T15:04:00.000Z',
    overallScore: 6.4,
    confidence: 0.9,
    resultKind: 'scored',
    source: 'real',
    favorite: false,
    ...overrides,
  };
}

function fact(
  hoursAgo: number,
  overrides: Partial<RealAnalysisFact> = {},
): RealAnalysisFact {
  return {
    id: `fact-${hoursAgo}`,
    shotType: 'forehand_drive',
    capturedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    overallScore: 3.7,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-1',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function renderHome(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<HomeScreen />);
  });
  return renderer;
}

async function flush(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function pressables(renderer: Renderer): Node[] {
  return renderer.root.findAll(
    n => typeof n.type === 'function' && n.type.name === 'Pressable',
  );
}

function pressableByTestId(renderer: Renderer, testID: string): Node | null {
  return pressables(renderer).find(n => n.props.testID === testID) ?? null;
}

function pressableByLabel(renderer: Renderer, label: string): Node | null {
  return (
    pressables(renderer).find(n => n.props.accessibilityLabel === label) ?? null
  );
}

function allText(renderer: Renderer): string {
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

function chartLabel(renderer: Renderer, testID: string): string | undefined {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  )[0]?.props.accessibilityLabel as string | undefined;
}

const ERROR_TITLE = 'Your court couldn’t load';
const ERROR_DETAIL =
  'Your saved reads could not be opened. Try again to load your real court history.';

function expectHomeContent(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).toContain('THIS WEEK');
  expect(text).not.toContain(ERROR_TITLE);
  expect(text).not.toContain(ERROR_DETAIL);
  expect(text).not.toContain('Loading your court…');
  expect(pressableByLabel(renderer, 'Try again')).toBeNull();
  expect(pressableByTestId(renderer, 'home-streak-badge')).not.toBeNull();
}

const realFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
// Jest runs on Node; the RN tsconfig has no node types, so reach the
// process event bus through globalThis with a minimal shape.
const nodeProcess = (
  globalThis as unknown as {
    process: {
      on(event: 'unhandledRejection', fn: (reason: unknown) => void): void;
      off(event: 'unhandledRejection', fn: (reason: unknown) => void): void;
    };
  }
).process;
let consoleError: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockNavigate.mockClear();
  mockGetDb.mockReset();
  mockGetDb.mockReturnValue({ execute: jest.fn() });
  mockListShots.mockReset();
  mockListShots.mockResolvedValue([]);
  mockListRealAnalysisFacts.mockReset();
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetKv.mockReset();
  mockGetKv.mockResolvedValue(null);
  mockSetKv.mockReset();
  mockSetKv.mockResolvedValue(undefined);
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(null);
  mockCanonicalOverride.impl = null;
  mockRefreshConsistency.mockClear();
  mockAppState.profile = null;
  mockConsistencyState.snapshot = null;
  mockFetch.mockReset();
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  unhandled.length = 0;
  nodeProcess.on('unhandledRejection', onUnhandled);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  nodeProcess.off('unhandledRejection', onUnhandled);
  (globalThis as { fetch: unknown }).fetch = realFetch;
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('S3 — canonical progress payload missing `streak`', () => {
  const seriesRow = {
    day: '2026-08-29',
    shot_type: 'dink',
    scoring_model_version: 'model-1',
    shot_count: 3,
    avg_score: 61,
    best_score: 72,
  };

  it('real parser rejects it; Home still renders and the week chart uses LOCAL reads', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockFetch.mockResolvedValue(
      jsonResponse({ series: [seriesRow], improving: [], needsAttention: [] }),
    );
    mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
    const renderer = await renderHome();
    await flush(3);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]![0])).toBe(
      'https://example.invalid/v1/progress',
    );
    expectHomeContent(renderer);
    // Local facts drive the week chart, never the canonical series.
    expect(chartLabel(renderer, 'score-dot-plot')).toBe(
      'Seven day technique scores: 1 scored read across 1 day, latest 3.7 out of 10.',
    );
    expect(allText(renderer)).toMatch(/1 scored read\b/);
    // The rejected canonical payload contributed nothing to the hero.
    expect(allText(renderer)).not.toContain('dink daily average');
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('a payload missing streak that BYPASSES the parser still renders (Home never reads streak)', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockCanonicalOverride.impl = async () => ({
      series: [
        {
          day: '2026-08-29',
          shotType: 'dink',
          scoringModelVersion: 'model-1',
          shotCount: 3,
          avgScore: 6.1,
          bestScore: 7.2,
        },
      ],
      improving: [],
      needsAttention: [],
    });
    mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
    const renderer = await renderHome();
    await flush(3);
    expectHomeContent(renderer);
    // With no local scored shot the hero falls back to the synced average.
    expect(allText(renderer)).toContain('dink daily average');
    expect(chartLabel(renderer, 'score-dot-plot')).toBe(
      'Seven day technique scores: 1 scored read across 1 day, latest 3.7 out of 10.',
    );
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('streak present but garbage (strings/NaN) is rejected by the parser; Home unaffected', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockFetch.mockResolvedValue(
      jsonResponse({
        series: [seriesRow],
        improving: [],
        needsAttention: [],
        streak: {
          currentDays: 'seven',
          longestDays: null,
          practicedToday: 'yes',
          lastPracticeDate: 42,
        },
      }),
    );
    const renderer = await renderHome();
    await flush(3);
    expectHomeContent(renderer);
    expect(allText(renderer)).not.toContain('dink daily average');
    act(() => renderer.unmount());
  });

  // FINDING (P2, pre-existing on main): load() awaits fetchCanonicalProgress
  // BEFORE `setLoaded(true)` runs in `finally` (HomeScreen.tsx:131-150), so
  // on first mount a signed-in Home shows "Loading your court…" until the
  // server answers or the 15s deadline aborts — even though every local
  // read already landed. `it.failing` documents the expected rule.
  it.failing(
    'local reads landed → Home must render while the canonical fetch is still pending (HomeScreen.tsx:131-150)',
    async () => {
      mockGetApiSession.mockReturnValue(session);
      mockFetch.mockImplementation(() => new Promise<Response>(() => {}));
      mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
      const renderer = await renderHome();
      await flush(5);
      expect(mockListShots).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expectHomeContent(renderer);
      act(() => renderer.unmount());
    },
  );

  it('documents the finding: a hanging canonical fetch pins Home on the spinner until the 15s abort', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
    const renderer = await renderHome();
    await flush(5);
    // Local reads are done, the canonical request is in flight…
    expect(mockListShots).toHaveBeenCalledTimes(1);
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // …and the user still sees the spinner.
    const text = allText(renderer);
    console.info(`[attack][finding] Home while canonical pending: "${text}"`);
    expect(text).toContain('Loading your court…');
    expect(text).not.toContain('THIS WEEK');
    // 14.999s later: still the spinner.
    await act(async () => {
      jest.advanceTimersByTime(14_999);
    });
    await flush(3);
    expect(allText(renderer)).toContain('Loading your court…');
    // The deadline abort finally releases the page, local-only.
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await flush(5);
    expectHomeContent(renderer);
    expect(chartLabel(renderer, 'score-dot-plot')).toBe(
      'Seven day technique scores: 1 scored read across 1 day, latest 3.7 out of 10.',
    );
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('the same hang on pull-to-refresh keeps the spinner up until the abort (page stays usable)', async () => {
    const renderer = await renderHome();
    mockGetApiSession.mockReturnValue(session);
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const control = () => renderer.root.findByType(RefreshControl);
    await act(async () => {
      control().props.onRefresh();
    });
    await flush(5);
    expect(control().props.refreshing).toBe(true);
    expectHomeContent(renderer);
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await flush(5);
    expect(control().props.refreshing).toBe(false);
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('a 500 / non-JSON body / rejected fetch all degrade to local-only Home', async () => {
    mockGetApiSession.mockReturnValue(session);
    for (const response of [
      () => Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('bad json')),
        } as unknown as Response),
      () => Promise.reject(new TypeError('Network request failed')),
    ]) {
      mockFetch.mockReset();
      mockFetch.mockImplementation(response);
      const renderer = await renderHome();
      await flush(3);
      expectHomeContent(renderer);
      act(() => renderer.unmount());
    }
    expect(unhandled).toEqual([]);
  });
});

describe('S4 — getKv rejects with Error("locked") while shots resolve', () => {
  it('renders content on the "scores" lens with no error copy', async () => {
    mockGetKv.mockRejectedValue(new Error('locked'));
    mockListShots.mockResolvedValue([shot({ id: 's1', shotType: 'dink' })]);
    mockListRealAnalysisFacts.mockResolvedValue([fact(3)]);
    const renderer = await renderHome();
    await flush(2);
    expectHomeContent(renderer);
    const scoresTab = pressableByTestId(renderer, 'home-week-chart-scores')!;
    const readsTab = pressableByTestId(renderer, 'home-week-chart-reads')!;
    expect(scoresTab.props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(readsTab.props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(chartLabel(renderer, 'score-dot-plot')).toBeDefined();
    expect(chartLabel(renderer, 'practice-volume-chart')).toBeUndefined();
    expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('getKv that THROWS synchronously (not a rejection) is still not fatal', async () => {
    mockGetKv.mockImplementation(() => {
      throw new Error('locked');
    });
    const renderer = await renderHome();
    await flush(2);
    // A synchronous throw inside Promise.all's argument list is not
    // caught by `.catch(() => null)`; it propagates to load()'s try/catch
    // and becomes the recoverable error state (never a crash). The real
    // getKv is `async` so this path is unreachable in the app — pinned so a
    // future non-async getKv cannot silently take Home down.
    const text = allText(renderer);
    expect(text).toContain(ERROR_TITLE);
    expect(pressableByLabel(renderer, 'Try again')).not.toBeNull();
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('a kv returning junk ("READS", "reads ", unicode, 10k chars) always lands on a valid lens', async () => {
    for (const junk of [
      'READS',
      'reads ',
      '読み',
      'x'.repeat(10_000),
      '0',
      'null',
    ]) {
      mockGetKv.mockResolvedValue(junk);
      const renderer = await renderHome();
      await flush(2);
      expectHomeContent(renderer);
      expect(
        pressableByTestId(renderer, 'home-week-chart-scores')!.props
          .accessibilityState,
      ).toMatchObject({ selected: true });
      act(() => renderer.unmount());
    }
  });

  it('selecting a lens while setKv rejects keeps the lens and surfaces no error', async () => {
    mockSetKv.mockRejectedValue(new Error('locked'));
    mockListRealAnalysisFacts.mockResolvedValue([fact(1)]);
    const renderer = await renderHome();
    await act(async () => {
      pressableByTestId(renderer, 'home-week-chart-reads')!.props.onPress();
    });
    await flush(2);
    expect(
      pressableByTestId(renderer, 'home-week-chart-reads')!.props
        .accessibilityState,
    ).toMatchObject({ selected: true });
    expectHomeContent(renderer);
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('getDb throwing on the lens write (no database) is swallowed', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([fact(1)]);
    const renderer = await renderHome();
    mockGetDb.mockImplementation(() => {
      throw new Error('db closed');
    });
    await act(async () => {
      pressableByTestId(renderer, 'home-week-chart-reads')!.props.onPress();
    });
    expect(
      pressableByTestId(renderer, 'home-week-chart-reads')!.props
        .accessibilityState,
    ).toMatchObject({ selected: true });
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });
});

describe('S5 — pull-to-refresh while the focus load() is pending', () => {
  function gatedShots() {
    const gates: Array<{
      resolve: (rows: unknown[]) => void;
      reject: (err: Error) => void;
    }> = [];
    mockListShots.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          gates.push({ resolve, reject });
        }),
    );
    return gates;
  }

  it('focus load resolves AFTER the refresh load: one final state, refreshing false', async () => {
    const gates = gatedShots();
    const renderer = await renderHome();
    // Still loading — the RefreshControl is not even mounted yet.
    expect(allText(renderer)).toContain('Loading your court…');
    expect(gates).toHaveLength(1);

    // Release the focus load so the page mounts, then gate the next two.
    await act(async () => {
      gates[0]!.resolve([]);
    });
    await flush(2);
    // A second focus (tab switch) starts a load that stays pending…
    // (simulated by directly invoking the RefreshControl twice: first as a
    // stand-in for the pending focus load, second as the user's pull).
    const control = () => renderer.root.findByType(RefreshControl);
    await act(async () => {
      control().props.onRefresh();
    });
    expect(gates).toHaveLength(2);
    await act(async () => {
      control().props.onRefresh();
    });
    expect(gates).toHaveLength(3);
    expect(control().props.refreshing).toBe(true);

    // Newer load lands first with the newer data…
    await act(async () => {
      gates[2]!.resolve([shot({ id: 'new', shotType: 'dink' })]);
    });
    await flush(3);
    // …then the older one lands with STALE data. Home has no sequencing
    // guard, so the stale result wins the screen (documented below).
    await act(async () => {
      gates[1]!.resolve([shot({ id: 'old', shotType: 'lob' })]);
    });
    await flush(3);

    expect(control().props.refreshing).toBe(false);
    expectHomeContent(renderer);
    const settledText = allText(renderer);
    const settledLabels = pressables(renderer).map(
      n => n.props.accessibilityLabel,
    );
    await flush(3);
    expect(allText(renderer)).toBe(settledText);
    expect(pressables(renderer).map(n => n.props.accessibilityLabel)).toEqual(
      settledLabels,
    );
    const showsOld = pressableByLabel(renderer, 'Open lob result') !== null;
    const showsNew = pressableByLabel(renderer, 'Open dink result') !== null;
    console.info(
      `[attack] overlapping loads settled showing old=${showsOld} new=${showsNew}`,
    );
    // Exactly one of the two datasets is on screen (a single final state).
    expect(showsOld !== showsNew).toBe(true);
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  // FINDING (P3, pre-existing on main): load() has no sequence guard, so
  // when two loads overlap the LAST TO RESOLVE wins, not the last started.
  // A pull-to-refresh that returns before a slow earlier load therefore
  // shows the earlier (stale) rows. `it.failing` documents the rule.
  it.failing(
    'the LATEST started load must win the screen, not the last to resolve (HomeScreen.tsx:110-151)',
    async () => {
      const gates = gatedShots();
      const renderer = await renderHome();
      await act(async () => {
        gates[0]!.resolve([]);
      });
      await flush(2);
      const control = () => renderer.root.findByType(RefreshControl);
      await act(async () => {
        control().props.onRefresh();
      });
      await act(async () => {
        control().props.onRefresh();
      });
      await act(async () => {
        gates[2]!.resolve([shot({ id: 'new', shotType: 'dink' })]);
      });
      await flush(3);
      await act(async () => {
        gates[1]!.resolve([shot({ id: 'old', shotType: 'lob' })]);
      });
      await flush(3);
      expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
      expect(pressableByLabel(renderer, 'Open lob result')).toBeNull();
      act(() => renderer.unmount());
    },
  );

  it('pull-to-refresh during the INITIAL focus load: control is not mounted, so pull is impossible; load still settles', async () => {
    const gates = gatedShots();
    const renderer = await renderHome();
    expect(renderer.root.findAllByType(RefreshControl)).toHaveLength(0);
    await act(async () => {
      gates[0]!.resolve([shot({ id: 'a', shotType: 'dink' })]);
    });
    await flush(2);
    expectHomeContent(renderer);
    expect(renderer.root.findByType(RefreshControl).props.refreshing).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('refresh whose load REJECTS still clears refreshing and shows the error state (no spinner)', async () => {
    const renderer = await renderHome();
    mockListShots.mockRejectedValueOnce(new Error('sqlite busy'));
    await act(async () => {
      renderer.root.findByType(RefreshControl).props.onRefresh();
    });
    await flush(3);
    const text = allText(renderer);
    expect(text).toContain(ERROR_TITLE);
    expect(text).not.toContain('Loading your court…');
    expect(renderer.root.findAllByType(RefreshControl)).toHaveLength(0);
    expect(unhandled).toEqual([]);
    // Try again restores the page.
    mockListShots.mockResolvedValue([]);
    await act(async () => {
      pressableByLabel(renderer, 'Try again')!.props.onPress();
    });
    await flush(3);
    expectHomeContent(renderer);
    expect(renderer.root.findByType(RefreshControl).props.refreshing).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('20 rapid pulls resolve to one settled page, refreshing false, 21 shot reads', async () => {
    const renderer = await renderHome();
    const control = () => renderer.root.findByType(RefreshControl);
    await act(async () => {
      for (let i = 0; i < 20; i += 1) control().props.onRefresh();
    });
    await flush(4);
    expect(mockListShots).toHaveBeenCalledTimes(21);
    expect(control().props.refreshing).toBe(false);
    expectHomeContent(renderer);
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });
});

describe('S6 — unmount while listShots is pending', () => {
  it('no unmounted-update warning, no unhandled rejection, late resolve is inert', async () => {
    let release!: (rows: unknown[]) => void;
    mockListShots.mockImplementation(
      () =>
        new Promise<unknown[]>(resolve => {
          release = resolve;
        }),
    );
    const renderer = await renderHome();
    expect(allText(renderer)).toContain('Loading your court…');
    act(() => renderer.unmount());
    await act(async () => {
      release([shot({ id: 'late', shotType: 'dink' })]);
    });
    await flush(3);
    expect(renderer.toJSON()).toBeNull();
    expect(unhandled).toEqual([]);
    const warnings = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
      .map(call => call.map(String).join(' '))
      .filter(msg => /unmounted|not wrapped in act|memory leak/i.test(msg));
    expect(warnings).toEqual([]);
  });

  it('unmount while listShots is pending and it later REJECTS: still silent', async () => {
    let fail!: (err: Error) => void;
    mockListShots.mockImplementation(
      () =>
        new Promise<unknown[]>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const renderer = await renderHome();
    act(() => renderer.unmount());
    await act(async () => {
      fail(new Error('sqlite closed after unmount'));
    });
    await flush(3);
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('unmount while the CANONICAL fetch is pending (local data landed): silent', async () => {
    mockGetApiSession.mockReturnValue(session);
    let settle!: (r: Response) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          settle = resolve;
        }),
    );
    const renderer = await renderHome();
    await flush(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await act(async () => {
      settle(
        jsonResponse({
          series: [],
          improving: [],
          needsAttention: [],
          streak: {
            currentDays: 1,
            longestDays: 1,
            practicedToday: true,
            lastPracticeDate: '2026-08-30',
          },
        }),
      );
    });
    await flush(3);
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('unmount mid-refresh: refreshing flag update after unmount is inert', async () => {
    const renderer = await renderHome();
    let release!: (rows: unknown[]) => void;
    mockListShots.mockImplementationOnce(
      () =>
        new Promise<unknown[]>(resolve => {
          release = resolve;
        }),
    );
    await act(async () => {
      renderer.root.findByType(RefreshControl).props.onRefresh();
    });
    act(() => renderer.unmount());
    await act(async () => {
      release([]);
    });
    await flush(3);
    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
