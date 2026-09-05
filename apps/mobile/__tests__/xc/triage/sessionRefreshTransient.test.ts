/**
 * Triage pin (xc-journeys::XC-AUTH-1), mobile half of the contract pinned by
 * supabase/functions/api/__wf__/xc_triage_auth_refresh_transient.test.ts.
 *
 * The edge answers a GoTrue 429 or a network failure on POST /v1/auth/refresh
 * with `503 + Retry-After` and the body
 * `{"error":{"message":"Session refresh is temporarily unavailable. Please try again."}}`.
 * `refreshApiSession` must classify EXACTLY that answer (and a 429, should
 * the edge ever forward it) as SessionRefreshError retryable=true — the
 * keeper then backs off instead of signing the user out — and only 401/403
 * as retryable=false.
 *
 * Run (apps/mobile): npx jest --ci __tests__/xc/triage/sessionRefreshTransient.test.ts
 */
import {
  refreshApiSession,
  SessionRefreshError,
} from '../../../src/account/sessionLifecycle';

const EDGE_REFRESH_UNAVAILABLE_BODY = {
  error: {
    message: 'Session refresh is temporarily unavailable. Please try again.',
  },
};

function edgeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lookup = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lookup.get(name.toLowerCase()) ?? null },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function classify(response: Response): Promise<SessionRefreshError> {
  const fetchFn = jest.fn().mockResolvedValue(response);
  try {
    await refreshApiSession(
      { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
      { fetchFn },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRefreshError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    return error as SessionRefreshError;
  }
  throw new Error('refreshApiSession resolved; expected SessionRefreshError');
}

describe('XC-AUTH-1: transient refresh answers are retryable, never a sign-out', () => {
  it('edge 503 + Retry-After (GoTrue 429 / unreachable) ⇒ retryable=true', async () => {
    const error = await classify(
      edgeResponse(503, EDGE_REFRESH_UNAVAILABLE_BODY, { 'Retry-After': '2' }),
    );
    expect(error.retryable).toBe(true);
  });

  it('edge 503 with the upstream Retry-After hint forwarded ⇒ retryable=true', async () => {
    const error = await classify(
      edgeResponse(503, EDGE_REFRESH_UNAVAILABLE_BODY, { 'Retry-After': '17' }),
    );
    expect(error.retryable).toBe(true);
  });

  it('a forwarded 429 + Retry-After ⇒ retryable=true', async () => {
    const error = await classify(
      edgeResponse(
        429,
        { error: { message: 'Too many requests.' } },
        { 'Retry-After': '30' },
      ),
    );
    expect(error.retryable).toBe(true);
  });

  it('fetch rejecting (device offline) ⇒ retryable=true', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new TypeError('Network request failed'));
    await expect(
      refreshApiSession(
        { apiBaseUrl: 'https://api.example.test', refreshToken: 'refresh-1' },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ name: 'SessionRefreshError', retryable: true });
  });

  it('control: edge 401 / 403 ⇒ retryable=false (the refresh token is dead)', async () => {
    for (const status of [401, 403]) {
      const error = await classify(
        edgeResponse(status, {
          error: {
            message: 'The session could not be refreshed. Sign in again.',
          },
        }),
      );
      expect(error.retryable).toBe(false);
    }
  });
});
