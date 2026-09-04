/**
 * Adversarial probe of the MAS-1 fix (candidate 4055a08d, base 4d812e1a).
 *
 * Two kinds of case live here:
 *  - "holds" cases: variants of the original repro (ordering, cancellation,
 *    clock jumps, garbage Date headers, unit confusion, alternating expiries)
 *    that the fixed refresh path must survive. They PASS on 4055a08d and are
 *    the evidence that the fix is not narrowly tuned to its own tests.
 *  - "gap" cases: the contract the fix states in sessionLifecycle.ts —
 *    "downstream code may trust `bearerExpiresAtMs` to lie a plausible
 *    lifetime ahead of the device clock" — is only enforced for
 *    `/v1/auth/refresh`. `bootstrap.ts` still hands `expiresAt * 1000` to the
 *    keeper (authStore.keepSessionAlive), so the SAME clock-skew scenario the
 *    fix targets survives on the sign-in path until the first rotation.
 *    These FAIL on 4055a08d (and on 4d812e1a: not a regression, an
 *    incomplete fix).
 */
import { AppState } from 'react-native';
import { bootstrapCanonicalAccount } from '../../src/account/bootstrap';
import {
  DEFAULT_BEARER_LIFETIME_MS,
  refreshApiSession,
} from '../../src/account/sessionLifecycle';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
const REFRESH_LEAD_MS = 60_000;
const FOREGROUND_LEAD_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

type AppStateListener = (state: string) => void;

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

function bootstrapResponse(
  expiresAt: number,
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
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
      session: {
        accessToken: 'access-0',
        refreshToken: 'refresh-0',
        expiresAt,
      },
    }),
  } as unknown as Response;
}

function failureResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Map(),
    json: async () => ({ error: { message: 'try later' } }),
  } as unknown as Response;
}

function startWith(
  fetchFn: jest.Mock,
  bearerExpiresAtMs: number | null = null,
  onRotated: jest.Mock = jest.fn(),
) {
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

/** The 'change' listener the keeper registered (last registration wins). */
function foregroundListener(): AppStateListener {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  const last = calls[calls.length - 1] as [string, AppStateListener];
  expect(last[0]).toBe('change');
  return last[1];
}

function timerDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls.map(call => Number(call[1] ?? 0));
}

const environment = {
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  device: {
    platform: 'ios' as const,
    osVersion: '18.5',
    appVersion: '1.0',
    model: 'iOS phone',
  },
};

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
  jest.restoreAllMocks();
  (AppState.addEventListener as jest.Mock).mockClear();
});

describe('holds — refresh-path variants of the MAS-1 repro', () => {
  it('a Date header that is garbage-but-parseable (epoch 0 / year 2100) falls back to the default lifetime: bounded exchanges, no sign-out', async () => {
    jest.useFakeTimers();
    for (const serverDate of [
      new Date(0).toUTCString(),
      new Date(Date.UTC(2100, 0, 1)).toUTCString(),
    ]) {
      stopSessionKeeper();
      let calls = 0;
      const fetchFn = jest.fn(async () => {
        calls += 1;
        return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls, {
          Date: serverDate,
        });
      });
      const { onRevoked } = startWith(fetchFn);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(
        DEFAULT_BEARER_LIFETIME_MS - REFRESH_LEAD_MS - 30_000 - 1_000,
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(onRevoked).not.toHaveBeenCalled();
    }
  });

  it('a server that sends `expires_in` where `expiresAt` belongs (3600) does not storm', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(3600, calls);
    });
    const { onRevoked } = startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('expiries alternating past / epoch-ms / far-future / negative across rotations never exceed one exchange per rotation spacing', async () => {
    jest.useFakeTimers();
    const shapes = [
      () => Math.floor(Date.now() / 1000) - 3600,
      () => Date.now() + HOUR_MS,
      () => Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600,
      () => -1,
      () => Math.floor(Date.now() / 1000) + 30,
      () => Math.floor(Date.now() / 1000) + 3600,
    ];
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(shapes[(calls - 1) % shapes.length]!(), calls);
    });
    const { onRevoked } = startWith(fetchFn);
    const HOURS = 12;
    await jest.advanceTimersByTimeAsync(HOURS * HOUR_MS);
    // One launch exchange plus at most one per (default lifetime - lead).
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(HOURS + 2);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(HOURS);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a transient 503 followed by a success carrying a PAST expiry stays bounded (launch, one backoff retry, then the default lifetime)', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return failureResponse(503);
      return sessionResponse(Math.floor(Date.now() / 1000) - 3600, calls);
    });
    const { onRevoked, onDeferred } = startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('refreshSessionNow() spam during a chunked far-future wait replaces the chunk timer (never stacks timers) and every exchange is normalised', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls);
    });
    startWith(fetchFn, Date.now() * 1000);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(fetchFn).toHaveBeenCalledTimes(5);
    // The chunk is gone; exactly one rotation timer remains, ~1 h out.
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS - 1_000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('stopSessionKeeper() during a chunked wait leaves no timer behind and nothing fires after a full chunk', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () => sessionResponse(0, 1));
    startWith(fetchFn, Date.now() * 1000);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);
    stopSessionKeeper();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_MS + 5_000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stop + restart while a refresh is in flight: the stale result is dropped and the new keeper schedules from its own exchange only', async () => {
    jest.useFakeTimers();
    let release: (() => void) | null = null;
    const slowFetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () =>
            resolve(sessionResponse(Math.floor(Date.now() / 1000) - 3600, 1));
        }),
    );
    const staleRotated = jest.fn();
    startWith(slowFetch, null, staleRotated);
    await jest.advanceTimersByTimeAsync(0);
    expect(slowFetch).toHaveBeenCalledTimes(1);

    let calls = 0;
    const freshFetch = jest.fn(async () => {
      calls += 1;
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, 100 + calls);
    });
    const freshRotated = jest.fn();
    startWith(freshFetch, null, freshRotated);
    await jest.advanceTimersByTimeAsync(0);
    expect(freshFetch).toHaveBeenCalledTimes(1);
    expect(freshRotated).toHaveBeenCalledTimes(1);

    release!();
    await jest.advanceTimersByTimeAsync(0);
    expect(staleRotated).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(freshFetch).toHaveBeenCalledTimes(2);
    expect(slowFetch).toHaveBeenCalledTimes(1);
  });

  it('a device clock that JUMPS 3 h forward after a rotation: foreground refreshes once, the elapsed-time timer is not duplicated, no storm', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls);
    });
    startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 3 * HOUR_MS);
    foregroundListener()('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('a device clock that JUMPS 3 h backward after a rotation: the pending timer still fires on elapsed time and re-anchors', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(Math.floor(Date.now() / 1000) + 3600, calls);
    });
    startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(0);
    jest.setSystemTime(Date.now() - 3 * HOUR_MS);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('device 2 h ahead AND an epoch-millisecond expiry AND a Date header: all three corrections compose', async () => {
    jest.useFakeTimers();
    const SKEW_MS = 2 * HOUR_MS;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      const serverNowMs = Date.now() - SKEW_MS;
      return sessionResponse(serverNowMs + HOUR_MS, calls, {
        Date: new Date(serverNowMs).toUTCString(),
      });
    });
    startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS - 2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('no delay handed to setTimeout is ever outside [1 s, 2^31-1] across pathological expiries', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const shapes = [
      () => Number.MAX_SAFE_INTEGER,
      () => -Number.MAX_SAFE_INTEGER,
      () => 0,
      () => Date.now() * 1000,
      () => Math.floor(Date.now() / 1000) + 3600,
    ];
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(shapes[(calls - 1) % shapes.length]!(), calls);
    });
    startWith(fetchFn, Number.MAX_SAFE_INTEGER);
    await jest.advanceTimersByTimeAsync(0);
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(6 * HOUR_MS);
    const delays = timerDelays(setTimeoutSpy).filter(d => d !== 15_000);
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }
  });

  it('refreshApiSession never rejects for a Response whose headers are a Map / plain object / absent', async () => {
    const shapes: unknown[] = [
      undefined,
      new Map<string, string>(),
      { get: () => null },
    ];
    for (const headers of shapes) {
      const tokens = await refreshApiSession(
        { apiBaseUrl: API_BASE_URL, refreshToken: 'refresh-0' },
        {
          fetchFn: async () =>
            ({
              ok: true,
              status: 200,
              headers,
              json: async () => ({
                session: {
                  accessToken: 'a',
                  refreshToken: 'r',
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              }),
            }) as unknown as Response,
        },
      );
      expect(tokens.bearerExpiresAtMs).toBeGreaterThan(Date.now());
    }
  });
});

describe('gap — the sign-in (bootstrap) path feeds the keeper an un-normalised expiry', () => {
  /** What authStore.keepSessionAlive does with a bootstrap result
   * (authStore.ts:321-334): the raw `bearerExpiresAtMs` drives the keeper. */
  async function signInWith(
    expiresAt: number,
    headers: Record<string, string>,
    refreshFetch: jest.Mock,
  ) {
    const result = await bootstrapCanonicalAccount({
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'provider-issued-jwt',
      provider: 'apple',
      environment,
      fetchFn: jest
        .fn()
        .mockResolvedValue(bootstrapResponse(expiresAt, headers)),
    });
    expect(result.apiSession.refreshToken).toBe('refresh-0');
    return startWith(refreshFetch, result.apiSession.bearerExpiresAtMs ?? null);
  }

  it('device clock 2 h BEHIND the server at sign-in: the bearer really dies after 1 h, but no rotation and no foreground re-check happens before ~3 h', async () => {
    jest.useFakeTimers();
    const SKEW_MS = 2 * HOUR_MS;
    let calls = 0;
    const refreshFetch = jest.fn(async () => {
      calls += 1;
      const serverNowMs = Date.now() + SKEW_MS;
      return sessionResponse(Math.floor(serverNowMs / 1000) + 3600, calls, {
        Date: new Date(serverNowMs).toUTCString(),
      });
    });
    const serverNowMs = Date.now() + SKEW_MS;
    const { onRevoked } = await signInWith(
      Math.floor(serverNowMs / 1000) + 3600,
      { Date: new Date(serverNowMs).toUTCString() },
      refreshFetch,
    );

    // 61 minutes later the server-side bearer has been dead for a minute.
    await jest.advanceTimersByTimeAsync(61 * MINUTE_MS);
    const rotatedBeforeRealExpiry = refreshFetch.mock.calls.length;

    // The user brings the app back to the foreground: the keeper compares
    // the (skewed, ~2 h out) expiry to FOREGROUND_LEAD and stays idle.
    foregroundListener()('active');
    await jest.advanceTimersByTimeAsync(0);
    const rotatedAfterForeground = refreshFetch.mock.calls.length;

    expect(onRevoked).not.toHaveBeenCalled();
    // Contract stated by the fix: bearerExpiresAtMs lies a plausible
    // lifetime ahead of the device clock, so a rotation lands before the
    // real expiry (a Date header was available to measure it).
    expect(rotatedBeforeRealExpiry).toBeGreaterThanOrEqual(1);
    expect(rotatedAfterForeground).toBeGreaterThanOrEqual(1);
  });

  it('(control) the SAME skew on the refresh path is corrected — the gap is specific to bootstrap.ts', async () => {
    jest.useFakeTimers();
    const SKEW_MS = 2 * HOUR_MS;
    let calls = 0;
    const refreshFetch = jest.fn(async () => {
      calls += 1;
      const serverNowMs = Date.now() + SKEW_MS;
      return sessionResponse(Math.floor(serverNowMs / 1000) + 3600, calls, {
        Date: new Date(serverNowMs).toUTCString(),
      });
    });
    startWith(refreshFetch);
    await jest.advanceTimersByTimeAsync(0);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HOUR_MS - REFRESH_LEAD_MS + 1_000);
    expect(refreshFetch).toHaveBeenCalledTimes(2);
  });
});

describe('gap — a legitimately short server lifetime is overwritten by the default', () => {
  it('a 3-minute bearer lifetime (Supabase allows it, discourages it) is treated as 1 h: the keeper waits past the real expiry (base 4d812e1a rotated at 2 min)', async () => {
    jest.useFakeTimers();
    const LIFETIME_MS = 3 * MINUTE_MS;
    let calls = 0;
    const fetchFn = jest.fn(async () => {
      calls += 1;
      return sessionResponse(
        Math.floor((Date.now() + LIFETIME_MS) / 1000),
        calls,
        { Date: new Date(Date.now()).toUTCString() },
      );
    });
    startWith(fetchFn);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(LIFETIME_MS + FOREGROUND_LEAD_MS);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
