/**
 * Execution audit (mobile-auth-session, pass 2): sessionKeeper's timer- and
 * foreground-driven paths.
 *
 * `jest --coverage` over the 26 auth/account suites left sessionKeeper.ts
 * lines 93-94 (the scheduled pre-expiry rotation firing) and 134-139 (the
 * AppState foreground re-check) unexecuted, and branch coverage at 61.76%.
 * This harness drives those paths with fake timers and a scripted fetch:
 * rotation ahead of expiry, exponential backoff with its cap, the foreground
 * lead, the single implicit sign-out, generation fencing, and an in-flight
 * refresh dropped by stop.
 *
 * Tests prefixed `[defect]` pin CURRENT behaviour that this audit reports as a
 * finding; the expected behaviour is described in each test's comment.
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import type { RefreshedTokens } from '../../src/account/sessionLifecycle';

type AppStateHandler = (state: string) => void;

const API = 'https://api.example.test';
const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);
const MINUTE = 60_000;

let appStateHandlers: AppStateHandler[] = [];
let removeCalls = 0;

function foreground(): void {
  for (const handler of [...appStateHandlers]) handler('active');
}
function background(): void {
  for (const handler of [...appStateHandlers]) handler('background');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve: value => resolve(value) };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const sessionBody = (n: number, expiresAtMs: number) => ({
  session: {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: Math.floor(expiresAtMs / 1000),
  },
});

/** A scripted /v1/auth/refresh: each call shifts the next scripted answer. */
function scriptedFetch(
  script: Array<
    (n: number, init?: RequestInit) => Response | Promise<Response>
  >,
) {
  const calls: Array<{ atMs: number; refreshToken: string }> = [];
  const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${API}/v1/auth/refresh`);
    const body = JSON.parse(String(init?.body)) as { refreshToken: string };
    calls.push({ atMs: Date.now(), refreshToken: body.refreshToken });
    const n = calls.length;
    const step = script.shift();
    if (!step) throw new Error(`unscripted refresh #${n}`);
    return step(n, init);
  });
  return { fetchFn, calls };
}

interface Harness {
  rotated: RefreshedTokens[];
  revoked: jest.Mock;
  deferred: jest.Mock;
}

function start(
  fetchFn: jest.Mock,
  bearerExpiresAtMs: number | null,
  refreshToken = 'refresh-0',
): Harness {
  const rotated: RefreshedTokens[] = [];
  const revoked = jest.fn();
  const deferred = jest.fn();
  startSessionKeeper({
    apiBaseUrl: API,
    refreshToken,
    bearerExpiresAtMs,
    onRotated: tokens => {
      rotated.push(tokens);
    },
    onRevoked: revoked,
    onDeferred: deferred,
    fetchFn: fetchFn as unknown as Parameters<
      typeof startSessionKeeper
    >[0]['fetchFn'],
  });
  return { rotated, revoked, deferred };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  appStateHandlers = [];
  removeCalls = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: AppStateHandler,
  ) => {
    appStateHandlers.push(handler);
    return {
      remove: () => {
        removeCalls += 1;
        appStateHandlers = appStateHandlers.filter(h => h !== handler);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  stopSessionKeeper();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('sessionKeeper: scheduled rotation ahead of expiry', () => {
  it('rotates exactly REFRESH_LEAD (60 s) before the bearer expires, then re-arms against the NEW expiry', async () => {
    const lifetime = 10 * MINUTE;
    const { fetchFn, calls } = scriptedFetch([
      n => response(sessionBody(n, Date.now() + lifetime)),
      n => response(sessionBody(n, Date.now() + lifetime)),
    ]);
    const h = start(fetchFn, T0 + lifetime);

    // Nothing happens before the lead.
    await jest.advanceTimersByTimeAsync(lifetime - MINUTE - 1);
    expect(fetchFn).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      atMs: T0 + lifetime - MINUTE,
      refreshToken: 'refresh-0',
    });
    expect(h.rotated).toHaveLength(1);
    expect(h.rotated[0]).toMatchObject({
      bearerToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    // Second rotation: lead before the NEW expiry, with the ROTATED token.
    await jest.advanceTimersByTimeAsync(lifetime - MINUTE - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls[1]?.refreshToken).toBe('refresh-1');
    expect(h.rotated[1]?.bearerToken).toBe('access-2');
    expect(h.revoked).not.toHaveBeenCalled();
    expect(h.deferred).not.toHaveBeenCalled();
  });

  it('a bearer already inside the lead is rotated after MIN_DELAY (1 s), not immediately and not never', async () => {
    const { fetchFn } = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    start(fetchFn, T0 + 30_000); // 30 s of life left

    await jest.advanceTimersByTimeAsync(999);
    expect(fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('started without a bearer it refreshes at once (no timer wait)', async () => {
    const { fetchFn } = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    const h = start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(h.rotated).toHaveLength(1);
  });
});

describe('sessionKeeper: transient failures back off exponentially and never sign out', () => {
  it('retryDelayMs: 5s, 10s, 20s, 40s, 80s, 160s, then capped at 300s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(retryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
    expect(retryDelayMs(0)).toBe(5_000);
    expect(retryDelayMs(-3)).toBe(5_000);
  });

  it('network → 503 → 429 → malformed body → success: each failure defers with backoff, success resets the counter and re-arms ahead of expiry', async () => {
    const lifetime = 60 * MINUTE;
    const { fetchFn, calls } = scriptedFetch([
      () => {
        throw new TypeError('Network request failed');
      },
      () => response({ error: 'down' }, 503),
      () => response({ error: 'slow down' }, 429),
      () => response({ session: { accessToken: 'x' } }, 200),
      n => response(sessionBody(n, Date.now() + lifetime)),
      // After the reset the next failure must start the ladder over at 5 s.
      () => response({ error: 'down' }, 503),
      n => response(sessionBody(n, Date.now() + lifetime)),
    ]);
    const h = start(fetchFn, null);

    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(h.deferred).toHaveBeenCalledTimes(1);

    for (const [expectedDelay, expectedCalls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [40_000, 5],
    ] as const) {
      await jest.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(calls).toHaveLength(expectedCalls - 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(expectedCalls);
    }
    expect(h.deferred).toHaveBeenCalledTimes(4);
    expect(h.rotated).toHaveLength(1);
    expect(h.revoked).not.toHaveBeenCalled();
    // Every retry re-sent the SAME (still valid) refresh token.
    expect(calls.map(c => c.refreshToken)).toEqual(Array(5).fill('refresh-0'));

    // Success re-armed at lead-before-expiry; that attempt fails once and
    // the ladder restarts at 5 s (counter was reset), then succeeds.
    await jest.advanceTimersByTimeAsync(lifetime - MINUTE);
    expect(calls).toHaveLength(6);
    expect(calls[5]?.refreshToken).toBe('refresh-5');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(7);
    expect(h.rotated).toHaveLength(2);
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it('after 8+ consecutive failures the retry cadence is pinned at 5 min (RETRY_MAX)', async () => {
    const { fetchFn, calls } = scriptedFetch(
      Array.from({ length: 12 }, () => () => response({ e: 1 }, 503)),
    );
    start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    // Drain the ladder: 5+10+20+40+80+160 = 315 s reaches attempt 7.
    await jest.advanceTimersByTimeAsync(315_000);
    expect(calls).toHaveLength(7);
    await jest.advanceTimersByTimeAsync(300_000 - 1);
    expect(calls).toHaveLength(7);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(8);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(9);
  });

  it('a refresh that hangs past 15 s is aborted and treated as transient (retry at 5 s)', async () => {
    let aborted = false;
    const fetchFn = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const h = start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(h.deferred).toHaveBeenCalledTimes(1);
    expect(h.revoked).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('sessionKeeper: foreground re-check', () => {
  it("'active' with < 5 min of bearer left refreshes immediately; with more life left it does nothing", async () => {
    const { fetchFn } = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    start(fetchFn, T0 + 30 * MINUTE);

    foreground(); // 30 min left → no refresh
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(25 * MINUTE + 1); // 4:59 left
    foreground();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("'active' with NO bearer (launch refresh still failing) refreshes; 'background'/'inactive' never do", async () => {
    const { fetchFn } = scriptedFetch([
      () => response({ e: 1 }, 503),
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    background();
    for (const handler of appStateHandlers) handler('inactive');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    foreground(); // bearerExpiresAtMs is still null → refresh now
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a foreground while a refresh is in flight does not start a second request', async () => {
    const gate = deferred<Response>();
    const fetchFn = jest.fn(() => gate.promise);
    start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    foreground();
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    gate.resolve(response(sessionBody(1, Date.now() + 60 * MINUTE)));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('the AppState subscription is removed on stop (no listener leak across generations)', () => {
    const { fetchFn } = scriptedFetch([]);
    start(fetchFn, T0 + 60 * MINUTE);
    expect(appStateHandlers).toHaveLength(1);
    start(fetchFn, T0 + 60 * MINUTE); // restart stops the previous one
    expect(appStateHandlers).toHaveLength(1);
    expect(removeCalls).toBe(1);
    stopSessionKeeper();
    expect(appStateHandlers).toHaveLength(0);
    expect(removeCalls).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('sessionKeeper: the ONE implicit sign-out and generation fencing', () => {
  it('401 → onRevoked exactly once, no retry timer, later refreshSessionNow/foreground are inert', async () => {
    const { fetchFn } = scriptedFetch([() => response({ error: 'gone' }, 401)]);
    const h = start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.revoked).toHaveBeenCalledTimes(1);
    expect(h.deferred).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(appStateHandlers).toHaveLength(0);
    refreshSessionNow();
    foreground();
    await jest.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(h.revoked).toHaveBeenCalledTimes(1);
  });

  it('403 is also a refusal; 400/404/500/502 are not', async () => {
    for (const [status, expectRevoked] of [
      [403, true],
      [400, false],
      [404, false],
      [500, false],
      [502, false],
    ] as const) {
      const { fetchFn } = scriptedFetch([() => response({ e: 1 }, status)]);
      const h = start(fetchFn, null);
      await jest.advanceTimersByTimeAsync(0);
      expect({ status, revoked: h.revoked.mock.calls.length }).toEqual({
        status,
        revoked: expectRevoked ? 1 : 0,
      });
      expect(h.deferred).toHaveBeenCalledTimes(expectRevoked ? 0 : 1);
      stopSessionKeeper();
    }
  });

  it('stop during an in-flight refresh drops the result: no onRotated, no onRevoked, no timer', async () => {
    const gate = deferred<Response>();
    const fetchFn = jest.fn(() => gate.promise);
    const h = start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    stopSessionKeeper();
    gate.resolve(response(sessionBody(1, Date.now() + 60 * MINUTE)));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.rotated).toHaveLength(0);
    expect(h.revoked).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    // Same for a refusal landing after stop: the sign-out callback of a dead
    // generation must never fire (it would sign out the NEXT account).
    const gate2 = deferred<Response>();
    const f2 = jest.fn(() => gate2.promise);
    const h2 = start(f2, null);
    await jest.advanceTimersByTimeAsync(0);
    stopSessionKeeper();
    gate2.resolve(response({ e: 1 }, 401));
    await jest.advanceTimersByTimeAsync(0);
    expect(h2.revoked).not.toHaveBeenCalled();
  });

  it('restarting the keeper cancels the previous generation’s pending rotation (exactly one request per account)', async () => {
    const a = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    start(a.fetchFn, T0 + 5 * MINUTE, 'refresh-A');
    const b = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    const hb = start(b.fetchFn, T0 + 5 * MINUTE, 'refresh-B');

    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(b.fetchFn).toHaveBeenCalledTimes(1);
    expect(b.calls[0]?.refreshToken).toBe('refresh-B');
    expect(hb.rotated).toHaveLength(1);
  });

  it('a throwing onRotated is treated as transient (retry with the ALREADY rotated token), never as a revocation', async () => {
    const { fetchFn, calls } = scriptedFetch([
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
      n => response(sessionBody(n, Date.now() + 60 * MINUTE)),
    ]);
    const revoked = jest.fn();
    const deferred = jest.fn();
    let throwOnce = true;
    startSessionKeeper({
      apiBaseUrl: API,
      refreshToken: 'refresh-0',
      bearerExpiresAtMs: null,
      onRotated: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('adopt failed');
        }
      },
      onRevoked: revoked,
      onDeferred: deferred,
      fetchFn: fetchFn as unknown as Parameters<
        typeof startSessionKeeper
      >[0]['fetchFn'],
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(deferred).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    // The token rotated by the first (adopt-failed) exchange is what is
    // retried — the spent refresh-0 is never re-sent.
    expect(calls[1]?.refreshToken).toBe('refresh-1');
    expect(revoked).not.toHaveBeenCalled();
  });
});

describe('[defect] sessionKeeper: expiry is compared against the DEVICE clock with no sanity clamp', () => {
  // sessionKeeper.ts:100-101 schedules `expiresAt - now() - 60s` floored at
  // 1 s (:96) and sessionLifecycle.ts:106-107 accepts any finite expiresAt.
  // A device clock ≥ (bearer lifetime − 60 s) ahead of the server — or a
  // server answering with an expiresAt in the past — therefore makes EVERY
  // successful rotation re-arm at MIN_DELAY: a 1 Hz refresh loop that rotates
  // the Supabase refresh token (and re-persists it via the vault) once per
  // second until the edge's per-IP budget (30/min, index.ts:2704) answers 429
  // — which is retryable, so the loop resumes after the backoff.
  // Expected: treat a non-positive remaining lifetime as a server/clock
  // anomaly (e.g. fall back to a lifetime-based interval, or use a server-
  // relative expiresIn) rather than spinning at MIN_DELAY.
  it('server expiresAt = server-now + 1 h while the device clock runs 1 h fast: ≥ 60 successful refreshes in the first minute', async () => {
    const SERVER_SKEW_MS = 60 * MINUTE; // device clock runs 1 h fast
    const fetchFn = jest.fn(async () =>
      response({
        session: {
          accessToken: 'a',
          refreshToken: 'r',
          // Server-side "now + 1 h", expressed in the server's clock.
          expiresAt: Math.floor(
            (Date.now() - SERVER_SKEW_MS + 60 * MINUTE) / 1000,
          ),
        },
      }),
    );
    const h = start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(60);
    expect(h.rotated.length).toBe(fetchFn.mock.calls.length);
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it('a server answering an expiresAt in the past has the same effect (1 Hz loop)', async () => {
    const fetchFn = jest.fn(async () =>
      response({
        session: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: Math.floor((Date.now() - 5 * MINUTE) / 1000),
        },
      }),
    );
    start(fetchFn, null);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(10);
  });
});
