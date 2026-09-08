/**
 * Adversarial (P0-02): the refresh route is the ONE place the durable
 * session can be lost, so every network failure shape is thrown at the keeper:
 * 429 + Retry-After, 5xx, a redirect answered by the transport, a request
 * that never gets headers (client timeout), a response whose headers arrive
 * but whose body never does (stall), and an account switch while a refresh is
 * in flight. Contract under attack (AGENTS.md "Auth sessions"): only 401/403
 * signs the user out; everything else keeps the session and retries; a stale
 * account's tokens must never be adopted after a switch.
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
  SessionRefreshError,
} from '../../src/account/sessionLifecycle';

type FetchFn = NonNullable<SessionKeeperInput['fetchFn']>;

// Response.json() on a fetch body takes a variable number of microtasks and
// immediates; advancing 0ms runs those without firing any >= 1s timer.
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  (AppState.addEventListener as jest.Mock).mockClear();
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('refreshApiSession: response shapes at the failure boundary', () => {
  it.each([
    ['429 + Retry-After: 120', 429, { 'retry-after': '120' }],
    ['500', 500, {}],
    ['502 HTML from a proxy', 502, { 'content-type': 'text/html' }],
    ['503 + Retry-After', 503, { 'retry-after': '30' }],
    ['302 redirect surfaced by the transport', 302, { location: 'https://x' }],
    ['404 route missing (old server)', 404, {}],
    ['400 malformed by the server', 400, {}],
  ])(
    '%s → retryable (keeps the session), never a sign-out',
    async (_label, status, headers) => {
      const fetchFn: FetchFn = async () =>
        new Response('<html>nope</html>', { status, headers });
      await expect(
        refreshApiSession(
          { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
          { fetchFn },
        ),
      ).rejects.toMatchObject({
        name: 'SessionRefreshError',
        retryable: true,
      });
    },
  );

  it.each([401, 403])(
    '%d → non-retryable (the only implicit sign-out)',
    async status => {
      const fetchFn: FetchFn = async () => new Response('', { status });
      await expect(
        refreshApiSession(
          { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
          { fetchFn },
        ),
      ).rejects.toMatchObject({
        name: 'SessionRefreshError',
        retryable: false,
      });
    },
  );

  it('a 200 whose session is a replay of the SAME refresh token is still adopted verbatim (no client-side replay guard)', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(
        JSON.stringify({
          session: { accessToken: 'a', refreshToken: 'rt', expiresAt: 1 },
        }),
        { status: 200 },
      );
    const tokens = await refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn },
    );
    expect(tokens.refreshToken).toBe('rt');
  });

  it('a 200 with an expiresAt in the past is accepted (the keeper, not the parser, owns the storm guard)', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(
        JSON.stringify({
          session: { accessToken: 'a', refreshToken: 'b', expiresAt: -1 },
        }),
        { status: 200 },
      );
    const tokens = await refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn },
    );
    expect(tokens.bearerExpiresAtMs).toBe(-1000);
  });

  it('no headers within the client timeout → aborts and is retryable', async () => {
    let aborted = false;
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const pending = refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: 15_000 },
    );
    const outcome = expect(pending).rejects.toMatchObject({
      retryable: true,
    });
    await advance(15_000);
    await outcome;
    expect(aborted).toBe(true);
  });

  it('headers arrive but the body never does → the refresh is NOT bounded by the client timeout', async () => {
    const fetchFn: FetchFn = async () => stalledBodyResponse();
    let settled: 'resolved' | 'rejected' | 'pending' = 'pending';
    refreshApiSession(
      { apiBaseUrl: 'https://api.test', refreshToken: 'rt' },
      { fetchFn, timeoutMs: 15_000 },
    ).then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    await advance(60 * 60_000);
    expect(settled).toBe('rejected');
  });
});

describe('sessionKeeper: keeps the session through every transient failure', () => {
  it('429 + Retry-After: 120 → retries, and the first retry is not sooner than the server asked', async () => {
    const requests: number[] = [];
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      requests.push(Date.now());
      if (n <= 3) {
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '120' },
        });
      }
      return okSession(n);
    };
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      onDeferred,
      fetchFn,
    });
    await settle();
    await advance(10 * 60_000);

    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(3);
    expect(retryDelayMs(1)).toBe(5_000);
    const first = requests[0] ?? 0;
    const second = requests[1] ?? 0;
    expect(second - first).toBeGreaterThanOrEqual(120_000);
  });

  it('a body stall on one rotation does not wedge the keeper: the next foreground still refreshes', async () => {
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
    // 30s → the scheduled rotation fires and stalls on its body.
    await advance(30_000);
    expect(n).toBe(1);

    // The bearer expires; the user backgrounds and returns hours later.
    await advance(6 * 60 * 60_000);
    fireAppState('background');
    fireAppState('active');
    await settle();
    refreshSessionNow();
    await settle();
    await advance(60_000);

    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(1);
  });

  it('an account switch mid-flight drops the stale account\u2019s tokens', async () => {
    let releaseA: ((r: Response) => void) | null = null;
    const fetchA: FetchFn = () =>
      new Promise<Response>(resolve => {
        releaseA = resolve;
      });
    const rotatedA = jest.fn();
    const revokedA = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-A',
      bearerExpiresAtMs: null,
      onRotated: rotatedA,
      onRevoked: revokedA,
      fetchFn: fetchA,
    });
    await settle();
    expect(releaseA).not.toBeNull();

    const rotatedB = jest.fn();
    const fetchB: FetchFn = async () => okSession(100);
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-B',
      bearerExpiresAtMs: null,
      onRotated: rotatedB,
      onRevoked: jest.fn(),
      fetchFn: fetchB,
    });
    await settle();
    expect(rotatedB).toHaveBeenCalledTimes(1);

    (releaseA as unknown as (r: Response) => void)(okSession(1));
    await settle();
    expect(rotatedA).not.toHaveBeenCalled();
    expect(revokedA).not.toHaveBeenCalled();
  });

  it('a 401 for the stale account after a switch does not sign the NEW account out', async () => {
    let releaseA: ((r: Response) => void) | null = null;
    const fetchA: FetchFn = () =>
      new Promise<Response>(resolve => {
        releaseA = resolve;
      });
    const revokedA = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-A',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: revokedA,
      fetchFn: fetchA,
    });
    await settle();

    const revokedB = jest.fn();
    const rotatedB = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-B',
      bearerExpiresAtMs: null,
      onRotated: rotatedB,
      onRevoked: revokedB,
      fetchFn: async () => okSession(7),
    });
    await settle();

    (releaseA as unknown as (r: Response) => void)(
      new Response('', { status: 401 }),
    );
    await settle();
    expect(revokedA).not.toHaveBeenCalled();
    expect(revokedB).not.toHaveBeenCalled();
    expect(rotatedB).toHaveBeenCalledTimes(1);
  });

  it('refreshSessionNow() during an in-flight refresh is a no-op (no double submit)', async () => {
    let release: ((r: Response) => void) | null = null;
    let n = 0;
    const fetchFn: FetchFn = () => {
      n += 1;
      return new Promise<Response>(resolve => {
        release = resolve;
      });
    };
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await settle();
    refreshSessionNow();
    refreshSessionNow();
    fireAppState('active');
    await settle();
    expect(n).toBe(1);
    (release as unknown as (r: Response) => void)(okSession(1));
    await settle();
    expect(n).toBe(1);
  });

  it('onRotated throwing (persist failure) is not a sign-out and the rotated token is retained for the retry', async () => {
    const sent: string[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      n += 1;
      sent.push(
        (JSON.parse(String(init?.body)) as { refreshToken: string })
          .refreshToken,
      );
      return okSession(n);
    };
    const onRotated = jest
      .fn()
      .mockRejectedValueOnce(new Error('keychain write failed'))
      .mockResolvedValue(undefined);
    const onRevoked = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      fetchFn,
    });
    await settle();
    await advance(retryDelayMs(1));
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(['refresh-0', 'refresh-1']);
  });

  it('SessionRefreshError is the only error class that can revoke: a thrown non-retryable-looking plain Error retries', async () => {
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) {
        throw Object.assign(new Error('revoked'), { retryable: false });
      }
      return okSession(n);
    };
    const onRevoked = jest.fn();
    const onRotated = jest.fn();
    startSessionKeeper({
      apiBaseUrl: 'https://api.test',
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated,
      onRevoked,
      fetchFn,
    });
    await settle();
    await advance(retryDelayMs(1));
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(new SessionRefreshError('x', false).retryable).toBe(false);
  });
});
