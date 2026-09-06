import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import { FlameIcon } from '../src/consistency/FlameIcon';
import { color } from '../src/design/tokens';
import TestRenderer, { act } from 'react-test-renderer';

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
