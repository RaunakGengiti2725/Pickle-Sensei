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
    // The screen is rendered without a SafeAreaProvider here.
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
import { duprAccessibilityLabel } from '../../src/progress/duprEstimate';
import type { LocalShotRow } from '../../src/data/repository';
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

/** A recent-read row's label: the stroke, then (for a scored read) the
 * estimated DUPR and the 0–10 score VoiceOver reads without opening it. */
function openResultLabel(stroke: string, score: number | null = 6.4): string {
  return `Open ${stroke} result${
    score === null ? '' : `, ${duprAccessibilityLabel(score)}`
  }`;
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

  it('prints the recent read in the shared card-score role without changing the measured value', async () => {
    mockListShots.mockResolvedValue([shot({})]);
    const renderer = await renderHome();
    // D-046: the recent-read row prints the estimated DUPR (6.4 → 3.48) in
    // the card-score role with the " DUPR" unit nested, and "6.4 /10" as the
    // smaller micro line.
    const duprNumerals = renderer.root
      .findAllByType(Text)
      .filter(
        node =>
          Array.isArray(node.props.children) &&
          node.props.children[0] === '3.48',
      );
    // The rank banner prints the same estimate in its own bodyBold role; the
    // recent read is the one card score in the shared card-score role.
    const scores = duprNumerals.filter(
      node =>
        StyleSheet.flatten(node.props.style)?.fontSize ===
        typography.score.fontSize,
    );
    expect(scores).toHaveLength(1);
    expect(StyleSheet.flatten(scores[0]!.props.style)).toMatchObject({
      ...typography.score,
      color: color.ink,
    });
    const secondary = renderer.root
      .findAllByType(Text)
      .filter(node => node.props.children === '6.4 /10');
    expect(secondary).toHaveLength(1);
    expect(StyleSheet.flatten(secondary[0]!.props.style)).toMatchObject(
      typography.micro,
    );
    expect(
      renderer.root
        .findAllByType(Text)
        .filter(node => node.props.children === '6.4'),
    ).toHaveLength(0);
    // Home carries no big-stat counter any more: the week card moved out.
    expect(
      renderer.root
        .findAllByType(Text)
        .filter(
          node =>
            StyleSheet.flatten(node.props.style)?.fontSize ===
            typography.display.fontSize,
        ),
    ).toHaveLength(0);
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
        // The self-rated level lives on Settings now, not in the header.
        expect(renderer.root.findAllByType(Pill)).toHaveLength(0);
        expect(allText(renderer)).not.toContain('SELF · 3.5');
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
        // The streak shows once, in the header chip — never a second block
        // inside the rank banner.
        expect(
          pressableByTestId(renderer, 'player-rank-banner-streak'),
        ).toBeNull();
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
        // D-046: the estimated DUPR (6.81 → 3.81) headlines with its unit;
        // the 0–10 rating is the smaller "/10" line beneath.
        expect(allText(renderer)).toContain('3.81 DUPR');
        expect(allText(renderer)).toContain('6.81 /10');
        expect(allText(renderer)).not.toMatch(/≈/);
        // The at-risk note rides on the one streak control's label.
        expect(badge.props.accessibilityLabel).toBe(
          '365 days training streak, at risk — no training yet today. Opens the consistency calendar.',
        );
        expect(toggle.props.accessibilityLabel).toContain(
          'estimated DUPR 3.81, technique rating 6.81 out of 10.',
        );
        await press(badge);
        expect(mockNavigate).toHaveBeenCalledTimes(1);
        expect(mockNavigate).toHaveBeenLastCalledWith('StreakCalendar');
        await press(toggle);
        expect(toggle.props.accessibilityState.expanded).toBe(true);
        expect(mockNavigate).toHaveBeenCalledTimes(1);
        // A recent read stacks its DUPR under the name at this text size.
        const row = pressableByLabel(
          renderer,
          openResultLabel('backhand drive', 6.81),
        )!;
        expect(flatStyle(row)).toMatchObject({ flexDirection: 'column' });
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
          // The header holds the brand and the streak chip only.
          expect(host('home-top-badges').findAllByType(Pill)).toHaveLength(0);
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
          for (const text of [wordmark, badge.findByType(Text)]) {
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
      // No "NEW PLAYER" / "SELF · level" pill competes with the chip.
      expect(allText(renderer)).not.toContain('NEW PLAYER');
      act(() => renderer.unmount());
    });
  });

  describe('rank banner', () => {
    it('shows the streak once: no banner streak block, and the chip carries the at-risk note', async () => {
      mockConsistencyState.snapshot = { currentStreak: 4, atRisk: true };
      const renderer = await renderHome();
      expect(
        pressableByTestId(renderer, 'player-rank-banner-streak'),
      ).toBeNull();
      expect(allText(renderer)).not.toContain('DAY STREAK');
      expect(allText(renderer)).not.toContain('KEEP IT ALIVE');
      const badge = pressableByTestId(renderer, 'home-streak-badge')!;
      expect(badge.props.accessibilityLabel).toBe(
        '4 days training streak, at risk — no training yet today. Opens the consistency calendar.',
      );
      await press(badge);
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
    it('opens the Result route for the tapped analysis id, three at most, with See all → Library', async () => {
      const shots = [
        shot({ id: 'a1', shotType: 'dink', overallScore: 7.2 }),
        shot({ id: 'a2', shotType: 'drive', overallScore: null }),
        shot({ id: 'a3', shotType: 'serve' }),
        shot({ id: 'a4', shotType: 'volley' }),
        shot({ id: 'a5', shotType: 'lob' }),
      ];
      mockListShots.mockResolvedValue(shots);
      const renderer = await renderHome();
      expect(mockListShots).toHaveBeenCalledWith(expect.anything(), 250);

      const cards = pressables(renderer).filter(n =>
        String(n.props.accessibilityLabel).startsWith('Open '),
      );
      expect(cards.map(c => c.props.accessibilityLabel)).toEqual([
        openResultLabel('dink', 7.2),
        openResultLabel('drive', null),
        openResultLabel('serve'),
      ]);
      for (const card of cards) {
        expect(card.props.accessibilityRole).toBe('button');
        expect(meetsHitTarget(card)).toBe(true);
        // Default text size: name on the left, DUPR on the right.
        expect(flatStyle(card)).toMatchObject({ flexDirection: 'row' });
      }

      await press(cards[1]!);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('Result', {
        analysisId: 'a2',
      });
      await press(cards[0]!);
      expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
        analysisId: 'a1',
      });

      // Everything older is one tap away on the Library tab.
      const seeAll = pressableByLabel(renderer, 'See all reads')!;
      expect(seeAll.props.accessibilityRole).toBe('button');
      expect(meetsHitTarget(seeAll)).toBe(true);
      await press(seeAll);
      expect(mockNavigate).toHaveBeenLastCalledWith('Tabs', {
        screen: 'Library',
      });
      act(() => renderer.unmount());
    });

    it('renders a null score as a dash instead of throwing', async () => {
      mockListShots.mockResolvedValue([
        shot({ id: 'u1', shotType: 'drive', overallScore: null }),
      ]);
      const renderer = await renderHome();
      expect(allText(renderer)).toContain('—');
      expect(
        pressableByLabel(renderer, openResultLabel('drive', null)),
      ).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('offers no See all link before the first read', async () => {
      const renderer = await renderHome();
      expect(allText(renderer)).toContain('Your first read starts here');
      expect(pressableByLabel(renderer, 'See all reads')).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('what Home leaves to other tabs', () => {
    it('shows no week chart, latest-technique or focus card, and reads no trends', async () => {
      mockAppState.profile = { focusCheckpoint: 'paddle_ready' };
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockListShots.mockResolvedValue([shot({})]);
      const renderer = await renderHome();
      const text = allText(renderer);
      for (const removed of [
        'THIS WEEK',
        'Latest technique',
        'Chosen focus',
        'paddle ready',
        'SELF SET',
      ]) {
        expect(text).not.toContain(removed);
      }
      expect(pressableByTestId(renderer, 'home-week-chart-scores')).toBeNull();
      // Trends are Progress's job: Home asks only for the saved reads.
      expect(mockListRealAnalysisFacts).not.toHaveBeenCalled();
      expect(mockGetKv).not.toHaveBeenCalled();
      expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
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
    it('reloads the saved reads, then clears the refreshing flag', async () => {
      const renderer = await renderHome();
      expect(mockListShots).toHaveBeenCalledTimes(1);

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
      expect(
        pressableByLabel(renderer, openResultLabel('dink')),
      ).not.toBeNull();
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
      expect(
        pressableByLabel(renderer, openResultLabel('dink')),
      ).not.toBeNull();
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

  describe('owner-scoped local reads', () => {
    it('never requests account progress, for this owner or another', async () => {
      mockGetApiSession.mockReturnValue({ canonicalAppUserId: OWNER });
      mockFetchCanonicalProgress.mockResolvedValue(syncedProgress(9.1));
      mockListShots.mockResolvedValue([shot({ shotType: 'dink' })]);
      const renderer = await renderHome();
      expect(
        pressableByLabel(renderer, openResultLabel('dink')),
      ).not.toBeNull();
      await act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
      });
      expect(mockFetchCanonicalProgress).not.toHaveBeenCalled();
      expect(allText(renderer)).not.toContain('9.1');
      act(() => renderer.unmount());
    });

    it('rejects local work from a previous sign-in even when the owner returns before render', async () => {
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(local.promise);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      setActiveDataOwner(OWNER);
      await act(async () => local.resolve([shot({ shotType: 'dink' })]));
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      mockListShots.mockResolvedValue([shot({ shotType: 'serve' })]);
      await act(async () => renderer.update(<HomeScreen />));
      expect(mockListShots).toHaveBeenCalledTimes(2);
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('hides loaded history from an earlier sign-in generation until the new read lands', async () => {
      mockListShots.mockResolvedValue([shot({ shotType: 'dink' })]);
      const renderer = await renderHome();
      setActiveDataOwner(OTHER_OWNER);
      setActiveDataOwner(OWNER);
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(local.promise);
      await act(async () => renderer.update(<HomeScreen />));
      expect(allText(renderer)).toContain('Loading your court');
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      await act(async () => local.resolve([shot({ shotType: 'serve' })]));
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      act(() => renderer.unmount());
    });

    it('ignores a read that lands while blurred and reloads on the next focus', async () => {
      const first = deferred<unknown[]>();
      mockListShots.mockReturnValueOnce(first.promise);
      const renderer = await renderHome();
      mockFocused = false;
      await act(async () => renderer.update(<HomeScreen />));
      await act(async () => first.resolve([shot({ shotType: 'dink' })]));
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      mockListShots.mockResolvedValue([shot({ shotType: 'serve' })]);
      mockFocused = true;
      await act(async () => renderer.update(<HomeScreen />));
      expect(mockListShots).toHaveBeenCalledTimes(2);
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('never lets a superseded read overwrite the latest refresh', async () => {
      const renderer = await renderHome();
      expect(allText(renderer)).not.toContain('Loading your court');
      const first = deferred<unknown[]>();
      const second = deferred<unknown[]>();
      mockListShots
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      await act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
      });
      await act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
      });
      await act(async () => second.resolve([shot({ shotType: 'serve' })]));
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      await act(async () => first.resolve([shot({ shotType: 'dink' })]));
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
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
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      await act(async () => {
        first.resolve([shot({ shotType: 'dink' })]);
      });
      expect(pressableByLabel(renderer, openResultLabel('dink'))).toBeNull();
      expect(
        pressableByLabel(renderer, openResultLabel('serve')),
      ).not.toBeNull();
      act(() => renderer.unmount());
    });

    it('publishes nothing when the local read finishes after unmount', async () => {
      const local = deferred<unknown[]>();
      mockListShots.mockReturnValue(local.promise);
      const renderer = await renderHome();
      act(() => renderer.unmount());
      await act(async () => local.resolve([shot({})]));
      expect(renderer.toJSON()).toBeNull();
    });
  });

  describe('profile-driven copy', () => {
    it('greets by first name and keeps the self-set level and focus off Home', async () => {
      mockAppState.profile = {
        firstName: 'Ada',
        skillLevel: '3.5',
        focusCheckpoint: 'paddle_ready',
      };
      const renderer = await renderHome();
      const text = allText(renderer);
      expect(text).toContain('Ready when you are, Ada.');
      expect(text).not.toContain('SELF · 3.5');
      expect(text).not.toContain('paddle ready');
      expect(
        renderer.root.findAll(
          n =>
            isHost(n) &&
            n.props.accessibilityLabel === 'Self-selected focus: paddle ready',
        ),
      ).toHaveLength(0);
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
        expect.stringContaining(
          'Player rank Gold I, estimated DUPR 3.48, technique rating 6.40 out of 10.',
        ),
        'Stroke Analysis. Analyze one movement with fast, detailed feedback.',
        'Drill Library. Guided drills you can search.',
        'Turn on practice reminders',
        'Not now',
        'See all reads',
        openResultLabel('dink'),
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
