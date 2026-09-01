/**
 * Home screen driven as a user would: loading → content, load failure →
 * honest error + Try again that actually recovers, every pressable card and
 * chip with its navigation target/params and accessibility props, the rank
 * banner toggling IN PLACE (never navigating) while its streak block routes
 * to the StreakCalendar, and the notification priming card's two actions.
 */
import React from 'react';
import { RefreshControl, Text } from 'react-native';
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
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
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

const mockFetchPlayerRank = jest.fn<Promise<null>, unknown[]>(async () => null);
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (...args: unknown[]) => mockFetchPlayerRank(...args),
  };
});

const mockAppState = {
  profile: null as {
    skillLevel?: string;
    firstName?: string;
    focusCheckpoint?: string;
  } | null,
};
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockConsistencyState = {
  snapshot: null as { currentStreak: number; atRisk: boolean } | null,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

const mockMaybeCelebrate = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('../../src/progress/rankCelebration', () => {
  const state = {
    maybeCelebrate: (...args: unknown[]) => mockMaybeCelebrate(...args),
  };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

const mockNotificationState = {
  hydrated: true,
  prefs: { enabled: false, promptDismissed: true },
  permission: 'unknown' as string,
  requestPermissionAndEnable: jest.fn(async () => false),
  dismissPrompt: jest.fn(async () => {}),
};
jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (
    selector: (s: typeof mockNotificationState) => unknown,
  ) => selector(mockNotificationState),
}));

import { HomeScreen } from '../../src/screens/HomeScreen';
import type { LocalShotRow } from '../../src/data/repository';
import { hasWalkthroughTarget } from '../../src/walkthrough/targets';

function shot(overrides: Partial<LocalShotRow>): LocalShotRow {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    sessionId: null,
    shotType: 'forehand_drive',
    capturedAt: '2026-08-30T10:00:00.000Z',
    overallScore: 6.4,
    confidence: 0.9,
    resultKind: 'scored',
    source: 'real',
    favorite: false,
    ...overrides,
  };
}

async function renderHome() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<HomeScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ');
}

function hostNodes(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n));
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  // Deepest composite carrying the handler (the Pressable itself, after
  // PressableScale has applied its default accessibilityRole).
  const node = renderer.root
    .findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )
    .at(-1);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function pressableByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = renderer.root
    .findAll(
      n => n.props.testID === testID && typeof n.props.onPress === 'function',
    )
    .at(-1);
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockMaybeCelebrate.mockClear();
  mockFetchPlayerRank.mockClear();
  mockFetchCanonicalProgress.mockReset();
  mockGetApiSession.mockReset().mockReturnValue(null);
  mockListShots.mockReset().mockResolvedValue([]);
  mockListCaptureHistory.mockReset().mockResolvedValue([]);
  mockAppState.profile = null;
  mockConsistencyState.snapshot = null;
  mockConsistencyState.refresh.mockClear();
  mockNotificationState.prefs = { enabled: false, promptDismissed: true };
  mockNotificationState.permission = 'unknown';
  mockNotificationState.requestPermissionAndEnable.mockClear();
  mockNotificationState.dismissPrompt.mockClear();
});

describe('Home — loading and failure', () => {
  it('shows a labeled loading state until the local reads resolve, then the court', async () => {
    let resolveShots!: (rows: LocalShotRow[]) => void;
    mockListShots.mockReturnValue(
      new Promise<LocalShotRow[]>(resolve => {
        resolveShots = resolve;
      }),
    );
    const renderer = await renderHome();
    expect(allText(renderer)).toContain('Loading your court…');
    expect(
      hostNodes(
        renderer,
        n =>
          n.props.accessibilityLabel ===
          'Loading your court…. Keep Pickle Sensei open.',
      ),
    ).toHaveLength(1);
    expect(mockConsistencyState.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveShots([]);
    });
    const copy = allText(renderer);
    expect(copy).not.toContain('Loading your court…');
    expect(copy).toContain('Ready when you are.');
    expect(copy).toContain('NEW PLAYER');
    act(() => renderer.unmount());
  });

  it('a failed read shows honest error copy with Try again, and retry recovers to content', async () => {
    mockListShots.mockRejectedValueOnce(new Error('sqlite locked'));
    const renderer = await renderHome();

    const copy = allText(renderer);
    expect(copy).toContain('Your court couldn’t load');
    expect(copy).toContain(
      'Your saved reads could not be opened. Try again to load your real court history.',
    );
    expect(copy).not.toContain('Loading your court…');
    expect(
      hostNodes(renderer, n => n.props.accessibilityRole === 'alert'),
    ).toHaveLength(1);

    mockListShots.mockResolvedValueOnce([shot({})]);
    await press(pressableByLabel(renderer, 'Try again'));
    const recovered = allText(renderer);
    expect(recovered).not.toContain('Your court couldn’t load');
    expect(recovered).toContain('Recent reads');
    expect(recovered).toMatch(/1\s+latest/);
    act(() => renderer.unmount());
  });

  it('a synced-progress failure never blocks the court (device data still renders)', async () => {
    mockGetApiSession.mockReturnValue({ token: 't' });
    mockFetchCanonicalProgress.mockRejectedValue(new Error('503'));
    mockListShots.mockResolvedValue([shot({})]);
    const renderer = await renderHome();
    const copy = allText(renderer);
    expect(copy).not.toContain('Your court couldn’t load');
    expect(copy).toContain('Latest validated scored stroke on this device');
    expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('pull-to-refresh reloads and clears the spinner even when the reload fails', async () => {
    const renderer = await renderHome();
    const control = () => renderer.root.findByType(RefreshControl);
    expect(control().props.refreshing).toBe(false);

    mockListShots.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      control().props.onRefresh();
    });
    // Failure surfaces as the error state (not a stuck spinner) and the
    // refreshing flag was released.
    expect(allText(renderer)).toContain('Your court couldn’t load');
    expect(mockListShots).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});

describe('Home — controls', () => {
  it('top-bar streak chip: role button, streak-count label, routes to StreakCalendar', async () => {
    mockConsistencyState.snapshot = { currentStreak: 3, atRisk: false };
    const renderer = await renderHome();
    const chip = pressableByTestId(renderer, 'home-streak-badge');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityLabel).toBe(
      '3 days training streak. Opens the consistency calendar.',
    );
    await press(chip);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('streak chip pluralizes a single day and shows 0 for no streak', async () => {
    mockConsistencyState.snapshot = { currentStreak: 1, atRisk: true };
    let renderer = await renderHome();
    expect(
      pressableByTestId(renderer, 'home-streak-badge').props.accessibilityLabel,
    ).toBe('1 day training streak. Opens the consistency calendar.');
    act(() => renderer.unmount());

    mockConsistencyState.snapshot = null;
    renderer = await renderHome();
    expect(
      pressableByTestId(renderer, 'home-streak-badge').props.accessibilityLabel,
    ).toBe('0 days training streak. Opens the consistency calendar.');
    act(() => renderer.unmount());
  });

  it('rank banner toggles in place (expanded state flips, no navigation) and registers the walkthrough anchor', async () => {
    const renderer = await renderHome();
    expect(hasWalkthroughTarget('rank-banner')).toBe(true);
    const toggle = () =>
      pressableByTestId(renderer, 'player-rank-banner-toggle');
    expect(toggle().props.accessibilityRole).toBe('button');
    expect(toggle().props.accessibilityState).toEqual({ expanded: false });
    expect(toggle().props.accessibilityLabel).toBe(
      'Player rank: unranked. Your first scored analysis places you.',
    );
    expect(toggle().props.accessibilityHint).toBe(
      'Opens the rank details in place.',
    );

    await press(toggle());
    expect(toggle().props.accessibilityState).toEqual({ expanded: true });
    expect(toggle().props.accessibilityHint).toBe(
      'Collapses the rank details.',
    );
    expect(allText(renderer)).toContain('Bronze → Silver → Gold');

    await press(toggle());
    expect(toggle().props.accessibilityState).toEqual({ expanded: false });
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
    expect(hasWalkthroughTarget('rank-banner')).toBe(false);
  });

  it('rank banner reports a resolved rank to the celebration store (owner-scoped ceremony hook)', async () => {
    mockListShots.mockResolvedValue([shot({ overallScore: 5.5 })]);
    const renderer = await renderHome();
    expect(mockMaybeCelebrate).toHaveBeenCalled();
    const summary = mockMaybeCelebrate.mock.calls.at(-1)?.[0] as
      { tier: string } | undefined;
    expect(summary?.tier).toBe('gold');
    expect(
      pressableByTestId(renderer, 'player-rank-banner-toggle').props
        .accessibilityLabel,
    ).toContain('Player rank Gold');
    act(() => renderer.unmount());
  });

  it('banner streak block is a separate button routing to StreakCalendar, with at-risk copy', async () => {
    mockConsistencyState.snapshot = { currentStreak: 4, atRisk: true };
    const renderer = await renderHome();
    const block = pressableByTestId(renderer, 'player-rank-banner-streak');
    expect(block.props.accessibilityRole).toBe('button');
    expect(block.props.disabled).toBe(false);
    expect(block.props.accessibilityLabel).toBe(
      '4 days training streak, at risk — no training yet today. Opens the consistency calendar.',
    );
    await press(block);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    // The banner itself stayed collapsed — the streak press is not a toggle.
    expect(
      pressableByTestId(renderer, 'player-rank-banner-toggle').props
        .accessibilityState,
    ).toEqual({ expanded: false });
    act(() => renderer.unmount());
  });

  it('Stroke Analysis card is the primary CTA → Analyze with source camera', async () => {
    const renderer = await renderHome();
    const card = pressableByLabel(
      renderer,
      'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
    );
    expect(card.props.accessibilityRole).toBe('button');
    await press(card);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Analyze', { source: 'camera' });
    act(() => renderer.unmount());
  });

  it('Drill Library card → DrillLibrary (no params)', async () => {
    const renderer = await renderHome();
    const card = pressableByLabel(
      renderer,
      'Drill Library. Guided drills you can search.',
    );
    expect(card.props.accessibilityRole).toBe('button');
    await press(card);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('empty court is honest and non-dead-end (no placeholder numbers)', async () => {
    const renderer = await renderHome();
    const copy = allText(renderer);
    expect(copy).toContain('Your court is ready.');
    expect(copy).toContain('The first verified capture starts this record.');
    expect(copy).toContain('No scored technique yet');
    expect(copy).toContain(
      'Camera practice still counts. Scores appear only after validated analysis.',
    );
    expect(copy).toContain('—');
    expect(copy).toContain('Your first read starts here');
    expect(copy).not.toContain('Live Court');
    expect(copy).not.toContain('Chosen focus');
    act(() => renderer.unmount());
  });

  it('recent read cards open the Result route with the shot id (max five)', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      shot({
        id: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
        shotType: i === 0 ? 'backhand_dink' : 'serve',
        overallScore: i % 2 ? null : 6 + i / 10,
        resultKind: i % 2 ? 'unscored' : 'scored',
      }),
    );
    mockListShots.mockResolvedValue(rows);
    const renderer = await renderHome();
    const copy = allText(renderer);
    expect(copy).toMatch(/5\s+latest/);

    const first = pressableByLabel(renderer, 'Open backhand dink result');
    expect(first.props.accessibilityRole).toBe('button');
    await press(first);
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: 'aaaaaaaa-0000-4000-8000-000000000000',
    });
    const serveCards = hostNodes(
      renderer,
      n => n.props.accessibilityLabel === 'Open serve result',
    );
    expect(serveCards).toHaveLength(4);
    act(() => renderer.unmount());
  });

  it('shows the profile name, self-rated level and chosen focus when present', async () => {
    mockAppState.profile = {
      firstName: 'Sam',
      skillLevel: '3.5',
      focusCheckpoint: 'paddle_ready',
    };
    const renderer = await renderHome();
    const copy = allText(renderer);
    expect(copy).toContain('Ready when you are, Sam.');
    expect(copy).toContain('SELF · 3.5');
    expect(copy).toContain('Chosen focus');
    expect(copy).toContain('paddle ready');
    expect(
      hostNodes(
        renderer,
        n => n.props.accessibilityLabel === 'Self-selected focus: paddle ready',
      ),
    ).toHaveLength(1);
    act(() => renderer.unmount());
  });
});

describe('Home — notification priming card', () => {
  it('is hidden once answered or when permission is denied', async () => {
    let renderer = await renderHome();
    expect(
      renderer.root.findAll(
        n => n.props.testID === 'notification-priming-card',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());

    mockNotificationState.prefs = { enabled: false, promptDismissed: false };
    mockNotificationState.permission = 'denied';
    renderer = await renderHome();
    expect(
      renderer.root.findAll(
        n => n.props.testID === 'notification-priming-card',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('Turn on requests permission; Not now dismisses — both wired, labeled buttons', async () => {
    mockNotificationState.prefs = { enabled: false, promptDismissed: false };
    const renderer = await renderHome();
    expect(allText(renderer)).toContain('A nudge on practice days?');

    const turnOn = pressableByLabel(renderer, 'Turn on practice reminders');
    expect(turnOn.props.accessibilityRole).toBe('button');
    expect(turnOn.props.accessibilityHint).toBe(
      'Request notification permission and schedule reminders',
    );
    await press(turnOn);
    expect(
      mockNotificationState.requestPermissionAndEnable,
    ).toHaveBeenCalledTimes(1);

    const notNow = pressableByLabel(renderer, 'Not now');
    expect(notNow.props.accessibilityRole).toBe('button');
    await press(notNow);
    expect(mockNotificationState.dismissPrompt).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
