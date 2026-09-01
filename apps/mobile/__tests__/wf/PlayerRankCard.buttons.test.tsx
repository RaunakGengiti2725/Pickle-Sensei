/**
 * Button ledger for `src/components/PlayerRankCard.tsx`.
 *
 * The card is a read-only rank display: it owns NO pressable, switch, input,
 * link or gesture handler — every visible tier / rating / technique is
 * information, not a control. This suite pins that contract (so a future
 * dead-end tap target cannot land here unnoticed) and exercises the card's
 * only asynchronous path, the account-rank fetch, through success, rejection
 * and unmount-mid-flight, asserting the copy the user actually sees.
 */
import React from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchPlayerRank = jest.fn<Promise<unknown>, unknown[]>(
  async () => null,
);
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (...args: unknown[]) => mockFetchPlayerRank(...args),
  };
});

const mockMaybeCelebrate = jest.fn<Promise<void>, [unknown]>(async () => {});
jest.mock('../../src/progress/rankCelebration', () => {
  const state = {
    maybeCelebrate: (summary: unknown) => mockMaybeCelebrate(summary),
  };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import type { RealAnalysisFact } from '../../src/data/repository';
import type { ServerPlayerRank } from '../../src/progress/playerRank';

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

let sequence = 0;
function fact(overrides: Partial<RealAnalysisFact> = {}): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: `2026-08-${String(10 + sequence).padStart(2, '0')}T10:00:00Z`,
    overallScore: 5.5,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    ...overrides,
  };
}

/** Two scored dinks → a locally computed Gold rank (5.5 sits in 5 ≤ x < 6.5). */
function deviceFacts(): RealAnalysisFact[] {
  return [fact(), fact()];
}

async function render(facts: RealAnalysisFact[]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PlayerRankCard facts={facts} />);
  });
  return renderer;
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

const INTERACTIVE_PROPS = [
  'onPress',
  'onPressIn',
  'onPressOut',
  'onLongPress',
  'onValueChange',
  'onSubmitEditing',
  'onChangeText',
  'onNavigationStateChange',
  'onMessage',
  'onRequestClose',
] as const;

/** Every node whose props carry any handler a user could trigger by touch. */
function interactiveNodes(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node =>
    INTERACTIVE_PROPS.some(prop => typeof node.props[prop] === 'function'),
  );
}

/** The ledger: this card is display-only, so the set of controls is empty. */
function expectNoControls(renderer: TestRenderer.ReactTestRenderer) {
  expect(interactiveNodes(renderer)).toHaveLength(0);
  expect(renderer.root.findAllByType(Pressable)).toHaveLength(0);
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  const roles = renderer.root
    .findAllByType(View)
    .map(node => node.props.accessibilityRole)
    .filter(Boolean);
  expect(roles).not.toContain('button');
  expect(roles).not.toContain('link');
  expect(roles).not.toContain('switch');
}

beforeEach(() => {
  sequence = 0;
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(null);
  mockFetchPlayerRank.mockReset();
  mockFetchPlayerRank.mockResolvedValue(null);
  mockMaybeCelebrate.mockClear();
});

describe('PlayerRankCard button ledger', () => {
  it('unranked state (no facts, signed out): renders honest copy and no controls', async () => {
    const renderer = await render([]);
    const copy = allText(renderer);
    expect(copy).toContain('Unranked');
    expect(copy).toContain('Your first scored analysis places you.');
    expect(
      renderer.root.findByProps({ testID: 'player-rank-card' }),
    ).toBeTruthy();
    expectNoControls(renderer);
    // Signed out: the account fetch is never attempted and nothing is
    // reported to the celebration store (there is no rank to celebrate).
    expect(mockFetchPlayerRank).not.toHaveBeenCalled();
    expect(mockMaybeCelebrate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('device-ranked state: renders the local rank, no controls, and reports it once', async () => {
    const renderer = await render(deviceFacts());
    const copy = allText(renderer);
    expect(copy).toContain('Gold');
    expect(copy).toContain('5.50');
    expect(copy).toContain('1.00 to Platinum');
    expect(copy).toContain('Computed on this device');
    expect(copy).not.toContain('Saved to your account.');
    expectNoControls(renderer);
    expect(mockMaybeCelebrate).toHaveBeenCalledTimes(1);
    expect(mockMaybeCelebrate.mock.calls[0]?.[0]).toMatchObject({
      tier: 'gold',
      rating: 5.5,
    });
    act(() => renderer.unmount());
  });

  it('exposes a descriptive accessibility label on the tier row', async () => {
    const renderer = await render(deviceFacts());
    const labels = renderer.root
      .findAllByType(View)
      .map(node => node.props.accessibilityLabel)
      .filter((label): label is string => typeof label === 'string');
    expect(
      labels.some(
        label =>
          label.startsWith('Player rank Gold') &&
          label.includes('Rating 5.50 out of 10') &&
          label.includes('1 technique.'),
      ),
    ).toBe(true);
    expect(labels).toContain('Rank ladder position: Gold');
    act(() => renderer.unmount());
  });
});

describe('PlayerRankCard account-rank fetch (its only async path)', () => {
  it('signed in + account rank with more evidence: shows the saved rank', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    const server: ServerPlayerRank = {
      rating: 7.6,
      tier: 'diamond',
      techniqueCount: 2,
      scoredShotCount: 9,
      updatedAt: '2026-08-30T00:00:00Z',
      techniques: [
        { shotType: 'dink', score: 7.5, capturedAt: '2026-08-30T00:00:00Z' },
        {
          shotType: 'third_shot_drop',
          score: 7.7,
          capturedAt: '2026-08-29T00:00:00Z',
        },
      ],
    };
    mockFetchPlayerRank.mockResolvedValue(server);

    const renderer = await render(deviceFacts());
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    expect(mockFetchPlayerRank.mock.calls[0]?.[0]).toBe(SESSION);
    const copy = allText(renderer);
    expect(copy).toContain('Diamond');
    expect(copy).toContain('7.60');
    expect(copy).toContain('Saved to your account.');
    expect(copy).toContain('Top tier — every new analysis defends it.');
    expect(copy).toContain('third shot drop');
    expectNoControls(renderer);
    // The account rank is reported to the ceremony store as the latest resolve.
    expect(mockMaybeCelebrate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tier: 'diamond', rating: 7.6 }),
    );
    act(() => renderer.unmount());
  });

  it('signed in + fetch rejects: no crash, local rank stands in, no error dead-end', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockRejectedValue(new Error('offline'));

    const renderer = await render(deviceFacts());
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    const copy = allText(renderer);
    expect(copy).toContain('Gold');
    expect(copy).toContain('Computed on this device');
    expect(copy).toContain('syncs to your account automatically');
    expect(copy).not.toContain('Saved to your account.');
    expectNoControls(renderer);
    act(() => renderer.unmount());
  });

  it('signed in + fetch rejects with no local facts: honest Unranked, not an error', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockRejectedValue(new Error('server 503'));

    const renderer = await render([]);
    expect(allText(renderer)).toContain('Unranked');
    expectNoControls(renderer);
    expect(mockMaybeCelebrate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('signed in + server returns null (unranked account): local rank wins', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockResolvedValue(null);

    const renderer = await render(deviceFacts());
    const copy = allText(renderer);
    expect(copy).toContain('Gold');
    expect(copy).toContain('Computed on this device');
    act(() => renderer.unmount());
  });

  it('tolerates a server rank with an unknown tier string and null counters', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    mockFetchPlayerRank.mockResolvedValue({
      rating: 3.9,
      tier: 'mythic',
      techniqueCount: 0,
      scoredShotCount: null,
      updatedAt: null,
      techniques: [],
    } satisfies ServerPlayerRank);

    // No local facts → the server rank is the only source; its unknown tier
    // must re-derive from the rating (3.9 → Silver) rather than throw.
    const renderer = await render([]);
    const copy = allText(renderer);
    expect(copy).toContain('Silver');
    expect(copy).toContain('3.90');
    expect(copy).toContain('0 techniques');
    expectNoControls(renderer);
    act(() => renderer.unmount());
  });

  it('unmounting mid-fetch never applies the late response', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    let resolveFetch!: (value: ServerPlayerRank | null) => void;
    mockFetchPlayerRank.mockReturnValue(
      new Promise<unknown>(resolve => {
        resolveFetch = resolve;
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const renderer = await render(deviceFacts());
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await act(async () => {
      resolveFetch({
        rating: 8,
        tier: 'diamond',
        techniqueCount: 1,
        scoredShotCount: 20,
        updatedAt: null,
        techniques: [],
      });
    });
    // A state update on an unmounted component would log through
    // console.error; the `active` guard must keep it silent.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('re-fetches when the facts prop changes (new analyses refresh the rank)', async () => {
    mockGetApiSession.mockReturnValue(SESSION);
    const renderer = await render(deviceFacts());
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(<PlayerRankCard facts={[...deviceFacts(), fact()]} />);
    });
    expect(mockFetchPlayerRank).toHaveBeenCalledTimes(2);
    expectNoControls(renderer);
    act(() => renderer.unmount());
  });
});
