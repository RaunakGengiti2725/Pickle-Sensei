/**
 * MAS-1 — `src/account/sessionKeeper.ts` must not let a server-supplied
 * bearer expiry drive the rotation timer unchecked.
 *
 * Fixed contract pinned here:
 *  - an expiry already in the past or inside the 60 s refresh lead re-arms no
 *    sooner than MIN_ROTATION_GAP_MS after a successful rotation, and never
 *    signs the user out;
 *  - every delay handed to setTimeout fits a 32-bit signed integer
 *    (2**31 - 1 ms), whatever `expiresAt` the server returns — an
 *    epoch-millisecond value multiplied by 1000 in `refreshApiSession` must
 *    be clamped, not passed through (Node and @sinonjs/fake-timers both
 *    collapse an over-range delay to 1 ms, which turns one bad expiry into a
 *    refresh exchange + Keychain write every millisecond);
 *  - an expiry the keeper cannot trust (not finite, or further out than
 *    MAX_TRUSTED_LIFE_MS — a millisecond-scaled or far-future value) is not
 *    scheduled from: at launch the refresh token is exchanged at once, after
 *    a rotation the bearer is re-checked on the paced 30 s → 5 min schedule,
 *    and the user is never signed out over it.
 */
import { AppState } from 'react-native';
import {
  MAX_DELAY_MS,
  MIN_ROTATION_GAP_MS,
  pacedRotationDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
const DAY_MS = 24 * 60 * 60_000;

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

function keeperAnsweringExpiry(
  expiresAtFor: () => number,
  bearerExpiresAtMs: number | null = null,
) {
  let calls = 0;
  const requestedAt: number[] = [];
  const fetchFn = jest.fn(async () => {
    calls += 1;
    requestedAt.push(Date.now());
    return sessionResponse(expiresAtFor(), calls);
  });
  const onRotated = jest.fn();
  const onRevoked = jest.fn();
  startSessionKeeper({
    apiBaseUrl: API_BASE_URL,
    refreshToken: 'refresh-0',
    bearerExpiresAtMs,
    onRotated,
    onRevoked,
    fetchFn,
  });
  return { fetchFn, onRotated, onRevoked, requestedAt };
}

function finiteDelays(spy: jest.SpyInstance): number[] {
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

afterEach(() => {
  stopSessionKeeper();
  // Restore any setTimeout spy BEFORE the fake clock is uninstalled, or the
  // sandbox loses `setTimeout` entirely when an assertion above failed.
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('sessionKeeper sanity-checks the bearer expiry before arming a timer', () => {
  it('a PAST expiry (now-3600s) performs at most 2 exchanges in 30 s and never revokes', async () => {
    jest.useFakeTimers();
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    const { fetchFn, onRotated, onRevoked } = keeperAnsweringExpiry(
      () => pastSeconds,
    );

    await jest.advanceTimersByTimeAsync(30_000);

    // Launch refresh + at most one rescheduled attempt.
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated).toHaveBeenCalledTimes(fetchFn.mock.calls.length);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an expiry inside the 60 s refresh lead (now+30s) performs at most 2 exchanges in 20 s and stays signed in', async () => {
    jest.useFakeTimers();
    const { fetchFn, onRotated, onRevoked } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + 30,
    );

    await jest.advanceTimersByTimeAsync(20_000);

    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated).toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an epoch-MILLISECOND expiresAt never schedules a delay past 2**31-1 ms (no TimeoutOverflowWarning collapse to 1 ms)', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(() => Date.now());

    await jest.advanceTimersByTimeAsync(0);
    const launchDelays = setTimeoutSpy.mock.calls
      .map(call => Number(call[1] ?? 0))
      .filter(delay => Number.isFinite(delay));

    // A collapsed delay fires every millisecond: one simulated second must
    // not turn into hundreds of exchanges.
    await jest.advanceTimersByTimeAsync(1_000);
    const exchanges = fetchFn.mock.calls.length;
    const allDelays = setTimeoutSpy.mock.calls
      .map(call => Number(call[1] ?? 0))
      .filter(delay => Number.isFinite(delay));
    setTimeoutSpy.mockRestore();

    expect(launchDelays.length).toBeGreaterThan(0);
    expect(Math.max(...launchDelays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(Math.max(...allDelays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(exchanges).toBeLessThanOrEqual(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an implausibly far-future SECONDS expiresAt (now+400 days) is clamped below 2**31-1 ms and does not storm', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const { fetchFn, onRotated, onRevoked, requestedAt } =
      keeperAnsweringExpiry(() =>
        Math.floor((Date.now() + 400 * DAY_MS) / 1000),
      );

    await jest.advanceTimersByTimeAsync(1_000);
    const delays = finiteDelays(setTimeoutSpy);

    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated).toHaveBeenCalledTimes(fetchFn.mock.calls.length);
    expect(onRevoked).not.toHaveBeenCalled();

    // Untrusted: not parked behind the ceiling, not rotated once a second —
    // re-checked on the paced schedule (30 s, doubling to 5 min) while the
    // server keeps answering that way, and never signed out.
    await jest.advanceTimersByTimeAsync(MAX_DELAY_MS);
    const times = requestedAt;
    expect(times[1]).toBe((times[0] ?? 0) + MIN_ROTATION_GAP_MS);
    expect(times[2]).toBe((times[1] ?? 0) + pacedRotationDelayMs(2));
    expect(maxInAnyWindow(times, 60_000)).toBeLessThanOrEqual(3);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(
      5 + MAX_DELAY_MS / pacedRotationDelayMs(Number.MAX_SAFE_INTEGER),
    );
    expect(Math.max(...finiteDelays(setTimeoutSpy))).toBeLessThanOrEqual(
      MAX_SAFE_TIMEOUT_MS,
    );
    expect(onRotated).toHaveBeenCalledTimes(fetchFn.mock.calls.length);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a millisecond-scaled bearerExpiresAtMs passed at START is not scheduled from: one launch exchange, no over-range delay, then the server schedule', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // `expiresAt * 1000` on an epoch-millisecond value, as sessionLifecycle
    // would produce it — nowhere near a 32-bit delay.
    const msScaledExpiry = Date.now() * 1000;
    const { fetchFn, onRevoked, requestedAt } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + 3600,
      msScaledExpiry,
    );

    // Untrusted at launch ⇒ treated like a missing bearer: exchanged once.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(requestedAt[0]).toBe(new Date('2026-09-06T12:00:00Z').getTime());

    // …and the trusted 1 h answer restores the 60 s-before schedule.
    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1_001);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(requestedAt[1]).toBe((requestedAt[0] ?? 0) + 3600_000 - 60_000);

    const delays = finiteDelays(setTimeoutSpy);
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a trusted bearer living longer than MAX_DELAY_MS passed at START is clamped on the launch path (re-checked after a day, exactly MAX_DELAY_MS)', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // Inside the Supabase JWT cap, so trusted — but a 3-day delay would
    // park the timer; the ceiling re-checks it daily instead.
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(
      () => Math.floor((Date.now() + 3 * DAY_MS) / 1000),
      Date.now() + 3 * DAY_MS,
    );

    const launchDelays = finiteDelays(setTimeoutSpy);
    expect(launchDelays).toEqual([MAX_DELAY_MS]);
    expect(MAX_DELAY_MS).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);

    await jest.advanceTimersByTimeAsync(MAX_DELAY_MS - 1);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Math.max(...finiteDelays(setTimeoutSpy))).toBeLessThanOrEqual(
      MAX_SAFE_TIMEOUT_MS,
    );
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a normal 1 h bearer passed at START is still rotated exactly 60 s before expiry (the ceiling neither delays nor advances it)', async () => {
    jest.useFakeTimers();
    const expiresAtMs = Date.now() + 3600_000;
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + 3600,
      expiresAtMs,
    );

    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('on foreground, an untrusted (millisecond-scaled) expiry is re-checked while a trusted 1 h bearer is left alone', async () => {
    jest.useFakeTimers();
    const foreground = captureForeground();
    let answerMs = true;
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(() =>
      answerMs ? Date.now() : Math.floor(Date.now() / 1000) + 3600,
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1); // launch exchange, ms answer

    // The keeper does not believe a bearer that claims to live for millennia
    // still has life left: the user coming back is a reason to re-check.
    answerMs = false;
    foreground();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2); // trusted 1 h answer now held

    foreground();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2); // 1 h of life left: no refresh
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an epoch-MILLISECOND expiresAt does not storm the refresh route under REAL timers', async () => {
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(() => Date.now());

    await new Promise<void>(resolve => {
      setTimeout(resolve, 200);
    });
    stopSessionKeeper();

    // Launch refresh only: nothing else may fire inside 200 ms of wall clock.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
