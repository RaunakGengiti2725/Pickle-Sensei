import type { ApiSession } from './apiSession';

/**
 * Rotation + revocation for the in-memory Supabase session.
 *
 * `refreshApiSession` rotates the refresh token into a fresh access token
 * before expiry; `revokeApiSession` asks the server to revoke every refresh
 * token for the account, so a stolen bearer dies with the session instead of
 * surviving to its natural expiry. Tokens never leave memory here — no
 * storage, no logging.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export class SessionRefreshError extends Error {
  constructor(
    message: string,
    /** false ⇒ the refresh token was revoked/rotated away: sign in again. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SessionRefreshError';
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function post(
  fetchFn: FetchFn,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      ...init,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchanges the session's refresh token for a fresh access/refresh pair.
 * Throws SessionRefreshError: retryable for network/server trouble (the
 * current access token may still be valid), non-retryable when the server
 * rejects the refresh token (revoked or already rotated — sign in again).
 */
export async function refreshApiSession(
  session: ApiSession,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ApiSession> {
  let response: Response;
  try {
    response = await post(fetchFn, `${session.apiBaseUrl}/v1/auth/refresh`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch {
    throw new SessionRefreshError(
      'The session could not be refreshed right now.',
      true,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SessionRefreshError('The session has been revoked.', false);
  }
  const payload = (await response.json().catch(() => null)) as {
    session?: {
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresAt?: unknown;
    };
  } | null;
  const tokens = payload?.session;
  if (
    !response.ok ||
    typeof tokens?.accessToken !== 'string' ||
    !tokens.accessToken.trim() ||
    typeof tokens.refreshToken !== 'string' ||
    !tokens.refreshToken.trim() ||
    typeof tokens.expiresAt !== 'number' ||
    !Number.isFinite(tokens.expiresAt)
  ) {
    throw new SessionRefreshError(
      'The session could not be refreshed right now.',
      true,
    );
  }
  return {
    ...session,
    bearerToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    bearerExpiresAtMs: tokens.expiresAt * 1000,
  };
}

/**
 * Best-effort server-side revocation of the whole application session
 * (every refresh token for the account). Local material must be cleared by
 * the caller regardless of whether this network call succeeds.
 */
export async function revokeApiSession(
  session: ApiSession,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  try {
    await post(fetchFn, `${session.apiBaseUrl}/v1/auth/logout`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
      },
    });
  } catch {
    // Offline sign-out: local tokens are cleared by the caller; the refresh
    // token still dies server-side at its natural rotation/expiry.
  }
}
