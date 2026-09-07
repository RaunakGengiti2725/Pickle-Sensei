import '../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import * as Components from '../src/design/components';
import { space, type } from '../src/design/tokens';

// The consistency store persists through SQLite; the native module is absent
// under jest and these tests only drive the overlay through store state.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { StreakCelebration } from '../src/consistency/StreakCelebration';
import { useConsistencyStore } from '../src/consistency/store';
import type { ConsistencyCelebration } from '../src/consistency/store';

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

afterEach(() => {
  useConsistencyStore.setState({ celebration: null });
});

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
          height: 236,
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
  it('renders nothing without a pending milestone', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<StreakCelebration />);
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
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    const copy = allText(renderer);
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
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    const copy = allText(renderer);
    expect(copy).toContain('Serve Specialist');
    expect(copy).not.toContain('serve Specialist');
    expect(copy).toContain('25 scored serve analyses');
    act(() => renderer.unmount());
  });
});
