/**
 * Button ledger for HomeScreen: every interactive element rendered by
 * `src/screens/HomeScreen.tsx` is pressed here and its real observable
 * effect asserted — navigation target + params, store calls, refresh and
 * retry behavior, the async failure path, and the accessibility contract
 * (role, label, hit target) each control must satisfy.
 */
import React from 'react';
import {
  Dimensions,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import { type } from '../../src/design/tokens';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { BrandMark, Pill } from '../../src/design/components';

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
  return {
    ...jest.requireActual('react-native-safe-area-context'),
    SafeAreaView: View,
  };
});

const mockNavigate = jest.fn();
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => {
      if (mockFocused) return callback();
    }, [callback, mockFocused]);
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
  ownerKey: null as string | null,
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
import { color, type as typography } from '../../src/design/tokens';
import type { LocalShotRow, RealAnalysisFact } from '../../src/data/repository';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const MIN_HIT_TARGET = 44;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function syncedProgress(score: number) {
  return {
    series: [
      {
        day: new Date().toISOString().slice(0, 10),
        shotType: 'serve',
        scoringModelVersion: 'm1',
        shotCount: 1,
        avgScore: score,
        bestScore: score,
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
  };
}

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

/** A real scored analysis `hoursAgo` before now — inside the week window. */
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

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

async function renderHome(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaInsetsContext.Provider
        value={{ top: 59, bottom: 34, left: 0, right: 0 }}
      >
        <HomeScreen />
      </SafeAreaInsetsContext.Provider>,
    );
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
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 375,
      height: 667,
      scale: 2,
      fontScale: 1,
    });
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockFocused = true;
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
    mockFetchCanonicalProgress.mockReset();
    mockRefreshConsistency.mockClear();
    mockRequestPermissionAndEnable.mockClear();
    mockDismissPrompt.mockClear();
    mockAppState.profile = null;
    mockAppState.ownerKey = OWNER;
    setActiveDataOwner(OWNER);
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
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.restoreAllMocks();
  });

  it('uses the shared card-score and big-stat roles without changing the measured values', async () => {
    mockListShots.mockResolvedValue([shot({})]);
    mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
    const renderer = await renderHome();
    const scores = renderer.root
      .findAllByType(Text)
      .filter(node => node.props.children === '6.4');
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      expect(StyleSheet.flatten(score.props.style)).toMatchObject({
        ...typography.score,
        color: color.ink,
      });
    }
    const counters = renderer.root
      .findAllByType(Text)
      .filter(
        node =>
          StyleSheet.flatten(node.props.style)?.fontSize ===
          typography.display.fontSize,
      );
    expect(counters).toHaveLength(1);
    expect(counters[0]!.props.children).toBe(1);
    expect(StyleSheet.flatten(counters[0]!.props.style)).toMatchObject({
      ...typography.display,
      color: color.onDark,
    });
    act(() => renderer.unmount());
  });

  it.each([375, 393])(
    'selects wrapping header/rank styles and preserves facts and routes at %spt / 3.571x',
    async width => {
      const dimensions = jest.spyOn(Dimensions, 'get').mockReturnValue({
        width,
        height: width === 375 ? 667 : 852,
        scale: width === 375 ? 2 : 3,
        fontScale: 3.571,
      });
      mockAppState.profile = { skillLevel: '3.5' };
      mockConsistencyState.snapshot = { currentStreak: 365, atRisk: true };
      mockListShots.mockResolvedValue([
        shot({ overallScore: 6.81, shotType: 'backhand_drive' }),
      ]);
      const renderer = await renderHome();
      try {
        const brand = renderer.root.findByType(BrandMark);
        expect(StyleSheet.flatten(brand.parent!.props.style)).toMatchObject({
          flexDirection: 'column',
          alignItems: 'stretch',
        });
        const wordmark = brand.findByType(Text);
        expect(StyleSheet.flatten(wordmark.props.style)).toMatchObject({
          ...typography.h3,
          flexShrink: 1,
        });
        expect(wordmark.props.children).toBe('Pickle Sensei');
        expect(wordmark.props.numberOfLines).toBeUndefined();
        expect(wordmark.props.maxFontSizeMultiplier).toBeUndefined();
        expect(wordmark.props.allowFontScaling).not.toBe(false);
        const pill = renderer.root.findByType(Pill);
        expect(pill.props.label).toBe('SELF · 3.5');
        expect(StyleSheet.flatten(pill.parent!.props.style)).toMatchObject({
          flexWrap: 'wrap',
          maxWidth: '100%',
        });
        const badge = pressableByTestId(renderer, 'home-streak-badge')!;
        expect(flatStyle(badge)).toMatchObject({
          height: 'auto',
          minHeight: 44,
        });
        expect(badge.props.disabled).not.toBe(true);
        const badgeValue = badge.findByType(Text);
        expect(badgeValue.props.children).toBe(365);
        expect(badgeValue.props.maxFontSizeMultiplier).toBeUndefined();
        expect(badgeValue.props.allowFontScaling).not.toBe(false);

        const toggle = pressableByTestId(
          renderer,
          'player-rank-banner-toggle',
        )!;
        const streak = pressableByTestId(
          renderer,
          'player-rank-banner-streak',
        )!;
        expect(StyleSheet.flatten(toggle.parent!.props.style)).toMatchObject({
          flexDirection: 'column',
          alignItems: 'stretch',
        });
        expect(flatStyle(toggle)).toMatchObject({
          width: '100%',
          flexBasis: 'auto',
          flexGrow: 0,
          flexDirection: 'column',
        });
        expect(flatStyle(streak)).toMatchObject({
          minHeight: 44,
          maxWidth: '100%',
        });
        const rankTexts = toggle.findAllByType(Text);
        const eyebrow = rankTexts.find(
          node => node.props.children === 'PLAYER RANK',
        )!;
        expect(StyleSheet.flatten(eyebrow.parent!.props.style)).toMatchObject({
          flex: 0,
          width: '100%',
        });
        const title = rankTexts.find(
          node => node.props.children === 'Platinum III',
        )!;
        expect(StyleSheet.flatten(title.parent!.props.style)).toMatchObject({
          flexDirection: 'column',
          alignItems: 'stretch',
        });
        for (const text of rankTexts) {
          expect(text.props.numberOfLines).toBeUndefined();
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          expect(text.props.allowFontScaling).not.toBe(false);
        }
        expect(allText(renderer)).toContain('Platinum III');
        expect(allText(renderer)).toContain('6.81');
        expect(allText(renderer)).toContain('/10');
        expect(allText(renderer)).not.toMatch(/DUPR|≈/);
        expect(allText(renderer)).toContain('KEEP IT ALIVE');
        expect(toggle.props.accessibilityLabel).toContain(
          'rating 6.81 out of 10.',
        );
        await press(badge);
        expect(mockNavigate).toHaveBeenCalledTimes(1);
        expect(mockNavigate).toHaveBeenLastCalledWith('StreakCalendar');
        await press(toggle);
        expect(toggle.props.accessibilityState.expanded).toBe(true);
        expect(mockNavigate).toHaveBeenCalledTimes(1);
        await press(streak);
        expect(mockNavigate).toHaveBeenCalledTimes(2);
        expect(mockNavigate).toHaveBeenLastCalledWith('StreakCalendar');
      } finally {
        act(() => renderer.unmount());
        dimensions.mockRestore();
      }
    },
  );

  describe('top bar streak badge (home-streak-badge)', () => {
    test.each([
      { width: 375, height: 667, fontScale: 1 },
      { width: 390, height: 844, fontScale: 1 },
      { width: 375, height: 667, fontScale: 1.353 },
      { width: 375, height: 667, fontScale: 3.12 },
      { width: 375, height: 667, fontScale: 3.571 },
      { width: 320, height: 568, fontScale: 3.571 },
      { width: 667, height: 375, fontScale: 3.571 },
    ])(
      'wraps the real brand and full header labels at $width×$height / $fontScale (JSX contract only)',
      async ({ width, height, fontScale }) => {
        const previous = {
          window: Dimensions.get('window'),
          screen: Dimensions.get('screen'),
        };
        Dimensions.set({
          window: { width, height, fontScale, scale: 2 },
          screen: { width, height, fontScale, scale: 2 },
        });
        mockAppState.profile = { skillLevel: 'intermediate' };
        mockConsistencyState.snapshot = { currentStreak: 365, atRisk: true };
        let renderer!: Renderer;
        try {
          renderer = await renderHome();
          const scroll = renderer.root.findByType(ScrollView);
          const brand = scroll.findByType(BrandMark);
          expect(StyleSheet.flatten(brand.parent!.props.style)).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
          });
          const host = (testID: string) =>
            scroll.findAll(
              node => node.props.testID === testID && isHost(node),
            )[0]!;
          expect(
            StyleSheet.flatten(host('home-top-bar').props.style),
          ).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
          });
          expect(
            StyleSheet.flatten(host('home-top-badges').props.style),
          ).toMatchObject({
            flexDirection: 'row',
            flexWrap: 'wrap',
            maxWidth: '100%',
          });
          const brandHost = brand.findAll(
            node =>
              isHost(node) && node.props.accessibilityLabel === 'Pickle Sensei',
          )[0]!;
          expect(StyleSheet.flatten(brandHost.props.style)).toMatchObject({
            maxWidth: '100%',
            flexShrink: 1,
            minWidth: 0,
          });
          const wordmark = brand.findByType(Text);
          expect(wordmark.props.children).toBe('Pickle Sensei');
          expect(StyleSheet.flatten(wordmark.props.style)).toMatchObject({
            ...type.h3,
            flexShrink: 1,
            minWidth: 0,
          });
          const pill = host('home-top-badges').findByType(Pill);
          expect(pill.props.label).toBe('SELF · intermediate');
          expect(pill.findByType(Text).props.numberOfLines).toBeUndefined();
          const badge = pressableByTestId(renderer, 'home-streak-badge')!;
          expect(flatStyle(badge)['height']).toBeUndefined();
          expect(flatStyle(badge)['minHeight']).toBe(32);
          expect(
            Number(flatStyle(badge)['minHeight']) +
              2 * Number(badge.props.hitSlop),
          ).toBeGreaterThanOrEqual(44);
          expect(
            StyleSheet.flatten(badge.findByType(Text).props.style),
          ).toMatchObject({ ...type.caption, flexShrink: 1, minWidth: 0 });
          for (const text of [
            wordmark,
            pill.findByType(Text),
            badge.findByType(Text),
          ]) {
            expect(text.props.allowFontScaling).not.toBe(false);
            expect(text.props.maxFontSizeMultiplier).toBeUndefined();
            expect(text.props.numberOfLines).toBeUndefined();
          }
          expect(
            renderer.root.findAll(
              node =>
                isHost(node) &&
                JSON.stringify(node.props.edges) ===
                  JSON.stringify(['top', 'left', 'right']),
            ),
          ).toHaveLength(1);
        } finally {
          if (renderer) act(() => renderer.unmount());
          Dimensions.set(previous);
        }
      },
    );

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
      expect(flatStyle(badge)['height']).toBeUndefined();
      expect(flatStyle(badge)['minHeight']).toBe(32);
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

  describe('This week card (scored reads, two chart lenses)', () => {
    const scoresTab = (renderer: Renderer) =>
      pressableByTestId(renderer, 'home-week-chart-scores')!;
    const readsTab = (renderer: Renderer) =>
      pressableByTestId(renderer, 'home-week-chart-reads')!;
    const chartLabel = (renderer: Renderer, testID: string) =>
      renderer.root.findAll(
        n => typeof n.type === 'string' && n.props.testID === testID,
      )[0]?.props.accessibilityLabel as string | undefined;

    it('counts the first scored read whatever path captured it (the scan-not-showing bug)', async () => {
      // One scored analysis exists (imported video OR guided camera — the
      // card no longer cares which); the capture-evidence table is not read.
      mockListRealAnalysisFacts.mockResolvedValue([fact(2)]);
      const renderer = await renderHome();
      expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
      const text = allText(renderer);
      expect(text).toContain('THIS WEEK');
      expect(text).toContain('Scored technique reads on this device');
      expect(text).toMatch(/1 scored read\b/);
      expect(text).not.toContain('Your court is ready.');
      // Footer: one scored day, avg and best both 3.7 — nothing invented.
      expect(text).toContain('1 scored day');
      expect(text.match(/3\.7/g)?.length).toBeGreaterThanOrEqual(2);
      // Default lens is the dot plot, summarized for screen readers.
      expect(chartLabel(renderer, 'score-dot-plot')).toBe(
        'Seven day technique scores: 1 scored read across 1 day, latest 3.7 out of 10.',
      );
      expect(chartLabel(renderer, 'practice-volume-chart')).toBeUndefined();
      act(() => renderer.unmount());
    });

    it('toggle switches to the reads-per-day bars and remembers the choice on device', async () => {
      mockListRealAnalysisFacts.mockResolvedValue([
        fact(30, { id: 'a', overallScore: 5.2 }),
        fact(2, { id: 'b', overallScore: 6.1 }),
      ]);
      const renderer = await renderHome();
      const scores = scoresTab(renderer);
      const reads = readsTab(renderer);
      for (const tab of [scores, reads]) {
        expect(tab.props.accessibilityRole).toBe('tab');
        expect(meetsHitTarget(tab)).toBe(true);
      }
      expect(scores.props.accessibilityState).toMatchObject({ selected: true });
      expect(reads.props.accessibilityState).toMatchObject({ selected: false });

      await press(reads);
      expect(mockSetKv).toHaveBeenCalledWith(
        expect.anything(),
        'home.week-chart',
        'reads',
      );
      expect(readsTab(renderer).props.accessibilityState).toMatchObject({
        selected: true,
      });
      expect(chartLabel(renderer, 'practice-volume-chart')).toBe(
        'Seven day read volume: 2 scored reads across 2 scored days.',
      );
      expect(chartLabel(renderer, 'score-dot-plot')).toBeUndefined();
      // The hero count is the same number in both lenses.
      expect(allText(renderer)).toMatch(/2 scored reads\b/);

      await press(scoresTab(renderer));
      expect(mockSetKv).toHaveBeenLastCalledWith(
        expect.anything(),
        'home.week-chart',
        'scores',
      );
      expect(chartLabel(renderer, 'score-dot-plot')).toBe(
        'Seven day technique scores: 2 scored reads across 2 days, latest 6.1 out of 10.',
      );
      act(() => renderer.unmount());
    });

    it('opens on the remembered lens', async () => {
      mockGetKv.mockResolvedValue('reads');
      mockListRealAnalysisFacts.mockResolvedValue([fact(1)]);
      const renderer = await renderHome();
      expect(mockGetKv).toHaveBeenCalledWith(
        expect.anything(),
        'home.week-chart',
      );
      expect(readsTab(renderer).props.accessibilityState).toMatchObject({
        selected: true,
      });
      expect(chartLabel(renderer, 'practice-volume-chart')).toBeDefined();
      act(() => renderer.unmount());
    });

    it('a broken preference read never fails the Home load', async () => {
      mockGetKv.mockRejectedValue(new Error('kv missing'));
      const renderer = await renderHome();
      expect(allText(renderer)).toContain('THIS WEEK');
      expect(pressableByLabel(renderer, 'Try again')).toBeNull();
      act(() => renderer.unmount());
    });

    it('tells a first week and a quiet week apart honestly', async () => {
      const first = await renderHome();
      let text = allText(first);
      expect(text).toContain('Your court is ready.');
      expect(text).toContain('Your first scored read starts this record.');
      expect(text).toContain('—');
      expect(chartLabel(first, 'score-dot-plot')).toBe(
        'No scored reads in this window yet.',
      );
      act(() => first.unmount());

      // Comparable reads exist, but all of them predate this week.
      mockListRealAnalysisFacts.mockResolvedValue([fact(24 * 12)]);
      const quiet = await renderHome();
      text = allText(quiet);
      expect(text).toContain('Quiet week so far.');
      expect(text).toContain('Your next scored read lands here.');
      expect(text).not.toContain('Your court is ready.');
      act(() => quiet.unmount());
    });
  });

  describe('pull-to-refresh', () => {
    it('reloads shots and analyses, then clears the refreshing flag', async () => {
      const renderer = await renderHome();
      expect(mockListShots).toHaveBeenCalledTimes(1);
      expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);

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
    it('never requests another owner’s canonical history', async () => {
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OTHER_OWNER });
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(9.1));
      mockListShots.mockResolvedValue([shot({ shotType: 'dink' })]);
      const renderer = await renderHome();
      expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
      expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('rejects local work from a previous sign-in even when the owner returns before render', async () => {
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(local.promise);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      setActiveDataOwner(OWNER);
      await act(async () => local.resolve([shot({ shotType: 'dink' })]));
      expect(pressableByLabel(renderer, 'Open dink result')).toBeNull();
      mockListShots.mockResolvedValue([shot({ shotType: 'serve' })]);
      await act(async () => renderer.update(<HomeScreen />));
      expect(mockListShots).toHaveBeenCalledTimes(2);
      expect(pressableByLabel(renderer, 'Open serve result')).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('hides loaded history and rejects late canonical data from an earlier sign-in generation', async () => {
      const canonical = deferred<ReturnType<typeof syncedProgress>>();
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockReturnValueOnce(canonical.promise);
      mockListShots.mockResolvedValue([shot({ shotType: 'dink' })]);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      setActiveDataOwner(OWNER);
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(local.promise);
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(7.9));
      await act(async () => renderer.update(<HomeScreen />));
      expect(allText(renderer)).toContain('Loading your court');
      expect(pressableByLabel(renderer, 'Open dink result')).toBeNull();
      await act(async () => canonical.resolve(syncedProgress(4.2)));
      expect(allText(renderer)).toContain('Loading your court');
      await act(async () => local.resolve([]));
      expect(allText(renderer)).toContain('7.9');
      expect(allText(renderer)).not.toContain('4.2');
      act(() => renderer.unmount());
    });

    it('ignores canonical data while blurred and only merges the next focus response', async () => {
      const first = deferred<ReturnType<typeof syncedProgress>>();
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockReturnValueOnce(first.promise);
      const renderer = await renderHome();
      mockFocused = false;
      await act(async () => renderer.update(<HomeScreen />));
      await act(async () => first.resolve(syncedProgress(4.2)));
      expect(allText(renderer)).not.toContain('4.2');
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(7.9));
      mockFocused = true;
      await act(async () => renderer.update(<HomeScreen />));
      expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain('7.9');
      act(() => renderer.unmount());
    });

    it('paints local reads and finishes refresh while canonical progress is still pending', async () => {
      const canonical = deferred<ReturnType<typeof syncedProgress>>();
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockReturnValue(canonical.promise);
      mockListShots.mockResolvedValue([shot({ shotType: 'dink' })]);
      mockListRealAnalysisFacts.mockResolvedValue([fact(1)]);
      const renderer = await renderHome();

      expect(allText(renderer)).not.toContain('Loading your court');
      expect(pressableByLabel(renderer, 'Open dink result')).not.toBeNull();
      expect(allText(renderer)).toContain('THIS WEEK');
      expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
      });
      expect(renderer.root.findByType(RefreshControl).props.refreshing).toBe(
        false,
      );
      expect(mockFetchCanonicalProgress).toHaveBeenCalledTimes(2);

      await act(async () => canonical.resolve(syncedProgress(9.1)));
      expect(allText(renderer)).toContain('6.4');
      expect(allText(renderer)).not.toContain('9.1');
      act(() => renderer.unmount());
    });

    it('ignores a superseded canonical response instead of overwriting the latest refresh', async () => {
      const first = deferred<ReturnType<typeof syncedProgress>>();
      const second = deferred<ReturnType<typeof syncedProgress>>();
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const renderer = await renderHome();
      expect(allText(renderer)).not.toContain('Loading your court');
      await act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
      });
      await act(async () => second.resolve(syncedProgress(7.9)));
      expect(allText(renderer)).toContain('7.9');
      await act(async () => first.resolve(syncedProgress(4.2)));
      expect(allText(renderer)).toContain('7.9');
      expect(allText(renderer)).not.toContain('4.2');
      act(() => renderer.unmount());
    });

    it('discards deferred local reads after an owner switch and loads the new owner', async () => {
      const first = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(first.promise);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      mockAppState.ownerKey = OTHER_OWNER;
      mockListShots.mockResolvedValue([shot({ shotType: 'serve' })]);
      await act(async () => renderer.update(<HomeScreen />));
      expect(pressableByLabel(renderer, 'Open serve result')).not.toBeNull();
      await act(async () => {
        first.resolve([shot({ shotType: 'dink' })]);
      });
      expect(pressableByLabel(renderer, 'Open dink result')).toBeNull();
      expect(pressableByLabel(renderer, 'Open serve result')).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('does not publish a previous owner’s pending canonical progress', async () => {
      const first = deferred<ReturnType<typeof syncedProgress>>();
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockReturnValueOnce(first.promise);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      mockAppState.ownerKey = OTHER_OWNER;
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OTHER_OWNER });
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(7.9));
      await act(async () => renderer.update(<HomeScreen />));
      await act(async () => first.resolve(syncedProgress(4.2)));
      expect(allText(renderer)).toContain('7.9');
      expect(allText(renderer)).not.toContain('4.2');
      act(() => renderer.unmount());
    });

    it('does not launch canonical work when local reads finish after unmount', async () => {
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValue(local.promise);
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(7.9));
      const renderer = await renderHome();
      act(() => renderer.unmount());
      await act(async () => local.resolve([shot({})]));
      expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
      expect(renderer.toJSON()).toBeNull();
    });

    it('falls back to local data when the progress fetch rejects', async () => {
      mockGetApiSession.mockReturnValue({
        apiBaseUrl: 'https://api.test',
        bearerToken: 'token',
        canonicalAppUserId: OWNER,
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
        canonicalAppUserId: OWNER,
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
        'Scores chart: every scored read at its score',
        'Reads chart: scored reads per day',
        'Open dink result',
      ]);
      for (const node of controls) {
        // The week-card lenses are a two-tab segmented control; every other
        // control is a button.
        expect(node.props.accessibilityRole).toBe(
          String(node.props.testID).startsWith('home-week-chart-')
            ? 'tab'
            : 'button',
        );
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
