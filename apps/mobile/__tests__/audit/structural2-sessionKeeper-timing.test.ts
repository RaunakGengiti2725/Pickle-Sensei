/**
 * Structural audit #2 (mobile-auth-session) — sessionKeeper scheduling driven
 * with fake timers. No existing auth suite drives the keeper's timer math, so
 * this file pins the documented contract (60 s lead, 1 s clamp, 5 s → 5 min
 * backoff with reset, foreground re-check, generation invalidation, no double
 * in-flight request) and exercises the unbounded-expiry hotspot
 * (sessionKeeper.ts scheduleAheadOfExpiry has no sanity bound).
 *
 * Audit-only: new file, touches no production code and no existing test.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import { SessionRefreshError } from '../../src/account/sessionLifecycle';

type AppStateHandler = (state: string) => void;

const API = 'https://api.test';
const HOUR_MS = 3_600_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function refreshOk(n: number, expiresAtMs: number): Response {
  return response({
    session: {
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      expiresAt: Math.floor(expiresAtMs / 1000),
    },
  });
}

let appStateHandlers: AppStateHandler[] = [];
let removedListeners = 0;

function emitAppState(state: string): void {
  for (const handler of [...appStateHandlers]) handler(state);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  appStateHandlers = [];
  removedListeners = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: AppStateHandler,
  ) => {
    appStateHandlers.push(handler);
    return {
      remove: () => {
        removedListeners += 1;
        appStateHandlers = appStateHandlers.filter(h => h !== handler);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('sessionKeeper timing contract (VERIFIED with fake timers)', () => {
  it('rotates exactly 60 s before the recorded expiry, then re-arms from the rotated expiry', async () => {
    let n = 0;
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => {
      n += 1;
      return refreshOk(n, Date.now() + HOUR_MS);
    });
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + HOUR_MS,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(HOUR_MS - 60_000 - 1);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).toEqual({
      refreshToken: 'refresh-0',
    });
    expect(onRotated).toHaveBeenCalledWith({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: Date.now() + HOUR_MS,
    });

    // Re-armed from the NEW expiry (1 h from the rotation), again 60 s ahead,
    // and the rotated refresh token is the one sent.
    await jest.advanceTimersByTimeAsync(HOUR_MS - 60_000 - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body))).toEqual({
      refreshToken: 'refresh-1',
    });
  });

  it('a bearer already inside the 60 s lead is refreshed after the 1 s clamp, and a null expiry refreshes immediately', async () => {
    const fetchFn = jest.fn(async () => refreshOk(1, Date.now() + HOUR_MS));
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 30_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    stopSessionKeeper();
    const immediate = jest.fn(async () => refreshOk(2, Date.now() + HOUR_MS));
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn: immediate,
    });
    expect(immediate).toHaveBeenCalledTimes(1);
  });

  it('transient failures back off 5 s → 10 s → … → 5 min (capped), the counter resets after a success, and onDeferred fires per failure', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);

    let failing = true;
    let n = 0;
    const fetchFn = jest.fn(async () => {
      if (failing) throw new TypeError('network down');
      n += 1;
      return refreshOk(n, Date.now() + HOUR_MS);
    });
    const onDeferred = jest.fn();
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      onDeferred,
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(1);

    const expectedDelays = [
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ];
    let calls = 1;
    for (const delay of expectedDelays) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(fetchFn).toHaveBeenCalledTimes(calls);
      await jest.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(fetchFn).toHaveBeenCalledTimes(calls);
    }
    expect(onDeferred).toHaveBeenCalledTimes(calls);
    expect(onRotated).not.toHaveBeenCalled();

    // Server comes back: the next retry (300 s) succeeds, the schedule is
    // ahead-of-expiry again and the failure counter is reset — one more
    // failure then waits 5 s, not 5 min.
    failing = false;
    await jest.advanceTimersByTimeAsync(300_000);
    expect(onRotated).toHaveBeenCalledTimes(1);
    failing = true;
    await jest.advanceTimersByTimeAsync(HOUR_MS - 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(calls + 2);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetchFn).toHaveBeenCalledTimes(calls + 2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(calls + 3);
  });

  it('a refusal (401/403) stops the keeper: onRevoked once, no retry, listener removed, refreshSessionNow becomes a no-op', async () => {
    const fetchFn = jest.fn(async () => response({ error: 'nope' }, 401));
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked,
      onDeferred,
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(onDeferred).not.toHaveBeenCalled();
    expect(removedListeners).toBe(1);
    refreshSessionNow();
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('foreground: "active" refreshes at once only when < 5 min of bearer life remain (or no bearer); other transitions do nothing', async () => {
    const fetchFn = jest.fn(async () => refreshOk(1, Date.now() + HOUR_MS));
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 10 * 60_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(appStateHandlers).toHaveLength(1);
    emitAppState('active');
    emitAppState('background');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();

    // 5 min 1 s later the bearer has < 5 min left: the next foreground rotates.
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    emitAppState('background');
    emitAppState('inactive');
    expect(fetchFn).not.toHaveBeenCalled();
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // The rotation re-armed the schedule; a foreground with a fresh bearer
    // does not refresh again.
    emitAppState('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stopSessionKeeper drops an in-flight result (no onRotated), cancels the timer and removes the AppState listener', async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          resolveFetch = resolve;
        }),
    );
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    stopSessionKeeper();
    expect(removedListeners).toBe(1);
    resolveFetch!(refreshOk(1, Date.now() + HOUR_MS));
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshSessionNow while a refresh is in flight issues no second request; after it lands it rotates immediately', async () => {
    const pending: Array<(r: Response) => void> = [];
    let n = 0;
    const fetchFn = jest.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>(resolve => {
          pending.push(resolve);
        }),
    );
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    refreshSessionNow();
    refreshSessionNow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    n += 1;
    pending.shift()!(refreshOk(n, Date.now() + HOUR_MS));
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).toHaveBeenCalledTimes(1);

    // A route 401 ahead of the recorded expiry → immediate rotation with the
    // rotated refresh token, and the ahead-of-expiry timer is replaced.
    refreshSessionNow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body))).toEqual({
      refreshToken: 'refresh-1',
    });
    n += 1;
    pending.shift()!(refreshOk(n, Date.now() + HOUR_MS));
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a stale generation cannot resurrect itself: a keeper restarted for another token ignores the old one entirely', async () => {
    const seen: string[] = [];
    const fetchFn = jest.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).refreshToken);
      return refreshOk(seen.length, Date.now() + HOUR_MS);
    });
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'old',
      bearerExpiresAtMs: Date.now() + 90_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'new',
      bearerExpiresAtMs: Date.now() + 120_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(seen[0]).toBe('new');
    expect(seen).not.toContain('old');
    expect(removedListeners).toBe(1);
  });

  it('a SessionRefreshError marked retryable is retried, a non-SessionRefreshError thrown by fetch is also treated as transient', async () => {
    const errors = [
      new SessionRefreshError('server trouble', true),
      new Error('boom'),
    ];
    const fetchFn = jest.fn(async () => {
      const error = errors.shift();
      if (error) throw error;
      return refreshOk(1, Date.now() + HOUR_MS);
    });
    const onRevoked = jest.fn();
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(1);
  });
});

describe('sessionKeeper expiry bounds (hotspot: scheduleAheadOfExpiry has no sanity bound)', () => {
  it('SUSPECTED DEFECT: when the server-issued expiry is not in the device future (clock skew ≥ bearer lifetime), the keeper rotates once per second without bound', async () => {
    // Device clock runs 2 h ahead of the server: every token the server
    // mints (1 h of life) is already "expired" by the device's clock.
    const DEVICE_SKEW_MS = 2 * HOUR_MS;
    let n = 0;
    const fetchFn = jest.fn(async () => {
      n += 1;
      const serverNowMs = Date.now() - DEVICE_SKEW_MS;
      return refreshOk(n, serverNowMs + HOUR_MS);
    });
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() - DEVICE_SKEW_MS + HOUR_MS,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(60_000);
    const rotationsInFirstMinute = fetchFn.mock.calls.length;
    // Observed on 4d812e1a: 60 rotations in 60 s (one every MIN_DELAY_MS),
    // each one spending and re-minting the refresh token and re-writing the
    // Keychain. Expected: a bearer the server just minted is rotated at most
    // a handful of times per minute — the schedule needs a floor that is not
    // the 1 s clamp when the computed lead is negative.
    expect(rotationsInFirstMinute).toBeLessThanOrEqual(2);
  });

  it('VERIFIED: refreshApiSession accepts any finite expiresAt (including one already in the past) and the keeper trusts it — pinning the input the bound would have to guard', async () => {
    const fetchFn = jest.fn(async () => refreshOk(1, Date.now() - 1_000));
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerExpiresAtMs: Math.floor((Date.now() - 1_000) / 1000) * 1000,
      }),
    );
    // Next rotation is 1 s away (the clamp), not 1 h.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
