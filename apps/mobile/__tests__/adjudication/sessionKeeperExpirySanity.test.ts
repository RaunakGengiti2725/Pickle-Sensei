/**
 * `src/account/sessionKeeper.ts` — timer scheduling derived from a
 * server-supplied bearer expiry.
 *
 * The expiry returned by /v1/auth/refresh is not trusted blindly: an expiry
 * that is already past or inside the refresh lead (device clock ahead of the
 * server, a stale server value) must not re-arm a 1 s rotation after every
 * SUCCESSFUL exchange, and an implausibly distant expiry (e.g. a value sent in
 * epoch milliseconds) must not hand setTimeout a delay beyond the 32-bit range
 * (Node clamps such a delay to 1 ms with a TimeoutOverflowWarning — the same
 * storm). Being unable to trust the expiry never signs the user out.
 */
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
/** A successful rotation must never re-arm sooner than this, whatever the
 * server expiry looked like. */
const MIN_POST_SUCCESS_DELAY_MS = 60_000;
/** sessionLifecycle's own request timeout — not a keeper reschedule. */
const REQUEST_TIMEOUT_MS = 15_000;

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

function failureResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: 'try later' } }),
  } as unknown as Response;
}

/** Delays handed to setTimeout by the keeper (its own module scope only —
 * sessionLifecycle's request timeout is excluded by value). */
function keeperDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => Number(call[1] ?? 0))
    .filter(delay => Number.isFinite(delay));
}

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('the server bearer expiry is sanity-checked before it drives a timer', () => {
  it('a finite PAST expiry (now-3600s) after a successful refresh does not loop: at most 2 exchanges in 30 s, never a sign-out', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(pastSeconds, calls);
    });
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      onDeferred,
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(30_000);

    // Launch refresh + at most one rescheduled attempt.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onRotated).toHaveBeenCalledWith(
      expect.objectContaining({ bearerToken: 'access-1' }),
    );
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onDeferred).not.toHaveBeenCalled();

    // The post-success reschedule is rate-limited well above 1 s.
    const rescheduled = keeperDelays(setTimeoutSpy).filter(
      delay => delay !== REQUEST_TIMEOUT_MS,
    );
    expect(rescheduled.length).toBeGreaterThan(0);
    for (const delay of rescheduled) {
      expect(delay).toBeGreaterThanOrEqual(MIN_POST_SUCCESS_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }

    // The keeper is still alive, not stalled: an untrusted expiry still
    // rotates again within the day, just never at 1 Hz.
    await jest.advanceTimersByTimeAsync(24 * 3600_000);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2 + 24 * 60);
    expect(onRevoked).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('an expiry already inside the 60 s refresh lead (now+30s) yields at most 2 exchanges in 20 s and the session stays signed in', async () => {
    jest.useFakeTimers();
    const skewedSeconds = Math.floor(Date.now() / 1000) + 30; // < REFRESH_LEAD
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(skewedSeconds, calls);
    });
    const onRotated = jest.fn();
    const onRevoked = jest.fn();

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(20_000);

    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onRotated).toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a millisecond-valued expiresAt never schedules a delay past the 32-bit timer range (no TimeoutOverflowWarning)', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // A server (or a future contract change) sending epoch MILLISECONDS is
    // multiplied by 1000 again in sessionLifecycle.refreshApiSession.
    const millisecondExpiry = Date.now();
    const fetchFn = jest.fn(async () => sessionResponse(millisecondExpiry, 1));
    const onRevoked = jest.fn();

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked,
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(0);

    // Node raises TimeoutOverflowWarning (and collapses the delay to 1 ms)
    // for anything above the 32-bit range; every delay must stay inside it.
    const delays = keeperDelays(setTimeoutSpy);
    expect(delays.length).toBeGreaterThan(1); // request timeout + reschedule
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }
    expect(onRevoked).not.toHaveBeenCalled();

    // The ceiling is a real reschedule, not a stall: the keeper rotates again
    // before the 32-bit limit elapses, and never sooner than the floor.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(MIN_POST_SUCCESS_DELAY_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_MS);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onRevoked).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('a plausible expiry (now+3600s) still rotates exactly 60 s ahead of it', async () => {
    jest.useFakeTimers();
    const hourAhead = Math.floor(Date.now() / 1000) + 3600;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      // Each rotation mints a bearer good for another hour from "now".
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls);
    });

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: hourAhead * 1000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1_000);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The rotated bearer (another hour) is honoured the same way.
    await jest.advanceTimersByTimeAsync(3600_000 - 60_000 - 1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('refreshSessionNow ignores the keeper backoff', () => {
  it('every API 401 forces an immediate exchange while a backoff timer is pending', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () => failureResponse(503));

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      onDeferred: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1); // launch refresh failed; retry in 5s

    for (let i = 0; i < 10; i += 1) {
      refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
    }

    // 10 more exchanges inside the first backoff window (no time elapsed).
    expect(fetchFn).toHaveBeenCalledTimes(11);
  });
});
