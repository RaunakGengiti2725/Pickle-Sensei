/**
 * Ceremony + Home banner flow: the rank-up and streak-milestone overlays can
 * always be left (Continue / Keep training, backdrop, hardware back), never
 * double-fire, and their stores skip the ceremony — rather than crash or
 * hang — when durable storage is unavailable. The PlayerRankBanner's main
 * tap toggles the ladder in place while its streak block is the only
 * navigation target (AGENTS.md invariant).
 */
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

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

let mockDbAvailable = false;
const mockKv = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockDbAvailable) throw new Error('no native sqlite in jest');
    return { tag: 'db' };
  },
}));
jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKv.set(key, value);
  },
}));

const mockOwner = { current: 'owner-1' };
jest.mock('../../src/data/accountScope', () => {
  const actual = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  return {
    ...actual,
    getActiveDataOwner: () => mockOwner.current,
  };
});

import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import { useConsistencyStore } from '../../src/consistency/store';
import type { ConsistencyCelebration } from '../../src/consistency/store';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';

const diamond: PlayerRankSummary = {
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

const platinum: PlayerRankSummary = {
  ...diamond,
  rating: 7.1,
  tier: 'platinum',
  tierLabel: 'Platinum',
  division: 1,
  divisionLabel: 'I',
  scoredAnalysisCount: 6,
  nextTier: {
    key: 'diamond',
    label: 'Diamond',
    minRating: 7.5,
    pointsNeeded: 0.4,
  },
};

const weekOne: ConsistencyCelebration = {
  kind: 'streak',
  achievementId: 'streak.7',
  title: 'Week One',
  blurb: 'A full week of real training.',
  reward: 'Streak Shield earned',
  rarity: 'uncommon',
  value: 7,
  streakAtCelebration: 7,
};

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function hosts(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function pressableByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No host labeled ${label}`);
  return node;
}

/** The fold-out stays mounted (but inert) for the 180ms collapse animation
 * so the content can fade out instead of vanishing; wait it out. */
const FOLD_AWAY_MS = 180;
async function settleFoldAway(renderer: TestRenderer.ReactTestRenderer) {
  const foldOut = renderer.root.findAll(
    node => node.props.testID === 'player-rank-banner-fold-out',
  );
  for (const node of foldOut) {
    expect(node.props.pointerEvents).toBe('none');
  }
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, FOLD_AWAY_MS + 20));
  });
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

afterEach(() => {
  useRankCelebrationStore.setState({ current: null });
  useConsistencyStore.setState({ celebration: null });
  mockKv.clear();
  mockDbAvailable = false;
  mockOwner.current = 'owner-1';
});

describe('flow: RankUpCelebration dismissal', () => {
  const show = () =>
    useRankCelebrationStore.setState({
      current: {
        fromTier: 'platinum',
        toTier: 'diamond',
        fromRating: 7.1,
        summary: diamond,
      },
    });

  it('Continue is a labeled button that closes the ceremony, twice is harmless', async () => {
    show();
    const renderer = render(<RankUpCelebration />);
    expect(hosts(renderer, 'rank-up-celebration')).toHaveLength(1);
    expect(renderer.root.findAllByType(Modal)[0]!.props.visible).toBe(true);
    const host = hosts(renderer, 'rank-up-continue')[0]!;
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Continue');

    const button = pressableByTestId(renderer, 'rank-up-continue');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(hosts(renderer, 'rank-up-celebration')).toHaveLength(0);
    expect(renderer.root.findAllByType(Modal)[0]!.props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('the backdrop and the hardware back both dismiss', async () => {
    show();
    let renderer = render(<RankUpCelebration />);
    const backdrop = pressableByLabel(renderer, 'Dismiss rank celebration');
    await act(async () => {
      backdrop.props.onPress();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    act(() => renderer.unmount());

    show();
    renderer = render(<RankUpCelebration />);
    const modal = renderer.root.findAllByType(Modal)[0]!;
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    act(() => renderer.unmount());
  });

  it('shows the ceremony only for a real upward transition and records it durably first', async () => {
    mockDbAvailable = true;
    const store = useRankCelebrationStore.getState();
    // First resolve: placement ceremony.
    await store.maybeCelebrate(platinum);
    expect(useRankCelebrationStore.getState().current).toMatchObject({
      fromTier: null,
      toTier: 'platinum',
    });
    expect(mockKv.get(rankCelebrationKeyForOwner('owner-1'))).toContain(
      '"platinum"',
    );
    // Storage was written BEFORE the overlay rose, so a repeat report of the
    // same rank (e.g. Home + Progress both resolving) raises nothing new.
    useRankCelebrationStore.getState().dismiss();
    await store.maybeCelebrate(platinum);
    expect(useRankCelebrationStore.getState().current).toBeNull();

    // Upward move: promotion ceremony, exactly once even under a double report.
    await Promise.all([
      store.maybeCelebrate(diamond),
      store.maybeCelebrate(diamond),
    ]);
    expect(useRankCelebrationStore.getState().current).toMatchObject({
      fromTier: 'platinum',
      toTier: 'diamond',
    });
    useRankCelebrationStore.getState().dismiss();
    // A downward move never celebrates.
    await store.maybeCelebrate(platinum);
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('skips the ceremony rather than failing when storage is unavailable or signed out', async () => {
    mockDbAvailable = false;
    await expect(
      useRankCelebrationStore.getState().maybeCelebrate(diamond),
    ).resolves.toBeUndefined();
    expect(useRankCelebrationStore.getState().current).toBeNull();

    mockDbAvailable = true;
    mockOwner.current = 'signed-out';
    await useRankCelebrationStore.getState().maybeCelebrate(diamond);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(mockKv.size).toBe(0);
  });
});

describe('flow: StreakCelebration dismissal', () => {
  it('Keep training closes the milestone, and twice is harmless', async () => {
    useConsistencyStore.setState({ celebration: weekOne });
    const renderer = render(<StreakCelebration />);
    expect(hosts(renderer, 'streak-celebration')).toHaveLength(1);
    const text = allText(renderer);
    expect(text).toContain('Week One');
    expect(text).toContain('Streak Shield earned');
    const host = hosts(renderer, 'streak-celebration-continue')[0]!;
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Keep training');

    const button = pressableByTestId(renderer, 'streak-celebration-continue');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(hosts(renderer, 'streak-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('the backdrop and the hardware back both dismiss', async () => {
    useConsistencyStore.setState({ celebration: weekOne });
    let renderer = render(<StreakCelebration />);
    await act(async () => {
      pressableByLabel(
        renderer,
        'Dismiss milestone celebration',
      ).props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());

    useConsistencyStore.setState({ celebration: weekOne });
    renderer = render(<StreakCelebration />);
    await act(async () => {
      renderer.root.findAllByType(Modal)[0]!.props.onRequestClose();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });

  it('a failed history load leaves the snapshot untouched and resolves', async () => {
    mockDbAvailable = false;
    useConsistencyStore.setState({ snapshot: null });
    await expect(
      useConsistencyStore.getState().refresh(),
    ).resolves.toBeUndefined();
    expect(useConsistencyStore.getState().snapshot).toBeNull();
    expect(useConsistencyStore.getState().celebration).toBeNull();
  });
});

const MAIN_LABEL =
  'Player rank: unranked. Your first scored analysis places you.';

describe('flow: PlayerRankBanner targets', () => {
  async function renderBanner(onPressStreak?: () => void) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerRankBanner
          shots={[]}
          streakDays={3}
          streakAtRisk
          {...(onPressStreak ? { onPressStreak } : {})}
        />,
      );
    });
    return renderer;
  }

  it('main tap toggles the ladder in place and never navigates', async () => {
    const onPressStreak = jest.fn();
    const renderer = await renderBanner(onPressStreak);
    const host = hostByLabel(renderer, MAIN_LABEL);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityState).toMatchObject({ expanded: false });
    expect(host.props.accessibilityHint).toBe(
      'Opens the rank details in place.',
    );
    expect(allText(renderer)).not.toContain('Bronze → Silver → Gold');

    const toggle = pressableByTestId(renderer, 'player-rank-banner-toggle');
    await act(async () => {
      toggle.props.onPress();
    });
    expect(allText(renderer)).toContain('Bronze → Silver → Gold');
    expect(
      hostByLabel(renderer, MAIN_LABEL).props.accessibilityState,
    ).toMatchObject({ expanded: true });
    expect(hostByLabel(renderer, MAIN_LABEL).props.accessibilityHint).toBe(
      'Collapses the rank details.',
    );

    // Rapid re-taps (each its own touch event) keep toggling deterministically:
    // close → open → close, never stuck.
    for (const expected of [false, true, false]) {
      await act(async () => {
        pressableByTestId(
          renderer,
          'player-rank-banner-toggle',
        ).props.onPress();
      });
      if (!expected) await settleFoldAway(renderer);
      expect(allText(renderer).includes('Bronze → Silver → Gold')).toBe(
        expected,
      );
      expect(
        hostByLabel(renderer, MAIN_LABEL).props.accessibilityState.expanded,
      ).toBe(expected);
    }
    expect(onPressStreak).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('the streak block is its own target with at-risk copy in the label', async () => {
    const onPressStreak = jest.fn();
    const renderer = await renderBanner(onPressStreak);
    const label =
      '3 days training streak, at risk — no training yet today. Opens the consistency calendar.';
    const host = hostByLabel(renderer, label);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityState?.disabled).toBeFalsy();
    await act(async () => {
      pressableByTestId(renderer, 'player-rank-banner-streak').props.onPress();
    });
    expect(onPressStreak).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toContain('Bronze → Silver → Gold');
    act(() => renderer.unmount());
  });

  it('without a streak handler the block is disabled, not a silent no-op', async () => {
    const renderer = await renderBanner();
    const host = hosts(renderer, 'player-rank-banner-streak')[0]!;
    expect(host.props.accessibilityState).toMatchObject({ disabled: true });
    act(() => renderer.unmount());
  });
});
