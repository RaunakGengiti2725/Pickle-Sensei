/**
 * The session keeper rotates the bearer REFRESH_LEAD_MS (60s) before it
 * expires. When the server hands back a bearer whose expiry is already inside
 * that lead window — or in the past, because the phone's clock lags the
 * server's — a naive "expiry − lead" schedule goes negative, and the keeper
 * must not degenerate into a refresh-per-second storm against
 * /v1/auth/refresh (the edge budget is 30 per IP per minute; each rotation
 * also burns a refresh-token generation).
 *
 * Pins: a successful rotation never re-arms faster than MIN_ROTATION_GAP_MS,
 * whatever lifetime the server reports; the user stays signed in; and a
 * bearer with a normal lifetime is still rotated exactly 60s before expiry.
 */
import {
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../src/account/sessionKeeper';

type Served = { requestedAtMs: number };

function keeperFor(
  lifeSeconds: number,
  onRotated: SessionKeeperInput['onRotated'],
  onRevoked: SessionKeeperInput['onRevoked'],
) {
  const served: Served[] = [];
  let n = 0;
  const fetchFn: NonNullable<SessionKeeperInput['fetchFn']> = async () => {
    n += 1;
    served.push({ requestedAtMs: Date.now() });
    return new Response(
      JSON.stringify({
        session: {
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: Math.floor(Date.now() / 1000) + lifeSeconds,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  startSessionKeeper({
    apiBaseUrl: 'https://api.test',
    refreshToken: 'refresh-0',
    bearerExpiresAtMs: null,
    onRotated,
    onRevoked,
    fetchFn,
  });
  return served;
}

function maxInAnyWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[j] ?? Infinity) < (times[i] ?? 0) - windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

const TEN_MINUTES_MS = 10 * 60_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('sessionKeeper with a bearer that is short-lived or already expired by the phone clock', () => {
  it.each([
    ['expiry in the past (device clock lags the server)', -5],
    ['expiry inside the 60s refresh lead', 30],
    ['expiry exactly at the refresh lead', 60],
  ])('does not storm the refresh route: %s', async (_label, lifeSeconds) => {
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const served = keeperFor(lifeSeconds, onRotated, onRevoked);

    await jest.advanceTimersByTimeAsync(TEN_MINUTES_MS);

    const times = served.map(s => s.requestedAtMs);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(served.length);
    // 10 min at ≥30s between rotations: 1 immediate + ≤ 20 re-arms.
    expect(served.length).toBeLessThanOrEqual(21);
    expect(served.length).toBeGreaterThanOrEqual(2); // it keeps rotating
    expect(maxInAnyWindow(times, 60_000)).toBeLessThanOrEqual(3);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        30_000,
      );
    }
  });

  it('still rotates a normal-lifetime bearer 60s before it expires (the storm guard does not delay healthy rotation)', async () => {
    const onRotated = jest.fn();
    const served = keeperFor(3600, onRotated, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(served).toHaveLength(1);
    const first = served[0]?.requestedAtMs ?? Number.NaN;

    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1);
    expect(served).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(served).toHaveLength(2);
    expect(served[1]?.requestedAtMs).toBe(first + 3600_000 - 60_000);
  });

  it('still rotates the longest legitimate bearer (6 days, under the trust ceiling) exactly 60s before it expires — the ceiling neither delays nor advances it', async () => {
    const SIX_DAYS_S = 6 * 24 * 3600;
    const onRotated = jest.fn();
    const served = keeperFor(SIX_DAYS_S, onRotated, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(served).toHaveLength(1);
    const first = served[0]?.requestedAtMs ?? Number.NaN;

    await jest.advanceTimersByTimeAsync(SIX_DAYS_S * 1000 - 60_000 - 1);
    expect(served).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(served).toHaveLength(2);
    expect(served[1]?.requestedAtMs).toBe(first + SIX_DAYS_S * 1000 - 60_000);
  });
});
