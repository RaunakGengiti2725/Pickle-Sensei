/**
 * ADVERSARIAL PASS 3 — edge-auth-cache-ratelimit (#2), mobile side.
 *
 * `refreshApiSession` is the ONE call whose failure can sign a user out
 * implicitly (401/403 ⇒ `retryable: false`). Everything the edge emits when
 * its own upstream (GoTrue) or the per-IP `auth_refresh` budget gets in the
 * way MUST be classified `retryable: true` so the session is kept.
 *
 *   S2  the edge's auth_refresh 429 (+ Retry-After) is retryable.
 *   S7  a hung edge (GoTrue fetch fault, ~25 s server side) is abandoned at
 *       REQUEST_TIMEOUT_MS (15 s) and classified retryable; the abort really
 *       reaches the fetch. A thrown TypeError is retryable too.
 *   S8  a 503 (edge's `serviceUnavailable`) is retryable.
 *   own the exact non-retryable set is {401, 403} only — 400/404/408/418/500/
 *       502/504/599 and malformed 200 bodies keep the session.
 *
 * Run: cd apps/mobile && npx jest --ci --silent __tests__/wf/attack2-refresh-throttle-and-outage.test.ts
 */
import {
  SessionRefreshError,
  refreshApiSession,
} from '../../src/account/sessionLifecycle';

const API = 'https://edge.test/functions/v1/api';
const EDGE_RATE_LIMIT_BODY = JSON.stringify({
  error: {
    code: 'rate_limited',
    message: 'Too many requests. Please slow down and try again shortly.',
  },
});

function edgeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** What a fetch polyfill rejects with when its AbortSignal fires. */
function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

async function classify(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  timeoutMs?: number,
): Promise<{ retryable: boolean; message: string }> {
  try {
    await refreshApiSession(
      { apiBaseUrl: API, refreshToken: 'refresh-under-test' },
      { fetchFn, timeoutMs },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRefreshError);
    const e = error as SessionRefreshError;
    return { retryable: e.retryable, message: e.message };
  }
  throw new Error('refresh unexpectedly succeeded');
}

describe('[S2] edge auth_refresh 429 is retryable for the mobile client', () => {
  it('keeps the session on 429 + Retry-After (exact edge body) and posts to /v1/auth/refresh once', async () => {
    const fetchFn = jest.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(`${API}/v1/auth/refresh`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        refreshToken: 'refresh-under-test',
      });
      return edgeResponse(429, EDGE_RATE_LIMIT_BODY, {
        'Retry-After': '50',
        'RateLimit-Limit': '30',
        'RateLimit-Remaining': '0',
      });
    });
    const outcome = await classify(fetchFn);
    expect(outcome.retryable).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('30 rapid refreshes that all 429 never produce a non-retryable error', async () => {
    const fetchFn = jest.fn(async () =>
      edgeResponse(429, EDGE_RATE_LIMIT_BODY, { 'Retry-After': '1' }),
    );
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => classify(fetchFn)),
    );
    expect(outcomes.every(o => o.retryable)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(30);
  });
});

describe('[S7] edge hangs on a GoTrue fault → mobile aborts at REQUEST_TIMEOUT_MS and keeps the session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts the fetch at exactly 15 000 ms and classifies the failure retryable', async () => {
    let abortedAtMs: number | null = null;
    const started = Date.now();
    const fetchFn = jest.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeDefined();
          signal!.addEventListener('abort', () => {
            abortedAtMs = Date.now() - started;
            reject(abortError());
          });
        }),
    );
    const pending = classify(fetchFn);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(abortedAtMs).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    expect(abortedAtMs).toBe(15_000);
    expect(outcome.retryable).toBe(true);
  });

  it('a 401 that arrives AFTER the abort is not observed (the timeout wins, no sign-out)', async () => {
    const fetchFn = jest.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
          // Edge answers 401 at ~25 s (observed server-side in S7).
          setTimeout(() => resolve(edgeResponse(401, '{}')), 25_400);
        }),
    );
    const pending = classify(fetchFn);
    await jest.advanceTimersByTimeAsync(26_000);
    const outcome = await pending;
    expect(outcome.retryable).toBe(true);
  });

  it('a thrown TypeError (network) is retryable', async () => {
    jest.useRealTimers();
    const outcome = await classify(async () => {
      throw new TypeError('Network request failed');
    });
    expect(outcome.retryable).toBe(true);
  });
});

describe('[S8 + own] retryability matrix', () => {
  it('503 (edge serviceUnavailable body) is retryable', async () => {
    const outcome = await classify(async () =>
      edgeResponse(
        503,
        JSON.stringify({
          error: {
            message:
              'Session refresh is temporarily unavailable. Please try again.',
          },
        }),
      ),
    );
    expect(outcome.retryable).toBe(true);
  });

  it.each([400, 404, 408, 418, 429, 500, 502, 504, 599])(
    'status %i keeps the session (retryable)',
    async status => {
      const outcome = await classify(async () => edgeResponse(status, '{}'));
      expect(outcome.retryable).toBe(true);
    },
  );

  it.each([401, 403])(
    'status %i is the ONLY implicit sign-out (non-retryable)',
    async status => {
      const outcome = await classify(async () => edgeResponse(status, '{}'));
      expect(outcome.retryable).toBe(false);
    },
  );

  it.each([
    ['empty body', ''],
    ['not json', '<html>gateway</html>'],
    ['session missing', JSON.stringify({})],
    [
      'expiresAt as string',
      JSON.stringify({
        session: { accessToken: 'a', refreshToken: 'r', expiresAt: '123' },
      }),
    ],
    [
      'blank tokens',
      JSON.stringify({
        session: { accessToken: '  ', refreshToken: '  ', expiresAt: 1 },
      }),
    ],
    [
      'expiresAt NaN',
      JSON.stringify({
        session: { accessToken: 'a', refreshToken: 'r', expiresAt: null },
      }),
    ],
    ['unicode garbage', '\u{1F600}\uFFFD{"session":'],
    ['huge body', 'x'.repeat(2_000_000)],
  ])(
    'malformed 200 body (%s) is retryable, never a sign-out',
    async (_label, body) => {
      const outcome = await classify(async () => edgeResponse(200, body));
      expect(outcome.retryable).toBe(true);
    },
  );

  it('a well-formed 200 rotates the tokens', async () => {
    const tokens = await refreshApiSession(
      { apiBaseUrl: API, refreshToken: 'old' },
      {
        fetchFn: async () =>
          edgeResponse(
            200,
            JSON.stringify({
              session: {
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                expiresAt: 1_800_000_000,
              },
            }),
          ),
      },
    );
    expect(tokens).toEqual({
      bearerToken: 'new-access',
      refreshToken: 'new-refresh',
      bearerExpiresAtMs: 1_800_000_000_000,
    });
  });
});
