/**
 * ADVERSARIAL PASS 3 — scenario 7 (mobile-design-components-walkthrough).
 *
 * Attack: the account-rank fetch resolves with a malformed server rank —
 * `tier: 'obsidian'` (not a real tier) and `rating: NaN`. Expected: the card
 * treats a rank it cannot place as no rank at all — the unranked emblem and
 * the "Unranked" label — and the string "NaN" never reaches the rating text,
 * `formatDuprEstimate`, or the accessibility label VoiceOver reads aloud.
 *
 * Two layers are probed separately:
 *   1. the JSON parser (`parsePlayerRank`) — the wire boundary;
 *   2. the component with `fetchPlayerRank` mocked to hand back the malformed
 *      object directly — i.e. what happens if anything upstream of the card
 *      ever trusts a rank without re-validating it.
 */
import React from 'react';
import { Text } from 'react-native';
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

import * as duprEstimateModule from '../../src/progress/duprEstimate';
import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import {
  PlayerRankApiError,
  parsePlayerRank,
  resolvePlayerRank,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

const OBSIDIAN_NAN: ServerPlayerRank = {
  rating: Number.NaN,
  tier: 'obsidian',
  techniqueCount: 3,
  scoredShotCount: 9,
  updatedAt: '2026-09-01T00:00:00Z',
  techniques: [
    { shotType: 'dink', score: 6.1, capturedAt: '2026-08-30T10:00:00Z' },
  ],
};

beforeEach(() => {
  mockGetApiSession.mockReturnValue(SESSION);
  mockFetchPlayerRank.mockReset();
  mockMaybeCelebrate.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PlayerRankCard facts={[]} />);
  });
  await act(async () => {});
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function allA11yLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string);
}

describe('PlayerRankCard fed tier=obsidian rating=NaN', () => {
  it('assigned attack: renders the unranked emblem + label and no "NaN" anywhere', async () => {
    mockFetchPlayerRank.mockResolvedValue(OBSIDIAN_NAN);
    const formatSpy = jest.spyOn(duprEstimateModule, 'formatDuprEstimate');
    const renderer = await render();

    const text = allText(renderer);
    const labels = allA11yLabels(renderer);

    expect(text).not.toMatch(/NaN/);
    for (const label of labels) expect(label).not.toMatch(/NaN/);
    for (const [score] of formatSpy.mock.calls) {
      expect(Number.isFinite(score)).toBe(true);
    }

    expect(labels).toContain('Unranked emblem');
    expect(text).toContain('Unranked');
    expect(text).not.toMatch(/Bronze|Silver|Gold|Platinum|Diamond/);
    act(() => renderer.unmount());
  });

  it('a NaN-rated account rank is never reported to the celebration store', async () => {
    mockFetchPlayerRank.mockResolvedValue(OBSIDIAN_NAN);
    const renderer = await render();
    for (const [summary] of mockMaybeCelebrate.mock.calls) {
      const rating = (summary as { rating: number }).rating;
      expect(Number.isFinite(rating)).toBe(true);
    }
    act(() => renderer.unmount());
  });

  it('resolvePlayerRank refuses a non-finite server rating instead of inventing a Bronze placement', () => {
    const resolved = resolvePlayerRank([], OBSIDIAN_NAN);
    expect(resolved).toBeNull();
  });

  it.each([
    ['NaN as JSON string', 'NaN'],
    ['Infinity as JSON string', 'Infinity'],
    ['-Infinity as JSON string', '-Infinity'],
    ['null rating', null],
    ['boolean rating', true],
    ['array rating', [5]],
    ['object rating', { value: 5 }],
    ['rating 10.0001 (out of scale)', 10.0001],
    ['rating -0.0001 (out of scale)', -0.0001],
    [
      'rating Number.POSITIVE_INFINITY (JSON 1e309 parses to this)',
      Number.POSITIVE_INFINITY,
    ],
  ])('parsePlayerRank rejects the wire payload — %s', (_name, rating) => {
    const payload = {
      rank: {
        rating,
        tier: 'obsidian',
        techniqueCount: 3,
        scoredShotCount: 9,
        techniques: [],
      },
    };
    expect(() => parsePlayerRank(payload)).toThrow(PlayerRankApiError);
  });

  it('parsePlayerRank accepts "-0" and treats it as a finite 0 rating', () => {
    const parsed = parsePlayerRank({
      rank: { rating: -0, tier: 'bronze', techniqueCount: 0, techniques: [] },
    });
    expect(parsed).not.toBeNull();
    expect(Object.is(parsed!.rating, -0) || parsed!.rating === 0).toBe(true);
  });

  it('an unknown tier string with a FINITE rating is re-derived from the rating and never rendered verbatim', async () => {
    mockFetchPlayerRank.mockResolvedValue({ ...OBSIDIAN_NAN, rating: 5.5 });
    const renderer = await render();
    const text = allText(renderer);
    expect(text).not.toMatch(/obsidian/i);
    expect(text).not.toMatch(/NaN/);
    expect(text).toContain('Gold');
    for (const label of allA11yLabels(renderer)) {
      expect(label).not.toMatch(/obsidian/i);
      expect(label).not.toMatch(/NaN/);
    }
    act(() => renderer.unmount());
  });

  it('a 10k-character unicode tier string does not crash the card or leak into copy', async () => {
    const tier = '𝔬𝔟𝔰𝔦𝔡𝔦𝔞𝔫🪨'.repeat(1_000);
    mockFetchPlayerRank.mockResolvedValue({ ...OBSIDIAN_NAN, tier, rating: 2 });
    const renderer = await render();
    const text = allText(renderer);
    expect(text).not.toContain('🪨');
    expect(text).toContain('Bronze');
    act(() => renderer.unmount());
  });

  it('a malformed rank arriving AFTER unmount is dropped (no state update on a dead card)', async () => {
    let resolveFetch!: (value: unknown) => void;
    mockFetchPlayerRank.mockReturnValue(
      new Promise(resolve => {
        resolveFetch = resolve;
      }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = await render();
    act(() => renderer.unmount());
    await act(async () => {
      resolveFetch(OBSIDIAN_NAN);
    });
    expect(errors).not.toHaveBeenCalled();
  });
});
