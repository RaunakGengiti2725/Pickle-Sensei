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
import { space, type, color, type as typography } from '../src/design/tokens';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import { Circle, Path } from 'react-native-svg';
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('node:path') as {
  join: (...parts: string[]) => string;
};
import { RankIcon, RANK_TIER_STYLE } from '../src/components/RankIcon';

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

  it('keeps the reflowing 7.02 / 10 numeral and uncapped remaining-points copy without an invented benchmark', async () => {
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
      const rating = renderer.root
        .findAllByType(Text)
        .find(
          node =>
            node.props.testID === 'rank-up-rating' ||
            node.props.children === '7.02',
        )!;
      expect(rating.props).toMatchObject({
        accessibilityLabel: 'Rating 7.02 out of 10',
      });
      expect(rating.props.numberOfLines).toBeUndefined();
      expect(rating.props.adjustsFontSizeToFit).not.toBe(true);
      expect(rating.props.children[0]).toBe('7.02');
      expect(
        rating
          .findAllByType(Text)
          .some(node => node.props.children === ' / 10'),
      ).toBe(true);
      expect(StyleSheet.flatten(rating.props.style)).toMatchObject({
        ...type.score,
        maxWidth: '100%',
      });
      const scroll = renderer.root.findByType(ScrollView);
      const texts = scroll.findAllByType(Text);
      expect(
        texts.some(node => /DUPR|≈/.test(String(node.props.children))),
      ).toBe(false);
      expect(
        texts.some(
          node =>
            node.props.children === '0.48 to Diamond. Every analysis moves it.',
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

describe('flat rank insignia', () => {
  it('keeps every tier label and a distinct shape in the same two-color palette', () => {
    const silhouettes = new Set<string>();
    for (const tier of PLAYER_RANK_TIERS) {
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(<RankIcon tier={tier.key} size={44} />);
      });
      const paths = renderer.root.findAllByType(Path);
      const circles = renderer.root.findAllByType(Circle);
      const marks = [...paths, ...circles];
      const paints = marks
        .flatMap(mark => [mark.props.fill, mark.props.stroke])
        .filter(paint => paint && paint !== 'none');
      expect([...new Set(paints)].sort()).toEqual(
        [color.inkElevated, color.volt].sort(),
      );
      expect(marks).toHaveLength(2);
      expect(JSON.stringify(renderer.toJSON())).toContain(
        `${tier.label} rank emblem`,
      );
      expect(RANK_TIER_STYLE[tier.key]).toEqual({
        accent: color.volt,
        deep: color.inkElevated,
        tint: color.voltTint,
      });
      silhouettes.add(
        JSON.stringify(
          marks.map(mark => ({
            d: mark.props.d,
            cx: mark.props.cx,
            cy: mark.props.cy,
            r: mark.props.r,
          })),
        ),
      );
      act(() => renderer.unmount());
    }
    expect(silhouettes.size).toBe(PLAYER_RANK_TIERS.length);
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
    'components/PlayerRankBanner.tsx',
    'components/PlayerRankCard.tsx',
    'components/RankUpCelebration.tsx',
    'consistency/FlameIcon.tsx',
    'consistency/MilestoneBadge.tsx',
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
