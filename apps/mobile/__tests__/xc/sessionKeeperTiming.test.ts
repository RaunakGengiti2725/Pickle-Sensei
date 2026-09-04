/**
 * sessionKeeper timing + lifecycle contract, pinned at the unit level with
 * fake timers (AGENTS.md → "Auth sessions"):
 *
 *  - the bearer is rotated exactly 60s AHEAD of its expiry — not at expiry,
 *    not after it — and every rotation schedules the next one 60s ahead of
 *    the NEW expiry;
 *  - each rotation spends the CURRENT refresh token (the one the previous
 *    rotation returned), never the one the keeper was started with;
 *  - transient failures back off 5s, 10s, 20s … capped at 5 min — never a
 *    1s hot loop — and the backoff resets after a success;
 *  - only a 401/403 ends the session; 5xx, network errors and malformed
 *    bodies defer and retry;
 *  - returning to the foreground refreshes a bearer with < 5 min left (and
 *    only then; background transitions do nothing);
 *  - stopSessionKeeper() drops the result of an in-flight refresh: no
 *    onRotated / onRevoked / retry after a sign-out, whatever the server
 *    answers.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';
import type {
  RefreshedTokens,
  SessionFetch,
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
  /** Answer queue; each entry serves one refresh call, in order. */
  answers: Array<() => Promise<Response>>;
  /** Refresh tokens sent so far, in order. */
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
const serverError = () => async () => jsonResponse({}, 503);
const networkError = () => async (): Promise<Response> => {
  throw new TypeError('Network request failed');
};
const malformedBody = () => async () => jsonResponse({ session: {} }, 200);
const refused = (status: 401 | 403) => async () => jsonResponse({}, status);

/** A fetch whose single response is released by the test. */
function heldFetch(): { fetchFn: FetchMock; release: (r: Response) => void } {
  let resolve: ((response: Response) => void) | null = null;
  const fetchFn: FetchMock = jest.fn(
    (_url, _init) => new Promise<Response>(res => (resolve = res)),
  );
  return {
    fetchFn,
    release: response => {
      if (!resolve) throw new Error('no refresh in flight');
      resolve(response);
    },
  };
}

let appStateHandler: ((state: string) => void) | null = null;

function foreground(): void {
  if (!appStateHandler)
    throw new Error('keeper registered no AppState listener');
  appStateHandler('active');
}

function background(): void {
  if (!appStateHandler)
    throw new Error('keeper registered no AppState listener');
  appStateHandler('background');
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
  it('rotates the bearer exactly 60s before it expires — not earlier, not at expiry, not after', async () => {
    const r = refresher();
    const t0 = Date.now();
    const expiresAt = t0 + 10 * MINUTE;
    r.answers.push(rotation('access-1', 'refresh-1', expiresAt + 60 * MINUTE));
    const { rotated, revoked } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: expiresAt,
    });

    await advance(9 * MINUTE - 1);
    expect(r.fetchFn).not.toHaveBeenCalled();

    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(r.fetchFn).toHaveBeenCalledWith(
      `${API}/v1/auth/refresh`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-0' }),
      }),
    );
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(rotated.mock.calls[0]?.[0]).toEqual({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: expiresAt + 60 * MINUTE,
    });

    // Nothing else fires at the old expiry or a minute past it.
    await advance(2 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('after a rotation the NEXT rotation is scheduled 60s ahead of the new expiry and spends the rotated refresh token', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 30 * MINUTE));
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    r.answers.push(rotation('access-3', 'refresh-3', t0 + 90 * MINUTE));
    const { rotated } = start({
      fetchFn: r.fetchFn,
      bearerExpiresAtMs: t0 + 10 * MINUTE,
    });

    await advance(9 * MINUTE);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // New expiry t0+30min → next rotation at t0+29min, not before.
    await advance(20 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);

    // And again: expiry t0+60min → rotation at t0+59min.
    await advance(30 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(3);

    expect(rotated).toHaveBeenCalledTimes(3);
    expect(r.sentRefreshTokens()).toEqual([
      'refresh-0',
      'refresh-1',
      'refresh-2',
    ]);
    expect(
      rotated.mock.calls.map(([tokens]) => tokens.bearerExpiresAtMs),
    ).toEqual([t0 + 30 * MINUTE, t0 + 60 * MINUTE, t0 + 90 * MINUTE]);
  });

  it('a keeper started without a bearer refreshes immediately and then keeps rotating ahead of each new expiry', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 5 * MINUTE));
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: null });

    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    await advance(4 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    expect(r.sentRefreshTokens()).toEqual(['refresh-0', 'refresh-1']);
  });

  it('a bearer with less than 60s of life (or already expired) is rotated after the 1s floor, not immediately and not never', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: t0 + 30_000 });

    await advance(999);
    expect(r.fetchFn).not.toHaveBeenCalled();
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('transient failures', () => {
  it('backs off 5s, 10s, 20s between retries — never a 1s hot loop — never signs out, and each retry spends the current refresh token', async () => {
    const r = refresher();
    r.answers.push(serverError(), networkError(), malformedBody());
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
    expect(deferred).toHaveBeenCalledTimes(2);

    await advance(9_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(3);
    expect(deferred).toHaveBeenCalledTimes(3);

    await advance(19_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(4);

    expect(rotated).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();
    expect(deferred).toHaveBeenCalledTimes(3);
    expect(r.sentRefreshTokens()).toEqual([
      'refresh-0',
      'refresh-0',
      'refresh-0',
      'refresh-0',
    ]);
  });

  it('the backoff is capped at 5 minutes', () => {
    expect(retryDelayMs(0)).toBe(5_000);
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(6)).toBe(160_000);
    expect(retryDelayMs(7)).toBe(5 * MINUTE);
    expect(retryDelayMs(8)).toBe(5 * MINUTE);
    expect(retryDelayMs(40)).toBe(5 * MINUTE);
  });

  it('a long outage retries every 5 minutes, not more often and not less', async () => {
    const r = refresher();
    for (let i = 0; i < 12; i += 1) r.answers.push(serverError());
    const { revoked } = start({ fetchFn: r.fetchFn, bearerExpiresAtMs: null });

    // 0, +5s, +10s, +20s, +40s, +80s, +160s → 7 calls by t = 315s; the 8th
    // is capped at +300s.
    await advance(315_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(7);
    await advance(5 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(7);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(8);
    await advance(5 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(8);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(9);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('the backoff resets after a success: the first failure after a rotation retries in 5s, not where the previous run left off', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(serverError(), serverError(), serverError());
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 2 * MINUTE));
    r.answers.push(serverError());
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 60 * MINUTE));
    const { rotated } = start({ fetchFn: r.fetchFn, bearerExpiresAtMs: null });

    // 0 → fail, +5s fail, +10s fail, +20s success (t = 35s).
    await advance(35_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(4);
    expect(rotated).toHaveBeenCalledTimes(1);

    // Next rotation is 60s ahead of the 2-minute expiry, i.e. at t = 60s.
    await advance(25_000);
    expect(r.fetchFn).toHaveBeenCalledTimes(5);

    // That one failed transiently; a reset backoff retries 5s later, at 65s.
    await advance(4_999);
    expect(r.fetchFn).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(6);
    expect(rotated).toHaveBeenCalledTimes(2);
    expect(r.sentRefreshTokens().slice(4)).toEqual(['refresh-1', 'refresh-1']);
  });
});

describe('a refused refresh token', () => {
  it.each([401, 403] as const)(
    'HTTP %i ends the keeper: onRevoked once, no onDeferred, no retry, no further rotation',
    async status => {
      const r = refresher();
      r.answers.push(refused(status));
      const { rotated, revoked, deferred } = start({
        fetchFn: r.fetchFn,
        bearerExpiresAtMs: null,
      });
      await advance(0);
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(rotated).not.toHaveBeenCalled();
      expect(deferred).not.toHaveBeenCalled();
      await advance(60 * MINUTE);
      expect(r.fetchFn).toHaveBeenCalledTimes(1);
      expect(revoked).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 404, 429, 500, 502, 503, 504])(
    'HTTP %i is NOT a sign-out: onDeferred, a retry, no onRevoked',
    async status => {
      const r = refresher();
      r.answers.push(async () => jsonResponse({}, status));
      r.answers.push(
        rotation('access-1', 'refresh-1', Date.now() + 60 * MINUTE),
      );
      const { rotated, revoked, deferred } = start({
        fetchFn: r.fetchFn,
        bearerExpiresAtMs: null,
      });
      await advance(0);
      expect(revoked).not.toHaveBeenCalled();
      expect(deferred).toHaveBeenCalledTimes(1);
      await advance(5_000);
      expect(r.fetchFn).toHaveBeenCalledTimes(2);
      expect(rotated).toHaveBeenCalledTimes(1);
      expect(revoked).not.toHaveBeenCalled();
    },
  );
});

describe('foreground re-check', () => {
  it('refreshes on foreground when the bearer has less than 5 minutes left — and leaves a healthier bearer alone', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 60 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: t0 + 10 * MINUTE });
    expect(appStateHandler).not.toBeNull();

    // 10 min left: no refresh on foreground.
    foreground();
    await advance(0);
    expect(r.fetchFn).not.toHaveBeenCalled();

    // Exactly 5 min left: still healthy enough.
    await advance(5 * MINUTE);
    foreground();
    await advance(0);
    expect(r.fetchFn).not.toHaveBeenCalled();

    // 4 min 59 s left (the timer is still 4 min away): a foreground refreshes now.
    await advance(1_000);
    expect(r.fetchFn).not.toHaveBeenCalled();
    foreground();
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // Background transitions never trigger anything.
    jest.setSystemTime(t0 + 59 * MINUTE + 30_000);
    background();
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
    foreground();
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a foreground refresh reschedules the timer ahead of the new expiry', async () => {
    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-1', 'refresh-1', t0 + 30 * MINUTE));
    r.answers.push(rotation('access-2', 'refresh-2', t0 + 90 * MINUTE));
    start({ fetchFn: r.fetchFn, bearerExpiresAtMs: t0 + 10 * MINUTE });

    await advance(6 * MINUTE);
    foreground();
    await advance(0);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // The old t0+9min timer must NOT fire; the next rotation is at t0+29min.
    await advance(23 * MINUTE - 1);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
    expect(r.sentRefreshTokens()).toEqual(['refresh-0', 'refresh-1']);
  });
});

describe('stopSessionKeeper drops in-flight results', () => {
  it('a rotation that lands after stop() is discarded: no onRotated, nothing scheduled', async () => {
    const held = heldFetch();
    const { rotated, revoked } = start({
      fetchFn: held.fetchFn,
      bearerExpiresAtMs: null,
    });
    await advance(0);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);

    stopSessionKeeper();
    held.release(
      jsonResponse(
        sessionBody('access-1', 'refresh-1', Date.now() + 60 * MINUTE),
      ),
    );
    await advance(0);
    expect(rotated).not.toHaveBeenCalled();
    expect(revoked).not.toHaveBeenCalled();

    await advance(2 * 60 * MINUTE);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a refusal that lands after stop() is discarded: no onRevoked after sign-out', async () => {
    const held = heldFetch();
    const { rotated, revoked, deferred } = start({
      fetchFn: held.fetchFn,
      bearerExpiresAtMs: null,
    });
    await advance(0);

    stopSessionKeeper();
    held.release(jsonResponse({}, 401));
    await advance(0);
    expect(revoked).not.toHaveBeenCalled();
    expect(rotated).not.toHaveBeenCalled();
    expect(deferred).not.toHaveBeenCalled();
  });

  it('a transient failure that lands after stop() schedules no retry', async () => {
    const held = heldFetch();
    const { deferred } = start({
      fetchFn: held.fetchFn,
      bearerExpiresAtMs: null,
    });
    await advance(0);

    stopSessionKeeper();
    held.release(jsonResponse({}, 503));
    await advance(10 * MINUTE);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
    expect(deferred).not.toHaveBeenCalled();
  });

  it('a result that lands after the keeper was RESTARTED for another account goes to neither keeper', async () => {
    const held = heldFetch();
    const first = start({ fetchFn: held.fetchFn, bearerExpiresAtMs: null });
    await advance(0);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);

    const r = refresher();
    const t0 = Date.now();
    r.answers.push(rotation('access-b1', 'refresh-b1', t0 + 60 * MINUTE));
    const second = start({
      fetchFn: r.fetchFn,
      refreshToken: 'refresh-b0',
      bearerExpiresAtMs: t0 + 10 * MINUTE,
    });

    held.release(
      jsonResponse(sessionBody('access-a1', 'refresh-a1', t0 + 60 * MINUTE)),
    );
    await advance(0);
    expect(first.rotated).not.toHaveBeenCalled();
    expect(second.rotated).not.toHaveBeenCalled();

    await advance(9 * MINUTE);
    expect(second.rotated).toHaveBeenCalledTimes(1);
    expect(r.sentRefreshTokens()).toEqual(['refresh-b0']);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels a pending scheduled rotation', async () => {
    const r = refresher();
    r.answers.push(rotation('access-1', 'refresh-1', Date.now() + 60 * MINUTE));
    const { rotated } = start({ fetchFn: r.fetchFn });
    stopSessionKeeper();
    await advance(60 * MINUTE);
    expect(r.fetchFn).not.toHaveBeenCalled();
    expect(rotated).not.toHaveBeenCalled();
  });

  it('refreshSessionNow() while a refresh is in flight does not spend the refresh token twice', async () => {
    const held = heldFetch();
    start({ fetchFn: held.fetchFn, bearerExpiresAtMs: null });
    await advance(0);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
    refreshSessionNow();
    refreshSessionNow();
    await advance(0);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
    held.release(
      jsonResponse(
        sessionBody('access-1', 'refresh-1', Date.now() + 60 * MINUTE),
      ),
    );
    await advance(0);
    expect(held.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshSessionNow() after stop() is a no-op', async () => {
    const r = refresher();
    start({ fetchFn: r.fetchFn });
    stopSessionKeeper();
    refreshSessionNow();
    await advance(0);
    expect(r.fetchFn).not.toHaveBeenCalled();
  });
});
