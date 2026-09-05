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
 *
 * Extended contract (second describe): an expiry the keeper cannot trust —
 * implausibly far out in SECONDS, or an already millisecond-scaled
 * `bearerExpiresAtMs` handed to `startSessionKeeper` at launch — is treated
 * like no expiry at all: rotations are self-paced (never closer than
 * MIN_ROTATION_GAP_MS, widening while the server keeps answering with an
 * untrusted expiry), a healthy answer restores the exact 60 s-before-expiry
 * schedule, and every rotation the keeper decides on by itself (timer, or a
 * foreground while the expiry is untrusted) shares ONE rate gate keyed on
 * the last successful rotation — while `refreshSessionNow()`, a route that
 * actually saw the bearer refused, still rotates at once.
 */
import { AppState } from 'react-native';
import {
  MIN_ROTATION_GAP_MS,
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
const DAY_MS = 24 * 3600_000;
const HOUR_SECONDS = 3600;

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
  const requestedAtMs: number[] = [];
  const fetchFn = jest.fn(async () => {
    calls += 1;
    requestedAtMs.push(Date.now());
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
  return { fetchFn, onRotated, onRevoked, requestedAtMs };
}

function timerDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => Number(call[1] ?? 0))
    .filter(delay => Number.isFinite(delay));
}

function gapsMs(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] ?? 0));
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

  it('an epoch-MILLISECOND expiresAt never schedules a delay past 2**31-1 ms (no timer-overflow collapse to 1 ms)', async () => {
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

describe('sessionKeeper treats an implausible expiry as no expiry: self-paced, rate-gated rotation', () => {
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

  it('a far-future SECONDS expiresAt (now + 400 days) never arms a delay past 2**31-1 ms and rotates at a widening pace, never faster than MIN_ROTATION_GAP_MS', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const { fetchFn, onRotated, onRevoked, requestedAtMs } =
      keeperAnsweringExpiry(() =>
        Math.floor((Date.now() + 400 * DAY_MS) / 1000),
      );

    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);

    await jest.advanceTimersByTimeAsync(3600_000 - 1_000);
    const delays = timerDelays(setTimeoutSpy);
    setTimeoutSpy.mockRestore();

    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(requestedAtMs.length);
    // Alive (an untrusted expiry is not a reason to stop rotating) but
    // paced: 30 s, 60 s, 120 s, 240 s, then the 5 min ceiling → ≤ 16 in 1 h.
    expect(requestedAtMs.length).toBeGreaterThanOrEqual(3);
    expect(requestedAtMs.length).toBeLessThanOrEqual(16);
    const gaps = gapsMs(requestedAtMs);
    for (const gap of gaps)
      expect(gap).toBeGreaterThanOrEqual(MIN_ROTATION_GAP_MS);
    expect(gaps[0]).toBe(MIN_ROTATION_GAP_MS);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] ?? 0);
    }
  });

  it('a millisecond-scaled bearerExpiresAtMs passed at START is clamped on the launch path: no over-range delay, ≤ 2 exchanges in 1 s, and a healthy answer restores the exact 60 s-before-expiry schedule', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // What refreshApiSession/bootstrap produce from an epoch-MILLISECOND
    // expiresAt: the value multiplied by 1000 once more.
    const { fetchFn, onRevoked, requestedAtMs } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + HOUR_SECONDS,
      Date.now() * 1000,
    );

    await jest.advanceTimersByTimeAsync(0);
    const launchDelays = timerDelays(setTimeoutSpy);
    await jest.advanceTimersByTimeAsync(1_000);
    const exchangesInFirstSecond = fetchFn.mock.calls.length;
    expect(exchangesInFirstSecond).toBeGreaterThanOrEqual(1);
    expect(exchangesInFirstSecond).toBeLessThanOrEqual(2);
    for (const delay of launchDelays) {
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }

    const first = requestedAtMs[0] ?? Number.NaN;
    await jest.advanceTimersByTimeAsync(HOUR_SECONDS * 1000 - 60_000 - 1_001);
    expect(requestedAtMs).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(requestedAtMs).toHaveLength(2);
    expect(requestedAtMs[1]).toBe(first + HOUR_SECONDS * 1000 - 60_000);

    const delays = timerDelays(setTimeoutSpy);
    setTimeoutSpy.mockRestore();
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('foreground flapping inside the rotation gap with an untrusted expiry collapses into ONE rotation at exactly lastRotation + MIN_ROTATION_GAP_MS', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const foreground = captureForeground();
    const { fetchFn, onRevoked, requestedAtMs } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) - 5, // stale expiry every time
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(requestedAtMs).toHaveLength(1);
    const rotatedAt = requestedAtMs[0] ?? Number.NaN;

    for (let i = 0; i < 10; i++) {
      await jest.advanceTimersByTimeAsync(1_000);
      foreground();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(MIN_ROTATION_GAP_MS);
    expect(requestedAtMs).toHaveLength(2);
    expect(requestedAtMs[1]).toBe(rotatedAt + MIN_ROTATION_GAP_MS);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('refreshSessionNow() (a route saw the bearer refused) still rotates at once inside the gap, and foreground with a trusted bearer under 5 min left still refreshes immediately', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    const foreground = captureForeground();
    // Trusted but short bearer: 200 s.
    const { fetchFn, onRevoked, requestedAtMs } = keeperAnsweringExpiry(
      () => Math.floor(Date.now() / 1000) + 200,
      Date.now() + 200_000,
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled(); // trusted: waits for expiry - 60 s

    foreground();
    await jest.advanceTimersByTimeAsync(0);
    expect(requestedAtMs).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(5_000);
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(requestedAtMs).toHaveLength(2);
    expect(requestedAtMs[1]).toBe((requestedAtMs[0] ?? 0) + 5_000);

    await jest.advanceTimersByTimeAsync(5_000);
    foreground();
    await jest.advanceTimersByTimeAsync(0);
    expect(requestedAtMs).toHaveLength(3);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
