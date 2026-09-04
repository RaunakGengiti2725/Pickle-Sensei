/**
 * AUDIT — PlayerRankBanner streak block (PlayerRankBanner.tsx:257-285,
 * styles :418-440). The block has no explicit minHeight/hitSlop, so its
 * 44pt footprint is derived here from the flattened styles of its children.
 * The PROBE targets the streak label: `styles.streakLabel` spreads
 * `type.micro` and then overrides `fontSize: 9` — an ad-hoc size below the
 * smallest typography token (micro = 11pt), against the AGENTS.md canon
 * "never invent ad-hoc fontSize near a token".
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { type as typeTokens } from '../../src/design/tokens';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/progress/rankCelebration', () => ({
  useRankCelebrationStore: (
    selector: (state: { maybeCelebrate: unknown }) => unknown,
  ) => selector({ maybeCelebrate: () => Promise.resolve() }),
}));
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';

const STREAK = 'player-rank-banner-streak';
const SMALLEST_TOKEN_FONT = Math.min(
  ...Object.values(typeTokens).map(role => role.fontSize),
);

async function renderBanner(props: {
  streakDays: number;
  streakAtRisk?: boolean;
  onPressStreak?: () => void;
}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlayerRankBanner
        shots={[]}
        streakDays={props.streakDays}
        {...(props.streakAtRisk !== undefined
          ? { streakAtRisk: props.streakAtRisk }
          : {})}
        {...(props.onPressStreak ? { onPressStreak: props.onPressStreak } : {})}
      />,
    );
  });
  return renderer;
}

function streakHost(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    n => typeof n.type === 'string' && n.props.testID === STREAK,
  );
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

describe('PlayerRankBanner streak block', () => {
  it('VERIFIED: role, label (singular/plural, at-risk suffix), and disabled state without a handler', async () => {
    const inert = await renderBanner({ streakDays: 1 });
    const inertHost = streakHost(inert);
    expect(inertHost.props.accessibilityRole).toBe('button');
    expect(inertHost.props.accessibilityLabel).toBe(
      '1 day training streak. Opens the consistency calendar.',
    );
    expect(inertHost.props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await act(async () => inert.unmount());

    const onPressStreak = jest.fn();
    const live = await renderBanner({
      streakDays: 4,
      streakAtRisk: true,
      onPressStreak,
    });
    const liveHost = streakHost(live);
    expect(liveHost.props.accessibilityLabel).toBe(
      '4 days training streak, at risk — no training yet today. Opens the consistency calendar.',
    );
    expect(liveHost.props.accessibilityState).toMatchObject({
      disabled: false,
    });
    act(() =>
      liveHost.props.onClick({
        currentTarget: liveHost,
        target: liveHost,
        nativeEvent: {},
        stopPropagation: () => {},
      }),
    );
    expect(onPressStreak).toHaveBeenCalledTimes(1);
    await act(async () => live.unmount());
  });

  it('VERIFIED: the block footprint derived from its styles is at least 44pt tall (INFERRED layout, no native measurement)', async () => {
    const renderer = await renderBanner({
      streakDays: 12,
      onPressStreak: jest.fn(),
    });
    const host = streakHost(renderer);
    const block = StyleSheet.flatten(host.props.style);
    const texts = host.findAllByType(Text);
    const [count, label] = texts.map(t => StyleSheet.flatten(t.props.style));
    const paddingV = num(block['paddingVertical']) * 2;
    const topRow = Math.max(num(count?.['lineHeight']), 18 /* flame glyph */);
    const labelH = num(label?.['lineHeight']) + num(label?.['marginTop']);
    expect(paddingV + topRow + labelH).toBeGreaterThanOrEqual(44);
    await act(async () => renderer.unmount());
  });

  it('PROBE: every text in the streak block must use a token font size (no ad-hoc size below the smallest role)', async () => {
    const renderer = await renderBanner({
      streakDays: 3,
      onPressStreak: jest.fn(),
    });
    const host = streakHost(renderer);
    const sizes = host
      .findAllByType(Text)
      .map(t => StyleSheet.flatten(t.props.style)['fontSize']);
    await act(async () => renderer.unmount());
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(SMALLEST_TOKEN_FONT);
    }
  });
});
