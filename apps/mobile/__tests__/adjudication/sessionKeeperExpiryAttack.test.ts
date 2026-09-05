/**
 * MAS-1 adversarial suite for `src/account/sessionKeeper.ts` (candidate
 * devin/close-mobile-auth-session-MAS-1-v2 @ 42bdcb40, base f702f0f8).
 *
 * Two families:
 *
 *  - `describe('regressions …')` pins behaviour the pre-fix keeper (f702f0f8)
 *    had and the candidate LOST. Every case here FAILS on 42bdcb40 and
 *    PASSES on f702f0f8 (same test file, keeper swapped) — see the attack
 *    report for the exact runs.
 *
 *  - `describe('hardening …')` doubles the scale of the original MAS-1
 *    repros (ordering, boundaries, restarts, cancellation, real wall clock)
 *    and must keep passing on the candidate; a failure here would mean the
 *    original storm is still reachable by some variant.
 *
 * Every test drives the keeper through the public API only, with jest's
 * fake clock (`jest.setSystemTime` moves `Date.now()` WITHOUT firing timers,
 * which is exactly what a device clock change looks like to the keeper:
 * `setTimeout` keeps running on the monotonic scheduler, `Date.now()` jumps).
 */
import { AppState } from 'react-native';
import {
  MIN_ROTATION_GAP_MS,
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const DAY_MS = 24 * 3600_000;
const HOUR_S = 3600;
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;

type Answer =
  | { kind: 'session'; expiresAt: number }
  | { kind: 'status'; status: number }
  | { kind: 'reject' };

function sessionResponse(expiresAt: number, n: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt,
      },
    }),
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

interface Harness {
  fetchFn: jest.Mock;
  onRotated: jest.Mock;
  onRevoked: jest.Mock;
  onDeferred: jest.Mock;
  requestedAtMs: number[];
  /** Replace the server's answer for every subsequent exchange. */
  answer: (next: () => Answer) => void;
}

function keeper(
  answerFor: () => Answer,
  bearerExpiresAtMs: number | null = null,
  extra: Partial<SessionKeeperInput> = {},
): Harness {
  let calls = 0;
  let current = answerFor;
  const requestedAtMs: number[] = [];
  const fetchFn = jest.fn(async () => {
    calls += 1;
    requestedAtMs.push(Date.now());
    const a = current();
    if (a.kind === 'reject') throw new TypeError('Network request failed');
    if (a.kind === 'status') return statusResponse(a.status);
    return sessionResponse(a.expiresAt, calls);
  });
  const onRotated = jest.fn();
  const onRevoked = jest.fn();
  const onDeferred = jest.fn();
  startSessionKeeper({
    apiBaseUrl: API_BASE_URL,
    refreshToken: 'refresh-0',
    bearerExpiresAtMs,
    onRotated,
    onRevoked,
    onDeferred,
    fetchFn,
    ...extra,
  });
  return {
    fetchFn,
    onRotated,
    onRevoked,
    onDeferred,
    requestedAtMs,
    answer: next => {
      current = next;
    },
  };
}

const serverSeconds = (lifeS: number) => (): Answer => ({
  kind: 'session',
  expiresAt: Math.floor(Date.now() / 1000) + lifeS,
});

function captureForeground(): () => void {
  let handler: ((state: string) => void) | null = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      handler = listener as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return () => handler?.('active');
}

function timerDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => Number(call[1] ?? 0))
    .filter(delay => Number.isFinite(delay));
}

function maxInAnyWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[j] ?? Infinity) < (times[i] ?? 0) - windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

afterEach(() => {
  stopSessionKeeper();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('regressions vs f702f0f8: the keeper now trusts the WALL clock for deadlines and for its rate gate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  });

  it('a trusted 1 h bearer is still rotated 60 s before expiry when the device clock is set BACK two days in the meantime (timers are monotonic; the bearer dies on the server regardless of the phone clock)', async () => {
    const h = keeper(serverSeconds(HOUR_S), Date.now() + HOUR_S * 1000);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.fetchFn).not.toHaveBeenCalled(); // trusted: waits for expiry-60s

    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.fetchFn).not.toHaveBeenCalled();

    // User (or an NTP correction) moves the device clock back two days.
    jest.setSystemTime(Date.now() - 2 * DAY_MS);

    // The 59 min timer elapses on the monotonic scheduler.
    await jest.advanceTimersByTimeAsync(29 * 60_000 + 1);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.onRotated).toHaveBeenCalledTimes(1);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('after a clock set-back, the bearer that has meanwhile expired on the server is rotated within one more hour of real time — not parked for the length of the jump', async () => {
    const foreground = captureForeground();
    const h = keeper(serverSeconds(HOUR_S), Date.now() + HOUR_S * 1000);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    jest.setSystemTime(Date.now() - 2 * DAY_MS);

    // 59 min mark passes, then a foreground, then another full hour.
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    foreground();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('with an untrusted (stale) server expiry, a clock set-back of one day must not close the self-rotation gate for a day: some rotation still happens within 5 min of real time after the jump', async () => {
    const foreground = captureForeground();
    // Server always answers with an expiry 5 s in the past (device ahead).
    const h = keeper(serverSeconds(-5));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1); // launch exchange

    await jest.advanceTimersByTimeAsync(10_000);
    jest.setSystemTime(Date.now() - DAY_MS); // clock set back one day

    foreground();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    // f702f0f8: paced at 30 s regardless of the wall clock → many rotations.
    // Expected floor: at least one self-decided rotation inside 5 real
    // minutes; the untrusted-expiry pace is capped at 5 min by design.
    expect(h.fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('a refresh forced by refreshSessionNow() that fails transiently is retried on the 5 s backoff, not held to lastRotation + 30 s (routes are refusing the bearer meanwhile)', async () => {
    const h = keeper(serverSeconds(HOUR_S));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1);
    const rotatedAt = h.requestedAtMs[0] ?? Number.NaN;

    // A route saw the bearer refused 1 s after the rotation; the refresh
    // route answers 503 once, then heals.
    await jest.advanceTimersByTimeAsync(1_000);
    let first = true;
    h.answer(() => {
      if (first) {
        first = false;
        return { kind: 'status', status: 503 };
      }
      return serverSeconds(HOUR_S)();
    });
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(2);
    expect(h.onDeferred).toHaveBeenCalledTimes(1);

    // retryDelayMs(1) = 5 s → the retry is due at rotatedAt + 6 s.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.requestedAtMs).toHaveLength(3);
    expect(h.requestedAtMs[2]).toBe(rotatedAt + 6_000);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('a bearer at exactly the Supabase JWT cap (7 d) with the device clock 1 s behind the server is still rotated ONCE, ~60 s before expiry — not every 5 min for a week', async () => {
    const SEVEN_DAYS_S = 7 * 24 * 3600;
    // Device is 1 s behind the server: the server's `expires_at` lands one
    // second past the 7 d ceiling as seen from the phone.
    const h = keeper(serverSeconds(SEVEN_DAYS_S + 1));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(DAY_MS);
    // f702f0f8: 1 exchange in the first 24 h (next at 7 d − 60 s).
    expect(h.fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });
});

describe('hardening: the MAS-1 storm stays unreachable under doubled-scale variants', () => {
  function useClock() {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  }

  it('server alternates epoch-MILLISECOND and seconds expiries: no over-range delay, ≤ 3 exchanges per minute, trusted answers restore the 60 s-before schedule', async () => {
    useClock();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    let n = 0;
    const h = keeper(() => {
      n += 1;
      return n % 2 === 1
        ? { kind: 'session', expiresAt: Date.now() } // milliseconds
        : serverSeconds(HOUR_S)();
    });
    await jest.advanceTimersByTimeAsync(2 * 3600_000);
    const delays = timerDelays(spy);
    spy.mockRestore();
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);
    // ms answer → paced 30 s → seconds answer (1 h) → rotate at +59 min.
    expect(h.requestedAtMs[0]).toBe(new Date('2026-09-06T12:00:00Z').getTime());
    expect(h.requestedAtMs[1]).toBe((h.requestedAtMs[0] ?? 0) + 30_000);
    expect(h.requestedAtMs[2]).toBe((h.requestedAtMs[1] ?? 0) + 3540_000);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['ms-scaled twice', Date.now() * 1000 * 1000],
  ])(
    'a %s bearerExpiresAtMs at start exchanges once at launch, arms no over-range delay, and then follows the server (1 h) schedule',
    async (_label, startExpiry) => {
      useClock();
      const spy = jest.spyOn(globalThis, 'setTimeout');
      const h = keeper(serverSeconds(HOUR_S), startExpiry);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(h.requestedAtMs).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(3540_000 - 1_001);
      expect(h.requestedAtMs).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.requestedAtMs).toHaveLength(2);
      const delays = timerDelays(spy);
      spy.mockRestore();
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
      expect(h.onRevoked).not.toHaveBeenCalled();
    },
  );

  it('stop → start (account switch) while the launch exchange is in flight: the stale answer is dropped and only the live keeper rotates, ≤ 2 exchanges in the first second even with a past expiry', async () => {
    useClock();
    let release: (() => void) | null = null;
    const slowFetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () => resolve(sessionResponse(Date.now() / 1000 - 60, 1));
        }),
    );
    const staleRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-old',
      bearerExpiresAtMs: null,
      onRotated: staleRotated,
      onRevoked: jest.fn(),
      fetchFn: slowFetch,
    });
    await jest.advanceTimersByTimeAsync(0);
    const h = keeper(serverSeconds(-60));
    release?.();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(staleRotated).not.toHaveBeenCalled();
    expect(h.requestedAtMs).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(maxInAnyWindow(h.requestedAtMs, MIN_ROTATION_GAP_MS - 1)).toBe(1);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('cancellation mid-flight: stopSessionKeeper() during a refresh whose answer is a past expiry leaves no timer behind (nothing fires in the next hour)', async () => {
    useClock();
    let release: (() => void) | null = null;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () => resolve(sessionResponse(Date.now() / 1000 - 60, 1));
        }),
    );
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    stopSessionKeeper();
    release?.();
    await jest.advanceTimersByTimeAsync(3600_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRotated).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refresh route flaps 503 ↔ stale expiry for an hour: backoff and pacing never exceed 3 exchanges in any minute and the user is never signed out', async () => {
    useClock();
    let n = 0;
    const h = keeper(() => {
      n += 1;
      return n % 2 === 0
        ? { kind: 'status', status: 503 }
        : serverSeconds(-30)();
    });
    await jest.advanceTimersByTimeAsync(3600_000);
    expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);
    expect(h.onRevoked).not.toHaveBeenCalled();
    expect(h.onRotated).toHaveBeenCalled();
  });

  it('the ONE sign-out still works: a 401 on the refresh route revokes exactly once, even with a stale expiry in play', async () => {
    useClock();
    let n = 0;
    const h = keeper(() => {
      n += 1;
      return n < 3 ? serverSeconds(-30)() : { kind: 'status', status: 401 };
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.onRevoked).toHaveBeenCalledTimes(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('REAL wall clock, 1 s: an epoch-millisecond expiry and a far-future seconds expiry each produce ≤ 2 exchanges and no over-range timer', async () => {
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const ms = keeper(() => ({ kind: 'session', expiresAt: Date.now() }));
    await new Promise<void>(resolve => {
      setTimeout(resolve, 500);
    });
    stopSessionKeeper();
    const far = keeper(() => ({
      kind: 'session',
      expiresAt: Math.floor((Date.now() + 400 * DAY_MS) / 1000),
    }));
    await new Promise<void>(resolve => {
      setTimeout(resolve, 500);
    });
    stopSessionKeeper();
    const delays = timerDelays(spy);
    spy.mockRestore();
    expect(ms.fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(far.fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(ms.onRevoked).not.toHaveBeenCalled();
    expect(far.onRevoked).not.toHaveBeenCalled();
  });
});
