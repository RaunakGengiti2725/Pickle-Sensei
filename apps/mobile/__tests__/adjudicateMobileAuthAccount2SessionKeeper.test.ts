/**
 * Adjudication replay (stress area mobile-auth-account-2, baseline 1fb0efd7).
 *
 * Candidate: `refreshApiSession` / `parseSessionTokens` validate `expiresAt`
 * with Number.isFinite BEFORE the ×1000 to milliseconds, so a finite second
 * count such as 1e308 or Number.MAX_VALUE becomes bearerExpiresAtMs=Infinity,
 * and `sessionKeeper` passes `Math.max(1000, Infinity)` (or any delay above
 * 2^31-1 ms) straight to setTimeout. Node and jest clamp such a delay to 1 ms,
 * so every successful rotation immediately re-arms the next one.
 *
 * Each `it` below FAILS on the baseline; a hardening fix must make them pass.
 * Replay payloads: expiresAt ∈ {1e308, Number.MAX_VALUE, now_s + 2^31/1000 + 61}.
 * Plane: Linux/Jest only — the iOS RCTTiming behaviour is not established here.
 */
import { refreshApiSession } from '../src/account/sessionLifecycle';
import {
  MIN_ROTATION_GAP_MS,
  startSessionKeeper,
  stopSessionKeeper,
} from '../src/account/sessionKeeper';

const API = 'https://api.test';

function sessionResponse(expiresAt: number, n: number): Response {
  return new Response(
    JSON.stringify({
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function maxInAnyWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[j] ?? Infinity) < (times[i] ?? 0) - windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

const STORM_KILL = 200;
const TWO_POW_31_S = Math.ceil((2 ** 31 - 1) / 1000);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('adjudication: oversized expiresAt', () => {
  it.each([1e308, Number.MAX_VALUE])(
    'refreshApiSession returns a finite bearerExpiresAtMs for expiresAt=%p',
    async expiresAt => {
      const tokens = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'r0' },
        { fetchFn: async () => sessionResponse(expiresAt, 1) },
      );
      expect(Number.isFinite(tokens.bearerExpiresAtMs)).toBe(true);
    },
  );

  it.each([
    ['expiresAt = 1e308', () => 1e308],
    [
      'expiresAt just past 2^31-1 ms from now',
      () => Math.floor(Date.now() / 1000) + TWO_POW_31_S + 61,
    ],
  ])(
    'sessionKeeper never rotates faster than MIN_ROTATION_GAP_MS when the server sends %s',
    async (_label, expiresAt) => {
      let n = 0;
      const times: number[] = [];
      const t0 = Date.now();
      startSessionKeeper({
        apiBaseUrl: API,
        refreshToken: 'r0',
        bearerExpiresAtMs: null,
        onRotated: () => undefined,
        onRevoked: () => undefined,
        fetchFn: async () => {
          n += 1;
          times.push(Date.now() - t0);
          if (n > STORM_KILL) stopSessionKeeper();
          return sessionResponse(expiresAt(), n);
        },
      });
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      console.log(
        `[adjudicate] ${_label}: ${n} refresh requests in 10 min; max in any 60 s window = ${maxInAnyWindow(times, 60_000)}`,
      );
      // 10 minutes at the documented ≥30 s gap: 1 immediate + ≤20 re-arms.
      expect(n).toBeLessThanOrEqual(1 + (10 * 60_000) / MIN_ROTATION_GAP_MS);
      expect(maxInAnyWindow(times, 60_000)).toBeLessThanOrEqual(3);
    },
  );

  it('real Node timers (300 ms wall): expiresAt=1e308 must not produce more than the one immediate refresh', async () => {
    jest.useRealTimers();
    let n = 0;
    try {
      startSessionKeeper({
        apiBaseUrl: API,
        refreshToken: 'r0',
        bearerExpiresAtMs: null,
        onRotated: () => undefined,
        onRevoked: () => undefined,
        fetchFn: async () => {
          n += 1;
          if (n > STORM_KILL) stopSessionKeeper();
          return sessionResponse(1e308, n);
        },
      });
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
      stopSessionKeeper();
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(`[adjudicate] real timers: ${n} refresh requests in 300 ms`);
    expect(n).toBe(1);
  });

  it('control: an expiry 3 minutes INSIDE the 2^31-1 ms limit rotates once (HELD on baseline)', async () => {
    let n = 0;
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'r0',
      bearerExpiresAtMs: null,
      onRotated: () => undefined,
      onRevoked: () => undefined,
      fetchFn: async () => {
        n += 1;
        return sessionResponse(
          Math.floor(Date.now() / 1000) + TWO_POW_31_S - 180,
          n,
        );
      },
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(n).toBe(1);
  });
});
