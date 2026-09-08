/**
 * P0-02 adversary — network failure at the refresh step: 429 / 503 with
 * `Retry-After`.
 *
 * The edge route answers rate-limited and upstream-unavailable refreshes with
 * a `Retry-After` header (AGENTS.md "rateLimit.ts enforces per-IP pre-auth
 * ... budgets (429 + Retry-After)"; refreshSessionRoute → serviceUnavailable
 * with retryAfterSeconds). A keeper that retries on its own 5 s backoff
 * inside that window presents the same refresh token into a budget the
 * server just told it is exhausted. The candidate's post() reads the body of
 * these answers but the status/headers are discarded before the keeper
 * schedules the retry.
 */
import { AppState } from 'react-native';
import {
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';

type FetchFn = NonNullable<SessionKeeperInput['fetchFn']>;

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

const throttled = (status: 429 | 503, retryAfterSeconds: number): Response =>
  new Response(JSON.stringify({ error: { message: 'Too many requests.' } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfterSeconds),
    },
  });

const okSession = (n: number): Response =>
  new Response(
    JSON.stringify({
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  (AppState.addEventListener as jest.Mock).mockClear();
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe.each([[429], [503]] as const)(
  'attack: %s with Retry-After: 120 on the refresh route',
  status => {
    it('no retry is presented before the server-stated window elapses', async () => {
      const RETRY_AFTER_S = 120;
      const requestsAt: number[] = [];
      const start = Date.now();
      let n = 0;
      const fetchFn: FetchFn = async () => {
        n += 1;
        requestsAt.push(Date.now() - start);
        if (n === 1) return throttled(status, RETRY_AFTER_S);
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
      expect(n).toBe(1);
      expect(onDeferred).toHaveBeenCalledTimes(1);
      expect(onRevoked).not.toHaveBeenCalled();

      // Inside the server's window nothing may be presented again.
      await advance(RETRY_AFTER_S * 1000 - 1);
      const insideWindow = requestsAt.filter(
        at => at > 0 && at < RETRY_AFTER_S * 1000,
      );
      expect({ status, retriesInsideRetryAfterWindow: insideWindow }).toEqual({
        status,
        retriesInsideRetryAfterWindow: [],
      });

      // After the window the keeper does retry and the session survives.
      await advance(5 * 60_000);
      expect(onRotated).toHaveBeenCalled();
      expect(onRevoked).not.toHaveBeenCalled();
    });
  },
);
