import '../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';
import * as Components from '../src/design/components';
import { space, type } from '../src/design/tokens';

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
        ).toMatchObject({ width: '100%', maxWidth: 320, height: 250 });
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

  it('keeps the fitted 7.02 / 10 numeral distinct from uncapped DUPR and remaining-points copy', async () => {
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
        renderer = TestRenderer.create(<RankUpCelebration />);
      });
      const rating = renderer.root
        .findAllByType(Text)
        .find(
          node =>
            node.props.testID === 'rank-up-rating' ||
            node.props.children === '7.02',
        )!;
      expect(rating.props).toMatchObject({
        numberOfLines: 1,
        adjustsFontSizeToFit: true,
        accessibilityLabel: 'Rating 7.02 out of 10',
      });
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
      expect(texts.some(node => node.props.children === '(≈ DUPR 5.2)')).toBe(
        true,
      );
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
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows the promotion facts for platinum → diamond', async () => {
    setCelebration('platinum');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
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
      renderer = TestRenderer.create(<RankUpCelebration />);
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
      renderer = TestRenderer.create(<RankUpCelebration />);
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
