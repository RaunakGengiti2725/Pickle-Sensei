/**
 * Button ledger for PlayerRankBanner: every pressable in the component is
 * enumerated and pressed here, asserting the real observable effect.
 *
 *   player-rank-banner-toggle -> toggle()  (in-place unfold of the ladder)
 *   player-rank-banner-streak -> props.onPressStreak (StreakCalendar route)
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';
import type {
  PlayerRankFactLike,
  ServerPlayerRank,
} from '../../src/progress/playerRank';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockGetApiSession = jest.fn<
  { apiBaseUrl: string; bearerToken: string } | null,
  []
>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchPlayerRank = jest.fn<
  Promise<ServerPlayerRank | null>,
  [unknown]
>();
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (session: unknown) => mockFetchPlayerRank(session),
  };
});

const mockMaybeCelebrate = jest.fn<Promise<void>, [PlayerRankSummary]>(() =>
  Promise.resolve(),
);
jest.mock('../../src/progress/rankCelebration', () => ({
  useRankCelebrationStore: (
    selector: (state: { maybeCelebrate: unknown }) => unknown,
  ) => selector({ maybeCelebrate: mockMaybeCelebrate }),
}));

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual('../../src/design/components');
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

// The celebration store is mocked above, but keep SQLite absent regardless
// so nothing in the render tree can reach a native module.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';

const TOGGLE = 'player-rank-banner-toggle';
const STREAK = 'player-rank-banner-streak';

const SCORED_DINK: PlayerRankFactLike = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  shotType: 'dink',
  capturedAt: '2026-08-01T10:00:00.000Z',
  overallScore: 5.5,
  resultKind: 'scored',
  source: 'real',
};

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token',
  canonicalAppUserId: 'user-1',
  provider: 'apple' as const,
};

const SERVER_RANK: ServerPlayerRank = {
  rating: 7.8,
  tier: 'diamond',
  techniqueCount: 2,
  scoredShotCount: 12,
  updatedAt: '2026-08-20T00:00:00.000Z',
  techniques: [
    {
      shotType: 'third_shot_drop',
      score: 8.1,
      capturedAt: '2026-08-20T00:00:00.000Z',
    },
    { shotType: 'dink', score: 7.5, capturedAt: '2026-08-19T00:00:00.000Z' },
  ],
};

interface BannerProps {
  shots?: readonly PlayerRankFactLike[];
  streakDays?: number;
  streakAtRisk?: boolean;
  onPressStreak?: () => void;
}

async function renderBanner(props: BannerProps = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlayerRankBanner
        shots={props.shots ?? []}
        streakDays={props.streakDays ?? 0}
        {...(props.streakAtRisk !== undefined
          ? { streakAtRisk: props.streakAtRisk }
          : {})}
        {...(props.onPressStreak ? { onPressStreak: props.onPressStreak } : {})}
      />,
    );
  });
  return renderer;
}

/** Composite Pressable instance carrying the given testID. */
function pressable(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(
    node => node.props.testID === id && 'onPress' in node.props,
  )[0]!;
}

async function press(renderer: TestRenderer.ReactTestRenderer, id: string) {
  await act(async () => {
    pressable(renderer, id).props.onPress();
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
    .join(' ');
}

beforeEach(() => {
  mockReducedMotion = false;
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(null);
  mockFetchPlayerRank.mockReset();
  mockMaybeCelebrate.mockClear();
});

describe('PlayerRankBanner button ledger', () => {
  it('exposes exactly two pressables, each a labelled accessibility button', async () => {
    const renderer = await renderBanner({
      streakDays: 4,
      onPressStreak: () => {},
    });
    const interactive = renderer.root.findAll(
      node =>
        'onPress' in node.props ||
        'onLongPress' in node.props ||
        'onValueChange' in node.props ||
        'onSubmitEditing' in node.props,
    );
    const ids = new Set(interactive.map(node => node.props.testID));
    expect([...ids].sort()).toEqual([STREAK, TOGGLE].sort());

    for (const id of [TOGGLE, STREAK]) {
      const node = pressable(renderer, id);
      expect(node.props.accessibilityRole).toBe('button');
      expect(String(node.props.accessibilityLabel).length).toBeGreaterThan(10);
      expect(typeof node.props.onPress).toBe('function');
    }
    act(() => renderer.unmount());
  });

  it('never invents a rank and never calls the rank API when signed out', async () => {
    const renderer = await renderBanner();
    expect(mockFetchPlayerRank).not.toHaveBeenCalled();
    expect(mockMaybeCelebrate).not.toHaveBeenCalled();
    const toggle = pressable(renderer, TOGGLE);
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'Player rank: unranked.',
    );
    expect(allText(renderer)).toContain('Unranked');
    act(() => renderer.unmount());
  });
});

describe('player-rank-banner-toggle -> toggle()', () => {
  it('unfolds the unranked explainer in place and folds it back on the second tap', async () => {
    const renderer = await renderBanner();
    const before = pressable(renderer, TOGGLE);
    expect(before.props.accessibilityState).toEqual({ expanded: false });
    expect(before.props.accessibilityHint).toBe(
      'Opens the rank details in place.',
    );
    expect(allText(renderer)).not.toContain('Complete one scored stroke');

    await press(renderer, TOGGLE);
    const open = pressable(renderer, TOGGLE);
    expect(open.props.accessibilityState).toEqual({ expanded: true });
    expect(open.props.accessibilityHint).toBe('Collapses the rank details.');
    const openCopy = allText(renderer);
    expect(openCopy).toContain('Complete one scored stroke analysis');
    expect(openCopy).toContain('Bronze → Silver → Gold → Platinum → Diamond');
    // Unranked: no ladder row, no YOU pill, no formula note.
    expect(openCopy).not.toContain('YOU');
    expect(openCopy).not.toContain('Current form');

    await press(renderer, TOGGLE);
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(allText(renderer)).not.toContain('Complete one scored stroke');
    act(() => renderer.unmount());
  });

  it('unfolds the full ladder, division pill, technique chips and next-tier math for a device rank', async () => {
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    const toggle = pressable(renderer, TOGGLE);
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'Player rank Gold II',
    );
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'rating 5.50 out of 10.',
    );
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'Best: dink 5.5 · 1.00 to Platinum',
    );
    expect(mockMaybeCelebrate).toHaveBeenCalledTimes(1);
    expect(mockMaybeCelebrate.mock.calls[0]![0]).toMatchObject({
      tier: 'gold',
      rating: 5.5,
    });

    await press(renderer, TOGGLE);
    const copy = allText(renderer);
    for (const tier of ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']) {
      expect(copy).toContain(tier);
    }
    expect(copy).toContain('YOU ·');
    expect(copy).toContain('II');
    expect(copy).toContain('dink');
    expect(copy).toContain('Current form');
    expect(copy).toContain('1.00 to Platinum.');
    expect(copy).toContain('3.5 – 4.99');
    expect(copy).toContain('7.5+');

    await press(renderer, TOGGLE);
    expect(allText(renderer)).not.toContain('Current form');
    act(() => renderer.unmount());
  });

  it('keeps toggling under reduced motion (no animation choreography)', async () => {
    mockReducedMotion = true;
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    await press(renderer, TOGGLE);
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(allText(renderer)).toContain('Current form');
    await press(renderer, TOGGLE);
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(allText(renderer)).not.toContain('Current form');
    act(() => renderer.unmount());
  });

  it('survives rapid repeated taps and always lands on a consistent state', async () => {
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    for (let i = 0; i < 5; i += 1) {
      await press(renderer, TOGGLE);
    }
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(allText(renderer)).toContain('Current form');
    await press(renderer, TOGGLE);
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: false,
    });
    act(() => renderer.unmount());
  });

  it('shows the account rank when the server has seen more evidence and reports it for celebration', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockResolvedValue(SERVER_RANK);
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    expect(mockFetchPlayerRank).toHaveBeenCalledWith(SESSION);

    const toggle = pressable(renderer, TOGGLE);
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'Player rank Diamond',
    );
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'rating 7.80 out of 10.',
    );
    expect(String(toggle.props.accessibilityLabel)).toContain(
      'Best: third shot drop 8.1 · Top tier',
    );
    expect(mockMaybeCelebrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tier: 'diamond', rating: 7.8 }),
    );

    await press(renderer, TOGGLE);
    const copy = allText(renderer);
    expect(copy).toContain('7.80');
    expect(copy).toContain('third shot drop');
    expect(copy).toContain('Top tier — every new analysis defends it.');
    act(() => renderer.unmount());
  });

  it('falls back to the device rank when the rank API rejects — the toggle keeps working', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockRejectedValue(new Error('offline'));
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    expect(
      String(pressable(renderer, TOGGLE).props.accessibilityLabel),
    ).toContain('Player rank Gold II');
    await press(renderer, TOGGLE);
    expect(allText(renderer)).toContain('1.00 to Platinum.');
    await press(renderer, TOGGLE);
    expect(allText(renderer)).not.toContain('Current form');
    act(() => renderer.unmount());
  });

  it('stays honest when the API says unranked (null) and the device has no shots', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockResolvedValue(null);
    const renderer = await renderBanner();
    expect(mockMaybeCelebrate).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain('Unranked');
    await press(renderer, TOGGLE);
    expect(allText(renderer)).toContain('Complete one scored stroke analysis');
    act(() => renderer.unmount());
  });

  it('does not throw on a server rank with no technique rows', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockResolvedValue({
      ...SERVER_RANK,
      rating: 4.2,
      tier: 'silver',
      techniqueCount: 0,
      scoredShotCount: 3,
      techniques: [],
    });
    const renderer = await renderBanner();
    expect(
      String(pressable(renderer, TOGGLE).props.accessibilityLabel),
    ).toContain('Best: — · 0.80 to Gold');
    await press(renderer, TOGGLE);
    expect(allText(renderer)).toContain('YOU ·');
    act(() => renderer.unmount());
  });

  it('ignores a rank response that lands after unmount', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    let resolveRank!: (rank: ServerPlayerRank | null) => void;
    mockFetchPlayerRank.mockReturnValue(
      new Promise<ServerPlayerRank | null>(resolve => {
        resolveRank = resolve;
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = await renderBanner({ shots: [SCORED_DINK] });
    act(() => renderer.unmount());
    await act(async () => {
      resolveRank(SERVER_RANK);
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('player-rank-banner-streak -> props.onPressStreak', () => {
  it('routes its own press to the consistency calendar handler exactly once per tap', async () => {
    const onPressStreak = jest.fn();
    const renderer = await renderBanner({ streakDays: 3, onPressStreak });
    const streak = pressable(renderer, STREAK);
    expect(streak.props.disabled).toBe(false);
    expect(streak.props.accessibilityRole).toBe('button');
    const label = String(streak.props.accessibilityLabel);
    expect(label).toContain('3 days training streak');
    expect(label).toContain('Opens the consistency calendar.');
    expect(label).not.toContain('at risk');
    expect(allText(renderer)).toContain('DAY STREAK');

    await press(renderer, STREAK);
    expect(onPressStreak).toHaveBeenCalledTimes(1);
    await press(renderer, STREAK);
    expect(onPressStreak).toHaveBeenCalledTimes(2);
    // The streak tap never toggles the rank fold-out.
    expect(pressable(renderer, TOGGLE).props.accessibilityState).toEqual({
      expanded: false,
    });
    act(() => renderer.unmount());
  });

  it('singularizes a one-day streak', async () => {
    const renderer = await renderBanner({
      streakDays: 1,
      onPressStreak: () => {},
    });
    expect(
      String(pressable(renderer, STREAK).props.accessibilityLabel),
    ).toContain('1 day training streak');
    act(() => renderer.unmount());
  });

  it('flags an at-risk streak in copy and accessibility label', async () => {
    const renderer = await renderBanner({
      streakDays: 6,
      streakAtRisk: true,
      onPressStreak: () => {},
    });
    expect(
      String(pressable(renderer, STREAK).props.accessibilityLabel),
    ).toContain('at risk — no training yet today');
    expect(allText(renderer)).toContain('KEEP IT ALIVE');
    expect(allText(renderer)).not.toContain('DAY STREAK');
    act(() => renderer.unmount());
  });

  it('does not nag a zero-day streak even when flagged at risk', async () => {
    const renderer = await renderBanner({
      streakDays: 0,
      streakAtRisk: true,
      onPressStreak: () => {},
    });
    expect(allText(renderer)).toContain('DAY STREAK');
    expect(allText(renderer)).not.toContain('KEEP IT ALIVE');
    act(() => renderer.unmount());
  });

  it('is disabled (never a dead tap) when no handler is supplied', async () => {
    const renderer = await renderBanner({ streakDays: 2 });
    const streak = pressable(renderer, STREAK);
    expect(streak.props.disabled).toBe(true);
    expect(streak.props.onPress).toBeUndefined();
    act(() => renderer.unmount());
  });
});
