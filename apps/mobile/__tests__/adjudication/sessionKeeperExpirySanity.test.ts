/**
 * MAS-1 — the bearer expiry returned by `/v1/auth/refresh` must be
 * sanity-checked before it drives a timer.
 *
 * At 4d812e1a the keeper took `expiresAt` at face value: a past or skewed
 * expiry made `scheduleAheadOfExpiry()` compute a negative delay that
 * `schedule()` floored at 1 s, so every SUCCESSFUL rotation immediately
 * re-armed a 1 s timer (a per-second POST /v1/auth/refresh + Keychain write
 * loop), and an epoch-millisecond `expiresAt` produced a delay past the
 * signed 32-bit range `setTimeout` accepts.
 *
 * Fixed contract (pinned here):
 *  - sessionLifecycle.refreshApiSession normalises the expiry at the HTTP
 *    boundary: the bearer LIFETIME is measured against the server's own
 *    clock (the response `Date` header, when present), auto-detects
 *    seconds vs milliseconds, and an implausible lifetime (past, inside the
 *    refresh lead, or beyond a day) is replaced by the default lifetime —
 *    then re-anchored to the device clock.
 *  - sessionKeeper never hands setTimeout a delay above 2^31-1 (longer
 *    waits are taken in chunks) and a successful rotation never re-arms
 *    itself sooner than its rotation spacing.
 *  - None of this ever signs the user out.
 */
import {
  DEFAULT_BEARER_LIFETIME_MS,
  MAX_BEARER_LIFETIME_MS,
  MIN_BEARER_LIFETIME_MS,
  normalizeBearerExpiry,
  refreshApiSession,
} from '../../src/account/sessionLifecycle';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
/** The keeper rotates this long before the (normalised) expiry. */
const REFRESH_LEAD_MS = 60_000;
const HOUR_MS = 60 * 60_000;

function sessionResponse(
  expiresAt: number,
  n: number,
  headers: Record<string, string> = {},
): Response {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
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

function startWith(
  fetchFn: jest.Mock,
  bearerExpiresAtMs: number | null = null,
) {
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
  });
  return { onRotated, onRevoked, onDeferred };
}

function timerDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls.map(call => Number(call[1] ?? 0));
}

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a stale or skewed server expiry never produces a rotation storm', () => {
  it('a finite PAST expiry (now-3600s) performs ONE launch exchange in 30 s, stays signed in, and re-arms at the default lifetime', async () => {
    jest.useFakeTimers();
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(pastSeconds, calls);
    });
    const { onRotated, onRevoked } = startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();

    // The untrusted expiry is replaced by the default lifetime: the next
    // rotation lands REFRESH_LEAD before it, not one second later.
    await jest.advanceTimersByTimeAsync(
      DEFAULT_BEARER_LIFETIME_MS - REFRESH_LEAD_MS - 30_000 - 1_000,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('an expiry inside the 60 s refresh lead (now+30s) yields at most 2 exchanges in 20 s and the session stays signed in', async () => {
    jest.useFakeTimers();
    const skewedSeconds = Math.floor(Date.now() / 1000) + 30;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(skewedSeconds, calls);
    });
    const { onRotated, onRevoked } = startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(20_000);

    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a genuine one-hour expiry (no Date header) still rotates exactly REFRESH_LEAD ahead of it', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls);
    });
    const { onRevoked } = startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS - 1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a device clock two hours AHEAD of the server is corrected through the response Date header: the bearer lives its real hour', async () => {
    jest.useFakeTimers();
    const SKEW_MS = 2 * HOUR_MS;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      const serverNowMs = Date.now() - SKEW_MS;
      return sessionResponse(Math.floor(serverNowMs / 1000) + 3600, calls, {
        Date: new Date(serverNowMs).toUTCString(),
      });
    });
    const { onRevoked } = startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Taken at face value the expiry is an hour in the device's past; the
    // Date header says the token has 3600 s to live.
    await jest.advanceTimersByTimeAsync(
      HOUR_MS - REFRESH_LEAD_MS - 30_000 - 2_000,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a device clock two hours BEHIND the server does not wait past the real expiry', async () => {
    jest.useFakeTimers();
    const SKEW_MS = 2 * HOUR_MS;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      const serverNowMs = Date.now() + SKEW_MS;
      return sessionResponse(Math.floor(serverNowMs / 1000) + 3600, calls, {
        Date: new Date(serverNowMs).toUTCString(),
      });
    });
    startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS - 2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(4_000);
    // Face value would have waited ~3 h; the real lifetime is one hour.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('timer delays stay inside the signed 32-bit range setTimeout accepts', () => {
  it('an epoch-MILLISECOND expiresAt on refresh never schedules a delay above 2^31-1 and triggers no TimeoutOverflowWarning', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const emitWarning = jest.spyOn(process, 'emitWarning');
    const millisecondExpiry = Date.now() + HOUR_MS;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(millisecondExpiry, calls);
    });
    const { onRevoked } = startWith(fetchFn);

    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const delays = timerDelays(setTimeoutSpy);
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_BEARER_LIFETIME_MS);
    expect(
      emitWarning.mock.calls.some(call =>
        JSON.stringify(call).includes('TimeoutOverflowWarning'),
      ),
    ).toBe(false);

    // The millisecond value is recognised as such: the bearer rotates an
    // hour later (minus the lead), not after 1 s and not after 2^31 ms.
    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS - 1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a far-future START expiry (bootstrap path) is waited out in bounded chunks instead of overflowing', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const fetchFn = jest.fn(async () => sessionResponse(0, 1));
    // An epoch-millisecond expiry multiplied by 1000 again — far beyond the
    // 32-bit timer range.
    startWith(fetchFn, Date.now() * 1000);

    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    const armed = setTimeoutSpy.mock.calls.length;
    expect(armed).toBeGreaterThan(0);
    for (const delay of timerDelays(setTimeoutSpy)) {
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }

    // The first chunk elapses: no refresh, the wait is re-armed.
    await jest.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_MS);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(armed);
    for (const delay of timerDelays(setTimeoutSpy)) {
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }
  });
});

describe('normalizeBearerExpiry — the HTTP-boundary contract', () => {
  const clientNowMs = 1_800_000_000_000;

  it('the lifetime band is coherent with the keeper lead', () => {
    expect(MIN_BEARER_LIFETIME_MS).toBeGreaterThan(REFRESH_LEAD_MS);
    expect(DEFAULT_BEARER_LIFETIME_MS).toBeGreaterThanOrEqual(
      MIN_BEARER_LIFETIME_MS,
    );
    expect(MAX_BEARER_LIFETIME_MS).toBeGreaterThanOrEqual(
      DEFAULT_BEARER_LIFETIME_MS,
    );
    expect(MAX_BEARER_LIFETIME_MS).toBeLessThan(MAX_SAFE_TIMEOUT_MS);
  });

  it('a plausible epoch-seconds expiry is kept, measured against the client clock when the server clock is unknown', () => {
    const expiresAt = clientNowMs / 1000 + 3600;
    expect(
      normalizeBearerExpiry({ expiresAt, serverNowMs: null, clientNowMs }),
    ).toBe(clientNowMs + HOUR_MS);
  });

  it('an epoch-milliseconds expiry is recognised and not multiplied again', () => {
    const expiresAt = clientNowMs + HOUR_MS;
    expect(
      normalizeBearerExpiry({ expiresAt, serverNowMs: null, clientNowMs }),
    ).toBe(clientNowMs + HOUR_MS);
  });

  it('the lifetime is measured against the SERVER clock and re-anchored to the client clock', () => {
    const serverNowMs = clientNowMs - 2 * HOUR_MS; // device 2 h ahead
    const expiresAt = serverNowMs / 1000 + 3600;
    expect(normalizeBearerExpiry({ expiresAt, serverNowMs, clientNowMs })).toBe(
      clientNowMs + HOUR_MS,
    );
  });

  it.each([
    ['past', -3600],
    ['inside the refresh lead', 30],
    ['below the minimum lifetime', MIN_BEARER_LIFETIME_MS / 1000 - 1],
    ['beyond a day', MAX_BEARER_LIFETIME_MS / 1000 + 1],
    ['centuries away', 100 * 365 * 24 * 3600],
  ])(
    'an implausible lifetime (%s) falls back to the default lifetime from the client clock',
    (_label, lifetimeSeconds) => {
      const expiresAt = clientNowMs / 1000 + lifetimeSeconds;
      expect(
        normalizeBearerExpiry({ expiresAt, serverNowMs: null, clientNowMs }),
      ).toBe(clientNowMs + DEFAULT_BEARER_LIFETIME_MS);
    },
  );

  it('the band edges themselves are trusted', () => {
    expect(
      normalizeBearerExpiry({
        expiresAt: clientNowMs / 1000 + MIN_BEARER_LIFETIME_MS / 1000,
        serverNowMs: null,
        clientNowMs,
      }),
    ).toBe(clientNowMs + MIN_BEARER_LIFETIME_MS);
    expect(
      normalizeBearerExpiry({
        expiresAt: clientNowMs / 1000 + MAX_BEARER_LIFETIME_MS / 1000,
        serverNowMs: null,
        clientNowMs,
      }),
    ).toBe(clientNowMs + MAX_BEARER_LIFETIME_MS);
  });

  it('refreshApiSession applies it: a past expiry comes back as a default-lifetime expiry on the client clock, tokens untouched', async () => {
    const clientNow = Date.now();
    const tokens = await refreshApiSession(
      { apiBaseUrl: API_BASE_URL, refreshToken: 'refresh-0' },
      {
        fetchFn: async () =>
          sessionResponse(Math.floor(clientNow / 1000) - 3600, 7),
        now: () => clientNow,
      },
    );
    expect(tokens).toEqual({
      bearerToken: 'access-7',
      refreshToken: 'refresh-7',
      bearerExpiresAtMs: clientNow + DEFAULT_BEARER_LIFETIME_MS,
    });
  });

  it('refreshApiSession ignores an unparseable Date header', async () => {
    const clientNow = Date.now();
    const tokens = await refreshApiSession(
      { apiBaseUrl: API_BASE_URL, refreshToken: 'refresh-0' },
      {
        fetchFn: async () =>
          sessionResponse(Math.floor(clientNow / 1000) + 3600, 8, {
            Date: 'not a date',
          }),
        now: () => clientNow,
      },
    );
    expect(tokens.bearerExpiresAtMs).toBe(
      Math.floor(clientNow / 1000) * 1000 + HOUR_MS,
    );
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
