/**
 * sessionKeeper timing and lifecycle contract, pinned at the unit level with
 * fake timers (mutation-testing survivors SK-01..04, SK-08..12, SK-14):
 *
 *  - the bearer is rotated exactly 60s AHEAD of its expiry — not at expiry,
 *    not after it — and every rotation schedules the next one;
 *  - each rotation spends the CURRENT refresh token (the one the previous
 *    rotation returned), never the one the keeper was started with;
 *  - transient failures back off 5s, 10s, 20s … (never a 1s hot loop), and
 *    the backoff resets after a success;
 *  - returning to the foreground refreshes a bearer with < 5 min left (and
 *    only then);
 *  - stopSessionKeeper() drops the result of an in-flight refresh: no
 *    onRotated / onRevoked after a sign-out, whatever the server answers.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';
import type { RefreshedTokens } from '../../src/account/sessionLifecycle';

type FetchInit = { body?: unknown } | undefined;

const MINUTE = 60_000;
const API = 'https://api.example.test';

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
  fetchFn: jest.Mock;
  /** Refresh tokens sent so far, in order. */
  sentRefreshTokens: () => string[];
  /** Answer queue; each entry serves one refresh call. */
  answers: Array<() => Promise<Response>>;
}

function refresher(): Refresher {
  const answers: Array<() => Promise<Response>> = [];
  const fetchFn = jest.fn(async (_url: string, init: FetchInit) => {
    void init;
    const next = answers.shift();
    if (!next) throw new Error('no answer queued for refresh');
    return next();
  });
  return {
    fetchFn,
    answers,
    sentRefreshTokens: () =>
      fetchFn.mock.calls.map(
        ([, init]: [string, FetchInit]) =>
          (JSON.parse(String(init?.body)) as { refreshToken: string })
            .refreshToken,
      ),
  };
}

const rotation =
  (access: string, refresh: string, expiresAtMs: number) => async () =>
    jsonResponse(sessionBody(access, refresh, expiresAtMs));
const serverError = () => async () => jsonResponse({}, 503);
const refused = () => async () => jsonResponse({}, 401);

let appStateHandler: ((state: string) => void) | null = null;

function start(
  overrides: Partial<SessionKeeperInput> & { fetchFn: jest.Mock },
): {
  rotated: jest.Mock<void, [RefreshedTokens]>;
  revoked: jest.Mock<void, []>;
  deferred: jest.Mock<void, [unknown]>;
} {
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
    fetchFn: overrides.fetchFn as unknown as SessionKeeperInput['fetchFn'],
  });
  return { rotated, revoked, deferred };
}

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  appStateHandler = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterEach(() => {
  stopSessionKeeper();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('rotation timing', () => {
  it('rotates the bearer exactly 60s before it expires — not before, not at expiry, not after', async () => {
    const r = refresher();
    const expiresAt = Date.now() + 10 * MINUTE;
    r.answers.push(rotation('access-1', 'refresh-1', expiresAt + 60 * MINUTE));
    const { rotated } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: expiresAt,
    });

    await advance(9 * MINUTE - 1_000);
    expect(r.fetchFn).not.toHaveBeenCalled();

    await advance(1_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(rotated.mock.calls[0]?.[0]).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: expiresAt + 60 * MINUTE,
    });

    // Nothing else fires at the old expiry or a minute past it.
    await advance(2 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('after a rotation the NEXT rotation is scheduled 60s ahead of the new expiry, spending the rotated refresh token', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 30 * MINUTE));
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    const { rotated } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: t0 + 10 * MINUTE,
    });

    await advance(9 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // New expiry t0+30min → next rotation at t0+29min.
    await advance(20 * MINUTE - 1_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    expect(rotated).toHaveBeenCalledTimes(2);
    expect(r.sentRefreshTokens()).toEqual(['refresh-0', 'refresh-1']);
  });

  it('a keeper started without a bearer refreshes immediately and then keeps rotating', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 5 * MINUTE));
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: null });

    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(4 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    expect(r.sentRefreshTokens()).toEqual(['refresh-0', 'refresh-1']);
  });
});

describe('transient failures', () => {
  it('backs off 5s, 10s, 20s between retries — never a 1s hot loop — and each retry spends the current refresh token', async () => {
    const r = refresher();
    r.answers.push(serverError(), serverError(), serverError());
    r.answers.push(rotation('access-1', 'refresh-1', Date.now() + 60 * MINUTE));
    const { rotated, revoked, deferred } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: null,
    });

    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveBeenCalledTimes(1);

    await advance(4_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);

    await advance(9_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(3);

    await advance(19_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(4);

    expect(rotated).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();
    expect(r.sentRefreshTokens()).toEqual([
      'refresh-0',
      'refresh-0',
      'refresh-0',
      'refresh-0',
    ]);
  });

  it('the backoff resets after a success: the first failure after a rotation retries in 5s, not where the previous run left off', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(serverError(), serverError(), serverError());
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 2 * MINUTE));
    r.answers.push(serverError());
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: null });

    // 0 → fail, +5s fail, +10s fail, +20s success (t = 35s).
    await advance(35_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(4);

    // Next rotation is 60s ahead of the 2-minute expiry, i.e. at t = 60s.
    await advance(25_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(5);

    // That one failed transiently; a reset backoff retries 5s later, at 65s.
    await advance(4_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(6);
    expect(r.sentRefreshTokens().slice(4)).toEqual(['refresh-1', 'refresh-1']);
  });
});

describe('foreground re-check', () => {
  it('refreshes on foreground when the bearer has less than 5 minutes left — and leaves a healthier bearer alone', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: t0 + 10 * MINUTE });
    expect(appStateHandler).not.toBeNull();

    // 10 min left: no refresh on foreground.
    appStateHandler!('active');
    await advance(0);
    expect(r.fetchFn).not.toHaveBeenCalled();

    // 4 min 59 s left (timer still 4 min away): foreground refreshes now.
    await advance(5 * MINUTE + 1_000);
    expect(r.fetchFn).not.toHaveBeenCalled();
    appStateHandler!('active');
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // Background transitions never trigger anything.
    appStateHandler!('background');
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a bearer that expired while the app was suspended is refreshed the moment it returns to the foreground', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: t0 + 10 * MINUTE });

    // Suspended: the clock moves, timers do not fire.
    jest.setSystemTime(t0 + 8 * 60 * MINUTE);
    expect(r.fetchFn).not.toHaveBeenCalled();
    appStateHandler!('active');
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('stopSessionKeeper drops in-flight results', () => {
  it('a rotation that lands after stop() is discarded: no onRotated, nothing scheduled', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = jest.fn(
      () => new Promise<Response>(resolve => (resolveFetch = resolve)),
    );
    const { rotated } = start({ fetchFn, bearerExpiresAtMs: null });
    await advance(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    stopSessionKeeper();
    resolveFetch!(
      jsonResponse(
        sessionBody('access-1', 'refresh-1', Date.now() + 60 * MINUTE),
      ),
    );
    await advance(0);
    expect(rotated).not.toHaveBeenCalled();

    await advance(2 * 60 * MINUTE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a refusal that lands after stop() is discarded: no onRevoked after sign-out', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = jest.fn(
      () => new Promise<Response>(resolve => (resolveFetch = resolve)),
    );
    const { revoked, deferred } = start({ fetchFn, bearerExpiresAtMs: null });
    await advance(0);

    stopSessionKeeper();
    resolveFetch!(jsonResponse({}, 401));
    await advance(0);
    expect(revoked).not.toHaveBeenCalled();
    expect(deferred).not.toHaveBeenCalled();
  });

  it('a transient failure that lands after stop() schedules no retry', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = jest.fn(
      () => new Promise<Response>(resolve => (resolveFetch = resolve)),
    );
    start({ fetchFn, bearerExpiresAtMs: null });
    await advance(0);

    stopSessionKeeper();
    resolveFetch!(jsonResponse({}, 503));
    await advance(10 * MINUTE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshSessionNow() while a refresh is in flight does not spend the refresh token twice', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = jest.fn(
      () => new Promise<Response>(resolve => (resolveFetch = resolve)),
    );
    start({ fetchFn, bearerExpiresAtMs: null });
    await advance(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    refreshSessionNow();
    refreshSessionNow();
    await advance(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    resolveFetch!(
      jsonResponse(
        sessionBody('access-1', 'refresh-1', Date.now() + 60 * MINUTE),
      ),
    );
    await advance(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('a refused refresh token', () => {
  it('ends the keeper: onRevoked once, no retry, no further rotation', async () => {
    const r = refresher();
    r.answers.push(refused());
    const { rotated, revoked } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: null,
    });
    await advance(0);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(rotated).not.toHaveBeenCalled();
    await advance(10 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });
});
