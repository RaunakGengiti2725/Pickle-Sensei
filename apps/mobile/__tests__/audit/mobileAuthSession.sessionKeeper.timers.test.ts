/**
 * Structural audit (mobile-auth-session, pass 1): sessionKeeper.ts driven with
 * fake timers. No existing auth suite exercises the scheduling arithmetic,
 * the retry backoff, the AppState foreground re-check, or the generation
 * fence — so each of those is pinned here, together with the suspected
 * defects (a past/zero `expiresAt` from the server, a callback that throws
 * on the non-retryable path).
 *
 * Every case is a pure unit test of the keeper: `fetchFn` is injected, no
 * store, no Keychain, no network.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import type { RefreshedTokens } from '../../src/account/sessionLifecycle';

// The mobile tsconfig has no node types; the unhandled-rejection hook below
// only needs these two members of the jest worker's process.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

type AppStateHandler = (state: string) => void;
const appStateMock = AppState as unknown as {
  addEventListener: jest.Mock;
};

/** Handlers the keeper registered since the last `jest.clearAllMocks()`. */
function foregroundHandlers(): AppStateHandler[] {
  return appStateMock.addEventListener.mock.calls
    .filter(([event]) => event === 'change')
    .map(([, handler]) => handler as AppStateHandler);
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const API = 'https://api.example.test';

/** A refresh server whose Nth answer is `answers[N]` (last one repeats). */
function refreshServer(
  answers: Array<(n: number) => Response | Promise<Response>>,
): jest.Mock {
  let n = 0;
  return jest.fn(async () => {
    const answer = answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    return answer(n);
  });
}

const okIn = (lifeSeconds: number) => (n: number) =>
  response({
    session: {
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      expiresAt: Math.floor(Date.now() / 1000) + lifeSeconds,
    },
  });

const networkDown = () => () => Promise.reject(new Error('network down'));
const serverError = () => () => response({ error: 'boom' }, 503);
const revoked = () => () => response({ error: 'gone' }, 401);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  jest.clearAllMocks();
  stopSessionKeeper();
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('audit/sessionKeeper timers: scheduling arithmetic', () => {
  it('rotates exactly 60s ahead of the bearer expiry (not before, not after)', async () => {
    const fetchFn = refreshServer([okIn(3600)]);
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 10 * 60_000,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });

    await jest.advanceTimersByTimeAsync(9 * 60_000 - 1);
    expect(fetchFn).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect((onRotated.mock.calls[0]![0] as RefreshedTokens).bearerToken).toBe(
      'access-1',
    );
  });

  it('a bearer already inside the 60s lead window refreshes after the 1s floor, never at 0ms', async () => {
    const fetchFn = refreshServer([okIn(3600)]);
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
  });

  it('started without a bearer it refreshes synchronously, then schedules ahead of the NEW expiry', async () => {
    const fetchFn = refreshServer([okIn(600), okIn(3600)]);
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
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).toHaveBeenCalledTimes(1);

    // New bearer lives 600s → next rotation at 540s.
    await jest.advanceTimersByTimeAsync(540_000 - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // The rotated refresh token is the one spent next.
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1].body))).toEqual({
      refreshToken: 'refresh-1',
    });
  });

  it('retryDelayMs: 5s, 10s, 20s, … capped at 5 min; attempt ≤ 1 is the base', () => {
    expect(retryDelayMs(0)).toBe(5_000);
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(6)).toBe(160_000);
    expect(retryDelayMs(7)).toBe(300_000);
    expect(retryDelayMs(50)).toBe(300_000);
  });

  it('transient failures back off 5s → 10s → 20s, report onDeferred each time, and a success resets the attempt counter', async () => {
    const fetchFn = refreshServer([
      networkDown(),
      serverError(),
      networkDown(),
      okIn(3600),
      networkDown(),
      okIn(3600),
    ]);
    const onDeferred = jest.fn();
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      onDeferred,
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000 - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onDeferred).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(10_000 - 1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onDeferred).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();

    // Success reset the counter: the next transient failure waits 5s again.
    await jest.advanceTimersByTimeAsync(3600_000 - 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(onRotated).toHaveBeenCalledTimes(2);
  });
});

describe('audit/sessionKeeper timers: foreground re-check', () => {
  it("'active' with < 5 min of bearer life refreshes at once; with more life it does nothing; non-active states are ignored", async () => {
    const fetchFn = refreshServer([okIn(3600)]);
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 10 * 60_000,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    const [handler] = foregroundHandlers();
    expect(handler).toBeDefined();

    handler!('active');
    expect(fetchFn).not.toHaveBeenCalled();

    // Simulate a suspension: the wall clock moves 6 min while the timer
    // (which fires at 9 min) has not, then the app comes back.
    jest.setSystemTime(Date.now() + 6 * 60_000);
    handler!('background');
    handler!('inactive');
    expect(fetchFn).not.toHaveBeenCalled();
    handler!('active');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("'active' while a refresh is in flight does not start a second one", async () => {
    let release: (() => void) | null = null;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () => resolve(okIn(3600)(1));
        }),
    );
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    foregroundHandlers()[0]!('active');
    refreshSessionNow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release!();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('audit/sessionKeeper timers: generation fence', () => {
  it('stopSessionKeeper drops an in-flight result (no onRotated), cancels the timer and removes the AppState listener', async () => {
    let release: (() => void) | null = null;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = () => resolve(okIn(3600)(1));
        }),
    );
    const onRotated = jest.fn();
    const remove = jest.fn();
    appStateMock.addEventListener.mockReturnValueOnce({ remove });
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    stopSessionKeeper();
    expect(remove).toHaveBeenCalledTimes(1);
    release!();
    await jest.advanceTimersByTimeAsync(0);
    expect(onRotated).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    refreshSessionNow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a second startSessionKeeper (account switch) fences the first: only the new refresh token is ever spent afterwards', async () => {
    let releaseA: (() => void) | null = null;
    const fetchA = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          releaseA = () => resolve(okIn(3600)(1));
        }),
    );
    const rotatedA = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-A',
      bearerExpiresAtMs: null,
      onRotated: rotatedA,
      onRevoked: jest.fn(),
      fetchFn: fetchA,
    });

    const fetchB = refreshServer([okIn(3600)]);
    const rotatedB = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-B',
      bearerExpiresAtMs: Date.now() + 10 * 60_000,
      onRotated: rotatedB,
      onRevoked: jest.fn(),
      fetchFn: fetchB,
    });

    releaseA!();
    await jest.advanceTimersByTimeAsync(0);
    expect(rotatedA).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9 * 60_000);
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchB.mock.calls[0]![1].body))).toEqual({
      refreshToken: 'refresh-B',
    });
    expect(rotatedB).toHaveBeenCalledTimes(1);
  });

  it('refresh refused (401) ⇒ onRevoked once, keeper stopped, no retry timer', async () => {
    const fetchFn = refreshServer([revoked()]);
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
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('audit/sessionKeeper timers: suspected defects', () => {
  it('SUSPECT: a server that returns an already-past expiresAt must not drive a 1s refresh loop', async () => {
    // A rotated session whose expiry is in the past (server clock behind the
    // device, or a mis-issued `expiresAt`) is scheduled at the 1s floor and
    // refreshed again and again: N refreshes in N seconds.
    const fetchFn = refreshServer([okIn(-30)]);
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    // Expected: at most a couple of rotations in 10s (some sane floor such
    // as the 5s retry base). Observed on 4d812e1a: one per second.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('SUSPECT: a huge expiresAt (ms instead of s) overflows setTimeout and refreshes immediately in a loop', async () => {
    const fetchFn = refreshServer([
      (n: number) =>
        response({
          session: {
            accessToken: `access-${n}`,
            refreshToken: `refresh-${n}`,
            // Seconds → the keeper multiplies by 1000; a server sending ms
            // yields a delay far beyond 2^31-1.
            expiresAt: Date.now() + 3600_000,
          },
        }),
    ]);
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('SUSPECT: onRevoked throwing on the non-retryable path must not escape as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const fetchFn = refreshServer([revoked()]);
      startSessionKeeper({
        apiBaseUrl: API,
        refreshToken: 'refresh-0',
        bearerExpiresAtMs: null,
        onRotated: jest.fn(),
        onRevoked: () => {
          throw new Error('sign-out cleanup failed');
        },
        fetchFn,
      });
      await jest.advanceTimersByTimeAsync(0);
      // Let Node deliver the unhandledRejection event (a real macrotask).
      jest.useRealTimers();
      await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('SUSPECT: onRotated throwing must not be classified as a transient refresh failure (onDeferred + an extra refresh 5s later)', async () => {
    const fetchFn = refreshServer([okIn(3600)]);
    let calls = 0;
    const onDeferred = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: () => {
        calls += 1;
        if (calls === 1) throw new Error('persist failed');
      },
      onRevoked: jest.fn(),
      onDeferred,
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // A callback failure is not a server failure: the keeper must not
    // report it as deferred nor spend another refresh 5s later (the retry
    // does at least use the rotated token — refreshToken is updated before
    // onRotated runs — so it is a spurious rotation, not a dead one).
    expect(onDeferred).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
