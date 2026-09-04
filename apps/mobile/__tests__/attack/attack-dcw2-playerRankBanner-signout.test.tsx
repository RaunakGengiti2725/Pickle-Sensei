/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S4.
 *
 * PlayerRankBanner fetches the account rank (`GET /v1/rank`) in an effect
 * keyed on `props.shots`, guarded by a closure `active` flag. Attack: the
 * session disappears (sign-out via `clearApiSession`) while that fetch is in
 * flight, then the response lands. Variants:
 *   A. sign-out + the host swaps `shots` (what Home does when the data owner
 *      changes) → the stale closure is inactive, the late response MUST be
 *      ignored and the local (device) rank rendered;
 *   B. sign-out while the banner stays mounted with the SAME `shots` array
 *      → the effect never re-runs, so the late response of the signed-out
 *      account is APPLIED (recorded — this is the assigned attack's exact
 *      boundary);
 *   C. unmount mid-flight → no state update after unmount;
 *   D. a session established AFTER mount (launch refresh landing late) is
 *      never fetched until `shots` changes (no subscription to the session
 *      store);
 *   E. rapid shots churn: 25 effects in flight, only the LAST response wins
 *      regardless of resolution order (seeded shuffle, seed recorded).
 *
 * `fetch` is stubbed with deferreds so the response timing is controlled
 * exactly; everything else (apiSession store, fetchPlayerRank, resolve
 * logic) is the real code.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  rankFromFacts,
  type PlayerRankFactLike,
} from '../../src/progress/playerRank';

const SEED = 0xd2c4;

function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

interface Deferred {
  url: string;
  resolve: (body: unknown, ok?: boolean) => void;
  reject: (error: Error) => void;
}

let pending: Deferred[] = [];

beforeEach(() => {
  pending = [];
  globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({
        url: String(input),
        resolve: (body, ok = true) =>
          resolve({
            ok,
            status: ok ? 200 : 500,
            json: () => Promise.resolve(body),
          } as unknown as Response),
        reject,
      });
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  clearApiSession();
});

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

const localShots: PlayerRankFactLike[] = [
  {
    id: 's1',
    shotType: 'forehand_drive',
    capturedAt: '2026-08-30T10:00:00.000Z',
    overallScore: 5.0,
    resultKind: 'scored',
    source: 'real',
  },
  {
    id: 's2',
    shotType: 'forehand_drive',
    capturedAt: '2026-08-30T11:00:00.000Z',
    overallScore: 5.2,
    resultKind: 'scored',
    source: 'real',
  },
];

/** A server rank that would WIN resolution (more scored shots, higher rating). */
const accountRankBody = {
  rank: {
    rating: 9.9,
    tier: 'pro',
    techniqueCount: 3,
    scoredShotCount: 999,
    updatedAt: '2026-09-01T00:00:00.000Z',
    techniques: [
      {
        shot_type: 'forehand_drive',
        score: 9.9,
        captured_at: '2026-09-01T00:00:00.000Z',
      },
    ],
  },
};

type Renderer = TestRenderer.ReactTestRenderer;

async function renderBanner(shots: readonly PlayerRankFactLike[]) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlayerRankBanner shots={shots} streakDays={0} />,
    );
  });
  return renderer;
}

async function update(
  renderer: Renderer,
  shots: readonly PlayerRankFactLike[],
) {
  await act(async () => {
    renderer.update(<PlayerRankBanner shots={shots} streakDays={0} />);
  });
}

function rankLabel(renderer: Renderer): string {
  const toggle = renderer.root.findAll(
    n => n.props.testID === 'player-rank-banner-toggle' && n.props.onPress,
  )[0]!;
  return String(toggle.props.accessibilityLabel);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const localRating = rankFromFacts(localShots)!.rating.toFixed(2);

describe('ATTACK S4 — PlayerRankBanner sign-out while the account-rank fetch is in flight', () => {
  it('precondition: local rank renders immediately while the fetch is pending', async () => {
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toBe('https://api.example.test/v1/rank');
    expect(rankLabel(renderer)).toContain(`rating ${localRating} out of 10`);
    act(() => renderer.unmount());
  });

  it('A. sign-out + shots swap: the late response is ignored, the local rank stands', async () => {
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    const inflight = pending[0]!;

    // Sign out: session gone, host re-derives its shots for the new owner.
    clearApiSession();
    expect(getApiSession()).toBeNull();
    const sameLocalCopy = [...localShots];
    await update(renderer, sameLocalCopy);
    // No new fetch was started (no session) …
    expect(pending).toHaveLength(1);

    // … and the OLD response lands late.
    inflight.resolve(accountRankBody);
    await flush();

    const label = rankLabel(renderer);
    expect(label).toContain(`rating ${localRating} out of 10`);
    expect(label).not.toContain('9.90');
    act(() => renderer.unmount());
  });

  it('B. sign-out with the SAME shots array mounted: records whether the signed-out account rank is applied', async () => {
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    const inflight = pending[0]!;
    clearApiSession();
    inflight.resolve(accountRankBody);
    await flush();
    const label = rankLabel(renderer);
    console.log(`[ATTACK S4-B] label after sign-out + late response: ${label}`);
    // The effect is keyed on props.shots only, so with no shots change the
    // late response of a session that no longer exists is applied.
    expect(label).toContain('9.90');
    act(() => renderer.unmount());
  });

  it('C. unmount mid-flight: the late response produces no update/warning', async () => {
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    const inflight = pending[0]!;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => renderer.unmount());
    inflight.resolve(accountRankBody);
    await flush();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('C2. rejected late response after sign-out + swap is swallowed', async () => {
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    const inflight = pending[0]!;
    clearApiSession();
    await update(renderer, [...localShots]);
    inflight.reject(new Error('network down'));
    await flush();
    expect(rankLabel(renderer)).toContain(`rating ${localRating} out of 10`);
    act(() => renderer.unmount());
  });

  it('D. session established AFTER mount: no fetch until shots change (records the gap)', async () => {
    const renderer = await renderBanner(localShots);
    expect(pending).toHaveLength(0);
    establishApiSession(session);
    await flush();
    console.log(
      `[ATTACK S4-D] fetches after late session install, same shots: ${pending.length}`,
    );
    expect(pending).toHaveLength(0);
    // A shots change (e.g. hydrate finishing) does trigger it.
    await update(renderer, [...localShots]);
    expect(pending).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it(`E. 25 in-flight fetches, seeded resolution order (seed=0x${SEED.toString(16)}): only the last response is applied`, async () => {
    console.log(`[ATTACK S4-E] seed=0x${SEED.toString(16)}`);
    establishApiSession(session);
    const renderer = await renderBanner(localShots);
    for (let i = 1; i < 25; i++) await update(renderer, [...localShots]);
    expect(pending).toHaveLength(25);

    const rng = makeRng(SEED);
    const order = pending.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // Every stale request answers with a different (hostile) rating; the
    // last request answers with 9.9. Whatever order they land in, 9.90 must
    // be what renders — every stale closure is inactive.
    for (const index of order) {
      const body =
        index === 24
          ? accountRankBody
          : {
              rank: {
                ...accountRankBody.rank,
                rating: 1 + (index % 8),
              },
            };
      pending[index]!.resolve(body);
      await flush();
    }
    const label = rankLabel(renderer);
    expect(label).toContain('rating 9.90 out of 10');
    act(() => renderer.unmount());
  });
});
