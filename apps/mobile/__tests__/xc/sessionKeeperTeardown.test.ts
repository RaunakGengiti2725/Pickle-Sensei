/**
 * sessionKeeper teardown contract — the gaps the timing suite leaves open
 * (found by mutation: each `it` below fails against a specific surviving
 * variant of sessionKeeper.ts / sessionLifecycle.ts):
 *
 *  - a refused refresh token (401/403) ENDS the keeper, not just reports it:
 *    afterwards refreshSessionNow(), a foreground and elapsed time spend
 *    nothing, onRevoked fires exactly once and the AppState listener is gone
 *    (variant: `onRevoked` without `stopSessionKeeper()`);
 *  - stopSessionKeeper() removes the AppState subscription and clears the
 *    pending timer (variant: `removeAppStateListener?.()` dropped);
 *  - starting a keeper for another account tears the previous one down:
 *    exactly one live listener and one pending timer (variant: `start()`
 *    bumps the generation without stopping the previous keeper);
 *  - a 200 whose refreshToken is blank is a MALFORMED body: the keeper keeps
 *    the refresh token it has and retries with it, never adopting ''
 *    (variant: `.trim()` check on refreshToken dropped).
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';
import {
  SessionRefreshError,
  refreshApiSession,
  type RefreshedTokens,
  type SessionFetch,
} from '../../src/account/sessionLifecycle';

const MINUTE = 60_000;
const API = 'https://api.example.test';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function sessionBody(access: string, refresh: string, expiresAtMs: number) {
  return {
    session: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Math.floor(expiresAtMs / 1000),
    },
  };
}

interface Refresher {
  fetchFn: FetchMock;
  answers: Array<() => Promise<Response>>;
  sentRefreshTokens: () => string[];
}

function refresher(): Refresher {
  const answers: Array<() => Promise<Response>> = [];
  const fetchFn: FetchMock = jest.fn(async (_url, _init) => {
    const next = answers.shift();
    if (!next) throw new Error('no answer queued for refresh');
    return next();
  });
  return {
    fetchFn,
    answers,
    sentRefreshTokens: () =>
      fetchFn.mock.calls.map(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { refreshToken: string })
            .refreshToken,
      ),
  };
}

const rotation =
  (access: string, refresh: string, expiresAtMs: number) => async () =>
    jsonResponse(sessionBody(access, refresh, expiresAtMs));
const refused = (status: 401 | 403) => async () => jsonResponse({}, status);

interface Listener {
  handler: (state: string) => void;
  remove: jest.Mock<void, []>;
}

/** Every AppState subscription the keeper registered, oldest first. */
let listeners: Listener[] = [];

function liveListeners(): Listener[] {
  return listeners.filter(l => l.remove.mock.calls.length === 0);
}

function foreground(): void {
  if (listeners.length === 0)
    throw new Error('keeper registered no AppState listener');
  // Deliver to every registered handler — a removed one must ignore it, a
  // leaked one is exactly what these tests are after.
  for (const l of listeners) l.handler('active');
}

interface Callbacks {
  rotated: jest.Mock<void, [RefreshedTokens]>;
  revoked: jest.Mock<void, []>;
  deferred: jest.Mock<void, [unknown]>;
}

function start(
  overrides: Partial<Omit<SessionKeeperInput, 'fetchFn'>> & {
    fetchFn: FetchMock;
  },
): Callbacks {
  const rotated = jest.fn<void, [RefreshedTokens]>();
  const revoked = jest.fn<void, []>();
  const deferred = jest.fn<void, [unknown]>();
  startSessionKeeper({
    apiBaseUrl: API,
    refreshToken: 'refresh-0',
    bearerExpiresAtMs: Date.now() + 10 * MINUTE,
    onRotated: rotated,
    onRevoked: revoked,
    onDeferred: deferred,
    now: () => Date.now(),
    ...overrides,
    fetchFn: overrides.fetchFn as unknown as SessionFetch,
  });
  return { rotated, revoked, deferred };
}

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  listeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const listener: Listener = {
        handler: handler as (state: string) => void,
        remove: jest.fn<void, []>(),
      };
      listeners.push(listener);
      return { remove: listener.remove } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterEach(() => {
  stopSessionKeeper();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('a refused refresh token ends the keeper', () => {
  it.each([401, 403] as const)(
    'after HTTP %i: refreshSessionNow(), a foreground and elapsed time spend nothing more; onRevoked once; the AppState listener is removed',
    async status => {
      const r = refresher();
      r.answers.push(refused(status));
      const { rotated, revoked, deferred } = start({
        fetchFn: r.fetchFn,
        bearerExpiresAtMs: Date.now() + 2 * MINUTE,
      });
      expect(liveListeners()).toHaveLength(1);

      await advance(MINUTE);
      expect(r.fetchFn).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(liveListeners()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);

      // The dead token is never spent again, whatever pokes the keeper.
      refreshSessionNow();
      await advance(0);
      foreground();
      await advance(0);
      await advance(60 * MINUTE);

      expect(r.fetchFn).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(deferred).not.toHaveBeenCalled();
      expect(rotated).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

describe('stopSessionKeeper tears everything down', () => {
  it('removes the AppState subscription and clears the pending timer', async () => {
    const r = refresher();
    start({ fetchFn: r.fetchFn });
    expect(liveListeners()).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    stopSessionKeeper();

    expect(liveListeners()).toHaveLength(0);
    expect(listeners[0]?.remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    await advance(60 * MINUTE);
    expect(r.fetchFn).not.toHaveBeenCalled();
  });

  it('is idempotent: a second stop removes nothing twice', () => {
    const r = refresher();
    start({ fetchFn: r.fetchFn });
    stopSessionKeeper();
    stopSessionKeeper();
    expect(listeners[0]?.remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('starting a keeper for another account', () => {
  it('tears the previous keeper down first: one live listener, one pending timer, and only the new token is ever spent', async () => {
    const first = refresher();
    const firstCallbacks = start({
      fetchFn: first.fetchFn,
      refreshToken: 'refresh-A',
      bearerExpiresAtMs: Date.now() + 2 * MINUTE,
    });

    const second = refresher();
    second.answers.push(
      rotation('access-B1', 'refresh-B1', Date.now() + 60 * MINUTE),
    );
    const secondCallbacks = start({
      fetchFn: second.fetchFn,
      refreshToken: 'refresh-B',
      bearerExpiresAtMs: Date.now() + 10 * MINUTE,
    });

    expect(listeners).toHaveLength(2);
    expect(liveListeners()).toHaveLength(1);
    expect(listeners[0]?.remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    // A foreground reaches only the live listener; the first keeper's
    // bearer (2 min left) would have refreshed had its listener survived;
    // the second's (10 min left) is healthy and left alone.
    foreground();
    await advance(0);
    expect(first.fetchFn).not.toHaveBeenCalled();
    expect(second.fetchFn).not.toHaveBeenCalled();

    // Timers: the first keeper's would have fired at +1 min; the second's
    // fires at +9 min.
    await advance(MINUTE);
    expect(first.fetchFn).not.toHaveBeenCalled();
    expect(second.fetchFn).not.toHaveBeenCalled();
    await advance(8 * MINUTE);
    expect(first.fetchFn).not.toHaveBeenCalled();
    expect(second.fetchFn).toHaveBeenCalledTimes(1);
    expect(second.sentRefreshTokens()).toEqual(['refresh-B']);
    expect(secondCallbacks.rotated).toHaveBeenCalledTimes(1);
    expect(firstCallbacks.rotated).not.toHaveBeenCalled();
    expect(firstCallbacks.revoked).not.toHaveBeenCalled();
    expect(firstCallbacks.deferred).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });
});

describe('a 200 with a blank refresh token is a malformed body', () => {
  it.each([
    ['', ''],
    ['whitespace', '   '],
  ])(
    'the keeper keeps its current refresh token, defers, and retries with it (%s)',
    async (_label, blank) => {
      const r = refresher();
      r.answers.push(rotation('access-1', blank, Date.now() + 60 * MINUTE));
      r.answers.push(
        rotation('access-2', 'refresh-2', Date.now() + 60 * MINUTE),
      );
      const { rotated, revoked, deferred } = start({
        fetchFn: r.fetchFn,
        bearerExpiresAtMs: Date.now() + 2 * MINUTE,
      });

      await advance(MINUTE);
      expect(r.fetchFn).toHaveBeenCalledTimes(1);
      expect(rotated).not.toHaveBeenCalled();
      expect(revoked).not.toHaveBeenCalled();
      expect(deferred).toHaveBeenCalledTimes(1);

      await advance(5_000);
      expect(r.fetchFn).toHaveBeenCalledTimes(2);
      expect(r.sentRefreshTokens()).toEqual(['refresh-0', 'refresh-0']);
      expect(rotated).toHaveBeenCalledTimes(1);
      expect(rotated.mock.calls[0]?.[0]?.refreshToken).toBe('refresh-2');
    },
  );

  it.each([
    [
      'an empty refreshToken',
      { accessToken: 'a', refreshToken: '', expiresAt: 1 },
    ],
    [
      'a whitespace refreshToken',
      { accessToken: 'a', refreshToken: ' \t', expiresAt: 1 },
    ],
    [
      'an infinite expiresAt',
      { accessToken: 'a', refreshToken: 'r', expiresAt: Infinity },
    ],
    [
      'a NaN expiresAt',
      { accessToken: 'a', refreshToken: 'r', expiresAt: NaN },
    ],
  ])(
    'refreshApiSession rejects a 200 with %s as retryable, never a refusal',
    async (_label, session) => {
      const fetchFn = jest.fn(async () => jsonResponse({ session }));
      const failure = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-1' },
        { fetchFn },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionRefreshError);
      expect((failure as SessionRefreshError).retryable).toBe(true);
    },
  );
});
