import '../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import * as Components from '../src/design/components';
import { space, type } from '../src/design/tokens';
import {
  Dimensions,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
} from 'react-native';
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
  type Metrics,
} from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { Circle, Defs, Path, Rect } from 'react-native-svg';
import { ConsistencyCard } from '../src/consistency/ConsistencyCard';
import * as Reanimated from 'react-native-reanimated';
import { AnimatedFlame, FlameIcon } from '../src/consistency/FlameIcon';
import {
  badgeArtFor,
  LOCKED_RIM,
  MilestoneBadge,
  numeralWidth,
  RARITY_PALETTE,
} from '../src/consistency/MilestoneBadge';
import {
  achievementBadgePlaque,
  achievementBadgeShapes,
} from '../src/consistency/achievementBadgeArt';
import {
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
} from '../src/consistency/milestones';
import {
  achievementLocked,
  achievementRarity,
  color,
  type as typography,
} from '../src/design/tokens';

// The consistency store persists through SQLite; the native module is absent
// under jest and these tests only drive the overlay through store state.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

let mockReducedMotion = false;
jest.mock('../src/design/components', () => ({
  ...jest.requireActual('../src/design/components'),
  useReducedMotion: () => mockReducedMotion,
}));

let mockInitialWindowMetrics: Metrics | null = null;
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  get initialWindowMetrics() {
    return mockInitialWindowMetrics;
  },
}));

import { StreakCelebration } from '../src/consistency/StreakCelebration';
import { DaySecuredBanner } from '../src/consistency/DaySecuredBanner';
import { useConsistencyStore } from '../src/consistency/store';
import type {
  ConsistencyCelebration,
  DaySecuredMoment,
} from '../src/consistency/store';

const consumeDaySecured = useConsistencyStore.getState().consumeDaySecured;

const thirtyDayClub: ConsistencyCelebration = {
  kind: 'streak',
  achievementId: 'streak.30',
  title: '30 Day Club',
  blurb: 'A month of showing up. Very few do this.',
  reward: 'Exclusive profile frame',
  rarity: 'epic',
  value: 30,
  streakAtCelebration: 30,
};

beforeEach(() => {
  mockInitialWindowMetrics = null;
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width: 375,
    height: 667,
    scale: 2,
    fontScale: 1,
  });
});

afterEach(() => {
  useConsistencyStore.setState({
    celebration: null,
    daySecured: null,
    consumeDaySecured,
  });
  mockReducedMotion = false;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function withSafeArea(
  children: React.ReactNode,
  insets: EdgeInsets = { top: 59, bottom: 34, left: 0, right: 0 },
) {
  return (
    <SafeAreaInsetsContext.Provider value={insets}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
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

describe('StreakCelebration layout contracts (not native viewport proof)', () => {
  test.each([
    {
      width: 375,
      height: 667,
      fontScale: 1,
      top: 20,
      bottom: 0,
      side: 0,
      reduced: false,
    },
    {
      width: 375,
      height: 667,
      fontScale: 1.353,
      top: 20,
      bottom: 0,
      side: 0,
      reduced: true,
    },
    {
      width: 375,
      height: 667,
      fontScale: 3.12,
      top: 20,
      bottom: 0,
      side: 0,
      reduced: false,
    },
    {
      width: 375,
      height: 667,
      fontScale: 3.571,
      top: 20,
      bottom: 0,
      side: 0,
      reduced: true,
    },
    {
      width: 320,
      height: 568,
      fontScale: 3.571,
      top: 44,
      bottom: 34,
      side: 0,
      reduced: true,
    },
    {
      width: 667,
      height: 375,
      fontScale: 3.571,
      top: 0,
      bottom: 21,
      side: 44,
      reduced: false,
    },
  ])(
    'keeps milestone and reward copy in scroll, outside the safe action at $width×$height / $fontScale / reduced=$reduced',
    async ({ width, height, fontScale, top, bottom, side, reduced }) => {
      const previous = {
        window: Dimensions.get('window'),
        screen: Dimensions.get('screen'),
      };
      Dimensions.set({
        window: { width, height, fontScale, scale: 2 },
        screen: { width, height, fontScale, scale: 2 },
      });
      mockInitialWindowMetrics = {
        frame: { x: 0, y: 0, width, height },
        insets: { top, bottom, left: side, right: side },
      };
      const motion = jest
        .spyOn(Components, 'useReducedMotion')
        .mockReturnValue(reduced);
      useConsistencyStore.setState({ celebration: thirtyDayClub });
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          renderer = TestRenderer.create(
            <SafeAreaInsetsContext.Provider
              value={{ top, bottom, left: side, right: side }}
            >
              <StreakCelebration />
            </SafeAreaInsetsContext.Provider>,
          );
        });
        const host = (testID: string) =>
          renderer.root.findAll(
            node =>
              node.props.testID === testID && typeof node.type === 'string',
          )[0]!;
        const scroll = renderer.root.findByType(ScrollView);
        expect(scroll.props.scrollEnabled).not.toBe(false);
        expect(scroll.props.horizontal).not.toBe(true);
        expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never');
        expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        });
        expect(
          StyleSheet.flatten(scroll.props.contentContainerStyle),
        ).toMatchObject({
          flexGrow: 1,
          alignItems: 'center',
        });
        expect(
          scroll.findAll(
            node => node.props.testID === 'streak-celebration-continue',
          ),
        ).toHaveLength(0);
        const actions = host('streak-celebration-actions');
        expect(StyleSheet.flatten(actions.props.style)).toMatchObject({
          flexShrink: 0,
        });
        expect(actions.findAllByType(Components.Button)).toHaveLength(1);
        expect(
          StyleSheet.flatten(
            host('streak-celebration-safe-content').props.style,
          ),
        ).toMatchObject({
          flex: 1,
          paddingTop: Math.max(top, space.md),
          paddingBottom: Math.max(bottom, space.lg),
          paddingLeft: side + space.xl,
          paddingRight: side + space.xl,
        });
        expect(
          StyleSheet.flatten(host('streak-celebration').props.style),
        ).toMatchObject({
          overflow: 'hidden',
        });
        expect(
          StyleSheet.flatten(host('streak-celebration-stage').props.style),
        ).toMatchObject({
          width: '100%',
          maxWidth: 320,
          minHeight: 188,
        });
        const texts = scroll.findAllByType(Text);
        for (const copy of [
          thirtyDayClub.title,
          thirtyDayClub.blurb,
          thirtyDayClub.reward,
          '30 days of real training',
        ]) {
          expect(texts.some(node => node.props.children === copy)).toBe(true);
        }
        const headline = texts.find(
          node => node.props.children === thirtyDayClub.title,
        )!;
        expect(StyleSheet.flatten(headline.props.style)).toMatchObject(type.h1);
        expect(headline.props.accessibilityRole).toBe('header');
        const reward = texts.find(
          node => node.props.children === thirtyDayClub.reward,
        )!;
        expect(StyleSheet.flatten(reward.props.style)).toMatchObject({
          flexShrink: 1,
          minWidth: 0,
        });
        expect(
          StyleSheet.flatten(host('streak-celebration-reward').props.style),
        ).toMatchObject({ maxWidth: '100%' });
        for (const text of [...texts, ...actions.findAllByType(Text)]) {
          expect(text.props.allowFontScaling).not.toBe(false);
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          expect(text.props.numberOfLines).toBeUndefined();
        }
        const label = actions
          .findAllByType(Text)
          .find(node => node.props.children === 'Keep training')!;
        expect(StyleSheet.flatten(label.props.style)).toMatchObject({
          ...type.bodyBold,
          flexShrink: 1,
          minWidth: 0,
          textAlign: 'center',
        });
      } finally {
        if (renderer) act(() => renderer.unmount());
        motion.mockRestore();
        Dimensions.set(previous);
      }
    },
  );
});

describe('StreakCelebration', () => {
  it.each([
    { width: 375, height: 667, rawTop: 59, rawBottom: 34 },
    { width: 393, height: 852, rawTop: 59, rawBottom: 34 },
    { width: 375, height: 667, rawTop: 0, rawBottom: 0 },
    { width: 393, height: 852, rawTop: 0, rawBottom: 0 },
  ])(
    'applies modal padding at $width pt / 3.571x with raw insets $rawTop/$rawBottom',
    ({ width, height, rawTop, rawBottom }) => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width,
        height,
        scale: width === 375 ? 2 : 3,
        fontScale: 3.571,
      });
      mockReducedMotion = true;
      mockInitialWindowMetrics =
        rawTop === 0
          ? {
              frame: { x: 0, y: 0, width, height },
              insets: { top: 59, bottom: 34, left: 0, right: 0 },
            }
          : null;
      useConsistencyStore.setState({ celebration: thirtyDayClub });
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          withSafeArea(<StreakCelebration />, {
            top: rawTop,
            bottom: rawBottom,
            left: 0,
            right: 0,
          }),
        );
      });
      try {
        const root = renderer.root.findAll(
          node =>
            node.props.testID === 'streak-celebration-safe-content' &&
            typeof node.type === 'string',
        )[0]!;
        expect(StyleSheet.flatten(root.props.style)).toMatchObject({
          flex: 1,
          paddingTop: 59,
          paddingBottom: 34,
        });
        const scroll = renderer.root.findByType(ScrollView);
        expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
          flex: 1,
          minHeight: 0,
        });
        expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never');
        expect(scroll.props.automaticallyAdjustContentInsets).toBe(false);
        expect(
          scroll.findAll(
            node => node.props.testID === 'streak-celebration-continue',
          ),
        ).toHaveLength(0);
        expect(renderer.root.findByType(StatusBar).props.barStyle).toBe(
          'light-content',
        );
        expect(allText(renderer)).toContain('30 days of real training');
        expect(allText(renderer)).toContain('Exclusive profile frame');
        const dismiss = renderer.root.findByProps({
          testID: 'ceremony-overlay',
        }).props.onAccessibilityEscape;
        const backdrop = renderer.root.findAll(
          node =>
            node.props.accessibilityLabel === 'Dismiss milestone celebration' &&
            node.props.onPress,
        )[0]!;
        const cta = renderer.root.findAll(
          node =>
            node.props.testID === 'streak-celebration-continue' &&
            node.props.onPress,
        )[0]!;
        expect(backdrop.props.onPress).toBe(dismiss);
        expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
        expect(cta.props.onPress).toBe(dismiss);
        act(() => cta.props.onPress());
        expect(useConsistencyStore.getState().celebration).toBeNull();
        expect(renderer.root.findAllByType(StatusBar)).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it.each([1.8, 3.571])(
    'keeps all facts scrollable and the CTA outside the scroll at font scale %s',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });
      useConsistencyStore.setState({ celebration: thirtyDayClub });
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(withSafeArea(<StreakCelebration />));
      });
      try {
        const scroll = renderer.root.findByType(ScrollView);
        expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
          flex: 1,
        });
        expect(
          scroll.findAll(
            node => node.props.testID === 'streak-celebration-continue',
          ),
        ).toHaveLength(0);
        expect(allText(renderer)).toContain('30 days of real training');
        expect(allText(renderer)).toContain('Exclusive profile frame');
        for (const text of scroll.findAllByType(Text)) {
          expect(text.props.numberOfLines).toBeUndefined();
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          expect(text.props.allowFontScaling).not.toBe(false);
        }
        const cta = renderer.root.findAll(
          node =>
            node.props.testID === 'streak-celebration-continue' &&
            node.props.onPress,
        )[0]!;
        act(() => cta.props.onPress());
        expect(useConsistencyStore.getState().celebration).toBeNull();
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it.each([false, true])(
    'uses one brief entry with no ornamental layer and preserves facts (reduced=%s)',
    reduced => {
      mockReducedMotion = reduced;
      const timing = jest.spyOn(Reanimated, 'withTiming');
      const repeat = jest.spyOn(Reanimated, 'withRepeat');
      const cancel = jest.spyOn(Reanimated, 'cancelAnimation');
      useConsistencyStore.setState({ celebration: thirtyDayClub });
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(withSafeArea(<StreakCelebration />));
      });
      expect(renderer.root.findAllByType(Defs)).toHaveLength(0);
      expect(repeat).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain('30 days of real training');
      expect(allText(renderer)).toContain('EPIC');
      expect(allText(renderer)).toContain('Exclusive profile frame');
      if (reduced) {
        expect(timing).not.toHaveBeenCalledWith(
          1,
          expect.objectContaining({ duration: 220 }),
        );
        const content = renderer.root.findAll(
          node =>
            node.props.testID === 'streak-celebration-safe-content' &&
            typeof node.type === 'string',
        )[0]!;
        expect(StyleSheet.flatten(content.props.style)).toMatchObject({
          opacity: 1,
          transform: [{ translateY: 0 }],
        });
      } else {
        expect(timing).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ duration: 220 }),
        );
      }
      act(() => renderer.unmount());
      expect(cancel).toHaveBeenCalled();
    },
  );

  it('renders nothing without a pending milestone', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<StreakCelebration />));
    });
    expect(
      renderer.root.findAll(node => node.props.testID === 'streak-celebration'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('presents the milestone facts and dismisses through Continue', async () => {
    useConsistencyStore.setState({ celebration: thirtyDayClub });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<StreakCelebration />));
    });
    const copy = allText(renderer);
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(copy).toContain('30 Day Club');
    expect(copy).toContain('Exclusive profile frame');
    expect(copy).toContain('EPIC');
    expect(copy).toContain('30 days of real training');

    const cta = renderer.root.findAll(
      node =>
        node.props.testID === 'streak-celebration-continue' &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      cta.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });

  it('titles volume achievements with their technique detail', () => {
    useConsistencyStore.setState({
      celebration: {
        kind: 'volume',
        achievementId: 'volume.specialist',
        title: 'serve Specialist',
        blurb: 'Twenty-five scored analyses of a single stroke.',
        reward: 'Technique crest',
        rarity: 'rare',
        value: 25,
        streakAtCelebration: 4,
        detail: 'serve',
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<StreakCelebration />));
    });
    const copy = allText(renderer);
    expect(copy).toContain('Serve Specialist');
    expect(copy).not.toContain('serve Specialist');
    expect(copy).toContain('25 scored serve analyses');
    act(() => renderer.unmount());
  });
});

describe('DaySecuredBanner', () => {
  it('keeps the once-consumed day and XP acknowledgment, then clears after its reduced-motion hold', () => {
    jest.useFakeTimers();
    mockReducedMotion = true;
    const moment: DaySecuredMoment = {
      day: '2026-03-10',
      streak: 3,
      xpToday: 25,
      shieldsAvailable: 0,
      nextMilestone: { title: 'Week One', daysAway: 4 },
    };
    const consume = jest.fn(() => {
      useConsistencyStore.setState({ daySecured: null });
      return moment;
    });
    useConsistencyStore.setState({
      daySecured: moment,
      consumeDaySecured: consume,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<DaySecuredBanner />));
    });
    const hosts = () =>
      renderer.root.findAll(
        node =>
          node.props.testID === 'day-secured-banner' &&
          typeof node.type === 'string',
      );
    expect(consume).toHaveBeenCalledTimes(1);
    expect(hosts()).toHaveLength(1);
    expect(hosts()[0]!.props.accessibilityLabel).toBe(
      'Day 3 secured. Plus 25 momentum XP. Next: Week One — 4 days away.',
    );
    expect(hosts()[0]!.props.pointerEvents).toBe('none');
    expect(renderer.root.findByType(FlameIcon).props.dark).toBe(true);
    expect(StyleSheet.flatten(hosts()[0]!.props.style)).toMatchObject({
      backgroundColor: color.inkElevated,
      borderColor: color.lineMutedDark,
      opacity: 1,
      transform: [{ translateY: 0 }],
    });
    act(() => jest.advanceTimersByTime(3599));
    expect(hosts()).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(hosts()).toHaveLength(0);
    expect(consume).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

describe('flat milestone insignia', () => {
  const ALL = [...STREAK_MILESTONES, ...Object.values(VOLUME_ACHIEVEMENTS)];

  /** Every paint an SVG mark on the badge uses (fills and strokes). */
  function paintsOf(renderer: TestRenderer.ReactTestRenderer): string[] {
    const marks = [
      ...renderer.root.findAllByType(Path),
      ...renderer.root.findAllByType(Circle),
      ...renderer.root.findAllByType(Rect),
    ];
    return [
      ...new Set(
        marks
          .flatMap(mark => [mark.props.fill, mark.props.stroke])
          .filter(
            (paint): paint is string =>
              typeof paint === 'string' && paint !== 'none',
          ),
      ),
    ].sort();
  }

  it('keeps a 40pt badge’s uncapped micro numeral inside its ribbon banner', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MilestoneBadge
          glyph="shieldFlame"
          value="7"
          rarity="uncommon"
          earned={false}
          size={40}
        />,
      );
    });
    try {
      const value = renderer.root.findByType(Text);
      const valueStyle = StyleSheet.flatten(value.props.style);
      expect(valueStyle.fontSize).toBe(typography.micro.fontSize);
      expect(value.props.maxFontSizeMultiplier).toBeUndefined();
      const panel = renderer.root.findAll(
        node =>
          node.props.testID === 'milestone-value' &&
          typeof node.type === 'string',
      )[0]!;
      const panelStyle = StyleSheet.flatten(panel.props.style);
      // Laid exactly over the shield's own banner …
      const plaque = achievementBadgePlaque('shieldFlame')!;
      expect(panelStyle.position).toBe('absolute');
      expect(panelStyle.left).toBeCloseTo((plaque.x * 40) / 96, 5);
      expect(panelStyle.top).toBeCloseTo((plaque.y * 40) / 96, 5);
      expect(panelStyle.width).toBeCloseTo((plaque.w * 40) / 96, 5);
      expect(panelStyle.height).toBeCloseTo((plaque.h * 40) / 96, 5);
      // … and the digit's cap height fits the banner with room to spare.
      expect(valueStyle.fontSize * 0.72).toBeLessThanOrEqual(panelStyle.height);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it.each([40, 64, 148])(
    'flows the complete numeral below size %s artwork when scaled text no longer fits',
    size => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width: 375,
        height: 667,
        scale: 2,
        fontScale: 3.571,
      });
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <MilestoneBadge
            glyph="phoenix"
            value="365"
            rarity="mythic"
            earned
            size={size}
          />,
        );
      });
      try {
        const value = renderer.root.findByType(Text);
        expect(value.props.children).toBe('365');
        expect(value.props.maxFontSizeMultiplier).toBeUndefined();
        expect(value.props.allowFontScaling).not.toBe(false);
        expect(value.props.numberOfLines).toBeUndefined();
        const panel = renderer.root.findAll(
          node =>
            node.props.testID === 'milestone-value' &&
            typeof node.type === 'string',
        )[0]!;
        const style = StyleSheet.flatten(panel.props.style);
        expect(style.position).not.toBe('absolute');
        expect(style.height).toBeUndefined();
        expect(style.backgroundColor).toBe(color.inkElevated);
        // The banner is not drawn under a numeral that has left it: the
        // art is exactly the plate's own shapes.
        expect(
          renderer.root.findAllByType(Path).length +
            renderer.root.findAllByType(Circle).length +
            renderer.root.findAllByType(Rect).length,
        ).toBe(achievementBadgeShapes('phoenix', false).length);
        expect(achievementBadgeShapes('phoenix', true).length).toBeGreaterThan(
          achievementBadgeShapes('phoenix', false).length,
        );
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it.each(ALL)(
    'casts $id in its rarity’s material when earned and in charcoal with a dashed rim when locked',
    milestone => {
      const art = badgeArtFor(milestone.id);
      const material = achievementRarity[milestone.rarity];
      expect(RARITY_PALETTE[milestone.rarity]).toMatchObject({
        accent: material.accent,
        deep: material.deep,
        tint: material.tint,
      });
      for (const earned of [false, true]) {
        let renderer!: TestRenderer.ReactTestRenderer;
        act(() => {
          renderer = TestRenderer.create(
            <MilestoneBadge
              {...art}
              rarity={milestone.rarity}
              earned={earned}
              size={64}
            />,
          );
        });
        try {
          const palette = earned ? material : achievementLocked;
          const allowed = new Set(
            earned
              ? [
                  palette.deep,
                  palette.base,
                  palette.light,
                  palette.bright,
                  color.surfaceDark,
                ]
              : [
                  palette.deep,
                  palette.base,
                  palette.light,
                  palette.bright,
                  palette.accent,
                ],
          );
          const paints = paintsOf(renderer);
          expect(paints.length).toBeGreaterThanOrEqual(3);
          for (const paint of paints) expect(allowed).toContain(paint);
          // Flat: no gradient definitions anywhere in the badge.
          expect(renderer.root.findAllByType(Defs)).toHaveLength(0);
          // The locked silhouette wears the dashed rim; nothing else does.
          const dashed = [
            ...renderer.root.findAllByType(Path),
            ...renderer.root.findAllByType(Circle),
            ...renderer.root.findAllByType(Rect),
          ].filter(node => node.props.strokeDasharray !== undefined);
          expect(dashed).toHaveLength(earned ? 0 : 1);
          if (!earned) {
            expect(dashed[0]!.props).toMatchObject({
              stroke: achievementLocked.accent,
              strokeDasharray: LOCKED_RIM.dash,
            });
          }
          if (art.value !== undefined) {
            const value = renderer.root.findByType(Text);
            expect(value.props.children).toBe(art.value);
            expect(StyleSheet.flatten(value.props.style).color).toBe(
              earned ? material.bright : achievementLocked.accent,
            );
          } else {
            expect(renderer.root.findAllByType(Text)).toHaveLength(0);
          }
        } finally {
          act(() => renderer.unmount());
        }
      }
    },
  );

  it('gives every achievement its own silhouette and emblem — no two badges share a drawing', () => {
    const drawings = ALL.map(milestone => {
      const art = badgeArtFor(milestone.id);
      return JSON.stringify(
        achievementBadgeShapes(art.glyph, art.value !== undefined),
      );
    });
    expect(new Set(drawings).size).toBe(ALL.length);
    // Every numbered badge wears its own ribbon banner; First Spark, which
    // has no value, stands alone.
    for (const milestone of ALL) {
      const art = badgeArtFor(milestone.id);
      const shapes = achievementBadgeShapes(art.glyph, art.value !== undefined);
      expect(shapes.some(shape => shape.fill === 'plaque')).toBe(
        art.value !== undefined,
      );
      expect(achievementBadgePlaque(art.glyph) !== null).toBe(
        art.value !== undefined,
      );
    }
    expect(badgeArtFor('streak.1').value).toBeUndefined();
  });

  it('sizes every banner for its own numeral in every size role, digits ≥ 2 units clear of the ends', () => {
    // The renderer picks micro under 64pt, h3 from 64pt and score from
    // 120pt; the sizes below are the ones the app renders (next-reward chip,
    // Century advert, showcase rail, default, celebration). Widths use the
    // bundled Manrope Bold's real digit advances.
    const roles = [
      [48, typography.micro],
      [54, typography.micro],
      [64, typography.h3],
      [72, typography.h3],
      [148, typography.score],
    ] as const;
    for (const milestone of ALL) {
      const art = badgeArtFor(milestone.id);
      if (art.value === undefined) continue;
      const plaque = achievementBadgePlaque(art.glyph)!;
      for (const [size, role] of roles) {
        const unit = size / 96;
        const width = numeralWidth(art.value, role, 1);
        expect(width).toBeLessThanOrEqual((plaque.w - 4) * unit);
        expect(role.fontSize * 0.72).toBeLessThanOrEqual((plaque.h - 1) * unit);
      }
    }
  });

  it('flows a three-digit numeral under a 40pt badge, where no banner could hold it legibly', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MilestoneBadge
          glyph="phoenix"
          value="365"
          rarity="mythic"
          earned
          size={40}
        />,
      );
    });
    const panel = renderer.root.findAll(
      node =>
        node.props.testID === 'milestone-value' &&
        typeof node.type === 'string',
    )[0]!;
    expect(StyleSheet.flatten(panel.props.style).position).not.toBe('absolute');
    expect(renderer.root.findByType(Text).props.children).toBe('365');
    act(() => renderer.unmount());
  });

  it.each([48, 54, 64, 72, 148])(
    'keeps badge numerals readable at size %s',
    size => {
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <MilestoneBadge
            glyph="phoenix"
            value="365"
            rarity="mythic"
            earned
            size={size}
          />,
        );
      });
      const value = renderer.root.findByType(Text);
      expect(value.props.children).toBe('365');
      expect(
        StyleSheet.flatten(value.props.style).fontSize,
      ).toBeGreaterThanOrEqual(typography.micro.fontSize);
      // At the default font scale the widest numeral still sits on the banner.
      const panel = renderer.root.findAll(
        node =>
          node.props.testID === 'milestone-value' &&
          typeof node.type === 'string',
      )[0]!;
      expect(StyleSheet.flatten(panel.props.style).position).toBe('absolute');
      act(() => renderer.unmount());
    },
  );
});

describe('static training flame', () => {
  it.each([false, true])(
    'uses a context-safe zero-state outline (dark=%s)',
    dark => {
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <AnimatedFlame intensity={0} dark={dark} />,
        );
      });
      try {
        expect(renderer.root.findByType(FlameIcon).props.dark).toBe(dark);
        expect(renderer.root.findByType(Path).props.stroke).toBe(
          dark ? color.onDarkSubtle : color.inkSoft,
        );
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('threads dark context through the empty consistency card', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ConsistencyCard snapshot={null} onPress={() => {}} />,
      );
    });
    expect(renderer.root.findByType(FlameIcon).props.dark).toBe(true);
    act(() => renderer.unmount());
  });

  it.each([0, 1, 2, 3, 4, 5] as const)(
    'retains intensity %s and size without scheduling an idle animation',
    intensity => {
      const repeat = jest.spyOn(Reanimated, 'withRepeat');
      const timing = jest.spyOn(Reanimated, 'withTiming');
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <AnimatedFlame intensity={intensity} size={26} />,
        );
      });
      expect(renderer.root.findByType(FlameIcon).props).toMatchObject({
        intensity,
        size: 26,
      });
      const paths = renderer.root.findAllByType(Path);
      expect(paths[0]!.props.fill).toBe(intensity === 0 ? 'none' : color.flame);
      expect(paths[0]!.props.stroke).toBe(
        intensity === 0 ? color.inkSoft : color.inkElevated,
      );
      expect(paths).toHaveLength(intensity > 1 ? 2 : 1);
      if (intensity > 1) expect(paths[1]!.props.fill).toBe(color.inkElevated);
      expect(renderer.root.findAllByType(Defs)).toHaveLength(0);
      expect(repeat).not.toHaveBeenCalled();
      expect(timing).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    },
  );
});
