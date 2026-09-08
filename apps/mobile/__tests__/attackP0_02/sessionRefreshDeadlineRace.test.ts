/**
 * P0-02 adversary — the refresh deadline vs. server-side rotation.
 *
 * `/v1/auth/refresh` ROTATES the refresh token before it writes the response
 * (supabase/functions/api/index.ts: "401 when it was revoked or already
 * rotated away"). Once the response headers are on the wire the old refresh
 * token is dead server-side and the ONLY copy of the new one is the body in
 * flight. The candidate bounds headers + body under one 15 s deadline and
 * discards whatever lands after it, so a slow-but-successful rotation must
 * not leave the keeper holding a refresh token the server has already
 * retired: that retry is answered 401 and the durable session signs out on
 * what was, from the user's point of view, a slow network.
 *
 * Also probes the neighbouring boundaries of the new `post()`: an abort-
 * honouring transport, sign-out with a stalled logout body, an account switch
 * while a rotation stalls, and a body that lands exactly on the deadline.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';
import {
  refreshApiSession,
  revokeApiSession,
} from '../../src/account/sessionLifecycle';

type FetchFn = NonNullable<SessionKeeperInput['fetchFn']>;

const TIMEOUT_MS = 15_000;

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

function fireAppState(state: 'active' | 'background'): void {
  const addListener = AppState.addEventListener as jest.Mock;
  for (const call of addListener.mock.calls as Array<
    [string, (next: string) => void]
  >) {
    if (call[0] === 'change') call[1](state);
  }
}

const sessionBody = (n: number, lifeSeconds = 3600) => ({
  session: {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: Math.floor(Date.now() / 1000) + lifeSeconds,
  },
});

/** 200 whose headers land now and whose body settles `bodyDelayMs` later. */
const slowBodyResponse = (body: unknown, bodyDelayMs: number): Response =>
  ({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () =>
      new Promise<unknown>(resolve => {
        setTimeout(() => resolve(body), bodyDelayMs);
      }),
  }) as unknown as Response;

const refused = (): Response =>
  new Response(JSON.stringify({ error: { message: 'Sign in again.' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A server that rotates on receipt, exactly like Supabase Auth behind the
 * edge route: presenting a refresh token that has already been rotated away
 * is refused with 401.
 */
function rotatingServer(bodyDelayFor: (n: number) => number) {
  let n = 0;
  let current = 'refresh-0';
  const requests: string[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    n += 1;
    const presented = (
      JSON.parse(String(init?.body)) as { refreshToken: string }
    ).refreshToken;
    requests.push(presented);
    if (presented !== current) return refused();
    current = `refresh-${n}`;
    return slowBodyResponse(sessionBody(n), bodyDelayFor(n));
  };
  return { fetchFn, requests, count: () => n };
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

describe('attack: rotation body lands after the deadline', () => {
  it('a body that settles 1 s past the deadline must not cost the session — the server already retired the presented token', async () => {
    // Rotation 1: headers immediately, body 1 s after the 15 s deadline.
    const server = rotatingServer(n => (n === 1 ? TIMEOUT_MS + 1_000 : 0));
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
      fetchFn: server.fetchFn,
    });
    await advance(30_000);
    expect(server.count()).toBe(1);

    // Deadline: the candidate rejects the rotation as transient.
    await advance(TIMEOUT_MS);
    expect(onDeferred).toHaveBeenCalledTimes(1);

    // The body lands 1 s later carrying the ONLY copy of refresh-1.
    await advance(1_000);

    // Backoff retry presents whatever the keeper still holds.
    await advance(retryDelayMs(1));
    expect(server.count()).toBe(2);

    // The session must survive a slow network: either the late rotation is
    // adopted (retry presents refresh-1) or the keeper never signs out here.
    expect({
      presentedOnRetry: server.requests[1],
      rotatedWith: onRotated.mock.calls.map(
        ([tokens]) => (tokens as { refreshToken: string }).refreshToken,
      ),
      revoked: onRevoked.mock.calls.length,
    }).toEqual({
      presentedOnRetry: 'refresh-1',
      rotatedWith: ['refresh-1'],
      revoked: 0,
    });
  });

  it('control: a body that settles 1 ms inside the deadline is adopted', async () => {
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      return slowBodyResponse(sessionBody(n), TIMEOUT_MS - 1);
    };
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'refresh-0' },
      { fetchFn, timeoutMs: TIMEOUT_MS },
    );
    const outcome = pending.then(
      tokens => ({
        kind: 'rotated' as const,
        refreshToken: tokens.refreshToken,
      }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        retryable: (error as { retryable?: boolean }).retryable,
      }),
    );
    await advance(TIMEOUT_MS);
    expect(await outcome).toEqual({
      kind: 'rotated',
      refreshToken: 'refresh-1',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('attack: neighbouring post() boundaries (expected to hold)', () => {
  it('an abort-honouring transport that rejects after the deadline leaves no timer and no second rejection', async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: TIMEOUT_MS },
    );
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        (async () => {
          const result = pending.catch((error: unknown) => error);
          await advance(TIMEOUT_MS);
          return result;
        })(),
      ).resolves.toMatchObject({
        name: 'SessionRefreshError',
        retryable: true,
      });
      await settle();
      expect(jest.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('sign-out with a logout body that never completes settles at the deadline', async () => {
    const fetchFn: FetchFn = async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () => new Promise<never>(() => {}),
        text: () => new Promise<never>(() => {}),
      }) as unknown as Response;
    let settled = false;
    const pending = revokeApiSession(
      {
        canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
        apiBaseUrl: 'https://api.test',
        bearerToken: 'bearer',
        provider: 'apple',
      },
      fetchFn,
    ).then(() => {
      settled = true;
    });
    await advance(TIMEOUT_MS - 1);
    expect(settled).toBe(true);
    await pending;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an account switch while a rotation stalls: the late body and the timeout both land on the dead generation', async () => {
    let releaseBody: ((value: unknown) => void) | null = null;
    const fetchA: FetchFn = async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () =>
          new Promise<unknown>(resolve => {
            releaseBody = resolve;
          }),
      }) as unknown as Response;
    const a = {
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      onDeferred: jest.fn(),
    };
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'a-0',
      bearerExpiresAtMs: null,
      ...a,
      fetchFn: fetchA,
    });
    await settle();
    expect(releaseBody).not.toBeNull();

    let bCalls = 0;
    const fetchB: FetchFn = async () => {
      bCalls += 1;
      return new Response(JSON.stringify(sessionBody(bCalls)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const b = {
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      onDeferred: jest.fn(),
    };
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'b-0',
      bearerExpiresAtMs: null,
      ...b,
      fetchFn: fetchB,
    });
    await settle();
    expect(bCalls).toBe(1);
    expect(b.onRotated).toHaveBeenCalledTimes(1);

    // A's stalled body times out — must not touch B's callbacks.
    await advance(TIMEOUT_MS);
    // ...and then lands late — must not rotate A's dead generation either.
    (releaseBody as unknown as (value: unknown) => void)(sessionBody(99));
    await settle();
    refreshSessionNow();
    await settle();
    fireAppState('active');
    await settle();
    expect({
      a: [
        a.onRotated.mock.calls.length,
        a.onRevoked.mock.calls.length,
        a.onDeferred.mock.calls.length,
      ],
      bRotated: b.onRotated.mock.calls.length,
      bRevoked: b.onRevoked.mock.calls.length,
      bDeferred: b.onDeferred.mock.calls.length,
      bCalls,
    }).toEqual({
      a: [0, 0, 0],
      bRotated: 2,
      bRevoked: 0,
      bDeferred: 0,
      bCalls: 2,
    });
  });
});
