import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

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
