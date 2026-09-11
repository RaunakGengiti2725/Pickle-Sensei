import '../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
import TestRenderer, { act } from 'react-test-renderer';
import * as Components from '../src/design/components';
import {
  space,
  type,
  color,
  rankTier,
  type as typography,
} from '../src/design/tokens';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('node:path') as {
  join: (...parts: string[]) => string;
};
import { RankIcon, RANK_TIER_STYLE } from '../src/components/RankIcon';
import {
  RANK_BADGE_VIEWBOX,
  RANK_TIER_MARK_VIEWBOX,
} from '../src/components/rankInsigniaArt';

// The celebration store persists through SQLite; the native module is absent
// under jest and none of these tests exercise persistence.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { RankUpCelebration } from '../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../src/progress/rankCelebration';

/**
 * Ceremony surface smoke tests: the overlay renders the promotion facts,
 * offers Continue and a backdrop dismiss, and unmounts cleanly. Animation
 * timing itself is not asserted — reduced-motion parity keeps the layout
 * identical at rest.
 */

const diamondSummary: PlayerRankSummary = {
  rating: 7.62,
  tier: 'diamond',
  tierLabel: 'Diamond',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 3,
  scoredAnalysisCount: 9,
  techniques: [],
  nextTier: null,
};

function setCelebration(fromTier: 'platinum' | null) {
  useRankCelebrationStore.setState({
    current: {
      fromTier,
      toTier: 'diamond',
      fromRating: fromTier ? 7.1 : null,
      summary: diamondSummary,
    },
  });
}

afterEach(() => {
  useRankCelebrationStore.setState({ current: null });
});

function withSafeArea(children: React.ReactNode) {
  return (
    <SafeAreaInsetsContext.Provider
      value={{ top: 59, bottom: 34, left: 0, right: 0 }}
    >
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

function hostNodes(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

describe('RankUpCelebration layout contracts (not native viewport proof)', () => {
  const cases = [
    { width: 375, height: 667, fontScale: 1, top: 20, bottom: 0, side: 0 },
    { width: 375, height: 667, fontScale: 1.353, top: 20, bottom: 0, side: 0 },
    { width: 375, height: 667, fontScale: 3.12, top: 20, bottom: 0, side: 0 },
    { width: 375, height: 667, fontScale: 3.571, top: 20, bottom: 0, side: 0 },
    { width: 320, height: 568, fontScale: 3.571, top: 44, bottom: 34, side: 0 },
    { width: 667, height: 375, fontScale: 3.571, top: 0, bottom: 21, side: 44 },
  ];

  test.each(cases)(
    'contains the scrolling body and reserves the safe action at $width×$height / $fontScale',
    async ({ width, height, fontScale, top, bottom, side }) => {
      const previous = {
        window: Dimensions.get('window'),
        screen: Dimensions.get('screen'),
      };
      Dimensions.set({
        window: { width, height, fontScale, scale: 2 },
        screen: { width, height, fontScale, scale: 2 },
      });
      const motion = jest
        .spyOn(Components, 'useReducedMotion')
        .mockReturnValue(true);
      setCelebration(null);
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          renderer = TestRenderer.create(
            <SafeAreaInsetsContext.Provider
              value={{ top, bottom, left: side, right: side }}
            >
              <RankUpCelebration />
            </SafeAreaInsetsContext.Provider>,
          );
        });
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
        ).toMatchObject({ flexGrow: 1, alignItems: 'center' });
        expect(
          scroll.findAll(node => node.props.testID === 'rank-up-continue'),
        ).toHaveLength(0);
        const actions = hostNodes(renderer, 'rank-up-actions')[0]!;
        expect(StyleSheet.flatten(actions.props.style)).toMatchObject({
          flexShrink: 0,
        });
        expect(actions.findAllByType(Components.Button)).toHaveLength(1);
        const shell = hostNodes(renderer, 'rank-up-safe-content')[0]!;
        expect(StyleSheet.flatten(shell.props.style)).toMatchObject({
          flex: 1,
          paddingTop: Math.max(top, space.md),
          paddingBottom: Math.max(bottom, space.lg),
          paddingLeft: side + space.xl,
          paddingRight: side + space.xl,
        });
        expect(
          StyleSheet.flatten(
            hostNodes(renderer, 'rank-up-stage')[0]!.props.style,
          ),
        ).toMatchObject({
          width: '100%',
          maxWidth: 320,
          minHeight: 180,
          flexWrap: 'wrap',
        });
        expect(
          StyleSheet.flatten(
            hostNodes(renderer, 'rank-up-celebration')[0]!.props.style,
          ),
        ).toMatchObject({ overflow: 'hidden' });
        const headline = scroll
          .findAllByType(Text)
          .find(node => node.props.children === 'You’re on the board.')!;
        expect(StyleSheet.flatten(headline.props.style)).toMatchObject(type.h1);
        expect(headline.props.accessibilityRole).toBe('header');
        for (const text of scroll.findAllByType(Text)) {
          expect(text.props.allowFontScaling).not.toBe(false);
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          if (text.props.testID !== 'rank-up-rating') {
            expect(text.props.numberOfLines).toBeUndefined();
          }
        }
        const label = actions
          .findAllByType(Text)
          .find(node => node.props.children === 'Continue')!;
        expect(StyleSheet.flatten(label.props.style)).toMatchObject({
          ...type.bodyBold,
          flexShrink: 1,
          minWidth: 0,
        });
        expect(label.props.numberOfLines).toBeUndefined();
      } finally {
        if (renderer) act(() => renderer.unmount());
        motion.mockRestore();
        Dimensions.set(previous);
      }
    },
  );

  it('keeps the reflowing estimated-DUPR numeral (7.02 → 3.35) over the /10 line and uncapped remaining-points copy', async () => {
    const previous = {
      window: Dimensions.get('window'),
      screen: Dimensions.get('screen'),
    };
    Dimensions.set({
      window: { width: 375, height: 667, fontScale: 3.571, scale: 2 },
      screen: { width: 375, height: 667, fontScale: 3.571, scale: 2 },
    });
    const motion = jest
      .spyOn(Components, 'useReducedMotion')
      .mockReturnValue(true);
    useRankCelebrationStore.setState({
      current: {
        fromTier: 'gold',
        toTier: 'platinum',
        fromRating: 6.4,
        summary: {
          ...diamondSummary,
          rating: 7.02,
          tier: 'platinum',
          tierLabel: 'Platinum',
          nextTier: {
            key: 'diamond',
            label: 'Diamond',
            minRating: 7.5,
            pointsNeeded: 0.48,
          },
        },
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
      });
      // D-046: the big numeral is the estimated DUPR (7.02 → 3.35) with its
      // unit; the 0–10 rating is the smaller line beneath it.
      const rating = renderer.root
        .findAllByType(Text)
        .find(node => node.props.testID === 'rank-up-rating')!;
      expect(rating.props).toMatchObject({
        accessibilityLabel:
          'Estimated DUPR 3.35, technique rating 7.02 out of 10',
      });
      expect(rating.props.numberOfLines).toBeUndefined();
      expect(rating.props.adjustsFontSizeToFit).not.toBe(true);
      expect(rating.props.children[0]).toBe('3.35');
      expect(
        rating
          .findAllByType(Text)
          .some(node => node.props.children === ' DUPR'),
      ).toBe(true);
      expect(StyleSheet.flatten(rating.props.style)).toMatchObject({
        ...type.score,
        maxWidth: '100%',
      });
      const technique = renderer.root
        .findAllByType(Text)
        .find(node => node.props.testID === 'rank-up-technique-rating')!;
      expect(technique.props.children).toBe('7.02 /10');
      expect(StyleSheet.flatten(technique.props.style)).toMatchObject(
        type.micro,
      );
      const scroll = renderer.root.findByType(ScrollView);
      const texts = scroll.findAllByType(Text);
      expect(texts.some(node => /≈/.test(String(node.props.children)))).toBe(
        false,
      );
      // 7.02 → 3.35 against Diamond's 7.5 → 3.67: 0.32 DUPR to go.
      expect(
        texts.some(
          node =>
            node.props.children === '0.32 to Diamond. Every analysis moves it.',
        ),
      ).toBe(true);
    } finally {
      if (renderer) act(() => renderer.unmount());
      motion.mockRestore();
      Dimensions.set(previous);
    }
  });
});

describe('RankUpCelebration', () => {
  it('renders nothing without a pending celebration', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows the promotion facts for platinum → diamond', async () => {
    setCelebration('platinum');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Diamond unlocked');
    expect(text).toContain('RANK UP');
    expect(text).toContain('Top tier');
    act(() => renderer.unmount());
  });

  it('uses placement copy for a first-ever rank', async () => {
    setCelebration(null);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('You’re on the board.');
    expect(text).toContain('PLACED');
    act(() => renderer.unmount());
  });

  it('Continue dismisses the ceremony', async () => {
    setCelebration('platinum');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    const continueButton = renderer.root.findAll(
      node => node.props.testID === 'rank-up-continue' && node.props.onPress,
    )[0]!;
    await act(async () => {
      continueButton.props.onPress();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    act(() => renderer.unmount());
  });
});

/** Geometry-only fingerprint of a rendered insignia, plus the paints it
 * used, in draw order. */
function insignia(node: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  const marks = renderer.root.findAll(
    candidate =>
      candidate.type === Path ||
      candidate.type === Circle ||
      candidate.type === Rect,
  );
  const silhouette = JSON.stringify(
    marks.map(mark => {
      const { d, cx, cy, r, x, y, width, height } = mark.props;
      return { d, cx, cy, r, x, y, width, height };
    }),
  );
  const paints = new Set<string>(
    marks
      .flatMap(mark => [mark.props.fill, mark.props.stroke])
      .filter(paint => paint && paint !== 'none'),
  );
  const numeralBars = marks.filter(
    mark => mark.type === Rect && mark.props.height === 5.6,
  ).length;
  const json = JSON.stringify(renderer.toJSON());
  act(() => renderer.unmount());
  return { count: marks.length, silhouette, paints, numeralBars, json };
}

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [foreground, background]
    .map(relativeLuminance)
    .sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe('rank insignia', () => {
  const divisions = [3, 2, 1] as const;

  it('gives every tier its own material, drawn only from that tier’s tokens', () => {
    const accents = new Set<string>();
    for (const tier of PLAYER_RANK_TIERS) {
      const material = rankTier[tier.key];
      expect(RANK_TIER_STYLE[tier.key]).toBe(material);
      expect(
        contrast(material.accent, color.surfaceDark),
      ).toBeGreaterThanOrEqual(4.5);
      accents.add(material.accent);
      const allowed = new Set<string>([
        material.deep,
        material.base,
        material.light,
        material.bright,
        color.ink,
      ]);
      for (const division of [null, ...divisions]) {
        const badge = insignia(
          <RankIcon tier={tier.key} division={division} size={44} />,
        );
        for (const paint of badge.paints) expect(allowed).toContain(paint);
        expect(badge.paints).not.toContain(color.volt);
      }
    }
    expect(accents.size).toBe(PLAYER_RANK_TIERS.length);
  });

  it('renders fifteen distinct division badges plus five distinct tier marks', () => {
    const silhouettes = new Set<string>();
    for (const tier of PLAYER_RANK_TIERS) {
      const mark = insignia(<RankIcon tier={tier.key} size={44} />);
      expect(mark.json).toContain(`"${tier.label} rank emblem"`);
      expect(mark.numeralBars).toBe(0);
      silhouettes.add(mark.silhouette);
      let previousCount = mark.count;
      for (const division of divisions) {
        const badge = insignia(
          <RankIcon tier={tier.key} division={division} size={44} />,
        );
        expect(badge.json).toContain(
          `"${tier.label} ${['', 'I', 'II', 'III'][division]} rank emblem"`,
        );
        // The plaque spells the same numeral the copy uses …
        expect(badge.numeralBars).toBe(division);
        // … and ornament grows as the player climbs III → II → I.
        expect(badge.count).toBeGreaterThan(previousCount);
        previousCount = badge.count;
        silhouettes.add(badge.silhouette);
      }
    }
    expect(silhouettes.size).toBe(PLAYER_RANK_TIERS.length * 4);
  });

  it('crops the tier mark to its plate and centres the full badge', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<RankIcon tier="gold" size={26} />);
    });
    expect(renderer.root.findByType(Svg).props).toMatchObject({
      width: 26,
      height: 26,
      viewBox: RANK_TIER_MARK_VIEWBOX,
    });
    act(() => renderer.unmount());
    act(() => {
      renderer = TestRenderer.create(
        <RankIcon tier="gold" division={1} size={132} />,
      );
    });
    expect(renderer.root.findByType(Svg).props).toMatchObject({
      width: 132,
      height: 132,
      viewBox: RANK_BADGE_VIEWBOX,
    });
    act(() => renderer.unmount());
  });

  it('keeps unranked neutral on its own dark plate', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<RankIcon tier={null} />);
    });
    const paths = renderer.root.findAllByType(Path);
    expect(paths[0]!.props.fill).toBe(color.inkElevated);
    expect(paths.every(path => path.props.stroke === color.onDarkFaint)).toBe(
      true,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('Unranked emblem');
    act(() => renderer.unmount());
  });
});

describe('inventory visual contract', () => {
  it.each([
    'screens/HomeScreen.tsx',
    'screens/ProgressScreen.tsx',
    'screens/StreakCalendarScreen.tsx',
    'screens/LibraryScreen.tsx',
    'components/RankIcon.tsx',
    'components/rankInsigniaArt.ts',
    'components/PlayerRankBanner.tsx',
    'components/PlayerRankCard.tsx',
    'components/RankUpCelebration.tsx',
    'consistency/FlameIcon.tsx',
    'consistency/MilestoneBadge.tsx',
    'consistency/achievementBadgeArt.ts',
    'consistency/ConsistencyCard.tsx',
    'consistency/AchievementsShowcase.tsx',
    'consistency/StreakCelebration.tsx',
    'consistency/DaySecuredBanner.tsx',
  ])('%s uses token colors and type without ornamental effects', file => {
    const source = readFileSync(join(__dirname, '../src', file), 'utf8');
    expect(source).not.toMatch(
      /\b(?:LinearGradient|RadialGradient|Sunburst|Shimmer|SPARKS|CONFETTI|glint|withRepeat|withSpring)\b/,
    );
    expect(source).not.toMatch(/['"`](?:#[\da-fA-F]{3,8}\b|rgba?\()/);
    expect(source).not.toMatch(
      /\b(?:shadowColor|shadowOffset|shadowOpacity|shadowRadius|textShadowColor|textShadowRadius|elevation|fontSize|lineHeight)\s*:/,
    );
  });

  it('uses the shared score, display, and minimum metadata roles', () => {
    expect(typography.score).toMatchObject({ fontSize: 30, lineHeight: 34 });
    expect(typography.display).toMatchObject({ fontSize: 64, lineHeight: 66 });
    expect(typography.micro.fontSize).toBeGreaterThanOrEqual(11);
  });
});
