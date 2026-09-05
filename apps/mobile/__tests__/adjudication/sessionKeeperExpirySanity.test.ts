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
 *    refresh exchange + Keychain write every millisecond).
 */
import {
  MAX_DELAY_MS,
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
  const fetchFn = jest.fn(async () => {
    calls += 1;
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
  return { fetchFn, onRotated, onRevoked };
}

function finiteDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => Number(call[1] ?? 0))
    .filter(delay => Number.isFinite(delay));
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
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const { fetchFn, onRotated, onRevoked } = keeperAnsweringExpiry(() =>
      Math.floor((Date.now() + 400 * DAY_MS) / 1000),
    );

    await jest.advanceTimersByTimeAsync(1_000);
    const delays = finiteDelays(setTimeoutSpy);
    setTimeoutSpy.mockRestore();

    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated).toHaveBeenCalledTimes(fetchFn.mock.calls.length);
    expect(onRevoked).not.toHaveBeenCalled();

    // The ceiling re-arms the keeper rather than parking the bearer forever:
    // a rotation lands within MAX_DELAY_MS of the launch exchange.
    const before = fetchFn.mock.calls.length;
    await jest.advanceTimersByTimeAsync(MAX_DELAY_MS);
    expect(fetchFn.mock.calls.length).toBe(before + 1);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a millisecond-scaled bearerExpiresAtMs passed at START is clamped on the launch path scheduleAheadOfExpiry(MIN_DELAY_MS)', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // `expiresAt * 1000` on an epoch-millisecond value, as sessionLifecycle
    // would produce it — nowhere near a 32-bit delay.
    const msScaledExpiry = Date.now() * 1000;
    const { fetchFn, onRevoked } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + 3600,
      msScaledExpiry,
    );

    const launchDelays = finiteDelays(setTimeoutSpy);
    expect(launchDelays.length).toBe(1);
    expect(launchDelays[0]).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(launchDelays[0]).toBeGreaterThan(1_000);

    // No collapsed timer: nothing fires inside one simulated second.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(Math.max(...finiteDelays(setTimeoutSpy))).toBeLessThanOrEqual(
      MAX_SAFE_TIMEOUT_MS,
    );
    setTimeoutSpy.mockRestore();

    // …and the keeper still comes back for the bearer within the ceiling.
    await jest.advanceTimersByTimeAsync(MAX_DELAY_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
