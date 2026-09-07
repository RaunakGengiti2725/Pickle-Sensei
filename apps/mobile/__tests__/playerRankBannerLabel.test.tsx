import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import { FlameIcon } from '../src/consistency/FlameIcon';
import { color } from '../src/design/tokens';
import TestRenderer, { act } from 'react-test-renderer';
import { type } from '../src/design/tokens';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// Offline double: the locally computed (here: absent) rank stands in.
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

// The banner reports resolved ranks to the celebration store, whose
// persistence rides SQLite; the native module is absent under jest and the
// store swallows the failure (no ceremony, which these tests don't cover).
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../src/components/PlayerRankBanner';

async function renderBanner(streakDays: number, onPressStreak?: () => void) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlayerRankBanner
        shots={[]}
        streakDays={streakDays}
        {...(onPressStreak ? { onPressStreak } : {})}
      />,
    );
  });
  return renderer;
}

function nodeByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(
    node =>
      node.props.testID === id && typeof node.props.onPress !== 'undefined',
  )[0]!;
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

describe('PlayerRankBanner large-text layout contracts (not native glyph proof)', () => {
  test.each([
    { width: 375, height: 667, fontScale: 1, stacked: false },
    { width: 390, height: 844, fontScale: 1, stacked: false },
    { width: 375, height: 667, fontScale: 1.353, stacked: true },
    { width: 375, height: 667, fontScale: 3.12, stacked: true },
    { width: 375, height: 667, fontScale: 3.571, stacked: true },
    { width: 320, height: 568, fontScale: 3.571, stacked: true },
    { width: 667, height: 375, fontScale: 3.571, stacked: true },
  ])(
    'reserves rank and streak independently at $width×$height / $fontScale',
    async ({ width, height, fontScale, stacked }) => {
      const previous = {
        window: Dimensions.get('window'),
        screen: Dimensions.get('screen'),
      };
      Dimensions.set({
        window: { width, height, fontScale, scale: 2 },
        screen: { width, height, fontScale, scale: 2 },
      });
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          renderer = TestRenderer.create(
            <PlayerRankBanner
              shots={[
                {
                  id: 'aaaaaaaa-0000-4000-8000-000000000002',
                  shotType: 'forehand_drive',
                  capturedAt: '2026-09-07T08:00:00.000Z',
                  overallScore: 7.02,
                  resultKind: 'scored',
                  source: 'real',
                },
              ]}
              streakDays={365}
              streakAtRisk
              onPressStreak={() => {}}
            />,
          );
        });
        expect(
          StyleSheet.flatten(
            nodeByTestId(renderer, 'player-rank-banner-toggle').props.style,
          ),
        ).toMatchObject({
          flexDirection: stacked ? 'column' : 'row',
          minHeight: 44,
        });
        const host = (testID: string) =>
          renderer.root.findAll(
            node =>
              node.props.testID === testID && typeof node.type === 'string',
          )[0]!;
        const style = (testID: string) =>
          StyleSheet.flatten(host(testID).props.style);
        expect(style('player-rank-banner-row')).toMatchObject({
          flexDirection: stacked ? 'column' : 'row',
        });
        expect(style('player-rank-banner-toggle')).toMatchObject({
          flexBasis: stacked ? 'auto' : 200,
          flexDirection: stacked ? 'column' : 'row',
          minHeight: 44,
        });
        if (stacked) {
          expect(style('player-rank-banner-toggle')).toMatchObject({
            width: '100%',
            flexGrow: 0,
          });
          expect(style('player-rank-banner-body')).toMatchObject({
            width: '100%',
            flex: 0,
          });
          expect(style('player-rank-banner-streak')).toMatchObject({
            width: '100%',
            marginLeft: 0,
          });
          expect(style('player-rank-banner-tier')).toMatchObject({
            flexDirection: 'column',
            alignItems: 'stretch',
          });
        }
        const texts = renderer.root.findAllByType(Text);
        const tier = texts.find(node => node.props.children === 'Platinum II')!;
        expect(tier.props.numberOfLines).toBeUndefined();
        expect(StyleSheet.flatten(tier.props.style)).toMatchObject(type.h3);
        const rating = texts.find(
          node => node.props.testID === 'player-rank-banner-rating',
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
            .some(node => node.props.children === ' /10'),
        ).toBe(true);
        expect(StyleSheet.flatten(rating.props.style)).toMatchObject({
          ...type.bodyBold,
          maxWidth: '100%',
        });
        expect(allText(renderer)).toContain('(≈ DUPR 5.2)');
        expect(allText(renderer)).toContain('0.48 to Diamond');
        expect(allText(renderer)).toContain('KEEP IT ALIVE');
        expect(
          style('player-rank-banner-streak').minHeight,
        ).toBeGreaterThanOrEqual(44);
        await act(async () =>
          nodeByTestId(renderer, 'player-rank-banner-toggle').props.onPress(),
        );
        if (stacked) {
          expect(style('player-rank-banner-tier-platinum')).toMatchObject({
            flexDirection: 'column',
            alignItems: 'flex-start',
          });
        }
        expect(allText(renderer)).toContain('Current form');
        expect(allText(renderer)).toContain('forehand drive');
        for (const text of renderer.root.findAllByType(Text)) {
          expect(text.props.allowFontScaling).not.toBe(false);
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          if (text.props.testID !== 'player-rank-banner-rating') {
            expect(text.props.numberOfLines).toBeUndefined();
          }
        }
      } finally {
        if (renderer) act(() => renderer.unmount());
        Dimensions.set(previous);
      }
    },
  );

  it('keeps the unranked label and zero streak without inventing a fitted score', async () => {
    const previous = {
      window: Dimensions.get('window'),
      screen: Dimensions.get('screen'),
    };
    Dimensions.set({
      window: { width: 375, height: 667, fontScale: 3.571, scale: 2 },
      screen: { width: 375, height: 667, fontScale: 3.571, scale: 2 },
    });
    const renderer = await renderBanner(0);
    try {
      const tier = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === 'Unranked')!;
      expect(tier.props.numberOfLines).toBeUndefined();
      expect(
        renderer.root.findAll(
          node => node.props.testID === 'player-rank-banner-rating',
        ),
      ).toHaveLength(0);
      expect(allText(renderer)).toContain(
        'Your first scored analysis places you.',
      );
      const streak = renderer.root.findAll(
        node =>
          node.props.testID === 'player-rank-banner-streak' &&
          typeof node.type === 'string',
      )[0]!;
      expect(streak.props.accessibilityLabel).toContain(
        '0 days training streak',
      );
    } finally {
      act(() => renderer.unmount());
      Dimensions.set(previous);
    }
  });
});

describe('PlayerRankBanner streak block', () => {
  it('uses the dark zero-state flame and readable streak metadata', async () => {
    const renderer = await renderBanner(0);
    expect(renderer.root.findByType(FlameIcon).props.dark).toBe(true);
    const label = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === 'DAY STREAK')!;
    expect(StyleSheet.flatten(label.props.style).color).toBe(color.onDarkMuted);
    act(() => renderer.unmount());
  });

  it('labels a single training day in the singular', async () => {
    const renderer = await renderBanner(1, () => {});
    const streak = nodeByTestId(renderer, 'player-rank-banner-streak');
    expect(String(streak.props.accessibilityLabel)).toContain(
      '1 day training streak',
    );
    act(() => renderer.unmount());
  });

  it('pluralizes multi-day streaks and routes its own press', async () => {
    const onPressStreak = jest.fn();
    const renderer = await renderBanner(3, onPressStreak);
    const streak = nodeByTestId(renderer, 'player-rank-banner-streak');
    const label = String(streak.props.accessibilityLabel);
    expect(label).toContain('3 days training streak');
    expect(label).not.toContain('3 day training streak');
    expect(label).toContain('consistency calendar');
    await act(async () => {
      streak.props.onPress();
    });
    expect(onPressStreak).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

describe('PlayerRankBanner in-place expansion', () => {
  it('gives the tier its own uncapped line at normal text instead of competing with the rating', async () => {
    const dimensions = jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 });
    const renderer = await renderBanner(7);
    try {
      const tier = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === 'Unranked')!;
      expect(tier.props.numberOfLines).toBeUndefined();
      expect(StyleSheet.flatten(tier.parent!.props.style).flexDirection).toBe(
        'column',
      );
    } finally {
      act(() => renderer.unmount());
      dimensions.mockRestore();
    }
  });

  it('expands on tap — presenting the tier ladder without navigating', async () => {
    const renderer = await renderBanner(0);
    const toggle = nodeByTestId(renderer, 'player-rank-banner-toggle');
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(allText(renderer)).not.toContain('Silver');

    await act(async () => {
      toggle.props.onPress();
    });
    const expandedCopy = allText(renderer);
    // Unranked: the fold-out explains the ladder instead of inventing a tier.
    expect(expandedCopy).toContain('Bronze → Silver → Gold');
    expect(
      nodeByTestId(renderer, 'player-rank-banner-toggle').props
        .accessibilityState,
    ).toMatchObject({ expanded: true });

    await act(async () => {
      nodeByTestId(renderer, 'player-rank-banner-toggle').props.onPress();
    });
    expect(
      nodeByTestId(renderer, 'player-rank-banner-toggle').props
        .accessibilityState,
    ).toMatchObject({ expanded: false });
    act(() => renderer.unmount());
  });

  it('shows the full tier list with the player pill once ranked', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerRankBanner
          shots={[
            {
              id: 'aaaaaaaa-0000-4000-8000-000000000001',
              shotType: 'dink',
              capturedAt: '2026-08-01T10:00:00.000Z',
              overallScore: 5.5,
              resultKind: 'scored',
              source: 'real',
            },
          ]}
          streakDays={2}
        />,
      );
    });
    await act(async () => {
      nodeByTestId(renderer, 'player-rank-banner-toggle').props.onPress();
    });
    const copy = allText(renderer);
    for (const tier of ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']) {
      expect(copy).toContain(tier);
    }
    expect(copy).toContain('YOU');
    expect(copy).toContain('Current form');
    const range = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === '3.5 – 4.99')!;
    expect(StyleSheet.flatten(range.props.style).color).toBe(color.onDarkMuted);
    act(() => renderer.unmount());
  });
});
