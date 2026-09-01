import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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
    expect(copy).toContain('serve Specialist');
    expect(copy).toContain('25 scored serve analyses');
    act(() => renderer.unmount());
  });
});
