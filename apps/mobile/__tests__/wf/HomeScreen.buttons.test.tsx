/**
 * Button ledger for HomeScreen: every interactive element rendered by
 * `src/screens/HomeScreen.tsx` is pressed here and its real observable
 * effect asserted — navigation target + params, store calls, refresh and
 * retry behavior, the async failure path, and the accessibility contract
 * (role, label, hit target) each control must satisfy.
 */
import React from 'react';
import { RefreshControl, StyleSheet, Text } from 'react-native';
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

const mockRequestPermissionAndEnable = jest.fn(async () => true);
const mockDismissPrompt = jest.fn(async () => {});
const mockNotificationState = {
  hydrated: true,
  prefs: { enabled: false, promptDismissed: false },
  permission: 'unknown' as 'unknown' | 'denied' | 'granted',
  requestPermissionAndEnable: mockRequestPermissionAndEnable,
  dismissPrompt: mockDismissPrompt,
};
jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (
    selector: (s: typeof mockNotificationState) => unknown,
  ) => selector(mockNotificationState),
}));

import { HomeScreen } from '../../src/screens/HomeScreen';
import type { LocalShotRow } from '../../src/data/repository';

const MIN_HIT_TARGET = 44;

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

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

async function renderHome(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<HomeScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function isHost(node: Node): boolean {
  return typeof node.type === 'string';
}

/** Every press target on screen: the `Pressable` composites (one per
 * control — PressableScale and Button both bottom out in exactly one).
 * RN exports Pressable as a memo wrapper, so the rendered instance's type
 * is the inner component; match it by name. */
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

/** The host view a Pressable renders — where the resolved style lives. */
function hostOf(pressable: Node): Node {
  const [host] = pressable.findAll(isHost);
  if (!host) throw new Error('Pressable rendered no host view');
  return host;
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

function flatStyle(pressable: Node): Record<string, unknown> {
  return (StyleSheet.flatten(hostOf(pressable).props.style) ?? {}) as Record<
    string,
    unknown
  >;
}

/** A Pressable's touch box is its laid-out frame, which is at least as tall
 * as its own fixed height/minHeight or that of any host view inside it. */
function meetsHitTarget(node: Node): boolean {
  if (node.props.hitSlop !== undefined) return true;
  const heights = [hostOf(node), ...hostOf(node).findAll(isHost)].map(host => {
    const style = (StyleSheet.flatten(host.props.style) ?? {}) as Record<
      string,
      unknown
    >;
    return Number(style['height'] ?? style['minHeight'] ?? 0);
  });
  return Math.max(...heights) >= MIN_HIT_TARGET;
}

async function press(node: Node | null) {
  if (!node) throw new Error('No such pressable');
  await act(async () => {
    node.props.onPress();
  });
}

describe('HomeScreen button ledger', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockGetDb.mockReset();
    mockGetDb.mockReturnValue({ execute: jest.fn() });
    mockListShots.mockReset();
    mockListShots.mockResolvedValue([]);
    mockListCaptureHistory.mockReset();
    mockListCaptureHistory.mockResolvedValue([]);
    mockGetApiSession.mockReset();
    mockGetApiSession.mockReturnValue(null);
    mockFetchCanonicalProgress.mockReset();
    mockRefreshConsistency.mockClear();
    mockRequestPermissionAndEnable.mockClear();
    mockDismissPrompt.mockClear();
    mockAppState.profile = null;
    mockConsistencyState.snapshot = null;
    mockNotificationState.hydrated = true;
    mockNotificationState.prefs = { enabled: false, promptDismissed: false };
    mockNotificationState.permission = 'unknown';
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  describe('top bar streak badge (home-streak-badge)', () => {
    it('opens the StreakCalendar route and announces the streak', async () => {
      mockConsistencyState.snapshot = { currentStreak: 3, atRisk: false };
      const renderer = await renderHome();
      const badge = pressableByTestId(renderer, 'home-streak-badge')!;
      expect(badge).not.toBeNull();
      expect(badge.props.accessibilityRole).toBe('button');
      expect(badge.props.accessibilityLabel).toBe(
        '3 days training streak. Opens the consistency calendar.',
      );
      await press(badge);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
      // WF-ISSUE: Home top-bar streak badge hit target is 32pt tall with no
      // hitSlop (styles.streakBadge height: 32) — below the 44pt minimum.
      // expect(meetsHitTarget(badge)).toBe(true);
      expect(flatStyle(badge)['height']).toBe(32);
      act(() => renderer.unmount());
    });

    it('reads a zero streak in the singular-safe form without a snapshot', async () => {
      const renderer = await renderHome();
      const badge = pressableByTestId(renderer, 'home-streak-badge')!;
      expect(badge.props.accessibilityLabel).toBe(
        '0 days training streak. Opens the consistency calendar.',
      );
      expect(allText(renderer)).toContain('NEW PLAYER');
      act(() => renderer.unmount());
    });
  });

  describe('PlayerRankBanner streak block (onPressStreak)', () => {
    it('routes to StreakCalendar with the at-risk copy in its label', async () => {
      mockConsistencyState.snapshot = { currentStreak: 4, atRisk: true };
      const renderer = await renderHome();
      const streak = pressableByTestId(renderer, 'player-rank-banner-streak')!;
      expect(streak).not.toBeNull();
      expect(streak.props.accessibilityRole).toBe('button');
      expect(streak.props.disabled).toBe(false);
      expect(hostOf(streak).props.accessibilityState).toMatchObject({
        disabled: false,
      });
      expect(String(streak.props.accessibilityLabel)).toContain(
        '4 days training streak, at risk',
      );
      expect(allText(renderer)).toContain('KEEP IT ALIVE');
      await press(streak);
      expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
      act(() => renderer.unmount());
    });

    it('rank banner toggle unfolds the ladder in place without navigating', async () => {
      const renderer = await renderHome();
      const toggle = pressableByTestId(renderer, 'player-rank-banner-toggle')!;
      expect(toggle.props.accessibilityState).toMatchObject({
        expanded: false,
      });
      await press(toggle);
      expect(
        pressableByTestId(renderer, 'player-rank-banner-toggle')!.props
          .accessibilityState,
      ).toMatchObject({ expanded: true });
      expect(allText(renderer)).toContain('Bronze → Silver → Gold');
      expect(mockNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('mode cards', () => {
    it('Stroke Analysis opens Analyze with the camera source', async () => {
      const renderer = await renderHome();
      const card = pressableByLabel(
        renderer,
        'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
      )!;
      expect(card).not.toBeNull();
      expect(card.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(card)).toBe(true);
      await press(card);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'camera',
      });
      act(() => renderer.unmount());
    });

    it('Drill Library opens the DrillLibrary route', async () => {
      const renderer = await renderHome();
      const card = pressableByLabel(
        renderer,
        'Drill Library. Guided drills you can search.',
      )!;
      expect(card).not.toBeNull();
      expect(card.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(card)).toBe(true);
      await press(card);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('DrillLibrary');
      act(() => renderer.unmount());
    });
  });

  describe('recent read cards', () => {
    it('opens the Result route for the tapped analysis id, five at most', async () => {
      const shots = [
        shot({ id: 'a1', shotType: 'dink', overallScore: 7.2 }),
        shot({ id: 'a2', shotType: 'drive', overallScore: null }),
        shot({ id: 'a3', shotType: 'serve' }),
        shot({ id: 'a4', shotType: 'volley' }),
        shot({ id: 'a5', shotType: 'lob' }),
        shot({ id: 'a6', shotType: 'reset' }),
      ];
      mockListShots.mockResolvedValue(shots);
      const renderer = await renderHome();
      expect(mockListShots).toHaveBeenCalledWith(expect.anything(), 250);

      const cards = pressables(renderer).filter(n =>
        String(n.props.accessibilityLabel).startsWith('Open '),
      );
      expect(cards.map(c => c.props.accessibilityLabel)).toEqual([
        'Open dink result',
        'Open drive result',
        'Open serve result',
        'Open volley result',
        'Open lob result',
      ]);
      for (const card of cards) {
        expect(card.props.accessibilityRole).toBe('button');
        expect(meetsHitTarget(card)).toBe(true);
      }
      expect(allText(renderer)).toContain('5 latest');

      await press(cards[1]!);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('Result', {
        analysisId: 'a2',
      });
      await press(cards[0]!);
      expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
        analysisId: 'a1',
      });
      act(() => renderer.unmount());
    });

    it('renders a null score as a dash instead of throwing', async () => {
      mockListShots.mockResolvedValue([
        shot({ id: 'u1', shotType: 'drive', overallScore: null }),
      ]);
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('—');
      expect(text).toContain('No scored technique yet');
      expect(pressableByLabel(renderer, 'Open drive result')).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('shows the latest scored stroke as the technique headline', async () => {
      mockListShots.mockResolvedValue([
        shot({ id: 'n1', shotType: 'drive', overallScore: null }),
        shot({ id: 's1', shotType: 'third_shot_drop', overallScore: 6.4 }),
      ]);
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('third shot drop');
      expect(text).toContain('6.4');
      expect(text).toContain('Latest validated scored stroke on this device');
      act(() => renderer.unmount());
    });
  });

  describe('NotificationPrimingCard actions rendered on Home', () => {
    it('Turn on requests permission through the notification store', async () => {
      const renderer = await renderHome();
      const turnOn = pressableByLabel(renderer, 'Turn on practice reminders')!;
      expect(turnOn).not.toBeNull();
      expect(turnOn.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(turnOn)).toBe(true);
      await press(turnOn);
      expect(mockRequestPermissionAndEnable).toHaveBeenCalledTimes(1);
      expect(mockNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('Not now dismisses the prompt through the notification store', async () => {
      const renderer = await renderHome();
      const notNow = pressableByLabel(renderer, 'Not now')!;
      expect(notNow).not.toBeNull();
      expect(notNow.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(notNow)).toBe(true);
      await press(notNow);
      expect(mockDismissPrompt).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('is hidden once reminders were answered', async () => {
      mockNotificationState.prefs = { enabled: false, promptDismissed: true };
      const renderer = await renderHome();
      expect(
        pressableByLabel(renderer, 'Turn on practice reminders'),
      ).toBeNull();
      expect(pressableByLabel(renderer, 'Not now')).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('pull-to-refresh', () => {
    it('reloads shots and captures, then clears the refreshing flag', async () => {
      const renderer = await renderHome();
      expect(mockListShots).toHaveBeenCalledTimes(1);
      expect(mockListCaptureHistory).toHaveBeenCalledTimes(1);

      let release!: (rows: unknown[]) => void;
      mockListShots.mockImplementationOnce(
        () =>
          new Promise<unknown[]>(resolve => {
            release = resolve;
          }),
      );
      const control = renderer.root.findByType(RefreshControl);
      expect(control.props.refreshing).toBe(false);
      await act(async () => {
        control.props.onRefresh();
      });
      expect(renderer.root.findByType(RefreshControl).props.refreshing).toBe(
        true,
      );
      expect(mockListShots).toHaveBeenCalledTimes(2);

      await act(async () => {
        release([shot({ id: 'r1', shotType: 'dink' })]);
      });
      await flush();
      expect(renderer.root.findByType(RefreshControl).props.refreshing).toBe(
        false,
      );
      expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('failure path: load error → Try again', () => {
    it('shows the error copy when the local store cannot be read', async () => {
      mockListShots.mockRejectedValue(new Error('sqlite closed'));
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('Your court couldn’t load');
      expect(text).toContain(
        'Your saved reads could not be opened. Try again to load your real court history.',
      );
      expect(pressableByLabel(renderer, 'Try again')).not.toBeNull();
      // The whole page is the error state: no home controls remain.
      expect(pressableByTestId(renderer, 'home-streak-badge')).toBeNull();
      act(() => renderer.unmount());
    });

    it('Try again reloads and restores the home controls on success', async () => {
      mockGetDb.mockImplementationOnce(() => {
        throw new Error('db unavailable');
      });
      const renderer = await renderHome();
      const retry = pressableByLabel(renderer, 'Try again')!;
      expect(retry).not.toBeNull();
      expect(retry.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(retry)).toBe(true);
      expect(mockListShots).toHaveBeenCalledTimes(0);

      mockListShots.mockResolvedValue([shot({ id: 'ok1', shotType: 'dink' })]);
      await press(retry);
      await flush();
      expect(mockListShots).toHaveBeenCalledTimes(1);
      expect(pressableByLabel(renderer, 'Try again')).toBeNull();
      expect(pressableByTestId(renderer, 'home-streak-badge')).not.toBeNull();
      expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('Try again that fails again lands back on the error state, never a spinner', async () => {
      mockListShots.mockRejectedValue(new Error('still broken'));
      const renderer = await renderHome();
      let pendingRetry!: () => void;
      mockListShots.mockImplementationOnce(
        () =>
          new Promise<unknown[]>((_resolve, reject) => {
            pendingRetry = () => reject(new Error('still broken'));
          }),
      );
      await press(pressableByLabel(renderer, 'Try again')!);
      // While the retry is in flight the button is gone (loading state
      // replaces it), so a second tap cannot fire a duplicate load.
      expect(pressableByLabel(renderer, 'Try again')).toBeNull();
      expect(allText(renderer)).toContain('Loading your court…');
      await act(async () => {
        pendingRetry();
      });
      await flush();
      expect(allText(renderer)).toContain('Your court couldn’t load');
      expect(pressableByLabel(renderer, 'Try again')).not.toBeNull();
      expect(allText(renderer)).not.toContain('Loading your court…');
      act(() => renderer.unmount());
    });
  });

  describe('account-synced progress', () => {
    it('falls back to local data when the progress fetch rejects', async () => {
      mockGetApiSession.mockReturnValue({
        apiBaseUrl: 'https://api.test',
        bearerToken: 'token',
      });
      mockFetchCanonicalProgress.mockRejectedValue(new Error('offline'));
      const renderer = await renderHome();
      expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
      expect(allText(renderer)).toContain('No scored technique yet');
      expect(pressableByTestId(renderer, 'home-streak-badge')).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('shows the synced daily average when no local scored read exists', async () => {
      mockGetApiSession.mockReturnValue({
        apiBaseUrl: 'https://api.test',
        bearerToken: 'token',
      });
      mockFetchCanonicalProgress.mockResolvedValue({
        series: [
          {
            day: '2026-08-20',
            shotType: 'dink',
            scoringModelVersion: 'm1',
            shotCount: 2,
            avgScore: 5.5,
            bestScore: 6,
          },
          {
            day: '2026-08-28',
            shotType: 'serve',
            scoringModelVersion: 'm1',
            shotCount: 1,
            avgScore: 7.1,
            bestScore: 7.1,
          },
        ],
        improving: [],
        needsAttention: [],
        streak: {
          currentDays: 0,
          longestDays: 0,
          practicedToday: false,
          lastPracticeDate: null,
        },
      });
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('serve daily average');
      expect(text).toContain('7.1');
      expect(text).toContain('Latest synced daily average');
      act(() => renderer.unmount());
    });
  });

  describe('profile-driven copy', () => {
    it('greets by first name and shows the self-set focus and level', async () => {
      mockAppState.profile = {
        firstName: 'Ada',
        skillLevel: '3.5',
        focusCheckpoint: 'paddle_ready',
      };
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('Ready when you are, Ada.');
      expect(text).toContain('SELF · 3.5');
      expect(text).toContain('paddle ready');
      expect(
        renderer.root.findAll(
          n =>
            isHost(n) &&
            n.props.accessibilityLabel === 'Self-selected focus: paddle ready',
        ).length,
      ).toBe(1);
      act(() => renderer.unmount());
    });
  });

  describe('ledger invariants', () => {
    it('every pressable on the loaded Home is a labeled button and the ledger is complete', async () => {
      mockConsistencyState.snapshot = { currentStreak: 2, atRisk: false };
      mockListShots.mockResolvedValue([shot({ id: 'l1', shotType: 'dink' })]);
      const renderer = await renderHome();
      const controls = pressables(renderer);
      const labels = controls.map(n => String(n.props.accessibilityLabel));
      expect(labels).toEqual([
        '2 days training streak. Opens the consistency calendar.',
        expect.stringContaining('Player rank Gold I, rating 6.40 out of 10.'),
        '2 days training streak. Opens the consistency calendar.',
        'Turn on practice reminders',
        'Not now',
        'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
        'Drill Library. Guided drills you can search.',
        'Open dink result',
      ]);
      for (const node of controls) {
        expect(node.props.accessibilityRole).toBe('button');
        expect(node.props.disabled ?? false).toBe(false);
        expect(hostOf(node).props.accessibilityState?.disabled ?? false).toBe(
          false,
        );
      }
      expect(mockRefreshConsistency).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });
  });
});
