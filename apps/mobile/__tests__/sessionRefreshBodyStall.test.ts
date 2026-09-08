/**
 * The refresh route is the ONE place the durable session can be lost, and
 * the keeper serialises rotations behind an in-flight guard. Both therefore
 * depend on every refresh SETTLING: a `/v1/auth/refresh` whose headers arrive
 * but whose body never completes (a proxy that half-answers, a connection
 * that dies mid-body) must be bounded by the same client timeout as a request
 * that never gets headers, and must count as a transient failure — the
 * session is kept, the keeper retries, and the next foreground/explicit
 * refresh still performs a real fetch instead of finding the guard held by a
 * rotation that can never finish.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../src/account/sessionKeeper';
import { refreshApiSession } from '../src/account/sessionLifecycle';

type FetchFn = NonNullable<SessionKeeperInput['fetchFn']>;

const TIMEOUT_MS = 15_000;

/** Runs pending microtasks/immediates without firing any >= 1ms timer. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await jest.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 16; j += 1) await Promise.resolve();
  }
};

const advance = async (ms: number): Promise<void> => {
  await jest.advanceTimersByTimeAsync(ms);
  await settle();
};

/** 200 with headers delivered and a body that never completes. */
const stalledBodyResponse = (): Response =>
  ({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => new Promise<never>(() => {}),
    text: () => new Promise<never>(() => {}),
  }) as unknown as Response;

const okSession = (n: number, lifeSeconds = 3600): Response =>
  new Response(
    JSON.stringify({
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt: Math.floor(Date.now() / 1000) + lifeSeconds,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function fireAppState(state: 'active' | 'background'): void {
  const addListener = AppState.addEventListener as jest.Mock;
  for (const call of addListener.mock.calls as Array<
    [string, (next: string) => void]
  >) {
    if (call[0] === 'change') call[1](state);
  }
}

function track(
  promise: Promise<unknown>,
): () => 'pending' | 'resolved' | 'rejected' {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return () => state;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  (AppState.addEventListener as jest.Mock).mockClear();
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('refreshApiSession: the whole refresh (headers + body) is bounded by the client timeout', () => {
  it('headers arrive but the body never does → rejects retryable exactly at the timeout', async () => {
    const fetchFn: FetchFn = async () => stalledBodyResponse();
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: TIMEOUT_MS },
    );
    const state = track(pending);
    const outcome = expect(pending).rejects.toMatchObject({
      name: 'SessionRefreshError',
      retryable: true,
    });
    await advance(TIMEOUT_MS - 1);
    expect(state()).toBe('pending');
    await advance(1);
    expect(state()).toBe('rejected');
    await outcome;
  });

  it('a transport that ignores the abort signal and never answers is still bounded', async () => {
    let sawSignal = false;
    const fetchFn: FetchFn = (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Promise<Response>(() => {});
    };
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: TIMEOUT_MS },
    );
    const state = track(pending);
    const outcome = expect(pending).rejects.toMatchObject({
      name: 'SessionRefreshError',
      retryable: true,
    });
    await advance(TIMEOUT_MS);
    expect(sawSignal).toBe(true);
    expect(state()).toBe('rejected');
    await outcome;
  });

  it('a body that completes inside the timeout is adopted and the timer is released', async () => {
    let releaseBody: ((value: unknown) => void) | null = null;
    const fetchFn: FetchFn = async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          new Promise<unknown>(resolve => {
            releaseBody = resolve;
          }),
      }) as unknown as Response;
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: TIMEOUT_MS },
    );
    await advance(TIMEOUT_MS - 1_000);
    expect(releaseBody).not.toBeNull();
    (releaseBody as unknown as (value: unknown) => void)({
      session: { accessToken: 'a', refreshToken: 'b', expiresAt: 10 },
    });
    await expect(pending).resolves.toEqual({
      bearerToken: 'a',
      refreshToken: 'b',
      bearerExpiresAtMs: 10_000,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a 401 whose body never arrives is still the non-retryable refusal', async () => {
    const fetchFn: FetchFn = async () =>
      ({
        ...stalledBodyResponse(),
        status: 401,
        ok: false,
      }) as unknown as Response;
    await expect(
      refreshApiSession(
        { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
        { fetchFn, timeoutMs: TIMEOUT_MS },
      ),
    ).rejects.toMatchObject({ name: 'SessionRefreshError', retryable: false });
  });
});

describe('sessionKeeper: a body stall on one rotation never wedges the keeper', () => {
  it('the stalled rotation times out as a transient failure, the retry rotates, and later triggers still fetch', async () => {
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) return stalledBodyResponse();
      return okSession(n);
    };
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 90_000,
      onRotated,
      onRevoked,
      onDeferred,
      fetchFn,
    });
    // 30s → the scheduled rotation fires and stalls on its body.
    await advance(30_000);
    expect(n).toBe(1);

    // While the stalled rotation is inside its timeout the guard holds.
    await advance(TIMEOUT_MS - 1);
    refreshSessionNow();
    fireAppState('active');
    await settle();
    expect(n).toBe(1);
    expect(onDeferred).not.toHaveBeenCalled();

    // The timeout lands: transient failure, retry scheduled with backoff.
    await advance(1);
    expect(onDeferred).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(n).toBe(1);
    await advance(retryDelayMs(1));
    expect(n).toBe(2);
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshToken: 'refresh-2' }),
    );

    // The guard was released: an explicit refresh performs a real fetch.
    refreshSessionNow();
    await settle();
    expect(n).toBe(3);
    expect(onRotated).toHaveBeenCalledTimes(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a foreground return after a stalled rotation refreshes exactly once', async () => {
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) return stalledBodyResponse();
      return okSession(n);
    };
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: Date.now() + 90_000,
      onRotated,
      onRevoked,
      fetchFn,
    });
    await advance(30_000);
    expect(n).toBe(1);
    // The stall times out and a retry is armed; the app is suspended before
    // it fires (timers do not run while iOS suspends the app), and the user
    // returns hours later with an expired bearer.
    await advance(TIMEOUT_MS);
    expect(jest.getTimerCount()).toBe(1);
    fireAppState('background');
    jest.setSystemTime(Date.now() + 6 * 60 * 60_000);
    fireAppState('active');
    await settle();
    expect(n).toBe(2);
    expect(onRotated).toHaveBeenCalledTimes(1);
    // The successful rotation replaced the pending retry timer.
    await advance(retryDelayMs(1));
    expect(n).toBe(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
