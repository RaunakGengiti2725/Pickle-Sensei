/**
 * Adjudication reproductions for `src/account/sessionKeeper.ts` — timer
 * scheduling derived from a server-supplied bearer expiry.
 *
 * These tests characterise the behaviour observed at 4d812e1a; they are
 * written as reproductions (asserting the defective behaviour) so a fixer can
 * flip each assertion once the expiry is sanity-checked and the delay is
 * clamped.
 */
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;

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

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('bearer expiry is taken at face value', () => {
  it('a finite PAST expiry makes the keeper rotate at 1 Hz indefinitely', async () => {
    jest.useFakeTimers();
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(pastSeconds, calls);
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

    await jest.advanceTimersByTimeAsync(30_000);

    // One launch refresh + one per second afterwards: the rotation never
    // settles even though every exchange SUCCEEDS.
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(25);
    expect(onRotated.mock.calls.length).toBeGreaterThanOrEqual(25);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an expiry already inside the 60s refresh lead loops the same way (clock skew)', async () => {
    jest.useFakeTimers();
    const skewedSeconds = Math.floor(Date.now() / 1000) + 30; // < REFRESH_LEAD
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(skewedSeconds, calls);
    });

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(20_000);

    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(15);
  });

  it('a millisecond-valued expiresAt schedules a delay past the 32-bit timer range', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    // A server (or a future contract change) sending epoch MILLISECONDS is
    // multiplied by 1000 again in sessionLifecycle.refreshApiSession.
    const millisecondExpiry = Date.now();
    const fetchFn = jest.fn(async () => sessionResponse(millisecondExpiry, 1));

    startSessionKeeper({
      apiBaseUrl: API_BASE_URL,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(0);

    const delays = setTimeoutSpy.mock.calls
      .map(call => Number(call[1] ?? 0))
      .filter(delay => Number.isFinite(delay));
    expect(Math.max(...delays)).toBeGreaterThan(MAX_SAFE_TIMEOUT_MS);
    setTimeoutSpy.mockRestore();
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
