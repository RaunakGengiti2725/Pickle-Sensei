import { AppState } from 'react-native';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../src/account/sessionKeeper';
import { refreshApiSession } from '../src/account/sessionLifecycle';
import { bootstrapCanonicalAccount } from '../src/account/bootstrap';

const SERVER_NOW = 1_800_000_000_000;
const API = 'https://api.example.test';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function sessionBody(index: number, expiresIn?: unknown) {
  return {
    session: {
      accessToken: `access-${index}`,
      refreshToken: `refresh-${index}`,
      expiresAt: SERVER_NOW / 1000 + 3600,
      ...(expiresIn === undefined ? {} : { expiresIn }),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

function start(expiresIn?: unknown, onRotated = jest.fn()) {
  let calls = 0;
  const fetchFn = jest.fn(async () =>
    response(sessionBody(++calls, expiresIn)),
  );
  const onRevoked = jest.fn();
  const listener = jest.spyOn(AppState, 'addEventListener');
  startSessionKeeper({
    apiBaseUrl: API,
    refreshToken: 'refresh-0',
    bearerExpiresAtMs: null,
    onRotated,
    onRevoked,
    fetchFn,
  });
  const foreground = () => {
    for (const [, onChange] of listener.mock.calls) onChange('active');
  };
  return { fetchFn, onRotated, onRevoked, foreground };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(SERVER_NOW + 2 * 60 * 60_000);
});

afterEach(() => {
  stopSessionKeeper();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('verified relative expiry parsing', () => {
  it.each([3600, 28.766, 0.5, 0])(
    'uses the server lifetime relative to receipt instead of a skewed absolute expiry: %s',
    async expiresIn => {
      const tokens = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-0' },
        { fetchFn: jest.fn(async () => response(sessionBody(1, expiresIn))) },
      );
      expect(tokens.bearerExpiresAtMs).toBe(Date.now() + expiresIn * 1000);
    },
  );

  it('applies the same relative lifetime to bootstrap without persisting any timing credentials', async () => {
    const result = await bootstrapCanonicalAccount({
      apiBaseUrl: API,
      provider: 'apple',
      bearerToken: 'provider-token',
      environment: {
        locale: 'en-US',
        timezone: 'UTC',
        device: {
          platform: 'ios',
          osVersion: '18',
          appVersion: '1',
          model: 'phone',
        },
      },
      fetchFn: jest.fn(async () =>
        response({
          ...sessionBody(1, 3600),
          user: { id: '11111111-1111-4111-8111-111111111111', email: null },
          onboardingState: 'complete',
        }),
      ),
    });
    expect(result.apiSession.bearerExpiresAtMs).toBe(Date.now() + 3_600_000);
    expect(result.apiSession.bearerToken).toBe('access-1');
  });

  it.each([undefined, null, -1, NaN, Infinity, 1e20, '3600'])(
    'keeps legacy absolute expiry when optional lifetime is invalid or absent: %s',
    async expiresIn => {
      const tokens = await refreshApiSession(
        { apiBaseUrl: API, refreshToken: 'refresh-0' },
        { fetchFn: jest.fn(async () => response(sessionBody(1, expiresIn))) },
      );
      expect(tokens.bearerExpiresAtMs).toBe(SERVER_NOW + 3_600_000);
    },
  );
});

describe('bounded renewal scheduling', () => {
  it.each([undefined, 3600])(
    'does not rotate on repeated foreground or one-second ticks with two-hour skew: %s',
    async expiresIn => {
      const runtime = start(expiresIn);
      await settle();
      for (let i = 0; i < 20; i += 1) {
        runtime.foreground();
        await settle();
      }
      await jest.advanceTimersByTimeAsync(60_000);
      expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
      expect(runtime.onRevoked).not.toHaveBeenCalled();
    },
  );

  it('uses a five-minute legacy cooldown after a successful refresh still appears expired', async () => {
    const runtime = start();
    await settle();
    await jest.advanceTimersByTimeAsync(299_999);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    expect(runtime.fetchFn).toHaveBeenLastCalledWith(
      `${API}/v1/auth/refresh`,
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('ignores forward and backward wall-clock jumps but refreshes an elapsed foreground deadline', async () => {
    const runtime = start(3600);
    await settle();
    jest.setSystemTime(Date.now() + 10 * 60 * 60_000);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() - 20 * 60 * 60_000);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(55 * 60_000);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rechecks elapsed lifetime on foreground when suspended timers have not fired', async () => {
    const clock = (
      globalThis as typeof globalThis & { performance: { now(): number } }
    ).performance;
    let elapsed = 0;
    jest.spyOn(clock, 'now').mockImplementation(() => elapsed);
    const runtime = start(3600);
    await settle();
    elapsed = 2 * 60 * 60_000;
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('uses a fractional lead for a genuine short lifetime instead of refreshing immediately', async () => {
    const runtime = start(30);
    await settle();
    runtime.foreground();
    await settle();
    await jest.advanceTimersByTimeAsync(23_999);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    runtime.foreground();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('caps automatic renewal at a five-second minimum even for a one-second lifetime', async () => {
    const runtime = start(1);
    await settle();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(13);
    expect(runtime.onRevoked).not.toHaveBeenCalled();
  });

  it.each([undefined, 3600])(
    'retries pending token persistence, not the network, while the renewal deadline has not elapsed: %s',
    async expiresIn => {
      const runtime = start(
        expiresIn,
        jest.fn(() => false),
      );
      await settle();
      for (let i = 0; i < 10; i += 1) {
        runtime.foreground();
        await settle();
      }
      await jest.advanceTimersByTimeAsync(60_000);
      expect(runtime.onRotated.mock.calls.length).toBeGreaterThan(1);
      expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
      expect(runtime.onRotated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bearerToken: 'access-1',
          refreshToken: 'refresh-1',
        }),
      );
    },
  );

  it('retries an initially pending bootstrap write without refreshing its skewed absolute expiry', async () => {
    const fetchFn = jest.fn(async () => response(sessionBody(2)));
    const onRotated = jest.fn(() => false);
    const tokens = {
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
      bearerExpiresAtMs: SERVER_NOW + 3_600_000,
    };
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: tokens.refreshToken,
      bearerExpiresAtMs: tokens.bearerExpiresAtMs,
      pendingTokens: tokens,
      onRotated,
      onRevoked: jest.fn(),
      fetchFn,
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(onRotated.mock.calls.length).toBeGreaterThan(1);
    expect(onRotated).toHaveBeenLastCalledWith(tokens);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not postpone expiry by the time spent waiting for persistence', async () => {
    const persistence = deferred<void>();
    const runtime = start(
      3600,
      jest.fn().mockImplementationOnce(() => persistence.promise),
    );
    await settle();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    jest.setSystemTime(Date.now() + 2 * 60 * 60_000);
    persistence.resolve();
    await settle();
    await jest.advanceTimersByTimeAsync(49 * 60_000 - 1);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('allows a genuine 401 to recover immediately during the legacy cooldown', async () => {
    const runtime = start();
    await settle();
    refreshSessionNow();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    runtime.fetchFn.mockResolvedValueOnce(response(null, 401));
    refreshSessionNow();
    await settle();
    expect(runtime.onRevoked).toHaveBeenCalledTimes(1);
    runtime.foreground();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('remembers a genuine 401 on tokens whose persistence is still in flight without duplicate rotations', async () => {
    const persistence = deferred<void>();
    const runtime = start(
      3600,
      jest.fn().mockImplementationOnce(() => persistence.promise),
    );
    await settle();
    refreshSessionNow();
    refreshSessionNow();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    persistence.resolve();
    await settle();
    expect(runtime.fetchFn).toHaveBeenCalledTimes(2);
    expect(runtime.fetchFn).toHaveBeenLastCalledWith(
      `${API}/v1/auth/refresh`,
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
  });

  it('drops a queued unauthorized recovery when stopped during token persistence', async () => {
    const persistence = deferred<void>();
    const runtime = start(
      3600,
      jest.fn().mockImplementationOnce(() => persistence.promise),
    );
    await settle();
    refreshSessionNow();
    stopSessionKeeper();
    persistence.resolve();
    await settle();
    runtime.foreground();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(runtime.fetchFn).toHaveBeenCalledTimes(1);
    expect(runtime.onRevoked).not.toHaveBeenCalled();
  });

  it('does not bypass a transient network backoff on repeated foreground events', async () => {
    const listener = jest.spyOn(AppState, 'addEventListener');
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(response(sessionBody(1, 3600)));
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: jest.fn(),
      onRevoked: jest.fn(),
      fetchFn,
    });
    await settle();
    for (let i = 0; i < 10; i += 1) {
      for (const [, onChange] of listener.mock.calls) onChange('active');
      await settle();
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('drops an old generation and all stopped timers/listeners even when a refresh lands later', async () => {
    const pending = deferred<Response>();
    const oldRotated = jest.fn();
    const oldRevoked = jest.fn();
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'old-refresh',
      bearerExpiresAtMs: null,
      onRotated: oldRotated,
      onRevoked: oldRevoked,
      fetchFn: jest.fn(() => pending.promise),
    });
    const stopped = stopSessionKeeper();
    const current = start(3600);
    await settle();
    pending.resolve(response(sessionBody(99, 3600)));
    await expect(stopped).resolves.toMatchObject({
      refreshToken: 'refresh-99',
    });
    await settle();
    expect(oldRotated).not.toHaveBeenCalled();
    expect(oldRevoked).not.toHaveBeenCalled();
    expect(current.onRotated).toHaveBeenCalledTimes(1);
    stopSessionKeeper();
    current.foreground();
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(current.fetchFn).toHaveBeenCalledTimes(1);
  });
});
